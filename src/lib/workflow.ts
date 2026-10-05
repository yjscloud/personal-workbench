import type { TicketStatus } from './api';

/**
 * 任务状态的流转规则。
 *
 *   待处理 → 进行中 → 待验证 → 已完成
 *
 * 刻意保持简单：能一步步往前走，也能退回上一步。
 * 想跳步（比如从待处理直接到已完成）不禁止，但要先确认 ——
 * 跳步通常意味着"任务很小"或"状态没跟上"，值得多问一句；
 * 而误点一下就把任务标成完成，是这套流程里最想避免的事。
 */
export const STATUS_FLOW: TicketStatus[] = ['todo', 'doing', 'review', 'done'];

/**
 * 「推进到某个状态」这个动作叫什么 —— 按钮上直接用这个词，
 * 所以键是**目标状态**而不是当前状态。todo 是流程起点，没有推进到它的动作，留空。
 */
export const ADVANCE_LABEL: Record<TicketStatus, string> = {
  todo: '',
  doing: '开始处理',
  review: '提交验证',
  done: '确认完成',
};

/** 「退回到某个状态」这个动作叫什么，同样按**目标状态**命名 */
export const REVERT_LABEL: Record<TicketStatus, string> = {
  todo: '退回待处理',
  doing: '退回进行中',
  review: '退回待验证',
  // 没有「退回到已完成」这种动作：它是流程终点，只能从待验证推进过去
  done: '',
};

const indexOf = (s: TicketStatus) => Math.max(0, STATUS_FLOW.indexOf(s));

/** 下一步的状态；已经是最后一步时返回 null（按钮就不显示） */
export function nextStatus(s: TicketStatus): TicketStatus | null {
  const i = indexOf(s);
  return i < STATUS_FLOW.length - 1 ? STATUS_FLOW[i + 1] : null;
}

/** 上一步的状态；已经在第一步时返回 null */
export function prevStatus(s: TicketStatus): TicketStatus | null {
  const i = indexOf(s);
  return i > 0 ? STATUS_FLOW[i - 1] : null;
}

/** 相邻 = 正常流转；不相邻 = 跳步，需要确认 */
export function isAdjacent(from: TicketStatus, to: TicketStatus): boolean {
  return Math.abs(indexOf(from) - indexOf(to)) <= 1;
}
