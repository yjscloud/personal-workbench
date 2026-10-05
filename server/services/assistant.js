import { db, update, uid } from '../store.js';
import { getOverview } from './pve.js';
import { accumulate, estimateWatts, powerReport, applyEco } from './power.js';
import { hermesSeats, hasHermesCredentials, hermesSessionStatus } from './hermes.js';
import { aiConfigured, llmReply, llmStream } from './llm.js';

/* ── 小工具 ─────────────────────────────────────────────────────────── */
const fmtBytes = (v) => {
  const n = Number(v) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(x >= 100 || i <= 1 ? 0 : 1)}${units[i]}`;
};

const pct = (used, total) => (total > 0 ? `${((used / total) * 100).toFixed(1)}%` : '—');

const money = (v, currency = 'CNY') => `${currency === 'CNY' ? '¥' : ''}${(Number(v) || 0).toFixed(2)}`;

const PRIORITY_LABEL = { P0: 'P0 紧急', P1: 'P1 高', P2: 'P2 中', P3: 'P3 低' };
const STATUS_LABEL = { todo: '待处理', doing: '进行中', review: '待验证', done: '已完成' };

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── 上下文快照：给 LLM 或规则引擎提供「当前事实」 ──────────────────── */
export async function buildContext() {
  const data = db();
  const settings = data.settings;
  let monitoring = null;
  try {
    const overview = await getOverview(settings, { timeframe: 'hour' });
    const wattsInfo = estimateWatts(
      { ...overview.status, disks: overview.disks },
      overview.sensors,
      settings,
    );
    monitoring = {
      mode: overview.mode,
      node: overview.node,
      cpuPercent: Math.round((overview.status?.cpu || 0) * 1000) / 10,
      memPercent: pct(overview.status?.memory?.used, overview.status?.memory?.total),
      rootPercent: pct(overview.status?.rootfs?.used, overview.status?.rootfs?.total),
      loadavg: overview.status?.loadavg?.join(' / '),
      uptimeHours: Math.round((overview.status?.uptime || 0) / 3600),
      watts: Math.round(wattsInfo.watts),
      eco: settings.power?.eco ? '开启' : '关闭',
      cpuTemp: overview.sensors?.temperatures?.find((t) => t.kind === 'cpu')?.value ?? null,
      diskTemps: (overview.sensors?.temperatures || []).filter((t) => t.kind === 'disk').map((t) => `${t.name} ${Math.round(t.value)}°C`),
    };
  } catch (err) {
    monitoring = { error: err.message };
  }

  // Hermes 工位走的是公开接口，读不到只影响这一段上下文，不该拖累整轮问答
  let hermes = null;
  try {
    const seats = await hermesSeats({ timeout: 4000 });
    hermes = {
      baseUrl: seats.baseUrl,
      gatewayVersion: seats.gatewayVersion,
      seats: seats.seats,
      staffed: seats.staffed,
      vacant: seats.vacant,
      online: seats.online,
      agents: seats.items.map((a) => `${a.name}${a.en ? `（${a.en}）` : ''}：${a.online ? '在线' : '离线'}`),
      checkedAt: seats.checkedAt,
    };
  } catch (err) {
    hermes = { error: err.message };
  }

  const openTodos = data.todos.filter((t) => !t.done);
  const weekTickets = data.tickets;
  return {
    monitoring,
    hermes,
    todos: { open: openTodos.length, total: data.todos.length, today: openTodos.map((t) => `${t.priority} ${t.text}`).slice(0, 8) },
    tickets: {
      open: weekTickets.filter((t) => t.status !== 'done').length,
      p0: weekTickets.filter((t) => t.priority === 'P0' && t.status !== 'done').map((t) => `${t.id} ${t.title}`),
      urgent: weekTickets.filter((t) => t.status !== 'done' && (t.priority === 'P0' || t.priority === 'P1')).slice(0, 6).map((t) => `${t.id}[${t.priority}] ${t.title} · ${STATUS_LABEL[t.status]}`),
    },
    news: (data.news.items || []).slice(0, 5).map((n) => `[${n.source}] ${n.title}`),
    /* 知识库目录 + 正文节选。只给标题和标签的话，接了大模型也答不出"具体该怎么做"；
       节选必须按篇截断（每篇 160 字、最多 12 篇），否则一篇长 Runbook 就能吃掉整个上下文。 */
    knowledge: data.knowledge.slice(0, 12).map((k) => {
      const excerpt = String(k.body_plain || '').slice(0, 160);
      return `${k.type}｜${k.title}｜标签:${(k.tags || []).join(',')}${excerpt ? `｜正文节选:${excerpt}` : ''}`;
    }),
  };
}

/**
 * 工位状态问答。走 Hermes 的公开接口，免凭证，所以不配口令也能回答；
 * 口令只是决定「能不能再往下调登录后的业务接口」，这里如实提示即可。
 */
async function hermesReply() {
  let seats;
  try {
    seats = await hermesSeats({ timeout: 5000 });
  } catch (err) {
    return { reply: `读不到 Hermes 的工位状态：${err.message}`, actions: [] };
  }

  const lines = [
    `Hermes Agent Office ${seats.gatewayVersion ? `v${seats.gatewayVersion}` : ''}（${seats.baseUrl}）`,
    `· ${seats.seats ?? '—'} 个工位，${seats.staffed ?? '—'} 名员工在编，${seats.vacant ?? '—'} 个空缺，在线 ${seats.online ?? '—'} 人`,
  ];
  if (seats.items.length) {
    lines.push(seats.items.map((a) => `· ${a.name}${a.en ? `（${a.en}）` : ''} ${a.online ? '在线' : '离线'}`).join('\n'));
  } else {
    lines.push('· 还没有任何员工在编');
  }

  // 凭证状态单独说清楚：决定下一步能不能做「管」，而不是只报在线数
  if (!hasHermesCredentials()) {
    lines.push('', '未配置 HERMES_USER / HERMES_PASSWORD，目前只能看免登录的公开状态。');
  } else if (!hermesSessionStatus().loggedIn) {
    lines.push('', '凭证已配置，但还没有建立会话；调用业务接口时会自动登录一次。');
  }
  return { reply: lines.join('\n'), actions: [] };
}

/* ── 规则引擎 ───────────────────────────────────────────────────────── */
/* 本地写操作：必须由工作台自己落库，不能交给模型 */

/**
 * 开关节能模式、加待办——这两件事都要改工作台自己的库。
 * 交给大模型只会换来一句「已开启」而库里什么都没变：假成功比不执行更糟，
 * 所以 ask() 会在模型之前先跑这里。返回 null 表示「不是写操作」，继续往下走。
 */
async function localAction(text) {
  const lower = text.toLowerCase();
  const settings = db().settings;

  /* 节能模式 */
  const ecoOn = /(开启|打开|启用|进入)\s*节能/.test(text) || /eco\s*(on|enable)/i.test(lower);
  const ecoOff = /(关闭|取消|退出|停止)\s*节能/.test(text) || /eco\s*(off|disable)/i.test(lower);
  if (ecoOn || ecoOff) {
    const enabled = ecoOn;
    update((d) => {
      d.settings.power.eco = enabled;
    });
    const link = await applyEco(enabled, db().settings);
    const note = link.errors?.length ? `\n联动提示：${link.errors.join('；')}` : '';
    return {
      reply: `已${enabled ? '开启' : '关闭'}节能模式。\n功耗模型上限调整为 ${settings.power.maxW}W × ${enabled ? settings.power.ecoFactor : 1}${
        link.webhook === 'ok' || link.command === 'ok' ? '\n已通知外部联动。' : ''
      }${note}`,
      actions: [{ type: 'refresh' }],
    };
  }

  /* 新增待办（显式「加待办：…」优先于关键词匹配） */
  const addMatch = /^(?:帮我)?(?:新增|添加|加|记个|记一下|新建)(?:一个)?(?:今日)?待办[：:，,\s]*(.+)$/.exec(text);
  if (addMatch) {
    const content = addMatch[1].trim();
    if (!content) return { reply: '要记什么？例如「加待办：重启监控容器」。', actions: [] };
    const priority = /紧急|马上|立刻|最高/.test(content) ? 'P0' : /重要|尽快/.test(content) ? 'P1' : 'P2';
    const id = uid('td');
    update((d) => {
      d.todos.unshift({ id, text: content, done: false, priority, due: todayKey(), createdAt: new Date().toISOString() });
    });
    return { reply: `已加入今日待办（${PRIORITY_LABEL[priority]}）：${content}`, actions: [{ type: 'refresh' }] };
  }

  return null;
}

async function ruleReply(message) {
  const text = message.trim();
  const lower = text.toLowerCase();
  const data = db();
  const settings = data.settings;
  const actions = [];

  const has = (...words) => words.some((w) => (w.length <= 3 ? lower.includes(w.toLowerCase()) : text.includes(w)));

  // 写操作与模型路径共用同一份实现，避免两边规则各写一套后慢慢漂移
  const local = await localAction(text);
  if (local) return local;

  /* 监控 / 硬件状态 */
  if (has('监控', '功耗', '电费', '温度', 'cpu', '内存', '硬盘', '负载', 'pve', '节点', '状态')) {
    const overview = await getOverview(settings, { timeframe: 'hour' });
    const status = overview.status || {};
    const wattsInfo = estimateWatts({ ...status, disks: overview.disks }, overview.sensors, settings);
    accumulate(wattsInfo.watts, settings, { eco: settings.power.eco });
    const report = powerReport({
      status,
      sensors: overview.sensors,
      settings,
      wattsInfo,
      energy: db().energy,
    });
    const cpuTemp = overview.sensors?.temperatures?.find((t) => t.kind === 'cpu');
    const diskTemps = (overview.sensors?.temperatures || []).filter((t) => t.kind === 'disk');

    const lines = [
      `${overview.mode === 'demo' ? '（演示数据）' : ''}节点 ${overview.node}`,
      `· CPU ${((status.cpu || 0) * 100).toFixed(1)}% · 负载 ${(status.loadavg || []).join(' / ')}`,
      `· 内存 ${pct(status.memory?.used, status.memory?.total)}（${fmtBytes(status.memory?.used)} / ${fmtBytes(status.memory?.total)}）`,
      `· 根分区 ${pct(status.rootfs?.used, status.rootfs?.total)}（${fmtBytes(status.rootfs?.used)} / ${fmtBytes(status.rootfs?.total)}）`,
      `· 整机功耗 ${report.watts}W（${report.source === 'sensor' ? '传感器实测' : '模型估算'}）· 节能模式${report.eco.enabled ? '已开启' : '关闭'}`,
      `· 今日用电 ${report.today.kwh} kWh，花费 ${money(report.today.cost)}；按当前功率预估日花费 ${money(report.projection.dayCost)}、月 ${money(report.projection.monthCost)}`,
    ];
    if (cpuTemp) lines.push(`· CPU 温度 ${Math.round(cpuTemp.value)}°C`);
    if (diskTemps.length) lines.push(`· 硬盘温度 ${diskTemps.map((t) => `${Math.round(t.value)}°C`).join(' / ')}`);

    actions.push({ type: 'refresh' });
    return { reply: lines.join('\n'), actions };
  }

  /* 待办查询 */
  if (has('待办', 'todo', '今天要做', '任务清单')) {
    const open = data.todos.filter((t) => !t.done);
    const done = data.todos.filter((t) => t.done);
    if (!open.length) return { reply: '今天的待办都清空了，可以安心看监控。', actions: [] };
    const lines = open
      .slice(0, 10)
      .map((t, i) => `${i + 1}. [${t.priority}] ${t.text}${t.due ? `（${t.due}）` : ''}`)
      .join('\n');
    return { reply: `今日待办 ${open.length} 项，已完成 ${done.length} 项：\n${lines}`, actions: [] };
  }

  /* 任务 */
  // 关键词里保留「工单」：界面已统一叫任务，但用户嘴上可能还是工单
  if (has('工单', 'ticket', '任务', '优先级')) {
    const open = data.tickets.filter((t) => t.status !== 'done');
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const sorted = [...open].sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));
    if (!sorted.length) return { reply: '本周任务已全部完成。', actions: [] };
    const lines = sorted
      .slice(0, 10)
      .map((t) => `· ${t.id} [${PRIORITY_LABEL[t.priority] || t.priority}] ${t.title} — ${STATUS_LABEL[t.status] || t.status}`)
      .join('\n');
    return { reply: `本周未完成任务 ${open.length} 个：\n${lines}`, actions: [] };
  }

  /* AI 热点 */
  if (has('热点', '新闻', '资讯', 'news', 'ai 动态', 'ai热点')) {
    const items = (data.news.items || []).slice(0, 5);
    if (!items.length) return { reply: '还没有抓取到热点，去「AI 热点」页点一下刷新。', actions: [{ type: 'navigate', to: '/news' }] };
    const lines = items.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n');
    return { reply: `最新 ${items.length} 条（更新于 ${data.news.updatedAt ? new Date(data.news.updatedAt).toLocaleString('zh-CN') : '未知'}）：\n${lines}`, actions: [{ type: 'navigate', to: '/news' }] };
  }

  /* Hermes 工位（局域网智能工位网关）*/
  // 放在知识库之前：知识库这条规则吃的是「怎么 / 如何」这类很宽的词，
  // 「Hermes 上都有谁」这种问句落在它后面会被误吞。
  if (has('工位', '员工', '司册', '白饭', '拾贝', '尾流', 'hermes', 'Hermes', 'agent', 'Agent')) {
    return await hermesReply();
  }

  /* 知识库检索 */
  if (has('知识库', 'sop', 'runbook', '手册', '流程', '怎么', '如何', '排查', '故障', '告警', '步骤')) {
    const cleaned = text
      .replace(/知识库|sop|runbook|手册|流程|怎么|如何|排查|故障|告警|步骤|处理|查一下|搜索|查找|找一下|请问|帮我|呢|吗|的|？|\?/gi, ' ')
      .trim();
    const tokens = cleaned.split(/[\s,，、]+/).filter((t) => t.length >= 1);
    // 标题命中权重最高，其次是标签，最后才是正文里顺带提到
    const scored = data.knowledge
      .map((k) => {
        const title = String(k.title || '').toLowerCase();
        const tags = (k.tags || []).join(' ').toLowerCase();
        /* 检索打在 body_plain 上，不是 Markdown 源：否则用户搜「表」会命中表格分隔行。
           权重不变 —— 标题 5 / 标签 3 / 正文 1。 */
        const body = `${k.summary || ''} ${k.body_plain || ''}`.toLowerCase();
        let score = 0;
        for (const raw of tokens) {
          const token = raw.toLowerCase();
          if (title.includes(token)) score += 5;
          if (tags.includes(token)) score += 3;
          if (body.includes(token)) score += 1;
        }
        return { k, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = scored[0]?.k;
    if (!best) {
      const all = data.knowledge.map((k) => `· ${k.type.toUpperCase()}｜${k.title}`).join('\n');
      return { reply: `没有匹配到条目。知识库现有 ${data.knowledge.length} 篇：\n${all}`, actions: [{ type: 'navigate', to: '/knowledge' }] };
    }

    const others = scored.slice(1, 3).map((x) => `· ${x.k.type.toUpperCase()}｜${x.k.title}`);
    return {
      /* 正文原样交给气泡渲染 —— 知识库正文本身就是 Markdown，
         在这里再拼一遍序号列表只会把代码块和表格拆烂。 */
      reply: [
        `**${best.type.toUpperCase()}｜${best.title}**`,
        best.summary,
        '',
        best.body || '（这篇还没有写正文）',
        others.length ? `\n相关条目：\n${others.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      actions: [{ type: 'navigate', to: '/knowledge' }],
    };
  }

  /* 帮助 / 兜底 */
  return {
    reply: [
      '我可以直接回答本地数据相关的问题，试着这样问我：',
      '· 现在功耗多少 / 这台机器温度正常吗',
      '· 开启节能模式 / 关闭节能模式',
      '· 今天还有哪些待办 / 加待办：给 NAS 加监控',
      '· 本周有哪些高优先级任务',
      '· ZFS 池满了怎么处理（检索 SOP / Runbook）',
      '· 今天有什么 AI 热点',
      '· Hermes 工位现在谁在线',
      '',
      '配置 AI_API_KEY 后，我可以接入大模型做更自由的问答。',
    ].join('\n'),
    actions: [],
  };
}

