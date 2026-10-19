import { db, update } from '../store.js';

/* ────────────────────────────────────────────────────────────────────────
 * 新建任务
 * ────────────────────────────────────────────────────────────────────────
 * 面板里的 POST /tickets 和公开外链的提交走的是同一段逻辑。
 * 分开写两份的话，迟早会出现"外链建的任务没有 section / 没被截断"这种漂移，
 * 而外链是公网写入口 —— 正是最不该漂的那一侧。
 * ──────────────────────────────────────────────────────────────────────── */

export const TICKET_STATUS = ['todo', 'doing', 'review', 'done'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/** 标签规范化：去空、去重、限长、限条数 */
export function normalizeTags(input) {
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
export function normalizeChecklist(input) {
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
 * 任务号：现有号里最大的数字 + 1（WO-1042 → WO-1043）。
 * 这个号对外可猜，所以公开接口不会把它回给提交者。
 */
function nextTicketId() {
  const maxSeq = db().tickets.reduce((m, t) => {
    const n = Number(String(t.id).replace(/\D/g, ''));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 1000);
  return `WO-${maxSeq + 1}`;
}

/**
 * 建一条任务并放进内存镜像（由 store 排队落库）。
 * @param {object} input 面板 / 外链共用的字段
 * @param {{ source?: string }} opts source 只由服务端决定，不接受请求体里的值
 */
export function createTicket(input = {}, { source = '' } = {}) {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('任务标题不能为空');

  const ticket = {
    id: nextTicketId(),
    title: title.slice(0, 200),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'P2',
    status: TICKET_STATUS.includes(input.status) ? input.status : 'todo',
    project: String(input.project ?? '').slice(0, 80),
    // section 必须一起初始化：缺了这个字段，新建的任务在项目视图里会归不了组
    section: String(input.section ?? '').slice(0, 120),
    owner: String(input.owner ?? '').slice(0, 80),
    due: String(input.due ?? '').slice(0, 40),
    // 与 PATCH 的口径保持一致：备注要装图片引用，1000 字符会被静默截断
    note: String(input.note ?? '').slice(0, 20000),
    /* 联系方式只由外链写入：面板里建任务不需要，留空即"没有"。
       任务完成时的邮件通知按这一列找人，不再从备注正文里解析。 */
    contact: String(input.contact ?? '').slice(0, 160),
    tags: normalizeTags(input.tags) || [],
    checklist: normalizeChecklist(input.checklist) || [],
    source,
    archivedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  };

  update((d) => d.tickets.unshift(ticket));
  return ticket;
}
