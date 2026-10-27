import { randomBytes } from 'node:crypto';
import { pool } from './connection.js';

/* ────────────────────────────────────────────────────────────────────────
 * 外部提交链接（监控/任务页之外的那张"公开投递口"）
 * ────────────────────────────────────────────────────────────────────────
 * 独立表逐行读写，不放进 store.js 的内存镜像：
 *   1. 它不在首屏数据里，没必要每次 /bootstrap 都整包带出去；
 *   2. token 是凭据，能少发一次就少发一次；
 *   3. 提交计数要"原子自增"，走内存镜像再整表重写反而更容易丢。
 * 表结构见 db/schema.sql 的 public_links。
 * ──────────────────────────────────────────────────────────────────────── */

const COLS =
  '`id`, `token`, `project`, `section`, `label`, `enabled`, `notify`, `max_uses`, `uses`, ' +
  '`day_key`, `day_count`, `expires_at`, `last_used_at`, `created_at`, `updated_at`';

/** 单条链接每天最多收多少条。防的是"链接被转到公开群之后被刷" */
export const DAY_CAP = 200;

/** 单条链接每天允许的附件总字节：20MB ≈ 4 次"带满附件"的提交。
    只按条数限的话，200 条 × 3 个 × 1.5MB ≈ 900MB/天，磁盘是被这样吃掉的 */
export const DAY_BYTES_CAP = 20 * 1024 * 1024;

const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

function fromRow(row) {
  return {
    id: row.id,
    token: row.token,
    project: row.project,
    section: row.section ?? '',
    label: row.label ?? '',
    enabled: Boolean(row.enabled),
    notify: Boolean(row.notify),
    maxUses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
    uses: Number(row.uses) || 0,
    dayKey: row.day_key ?? '',
    dayCount: Number(row.day_count) || 0,
    expiresAt: toIso(row.expires_at),
    lastUsedAt: toIso(row.last_used_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** 32 字节随机 → 43 字符 base64url。可猜性靠它，不靠"别把链接发出去" */
export const newToken = () => randomBytes(32).toString('base64url');

export const newLinkId = () => `pl_${randomBytes(9).toString('base64url')}`;

/** 令牌格式先过一遍再查库：省得每个扫描器都变成一条 SQL */
export const looksLikeToken = (token) => /^[A-Za-z0-9_-]{43}$/.test(String(token || ''));

export async function listLinks() {
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`public_links\` ORDER BY \`created_at\` DESC`);
  return rows.map(fromRow);
}

export async function getLink(id) {
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`public_links\` WHERE \`id\` = ? LIMIT 1`, [String(id)]);
  return rows.length ? fromRow(rows[0]) : null;
}

export async function getLinkByToken(token) {
  if (!looksLikeToken(token)) return null;
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`public_links\` WHERE \`token\` = ? LIMIT 1`, [String(token)]);
  return rows.length ? fromRow(rows[0]) : null;
}

export async function addLink({ project, section = '', label = '', notify = true, maxUses = null, expiresAt = null }) {
  const now = new Date();
  const row = {
    id: newLinkId(),
    token: newToken(),
    project: String(project || '').slice(0, 80),
    section: String(section || '').slice(0, 120),
    label: String(label || '').slice(0, 80),
    enabled: 1,
    notify: notify ? 1 : 0,
    max_uses: Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Math.floor(Number(maxUses)) : null,
    uses: 0,
    day_key: '',
    day_count: 0,
    expires_at: toDate(expiresAt),
    last_used_at: null,
    created_at: now,
    updated_at: now,
  };
  await pool.query(
    'INSERT INTO `public_links` (`id`, `token`, `project`, `section`, `label`, `enabled`, `notify`, `max_uses`, `uses`, `day_key`, `day_count`, `expires_at`, `last_used_at`, `created_at`, `updated_at`) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, NULL, ?, ?)',
    [
      row.id,
      row.token,
      row.project,
      row.section,
      row.label,
      row.enabled,
      row.notify,
      row.max_uses,
      '',
      row.expires_at,
      row.created_at,
      row.updated_at,
    ],
  );
  return getLink(row.id);
}