/* ── LLM 模式（可选）───────────────────────────────────────────────── */
/* 端点、超时、SSE 解析都在 services/llm.js —— 工作台助手和文章助手共用那一份。
   这里只剩两件本地的事：拼助手的系统提示，以及把模型结果和规则引擎拼起来。 */

function aiSystemPrompt(context) {
  return [
    '你是「个人工作台」里的运维助手，服务对象是管理 Proxmox 家庭实验室的工程师。',
    '回答要短、要具体，优先使用下面提供的实时上下文数据，不要编造数据。',
    '涉及具体数值时带单位；涉及操作时给出可执行的命令；不确定就说明不确定。',
    '',
    '当前上下文（JSON）：',
    JSON.stringify(context),
  ].join('\n');
}

/** 助手的消息体：system 里带实时上下文，user 是用户那一句 */
const assistantMessages = (message, context) => [
  { role: 'system', content: aiSystemPrompt(context) },
  { role: 'user', content: message },
];

/* ── 对外入口 ──────────────────────────────────────────────────────── */
export async function ask(message) {
  const text = String(message || '').slice(0, 2000);
  if (!text.trim()) return { reply: '说点什么吧。', actions: [] };

  // 先拦写操作：开关节能模式、加待办这类动作必须落进工作台自己的库。
  // 交给模型的话，它回一句「已开启」而库里没变——这种假成功比不执行更糟；
  // 顺带也省掉一次动辄上万 token 的模型调用。
  try {
    const local = await localAction(text);
    if (local) return { ...local, engine: 'local' };
  } catch (err) {
    // 能走到执行环节才会抛错，说明多半是写操作失败了，这时绝不能转手给模型
    return { reply: `本地操作没能执行：${err.message}`, actions: [], engine: 'local' };
  }

  const useLlm = aiConfigured();
  try {
    if (useLlm) {
      const context = await buildContext();
      const reply = await llmReply(assistantMessages(text, context), { source: 'assistant' });
      return { reply, actions: [], engine: 'llm' };
    }
  } catch (err) {
    const fallback = await ruleReply(text);
    return { ...fallback, engine: 'rule', warning: `大模型调用失败（${err.message}），已用本地规则回答。` };
  }

  const result = await ruleReply(text);
  return { ...result, engine: 'rule' };
}

