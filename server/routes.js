import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, persist, replaceAll, resetToSeed, exportAll, update, uid, flush, dbInfo, dbStats } from './store.js';
import { getOverview, getGrowth, listNodes, pveConfig, isConfigured } from './services/pve.js';
import { accumulate, estimateWatts, powerReport, applyEco, recordMeter } from './services/power.js';
import { haReadings, haConfig, isHaConfigured, listEntityOptions, normalizeSockets } from './services/ha.js';
import { hermesSeats, testHermes, isHermesConfigured, hasHermesCredentials } from './services/hermes.js';
import { readGovernor, GOVERNORS } from './services/cpu.js';
import { backgroundStatus, saveBackground, clearBackground } from './services/background.js';
import { sampleOnce, samplerStatus } from './services/sampler.js';
import { refreshNews } from './services/news.js';
import { withKnowledgeBody, markdownToPlain, sanitizeAiLog, normalizeType, BODY_MAX } from './services/knowledge.js';
import { importFromUrl } from './services/importer.js';
import { askAboutArticle } from './services/knowledge-ai.js';
import { askAboutNews, cachedBody, unreadableHosts } from './services/reader.js';
import { usageSnapshot } from './services/ai-usage.js';
import { probeSiteColor } from './services/sitecolor.js';
import { fetchSiteIcon } from './services/siteicon.js';
import { suggestSource, fetchSuggest } from './services/suggest.js';
import {
  applyBackupSchedule,
  cosConfig,
  cosMissing,
  isValidCron,
  listBackups,
  restoreFromCos,
  runBackup,
  testConnection,
} from './services/backup.js';
import { KNOWLEDGE_TRASH_KEEP_DAYS } from './services/retention.js';
import {
  authConfig,
  blockedFor,
  checkCredentials,
  currentUser,
  expiredCookie,
  hashPassword,
  issueToken,
  sessionCookie,
  verifyCurrent,
  verifyHash,
} from './services/auth.js';
import { ask, askStream } from './services/assistant.js';
import { listMessages, addMessage, clearMessages, countMessages } from './db/messages.js';
import { listComments, addComment, removeComment, clearTicketComments, countComments } from './db/comments.js';
import {
  listAttachments,
  addAttachment,
  removeAttachment,
  clearTicketAttachments,
  countAttachments,
} from './db/attachments.js';
import { listProjects, getProject, addProject, patchProject, removeProject, countProjects } from './db/projects.js';
import {
  listSections,
  listAllSections,
  getSection,
  addSection,
  patchSection,
  removeSection,
} from './db/sections.js';

export const router = express.Router();

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, error: message, ...extra });
const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error('[api]', req.method, req.originalUrl, '-', err.message);
    fail(res, 500, err.message || '服务器内部错误');
  }
};

/* ── 前端产物版本 ─────────────────────────────────────────────────── */
/** dist/index.html 引用的入口 JS 文件名带内容哈希，换版本就换名字，
 *  所以它天然是"前端有没有重新构建"的判据。dev 模式没有 dist，返回 null。 */
const DIST_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.html');
let distVersionCache = { mtimeMs: 0, value: null };

function frontendVersion() {
  try {
    const stat = fs.statSync(DIST_INDEX);
    if (stat.mtimeMs !== distVersionCache.mtimeMs) {
      const html = fs.readFileSync(DIST_INDEX, 'utf8');
      const found = html.match(/assets\/([A-Za-z0-9_.-]+\.js)/);
      distVersionCache = { mtimeMs: stat.mtimeMs, value: found ? found[1] : null };
    }
    return distVersionCache.value;
  } catch {
    return null;
  }
}

const MASK = '••••••••';

/**
 * 对象键前缀只留 ASCII 字母数字与 - _ /。
 *
 * 前缀在 COS 签名里是一条路径，而非 ASCII 字符会撞上"路径要不要先转义"
 * 这个各家实现说法不一的地方（见 services/backup.js 的 signedPath）。
 * 与其赌一个说不准的规则，不如把前缀限死在这套字符里 ——
 * 它本来就只是个目录名，没有表达诉求。
 */
const sanitizeBackupPrefix = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9\-_/]/g, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .slice(0, 120);

/** 把 PUT 进来的 backup 片段合并成"最终要存的那一份"。掩码 = 这一栏没动过 */
function mergeBackup(current, incoming) {
  const base = current || {};
  const b = incoming || {};
  const next = { ...base };
  if (b.enabled !== undefined) next.enabled = Boolean(b.enabled);
  if (b.cron !== undefined) next.cron = String(b.cron).trim().slice(0, 80);
  if (b.prefix !== undefined) next.prefix = sanitizeBackupPrefix(b.prefix);
  if (b.cos) {
    const cos = { ...(base.cos || {}) };
    if (b.cos.secretId !== undefined) cos.secretId = String(b.cos.secretId).trim().slice(0, 200);
    if (b.cos.bucket !== undefined) cos.bucket = String(b.cos.bucket).trim().slice(0, 200);
    if (b.cos.region !== undefined) cos.region = String(b.cos.region).trim().slice(0, 60);
    if (b.cos.secretKey !== undefined && b.cos.secretKey !== MASK) {
      cos.secretKey = String(b.cos.secretKey).trim().slice(0, 200);
    }
    next.cos = cos;
  }
  return next;
}

/**
 * 整理 PUT 进来的 search 片段。
 *
 * 三条硬规则都在这儿挡住，并且报错要能直接照做：
 * · 至少留一个引擎 —— 全删了首页那块搜索框就没得选，等于功能消失；
 * · 每个引擎都要有名字和地址；
 * · 地址里必须有 %s 占位符 —— 少一个字符的后果是"点搜索永远跳回同一个固定页面"，
 *   界面上完全看不出哪里不对（这条以前是静默失败最典型的来源）。
 * 返回 { ok: true, value } 或 { ok: false, error }。
 */
function normalizeSearch(current, incoming) {
  const base = current || {};
  const s = incoming || {};
  const next = { ...base };
  if (Array.isArray(s.engines)) {
    const engines = s.engines.slice(0, 12).map((e) => ({
      // 前端新增的行还没落库，没有 id —— 在这里补一个，之后它就是稳定的引用
      id: String(e?.id ?? '').trim() || uid('se'),
      name: String(e?.name ?? '').trim().slice(0, 20),
      url: String(e?.url ?? '').trim().slice(0, 500),
    }));
    if (!engines.length) return { ok: false, error: '至少保留一个搜索引擎' };
    const blank = engines.findIndex((e) => !e.name || !e.url);
    if (blank >= 0) return { ok: false, error: `第 ${blank + 1} 个搜索引擎的名称和地址都要填` };
    const bad = engines.find((e) => !e.url.includes('%s'));
    if (bad) return { ok: false, error: `「${bad.name}」的搜索地址里缺少 %s 占位符` };
    next.engines = engines;
  }
  if (s.defaultEngine !== undefined) {
    const ids = (next.engines || []).map((e) => e.id);
    const want = String(s.defaultEngine || '');
    // 默认项被删掉之后不留悬空 id：回落到列表第一个，界面上的选中态才和实际一致
    next.defaultEngine = ids.includes(want) ? want : ids[0] ?? '';
  }
  if (s.newTab !== undefined) next.newTab = Boolean(s.newTab);
  /* 联想总开关。字段不再往上面加的话它会被这里吃掉 ——
     这个函数是一次"挑字段"的白名单，不是浅合并。 */
  if (s.suggest !== undefined) next.suggest = Boolean(s.suggest);
  return { ok: true, value: next };
}

function maskSettings(settings) {
  // 令牌不落库，所以这里直接把可能残留的字段摘掉再返回；
  // hasToken 反映的是"环境变量有没有配"，而不是库里存了什么。
  // sockets 回显前先规范化一次：旧配置（只有扁平字段）在页面上也会以
  // 「一个插座」的样子出现，用户不必重新填一遍。
  const { token: _token, hasToken: _hasToken, ...ha } = settings.ha || {};
  const cfg = haConfig(settings);
  return {
    ...settings,
    pve: {
      ...settings.pve,
      tokenSecret: settings.pve?.tokenSecret ? MASK : '',
      hasSecret: Boolean(settings.pve?.tokenSecret),
    },
    ha: {
      ...ha,
      url: cfg.url,
      sockets: cfg.sockets,
      hasToken: Boolean(process.env.HA_TOKEN),
    },
    backup: {
      ...settings.backup,
      cos: {
        ...settings.backup?.cos,
        /* SecretKey 同 PVE tokenSecret 的做法：只回一个掩码 + 一个布尔。
           前端把掩码原样传回来就表示"没改过"，服务端据此保留原值 */
        secretKey: settings.backup?.cos?.secretKey ? MASK : '',
        hasSecretKey: Boolean(settings.backup?.cos?.secretKey),
      },
    },
    /* 回收站保留几天是服务端的业务规则（services/retention.js），
       这里派生态暴露给前端 —— 页面上那句"保留 7 天"的文案得跟着它走，
       写死在两处迟早会说法不一致 */
    knowledgeTrashKeepDays: KNOWLEDGE_TRASH_KEEP_DAYS,
    background: {
      ...settings.background,
      // 上传的图不在库里的，磁盘上有才算数。这两个字段是派生态，
      // 前端靠它们决定"上传"这个选项能不能选、以及图片地址带哪个版本号。
      hasUpload: Boolean(backgroundStatus()),
      uploadedAt: backgroundStatus()?.mtime ?? null,
      size: backgroundStatus()?.size ?? null,
    },
    // 登录页背景同上（独立一份，和主背景互不影响）
    loginBackground: {
      ...(settings.loginBackground || {}),
      hasUpload: Boolean(backgroundStatus('login')),
      uploadedAt: backgroundStatus('login')?.mtime ?? null,
      size: backgroundStatus('login')?.size ?? null,
    },
    // 账号概览：只说"开没开、是不是在设置页改过"，口令哈希不出门
    auth: authConfig(),
  };
}

/* ── 基础 ─────────────────────────────────────────────────────────── */
router.get(
  '/health',
  wrap(async (_req, res) => {
    // 顺带探一次库：让健康检查真实反映"能不能落盘"，而不只是进程活着
    const probe = await dbStats().then(
      async (tables) => {
        // 这两张表不在内存镜像里（见 db/messages.js、db/comments.js），行数得单独数
        const [messages, comments] = await Promise.all([
          countMessages().catch(() => null),
          countComments().catch(() => null),
        ]);
        const extra = {};
        if (messages !== null) extra.assistant_messages = messages;
        if (comments !== null) extra.ticket_comments = comments;
        return { ok: true, tables: { ...tables, ...extra } };
      },
      (err) => ({ ok: false, error: err.message, tables: null }),
    );
    ok(res, {
      status: 'up',
      uptime: Math.round(process.uptime()),
      db: { ...dbInfo(), reachable: probe.ok, error: probe.ok ? null : probe.error, tables: probe.tables },
      pveConfigured: isConfigured(db().settings),
      haConfigured: isHaConfigured(db().settings),
      hermesConfigured: isHermesConfigured(),
      hermesCredentials: hasHermesCredentials(),
      sampler: samplerStatus(),
      assistantEngine: process.env.AI_API_KEY ? 'llm' : 'rule',
    });
  }),
);

/** 前端产物版本：页面据此发现自己是不是旧版本，好提示刷新（省得靠人记得强刷） */
router.get('/version', (_req, res) => ok(res, { version: frontendVersion() }));

/**
 * 全站大模型 token 用量。给顶栏那个统计用 —— 它挂在每个页面都看得见的位置，
 * 所以必须是个便宜接口：这里只是把内存里那个对象读出来，不查库。
 */
router.get('/ai/usage', (_req, res) => ok(res, usageSnapshot(db())));

/* ── 登录 ─────────────────────────────────────────────────────────── */

/** 是否给这个请求下发 Secure cookie。局域网默认是 http，
 *  硬加 Secure 的话浏览器根本不存这个 cookie，登录会永远"成功但没登录"。 */
