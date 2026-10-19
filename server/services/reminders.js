import { db } from '../store.js';
import { markReminder } from '../db/reminders.js';
import { feishuConfigured, notifyFeishu } from './feishu.js';
import { isEmail, mailConfigured, sendMail } from './mail.js';

/* ────────────────────────────────────────────────────────────────────────
 * 任务到期提醒
 * ────────────────────────────────────────────────────────────────────────
 * 每天 09:00 扫一遍未完成、且设了截止日期的任务，按"离到期还有多久"发提醒：
 *
 *   T-1  due_soon    明天到期
 *   T0   due_today   今天到期
 *   T+1 / T+3 / T+7  overdue  已逾期 N 天（只提醒这三天，之后不再追）
 *
 * 渠道：飞书发一条汇总（所有到期任务），邮件只发给留下邮箱的外链提交者。
 * 是否发送由设置页的开关控制，但任务本身的发送记录始终写库 ——
 * 关掉再打开时不会把当天已经发过的补一遍。
 *
 * 去重靠 ticket_reminders 的唯一键，所以这个函数是幂等的：同一天跑几次都行。
 * ──────────────────────────────────────────────────────────────────────── */

const OVERDUE_DAYS = [1, 3, 7];
const MAX_MAILS = 20;

const KIND_LABEL = {
  due_soon: '明天到期',
  due_today: '今天到期',
};

/** 本地日期键 YYYY-MM-DD（不用 toISOString：那会把时区挪到 UTC） */
function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把任务的 due 归一成"本地日历日"。
 * 面板里可能是 2026-10-30（date 输入框），也可能是 2026-10-30T18:00:00.000Z（种子 / 旧数据）。
 * 这两种都要落到人心里那一天，而不是 UTC 那一天。
 */
function dueDayKey(due) {
  const raw = String(due || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : localDayKey(d);
}

function diffDays(fromKey, toKey) {
  const parse = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  return Math.round((parse(fromKey) - parse(toKey)) / 86400000);
}

function overdueLabel(days) {
  return `已逾期 ${days} 天`;
}

function labelOf(kind, daysOverdue) {
  return kind === 'overdue' ? overdueLabel(daysOverdue) : KIND_LABEL[kind];
}

/** 一条任务的提醒该不该发、发哪种 */
function kindFor(due, todayKey) {
  const delta = diffDays(due, todayKey); // 正数 = 未来
  if (delta === 1) return { kind: 'due_soon', overdueDays: 0 };
  if (delta === 0) return { kind: 'due_today', overdueDays: 0 };
  if (delta < 0 && OVERDUE_DAYS.includes(-delta)) return { kind: 'overdue', overdueDays: -delta };
  return null;
}

function activeTickets() {
  return (db().tickets || []).filter((t) => t && !t.deletedAt && !t.archivedAt && t.status !== 'done');
}

function emailBody(ticket, label) {
  return [
    `你提交的任务${label === '今天到期' ? '今天到期' : label === '明天到期' ? '明天到期' : label}：${ticket.title}`,
    ticket.project ? `项目：${ticket.project}${ticket.section ? ` / ${ticket.section}` : ''}` : '',
    ticket.due ? `截止日期：${dueDayKey(ticket.due)}` : '',
    '',
    '任务处理完成后，你会收到一封「已完成」的通知。',
    '这封邮件由个人工作台自动发出，直接回复不会有人看到。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 执行一次检查。
 * force = true 时忽略设置里的总开关（给"立即检查"按钮用），
 * 但仍然遵守当天的去重。
 */
export async function runDueReminders({ now = new Date(), force = false } = {}) {
  const settings = db().settings || {};
  const enabled = settings.reminders?.enabled !== false;
  if (!enabled && !force) return { skipped: true, tickets: 0, mails: 0, feishu: false };

  const todayKey = localDayKey(now);
  const due = [];

  for (const ticket of activeTickets()) {
    const key = dueDayKey(ticket.due);
    if (!key) continue;
    const hit = kindFor(key, todayKey);
    if (!hit) continue;
    /* 先占位再发：多进程 / 手动补跑同时进来时，只有抢到唯一键的那个才继续 */
    const fresh = await markReminder(ticket.id, hit.kind, todayKey, now);
    if (!fresh) continue;
    due.push({ ticket, kind: hit.kind, overdueDays: hit.overdueDays, label: labelOf(hit.kind, hit.overdueDays) });
  }

  if (!due.length) return { skipped: false, tickets: 0, mails: 0, feishu: false };

  /* 飞书：一条汇总，而不是一条任务一条消息 —— 群里刷屏比不提醒更烦 */
  let feishu = false;
  if (feishuConfigured()) {
    const lines = due
      .slice(0, 12)
      .map((d) => `${d.label}｜${d.ticket.id} ${d.ticket.title}${d.ticket.project ? `（${d.ticket.project}）` : ''}`);
    if (due.length > lines.length) lines.push(`…另有 ${due.length - lines.length} 条`);
    const text = [`【任务到期提醒】${due.length} 条未完成`, ...lines, `检查时间 ${now.toLocaleString('zh-CN')}`].join('\n');
    try {
      await notifyFeishu(text);
      feishu = true;
    } catch (err) {
      console.warn('[reminders] 飞书提醒发送失败：', err.message);
    }
  }

  /* 邮件：只有留了邮箱的外链任务才有收件人；一次最多 20 封，避免 SMTP 被刷 */
  let mails = 0;
  if (mailConfigured()) {
    for (const item of due) {
      if (mails >= MAX_MAILS) break;
      const to = String(item.ticket.contact || '').trim();
      if (!isEmail(to)) continue;
      try {
        await sendMail({
          to,
          subject: `【${item.label}】${item.ticket.title}`.slice(0, 120),
          text: emailBody(item.ticket, item.label),
        });
        mails += 1;
      } catch (err) {
        console.warn(`[reminders] 邮件提醒失败 ${item.ticket.id} → ${to}：`, err.message);
      }
    }
  }

  console.log(`[reminders] ${todayKey} 检查完成：${due.length} 条任务，飞书 ${feishu ? '已发' : '未发'}，邮件 ${mails} 封`);
  return { skipped: false, tickets: due.length, mails, feishu };
}
