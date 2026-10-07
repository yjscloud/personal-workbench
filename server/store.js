import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultData } from './seed.js';
import { newsItemId } from './services/news-id.js';
import { normalizeKnowledge } from './services/knowledge.js';
import { DB, DB_LABEL } from './db/config.js';
import { assertConnection, closePool } from './db/connection.js';
import { ensureSchema } from './db/schema.js';
import {
  loadAll,
  isEmpty,
  resetSignatures,
  primeSignatures,
  tableStats,
  sync as syncToDb,
} from './db/repository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 旧版 JSON 数据目录：仅用于首次迁移，迁完就不再写入 */
export const DATA_DIR = path.join(__dirname, 'data');
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');

/**
 * 数据层说明
 * ────────────────────────────────────────────────────────────────
 * MySQL 是唯一的持久化载体：进程内保留一份内存镜像供读取与同步修改，
 * 任何写操作都会在同一个事务里落库；写接口在返回前会等待落库完成。
 * 这样既保留了原有「同步读写」的调用体验，又不会出现"内存里有、库里没有"。
 */

let cache = null;

/* ── 初始化 ────────────────────────────────────────────────────────── */

/**
 * 历史数据的热点 ID 可能是重复的（老版本 ID 生成方式会截断到来源前缀），
 * 导入时按「来源 + 链接」重新派生一次，保证能落库、界面也不再出现重复 key。
 * 对已经是新格式的 ID 来说这一步是幂等的。
 */
function rekeyNewsItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({ ...item, id: newsItemId(item) }));
}

function normalize(input) {
  const seed = defaultData();
  const newsInput = input?.news || {};
  const data = { ...seed, ...(input || {}) };
  const stored = input?.settings || {};
  // 导入旧备份时同样丢掉落库的令牌（令牌只认环境变量 HA_TOKEN）
  const ha = { ...seed.settings.ha, ...(stored.ha || {}) };
  delete ha.token;
  // 老配置用的是扁平字段（powerEntity）。这时必须让位，否则 seed 里的示例插座
  // 会盖过去——万一两者实体不同，就会静默用错设备。
  if (!stored.ha?.sockets && (stored.ha?.powerEntity || stored.ha?.counterEntity)) ha.sockets = [];
  // 逐层合并，否则旧备份里缺字段的 ha / pve / power 会把新默认值整个盖掉
  data.settings = {
    ...seed.settings,
    ...stored,
    profile: { ...seed.settings.profile, ...(stored.profile || {}) },
    // engines 是数组，整份取库里的；缺字段（老备份没有 search）时上面的 ...seed 已经兜住
    search: { ...seed.settings.search, ...(stored.search || {}) },
    background: { ...seed.settings.background, ...(stored.background || {}) },
    theme: { ...seed.settings.theme, ...(stored.theme || {}) },
    pve: { ...seed.settings.pve, ...(stored.pve || {}) },
    power: { ...seed.settings.power, ...(stored.power || {}) },
    ha,
    news: { ...seed.settings.news, ...(stored.news || {}), aihot: { ...seed.settings.news.aihot, ...(stored.news?.aihot || {}) } },
    /* backup.cos 是嵌套对象：浅合并会让"库里存着旧凭证"把新默认字段整体盖掉，
       凭证本身也会在只改频率时被抹平 */
    backup: {
      ...seed.settings.backup,
      ...(stored.backup || {}),
      cos: { ...seed.settings.backup.cos, ...(stored.backup?.cos || {}) },
    },
  };
  data.news = { ...seed.news, ...newsInput, items: rekeyNewsItems(newsInput.items ?? seed.news.items) };
  data.energy = { ...seed.energy, ...(input?.energy || {}) };
  /* 知识库正文：导入的旧备份里还是 steps 数组，在这里统一搬成 Markdown。
     放在 normalize 里是因为「旧 db.json 导入」和「备份恢复」两条路都经过它 ——
     恢复完不一定重启，不在这儿转就永远漏一条。 */
  normalizeKnowledge(data);
  return data;
}