export async function patchLink(id, patch) {
  const sets = [];
  const args = [];
  const put = (sql, value) => {
    sets.push(sql);
    args.push(value);
  };
  if (patch.project !== undefined) put('`project` = ?', String(patch.project).slice(0, 80));
  if (patch.section !== undefined) put('`section` = ?', String(patch.section).slice(0, 120));
  if (patch.label !== undefined) put('`label` = ?', String(patch.label).slice(0, 80));
  if (patch.enabled !== undefined) put('`enabled` = ?', patch.enabled ? 1 : 0);
  if (patch.notify !== undefined) put('`notify` = ?', patch.notify ? 1 : 0);
  if (patch.maxUses !== undefined) {
    const n = Number(patch.maxUses);
    put('`max_uses` = ?', Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
  }
  if (patch.expiresAt !== undefined) put('`expires_at` = ?', toDate(patch.expiresAt));
  if (!sets.length) return getLink(id);

  put('`updated_at` = ?', new Date());
  args.push(String(id));
  await pool.query(`UPDATE \`public_links\` SET ${sets.join(', ')} WHERE \`id\` = ?`, args);
  return getLink(id);
}

/** 换一条新 token：旧链接立刻作废，适合"链接被转出去了"的场合 */
export async function rotateLink(id) {
  await pool.query('UPDATE `public_links` SET `token` = ?, `updated_at` = ? WHERE `id` = ?', [
    newToken(),
    new Date(),
    String(id),
  ]);
  return getLink(id);
}

export async function removeLink(id) {
  const [res] = await pool.query('DELETE FROM `public_links` WHERE `id` = ?', [String(id)]);
  return Number(res.affectedRows) || 0;
}

/**
 * 记一次提交。**先占额度再建任务**：并发下"先查再写"会同时挤进来。
 * 条件写进 WHERE，命中不了就说明当天额度或总量已经用完。
 * 返回 false 表示没占到额度（调用方按 429 处理），不是数据库出错。
 *
 * bytes 是这次提交的附件总字节。条数与字节在**同一条 UPDATE** 里判定：
 * 分成"先查当日字节、够了再写"两步的话，两个并发请求会各自读到旧值，
 * 于是都能通过 —— 那正是当初写 day_count 时想避免的问题。
 */
export async function consumeQuota(id, dayKey, bytes = 0, now = new Date()) {
  /* 时间戳用 JS 的 Date 传进来，不用 SQL 的 NOW()：这张表的时间列在别处
     都是 JS Date 写入的，混用 NOW() 会跟着连接的时区解释走，读回来能差 8 小时
     （界面上就会显示成「最近 8 小时后」）。

     SET 的求值顺序是 left→right（MySQL 的行为），所以凡是要读"旧 day_key"
     的赋值都必须排在 `day_key = ?` 之前；WHERE 用的则始终是更新前的行。 */
  const size = Math.max(0, Math.floor(Number(bytes) || 0));
  const [res] = await pool.query(
    'UPDATE `public_links` SET ' +
      '`uses` = `uses` + 1, ' +
      '`day_count` = IF(`day_key` = ?, `day_count` + 1, 1), ' +
      '`day_bytes` = IF(`day_key` = ?, `day_bytes` + ?, ?), ' +
      '`day_key` = ?, ' +
      '`last_used_at` = ?, ' +
      '`updated_at` = ? ' +
      'WHERE `id` = ? ' +
      'AND (`max_uses` IS NULL OR `uses` < `max_uses`) ' +
      'AND (`day_key` <> ? OR `day_count` < ?) ' +
      'AND (`day_key` <> ? OR `day_bytes` + ? <= ?)',
    [dayKey, dayKey, size, size, dayKey, now, now, String(id), dayKey, DAY_CAP, dayKey, size, DAY_BYTES_CAP],
  );
  return Number(res.affectedRows) > 0;
}