/**
 * 流式版 ask()。emit 会收到三类事件：
 *   { type:'thinking', text }  推理片段——只表示"有进展"，不是答案
 *   { type:'delta', text }     答案片段，按顺序拼接即为全文
 *   { type:'done', reply, actions, engine, warning? }
 *
 * 语义与 ask() 严格一致：写操作仍由本地执行（不流式，命中就直接 done）；
 * 模型失败时，只有在**没吐出过任何答案片段**的前提下才回退规则引擎——
 * 已经出了半截答案再回退，两段文字会接在一起，比直接报错更难懂。
 * done.reply 为 null 表示"保留已经流出去的内容"，由前端按此处理。
 */
export async function askStream(message, emit) {
  const text = String(message || '').slice(0, 2000);
  if (!text.trim()) {
    emit({ type: 'done', reply: '说点什么吧。', actions: [], engine: 'local' });
    return;
  }

  try {
    const local = await localAction(text);
    if (local) {
      emit({ type: 'done', reply: local.reply, actions: local.actions, engine: 'local' });
      return;
    }
  } catch (err) {
    emit({ type: 'done', reply: `本地操作没能执行：${err.message}`, actions: [], engine: 'local' });
    return;
  }

  if (aiConfigured()) {
    let emitted = false;
    try {
      const context = await buildContext();
      const answer = await llmStream(
        assistantMessages(text, context),
        (chunk) => {
          if (chunk.type === 'delta') emitted = true;
          emit(chunk);
        },
        { source: 'assistant' },
      );
      emit({
        type: 'done',
        reply: answer.trim(),
        actions: [],
        engine: 'llm',
        ...(answer.trim() ? {} : { warning: '模型没有返回内容。' }),
      });
      return;
    } catch (err) {
      if (emitted) {
        emit({ type: 'done', reply: null, actions: [], engine: 'llm', warning: `大模型调用中断（${err.message}）` });
        return;
      }
      const fallback = await ruleReply(text);
      emit({
        type: 'done',
        reply: fallback.reply,
        actions: fallback.actions,
        engine: 'rule',
        warning: `大模型调用失败（${err.message}），已用本地规则回答。`,
      });
      return;
    }
  }

  const result = await ruleReply(text);
  emit({ type: 'done', reply: result.reply, actions: result.actions, engine: 'rule' });
}
