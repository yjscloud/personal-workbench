import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import { router } from './routes.js';
import { authEnabled, currentUser } from './services/auth.js';
import { initStore, closeStore, db, dbInfo, dbStats, flush } from './store.js';
import { DB_LABEL } from './db/config.js';
import { refreshNews, newsStale } from './services/news.js';
import { startSampler, stopSampler } from './services/sampler.js';
import { purgeOldKnowledge, purgeOldMonitoringData, purgeOldNews } from './services/retention.js';
import { applyBackupSchedule } from './services/backup.js';
import { refreshBackground } from './services/background.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.disable('x-powered-by');
/* 前面是 nginx（本机 127.0.0.1），只信这一跳：
   这样 req.ip 拿到的是真实客户端 IP（登录失败限速按它计），
   X-Forwarded-Proto 也才会被采纳（决定 cookie 要不要加 Secure）。 */
app.set('trust proxy', 'loopback');
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
  // 背景图状态存在磁盘上、缓存在内存里，必须先灌一次，
  // 否则第一个 /api/settings 会误报「没上传过图」
  await refreshBackground();
  const info = dbInfo();
  const data = db();

  const server = app.listen(PORT, async () => {
    console.log('');
    console.log('  个人工作台 · 服务已启动');
    console.log(`  API      http://127.0.0.1:${PORT}/api`);
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
    // 用电量由实测功率积分而来，必须常驻采样：只靠前端轮询，页面一关就断档
    startSampler();

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
