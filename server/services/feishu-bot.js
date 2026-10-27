import { bridgeCall } from './hermes-local.js';
import { notifyFeishu, notifyFeishuCard, feishuConfigured } from './feishu.js';
import { db } from '../store.js';
import { enrichCardIps, enrichIps } from './geo.js';

/* ────────────────────────────────────────────────────────────────────────
 * 飞书机器人（自定义机器人 webhook）：全站唯一的一份配置
 * ────────────────────────────────────────────────────────────────────────
 * 发通知的地方有三处：
 *   1. 面板自己 —— GitHub star、外链任务通知（services/feishu.js）；
 *   2. 助手机上的脚本 —— 自动封禁、值守报告（~/.hermes/scripts/*.py）；
 *   3. Hermes cron 投递 —— feishu_bot 插件，读 ~/.hermes/.env。
 *
 * 以前各读各的：面板读 settings.stars，脚本读 .env。换一个群就得 ssh 上去改
 * 文件，还得记得哪几处都改了。现在设置页是唯一真源 —— 保存时把这份配置推给
 * 助手机（~/.hermes/state/feishu_bot.json，0600），脚本读那一份；.env 只作
 * 兜底（全新部署、还没在面板里配过的时候）。
 *
 * 这里刻意不做"推送失败就回滚保存"：本地这份是有效的，面板自己的通知照发；
 * 失败的只是"助手机还拿着旧地址"这件事。把原因带回去显示，比让人重填一遍好。
 * ──────────────────────────────────────────────────────────────────────── */

export function feishuBotDefaults() {
  return {
    /** 总开关。关掉 = 一条通知都不发，但配置留着 */
    enabled: true,
    /** 自定义机器人：一条 URL 就能发，但收不到按钮回调 */
    webhookUrl: '',
    secret: '',
    /** 应用机器人：能收回调（审批卡的按钮只有它能接） */
    appId: '',
    appSecret: '',
    /** 群会话 id（oc_ 开头）。应用机器人发消息必须指定 */
    chatId: '',
    /**
     * 所有者白名单（open_id，ou_ 开头）。应用机器人的"收"这一半只认这里的人：
     * 不在名单里的消息不进助手、卡片按钮也点不动。
     * 留空时走首次认领 —— 第一个给机器人发消息的人被记进来（见 feishu-app.js），
     * 单用户部署下这是唯一不会把人挡在门外的做法；想换人或加人就直接改这个数组。
     */
    allowOpenIds: [],
    /** 通知范围：自动封禁 / 值守报告。分开是因为前者希望你秒知道，后者可以少吵 */
    notifyBan: true,
    notifyOps: true,
    /** 派生态：上次推送到助手机的结果。页面靠它说清"脚本那边到底用没用上" */
    syncedAt: null,
    syncError: null,
  };
}

/** 读当前配置并补齐默认值。设置里没有这一段时就是"没配过" */
export function feishuBotConfig(settings) {
  return { ...feishuBotDefaults(), ...(settings?.feishuBot || {}) };
}

/**
 * 库里没填、但环境变量里有地址：通知其实一直在发。
 * 页面必须说清这件事，否则会显示「未配置」，人以为停了，实际还在往群里发。
 */
export function hasEnvWebhook() {
  return Boolean(String(process.env.FEISHU_WEBHOOK_URL || process.env.FEISHU_BOT_WEBHOOK_URL || '').trim());
}

/**
 * 一次性搬家：老配置把 webhook 放在「GitHub Star 监控」里。
 * 新的一栏还空着就照抄过来 —— 否则用户得把同一串地址再抄一遍，
 * 而两处不一致时又很难说清哪个生效。只在启动时跑，抄过一次就不再有动作。
 */
export function migrateFeishuBotFromStars(settings) {
  const bot = settings?.feishuBot;
  const stars = settings?.stars || {};
  if (!bot || String(bot.webhookUrl || '').trim()) return false;
  const url = String(stars.feishuUrl || '').trim();
  if (!url) return false;
  settings.feishuBot = {
    ...feishuBotDefaults(),
    ...bot,
    webhookUrl: url,
    secret: String(stars.feishuSecret || ''),
  };
  return true;
}

/**
 * 把配置推给助手机。返回 { syncedAt, syncError }，不抛 —— 调用方决定怎么显示。
 */
export async function syncFeishuBot(cfg) {
  try {
    const data = await bridgeCall('/local/feishu-config', {
      method: 'POST',
      timeout: 15000,
      body: {
        enabled: cfg.enabled !== false,
        webhookUrl: String(cfg.webhookUrl || '').trim(),
        secret: String(cfg.secret || ''),
        appId: String(cfg.appId || '').trim(),
        appSecret: String(cfg.appSecret || ''),
        chatId: String(cfg.chatId || '').trim(),
        notifyBan: cfg.notifyBan !== false,
        notifyOps: cfg.notifyOps !== false,
      },
    });
    return { syncedAt: data?.savedAt || new Date().toISOString(), syncError: null };
  } catch (err) {
    return { syncedAt: null, syncError: String(err?.message || err).slice(0, 300) };
  }
}