const isSecure = (req) =>
  Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

/** 页面启动时问一次：要不要登录、我登了没 */
router.get('/auth/me', (req, res) => {
  const cfg = authConfig();
  ok(res, {
    enabled: cfg.enabled,
    user: cfg.enabled ? currentUser(req) : null,
    /* 登录页有自己的背景图，而它必须在**未登录**时就能拿到 ——
       所以随这一并回传，登录页不必再多发一次请求（多一次就会先闪一下默认底色） */
    loginBackground: loginBackgroundView(),
  });
});

router.post(
  '/auth/login',
  wrap(async (req, res) => {
    const { enabled } = authConfig();
    if (!enabled) return fail(res, 400, '没有开启登录：请在服务器的 .env 里设置 AUTH_PASSWORD');

    const ip = req.ip || 'unknown';
    const wait = blockedFor(ip);
    if (wait) return fail(res, 429, `尝试过于频繁，请 ${wait} 秒后再试`);

    const { username = '', password = '' } = req.body || {};
    const user = checkCredentials(ip, String(username).trim(), String(password));
    if (user === 'blocked') return fail(res, 429, '尝试过于频繁，请稍后再试');
    // 只回一句"账号或密码不正确"：分开提示等于告诉对方用户名猜对了
    if (!user) return fail(res, 401, '账号或密码不正确');

    res.setHeader('Set-Cookie', sessionCookie(issueToken(user), isSecure(req)));
    ok(res, { user });
  }),
);

router.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', expiredCookie(isSecure(req)));
  ok(res, { ok: true });
});

/**
 * 改密码。要在这里做而不是让用户去改 .env：
 * .env 是服务器上的文件，改完还得重启服务，对"我怀疑密码被人看到了"这种
 * 需要立刻生效的场景完全不合适。
 *
 * 改完在同一响应里换发新 cookie —— 会话签名密钥掺了凭据指纹，
 * 密码一改，**所有**旧会话（包括这台）都会失效；不续发一张，
 * 用户会被自己刚做的操作踢到登录页。
 */
router.post(
  '/auth/password',
  wrap(async (req, res) => {
    const cfg = authConfig();
    if (!cfg.enabled) return fail(res, 400, '没有开启登录，无需修改密码');
    if (!currentUser(req)) return fail(res, 401, '登录已过期，请重新登录');

    const { current = '', next = '' } = req.body || {};
    if (!verifyCurrent(cfg.user, String(current))) return fail(res, 400, '当前密码不正确');

    const pass = String(next);
    if (pass.length < 6) return fail(res, 400, '新密码至少 6 位');
    if (pass.length > 128) return fail(res, 400, '新密码过长（上限 128 位）');
    if (pass === String(current)) return fail(res, 400, '新密码不能和当前密码相同');

    const hash = hashPassword(pass);
    /* 写进去之前先自检一遍：这段哈希决定"下次还能不能登进来"，
       一旦它在落库 / 读回的路上被改动，用户就被锁在门外了，
       而那时界面上不会有任何提示。宁可这次改密码失败，也不能存一条验不过的哈希。 */
    if (!verifyHash(pass, hash)) {
      console.error('[auth] 口令哈希自检未通过，已放弃保存');
      return fail(res, 500, '口令写入前校验失败，请重试');
    }

    update((d) => {
      d.settings.auth = { user: cfg.user, passwordHash: hash, updatedAt: new Date().toISOString() };
      d.settings.updatedAt = new Date().toISOString();
    });
    // 密码变更留一条日志：出问题时这是唯一能回溯"什么时候改过"的地方
    console.log(`[auth] 面板口令已更新（账号 ${cfg.user}，哈希 ${hash.slice(0, 13)}…），其它设备上的会话已失效`);
    res.setHeader('Set-Cookie', sessionCookie(issueToken(cfg.user), isSecure(req)));
    ok(res, { user: cfg.user });
  }),
);

/* ── 登录页背景 ───────────────────────────────────────────────────── */

/** 登录页背景的对外形态。派生态（有没有图、什么时候传的）来自磁盘扫描 */
function loginBackgroundView() {
  const s = db().settings.loginBackground || {};
  const file = backgroundStatus('login');
  return {
    kind: ['canvas', 'url', 'upload'].includes(s.kind) ? s.kind : 'canvas',
    url: s.url || '',
    overlay: Number.isFinite(Number(s.overlay)) ? Number(s.overlay) : 0.2,
    blur: Number(s.blur) || 0,
    hasUpload: Boolean(file),
    uploadedAt: file?.mtime ?? null,
  };
}

/* GET 在守卫白名单里：登录页要先能取到自己的背景图。
   POST / DELETE 要登录 —— 上传口子不对未登录开放。 */
router.get(
  '/login-background',
  wrap(async (_req, res) => {
    const file = backgroundStatus('login');
    if (!file) return fail(res, 404, '还没有上传登录页背景图');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file.path);
  }),
);

router.post(
  '/login-background',
  wrap(async (req, res) => {
    const saved = await saveBackground(req.body?.data, 'login');
    ok(res, { hasUpload: true, uploadedAt: saved.mtime, size: saved.size, ext: saved.ext });
  }),
);

router.delete(
  '/login-background',
  wrap(async (_req, res) => {
    await clearBackground('login');
    // 和主背景一样：配置退回 canvas，避免留下"指向已经不存在的图"的悬空状态
    update((d) => {
      if (d.settings.loginBackground?.kind === 'upload') d.settings.loginBackground.kind = 'canvas';
      d.settings.updatedAt = new Date().toISOString();
    });
    await flush();
    ok(res, { hasUpload: false });
  }),
);

/** 一次性拉取首屏所需数据 */
router.get(
  '/bootstrap',
  wrap(async (_req, res) => {
    const data = db();
    ok(res, {
      todos: data.todos,
      tickets: data.tickets,
      // 项目在独立表里。万一这张表还没建好，不该拖垮整个首屏 —— 退化成空数组
      projects: await listProjects().catch(() => []),
      // 分类一次全给：前端按 projectId 分组即可，省得每个项目各请求一次
      sections: await listAllSections().catch(() => []),
      bookmarks: data.bookmarks.map(publicBookmark),
      groups: data.groups,
      knowledge: publicKnowledge(data.knowledge),
      news: { updatedAt: data.news.updatedAt, lastError: data.news.lastError, count: data.news.items.length },
      settings: maskSettings(data.settings),
    });
  }),
);

/* ── 今日待办 ─────────────────────────────────────────────────────── */
router.get('/todos', (_req, res) => ok(res, db().todos));

router.post(
  '/todos',
  wrap(async (req, res) => {
    const { text, priority = 'P2', due = '' } = req.body || {};
    if (!text || !String(text).trim()) return fail(res, 400, '待办内容不能为空');
    const todo = {
      id: uid('td'),
      text: String(text).trim().slice(0, 300),
      done: false,
      priority: ['P0', 'P1', 'P2', 'P3'].includes(priority) ? priority : 'P2',
      due,
      createdAt: new Date().toISOString(),
    };
    update((d) => d.todos.unshift(todo));
    ok(res, todo);
  }),
);

router.patch(
  '/todos/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const patch = req.body || {};
    let updated = null;
    update((d) => {
      const t = d.todos.find((x) => x.id === id);
      if (!t) return;
      if (patch.text !== undefined) t.text = String(patch.text).slice(0, 300);
      if (patch.done !== undefined) t.done = Boolean(patch.done);
      if (patch.priority !== undefined) t.priority = patch.priority;
      if (patch.due !== undefined) t.due = patch.due;
      updated = t;
    });
    if (!updated) return fail(res, 404, '待办不存在');
    ok(res, updated);
  }),
);

router.delete(
  '/todos/:id',
  wrap(async (req, res) => {
    const before = db().todos.length;
    update((d) => {
      d.todos = d.todos.filter((t) => t.id !== req.params.id);
    });
    ok(res, { removed: before - db().todos.length });
  }),
);

/** 一键清理已完成的待办 */
router.post(
  '/todos/clear-done',
  wrap(async (_req, res) => {
    let removed = 0;
    update((d) => {
      removed = d.todos.filter((t) => t.done).length;
      d.todos = d.todos.filter((t) => !t.done);
    });
    ok(res, { removed });
  }),
);

/* ── 任务 ──────────────────────────────────────────────────── */
const TICKET_STATUS = ['todo', 'doing', 'review', 'done'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/** 标签规范化：去重、限长、限数量，别让脏数据进库 */
function normalizeTags(input) {
  if (!Array.isArray(input)) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const tag = String(raw ?? '').trim().slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}

/** 子任务规范化：丢掉空文本、补 ID、限条数 */
function normalizeChecklist(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .slice(0, 50)
    .map((item, i) => ({
      id: String(item?.id || `ck_${i + 1}`).slice(0, 48),
      text: String(item?.text ?? '').trim().slice(0, 200),
      done: Boolean(item?.done),
    }))
    .filter((item) => item.text);
}

/**
 * 把一份 patch 应用到单个任务上。批量与单条共用同一套规则，避免两边慢慢漂移。
 * 注意：归档 / 回收站不在这里改，它们有专用接口 —— 免得一次普通编辑把任务藏起来。
 */
function applyTicketPatch(t, patch) {
  if (patch.title !== undefined) t.title = String(patch.title).trim().slice(0, 200);
  if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) t.priority = patch.priority;
  if (patch.status !== undefined && TICKET_STATUS.includes(patch.status)) t.status = patch.status;
  if (patch.project !== undefined) t.project = String(patch.project).slice(0, 80);
  // 分类跟着项目走：同一个项目里的某个「分组」。名字在单项目内唯一（见 db/sections.js）
  if (patch.section !== undefined) t.section = String(patch.section).slice(0, 120);
  if (patch.owner !== undefined) t.owner = String(patch.owner).slice(0, 80);
  if (patch.due !== undefined) t.due = String(patch.due).slice(0, 40);
  // 备注现在要装图片引用，1000 字符不够用（贴几张图就满了，还会被静默截断）；
  // 给到 20000 而不是不限，避免误贴超长内容把库撑大
  if (patch.note !== undefined) t.note = String(patch.note).slice(0, 20000);
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    if (tags) t.tags = tags;
  }
  if (patch.checklist !== undefined) {
    const checklist = normalizeChecklist(patch.checklist);
    if (checklist) t.checklist = checklist;
  }
  t.updatedAt = new Date().toISOString();
}

router.get('/tickets', (_req, res) => ok(res, db().tickets));

router.post(
  '/tickets',
  wrap(async (req, res) => {
    const {
      title,
      priority = 'P2',
      status = 'todo',
      project = '',
      section = '',
      owner = '',
      due = '',
      note = '',
    } = req.body || {};
    if (!title || !String(title).trim()) return fail(res, 400, '任务标题不能为空');
    const maxSeq = db().tickets.reduce((m, t) => {
      const n = Number(String(t.id).replace(/\D/g, ''));
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 1000);
    const ticket = {
      id: `WO-${maxSeq + 1}`,
      title: String(title).trim().slice(0, 200),
      priority: PRIORITIES.includes(priority) ? priority : 'P2',
      status: TICKET_STATUS.includes(status) ? status : 'todo',
      project: String(project).slice(0, 80),
      // section 必须一起初始化：缺了这个字段，新建的任务在项目视图里会归不了组
      section: String(section).slice(0, 120),
      owner: String(owner).slice(0, 80),
      due: String(due).slice(0, 40),
      // 与 PATCH 的口径保持一致：备注要装图片引用，1000 字符会被静默截断
      note: String(note).slice(0, 20000),
      tags: normalizeTags(req.body?.tags) || [],
      checklist: normalizeChecklist(req.body?.checklist) || [],
      archivedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    };
    update((d) => d.tickets.unshift(ticket));
    ok(res, ticket);
  }),
);

/**
 * 批量修改：一次提交多个 id + 同一份 patch，省掉 N 次往返。
 * 必须注册在 `/tickets/:id` 之前，否则 "batch" 会被当成一个任务 ID 吃掉。
 */
router.patch(
  '/tickets/batch',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const patch = req.body?.patch || {};
    if (!ids.length) return fail(res, 400, '没有选中任何任务');
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) return fail(res, 400, '没有要修改的内容');

    const updated = [];
    update((d) => {
      for (const t of d.tickets) {
        if (!ids.includes(t.id)) continue;
        applyTicketPatch(t, patch);
        updated.push(t);
      }
    });
    if (!updated.length) return fail(res, 404, '没有找到选中的任务');
    ok(res, { updated: updated.length, tickets: updated });
  }),
);

