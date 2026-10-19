import nodemailer from 'nodemailer';
import { db } from '../store.js';

/* ────────────────────────────────────────────────────────────────────────
 * 邮件通知（SMTP）
 * ────────────────────────────────────────────────────────────────────────
 * 目前只有一个用途：外链提交的任务被标记为「已完成」时，给提交者发一封信。
 *
 * 配置放在 settings.mail（设置页可改），.env 里的 SMTP_* 只当兜底 ——
 * 和 GitHub star 的 webhook 是同一套优先级：界面里填了就用界面的，
 * 没填才回头看环境变量，老部署不至于必须改一遍设置。
 *
 * 发信是**尽力而为**：失败只记日志，绝不能让标记完成这个动作跟着失败。
 * ──────────────────────────────────────────────────────────────────────── */

const DEFAULT_PORT = 465;

function config() {
  const s = db().settings?.mail || {};
  const env = process.env;

  const host = String(s.host || env.SMTP_HOST || '').trim();
  const rawPort = Number(s.port || env.SMTP_PORT || DEFAULT_PORT);
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT;
  const user = String(s.user || env.SMTP_USER || '').trim();
  const pass = String(s.pass || env.SMTP_PASS || '');
  const from = String(s.from || env.SMTP_FROM || user || '').trim();
  /* 没显式设 secure 时按端口猜：465 是隐式 TLS，587 是 STARTTLS */
  const secure = typeof s.secure === 'boolean' ? s.secure : port === 465;
  /* 平台所有者的收件地址：外部工单提交时发到这里。
     留空就发给发件地址自己 —— 单用户部署里这两个通常就是同一个邮箱。 */
  const notifyTo = String(s.notifyTo || env.SMTP_NOTIFY_TO || '').trim() || from;

  return { host, port, secure, user, pass, from, notifyTo };
}

/** 外部工单提交时，给平台所有者发信用的地址 */
export const ownerAddress = () => config().notifyTo;

export const mailConfigured = () => {
  const c = config();
  return Boolean(c.host && c.from);
};

/** 够用的邮箱判断：外链的 contact 允许写微信 / 手机号，只有像邮箱的才发信 */
export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());

/** 连接池没必要：一天可能就几封信，缓存一个 transport 是为了不重复握手 */
let cached = { key: '', transport: null };

function transport() {
  const c = config();
  const key = JSON.stringify(c);
  if (cached.transport && cached.key === key) return cached.transport;

  cached = {
    key,
    transport: nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    }),
  };
  return cached.transport;
}

export async function sendMail({ to, subject, text }) {
  const c = config();
  if (!c.host || !c.from) throw new Error('还没有配置发件邮箱（设置 → 邮件通知）');
  if (!isEmail(to)) throw new Error('收件地址不是一个邮箱');

  const info = await transport().sendMail({ from: c.from, to, subject, text });
  return info.messageId || '';
}

/** 设置页那个「发一封测试邮件」 */
export async function sendTestMail(to) {
  await sendMail({
    to,
    subject: '【个人工作台】邮件通知已连通',
    text: [
      '这是一封测试邮件。',
      '外链提交的任务被标记为「已完成」时，会给提交者发一封这样的通知。',
      '',
      `发送时间：${new Date().toLocaleString('zh-CN')}`,
    ].join('\n'),
  });
}

/**
 * 任务完成通知。只对「外链提交 + 联系方式是邮箱」的任务发，
 * 且由调用方保证这是 todo/doing → done 的那一次状态变化。
 */
export async function notifyTicketDone(ticket) {
  try {
    if (!ticket || ticket.status !== 'done' || ticket.source !== 'external') return false;
    const to = String(ticket.contact || '').trim();
    if (!isEmail(to) || !mailConfigured()) return false;

    const id = await sendMail({
      to,
      subject: `【任务已完成】${ticket.title}`.slice(0, 120),
      text: [
        `你提交的任务已经完成：${ticket.title}`,
        ticket.project ? `项目：${ticket.project}${ticket.section ? ` / ${ticket.section}` : ''}` : '',
        `完成时间：${new Date().toLocaleString('zh-CN')}`,
        '',
        '这封邮件由个人工作台自动发出，直接回复不会有人看到。',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    /* 成功也留一行：出问题时要能分清"没发"和"发了但对方没收到" */
    console.log(`[mail] 完成通知已发送 ${ticket.id} → ${to}（${id}）`);
    return true;
  } catch (err) {
    console.warn('[mail] 完成通知发送失败：', err.message);
    return false;
  }
}
