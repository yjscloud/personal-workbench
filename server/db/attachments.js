import { pool } from './connection.js';

/* ────────────────────────────────────────────────────────────────────────
 * 任务附件
 * ────────────────────────────────────────────────────────────────────────
 * 文件本体以 data URL 存进 MEDIUMTEXT，而不是落磁盘：
 *   · 项目里没有 multipart 依赖，前端 FileReader 出 data URL 直接走 JSON 就够；
 *   · 也就不用处理磁盘文件的命名、清理、以及备份时的一致性。
 * 代价是单个附件要小、数量要少，所以这里卡了上限（超了直接报错，不静默截断）。
 *
 * 与评论同理，它走独立表逐行读写，不进 store.js 的内存镜像。
 * ──────────────────────────────────────────────────────────────────────── */

/** 每条任务的附件数量上限 */
const MAX_FILES = 10;
/** 内联图片（粘贴进备注 / 评论的）单独计数，不挤占附件名额 */
const MAX_INLINE = 20;
/** 单个附件上限 1.5MB：base64 后约 2MB 字符，MEDIUMTEXT 与 4MB 的请求体都装得下 */
const MAX_BYTES = 1.5 * 1024 * 1024;

let counter = 0;
function uid() {
  counter = (counter + 1) % 10000;
  return `att_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
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
    name: row.name,
    mime: row.mime,
    size: Number(row.size) || 0,
    content: row.content,
    /** 内联图片：粘贴进备注 / 评论的图，只在正文里用，不列进附件区 */
    inline: Boolean(row.inline),
    createdAt: toIso(row.created_at),
  };
}

/** 某个任务的附件（含内容，前端靠 data URL 直接预览图片 / 下载） */
export async function listAttachments(ticketId) {
  const [rows] = await pool.query(
    'SELECT `id`, `ticket_id`, `name`, `mime`, `size`, `content`, `inline`, `created_at` FROM `ticket_attachments` WHERE `ticket_id` = ? ORDER BY `seq` ASC',
    [String(ticketId)],
  );
  return rows.map(fromRow);
}

/** 追加一个附件，超限直接抛错。inline=true 表示这是粘贴进正文的图片 */
export async function addAttachment(ticketId, { name, mime, size, content, inline = false }) {
  const isInline = Boolean(inline);
  const dataUrl = String(content ?? '');
  if (!/^data:[^;]+;base64,/.test(dataUrl)) throw new Error('附件内容格式不对，应该是 data URL');

  // base64 的体积可以反推：每 4 个字符还原 3 字节
  const bytes = Math.round((dataUrl.length * 3) / 4);
  if (bytes > MAX_BYTES) throw new Error(`单个附件不能超过 ${(MAX_BYTES / 1024 / 1024).toFixed(1)}MB`);

  // 内联图片与真正的附件分开计数：贴几张图不该把附件名额挤掉
  const limit = isInline ? MAX_INLINE : MAX_FILES;
  const [existing] = await pool.query(
    'SELECT COUNT(*) AS `n` FROM `ticket_attachments` WHERE `ticket_id` = ? AND `inline` = ?',
    [String(ticketId), isInline ? 1 : 0],
  );
  if (Number(existing?.[0]?.n || 0) >= limit) {
    throw new Error(isInline ? `每条任务最多 ${limit} 张内联图片` : `每条任务最多 ${limit} 个附件`);
  }

  const row = {
    id: uid(),
    ticketId: String(ticketId),
    name: String(name || '未命名').slice(0, 200),
    mime: String(mime || '').slice(0, 120),
    size: Number(size) > 0 ? Math.trunc(Number(size)) : bytes,
    content: dataUrl,
    inline: isInline,
    createdAt: new Date(),
  };

  await pool.query(
    'INSERT INTO `ticket_attachments` (`id`, `ticket_id`, `name`, `mime`, `size`, `content`, `inline`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.ticketId, row.name, row.mime, row.size, row.content, row.inline ? 1 : 0, row.createdAt],
  );
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** 删一个附件，返回是否真的删掉了 */
export async function removeAttachment(id) {
  const [result] = await pool.query('DELETE FROM `ticket_attachments` WHERE `id` = ?', [String(id)]);
  return Boolean(result.affectedRows);
}

/** 任务被彻底删除时清掉它的附件，免得留下孤儿行 */
export async function clearTicketAttachments(ticketId) {
  const [result] = await pool.query('DELETE FROM `ticket_attachments` WHERE `ticket_id` = ?', [String(ticketId)]);
  return result.affectedRows || 0;
}

/** 供健康检查的「表行数」用 */
export async function countAttachments() {
  const [rows] = await pool.query('SELECT COUNT(*) AS `n` FROM `ticket_attachments`');
  return Number(rows?.[0]?.n || 0);
}