/**
 * 批量彻底删除（回收站里用）。评论与附件在独立表，这里逐个清掉，免得留下孤儿行。
 * 必须注册在 `/tickets/:id` 之前，否则 "batch-delete" 会被当成一个任务 ID。
 * 只删回收站里的任务：万一调用方误传了进行中的 id，这里挡下来 ——
 * 「批量删除」不能变成「批量毁数据」。
 */
router.post(
  '/tickets/batch-delete',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return fail(res, 400, '没有选中任何任务');

    const targets = db()
      .tickets.filter((t) => ids.includes(t.id) && t.deletedAt)
      .map((t) => t.id);
    if (!targets.length) return fail(res, 400, '只有回收站里的任务才能彻底删除');

    update((d) => {
      d.tickets = d.tickets.filter((t) => !targets.includes(t.id));
    });

    let removedComments = 0;
    let removedAttachments = 0;
    for (const id of targets) {
      const [comments, files] = await Promise.all([
        clearTicketComments(id).catch(() => 0),
        clearTicketAttachments(id).catch(() => 0),
      ]);
      removedComments += comments;
      removedAttachments += files;
    }
    ok(res, { removed: targets.length, removedComments, removedAttachments });
  }),
);

router.patch(
  '/tickets/:id',
  wrap(async (req, res) => {
    let updated = null;
    update((d) => {
      const t = d.tickets.find((x) => x.id === req.params.id);
      if (!t) return;
      applyTicketPatch(t, req.body || {});
      updated = t;
    });
    if (!updated) return fail(res, 404, '任务不存在');
    ok(res, updated);
  }),
);

/** 归档 / 取消归档 */
router.post(
  '/tickets/:id/archive',
  wrap(async (req, res) => {
    const archived = req.body?.archived !== false;
    let updated = null;
    update((d) => {
      const t = d.tickets.find((x) => x.id === req.params.id);
      if (!t) return;
      t.archivedAt = archived ? new Date().toISOString() : null;
      t.updatedAt = new Date().toISOString();
      updated = t;
    });
    if (!updated) return fail(res, 404, '任务不存在');
    ok(res, updated);
  }),
);

/** 移入回收站（软删除，可恢复） */
router.post(
  '/tickets/:id/trash',
  wrap(async (req, res) => {
    let updated = null;
    update((d) => {
      const t = d.tickets.find((x) => x.id === req.params.id);
      if (!t) return;
      t.deletedAt = new Date().toISOString();
      t.updatedAt = new Date().toISOString();
      updated = t;
    });
    if (!updated) return fail(res, 404, '任务不存在');
    ok(res, updated);
  }),
);

/** 恢复：归档与回收站一起清掉，从哪儿来回哪儿去 */
router.post(
  '/tickets/:id/restore',
  wrap(async (req, res) => {
    let updated = null;
    update((d) => {
      const t = d.tickets.find((x) => x.id === req.params.id);
      if (!t) return;
      t.deletedAt = null;
      t.archivedAt = null;
      t.updatedAt = new Date().toISOString();
      updated = t;
    });
    if (!updated) return fail(res, 404, '任务不存在');
    ok(res, updated);
  }),
);

/** 彻底删除（只在回收站里用）。评论在独立表，这里顺手清掉，免得留下孤儿行。 */
router.delete(
  '/tickets/:id',
  wrap(async (req, res) => {
    const exists = db().tickets.some((t) => t.id === req.params.id);
    if (!exists) return fail(res, 404, '任务不存在');
    update((d) => {
      d.tickets = d.tickets.filter((t) => t.id !== req.params.id);
    });
    const [removedComments, removedAttachments] = await Promise.all([
      clearTicketComments(req.params.id).catch(() => 0),
      clearTicketAttachments(req.params.id).catch(() => 0),
    ]);
    ok(res, { removed: 1, removedComments, removedAttachments });
  }),
);

/* 任务评论：独立表逐行读写（不走内存镜像，理由见 db/comments.js） */
router.get(
  '/tickets/:id/comments',
  wrap(async (req, res) => {
    ok(res, { comments: await listComments(req.params.id) });
  }),
);

router.post(
  '/tickets/:id/comments',
  wrap(async (req, res) => {
    const content = req.body?.content;
    if (!content || !String(content).trim()) return fail(res, 400, '评论内容不能为空');
    if (!db().tickets.some((t) => t.id === req.params.id)) return fail(res, 404, '任务不存在');
    ok(res, await addComment(req.params.id, content));
  }),
);

router.delete(
  '/tickets/comments/:id',
  wrap(async (req, res) => {
    const removed = await removeComment(req.params.id);
    if (!removed) return fail(res, 404, '评论不存在');
    ok(res, { removed: 1 });
  }),
);

/* 任务附件：同样是独立表逐行读写（见 db/attachments.js） */
router.get(
  '/tickets/:id/attachments',
  wrap(async (req, res) => {
    ok(res, { attachments: await listAttachments(req.params.id) });
  }),
);

router.post(
  '/tickets/:id/attachments',
  wrap(async (req, res) => {
    const { name, mime, size, content, inline } = req.body || {};
    if (!content) return fail(res, 400, '附件内容不能为空');
    if (!db().tickets.some((t) => t.id === req.params.id)) return fail(res, 404, '任务不存在');
    // 超限（单个太大 / 数量太多）属于请求本身的问题，报 400 而不是 500
    try {
      ok(res, await addAttachment(req.params.id, { name, mime, size, content, inline }));
    } catch (err) {
      fail(res, 400, err.message);
    }
  }),
);

router.delete(
  '/tickets/attachments/:id',
  wrap(async (req, res) => {
    const removed = await removeAttachment(req.params.id);
    if (!removed) return fail(res, 404, '附件不存在');
    ok(res, { removed: 1 });
  }),
);

/* ── 项目（Tower 式的「项目 → 任务」两层）─────────────────────────────
 * 任务侧用 tickets.project 存项目名，所以这里有两个连带动作：
 *   · 改名 → 必须刷一遍该项目的任务，否则它们会整批掉进「未归类」；
 *   · 删除 → 只删项目本身，任务保留、归属清空 —— 删个项目不该把任务一起删掉。
 * ──────────────────────────────────────────────────────────────────── */

router.get(
  '/projects',
  wrap(async (_req, res) => ok(res, { projects: await listProjects() })),
);

router.post(
  '/projects',
  wrap(async (req, res) => {
    try {
      ok(res, await addProject(req.body || {}));
    } catch (err) {
      fail(res, 400, err.message);
    }
  }),
);

router.patch(
  '/projects/:id',
  wrap(async (req, res) => {
    let result;
    try {
      result = await patchProject(req.params.id, req.body || {});
    } catch (err) {
      return fail(res, 400, err.message);
    }
    if (!result) return fail(res, 404, '项目不存在');

    const { before, after } = result;
    const renamed = after.name !== before.name;
    if (renamed) {
      update((d) => {
        for (const t of d.tickets) {
          if (t.project === before.name) t.project = after.name;
        }
      });
    }
    ok(res, { project: after, renamedTasks: renamed });
  }),
);

router.delete(
  '/projects/:id',
  wrap(async (req, res) => {
    const target = await getProject(req.params.id);
    if (!target) return fail(res, 404, '项目不存在');

    await removeProject(req.params.id);
    let cleared = 0;
    update((d) => {
      for (const t of d.tickets) {
        if (t.project === target.name) {
          t.project = '';
          t.section = '';
          cleared += 1;
        }
      }
    });
    ok(res, { removed: 1, clearedTasks: cleared });
  }),
);

/* ── 项目分类（项目详情里的「分组」）──────────────────────────────────
 * 任务侧用 tickets.section 存分类名，所以改名要连带刷该段下的任务；
 * 删除只删分类本身，段里的任务保留、只是失去归属。
 * 注意任务上没有 projectId，只有项目**名**，所以判断归属要先换一次名字。
 * ──────────────────────────────────────────────────────────────────── */

router.get(
  '/projects/:id/sections',
  wrap(async (req, res) => ok(res, { sections: await listSections(req.params.id) })),
);

router.post(
  '/projects/:id/sections',
  wrap(async (req, res) => {
    const project = await getProject(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');
    try {
      ok(res, await addSection(req.params.id, req.body?.name));
    } catch (err) {
      fail(res, 400, err.message);
    }
  }),
);

router.patch(
  '/sections/:id',
  wrap(async (req, res) => {
    let result;
    try {
      result = await patchSection(req.params.id, req.body || {});
    } catch (err) {
      return fail(res, 400, err.message);
    }
    if (!result) return fail(res, 404, '分类不存在');

    const { before, after } = result;
    const renamed = after.name !== before.name;
    if (renamed) {
      const project = await getProject(before.projectId);
      if (project) {
        update((d) => {
          for (const t of d.tickets) {
            if (t.project === project.name && t.section === before.name) t.section = after.name;
          }
        });
      }
    }
    ok(res, { section: after, renamedTasks: renamed });
  }),
);

router.delete(
  '/sections/:id',
  wrap(async (req, res) => {
    const target = await getSection(req.params.id);
    if (!target) return fail(res, 404, '分类不存在');

    await removeSection(req.params.id);
    const project = await getProject(target.projectId);
    let cleared = 0;
    if (project) {
      update((d) => {
        for (const t of d.tickets) {
          if (t.project === project.name && t.section === target.name) {
            t.section = '';
            cleared += 1;
          }
        }
      });
    }
    ok(res, { removed: 1, clearedTasks: cleared });
  }),
);

/* ── 常用网站 ─────────────────────────────────────────────────────── */

/**
 * 上传图标的形状与体积上限。
 *
 * 只收**位图**的 base64 data URL，SVG 明确不收：SVG 能带外链与脚本，
 * 即使通过 <img> 加载时脚本被浏览器挡住，也不该由自己的面板替用户决定
 * 存一份"万一是 SVG 呢"的东西。
 *
 * 上限 256KB。图标是要跟着每一条书签走的（它进 COS 备份，也进下一次
 * /bootstrap 的数据库往返），再大就该落盘而不是进库了。
 */
const ICON_MAX = 256 * 1024;
const ICON_DATA_URL = /^data:image\/(png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/]+={0,2})$/;

/** 校验上传的图标。空串 = 清除（回到自动取 favicon） */
function checkIcon(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { ok: true, value: '' };
  const m = ICON_DATA_URL.exec(v);
  if (!m) return { ok: false, error: '图标只接受 PNG / JPEG / GIF / WebP / AVIF 格式的图片' };
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > ICON_MAX) {
    return { ok: false, error: `图标 ${Math.ceil(bytes / 1024)}KB，超过 ${ICON_MAX / 1024}KB 上限` };
  }
  return { ok: true, value: v };
}

/**
 * 列表里的书签**不带图标本体**。
 *
 * 一张位图 base64 后几百 KB，几十条书签就能把 /bootstrap 顶成几百 KB ——
 * 而那个接口是每次打开面板都要走一遍的首屏数据。改成只给一个
 * hasIcon 布尔，图标本体由 /bookmarks/:id/icon 单独取（可缓存、可协商）。
 *
 * hasIcon 把"自动抓来的"也算进去：对页面来说只要那个地址有图可拿就行，
 * 哪来的不影响渲染；而编辑弹窗要知道**这张图是不是用户自己传的**
 * （"清除"这颗按钮只在有自定义图标时才有意义），所以另给 hasCustomIcon。
 */
