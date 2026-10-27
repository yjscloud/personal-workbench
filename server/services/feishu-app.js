import * as Lark from '@larksuiteoapi/node-sdk';
import { feishuBotConfig } from './feishu-bot.js';
import { ask } from './assistant.js';
import { bridgeCall } from './hermes-local.js';
import { enrichIps } from './geo.js';
import { db, update } from '../store.js';

/** 超过这个时间还没出结果，就先回一句"正在查"（飞书要求 3 秒内响应） */
const SLOW_MS = 2500;

/* ────────────────────────────────────────────────────────────────────────
 * 应用机器人的"收"这一半：长连接接收事件
 * ────────────────────────────────────────────────────────────────────────
 * services/feishu-bot.js 负责发（webhook / im/v1/messages），这里负责收。
 * 两件事必须说清楚：
 *
 *   1. 自定义机器人（webhook）**永远收不到东西** —— 那是纯出站通路。
 *      @ 机器人有反应、卡片按钮能点，前提都是配了应用机器人（App ID +
 *      App Secret），并且飞书后台的「事件与回调」选了长连接。
 *
 *   2. 长连接不需要公网地址、不用改反代：SDK 主动向飞书要一条 WebSocket。
 *      代价是这条连接挂在面板进程里，所以配置一改就要重建（见 routes.js
 *      保存设置后的 restartFeishuApp）。
 *
 * 连不上不是致命错误：飞书后台还没开长连接、权限没发布、App Secret 填错，
 * 都会在这里失败。进程照常跑，状态字段把原因带回设置页 —— 让人知道"是没接
 * 上"而不是"机器人坏了"。
 * ──────────────────────────────────────────────────────────────────────── */

/** 当前连接。ws 由 SDK 维护，client 用来回消息 */
let conn = null;
/** 给设置页看的派生态。status 只有 idle/disabled/unconfigured/failed/connected */
let state = { status: 'idle', error: null, since: null, appId: '' };

const log = (...args) => console.log('[feishu-app]', ...args);
const warn = (...args) => console.warn('[feishu-app]', ...args);

/* ── 去重：同一个事件只处理一次 ──────────────────────────────────────────
 * 飞书的推送不是"发一次就完事"：长连接这条路上，SDK 是**先等 handler 返回、
 * 之后才发回执**的（见 node-sdk 的 handleEventData —— invoke 完才 sendMessage）。
 * 超过 3 秒没回执，飞书就认为没送到，把同一个事件重投一遍；我们能等大模型
 * 十几秒，重投就必然发生，表现就是"问一句、答两遍"。
 *
 * 重投带的是同一个 header.event_id，按它去重最准。顺带还挡住两种重复：
 *   · 重建长连接时新旧两条连接短暂并存，两边各收到一次；
 *   · 断线重连后飞书补发之前没回执的事件。
 *
 * 两手都要：回执要快（handleMessage 只做判断、立刻返回），重投要兜住（这里）。
 */
const SEEN_TTL_MS = 30 * 60 * 1000;
const SEEN_LIMIT = 500;
const seenEvents = new Map();

/**
 * 第一次见到这些标识返回 true；任意一个见过就算重投，返回 false。
 *
 * 允许传多个标识是有意的：消息事件既按 event_id 也按 message_id 记一笔 ——
 * 万一飞书重投时换了 event_id，message_id 仍然不变，照样挡得住。
 */
function claimEvent(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean);
  if (!list.length) return true; /* 没 id 就不去重，宁可多答也不要漏答 */
  const now = Date.now();
  /* Map 按插入顺序迭代，时间递增，遇到还新鲜的就说明后面都新鲜 */
  for (const [k, ts] of seenEvents) {
    if (now - ts <= SEEN_TTL_MS) break;
    seenEvents.delete(k);
  }
  if (list.some((k) => seenEvents.has(k))) return false;
  for (const k of list) seenEvents.set(k, now);
  while (seenEvents.size > SEEN_LIMIT) seenEvents.delete(seenEvents.keys().next().value);
  return true;
}

