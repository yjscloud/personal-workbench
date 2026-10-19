import { pool } from './connection.js';

/**
 * 记一条提醒。
 *
 * 用 INSERT IGNORE + 唯一键 (ticket_id, kind, sent_on) 做去重：
 * 返回 true 表示"今天这一条还没发过，可以发"，false 表示发过了。
 * 这样服务重启、手动补跑、同一天跑两次都不会重复轰炸。
 */
export async function markReminder(ticketId, kind, dayKey, now = new Date()) {
  const [res] = await pool.query(
    'INSERT IGNORE INTO `ticket_reminders` (`ticket_id`, `kind`, `sent_on`, `created_at`) VALUES (?, ?, ?, ?)',
    [String(ticketId), String(kind), dayKey, now],
  );
  return Number(res.affectedRows) > 0;
}

/** 给设置页用的最近发送记录（可选，暂时没接 UI） */
export async function recentReminders(limit = 20) {
  const [rows] = await pool.query(
    'SELECT `ticket_id`, `kind`, `sent_on` FROM `ticket_reminders` ORDER BY `seq` DESC LIMIT ?',
    [Math.min(100, Math.max(1, Number(limit) || 20))],
  );
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    kind: r.kind,
    sentOn: r.sent_on instanceof Date ? r.sent_on.toISOString().slice(0, 10) : String(r.sent_on).slice(0, 10),
  }));
}