function publicBookmark(b) {
  const { icon, iconAuto, ...rest } = b;
  const stored = icon || iconAuto || '';
  return {
    ...rest,
    hasIcon: Boolean(stored),
    hasCustomIcon: Boolean(icon),
    /* 图标内容的短指纹，给前端拼一个可长缓存的地址。
       图标一换这里就变，于是"长缓存"不会让人看了旧图 ——
       代价是每次列表都要算一遍：几十条几 KB 的图标算下来不到 1ms。 */
    iconV: stored ? createHash('sha1').update(stored).digest('base64url').slice(0, 8) : '',
  };
}

/** 把 data URL 拆成 (mime, 字节)，拆不出来返回 null */
function decodeIcon(icon) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(icon || '').trim());
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

router.get('/bookmarks', (_req, res) => {
  const data = db();
  ok(res, { bookmarks: data.bookmarks.map(publicBookmark), groups: data.groups });
});

/**
 * 自定义图标本体。单独一个接口而不是塞进列表响应，
 * 是为了上面 publicBookmark 说的那件事：首屏不背图标，图片按需取。
 *
 * Cache-Control 用 no-cache 而不是 immutable —— 同一个地址的内容会变
 * （用户换图），所以不能让它在浏览器里躺到过期；改由 ETag 协商：
 * 内容没变就回 304，几乎不花流量。
 */
router.get('/bookmarks/:id/icon', (_req, res) => {
  const bm = db().bookmarks.find((b) => b.id === _req.params.id);
  /* 自定义的优先于自动抓来的：用户传那张图就是因为不满意自动取的那张 */
  const decoded = bm ? decodeIcon(bm.icon || bm.iconAuto) : null;
  if (!decoded) return fail(res, 404, '这个书签没有自定义图标');
  const etag = `W/"${decoded.buf.length}-${createHash('sha1').update(decoded.buf).digest('base64url').slice(0, 12)}"`;
  if (_req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Content-Type', decoded.mime);
  /* 带版本参数的请求可以长缓存：那个 v 就是内容指纹（见 publicBookmark），
     图标一变 URL 就变，所以不会有人拿到旧图。
     不带 v 的（直接访问这个地址、或还没拿到版本号的预览）保持协商缓存。 */
  res.setHeader('Cache-Control', _req.query.v ? 'public, max-age=31536000, immutable' : 'private, no-cache');
  res.setHeader('ETag', etag);
  res.send(decoded.buf);
});

/**
 * 探测各站点自己的品牌色，写进书签的 color。
 *
 * 默认只补没颜色的（空 = 还没认过），`force` 才会连已有的一起重探 ——
 * 一次刷新要真的去访问那十几个站点，不该在每次打开页面时都跑。
 * 并发压到 4：这些地址多半在同一台内网机器上，并发再高只是互相排队，
 * 反而把面板本身拖慢。
 *
 * 拿不到色的不算失败到底：前端会退回糖纸色板，failed 里给出原因，
 * 用户可以照着排（超时 / 自签证书 / 站点没有图标 / 图标是纯灰的）。
 */
const COLOR_PROBE_CONCURRENCY = 4;

router.post(
  '/bookmarks/refresh-colors',
  wrap(async (req, res) => {
    const { force = false, ids } = req.body || {};
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const queue = db().bookmarks.filter((b) => (wanted ? wanted.has(b.id) : true) && (force || !b.color));

    const found = [];
    const failed = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const bm = queue[cursor];
        cursor += 1;
        try {
          const hit = await probeSiteColor(bm.url);
          if (hit) found.push({ id: bm.id, name: bm.name, color: hit.color, source: hit.source });
          else failed.push({ id: bm.id, name: bm.name, error: '站点没有声明主题色，图标里也没取到彩色' });
        } catch (err) {
          failed.push({ id: bm.id, name: bm.name, error: err.message || '探测失败' });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(COLOR_PROBE_CONCURRENCY, queue.length) }, worker),
    );

    if (found.length) {
      const byId = new Map(found.map((f) => [f.id, f.color]));
      update((d) => {
        for (const b of d.bookmarks) {
          const color = byId.get(b.id);
          if (color) b.color = color;
        }
      });
    }

    ok(res, { total: queue.length, updated: found.length, colors: found, failed });
  }),
);

/**
 * 抓取并固化一个书签的站点图标（单个）。
 *
 * 前端在"新增工具"之后会顺手调它一次：新加的入口立刻就有自己的图标，
 * 不必等用户去点「同步站点图标与配色」。失败就静默 —— 图标没有不算错，
 * 页面上退回首字色块即可，弹一条"取图标失败"只会让人以为保存出了问题。
 */
router.post(
  '/bookmarks/:id/icon/fetch',
  wrap(async (req, res) => {
    const bm = db().bookmarks.find((b) => b.id === req.params.id);
    if (!bm) return fail(res, 404, '书签不存在');
    /* 用户自己传过图标的不用抓：那张就是他要的 */
    if (bm.icon) return ok(res, publicBookmark(bm));
    const hit = await fetchSiteIcon(bm.url).catch(() => null);
    if (!hit) return ok(res, publicBookmark(bm));
    update((d) => {
      const b = d.bookmarks.find((x) => x.id === bm.id);
      if (b) b.iconAuto = hit.dataUrl;
    });
    ok(res, publicBookmark(db().bookmarks.find((b) => b.id === bm.id)));
  }),
);

/**
 * 批量固化站点图标。
 *
 * 默认只补"还没有图标的"（含自动抓来的），`force` 才会连已有的一起重抓。
 * 与 refresh-colors 同一套：并发 4、逐条记录失败原因。
 *
 * 为什么要批量：面板里几十个入口，一个一个点开编辑太慢；而这件事
 * 只要做一次（结果落库），之后刷新页面就再也不去访问那些站点了。
 */
router.post(
  '/bookmarks/refresh-icons',
  wrap(async (req, res) => {
    const { force = false, ids } = req.body || {};
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const queue = db().bookmarks.filter(
      /* 有自定义图标的跳过：那个地址已经能取到图，再去抓站点是白跑一次 */
      (b) => !b.icon && (wanted ? wanted.has(b.id) : true) && (force || !b.iconAuto),
    );

    const found = [];
    const failed = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const bm = queue[cursor];
        cursor += 1;
        try {
          const hit = await fetchSiteIcon(bm.url);
          /* dataUrl 只留在服务端的内存里（下面要写库）：响应里不带它 ——
             图标本体走 /bookmarks/:id/icon，别让这个接口背上几十 KB 的 base64 */
          if (hit) found.push({ id: bm.id, name: bm.name, dataUrl: hit.dataUrl, from: hit.source });
          else failed.push({ id: bm.id, name: bm.name, error: '站点没有可用的图标（或图标太大、格式不收）' });
        } catch (err) {
          failed.push({ id: bm.id, name: bm.name, error: err.message || '抓取失败' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COLOR_PROBE_CONCURRENCY, queue.length) }, worker));

    if (found.length) {
      const byId = new Map(found.map((f) => [f.id, f]));
      update((d) => {
        for (const b of d.bookmarks) {
          const hit = byId.get(b.id);
          if (hit) {
            /* 抓一遍要几百毫秒到几秒，期间用户可能已经自己传了图标：
               那就把抓来的丢掉，别盖掉他刚传的那张 */
            const current = d.bookmarks.find((x) => x.id === b.id);
            if (current && current.icon) continue;
            b.iconAuto = hit.dataUrl;
          }
        }
      });
    }

    /* icons 一并回给页面：它据此把 hasIcon 标上，磁贴立刻换图，
       不必等下一次全量刷新（与 refresh-colors 回 colors 同一个理由）。
       只回 id / name —— 图标本体走 /bookmarks/:id/icon。 */
    ok(res, {
      total: queue.length,
      updated: found.length,
      icons: found.map(({ id, name }) => ({ id, name })),
      failed,
    });
  }),
);

router.post(
  '/bookmarks',
  wrap(async (req, res) => {
    /* pinned 在新建时也要收：添加工具那个弹窗里有一个「设为常用」开关，
       用户在点保存之前就打开了它 —— 这里漏掉的话，开关会被静默丢弃，
       首页看不到刚加的东西，而界面又没报错。 */
    const { name, url, group = 'grp_ops', note = '', color = '', icon, pinned = false } = req.body || {};
    if (!name || !url) return fail(res, 400, '名称和网址都要填');
    const checked = checkIcon(icon);
    if (!checked.ok) return fail(res, 400, checked.error);
    let normalized = String(url).trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
    const bm = { id: uid('bm'), name: String(name).trim().slice(0, 60), url: normalized, group, note: String(note).slice(0, 120), color, pinned: Boolean(pinned), icon: checked.value };
    update((d) => d.bookmarks.push(bm));
    ok(res, publicBookmark(bm));
  }),
);

router.patch(
  '/bookmarks/:id',
  wrap(async (req, res) => {
    const patch = req.body || {};
    const checked = checkIcon(patch.icon);
    if (!checked.ok) return fail(res, 400, checked.error);
    let updated = null;
    update((d) => {
      const b = d.bookmarks.find((x) => x.id === req.params.id);
      if (!b) return;
      /* 地址换了，抓来的那张图标就是上一个站点的东西了，直接丢掉 ——
         由保存方随后重新抓一次（见 Toolbox 的 onSave）。自定义图标不动：
         那是用户自己传的，跟地址无关。 */
      const repointed = patch.url !== undefined && String(patch.url) !== b.url;
      Object.assign(b, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(repointed ? { iconAuto: '' } : {}),
        ...(patch.group !== undefined ? { group: patch.group } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.pinned !== undefined ? { pinned: Boolean(patch.pinned) } : {}),
        ...(patch.icon !== undefined ? { icon: checked.value } : {}),
      });
      updated = b;
    });
    if (!updated) return fail(res, 404, '书签不存在');
    ok(res, publicBookmark(updated));
  }),
);

router.delete(
  '/bookmarks/:id',
  wrap(async (req, res) => {
    update((d) => {
      d.bookmarks = d.bookmarks.filter((b) => b.id !== req.params.id);
    });
    ok(res, { removed: 1 });
  }),
);

/**
 * 重排书签顺序（工具箱那面磁贴墙）。
 *
 * 与 /groups/reorder 同一套路：传**整份顺序**而不是"把 A 挪到 B 前面"这类
 * 增量指令，一次落库就把 sort_order 按数组下标写死 —— 书签的顺序本来就是
 * 内存数组的顺序（见 db/repository.js 里 bookmarks 的 toRow：sort_order 取下标），
 * 所以这里只管把数组排对。没出现在 ids 里的书签按原相对顺序追加到末尾，
 * 避免"漏传即丢序"。
 *
 * moved 只在**跨分类拖动**时才带：磁贴被放到另一个分类的邻居之间，
 * 那它同时也就换了分类。顺序与分类合成一次写入，不会留下"顺序变了、
 * 分类还没变"的中间态。分类 id 不存在直接拒掉 —— 否则会写出一条指向
 * 空分类的书签，它在页面上根本不会被渲染出来（分组是遍历分类画的）。
 */