export function feishuAppStatus() {
  /* ws 自己也有状态机，但它在重连途中会给出中间态；这里以"我们这边是否
     成功 start 过"为准，附带的 ws 状态只做补充，不覆盖 error */
  let wsState = null;
  try {
    wsState = conn?.ws?.getConnectionStatus?.()?.state || null;
  } catch {
    wsState = null;
  }
  return {
    status: state.status,
    wsState,
    error: state.error,
    since: state.since,
    appId: state.appId,
  };
}

export function stopFeishuApp() {
  if (conn) {
    try {
      /* force：重连循环会自己续上，温柔 close 在"改配置要立刻换 appId"时
         会拖到超时，旧连接还可能抢在新连接后面触发一次事件 */
      conn.ws.close({ force: true });
    } catch (err) {
      warn('关闭长连接失败：', err?.message || err);
    }
    conn = null;
  }
  if (state.status !== 'unconfigured' && state.status !== 'disabled') {
    state = { status: 'idle', error: null, since: null, appId: '' };
  }
}

/** 配置换了就重建。返回最新状态，调用方可以直接回给页面 */
export function restartFeishuApp(settings) {
  stopFeishuApp();
  return startFeishuApp(settings);
}

export function startFeishuApp(settings) {
  /* 单例：任何一条老连接都先收掉，否则同一个应用会同时挂着两条长连接，
     同一条消息两边各回一次（看起来就是"回两遍"）。restartFeishuApp 里
     已经调过一次，这里再调是幂等的，防的是别处直接 start。 */
  stopFeishuApp();

  const cfg = feishuBotConfig(settings);
  const appId = String(cfg.appId || '').trim();
  const appSecret = String(cfg.appSecret || '');

  if (cfg.enabled === false) {
    state = { status: 'disabled', error: null, since: null, appId };
    return feishuAppStatus();
  }
  if (!appId || !appSecret) {
    state = { status: 'unconfigured', error: null, since: null, appId };
    return feishuAppStatus();
  }

  const client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.warn });
  const ws = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => {
      state = { status: 'connected', error: null, since: new Date().toISOString(), appId };
      log(`长连接已建立（${appId}）`);
      /* 连上不等于事件会来。这里先自检"机器人在不在群、配置的 chat_id 对不对"：
         两者错一个，表现都是"@ 了没反应"，而日志里看不出区别 */
      void selfCheck(client, cfg);
    },
    onError: (err) => {
      /* SDK 重连失败、鉴权失败都走这里。原因保留下来给设置页 */
      state = { ...state, status: 'failed', error: String(err?.message || err).slice(0, 300) };
      warn('长连接异常：', state.error);
    },
    onReconnecting: () => {
      state = { ...state, status: 'reconnecting' };
    },
    onReconnected: () => {
      state = { status: 'connected', error: null, since: new Date().toISOString(), appId };
      log('长连接已恢复');
    },
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => handleMessage(client, data),
    'card.action.trigger': (data) => handleCardAction(client, data),
  });

  conn = { ws, client, appId };
  state = { status: 'connecting', error: null, since: null, appId };

  /* 不 await：start 会一直挂着这条连接的生命周期，await 它等于把调用方
     （启动流程 / 保存接口）也一起挂住。成败由 onReady / onError 回填 */
  ws.start({ eventDispatcher: dispatcher }).catch((err) => {
    state = { status: 'failed', error: String(err?.message || err).slice(0, 300), since: null, appId };
    warn('启动长连接失败：', state.error);
  });

  return feishuAppStatus();
}

/* ── 所有者白名单 ────────────────────────────────────────────────────────
 * 这个机器人是"所有者本人的一个客户端"，不是给群里人用的助手。之前的实现只
 * 过滤了机器人自己的消息，谁发都答 —— 等于给了租户内任何人一个免登录入口，
 * 而消息进去之后能在模型之前触发写动作（改 PVE 调频、在本机执行命令）。
 *
 * 现在只认 settings.feishuBot.allowOpenIds 里的人。名单为空时走"首次认领"：
 * 第一条消息的发送者被记成所有者并落库，同时回一句说明。单用户部署下这是
 * 唯一不把人挡在门外的做法（否则升级完谁也进不来），而且认领只发生一次。
 * ──────────────────────────────────────────────────────────────────── */