function readLegacyFile() {
  if (!fs.existsSync(LEGACY_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    return typeof parsed === 'object' && parsed ? normalize(parsed) : null;
  } catch (err) {
    console.warn(`[db] 旧数据文件解析失败，已忽略：${err.message}`);
    return null;
  }
}

/**
 * 连接数据库 → 建表 → 首次运行写入种子（或迁移旧 db.json）→ 载入内存镜像。
 * 必须在 app.listen 之前完成。
 */
export async function initStore() {
  await assertConnection();
  await ensureSchema();

  let result;
  if (await isEmpty()) {
    const legacy = readLegacyFile();
    cache = legacy ?? defaultData();
    resetSignatures();
    await syncToDb(cache);
    result = { seeded: true, source: legacy ? 'legacy-json' : 'seed' };
  } else {
    cache = await loadAll(defaultData());
    resetSignatures();
    primeSignatures(cache);
    result = { seeded: false, source: 'mysql' };
  }

  /* RSS 时代那串 feeds 配置已经没有任何代码读它了（2026-10 换成 AIHOT 单源，
     见 services/news.js）。旧库和旧备份里还留着这份数组，在这里统一丢掉 ——
     留着只会让后来的人以为"这些源还在生效"，死配置比死代码更容易误导。
     放在两个分支之后，是为了让"库里已有数据"和"从旧文件导入"两条路都过一遍。 */
  if (cache?.settings?.news) delete cache.settings.news.feeds;

  /* ── steps → body 的一次性搬迁（知识库支持 Markdown 时引入）──────────
     老库里正文是 steps 数组，现在正文走 Markdown。转换是幂等的：body 已有
     内容就一字不动，只补 body_plain。放在两个分支之后，于是「库里已有数据」
     「从旧文件导入」「首次写种子」三条路都过一遍。

     确实有改动才回写一次 —— 平时启动不产生任何写库动作。
     syncToDb 提交成功后会自己更新指纹，所以这里不必再 primeSignatures。 */
  if (normalizeKnowledge(cache)) {
    await syncToDb(cache);
    console.log('[db] 知识库正文已从 steps 迁移为 Markdown 并落库');
  }

  return result;
}

export async function closeStore() {
  if (cache) await syncToDb(cache).catch(() => {});
  await closePool();
}

/* ── 读取 ──────────────────────────────────────────────────────────── */

export function db() {
  if (!cache) throw new Error('数据层尚未初始化，请先 await initStore()');
  return cache;
}

export function isReady() {
  return cache !== null;
}

export function dbInfo() {
  return {
    driver: 'mysql',
    host: DB.host,
    port: DB.port,
    user: DB.user,
    database: DB.database,
    label: DB_LABEL,
    legacyFile: fs.existsSync(LEGACY_FILE) ? LEGACY_FILE : null,
  };
}

export async function dbStats() {
  return tableStats();
}

/* ── 写入 ──────────────────────────────────────────────────────────── */

const FLUSH_DELAY_MS = 120;

let timer = null;
let tail = Promise.resolve();

/**
 * 立即把内存镜像同步到 MySQL，并等待提交完成。
 * 多次并发调用会自动串行化，只有数据真正变化的表会写。
 */
export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const run = tail.then(
    () => syncToDb(cache),
    () => syncToDb(cache),
  );
  // tail 吞掉异常，保证后续 flush 不被前一次失败卡住
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 合并写入：改内存 → 排队落库（写接口会再 await flush() 确保提交） */
export function update(mutator) {
  const data = db();
  mutator(data);
  schedule();
  return data;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush().catch((err) => console.error('[db] 后台落库失败：', err.message));
  }, FLUSH_DELAY_MS);
  // 后台定时落库不应该拖住进程退出
  if (typeof timer.unref === 'function') timer.unref();
}

/** 兼容旧调用名：语义等同 flush() */
export function persist() {
  return flush();
}

export async function replaceAll(next) {
  cache = normalize(next);
  resetSignatures();
  await flush();
  return cache;
}

/**
 * 只替换指定的几份数据，其余一律不动。用于知识库备份的恢复（见
 * services/backup.js 的 restoreFromCos）—— 那份快照里只有知识库与工具箱。
 *
 * 靠的是 repository 的**按表签名**：sync 只写签名变了的表（见 db/repository.js
 * 的 buildPlan）。所以这里把这几张表的数组换掉再 flush，其它表连一条 SQL 都
 * 不会发出去 —— 不必为此绕一套"部分导入"的机制。
 *
 * 千万别用 replaceAll 顶替：那是"整份覆盖"，会把任务、设置、AI 热点一起清掉。
 */
export async function replaceScoped(next = {}) {
  const data = db();
  if (Array.isArray(next.knowledge)) data.knowledge = next.knowledge;
  if (Array.isArray(next.groups)) data.groups = next.groups;
  if (Array.isArray(next.bookmarks)) data.bookmarks = next.bookmarks;
  /* 正文的派生列（body_plain 等）要走同一次转换 —— 早期备份里的正文还是
     steps 数组，不转的话恢复回来既搜不到也读不出 */
  normalizeKnowledge(data);
  await flush();
  return cache;
}

export async function resetToSeed() {
  cache = defaultData();
  // 种子数据的知识库正文也走同一次转换，否则「重置为示例数据」会退回到 steps 时代
  normalizeKnowledge(cache);
  resetSignatures();
  await flush();
  return cache;
}

export function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    app: 'personal-workbench',
    version: 1,
    storage: dbInfo(),
    data: db(),
  };
}

let counter = 0;
export function uid(prefix = 'id') {
  counter = (counter + 1) % 10000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random()
    .toString(36)
    .slice(2, 5)}`;
}
