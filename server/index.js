import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import { router } from './routes.js';
import { publicRouter } from './routes-public.js';
import { authEnabled, currentUser } from './services/auth.js';
import { initStore, closeStore, db, dbInfo, dbStats, flush, persist, update } from './store.js';
import { migrateFeishuBotFromStars, syncFeishuBot } from './services/feishu-bot.js';
import { startFeishuApp } from './services/feishu-app.js';
import { DB_LABEL } from './db/config.js';
import { refreshNews, newsStale } from './services/news.js';
import { collectStars, ensureStarsFresh } from './services/github-stars.js';
import { runDueReminders } from './services/reminders.js';
import { startSampler, stopSampler } from './services/sampler.js';
import { warmOfficeData } from './services/office.js';
import { bridgeCall } from './services/hermes-local.js';
import { purgeOldKnowledge, purgeOldMonitoringData, purgeOldNews } from './services/retention.js';
import { applyBackupSchedule } from './services/backup.js';
import { refreshBackground } from './services/background.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
/* 监听地址。默认只听回环：对外由 nginx 的 443 反代进来。
 *
 * 以前这里是 app.listen(PORT) —— 等于 0.0.0.0，于是局域网里任何人都能绕过
 * HTTPS 直接访问完整 API（登录接口也在里面），明文口令与 Cookie 可被嗅探。
 * 容器部署若需要映射端口，显式设 HOST=0.0.0.0 并只映射到宿主回环：
 *   docker run -p 127.0.0.1:8787:8787 -e HOST=0.0.0.0 ... */
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
/* 前面是 nginx（本机 127.0.0.1），只信这一跳：
   这样 req.ip 拿到的是真实客户端 IP（登录失败限速按它计），
   X-Forwarded-Proto 也才会被采纳（决定 cookie 要不要加 Secure）。 */
app.set('trust proxy', 'loopback');

/* ── 公开外链：唯一一个不登录的写入口 ────────────────────────────────
   挂在全局 express.json / cors / 登录守卫之前，理由是三件事都由它自己定：
   1. 请求体上限 32KB（面板用的是 4MB，对外链太宽松了）；
   2. 不加 cors()：跨站页面拿不到响应头，等于默认只允许同源调用；
   3. 不依赖会话，也不该被会话逻辑拦住。
   响应头一并收窄：这条 URL 本身就是凭据，不能进 Referer、不能被搜索引擎收录。 */
app.use(
  '/api/public',
  (_req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    next();
  },
  /* 8MB：外链允许带最多 3 个附件、单个 1.5MB，base64 后约 6MB。
     比全局的 4MB 宽，但只宽在这一个前缀上，且仍受路由里的数量 / 类型校验。 */
  express.json({ limit: '8mb' }),
  publicRouter,
  /* 请求体超限 / JSON 语法错误：这两个错必须停在公开路由里，
     不能让它们落到全局错误处理器变成一句 500（原文还是英文的） */
  (err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: '附件太大了，请压缩或减少数量后重试' });
    }
    res.status(400).json({ ok: false, error: '请求格式不正确' });
  },
);
/* 公开提交页同样不收录、不把 token 泄露给任何外链资源 */
app.use('/s', (_req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(cors());
app.use(express.json({ limit: '4mb' }));

/**
 * 落库闸门：非 GET 请求在响应之前先等 MySQL 事务提交。
 * 这样"接口返回成功"就一定等于"数据已在库里"，落库失败会如实报错。
 */
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const send = res.json.bind(res);
  res.json = async (body) => {
    if (body && body.ok === false) {
      // 失败响应也尽量把已经发生的改动落下来，但不覆盖原始错误
      await flush().catch(() => {});
      return send(body);
    }
    try {
      await flush();
    } catch (err) {
      console.error('[db] 落库失败：', err.message);
      // 503：数据没进库，这次操作对调用方来说是不成功的（send 是未被包装的原始 res.json）
      res.status(503);
      return send({ ok: false, error: `数据落库失败：${err.message}` });
    }
    return send(body);
  };
  next();
});

