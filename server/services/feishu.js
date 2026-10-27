import { createHmac } from 'node:crypto';
import { db } from '../store.js';

/* ────────────────────────────────────────────────────────────────────────
 * 飞书自定义机器人
 * ────────────────────────────────────────────────────────────────────────
 * 两处都在用：GitHub star 卡片（涨了发一条）和外部任务提交（来一条发一条）。
 * 配置沿用一个来源 —— 设置页「GitHub Star 监控」里填的 webhook 就是全站
 * 默认的飞书出口，.env 的 FEISHU_WEBHOOK_URL 只作兜底。
 * 这样不必为了"提交任务也通知"再让人配一遍同一个地址。
 * ──────────────────────────────────────────────────────────────────────── */

const TIMEOUT_MS = 15000;

/**
 * 当前生效的 webhook。
 *
 * 优先级：设置页「飞书机器人」→ 老的「GitHub Star 监控」里的地址 → .env。
 * 中间那档留着是为了不把已经配好的人卡住 —— 那段配置还在，只是收敛到新的
 * 那一栏之后就没必要再填第二遍。总开关关掉时**不**回落到后面两档：
 * "关掉"就该是真的不发，而不是悄悄换成另一个地址继续发。
 */
export function feishuConfig() {
  const s = db()?.settings || {};
  const bot = s.feishuBot;
  if (bot) {
    /* 总开关是"真的停"：关掉时连回落也不走，否则"关了还在发"没人能解释 */
    if (bot.enabled === false) return { url: '', secret: '' };
    const url = String(bot.webhookUrl || '').trim();
    if (url) return { url, secret: String(bot.secret || '').trim() };
  }
  const stars = s.stars || {};
  return {
    url: String(stars.feishuUrl || '').trim() || String(process.env.FEISHU_WEBHOOK_URL || '').trim(),
    secret: String(stars.feishuSecret || '').trim() || String(process.env.FEISHU_WEBHOOK_SECRET || '').trim(),
  };
}

/** 卡片上要说明"没配 webhook 所以只记数"，而不是让人以为通知发过了 */
export const feishuConfigured = () => Boolean(feishuConfig().url);

/**
 * 往飞书自定义机器人发一条文本。
 *
 * 两种机器人形态都支持：只给 URL（无签名校验），或 URL + secret。
 * 如果机器人开了「签名校验」而这里没带 timestamp/sign，飞书会回 19021，
 * 那句话对用户毫无信息量 —— 所以宁可多十行把签名算上。
 */
/** 真正发出去的那一步：签名 + 请求 + 错误信息统一在这里 */
async function postToFeishu(body, cfg) {
  if (!cfg?.url) throw new Error('还没有配置飞书 webhook 地址');

  if (cfg.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    /* 飞书的算法：key = `${timestamp}\n${secret}`，内容为空，HMAC-SHA256 后 base64 */
    body.timestamp = timestamp;
    body.sign = createHmac('sha256', `${timestamp}\n${cfg.secret}`).update('').digest('base64');
  }

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    throw new Error(`连不上飞书 webhook：${err?.cause?.code || err?.message || err}`);
  });

  const json = await res.json().catch(() => null);
  const code = json?.code ?? json?.StatusCode;
  if (!res.ok || (code != null && code !== 0)) {
    throw new Error(`飞书返回 HTTP ${res.status}${code != null ? ` code=${code}` : ''}${json?.msg ? `（${json.msg}）` : ''}`);
  }
}

/** 纯文本。用在不需要结构的地方（star 涨了这种一句话消息） */
export function notifyFeishu(text, cfg = feishuConfig()) {
  return postToFeishu({ msg_type: 'text', content: { text } }, cfg);
}

/**
 * 交互卡片。
 *
 * 卡片是自定义机器人的另一种消息类型（msg_type=interactive），
 * 签名规则和文本完全一致 —— 不一样的是内容结构，所以这里只多一层壳。
 * 卡片 schema 写错时飞书会回 400 / code，不会静默变成一条丑文本，
 * 调用方可以据此降级成纯文本。
 */
export function notifyFeishuCard(card, cfg = feishuConfig()) {
  return postToFeishu({ msg_type: 'interactive', card }, cfg);
}