/** 当前名单（open_id 数组，已去空） */
function ownerList() {
  const raw = feishuBotConfig(db().settings).allowOpenIds;
  return (Array.isArray(raw) ? raw : []).map((v) => String(v || '').trim()).filter(Boolean);
}

/** 只读判断：这个人是不是所有者。不给任何"顺手认领"的机会（卡片回调要用） */
function isOwner(openId) {
  const id = String(openId || '').trim();
  return Boolean(id) && ownerList().includes(id);
}

/** 消息入口用：名单为空时把当前发送者记成所有者 */
function claimOwner(openId) {
  const id = String(openId || '').trim();
  if (!id) return false;
  if (isOwner(id)) return true;
  if (ownerList().length) return false;
  update((d) => {
    if (!d.settings.feishuBot) d.settings.feishuBot = {};
    const cur = Array.isArray(d.settings.feishuBot.allowOpenIds) ? d.settings.feishuBot.allowOpenIds : [];
    if (!cur.length) d.settings.feishuBot.allowOpenIds = [id];
  });
  log(`首次认领：把 ${id} 记为所有者（可在设置里改 feishuBot.allowOpenIds）`);
  return true;
}

/**
 * 收到消息 → 交给工作台助手回答。
 *
 * 助手那套（server/services/assistant.js）已经会查待办、功耗、PVE、新闻，
 * 并且会在模型不可用时退回本地规则，所以这里不重复造数据口径 ——
 * 群里问出来的答案和页面上助手面板里看到的，是同一套。
 *
 * 时间上要讲究：飞书要求回调 3 秒内响应，走大模型常常要十几秒。
 * 所以先赌"快"：2.5 秒内出结果就直接回；超了就先回一句"正在查"，
 * 再把真正的答案补一条 —— 慢，但不会石沉大海。
 */
function handleMessage(client, data) {
  /* 这个函数**必须立刻返回**：SDK 是拿到 handler 的返回值之后才发回执的，
     而飞书只等 3 秒。把 ask()（十几秒）摆在这里等，等于告诉飞书"没收到"，
     它就把同一个事件重投一遍 —— 用户看到的就是答了两遍。
     所以这里只做"要不要答"的判断，真正的答复丢给 answer() 在后台跑。 */
  let msg;
  let text;
  try {
    msg = data?.message;
    if (!msg) return;
    /* 自己发的消息也会回流。不挡掉就会自己回自己，来回刷 */
    if (data?.sender?.sender_type === 'app' || data?.sender?.sender_type === 'bot') return;

    const mentioned = Array.isArray(msg.mentions) && msg.mentions.length > 0;
    if (msg.chat_type !== 'p2p' && !mentioned) return;

    text = extractText(msg);
    if (!text) return;

    /* 同一条消息的重投在这里挡掉（重启连接时新旧并存也走这条） */
    if (!claimEvent([data?.event_id && `evt:${data.event_id}`, `msg:${msg.message_id}`])) {
      log(`忽略重复推送：${msg.message_id}`);
      return;
    }

    /* 收/回各留一行日志：出问题时能直接数出"同一个 message_id 被处理了几次" */
    log(`收到${msg.chat_type === 'p2p' ? '私聊' : '群'}消息 ${msg.message_id}：${text.slice(0, 40)}`);
  } catch (err) {
    warn('消息预处理失败：', err?.message || err);
    return;
  }

  /* 身份这一关必须在进助手之前过：ask() 会在模型之前跑写动作，等到里面再判断
     就晚了。open_id 拿不到（老事件格式）也一律当外人处理。 */
  const openId = data?.sender?.sender_id?.open_id || '';
  if (!claimOwner(openId)) {
    log(`拒绝非所有者消息 ${msg.message_id}（${openId || '无 open_id'}）`);
    void replyText(client, msg.message_id, '这个机器人只对所有者开放。').catch(() => {});
    return;
  }

  void answer(client, msg, text, { openId, chatId: msg.chat_id || '' });
}