/* ── 登录守卫 ────────────────────────────────────────────────────────
   挂在 /api 上、写在路由之前：除白名单外都要带会话 cookie。
   刻意只拦接口、不拦静态页面 —— 登录页本身得先能打开。
   没设 AUTH_PASSWORD 时 authEnabled() 为 false，整段等于不存在。 */
const API_OPEN = [
  { method: 'GET', path: '/auth/me' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/version' },
  // 登录页要先能取到自己的背景图；但上传 / 删除必须登录
  { method: 'GET', path: '/login-background' },
];
app.use('/api', (req, res, next) => {
  if (!authEnabled()) return next();
  const open = API_OPEN.some(
    (o) => o.method === req.method && (req.path === o.path || req.path.startsWith(`${o.path}/`)),
  );
  if (open) return next();
  if (currentUser(req)) return next();
  res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
});

app.use('/api', router);
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

/* 生产模式下直接托管构建产物 */
const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

/* ── 定时任务：每天自动更新 AI 热点 ───────────────────────────────── */
let newsJob = null;

function applyNewsSchedule() {
  const settings = db().settings;
  const expr = settings.news?.cron || '0 6 * * *';
  if (newsJob) {
    newsJob.stop();
    newsJob = null;
  }
  if (!settings.news?.autoUpdate) {
    console.log('[news] 自动更新已关闭');
    return;
  }
  if (!cron.validate(expr)) {
    console.warn(`[news] cron 表达式无效：${expr}，跳过定时任务`);
    return;
  }
  newsJob = cron.schedule(expr, async () => {
    console.log(`[news] 定时抓取开始 ${new Date().toLocaleString('zh-CN')}`);
    try {
      const result = await refreshNews(db().settings);
      await flush();
      console.log(`[news] 抓取完成并已落库，新增/更新 ${result.count} 条${result.errors.length ? `，部分失败：${result.errors.join('；')}` : ''}`);
    } catch (err) {
      console.error('[news] 抓取异常：', err.message);
    }
  });
  /* 不写"每日"：cron 是用户自己填的，默认已经改成每 2 小时一次。
     写死"每日"会让日志和设置对不上，排查时反而误导。 */
  console.log(`[news] 已启用自动更新，计划：${expr}`);
}

/* ── 定时任务：GitHub star，每 6 小时一次 ────────────────────────────
   定在 0 / 6 / 12 / 18 点。star 的增长是"天"的量级，采得再勤也只是把同一批
   数字重复记进历史；6 小时是"一天看得见四次"和"别把同一批数记四遍"之间的
   折中，也和新闻抓取（2 小时一轮）、清理（4:20）都错开。

   为什么不放进设置页：这个数是给监控卡片用的固定节奏，不是"用户偏好"。
   做成可配置项反而多一个能被改坏的地方。 */
const STAR_CRON = '0 */6 * * *';
let starJob = null;

function applyStarSchedule() {
  if (starJob) return;
  starJob = cron.schedule(STAR_CRON, () => {
    collectStars()
      .then((s) => console.log(`[stars] 采集完成：${s.stars} 个 star（本次 +${s.delta}）`))
      .catch((err) => console.error('[stars] 采集失败：', err.message));
  });
  console.log(`[stars] 已启用定时采集，计划：${STAR_CRON}`);
}

/* ── 定时任务：AI 用量按天记账 ───────────────────────────────────────
   桥（server/remote/hwb-bridge.cjs 的 measureUsage）在每次 /local/usage 时
   对比上次快照，把新增的 token 记到当天 —— Hermes 的 state.db 只有累计值，
   没有按天的账本，"今日消耗"只能这样采出来。

   所以**必须有人定期调它**：只靠监控页轮询的话，没人看页面那天就不记账，
   增量会整段攒到下次打开才落账，跨午夜就分不清是哪天的了。
   15 分钟一次：一次 SSH 往返，成本可以忽略；跨午夜最多偏一个间隔。 */
const USAGE_SAMPLE_MS = 15 * 60 * 1000;
let usageSampleTimer = null;

function startUsageSampler() {
  if (usageSampleTimer) return;
  const tick = () => {
    bridgeCall('/local/usage', { cacheTtl: 0, timeout: 20000 }).catch((err) =>
      console.warn('[usage] 采样失败：', err.message),
    );
  };
  tick(); /* 启动先采一次：建立 / 刷新快照基线 */
  usageSampleTimer = setInterval(tick, USAGE_SAMPLE_MS);
  usageSampleTimer.unref?.();
  console.log(`[usage] 已启用按天记账采样，间隔 ${USAGE_SAMPLE_MS / 60000} 分钟`);
}

/* ── 定时任务：清理过期数据 ─────────────────────────────────────────
   逐日明细留 3 个自然月，月度电费归档留 12 个月，AI 热点留 7 天，
   见 services/retention.js。
   定在凌晨 4:20：和 6:00 的新闻抓取错开，也不撞采样器的整点那一轮。

   热点这条是**每天**跑一次、而不是每 7 天跑一次：要的效果是"任何时刻
   库里都只有 7 天内的条目"，每天检查一次就能一直成立；每 7 天才跑一次，
   中间会积到接近 14 天，那就不是"只留 7 天"了。
   窗口和频率都是固定的业务规则，不做成设置项——改这里比改配置更不容易出事。 */
const RETENTION_CRON = '20 4 * * *';
let retentionJob = null;

/* ── 定时任务：任务到期提醒 ─────────────────────────────────────────
   每天 09:00 扫一遍未完成任务：T-1「明天到期」、T0「今天到期」、
   T+1/T+3/T+7「已逾期」。飞书发一条汇总，邮件发给留了邮箱的提交者。
   开关在设置页（reminders.enabled），任务本身照常排班 —— 关掉再打开时
   不会把当天已经发过的补一遍（去重靠 ticket_reminders 的唯一键）。 */
const REMINDER_CRON = '0 9 * * *';
let reminderJob = null;

function applyReminderSchedule() {
  if (reminderJob) return;
  reminderJob = cron.schedule(REMINDER_CRON, () => {
    runDueReminders().catch((err) => console.error('[reminders] 检查失败：', err.message));
  });
  console.log(`[reminders] 已启用到期提醒，计划：${REMINDER_CRON}`);
}

function applyRetentionSchedule() {
  if (retentionJob) return;
  retentionJob = cron.schedule(RETENTION_CRON, () => {
    purgeOldMonitoringData()
      .then((r) => {
        if (!r.changed) return;
        console.log(
          `[retention] 归档 ${r.archivedDays} 天 → ${r.archivedMonths.length} 个月，` +
            `删过期月归档 ${r.purgedMonths.length} 个；现存 ${r.keptDays} 天 / ${r.keptMonths} 个月`,
        );
      })
      .catch((err) => console.error('[retention] 清理失败：', err.message));

    purgeOldNews()
      .then((r) => {
        if (!r.changed) return;
        console.log(`[retention] 热点清理：删掉 ${r.purged} 条 ${r.keepDays} 天前的条目，现存 ${r.kept} 条`);
      })
      .catch((err) => console.error('[retention] 热点清理失败：', err.message));

    /* 回收站满 7 天永久删除。和热点一样每天跑一次而不是每 7 天跑一次：
       要的效果是"任何时刻回收站里都只有 7 天内的东西"，每天检查就恒成立 */
    purgeOldKnowledge()
      .then((r) => {
        if (!r.changed) return;
        console.log(
          `[retention] 回收站清理：永久删除 ${r.purged} 篇（保留 ${r.keepDays} 天），回收站现存 ${r.keptInTrash} 篇`,
        );
      })
      .catch((err) => console.error('[retention] 回收站清理失败：', err.message));
  });
  console.log(`[retention] 已启用数据留存清理，计划：${RETENTION_CRON}`);
}

/* ── 启动 ─────────────────────────────────────────────────────────── */
async function bootstrap() {
  const { seeded, source } = await initStore();
  /* 老库里 webhook 停在「GitHub Star 监控」那一栏，新的「飞书机器人」还是空的：
     启动时搬一次，避免同一串地址要人抄两遍 */
  if (migrateFeishuBotFromStars(db().settings)) {
    persist();
    console.log('  飞书机器人 已接管「GitHub Star 监控」里的原有配置');
  }
  /* 应用机器人的长连接：@ 机器人有反应、卡片按钮能点，靠的都是它。
     配置不齐就什么都不做；连不上只记状态（设置页能看到原因），不挡启动 */
  startFeishuApp(db().settings);

  /* 助手机上的配置以面板为唯一真源，启动时推一次 ——
     否则"面板里改了、忘了点重新同步"就会让助手机一直拿着旧地址。
     推不动不挡启动：本地这份仍然有效，只是助手机那边还拿着旧的 */
  if (db().settings.feishuBot) {
    syncFeishuBot(db().settings.feishuBot)
      .then((synced) => {
        if (synced.syncError) {
          console.warn('[feishu-bot] 启动同步到助手机失败：', synced.syncError);
          return;
        }
        update((d) => {
          d.settings.feishuBot = { ...d.settings.feishuBot, ...synced };
        });
        persist();
        console.log('  飞书机器人 已把配置同步到助手机');
      })
      .catch((err) => console.warn('[feishu-bot] 启动同步失败：', err.message));
  }
  // 背景图状态存在磁盘上、缓存在内存里，必须先灌一次，
  // 否则第一个 /api/settings 会误报「没上传过图」
  await refreshBackground();
  const info = dbInfo();
  const data = db();

  const server = app.listen(PORT, HOST, async () => {
    console.log('');
    console.log('  个人工作台 · 服务已启动');
    console.log(`  API      http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/api${HOST === '0.0.0.0' ? '（监听所有网卡）' : ''}`);
    console.log(`  数据库    MySQL · ${DB_LABEL}`);
    if (seeded) {
      console.log(`  初始化    已写入 ${source === 'legacy-json' ? '旧 db.json 迁移数据' : '示例数据'}`);
      if (source === 'legacy-json' && info.legacyFile) console.log(`            迁移来源 ${info.legacyFile}`);
    } else {
      console.log('  数据      从 MySQL 载入');
    }
    console.log(`  PVE      ${data.settings.pve.host ? `${data.settings.pve.host}:${data.settings.pve.port}（真实数据）` : '未配置 → 演示数据'}`);
    console.log(`  助手引擎  ${process.env.AI_API_KEY ? `大模型（${process.env.AI_MODEL || 'gpt-4o-mini'}）` : '本地规则'}`);

    try {
      const stats = await dbStats();
      console.log(`  表行数    ${Object.entries(stats).map(([t, n]) => `${t}=${n}`).join(' ')}`);
    } catch {
      /* 统计失败不影响服务启动 */
    }
    console.log('');

    applyNewsSchedule();
    applyRetentionSchedule();
    applyStarSchedule();
    applyReminderSchedule();

    /* 停机期间错过的 star 采集，起来就补一次。不补的话卡片的空窗期不是
       6 小时，而是"从上次跑到下一个整点" —— 部署当天可能一整天都是空的 */
    ensureStarsFresh()
      .then((s) => {
        if (s) console.log(`[stars] 启动补采完成：${s.stars} 个 star（本次 +${s.delta || 0}）`);
      })
      .catch((err) => console.warn('[stars] 启动补采失败：', err.message));
    // 用电量由实测功率积分而来，必须常驻采样：只靠前端轮询，页面一关就断档
    startSampler();
    // AI 用量同理：桥要靠"被调用"才会把增量记到当天
    startUsageSampler();

    /* 智能办公首屏预热：工位 / 待办 / 用量 / 守望摘要先拉进内存缓存，
       用户第一次点开就不用为 SSH 冷启动买单。失败只记日志，不影响启动 */
    const officeWarmAt = Date.now();
    const warmOnce = () => warmOfficeData().then((rs) => {
      const failed = rs.filter((r) => !r.ok);
      if (!failed.length) {
        console.log(`[office] 首屏预热完成 ${Date.now() - officeWarmAt}ms`);
        return true;
      }
      console.warn('[office] 预热部分失败：', failed.map((r) => `${r.name}: ${r.error}`).join(' / '));
      return false;
    });
    warmOnce()
      /* 启动瞬间网关/数据桥偶发抖动很常见，5 秒后补一次，避免首屏一直冷着 */
      .then((allOk) => { if (!allOk) setTimeout(() => warmOnce().catch(() => {}), 5000); })
      .catch((err) => console.warn('[office] 预热失败：', err.message));

    // 启动时先清一次：服务停了很久再起来、或者跨了月，
    // 过期的明细不用等到凌晨才被收走
    purgeOldMonitoringData()
      .then((r) => {
        if (!r.changed) return;
        console.log(
          `[retention] 启动清理：归档 ${r.archivedDays} 天 → ${r.archivedMonths.length} 个月，` +
            `删过期月归档 ${r.purgedMonths.length} 个`,
        );
      })
      .catch((err) => console.warn('[retention] 启动清理失败：', err.message));

    // 热点同理：停机期间过期的条目，起来就收走，不用等凌晨那一轮
    purgeOldNews()
      .then((r) => {
        if (!r.changed) return;
        console.log(`[retention] 启动清理热点：删掉 ${r.purged} 条 ${r.keepDays} 天前的条目，现存 ${r.kept} 条`);
      })
      .catch((err) => console.warn('[retention] 启动清理热点失败：', err.message));

    /* 回收站更是如此：服务停了一周再起来，那批早该永久删除的条目
       不能等到凌晨。启动时就收一次，避免"明明过了 7 天还在"的怪状态 */
    purgeOldKnowledge()
      .then((r) => {
        if (!r.changed) return;
        console.log(`[retention] 启动清理回收站：永久删除 ${r.purged} 篇，回收站现存 ${r.keptInTrash} 篇`);
      })
      .catch((err) => console.warn('[retention] 启动清理回收站失败：', err.message));

    /* 知识库自动备份。任务注册在 services/backup.js 里（和采样器同一做法），
       这样设置页改完频率能直接重新注册，不必重启服务 */
    applyBackupSchedule();

    if (data.settings.news?.autoUpdate && newsStale(data.news, 12)) {
      refreshNews(db().settings)
        .then((r) => flush().then(() => console.log(`[news] 启动时补抓完成并已落库：${r.count} 条`)))
        .catch((err) => console.warn('[news] 启动补抓失败：', err.message));
    }
  });

  return server;
}

bootstrap().catch((err) => {
  console.error('');
  console.error('  ✗ 数据库初始化失败，服务未启动');
  console.error(`    目标：${DB_LABEL}`);
  console.error(`    原因：${err.message}`);
  console.error('');
  console.error('    1) 确认 MySQL 已启动，并执行过一次初始化脚本：');
  console.error('         mysql -uroot -p < server/db/bootstrap.sql');
  console.error('    2) 在 .env 中核对 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME');
  console.error('');
  process.exit(1);
});

/* ── 退出前把内存里的改动落库，避免丢最后一次写入 ─────────────────── */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${signal}，正在落库后退出…`);
  stopSampler();
  try {
    await closeStore();
  } catch (err) {
    console.error('[db] 退出前落库失败：', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, applyNewsSchedule };
