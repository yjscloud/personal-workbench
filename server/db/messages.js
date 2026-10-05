import { pool } from './connection.js';

/* ────────────────────────────────────────────────────────────────────────
 * AI 助手对话历史
 * ────────────────────────────────────────────────────────────────────────
 * 这是全项目唯一不经过 store.js 内存镜像的表，原因见 schema.sql 里的说明：
 * 对话是只追加、持续增长的数据，而镜像的落库方式是「整表 DELETE + 全量 INSERT」
 * 再按整表 JSON 指纹判重 —— 每发一条消息都要重写全部历史，越用越慢，
 * 事务也越滚越大。所以这里直接复用连接池逐行读写。
 *
 * 代价与补偿：
 *   · 它不在镜像里，所以「备份导出」不包含对话历史（导出的是镜像快照）；
 *   · 健康检查里的「表行数」由本模块的 countMessages() 单独补上；
 *   · 超过 KEEP 条的旧记录会被自动裁掉，这张表不会无限膨胀。
 * ──────────────────────────────────────────────────────────────────────── */

/** 保留的历史条数上限：再老的直接删掉 */
const KEEP = 500;
/** 单条正文上限，防止一次塞进超长内容把库撑大 */
const MAX_CONTENT = 20000;

let counter = 0;
/** 与 store.js 的 uid 同款：前缀 + 时间戳 36 进制 + 递增计数 + 随机尾巴 */
function uid() {
  counter = (counter + 1) % 10000;
  return `msg_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return new Date();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function fromRow(row) {
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    engine: row.engine || null,
    warning: row.warning || null,
    createdAt: toIso(row.created_at),
  };
}

/** 读最近 limit 条，按时间正序返回（旧 → 新，正好是气泡的排列顺序） */
export async function listMessages(limit = 100) {
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), KEEP);
  const [rows] = await pool.query(
    'SELECT `id`, `role`, `content`, `engine`, `warning`, `created_at` FROM `assistant_messages` ORDER BY `seq` DESC LIMIT ?',
    [size],
  );
  return rows.reverse().map(fromRow);
}

/**
 * 追加一条。id 由服务端生成，客户端不用关心。
 * 写入后顺带裁剪一次：留老记录没意义，还会让这张表一直长。
 */
export async function addMessage({ role, content, engine = null, warning = null, createdAt = null }) {
  const kind = role === 'user' ? 'user' : 'assistant';
  const body = String(content ?? '').slice(0, MAX_CONTENT);
  if (!body.trim()) throw new Error('消息内容不能为空');

  const message = {
    id: uid(),
    role: kind,
    content: body,
    // engine / warning 只对助手消息有意义，用户消息一律留空
    engine: kind === 'assistant' && engine ? String(engine).slice(0, 16) : null,
    warning: kind === 'assistant' && warning ? String(warning).slice(0, 500) : null,
    createdAt: toDate(createdAt),
  };

  await pool.query(
    'INSERT INTO `assistant_messages` (`id`, `role`, `content`, `engine`, `warning`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)',
    [message.id, message.role, message.content, message.engine, message.warning, message.createdAt],
  );

  // 裁剪到最近 KEEP 条。子查询外面套一层派生表，绕开 MySQL
  // 「不能在 DELETE 的子查询里直接引用同一张表」的限制；
  // 表为空时 MAX(seq) 是 NULL，NULL - KEEP 仍是 NULL，条件不成立，安全。
  await pool.query(
    'DELETE FROM `assistant_messages` WHERE `seq` <= (SELECT * FROM (SELECT MAX(`seq`) - ? AS `cut` FROM `assistant_messages`) AS `t`)',
    [KEEP],
  );

  return { ...message, createdAt: message.createdAt.toISOString() };
}

/** 清空历史，返回删掉的条数 */
export async function clearMessages() {
  const [result] = await pool.query('DELETE FROM `assistant_messages`');
  return result.affectedRows || 0;
}

/** 供健康检查的「表行数」用：这张表不在内存镜像里，得单独数 */
export async function countMessages() {
  const [rows] = await pool.query('SELECT COUNT(*) AS `n` FROM `assistant_messages`');
  return Number(rows?.[0]?.n || 0);
}