/** 真正的查询与回复。慢慢来没关系，回执已经先发走了 */
async function answer(client, msg, text, identity) {
  try {
    /* identity 一路带进 ask()：到了 localAction 那一层还要用它做"是不是本人 +
       有没有确认"的判断，光在入口挡一次不够（HTTP 侧也会调 ask） */
    const task = ask(text, { identity, trusted: true })
      .catch((err) => ({ reply: `查询失败：${err?.message || err}`, engine: 'error' }));

    let timer = null;
    const slow = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), SLOW_MS);
    });
    const quick = await Promise.race([task, slow]);
    if (timer) clearTimeout(timer);

    if (quick) {
      await replyTo(client, msg, quick);
      log(`已回复 ${msg.message_id}（快，${quick.engine || '?'}）`);
      return;
    }

    await replyText(client, msg.message_id, '正在查，稍等…');
    const full = await task;
    await replyTo(client, msg, full);
    log(`已回复 ${msg.message_id}（慢，${full.engine || '?'}）`);
  } catch (err) {
    /* 回复失败最常见的两种：应用没发消息权限、被移出群。带原因记下来，
       否则用户只会看到"没反应" */
    warn('回复消息失败：', err?.response?.data?.msg || err?.message || err);
  }
}

/** 助手答完 → 回一条。带上引擎来源，让人知道是模型答的还是规则答的 */
async function replyTo(client, msg, result) {
  const body = String(result?.reply || '（没有内容）').slice(0, 3000);
  const engine = result?.engine === 'llm' ? '大模型' : result?.engine === 'rule' ? '本地规则' : result?.engine === 'local' ? '本地操作' : '';
  const text = engine ? `${body}\n\n—— 工作台助手 · ${engine}` : body;
  await replyText(client, msg.message_id, text);
}

/** 回复一条消息（reply 接口会把新消息挂在原消息下面） */
async function replyText(client, messageId, text) {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text: String(text) }) },
  });
}

/**
 * 卡片按钮回调。
 *
 * 这张卡是助手机上的脚本发的（封禁申请），按钮 value 里带着动作和一次性授权码：
 *   { hermes_local_action: 'ban_approve' | 'ban_reject', code, ip }
 *
 * 真正执行要走 SSH 到助手机跑 frp_guard.py，一来一回几十秒 —— 飞书的回调帧
 * 等不起那么久（超时会重投，按钮会被点两遍）。所以这里**立刻回一个 toast**，
 * 真正的封禁放到后台异步做，做完再把卡片本身改成"已批准/已拒绝"。
 */
function handleCardAction(client, data) {
  const value = data?.action?.value || {};
  const action = String(value.hermes_local_action || '');
  const code = String(value.code || '').trim();
  const ip = String(value.ip || '').trim();

  if (action !== 'ban_approve' && action !== 'ban_reject') {
    return { toast: { type: 'info', content: action ? `暂不支持的动作：${action}` : '这个按钮没有动作' } };
  }
  if (!code) {
    return { toast: { type: 'error', content: '卡片里没有授权码' } };
  }

  const approve = action === 'ban_approve';
  const messageId = data?.context?.open_message_id || data?.open_message_id || null;
  const operatorOpenId = String(data?.operator?.open_id || '').trim();
  const operator = data?.operator?.name || operatorOpenId || '未知';

  /* 按钮在群里，谁都能点 —— 之前只把 operator 写进日志，等于"看到就能批"。
     这里把点击者绑到所有者名单上：名单为空说明还没完成首次认领，也拒绝。 */
  if (!isOwner(operatorOpenId)) {
    log(`拒绝非所有者卡片操作：${operatorOpenId || '无 open_id'} → ${action}`);
    return {
      toast: {
        type: 'error',
        content: ownerList().length ? '只有所有者可以审批这次封禁' : '请先私聊机器人发一条消息，完成所有者绑定',
      },
    };
  }

  /* 按钮被连点/事件重投时只执行一次。授权码本身是一次性的，第二次必然失败，
     但那会让卡片被改写成"执行失败"，比直接告诉他"已经点过了"更让人迷惑 */
  if (!claimEvent(`card:${data?.event_id || `${action}:${code}`}`)) {
    return { toast: { type: 'info', content: '这个操作已经处理过了' } };
  }

  void runDecision(client, { code, approve, ip, messageId, operator });

  return {
    toast: {
      type: 'success',
      content: approve ? '已受理，正在执行封禁…' : '已受理，正在拒绝…',
    },
  };
}