router.post(
  '/bookmarks/reorder',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : null;
    if (!ids) return fail(res, 400, 'ids 必须是数组');

    const raw = Array.isArray(req.body?.moved) ? req.body.moved : [];
    const known = new Set(db().groups.map((g) => g.id));
    const moved = [];
    for (const m of raw) {
      if (!m || typeof m.id !== 'string' || typeof m.group !== 'string') return fail(res, 400, 'moved 格式不对');
      if (!known.has(m.group)) return fail(res, 400, '要归入的分类不存在');
      moved.push({ id: m.id, group: m.group });
    }

    let list = null;
    update((d) => {
      for (const m of moved) {
        const b = d.bookmarks.find((x) => x.id === m.id);
        if (b) b.group = m.group;
      }
      const byId = new Map(d.bookmarks.map((b) => [b.id, b]));
      const ordered = ids.filter((id) => byId.has(id));
      for (const b of d.bookmarks) if (!ordered.includes(b.id)) ordered.push(b.id);
      d.bookmarks = ordered.map((id) => byId.get(id));
      list = d.bookmarks;
    });
    /* 回整份列表而不是只回 { ok: true }：前端要拿服务端的最终顺序兜底，
       免得"本地乐观排的结果"和"库里真正落下的顺序"悄悄分叉 */
    ok(res, { bookmarks: list.map(publicBookmark) });
  }),
);

router.post(
  '/groups',
  wrap(async (req, res) => {
    const { name } = req.body || {};
    if (!name) return fail(res, 400, '分组名称不能为空');
    const group = { id: uid('grp'), name: String(name).slice(0, 40), order: db().groups.length };
    update((d) => d.groups.push(group));
    ok(res, group);
  }),
);

/**
 * 改分类名。书签里存的是分组 id 而不是名字，所以改名不用回头改任何 bookmark ——
 * 这正是当初用 id 关联的意义，别因为"只有名字变了"就改成存名字。
 */
router.patch(
  '/groups/:id',
  wrap(async (req, res) => {
    const raw = String(req.body?.name ?? '').trim();
    if (!raw) return fail(res, 400, '分组名称不能为空');
    const name = raw.slice(0, 40);
    let updated = null;
    update((d) => {
      const g = d.groups.find((x) => x.id === req.params.id);
      if (!g) return;
      if (d.groups.some((x) => x.id !== g.id && x.name === name)) {
        return; // 重名不拦，但也不改：两个同名分组在筛选条上无法区分
      }
      g.name = name;
      updated = g;
    });
    if (!updated) return fail(res, 404, '分组不存在，或已有同名分组');
    ok(res, updated);
  }),
);

/**
 * 重排分类顺序：前端把拖动（或「按名称排序」）之后的完整 id 顺序传过来。
 *
 * 传的是**整份顺序**而不是"把 A 挪到 B 前面"这类增量指令：一次落库就把
 * 所有 sort_order 写死成下标，不留需要靠时间戳去猜的相对位置。没出现在
 * ids 里的分类（正常不会发生）按原相对顺序追加到末尾，避免"漏传即丢序"。
 */
router.post(
  '/groups/reorder',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : null;
    if (!ids) return fail(res, 400, 'ids 必须是数组');
    let groups = null;
    update((d) => {
      const byId = new Map(d.groups.map((g) => [g.id, g]));
      const ordered = ids.filter((id) => byId.has(id));
      for (const g of d.groups) if (!ordered.includes(g.id)) ordered.push(g.id);
      d.groups = ordered.map((id, i) => ({ ...byId.get(id), order: i }));
      groups = d.groups;
    });
    ok(res, { groups });
  }),
);

/* ── 知识库 ───────────────────────────────────────────────────────── */

/**
 * SSE 样板：响应头、心跳、断开检测。
 *
 * 工作台助手（/assistant/stream）和文章助手（/knowledge/ai）共用这一份。
 * 里面有个必须照做的坑：**要听 res 的 close，不能听 req 的** ——
 * req 在请求体读完时就触发 close，用它会把整个流误判成"客户端已断开"，
 * 结果一个字节都发不出去、连接只能挂着。这种坑复制两份迟早踩错一份。
 */
function openSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx 那边已经关了 buffering，这里再声明一遍：换个反代也不会攒着不发
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const send = (event) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // 推理阶段万一没有输出，心跳能让中间设备看到连接还活着
  const ping = setInterval(() => {
    if (closed || res.writableEnded) return;
    res.write(': ping\n\n');
  }, 15000);

  return {
    send,
    close: () => {
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    },
  };
}

/**
 * 对外的条目形态（**不带正文**）。
 *
 * 为什么不带：正文动辄上万字，而列表、首屏、搜索结果要的都只是
 * "这一篇大概讲了什么"。为这个把每一篇的完整 Markdown 都发下去，
 * 等于打开首页就得下载整个知识库 —— 而 BODY_MAX 是 20 万字，
 * 导入三五本手册就是几 MB，且**每个页面都为它买单**（/bootstrap 里就有）。
 *
 * 所以列表只给 excerpt（正文开头一小段纯文本），正文按需单独取：
 * `GET /knowledge/:id`，或 `?full=1`（图谱那种真要扫全部正文的地方）。
 *
 * 字段是显式列的（同 /news 的做法）：加字段时记得同步，漏了不会报错，
 * 前端只会静默拿不到。
 */
const EXCERPT_MAX = 140;

const excerptOf = (k) => {
  const plain = String(k?.body_plain || '');
  return plain.length > EXCERPT_MAX ? `${plain.slice(0, EXCERPT_MAX)}…` : plain;
};

const publicOne = (k) => ({
  id: k.id,
  type: k.type,
  title: k.title,
  tags: k.tags,
  summary: k.summary,
  /* 卡片上的预览。用的是 body_plain 的头一段：它本来就是给"读个大概"用的，
     前端不必再粗剥一遍 Markdown（那是第二份实现，迟早分叉） */
  excerpt: excerptOf(k),
  pinned: Boolean(k.pinned),
  starred: Boolean(k.starred),
  /* 文章助手的对话记录。它跟着条目走，所以只看得到这一篇自己的回答 */
  ai: k.ai && Array.isArray(k.ai.turns) ? k.ai : { turns: [] },
  /* 回收站标记。**不在这里过滤**：列表整份发给前端，由它按"知识库 / 回收站"
     分成两份。多一个服务端筛选参数，就多一处"前后端口径对不上"的机会，
     而条目数并不大（正文本来就不在列表里）。口径与 tickets 一致。 */
  deletedAt: k.deletedAt ?? null,
  updatedAt: k.updatedAt,
});

/** 列表形态：元信息 + 摘要 */
const publicKnowledge = (list) => (Array.isArray(list) ? list : []).map(publicOne);

/** 完整形态（含正文）。只给真要读 / 写 / 扫全文的几处 */
const publicKnowledgeFull = (list) => (Array.isArray(list) ? list : []).map((k) => ({ ...publicOne(k), body: String(k.body ?? '') }));

/**
 * 搜索。**必须服务端做**：打在 body_plain 上，而列表已经不带正文了。
 * 这也是 body_plain 存在的理由 —— 它一直派不上用场，只因为搜索在客户端。
 *
 * 命中在正文里时给**上下文**而不是开头那 140 字：搜 zpool 想看的是
 * 那条命令前后写了什么，不是这篇文章的第一句。
 */