const API = 'https://open.feishu.cn/open-apis';

/** 两条通道各自配全了没有。页面据此决定按钮能不能点 */
export function feishuBotChannels(cfg) {
  return {
    hasWebhook: Boolean(String(cfg.webhookUrl || '').trim()),
    hasApp: Boolean(
      String(cfg.appId || '').trim() && String(cfg.appSecret || '') && String(cfg.chatId || '').trim(),
    ),
  };
}

/**
 * 应用机器人的 tenant_access_token。飞书那句话原样抛出去 ——
 * "app_secret invalid" 比 "发送失败" 有用得多。
 *
 * 缓存：这枚 token 飞书给 2 小时有效期。通知是"发一条换一枚"的话，
 * 每条都去换一次等于凭空多出同样数量的鉴权往返（飞书对鉴权接口也有频率限制）。
 * 留一分钟余量，过期前重换 —— 换 token 失败时清缓存，下次重试不会被旧值卡住。
 */
let cachedToken = null;

async function tenantToken(cfg) {
  const appId = String(cfg.appId || '').trim();
  const appSecret = String(cfg.appSecret || '');
  if (!appId || !appSecret) throw new Error('还没有填 App ID / App Secret');
  if (cachedToken && cachedToken.appId === appId && cachedToken.expiresAt > Date.now() + 60000) {
    console.log('[feishu-bot] 复用已缓存的 tenant_access_token');
    return cachedToken.token;
  }
  let res;
  try {
    res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    cachedToken = null;
    throw new Error(`取 tenant_access_token 失败：${err?.cause?.code || err?.message || err}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.code !== 0) {
    cachedToken = null;
    throw new Error(`取 tenant_access_token 失败：${json?.msg || `HTTP ${res.status}`}`);
  }
  /* 飞书给 expire（秒），没给就按 2 小时算 */
  const ttl = Number(json.expire) > 0 ? Number(json.expire) : 7200;
  cachedToken = { appId, token: json.tenant_access_token, expiresAt: Date.now() + ttl * 1000 };
  return cachedToken.token;
}

/**
 * 应用机器人的发消息。text 与 interactive 只是 content 的形状不同，
 * 剩下的（取 token、指定群、报错带飞书原文）完全一样，所以收在同一个函数里。
 */
async function sendAppMessage(msgType, content, cfg) {
  const chatId = String(cfg.chatId || '').trim();
  if (!chatId) throw new Error('还没有填群 chat_id（oc_ 开头）');
  const token = await tenantToken(cfg);
  const res = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: msgType,
      content: JSON.stringify(content),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.code !== 0) {
    throw new Error(`应用机器人发送失败：${json?.msg || `HTTP ${res.status}`}`);
  }
  return json?.data?.message_id;
}

/**
 * 应用机器人发一张卡片。
 *
 * 为什么这条也必须留着：审批卡（「批准 / 拒绝」按钮）只有应用机器人收得到回调，
 * 自定义机器人是纯出站的通路。所以两套凭据不是重复配置，是两条不同的用途。
 */
export async function notifyFeishuAppCard(card, cfg) {
  return sendAppMessage('interactive', card, cfg);
}

/** 应用机器人发一条纯文本（到期汇总、star 增量这类一句话通知） */
export async function notifyFeishuAppText(text, cfg) {
  return sendAppMessage('text', { text: String(text) }, cfg);
}

/**
 * 面板自己发的通知统一走这里：**应用机器人优先，webhook 回落**。
 *
 * 为什么是"优先"而不是"二选一"：应用机器人那条能收（@ 有反应、卡片按钮有回调），
 * 走它才能把"发"和"收"接在同一套凭据上；没配全时也不能因此不发通知，
 * 所以回落到 webhook（自定义机器人），再由 feishuConfig() 负责老配置与环境变量兜底。
 *
 * 总开关关掉 = 一条都不发，这里直接静默返回，不去回落 —— 与 feishuConfig() 的口径一致。
 */
export async function notifyPanelText(text) {
  const cfg = feishuBotConfig(db()?.settings);
  if (cfg.enabled === false) return null;
  const body = await enrichIps(text);
  if (feishuBotChannels(cfg).hasApp) return notifyFeishuAppText(body, cfg);
  return notifyFeishu(body);
}

/**
 * 统一的"通知卡片"格式。
 *
 * 之前各发各的：cron 投过来的是裸文本 + 框架自带的
 * "Cronjob Response: xxx (job_id: …)\n----------" 包装，面板这边是
 * "【任务到期提醒】…" 这种文本前缀，群里看起来像三种东西来自三个地方。
 * 现在所有通知类消息都走这一个模板：
 *
 *   ┌ 标题（header，模板色表示轻重）
 *   │ 正文（lark_md）
 *   │ ───────────────
 *   │ 来源 · 时间（note）
 *
 * 对话回复（@ 机器人提问）不走这个 —— 那是聊天，用纯文本更自然。
 */
export const NOTICE_TONE = {
  info: 'blue',
  success: 'green',
  warning: 'orange',
  error: 'red',
  neutral: 'grey',
};

/** 造一张统一格式的通知卡。tone 见 NOTICE_TONE */
export function buildNoticeCard({ title, body, tone = 'info', source = '个人工作台', time } = {}) {
  const stamp = time || new Date().toLocaleString('zh-CN');
  return {
    config: { wide_screen_mode: true },
    header: {
      template: NOTICE_TONE[tone] || 'blue',
      title: { tag: 'plain_text', content: String(title || '通知').slice(0, 80) },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: String(body || '').slice(0, 3000) } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `${source} · ${stamp}` }] },
    ],
  };
}

/** 发一张统一格式的通知卡（应用机器人优先、webhook 回落） */
export async function notifyPanelNotice({ title, body, tone = 'info', source = '个人工作台' }) {
  const cfg = feishuBotConfig(db()?.settings);
  if (cfg.enabled === false) return null;
  /* 正文里出现 IP 就补上地区：判断"这是哪来的"比看一串数字有用得多 */
  const card = await enrichCardIps(buildNoticeCard({ title, body, tone, source }));
  if (feishuBotChannels(cfg).hasApp) return notifyFeishuAppCard(card, cfg);
  return notifyFeishuCard(card);
}

/** 同上，发的是交互卡片（外链提交那张） */
export async function notifyPanelCard(card) {
  const cfg = feishuBotConfig(db()?.settings);
  if (cfg.enabled === false) return null;
  /* 卡片正文里出现 IP 也补地区（外链提交那张会带提交的 IP） */
  const rich = await enrichCardIps(card);
  if (feishuBotChannels(cfg).hasApp) return notifyFeishuAppCard(rich, cfg);
  return notifyFeishuCard(rich);
}

/**
 * 面板通知能不能发。
 * 只看 webhook 是不够的：只配了应用机器人的人，webhook 是空的，
 * 但通知照样发得出去（走应用机器人那条）。
 */
export function panelNotifyReady() {
  const cfg = feishuBotConfig(db()?.settings);
  if (cfg.enabled === false) return false;
  return feishuBotChannels(cfg).hasApp || feishuConfigured();
}

/**
 * 测试卡：用**已保存**的配置发一张，回答"这条路通不通"。
 * 卡片里写明走的是哪条通道 —— 两条通道可能指向同一个群，不标出来会分不清。
 */
export async function testFeishuBot(cfg, channel) {
  const { hasWebhook, hasApp } = feishuBotChannels(cfg);
  /* 库里空着但 .env 有地址时，实际发的就是那个地址 —— 测试也得走同一条路，
     否则会出现"平时收得到、测试说没配" */
  const envFallback = !hasWebhook && hasEnvWebhook();
  const pick = channel || (hasWebhook ? 'webhook' : hasApp ? 'app' : envFallback ? 'webhook' : '');
  if (!pick) throw new Error('还没有可用的通道：填 webhook，或者填 App ID / App Secret / chat_id');
  if (pick === 'webhook' && !hasWebhook && !envFallback) throw new Error('还没有配置 webhook 地址');
  if (pick === 'app' && !hasApp) throw new Error('应用机器人没配全：App ID、App Secret、群 chat_id 三个都要填');

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '工作台 · 飞书机器人已接通' },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**通道**\n${pick === 'app' ? '应用机器人' : '自定义机器人'}`,
            },
          },
          { is_short: true, text: { tag: 'lark_md', content: `**通知范围**\n${scopeText(cfg)}` } },
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '这条是测试消息，由「系统设置 · 飞书机器人」发出。' }],
      },
    ],
  };

  if (pick === 'app') await notifyFeishuAppCard(card, cfg);
  else if (envFallback) await notifyFeishuCard(card);
  else await notifyFeishuCard(card, { url: cfg.webhookUrl, secret: String(cfg.secret || '') });
  return pick;
}

function scopeText(cfg) {
  const parts = [];
  if (cfg.notifyBan !== false) parts.push('自动封禁');
  if (cfg.notifyOps !== false) parts.push('值守报告');
  return parts.length ? parts.join(' · ') : '全部关闭';
}