/** 后台执行授权决定，然后把卡片改成结果态 */
async function runDecision(client, { code, approve, ip, messageId, operator }) {
  try {
    /* 桥上 approve 要跑 frp_guard.py --apply，给足 60 秒（网页那条路只有 30 秒，
       这里经由飞书，不受页面等待时间约束，但也不能比桥的 45 秒上限还短） */
    const res = await bridgeCall(`/local/security/${approve ? 'approve' : 'reject'}`, {
      method: 'POST',
      /* by: 这条是飞书点的。桥据此写审计里的批准人，并且不再重复 PATCH 卡片 ——
         结果卡由下面 patchResultCard 改成带操作人名的版本。 */
      /* operator 一起送过去：桥把它拼进审计里的批准人，否则所有飞书审批都只
         记成"飞书授权"，出了事没人说得清是谁点的 */
      body: { code, by: '飞书', operator },
      timeout: 60000,
    });
    log(`卡片授权已执行：${approve ? '批准' : '拒绝'} ${code}（${operator}）`);
    await patchResultCard(client, messageId, { approve, ip, code, ok: true, detail: res?.output || `操作人：${operator}` });
  } catch (err) {
    const reason = err?.message || String(err);
    warn('卡片授权执行失败：', reason);
    await patchResultCard(client, messageId, { approve, ip, code, ok: false, detail: reason });
  }
}

/**
 * 把卡片改写成结果态。
 *
 * PATCH 要求**发卡的应用**和 PATCH 的应用是同一个 —— 卡片是助手机脚本用
 * 它 .env 里的 FEISHU_APP_ID 发的，所以设置页里的 App ID 必须与之一致，
 * 否则这里会失败（失败也不影响封禁本身是否已经执行）。
 */
async function patchResultCard(client, messageId, { approve, ip, code, ok, detail }) {
  if (!messageId || !client) return;
  const title = ok ? (approve ? '✅ 已批准封禁' : '🚫 已拒绝') : '⚠️ 执行失败';
  /* IP 带地区：一眼看出这是哪来的段 */
  const ipText = ip ? await enrichIps(ip) : '未知';
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: ok ? (approve ? 'green' : 'grey') : 'red',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [`**目标 IP**\n${ipText}`, `**授权码**\n${code}`].join('\n'),
        },
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: String(detail || '').slice(0, 300) || '（无附加信息）' }],
      },
    ],
  };
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  } catch (err) {
    /* 改卡片失败不影响封禁是否已经执行，只影响群里那张卡还停在旧样子 */
    warn('更新卡片状态失败：', err?.response?.data?.msg || err?.message || err);
  }
}

/**
 * 启动自检：机器人到底在哪些群里、配置的 chat_id 是否其中之一。
 * 只读，失败不抛 —— 缺 im:chat:readonly 时报错本身就是有用的信息。
 */
async function selfCheck(client, cfg) {
  const want = String(cfg.chatId || '').trim();
  try {
    const res = await client.im.chat.list({ params: { page_size: 50 } });
    const items = res?.data?.items || [];
    if (!items.length) {
      warn('自检：机器人不在任何群里 —— 把它拉进群，或群里 @ 一次后再看');
      return;
    }
    log(`自检：在 ${items.length} 个群（${items.map((c) => c.name || c.chat_id).join(' / ')}）`);
    if (want && !items.some((c) => c.chat_id === want)) {
      warn(`自检：配置的 chat_id ${want} 不在这份列表里 —— 发得出去才怪`);
    }
  } catch (err) {
    warn('自检失败（列群需要 im:chat:readonly）：', err?.response?.data?.msg || err?.message || err);
  }
}

/** 飞书文本消息的 content 是 JSON 字符串，里面 @ 会变成 @_user_1 这种占位 */
function extractText(msg) {
  if (msg.message_type !== 'text') return '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    return String(parsed.text || '')
      .replace(/@_user_\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  } catch {
    return String(msg.content || '').slice(0, 200);
  }
}