const SNIPPET_MAX = 140;
function searchKnowledge(list, raw) {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return null;

  const out = [];
  for (const k of list) {
    const title = String(k.title || '');
    const summary = String(k.summary || '');
    const tags = (Array.isArray(k.tags) ? k.tags : []).join(' ');
    const plain = String(k.body_plain || '');
    const at = plain.toLowerCase().indexOf(q);
    const inMeta =
      title.toLowerCase().includes(q) || summary.toLowerCase().includes(q) || tags.toLowerCase().includes(q);
    if (at < 0 && !inMeta) continue;

    let snippet = excerptOf(k);
    if (at >= 0) {
      const start = Math.max(0, at - 40);
      const end = Math.min(plain.length, start + SNIPPET_MAX);
      snippet = `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
    }
    out.push({ ...publicOne(k), snippet });
  }
  return out;
}

router.get('/knowledge', (req, res) => {
  const list = db().knowledge;
  const hits = searchKnowledge(list, req.query?.q);
  if (hits) return ok(res, hits);
  /* full=1 是给图谱的：它要把所有正文扫一遍找 [[双链]]，没法只拿摘要 */
  ok(res, req.query?.full === '1' ? publicKnowledgeFull(list) : publicKnowledge(list));
});

/** 单篇（含正文）。阅读页与编辑器按需取 */
router.get('/knowledge/:id', (req, res) => {
  const k = db().knowledge.find((x) => x.id === req.params.id);
  if (!k) return fail(res, 404, '条目不存在');
  ok(res, { ...publicOne(k), body: String(k.body ?? '') });
});

/**
 * 标签批量改写：改名 / 合并 / 删除。
 *
 * 标签是每条自己存的字符串数组，没有"标签表"，所以改一个名字原本要逐篇编辑。
 * 于是 `PVE` 与 `pve`、`网络` 与 `网络配置` 各成一体，而这个碎法会**放大到
 * 图谱上** —— 标签节点是一整类节点，碎掉之后就是一堆分不清的孤立小点。
 *
 * 改名到**已存在**的名字 = 合并：替换后再去重，两堆自然合成一堆。
 * 返回改完的整份列表，省掉客户端再拉一次。
 */
router.post(
  '/knowledge/tags',
  wrap(async (req, res) => {
    const renames = Array.isArray(req.body?.renames) ? req.body.renames : [];
    const removes = Array.isArray(req.body?.removes) ? req.body.removes : [];

    const map = new Map();
    for (const r of renames) {
      const from = String(r?.from ?? '').trim();
      const to = String(r?.to ?? '').trim();
      if (!from || !to || from === to) continue;
      map.set(from, to.slice(0, 24));
    }
    const drop = new Set(removes.map((t) => String(t ?? '').trim()).filter(Boolean));
    if (!map.size && !drop.size) return fail(res, 400, '没有要改的标签');

    let changed = 0;
    update((d) => {
      for (const k of d.knowledge) {
        const tags = Array.isArray(k.tags) ? k.tags : [];
        const next = [];
        for (const t of tags) {
          if (drop.has(t)) continue;
          const to = map.get(t) ?? t;
          if (drop.has(to)) continue;
          if (!next.includes(to)) next.push(to); // 合并后去重
        }
        if (next.length !== tags.length || next.some((t, i) => t !== tags[i])) {
          k.tags = next.slice(0, 8);
          changed += 1;
        }
      }
    });
    /* 不动 updatedAt：改的是分类口径，不是"这篇文章更新了" ——
       否则批量改一次标签，整个列表的「更新于」全变成刚刚，顺序也乱了 */
    ok(res, { list: publicKnowledge(db().knowledge), changed });
  }),
);

/**
 * 抓一个外链文章并转成 Markdown。**只返回结果，不写库** ——
 * 抽取是启发式的，一定要让人过一眼再决定存不存（见 services/importer.js）。
 */
router.post(
  '/knowledge/import',
  wrap(async (req, res) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url) return fail(res, 400, '请填一个网址');
    try {
      ok(res, await importFromUrl(url));
    } catch (err) {
      /* 失败原因原样带出去：连不上、被反爬、还是页面里没正文，
         这三种的处置完全不同，糊成一句"导入失败"就没法排查了。 */
      fail(res, 502, err.message);
    }
  }),
);

/**
 * 文章助手（SSE）：总结 / 分析 / 解释，或自由追问。
 *
 * 正文由**前端传进来**，不从库里读 —— 编辑器里那些还没保存的改动也该能问。
 * 走流式是必须的：Hermes 处理复杂问题实测 29–64 秒，一把返回界面得冻住一分钟。
 */
router.post(
  '/knowledge/ai',
  wrap(async (req, res) => {
    const { task, question, article, history } = req.body || {};
    const title = String(article?.title || '').slice(0, 200);
    const body = String(article?.body || '');
    if (!title.trim() && !body.trim()) return fail(res, 400, '这篇文章还是空的，没什么可读的');

    const sse = openSse(res);
    try {
      await askAboutArticle(
        {
          title,
          summary: String(article?.summary || '').slice(0, 400),
          tags: Array.isArray(article?.tags) ? article.tags.map(String).slice(0, 8) : [],
          body,
        },
        {
          task: String(task || ''),
          question: String(question || '').slice(0, 2000),
          /* 追问要带上前面的轮次，否则"第 3 条具体怎么做"没有指代对象。
             长度和条数由服务层再夹一次，这里只保证拿到的是一个数组 */
          history: Array.isArray(history) ? history : [],
        },
        sse.send,
      );
    } catch (err) {
      // 头已经发出去了，改不了状态码，只能作为一次 error 事件收尾
      sse.send({ type: 'error', message: err.message });
    } finally {
      sse.close();
    }
  }),
);

router.post(
  '/knowledge',
  wrap(async (req, res) => {
    const { type = 'sop', title, tags = [], summary = '', body = '', steps = [], pinned = false, starred = false } = req.body || {};
    if (!title) return fail(res, 400, '标题不能为空');
    /* steps 是旧字段，只在没给 body 时用来兜底 —— 旧客户端和旧备份都还可能带它。
       body_plain 统一由 withKnowledgeBody 派生，不在这里手搓。 */
    const item = withKnowledgeBody({
      id: uid('kb'),
      type: normalizeType(type),
      title: String(title).slice(0, 160),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : [],
      summary: String(summary).slice(0, 400),
      body: String(body ?? '').slice(0, BODY_MAX),
      steps: Array.isArray(steps) ? steps.map((s) => String(s).slice(0, 800)).slice(0, 40) : [],
      pinned: Boolean(pinned),
      starred: Boolean(starred),
      ai: { turns: [] },
      updatedAt: new Date().toISOString(),
    });
    update((d) => d.knowledge.unshift(item));
    /* 回元信息形态：编辑器只要 id 去跳阅读页，正文它自己会按需取 */
    ok(res, publicOne(item));
  }),
);

router.patch(
  '/knowledge/:id',
  wrap(async (req, res) => {
    const patch = req.body || {};
    let updated = null;
    update((d) => {
      const k = d.knowledge.find((x) => x.id === req.params.id);
      if (!k) return;
      /* 只有内容真的变了才动 updatedAt。置顶 / 星标不是"更新了这篇文章" ——
         把时间戳一起刷新，卡片上那句"更新于"就开始说谎，也没法再按它看新鲜度。 */
      let touched = false;
      if (patch.type !== undefined) {
        k.type = normalizeType(patch.type);
        touched = true;
      }
      if (patch.title !== undefined) {
        k.title = String(patch.title).slice(0, 160);
        touched = true;
      }
      if (patch.summary !== undefined) {
        k.summary = String(patch.summary).slice(0, 400);
        touched = true;
      }
      if (patch.tags !== undefined && Array.isArray(patch.tags)) {
        k.tags = patch.tags.slice(0, 8);
        touched = true;
      }
      /* 只有真的改了 body 才重算纯文本；只改标题时不该动正文。
         steps 不再接受写入：它已经是只读的遗留字段（见 services/knowledge.js）。 */
      if (patch.body !== undefined) {
        k.body = String(patch.body ?? '').slice(0, BODY_MAX);
        k.body_plain = markdownToPlain(k.body);
        touched = true;
      }
      if (patch.pinned !== undefined) k.pinned = Boolean(patch.pinned);
      if (patch.starred !== undefined) k.starred = Boolean(patch.starred);
      /* 助手对话整份覆盖（单个用户，不存在并发写同一篇）。
         同样不算"更新了这篇文章"，所以不动 updatedAt —— 否则问一句话
         就会把「更新于」刷新一遍，还会把列表顺序搅乱。 */
      if (patch.ai !== undefined) k.ai = sanitizeAiLog(patch.ai);
      if (touched) k.updatedAt = new Date().toISOString();
      updated = k;
    });
    if (!updated) return fail(res, 404, '条目不存在');
    /* 回元信息形态：客户端拿它覆盖本地那一份，
       excerpt 是服务端按新正文重算的（保存后卡片上的预览得跟着变） */
    ok(res, publicOne(updated));
  }),
);

/**
 * ── 回收站 ─────────────────────────────────────────────────────────────
 *
 * 删除一律先软删除（写 `deletedAt`），彻底删除只认回收站里的条目 ——
 * 口径与 tickets 完全一致，连批量接口的保护规则也一样：
 * 误传一个还在用的 id 时宁可报错，也不能让「批量删除」变成「批量毁数据」。
 *
 * 所有写操作都不动 `updatedAt`：进回收站、恢复都不是「这篇文章更新了」。
 * 动它会让列表的「更新于」和排序整片错位，恢复回来也回不到原位。
 */
router.post(
  '/knowledge/:id/trash',
  wrap(async (req, res) => {
    let updated = null;
    update((d) => {
      const k = d.knowledge.find((x) => x.id === req.params.id);
      if (!k) return;
      k.deletedAt = new Date().toISOString();
      updated = k;
    });
    if (!updated) return fail(res, 404, '条目不存在');
    ok(res, publicOne(updated));
  }),
);

router.post(
  '/knowledge/:id/restore',
  wrap(async (req, res) => {
    let updated = null;
    update((d) => {
      const k = d.knowledge.find((x) => x.id === req.params.id);
      if (!k) return;
      k.deletedAt = null;
      updated = k;
    });
    if (!updated) return fail(res, 404, '条目不存在');
    ok(res, publicOne(updated));
  }),
);

/* 这两个必须排在 `/knowledge/:id` 那组之前，否则 "batch-trash" 会被当成条目 ID */
router.post(
  '/knowledge/batch-trash',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return fail(res, 400, '没有选中任何条目');

    const targets = db()
      .knowledge.filter((k) => ids.includes(k.id) && !k.deletedAt)
      .map((k) => k.id);
    if (!targets.length) return fail(res, 400, '选中的条目都已经在回收站里了');

    const at = new Date().toISOString();
    update((d) => {
      for (const k of d.knowledge) if (targets.includes(k.id)) k.deletedAt = at;
    });
    ok(res, { trashed: targets.length });
  }),
);

router.post(
  '/knowledge/batch-delete',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return fail(res, 400, '没有选中任何条目');

    const targets = db()
      .knowledge.filter((k) => ids.includes(k.id) && k.deletedAt)
      .map((k) => k.id);
    if (!targets.length) return fail(res, 400, '只有回收站里的条目才能彻底删除');

    update((d) => {
      d.knowledge = d.knowledge.filter((k) => !targets.includes(k.id));
    });
    ok(res, { removed: targets.length });
  }),
);

/** 彻底删除（单条）。同样只认回收站里的：列表页那颗「删除」是软删除，走 trash */
router.delete(
  '/knowledge/:id',
  wrap(async (req, res) => {
    const k = db().knowledge.find((x) => x.id === req.params.id);
    if (!k) return fail(res, 404, '条目不存在');
    if (!k.deletedAt) return fail(res, 400, '这条还没进回收站，先删除再去回收站里彻底清掉');
    update((d) => {
      d.knowledge = d.knowledge.filter((x) => x.id !== req.params.id);
    });
    ok(res, { removed: 1 });
  }),
);

/* ── AI 热点 ──────────────────────────────────────────────────────── */
router.get('/news', (_req, res) => {
  const n = db().news;
  /* 这里的字段是显式列的，加字段时记得同步 —— 漏了不会报错，
     前端只会静默拿不到（热点榜就一直是"还没抓过榜"） */
  ok(res, {
    items: n.items,
    updatedAt: n.updatedAt,
    lastError: n.lastError,
    /* 入库时被分数门槛挡掉多少条。界面上只在 >0 时显示 */
    dropped: n.dropped ?? 0,
    hot: n.hot ?? null,
    daily: n.daily ?? null,
  });
});

router.post(
  '/news/refresh',
  wrap(async (_req, res) => {
    const result = await refreshNews(db().settings);
    if (!result.ok && !db().news.items.length) return fail(res, 502, `抓取失败：${result.errors.join('；')}`, { errors: result.errors });
    ok(res, { ...result, lastError: result.errors.join('；') || null });
  }),
);

/**
 * AI 读一篇热点文章（SSE）：抓原文 → 用中文讲一遍。
 *
 * 正文由服务端自己按 url 去抓，不从客户端传 —— 客户端手里只有摘要，
 * 而"读文章"要的是正文。条目元信息（标题/来源/摘要/推荐理由）由客户端传，
 * 因为它们在热点列表里，服务端不必为此再查一次库。
 *
 * 流式是必须的：抓一次网页要几秒，再叠上大模型读长文的几十秒，
 * 一把返回的话界面得冻住一分钟。
 */
router.post(
  '/news/read',
  wrap(async (req, res) => {
    const { url, zhUrl, item, task, question, history, force } = req.body || {};
    const target = String(url || '').trim();
    /* 这条没有原文地址（上游偶尔给空 link）时直接说清楚，别开流再说 —— 
       开流之后错误只能作为事件发出去，状态码就没法用了 */
    if (!/^https?:\/\//i.test(target)) return fail(res, 400, '这条没有可读的原文地址');

    /* AIHOT 的条目页（里面有译好的中文全文）。**可以没有** ——
       老条目、或者上游没给这一条时它为空，那时就照旧去抓原文。
       server 不再自己拼这个地址：客户端手里本来就有这一条的全部元信息。 */
    const zhTarget = /^https?:\/\//i.test(String(zhUrl || '')) ? String(zhUrl).trim() : '';

    const sse = openSse(res);
    try {
      await askAboutNews(
        {
          url: target,
          zhUrl: zhTarget,
          item: {
            title: String(item?.title || '').slice(0, 300),
            source: String(item?.source || '').slice(0, 120),
            summary: String(item?.summary || '').slice(0, 600),
            reason: String(item?.reason || '').slice(0, 600),
            publishedAt: String(item?.publishedAt || '').slice(0, 32),
          },
          task: String(task || ''),
          question: String(question || '').slice(0, 2000),
          history: Array.isArray(history) ? history : [],
          /* true = 无视"这个站点读不了"的名单，硬抓一次。
             名单是为了省掉白等，不是封禁，所以必须留这条出口。 */
          force: Boolean(force),
        },
        sse.send,
      );
    } catch (err) {
      // 头已经发出去了，改不了状态码，只能作为一次 error 事件收尾
      sse.send({ type: 'error', message: err.message });
    } finally {
      sse.close();
    }
  }),
);

/**
 * 取刚才为 AI 读抓下来的那份**正文**。
 *
 * 叫 body 而不是 original：现在读到的可能是 AIHOT 译好的中文版，
 * 也可能才是原稿，取决于 meta 里那个 source —— 一律叫"原文"就不准了。
 *
 * **只读服务端缓存、不发起任何抓取**（见 services/reader.js 的 cachedBody），
 * 所以它没有引入新的 SSRF 面：能拿到的只有"这次读过的那一篇"。
 * 没读过或缓存已被淘汰时返回 404，前端据此退回"去原站看"。
 */
router.get(
  '/news/read/body',
  wrap(async (req, res) => {
    const url = String(req.query?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return fail(res, 400, '缺少可用的正文地址');
    const hit = cachedBody(url);
    if (!hit) return fail(res, 404, '这份正文已经不在缓存里了，可以去原站看');
    ok(res, hit);
  }),
);

/** 当前判为读不了的站点。列表页据此提前标出来，省掉一次注定失败的白等 */
router.get('/news/read/unreadable', (_req, res) => ok(res, { hosts: unreadableHosts() }));

/**
 * 搜索建议（首页大搜索框的联想词）。
 *
 * 这是本站**唯一**会把用户输入转发给第三方的接口，所以口径要说清：
 * · 只在登录后可达（挂在 /api 下，登录守卫在前面）；
 * · 上游主机写死在 services/suggest.js 的映射表里，不拿用户填的引擎地址
 *   去请求（否则就是一个能拿后端身份访问任意地址的跳板）；
 * · 总开关在设置里（search.suggest），关掉之后**服务端也不给**，
 *   而不是只让前端不问 —— 一个"关了还在发"的开关等于没关；
 * · 词长卡在 64 字：这个接口不收长文本，它只是取几个候选词。
 */
router.get(
  '/search/suggest',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 64);
    const engineId = String(req.query.engine ?? '');
    const search = db().settings.search ?? {};
    const enabled = search.suggest !== false;
    const engine = (search.engines ?? []).find((e) => e.id === engineId);
    const source = enabled && q && engine ? suggestSource(engine.url) : null;
    if (!source) return ok(res, { items: [], source: null, supported: false, enabled });
    ok(res, {
      items: await fetchSuggest(source, q),
      source: source.id,
      label: source.label,
      supported: true,
      enabled,
    });
  }),
);

/* ── 设置 / 备份 ──────────────────────────────────────────────────── */
router.get('/settings', (_req, res) => ok(res, maskSettings(db().settings)));

router.put(
  '/settings',
  wrap(async (req, res) => {
    const incoming = req.body || {};
    // 插座列表先校验再落库：以前是在规范化时把"没选实体"的行悄悄筛掉，
    // 接口照样返回成功，前端就以为存上了。宁可明确报错，也不要静默丢数据。
    if (Array.isArray(incoming.ha?.sockets)) {
      const missing = incoming.ha.sockets.filter((s) => !String(s?.powerEntity || '').trim());
      if (missing.length) {
        return fail(res, 400, `有 ${missing.length} 路插座还没选功率实体，请选好再保存`);
      }
    }

    /* backup 这一段先整理、再校验、最后才落库。
       校验不能塞进下面的 update 里 —— 内存那时候已经改过了，而失败响应
       同样会触发落库（见 index.js 的落库闸门），于是"报错但存进去了"。 */
    const nextBackup = incoming.backup ? mergeBackup(db().settings.backup, incoming.backup) : null;
    if (incoming.backup) {
      /* 落一个跑不起来的 cron，表现是"页面显示已启用、却永远不备份"，
         比当场报错难查得多 —— 所以在这里就挡掉 */
      if (nextBackup.cron && !isValidCron(nextBackup.cron)) {
        return fail(res, 400, `cron 表达式无效：${nextBackup.cron}`);
      }
      if (nextBackup.enabled) {
        /* 缺凭证时打开开关，结果只是每天静默失败一次。倒不如现在就说清楚 */
        const missing = cosMissing(cosConfig({ backup: nextBackup }));
        if (missing.length) return fail(res, 400, `开启自动备份前请先填好：${missing.join('、')}`);
      }
    }

    /* 同 backup：搜索源先整理、校验，再落库。校验一旦塞进 update 里，
       内存已经改过了，而失败响应同样会触发落库——于是"报错但存进去了"。 */
    const nextSearch = incoming.search ? normalizeSearch(db().settings.search, incoming.search) : null;
    if (nextSearch && !nextSearch.ok) return fail(res, 400, nextSearch.error);

    update((d) => {
      const s = d.settings;
      if (incoming.theme) s.theme = { ...s.theme, ...incoming.theme };
      if (incoming.profile) {
        // 称呼会直接渲染进首页的 h1，所以落库前先裁掉首尾空白并限长——
        // 前后带空格会把问候语的排版撑开，过长的名字也会把标题挤换行。
        s.profile = { ...s.profile, name: String(incoming.profile.name ?? '').trim().slice(0, 24) };
      }
      if (incoming.background) {
        const b = incoming.background;
        s.background = {
          kind: ['none', 'url', 'upload'].includes(b.kind) ? b.kind : 'none',
          url: String(b.url ?? '').trim().slice(0, 1000),
          // 遮罩与虚化都卡在合理区间：越界值会让背景要么压掉正文、要么糊成一团
          overlay: Math.min(0.9, Math.max(0, Number(b.overlay) || 0)),
          blur: Math.min(24, Math.max(0, Number(b.blur) || 0)),
        };
      }
      if (incoming.loginBackground) {
        const b = incoming.loginBackground;
        // kind 用 canvas 而不是 none：登录页的"无背景"是指那层柔彩画布，
        // 语义上和主背景的"无"（页面自己的渐变）不是一回事
        s.loginBackground = {
          kind: ['canvas', 'url', 'upload'].includes(b.kind) ? b.kind : 'canvas',
          url: String(b.url ?? '').trim().slice(0, 1000),
          overlay: Math.min(0.9, Math.max(0, Number(b.overlay) || 0)),
          blur: Math.min(24, Math.max(0, Number(b.blur) || 0)),
        };
      }
      if (incoming.power) s.power = { ...s.power, ...incoming.power };
      if (nextSearch) s.search = nextSearch.value;
      if (incoming.news) {
        /* aihot 是嵌套配置，必须逐层合并 —— 浅合并会让"前端只改了一个开关"
           这个动作把其余字段整体抹平（只发 { enabled } 时 mode / minScore 会没）。
           顺便把值收进合法区间：这些数会直接进抓取器，pages 给大了就是去撞限流。 */
        const a = incoming.news.aihot || {};
        const aihot = { ...s.news.aihot };
        if (a.enabled !== undefined) aihot.enabled = Boolean(a.enabled);
        if (a.mode !== undefined) aihot.mode = a.mode === 'all' ? 'all' : 'selected';
        if (a.minScore !== undefined) aihot.minScore = Math.min(100, Math.max(0, Math.round(Number(a.minScore) || 0)));
        if (a.maxItems !== undefined) aihot.maxItems = Math.min(300, Math.max(20, Math.round(Number(a.maxItems) || 200)));
        if (a.pages !== undefined) aihot.pages = Math.min(3, Math.max(1, Math.round(Number(a.pages) || 2)));
        s.news = { ...s.news, ...incoming.news, aihot };
      }
      if (nextBackup) s.backup = nextBackup;
      if (incoming.autoBackup !== undefined) s.autoBackup = Boolean(incoming.autoBackup);
      if (incoming.refreshSeconds !== undefined) s.refreshSeconds = Math.max(5, Number(incoming.refreshSeconds) || 60);
      if (incoming.pve) {
        const next = { ...s.pve, ...incoming.pve };
        if (incoming.pve.tokenSecret === MASK || incoming.pve.tokenSecret === undefined) {
          next.tokenSecret = s.pve.tokenSecret;
        }
        s.pve = next;
      }
      if (incoming.ha) {
        // 只接受真正的配置字段：
        //   token / hasToken —— 前者只来自环境变量，后者是服务端推导的派生态，都不该落库；
        //   sockets 先规范化，顺手清掉空行、给缺 ID / 名称的补默认值。
        const { token: _token, hasToken: _hasToken, sockets, ...rest } = incoming.ha;
        s.ha = { ...s.ha, ...rest };
        if (sockets !== undefined) {
          s.ha.sockets = normalizeSockets({ sockets });
          // 页面上改成列表管理之后，旧的扁平字段必须退场，
          // 否则把列表删空时它会把那个旧插座又"复活"出来。
          delete s.ha.powerEntity;
          delete s.ha.counterEntity;
        }
      }
      s.updatedAt = new Date().toISOString();
    });
    /* 计划改了要**立刻**生效：定时任务的注册搬到了 services/backup.js，
       这里直接按新设置重新注册一遍，不必重启服务。
       （同样的问题在 news 上还没解：那边的 cron 只在启动时读一次） */
    if (nextBackup) applyBackupSchedule();
    ok(res, maskSettings(db().settings));
  }),
);

/* ── 背景图 ───────────────────────────────────────────────────────── */

/** 提供上传的背景图本体。前端会在地址后带 ?v=<mtime> 做缓存失效。 */
router.get(
  '/background',
  wrap(async (_req, res) => {
    const bg = backgroundStatus();
    if (!bg) return fail(res, 404, '还没有上传背景图');
    // 文件名固定是 bg.<ext>，内容一变 mtime 就变，所以可以让浏览器长期缓存
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(bg.path);
  }),
);

router.post(
  '/background',
  wrap(async (req, res) => {
    const saved = await saveBackground(req.body?.data);
    ok(res, { hasUpload: true, uploadedAt: saved.mtime, size: saved.size, ext: saved.ext });
  }),
);

router.delete(
  '/background',
  wrap(async (_req, res) => {
    await clearBackground();
    // 顺手把配置退回 none：否则会留下"指向一张已经不存在的图"的悬空状态，
    // 页面看起来是坏的，但配置里看不出问题
    update((d) => {
      if (d.settings.background?.kind === 'upload') d.settings.background.kind = 'none';
      d.settings.updatedAt = new Date().toISOString();
    });
    await flush();
    ok(res, { hasUpload: false });
  }),
);

/**
 * 知识库自动备份（腾讯云 COS）。
 *
 * 手动跑一次和定时跑的是同一条路（services/backup.js 的 runBackup），
 * 于是"手动成功、定时失败"这种只在某一侧冒出来的差异不会出现。
 *
 * 失败原因原样带出去：缺凭证、桶名写错、签名没通过，这三件的处置完全不同，
 * 糊成一句"备份失败"就没法排查了。
 */
router.post(
  '/backup/cos/run',
  wrap(async (_req, res) => {
    try {
      ok(res, await runBackup({ trigger: 'manual' }));
    } catch (err) {
      fail(res, 502, err.message);
    }
  }),
);

/** 连通性自检。会往桶里写一个几十字节的探针对象 —— 备份要的就是写权限 */
router.post(
  '/backup/cos/test',
  wrap(async (_req, res) => {
    try {
      ok(res, await testConnection());
    } catch (err) {
      fail(res, 502, err.message);
    }
  }),
);

/**
 * 云上有哪些备份。给设置页的「从云备份恢复」用。
 *
 * 清单来源可能是列桶，也可能是按日期探测（密钥没给 ListBucket 权限时）——
 * 两者都是正常情况，所以把 mode 一起返回，让页面说清"这份清单是怎么来的"。
 */
router.get(
  '/backup/cos/list',
  wrap(async (_req, res) => {
    try {
      ok(res, await listBackups());
    } catch (err) {
      fail(res, 502, err.message);
    }
  }),
);

/**
 * 从云上的一份备份恢复整库。**会覆盖当前全部数据**，所以：
 * · 服务端先自动留一份恢复前的存档（尽力而为，见 restoreFromCos）；
 * · 页面上还要再确认一次。
 *
 * 恢复回来的是整份数据，连 settings 都换了，所以之后要按**恢复后的**设置
 * 重新注册定时任务 —— 否则备份计划会停在打开页面那一刻的那份。
 */
router.post(
  '/backup/cos/restore',
  wrap(async (req, res) => {
    try {
      const result = await restoreFromCos(req.body?.key);
      applyBackupSchedule();
      ok(res, result);
    } catch (err) {
      fail(res, 502, err.message);
    }
  }),
);

router.get('/backup', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="workbench-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(exportAll(), null, 2));
});

router.post(
  '/backup/restore',
  wrap(async (req, res) => {
    const payload = req.body?.data || req.body;
    if (!payload || typeof payload !== 'object' || !payload.todos) {
      return fail(res, 400, '备份文件格式不正确');
    }
    await replaceAll(payload);
    ok(res, { restored: true });
  }),
);

router.post(
  '/backup/reset',
  wrap(async (_req, res) => {
    await resetToSeed();
    ok(res, { reset: true });
  }),
);

router.post(
  '/backup/save',
  wrap(async (_req, res) => {
    await persist();
    ok(res, { savedAt: new Date().toISOString(), tables: await dbStats() });
  }),
);

/* ── Proxmox 监控 ─────────────────────────────────────────────────── */
router.get(
  '/pve/nodes',
  wrap(async (_req, res) => {
    ok(res, { nodes: await listNodes(db().settings), configured: isConfigured(db().settings) });
  }),
);

/* ── overview 的远程读数缓存 ────────────────────────────────────────────
 * 一次真实采集要串起 PVE 的节点列表、状态、传感器、硬盘、网卡，再加一次 HA
 * 读数 —— 实测 0.8s 量级。页面每刷新一次就重跑一遍很不划算：轮询周期是 60 秒，
 * 这中间的任何刷新拿到的其实是同一份数据。
 *
 * 所以这里缓存 50 秒（前端轮询周期是 60 秒），且**只覆盖远程读数**：
 * 电量累计（accumulate / recordMeter）仍按每次请求真实执行，否则累计电量会漏。
 * 缓存要略小于轮询周期 —— 太短则刷新时缓存总是凉的，太长则轮询永远命中、数据不更新。
 * ──────────────────────────────────────────────────────────────────── */
const OVERVIEW_CACHE_MS = 50_000;
/* 必须是 let：缓存对象是整体替换的。声明成 const 会在赋值那一行抛
   "Assignment to constant variable"，而且只在真正走到赋值时才炸，很难发现。 */
let overviewCache = { key: '', at: 0, value: null, refreshing: false };

/**
 * 过期后用 stale-while-revalidate：先把上一份读数交出去，再在后台补采一次。
 * 没有这一步的话，"缓存刚过期"和"缓存从未有过"对用户是一样的 —— 都得等满 0.8s，
 * 刷新页面就会时不时卡一下。宁可给一份 15 秒前的数，也别让页面转圈。
 */
async function remoteReadings(settings, node, timeframe) {
  const key = `${node || ''}|${timeframe}`;
  const now = Date.now();

  if (overviewCache.value && overviewCache.key === key) {
    if (now - overviewCache.at >= OVERVIEW_CACHE_MS && !overviewCache.refreshing) {
      overviewCache.refreshing = true;
      // 关键：补采要晚一步再起。实测如果立即发起，采集那 0.8s 的 I/O 与
      // JSON 解析会把正在等的这次响应一起拖慢（425ms）。推后 100ms 就够 ——
      // 命中缓存的响应本身只要几毫秒，补采启动时它早发完了。
      setTimeout(() => {
        Promise.all([getOverview(settings, { node, timeframe }), haReadings(settings)])
          .then(([overview, ha]) => {
            overviewCache = { key, at: Date.now(), value: { overview, ha }, refreshing: false };
          })
          .catch(() => {
            // 补采失败就留着旧值等下次，不能把错误冒泡给正在等响应的那个请求
            overviewCache.refreshing = false;
          });
      }, 100);
    }
    return overviewCache.value;
  }

  const [overview, ha] = await Promise.all([getOverview(settings, { node, timeframe }), haReadings(settings)]);
  overviewCache = { key, at: now, value: { overview, ha }, refreshing: null };
  return overviewCache.value;
}

/* ── 容量增长趋势的缓存 ──────────────────────────────────────────────
 * getGrowth 内部会再拉一次 timeframe:'week' 的概览 —— 又是一整轮 PVE 采集，
 * 而且序列比 hour 更长，实测 400ms。这才是"缓存命中了却还是慢"的那一半：
 * 上面的 overviewCache 只盖住 hour 那一次，week 这次每次都真跑。
 *
 * 增长趋势本身就是按天变化的东西，10 分钟缓存绰绰有余。
 * 失败也缓存（存 null），免得 PVE 短暂不可用时每次请求都去撞一遍超时。
 * ──────────────────────────────────────────────────────────────────── */
const GROWTH_CACHE_MS = 600_000;
let growthCache = { key: '', at: 0, value: null };

async function cachedGrowth(settings, node, usedRatio) {
  const key = node || '';
  const now = Date.now();
  if (growthCache.value !== undefined && growthCache.key === key && now - growthCache.at < GROWTH_CACHE_MS) {
    return growthCache.value;
  }
  const value = await getGrowth(settings, node, usedRatio).catch(() => null);
  growthCache = { key, at: now, value };
  return value;
}

router.get(
  '/pve/overview',
  wrap(async (req, res) => {
    const data = db();
    const timeframe = ['hour', 'day', 'week', 'month', 'year'].includes(String(req.query.timeframe))
      ? String(req.query.timeframe)
      : 'hour';
    const node = req.query.node ? String(req.query.node) : undefined;

    // 整机功耗来源优先级：米家插座实测(HA) > PVE 硬件传感器 > CPU 利用率模型估算。
    // HA 拿不到读数时不报错，静默回退到原来的估算链路，监控页不受影响。
    //
    // 远程读数（PVE + HA，带 15 秒缓存）与 SSH 调频档位并行，不串行叠加延迟。
    // readGovernor 自己还有 5 分钟缓存，失败返回 null，不会拖慢这个接口。
    const [{ overview, ha }, cpuGovernor] = await Promise.all([
      remoteReadings(data.settings, node, timeframe),
      readGovernor(pveConfig(data.settings).host),
    ]);
    const wattsInfo = ha.ok
      ? { watts: ha.watts, cpuWatts: null, baseWatts: null, source: 'ha' }
      : estimateWatts({ ...overview.status, disks: overview.disks }, overview.sensors, data.settings);

    // 电量累计是一次真实写入，返回前落库，避免"界面涨了、库里没涨"
    // 带上 CPU 负载：实测统计要按负载档分桶，否则"平均功率"里混的是当期在忙什么
    accumulate(wattsInfo.watts, data.settings, { eco: data.settings.power.eco, load: overview.status?.cpu });
    // 插座累计读数的每日快照：今日/近一月用电都由它推导
    recordMeter(ha.counterKwh);
    /* 电量落库不挡在响应前面。实测同步 await 要为它付 400ms（写 energy_* 表），
       而它跟这次要返回的数据毫无关系 —— 缓存命中时整条链路只要 20ms，
       剩下 400ms 全是等这次写库。
       电量是采样数据，不是交易流水：update() 本来也排了 120ms 后的自动落库，
       不 await 只是晚一点写入，不会丢。 */
    void flush().catch(() => {});
    const power = powerReport({
      status: overview.status,
      sensors: overview.sensors,
      settings: data.settings,
      wattsInfo,
      energy: db().energy,
      ha,
    });

    // 容量增长趋势单独基于 1 周序列计算，避免短窗口噪声影响判断
    const growth = await cachedGrowth(
      data.settings,
      overview.node,
      overview.status?.rootfs?.total ? overview.status.rootfs.used / overview.status.rootfs.total : undefined,
    );

    ok(res, {
      ...overview,
      power,
      growth,
      // governor = 母机实测档位（读不到为 null）；expected = 当前模式应有的档位。
      // 两个都给出去，界面才能分辨"没读到"和"读到了但不对"——前者是 SSH 不通，
      // 后者是下发失败，排查方向完全不同。
      cpu: {
        governor: cpuGovernor,
        expected: data.settings.power.eco ? GOVERNORS.eco : GOVERNORS.standard,
      },
    });
  }),
);

router.post(
  '/pve/eco',
  wrap(async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    update((d) => {
      d.settings.power.eco = enabled;
      d.settings.updatedAt = new Date().toISOString();
    });
    const link = await applyEco(enabled, db().settings);
    ok(res, { enabled, link });
  }),
);

router.post(
  '/pve/config/test',
  wrap(async (req, res) => {
    const cfg = pveConfig({ pve: { ...db().settings.pve, ...(req.body || {}) } });
    if (!cfg.host || !cfg.tokenId || !cfg.tokenSecret) return fail(res, 400, '请先填写地址、Token ID 与密钥');
    const nodes = await listNodes({ pve: { ...db().settings.pve, ...(req.body || {}) } });
    ok(res, { nodes, count: nodes.length });
  }),
);

/* ── Home Assistant：米家智能插座实测功耗与用电 ───────────────────── */

/** 实体候选：设置页用它做下拉选择，省得手填实体 ID */
router.get(
  '/ha/options',
  wrap(async (_req, res) => {
    ok(res, await listEntityOptions(db().settings));
  }),
);
router.post(
  '/ha/test',
  wrap(async (req, res) => {
    const body = req.body || {};
    // 令牌由环境变量提供，请求体里带什么都不作数；其余字段允许就地覆盖，方便"只改个地址再测一次"
    const { token: _ignored, ...rest } = body;
    const merged = { ha: { ...(db().settings.ha || {}), ...rest } };
    const cfg = haConfig(merged);
    if (!cfg.token) return fail(res, 400, '服务端没有配置环境变量 HA_TOKEN，请在 .env 里补上并重启服务');
    if (!cfg.url) return fail(res, 400, '请先填写 Home Assistant 地址');

    const readings = await haReadings(merged);
    if (!readings.ok) return fail(res, 502, readings.error || '读取 Home Assistant 失败');
    ok(res, {
      ...readings,
      config: {
        url: cfg.url,
        powerEntity: cfg.powerEntity,
        counterEntity: cfg.counterEntity,
        monthEnergyEntity: cfg.monthEnergyEntity,
        todayEnergyEntity: cfg.todayEnergyEntity,
      },
    });
  }),
);

/** 手动触发一次用电采样，用来验证"读功率 → 积分 → 落库"这条链路 */
router.post(
  '/ha/sample',
  wrap(async (_req, res) => {
    const result = await sampleOnce();
    if (!result.ok) return fail(res, 502, result.error || '采样失败');
    ok(res, { ...result, sampler: samplerStatus() });
  }),
);

/* ── Hermes Agent Office（局域网智能工位网关）──────────────────────── */

/**
 * 工位/员工在线状态。走 Hermes 的公开接口，不需要凭证；
 * 连不上就 502，由前端决定是显示兜底文案还是整块隐藏。
 */
router.get(
  '/hermes/seats',
  wrap(async (_req, res) => {
    ok(res, await hermesSeats());
  }),
);

/** 测试连接：分「公开接口」与「登录凭证」两层报结果 */
router.post(
  '/hermes/test',
  wrap(async (_req, res) => {
    const result = await testHermes();
    if (!result.public.ok) return fail(res, 502, result.public.error, { baseUrl: result.baseUrl });
    if (result.auth.attempted && !result.auth.ok) {
      return fail(res, 401, result.auth.error, { baseUrl: result.baseUrl, public: result.public });
    }
    ok(res, result);
  }),
);

/* ── AI 助手 ──────────────────────────────────────────────────────── */
/* ── AI 助手对话历史 ──────────────────────────────────────────────── */
/* 这张表逐行读写、不挂内存镜像，原因见 server/db/messages.js */

/** 最近 limit 条，按时间正序返回（旧 → 新，正是气泡的排列顺序） */
router.get(
  '/assistant/messages',
  wrap(async (req, res) => {
    ok(res, { messages: await listMessages(req.query.limit) });
  }),
);

/** 追加一条：前端在提问后、回答完成后各调一次 */
router.post(
  '/assistant/messages',
  wrap(async (req, res) => {
    const { role, content, engine, warning } = req.body || {};
    if (!content || !String(content).trim()) return fail(res, 400, '消息内容不能为空');
    ok(res, await addMessage({ role, content, engine, warning }));
  }),
);

/** 清空历史 */
router.delete(
  '/assistant/messages',
  wrap(async (_req, res) => {
    ok(res, { removed: await clearMessages() });
  }),
);

router.post(
  '/assistant',
  wrap(async (req, res) => {
    const message = req.body?.message;
    if (!message) return fail(res, 400, '消息不能为空');
    ok(res, await ask(message));
  }),
);

/**
 * 流式问答（SSE）。与 /assistant 同一套语义，只是把内容边生成边推给浏览器：
 * 复杂问题要 60 秒以上，非流式只能干等，还容易撞上反代的读超时。
 */
router.post(
  '/assistant/stream',
  wrap(async (req, res) => {
    const message = req.body?.message;
    if (!message) return fail(res, 400, '消息不能为空');

    const sse = openSse(res);
    try {
      await askStream(message, sse.send);
    } catch (err) {
      // 响应头已经发出去了，改不了状态码，只能作为一次 done 事件收尾
      sse.send({ type: 'done', reply: `助手出错了：${err.message}`, actions: [], engine: 'rule', warning: '请求失败' });
    } finally {
      sse.close();
    }
  }),
);
