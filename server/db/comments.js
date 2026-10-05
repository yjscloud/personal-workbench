import { pool } from './connection.js';

/* ────────────────────────────────────────────────────────────────────────
 * 任务评论 / 动态流
 * ────────────────────────────────────────────────────────────────────────
 * 和 db/messages.js 同一套路：只追加、持续增长的数据不走 store.js 的内存镜像
 * （镜像是整表 DELETE + 全量 INSERT + 整表指纹判重，每加一条评论都会重写全表），
 * 这里直接复用连接池逐行读写。
 *
 * 代价：它不在镜像里，所以「备份导出」不包含评论。
 * ──────────────────────────────────────────────────────────────────────── */

/** 单条评论的长度上限，防止一次贴进超长内容 */
const MAX_CONTENT = 4000;

let counter = 0;
/** 与 store.js 的 uid 同款：前缀 + 时间戳 36 进制 + 递增计数 + 随机尾巴 */
function uid() {
  counter = (counter + 1) % 10000;
  return `cmt_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function fromRow(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    content: row.content,
    createdAt: toIso(row.created_at),
  };
}

/** 某个任务的评论，按时间正序（旧 → 新，正好是动态流的阅读顺序） */
export async function listComments(ticketId, { limit = 200 } = {}) {
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || 200, 1), 500);
  const [rows] = await pool.query(
    'SELECT `id`, `ticket_id`, `content`, `created_at` FROM `ticket_comments` WHERE `ticket_id` = ? ORDER BY `seq` ASC LIMIT ?',
    [String(ticketId), size],
  );
  return rows.map(fromRow);
}

/** 追加一条评论，返回落库后的记录 */
export async function addComment(ticketId, content) {
  const body = String(content ?? '').slice(0, MAX_CONTENT);
  if (!body.trim()) throw new Error('评论内容不能为空');

  const comment = {
    id: uid(),
    ticketId: String(ticketId),
    content: body,
    createdAt: new Date(),
  };

  await pool.query(
    'INSERT INTO `ticket_comments` (`id`, `ticket_id`, `content`, `created_at`) VALUES (?, ?, ?, ?)',
    [comment.id, comment.ticketId, comment.content, comment.createdAt],
  );
  return { ...comment, createdAt: comment.createdAt.toISOString() };
}

/** 删一条评论，返回是否真的删掉了 */
export async function removeComment(id) {
  const [result] = await pool.query('DELETE FROM `ticket_comments` WHERE `id` = ?', [String(id)]);
  return Boolean(result.affectedRows);
}

/** 任务被彻底删除时清掉它的评论，避免留下孤儿行 */
export async function clearTicketComments(ticketId) {
  const [result] = await pool.query('DELETE FROM `ticket_comments` WHERE `ticket_id` = ?', [String(ticketId)]);
  return result.affectedRows || 0;
}

/** 供健康检查的「表行数」用：这张表不在内存镜像里，得单独数 */
export async function countComments() {
  const [rows] = await pool.query('SELECT COUNT(*) AS `n` FROM `ticket_comments`');
  return Number(rows?.[0]?.n || 0);
}
