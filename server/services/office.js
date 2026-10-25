import { authedRequest, hermesApi, hasHermesCredentials, openHermesStream, hermesSeats } from './hermes.js';

/* ────────────────────────────────────────────────────────────────────────
 * Hermes「Agent Office」—— 登录墙后面那半
 * ────────────────────────────────────────────────────────────────────────
 * 免登录的 `/public/agents` 只给工位数量与在线标记（services/hermes.js 里已归一化）。
 * 这一层接的是要 Cookie 会话才读得到的东西，全部走面板自己的会话去调，
 * 浏览器不直接碰那台网关（跨域 + 混合内容 + 不该把会话交给前端）。
 *
 * 实测的接口面（路径都是相对那台控制台的）：
 *
 *   GET  /public/agents                       免登录：工位/在编/在线 + 每位员工在线标记
 *   GET  /hermes/api/sessions?limit=&offset=  对话回溯（网关侧，控制台以 /hermes 前缀代理）
 *   GET  /hermes/api/sessions/:id/messages    某次对话的逐条明细
 *   POST /hermes/api/sessions/:id/chat/stream 对话（SSE，边想边推）
 *   GET  /local/board                         全局待办工作表（任务 / 最近执行 / 异常）
 *   GET  /local/usage                         今日与近 7 日 token 用量、预算
 *   GET  /local/security                      边界守望：攻击快照 / 24h 汇总 / 待授权封禁
 *   GET  /local/security/profile?ip=          单个来源 IP 的画像（连接 / 字节 / 用户名 / 封禁史）
 *   POST /local/security/approve|reject       {code} 批准或拒绝一条封禁申请
 *   GET  /assets/*.png                        员工立绘（连图片也在登录墙后面）
 *
 * ── 两个刻意的取舍 ──────────────────────────────────────────────────────
 * 1. **员工档案写在代码里**。控制台的 `/public/agents` 只回 id/name/en/online，
 *    岗位职责、工位号、立绘文件名都只存在于它自己的前端常量里（`AGENTS` 数组，
 *    在 index.html 内联）。这里照抄一份并注明来源，是因为没有别的接口可取；
 *    写死一个 id → 立绘的映射同时也是一道白名单：取立绘只认这几个文件名，
 *    不会变成"拿任意路径去打那台内网机器"的跳板。
 * 2. **不搬它的演示数据**。它前端那几栏「当前任务 / 今日 token」对部分员工是写死的
 *    示例值（鲸吞/蓝岚那些是演示员工，根本不在在编名单里）。这里只取能核实的：
 *    名字、岗位、工位号、在线与否，以及真实接口给的待办与用量。编不出来就不显示。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 在编员工的档案。id 与 `/public/agents` 的 id 一致（用它对上）。
 *
 * avatar 是那台机器上 `/assets/` 里的文件名，由本服务代理出去
 * （见 avatarFile：字节原样转发 + 长缓存）。
 *
 * chat 表示"这个岗位有没有真的对话通道"：`agent` = 网关那个智能体本体，
 * 能真的收发；其余岗位是工具集/守望/采集子系统，没有对话概念，界面上要如实标出来，
 * 不能装作在跟它聊。
 */
export const EMPLOYEES = [
  {
    id: 'hermes',
    name: '白饭',
    en: 'Hermes',
    role: '首席智能体 · 统筹任务编排与自我进化',
    seat: 'A-02',
    avatar: 'whale-girl.png',
    chat: 'agent',
  },
  {
    id: 'weiliu',
    name: '尾流',
    en: 'Wake',
    role: '运维值守 · 巡检、告警根因分析、边界攻击守望（真实 cron 任务驱动）',
    seat: 'B-03',
    avatar: 'wake.png',
    chat: null,
  },
  {
    id: 'shabei',
    name: '拾贝',
    en: 'Harvester',
    role: '数据采集 · 全网抓取、结构化抽取与反爬绕过',
    seat: 'A-03',
    avatar: 'shabei.png',
    chat: null,
  },
  {
    id: 'mcp-filesystem',
    name: '司册',
    en: 'Filesystem MCP',
    role: 'MCP 文件服务 · 负责 /data/filesystem 的读写与检索',
    seat: 'A-01',
    avatar: 'sice.png',
    chat: null,
  },
];

/** 立绘白名单：只有档案里出现过的文件名才允许去取 */
const AVATAR_FILES = new Set(EMPLOYEES.map((e) => e.avatar));

/** 工位/员工在线状态 + 档案合并。列表顺序按上面的档案来（网关回的 id 顺序不稳定） */
export async function officeRoster() {
  const seats = await hermesSeats();
  const live = new Map(seats.items.map((a) => [a.id, a]));
  return {
    ...seats,
    items: EMPLOYEES.map((e) => ({
      id: e.id,
      name: e.name,
      en: e.en,
      role: e.role,
      seat: e.seat,
      avatar: `/api/office/avatar/${e.avatar}`,
      online: Boolean(live.get(e.id)?.online),
      /** 该岗位有没有独立对话通道；没有的由白饭代答（见 chatStream 的说明） */
      chat: e.chat,
    })),
    /** 网关回里出现过、但档案里没有的 id：不静默丢，交给界面提示"档案没跟上" */
    unknown: seats.items.filter((a) => !EMPLOYEES.some((e) => e.id === a.id)).map((a) => a.id),
  };
}

/* ── 立绘代理 ──────────────────────────────────────────────────────────
 * 为什么不直接把那台机器的地址丢给浏览器：
 *   · 面板可以用 https 打开，而它是 http —— 混合内容会被浏览器直接拦掉；
 *   · 立绘在登录墙后面，浏览器没有那个会话 Cookie，拿到的只会是 401 的 JSON；
 *   · 那 4 张图每张 1MB 级，让它每次都被内网穿一遍没意义。
 * 所以由服务端取一次、缓存在内存里，浏览器只跟面板要。
 */
const AVATAR_TTL = 30 * 60 * 1000;
const AVATAR_MAX = 8 * 1024 * 1024;
const avatarCache = new Map(); /* 文件名 → { at, contentType, buffer } */

/**
 * 取员工立绘（PNG 字节）。文件名必须是白名单里的，不认路径分隔符 ——
 * 这个函数对外暴露成一个 GET 路由，任何能走进来的字符串都会变成"用面板的
 * 会话去打内网网关"的一次请求，所以白名单是必须的，不是"顺手校验"。
 */
export async function avatarFile(file) {
  const name = String(file || '').trim();
  if (!AVATAR_FILES.has(name)) throw new Error('没有这张立绘');
  if (!hasHermesCredentials()) throw new Error('服务端没有配置 Hermes 口令，读不到立绘（它也在登录墙后面）');

  const hit = avatarCache.get(name);
  if (hit && Date.now() - hit.at < AVATAR_TTL) return hit;

  const res = await authedRequest(`/assets/${name}`, { timeout: 15000, binary: true, maxBytes: AVATAR_MAX });
  if (res.status !== 200 || !res.buffer?.length) throw new Error(`取立绘失败（HTTP ${res.status}）`);
  const entry = {
    at: Date.now(),
    contentType: String(res.headers['content-type'] || 'image/png'),
    buffer: res.buffer,
  };
  avatarCache.set(name, entry);
  return entry;
}

/* ── 待办 / 用量 / 对话 ─────────────────────────────────────────────── */

/** 全局待办工作表：会话统计、定时任务、最近执行、异常 */
export const officeBoard = () => hermesApi('/local/board', { timeout: 12000 });

/** 今日与近 7 日 token 用量（含预算与模型） */
export const officeUsage = () => hermesApi('/local/usage', { timeout: 12000 });

/* ── 给顶栏用的用量摘要 ──────────────────────────────────────────────
 * 顶栏那个「今日消耗 Token」原本只算面板自己调了几次模型，而办公室那几位
 * （定时任务、巡检、采集）的消耗全在网关那边 —— 不并进来，这个数漏掉大头。
 *
 * 三条约束决定了它是这么写的：
 * 1. `/ai/usage` 挂在每个页面都会拉的位置，必须**便宜**。所以这里只做
 *    内存读取：缓存过就直接给，过期就在后台刷新，**绝不在这条路径上等网络**。
 *    第一次调用时缓存还是空的，那就先返回 null，下一个轮询周期（30 秒）自然拿到。
 * 2. 失败了不能把上一次的好数抹掉。网关偶尔不通时，显示一份一分钟前的数
 *    比显示 0 或消失都强 —— 只是要带上 error，界面能说明"这份是旧的"。
 * 3. /local/usage 有 10KB，不该整个塞给顶栏。只留用得上的几个数。
 */
const USAGE_TTL = 60 * 1000;
/** 一直拿不到值时的重试间隔。别用 TTL：那会变成"每 30 秒堵一次 4 秒" */
const USAGE_RETRY_GAP = 5 * 60 * 1000;
/** 完全没有值时的首次等待上限。宁可慢这一下，也别先报一个 0 再跳数 */
const USAGE_WAIT_MS = 4000;
let usageMemo = { at: 0, triedAt: 0, val: null, inflight: null, error: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const briefOf = (u) => ({
  today: {
    total: Number(u?.today?.total) || 0,
    input: Number(u?.today?.input) || 0,
    output: Number(u?.today?.output) || 0,
    cache_read: Number(u?.today?.cache_read) || 0,
    api_calls: Number(u?.today?.api_calls) || 0,
    sources: u?.today?.sources && typeof u.today.sources === 'object' ? u.today.sources : {},
  },
  yesterday: { total: Number(u?.yesterday?.total) || 0, api_calls: Number(u?.yesterday?.api_calls) || 0 },
  models: Array.isArray(u?.models) ? u.models : [],
  budget_tokens: Number(u?.budget_tokens) || 0,
  budget_label: String(u?.budget_label || ''),
  at: new Date().toISOString(),
});

function refreshUsage() {
  usageMemo.triedAt = Date.now();
  usageMemo.inflight = officeUsage()
    .then((u) => {
      usageMemo = { ...usageMemo, at: Date.now(), val: briefOf(u), inflight: null, error: null };
    })
    .catch((err) => {
      /* 保留上一次的值，只挂上原因：界面据此说明"这份数据是旧的"；
         at 推到当下，免得每一轮轮询都往一个不通的网关重试一遍 */
      usageMemo = { ...usageMemo, at: Date.now(), inflight: null, error: err.message };
    });
  return usageMemo.inflight;
}

/**
 * 给顶栏用的用量摘要（异步，但是**已经有值时不阻塞**）。
 *
 * 第一次调用时手上什么都没有 —— 这时候要等一小下（最多 4 秒）。不等的版本
 * 会在顶栏先显示一个 0（本地记账还没有任何调用），30 秒后才跳到十几万，
 * 那个 0 足够让人以为"坏了"。等一次换一个准数，划算。
 *
 * 之后：有值就直接给（过期了在后台刷，调用方不等）；一直拿不到值就退回 null
 * （界面回到本地记账），并且 **5 分钟**才再试一次 —— 否则网关不通时，
 * 每 30 秒的轮询都会在 /ai/usage 这条路上白等 4 秒。
 */
export async function officeUsageBrief() {
  const now = Date.now();
  const stamp = usageMemo.val ? usageMemo.at : usageMemo.triedAt;
  const gap = usageMemo.val ? USAGE_TTL : USAGE_RETRY_GAP;
  if (now - stamp >= gap && !usageMemo.inflight && hasHermesCredentials()) refreshUsage();

  if (usageMemo.val) return usageMemo.error ? { ...usageMemo.val, error: usageMemo.error } : usageMemo.val;

  await Promise.race([usageMemo.inflight ?? Promise.resolve(), sleep(USAGE_WAIT_MS)]);
  if (!usageMemo.val) return null;
  return usageMemo.error ? { ...usageMemo.val, error: usageMemo.error } : usageMemo.val;
}

/** 对话回溯。网关侧那套返回 {object:'list', data, limit, offset, has_more} */
export const officeSessions = ({ limit = 20, offset = 0 } = {}) =>
  hermesApi(`/hermes/api/sessions?limit=${Number(limit) || 20}&offset=${Number(offset) || 0}`, { timeout: 12000 });

/** 某次对话的逐条明细 */
export const officeMessages = (sessionId, { limit = 30 } = {}) =>
  hermesApi(
    `/hermes/api/sessions/${encodeURIComponent(String(sessionId))}/messages?limit=${Number(limit) || 30}&order=latest`,
    { timeout: 12000 },
  );

/** 对话用的会话 id：默认就是控制台自己那条「网页端会话」，两边看到的是同一份历史 */
const CHAT_SESSION = String(process.env.HERMES_CHAT_SESSION || 'agent_office_web');

/**
 * 幂等建会话：已存在网关回 409，那正是"可以用"。
 * 不建的话第一条消息会 404（会话得先存在才有 chat/stream 可打）。
 */
async function ensureChatSession() {
  const res = await authedRequest('/hermes/api/sessions', {
    method: 'POST',
    body: { id: CHAT_SESSION, title: 'Agent Office 网页端会话' },
    timeout: 10000,
  });
  if (res.status !== 200 && res.status !== 409) {
    throw new Error(res.status === 401 ? 'Hermes 会话失效，且重登失败' : `建会话失败（HTTP ${res.status}）`);
  }
  return CHAT_SESSION;
}

/**
 * 对话用那条会话的历史明细。
 *
 * 抽屉打开时先读它：这样"进来看得见上次聊到哪儿"，而不是一片空白。
 * 与对话共用同一条会话，所以这里读到的和对话里追加的是同一份记录。
 */
export async function chatHistory({ limit = 30 } = {}) {
  const id = await ensureChatSession();
  return officeMessages(id, { limit });
}

/* ── 员工详情（点开工位后那个弹窗）────────────────────────────────────
 * 与上游控制台同一套口径：抬头四个小标签 + 每个岗位各自的页签，
 * 数据全部来自它自己的 `/local/*` 与网关接口。
 *
 * 两处**刻意不照抄**上游的地方：
 * 1. 上游的岗位元数据里混着演示值（尾流的「今日 Token 27.3万」「连续在线 9h 15m」
 *    来自它前端写死的常量）。这里凡是能算出来的都用真实数据：尾流那格改成
 *    他两个值守任务的**累计** token（并如实标注"累计"），时长改成"下次值守"。
 *    编一个数出来看着齐整，但它是假的。
 * 2. 页签集合按"这个岗位真的有这些数据"来给：远端只在个别岗位开放「进化档案」
 *    与「即时交互」，这里沿用同一套判断。
 * ──────────────────────────────────────────────────────────────────── */

/** 每个岗位有哪些页签（沿用上游：进化档案只给本体；边界守望只给值守；MCP/值守不能对话） */
const SEAT_TABS = {
  hermes: ['config', 'skills', 'evo', 'memory', 'chat'],
  'mcp-filesystem': ['config', 'skills', 'memory'],
  weiliu: ['config', 'skills', 'guard', 'memory'],
  shabei: ['config', 'skills', 'memory', 'chat'],
};

const num = (v) => (Number(v) || 0).toLocaleString('zh-CN');
const wanText = (v) => `${((Number(v) || 0) / 10000).toFixed(2)}万`;
/** 服务端也要一份时长文案：标签的悬停说明里要写"已连续运行 6 天 12 小时" */
function durText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}
const atText = (v) => String(v || '').replace('T', ' ').slice(0, 16);
const tsText = (sec) => (sec ? new Date(Number(sec) * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

/** 尾部：元数据里带 token 的定时任务（尾流那两个值守任务就在这里） */
const OPS_JOB_PREFIX = '运维值守';

/** 工位详情：档案 + 抬头标签 + 该岗位有哪些页签 */
export async function seatDetail(seatId) {
  const roster = await officeRoster();
  const profile = roster.items.find((e) => e.id === seatId);
  if (!profile) throw new Error('没有这位员工');
  const { chips, tabs } = await seatChips(seatId, profile.online);
  return { profile, chips, tabs };
}

/**
 * 工位详情：抬头那四个标签。
 *
 * 每个岗位的"今日 Token / 运行时长"来源都不一样，这是上游自己定的口径，
 * 照抄过来才对得上：本体看网关记账、司册看 MCP 常驻进程、拾贝看它自己
 * 花掉的模型钱、值守看它的定时任务。写一套通用逻辑反而会张冠李戴。
 */
export async function seatChips(seatId, online) {
  const emp = EMPLOYEES.find((e) => e.id === seatId);
  if (!emp) throw new Error('没有这位员工');
  const usage = await officeUsage();

  const chips = [{ key: 'seat', icon: 'seat', label: '工位', value: emp.seat }];

  if (seatId === 'hermes') {
    const t = usage.today || {};
    chips.push({
      key: 'token',
      icon: 'token',
      label: '今日 Token',
      value: wanText(t.total),
      tip: `真实用量：输入 ${num(t.input)} / 输出 ${num(t.output)} / 推理 ${num(t.reasoning)}（${t.api_calls} 次 API 调用）`,
    });
    const g = usage.gateway || {};
    chips.push({
      key: 'uptime',
      icon: 'clock',
      label: '网关已运行',
      seconds: g.uptime_s,
      tip: `Hermes 网关（pid ${g.pid}，版本 ${g.version}）已连续运行 ${durText(g.uptime_s)}`,
    });
  } else if (seatId === 'mcp-filesystem') {
    const items = usage.mcp?.items || [];
    const proc = items.find((p) => p.name === 'filesystem') || items[0] || null;
    chips.push({
      key: 'token',
      icon: 'token',
      label: '今日 Token',
      value: '不适用',
      tip: `司册是文件操作类 MCP 服务，读写都在本机完成、不经过模型，因此没有 token 消耗。${usage.mcp?.note ? `（${usage.mcp.note}）` : ''}`,
    });
    chips.push(
      proc
        ? {
            key: 'uptime',
            icon: 'clock',
            label: 'MCP 已运行',
            seconds: proc.uptime_s,
            tip: `文件系统 MCP 常驻进程（pid ${proc.pid}）已连续运行 ${durText(proc.uptime_s)}${proc.started_at ? `，启动于 ${atText(proc.started_at)}` : ''}。由 Hermes 网关拉起并守护。`,
          }
        : { key: 'uptime', icon: 'clock', label: 'MCP 状态', value: '未运行', tip: '网关当前没有拉起该 MCP 子进程' },
    );
  } else if (seatId === 'shabei') {
    const h = usage.harvester || {};
    const kinds = Object.entries(h.by_kind || {})
      .map(([k, v]) => `${k} ${num(v)}`)
      .join(' / ');
    chips.push({
      key: 'token',
      icon: 'token',
      label: '今日 Token',
      value: h.tokens >= 10000 ? wanText(h.tokens) : num(h.tokens),
      tip: `拾贝自己的 AI 消耗：${h.calls || 0} 次模型调用，共 ${num(h.tokens)} token${kinds ? `（${kinds}）` : ''}。${h.note || ''}`,
    });
    const s = usage.service || {};
    chips.push({
      key: 'uptime',
      icon: 'clock',
      label: '连续在线',
      seconds: s.uptime_s,
      tip: `本机采集服务（agent-office）已连续运行 ${durText(s.uptime_s)}${s.started_at ? `，启动于 ${atText(s.started_at)}` : ''}`,
    });
  } else {
    /* 值守：token 只有定时任务的**累计**数（上游那格是演示值，不抄） */
    const board = await officeBoard();
    const jobs = (board.jobs || []).filter((j) => String(j.name).startsWith(OPS_JOB_PREFIX));
    const sum = jobs.reduce((s, j) => s + (Number(j.tokens) || 0), 0);
    chips.push({
      key: 'token',
      icon: 'token',
      label: '值守累计',
      value: wanText(sum),
      tip: `两个值守任务历次执行的累计 token：${jobs.map((j) => `${j.name} ${wanText(j.tokens)}`).join(' / ')}。这是累计值，不是今日（上游那一格是它前端的演示常量）。`,
    });
    const next = jobs.map((j) => j.next_run_at).filter(Boolean).sort()[0];
    chips.push({
      key: 'uptime',
      icon: 'clock',
      label: '下次值守',
      value: next ? tsText(new Date(next).getTime() / 1000) : '未排期',
      tip: jobs.map((j) => `${j.name}：${j.schedule}，下次 ${atText(j.next_run_at)}`).join('\n'),
    });
  }

  chips.push({
    key: 'task',
    icon: 'target',
    label: '状态',
    /* 在线与否是网关那个公开接口给的，档案表里没有这一项 ——
       所以从外面传进来，而不是在这里读一个不存在的字段（那会让四张工位
       全部显示"已下线休息"） */
    value: online ? '空闲待命' : '已下线休息',
  });

  return { chips, tabs: SEAT_TABS[seatId] || ['config'], generated_at: usage.generated_at };
}

/* ── 页签数据 ───────────────────────────────────────────────────────── */

const fetchTab = {
  hermes: {
    config: () => hermesApi('/local/config', { timeout: 12000 }),
    skills: () => hermesApi('/local/skills', { timeout: 15000 }),
    evo: () => hermesApi('/local/evolution', { timeout: 12000 }),
    memory: () => hermesApi('/local/memories', { timeout: 12000 }),
  },
  'mcp-filesystem': {
    config: () => hermesApi('/local/mcp', { timeout: 12000 }),
    skills: () => hermesApi('/local/mcp', { timeout: 12000 }),
    memory: () => hermesApi('/local/mcp', { timeout: 12000 }),
  },
  weiliu: {
    config: () => hermesApi('/local/watch', { timeout: 12000 }),
    skills: () => hermesApi('/local/watch', { timeout: 12000 }),
    /* 边界守望与值守任务不是同一份数据：它来自采集器落库的攻击记录（/local/security），
       窗口快照 + 24 小时汇总 + 封禁申请单，读一次要现采两端日志，给足超时 */
    guard: () => officeSecurity(),
    memory: () => hermesApi('/local/watch', { timeout: 12000 }),
  },
  shabei: {
    config: () => hermesApi('/local/harvester/sites', { timeout: 12000 }),
    skills: () => hermesApi('/local/harvester/sites', { timeout: 12000 }),
    memory: () => hermesApi('/local/harvester/history?limit=200', { timeout: 15000 }),
  },
};

const md = (lines) => lines.filter((l) => l !== null).join('\n');

/* 配置文档：上游是在浏览器里拼 Markdown 的，这里在服务端拼 ——
   前端只管渲染与"复制 MD"，不必知道每份文档的字段从哪来 */
function configDoc(seatId, d, usage) {
  if (seatId === 'hermes') {
    const r = d.runtime || {};
    const g = d.gateway || {};
    const a = d.api_server || {};
    const m = d.model || {};
    const ag = d.agent || {};
    const c = d.counts || {};
    return md([
      '# 白饭 · Hermes',
      '',
      '> 数据来源：`/local/config` 直读 Hermes 安装目录与 `~/.hermes` 的真实文件',
      '',
      '## 运行时',
      `- 版本: ${r.version || '—'}${r.sha ? ` (${r.sha})` : ''}`,
      `- 安装路径: ${r.install_path || '—'}`,
      `- Hermes Home: ${r.hermes_home || '—'}`,
      `- 宿主: ${r.hostname || '—'} · ${r.os || '—'}`,
      `- Python: ${r.python || '—'} · Node: ${r.node || '—'}`,
      '',
      '## 网关',
      `- 状态: ${g.state || '—'} · PID ${g.pid ?? '—'} · 已运行 ${durText(g.uptime_s)}`,
      /* platforms 是对象数组（{name, state}），不是字符串数组 ——
         直接 join 会印出一串 [object Object] */
      `- 活跃 Agent: ${g.active_agents ?? '—'} · 平台: ${
        Array.isArray(g.platforms) && g.platforms.length
          ? g.platforms.map((p) => `${p.name ?? '?'}${p.state ? `（${p.state}）` : ''}`).join(' / ')
          : '—'
      }`,
      Array.isArray(g.profiles) && g.profiles.length ? `- 配置档案: ${g.profiles.join(' / ')}` : null,
      '',
      '## 接口服务',
      `- 启用: ${a.enabled ? '是' : '否'} · 监听 ${a.host || '—'}:${a.port ?? '—'}`,
      `- 密钥来源: ${a.key_source || '—'} · 最大并发: ${a.max_concurrent_runs ?? '—'}`,
      '',
      '## 模型',
      `- 当前: ${m.active || '—'}`,
      `- 对外公布: ${m.advertised || '—'}`,
      '',
      '## Agent',
      `- 最大轮次: ${ag.max_turns ?? '—'} · 推理强度: ${ag.reasoning_effort || '—'}`,
      '',
      '## 计数',
      `- 技能: 用户安装 ${c.skills_user ?? '—'} / 内置 ${c.skills_builtin ?? '—'}`,
      `- 工具集: ${c.toolsets ?? '—'} · 会话: ${c.sessions ?? '—'}`,
      `- 记忆条目: ${c.memory_entries ?? '—'} · 定时任务: ${c.cron_jobs ?? '—'} · 配置快照: ${c.config_snapshots ?? '—'}`,
      `- 配置 Schema: ${d.config_schema_version ?? '—'}`,
    ]);
  }

  if (seatId === 'mcp-filesystem') {
    const s = (d.servers || [])[0] || {};
    const p = (d.probes || []).find((x) => x.name === s.name) || (d.probes || [])[0] || {};
    const tools = p.tools || [];
    return md([
      '# 司册 · Filesystem MCP',
      '',
      `> 数据来源：\`${d.config_source || '~/.hermes/config.yaml'}\` 的 \`mcp_servers\` 段 + 实时 stdio 握手`,
      '',
      '## MCP 服务',
      `- 名称: ${s.name || '—'}`,
      `- 传输方式: ${s.transport || '—'}`,
      `- 启动命令: ${s.command || '—'}`,
      `- 参数: ${(s.args || []).join(' ') || '—'}`,
      `- 授权目录: ${(s.scope || []).join(' / ') || '—'}`,
      `- 配置来源: ${s.source || '—'}`,
      '',
      '## 实时握手（本次探测）',
      `- 状态: ${p.ok ? '✅ 已连接' : `❌ 未连接${p.error ? `（${p.error}）` : ''}`}`,
      `- 协议版本: ${p.protocol || '—'}`,
      p.server_info ? `- 服务实现: ${p.server_info.name} ${p.server_info.version}` : null,
      p.latency_ms != null ? `- 往返延迟: ${p.latency_ms} ms` : null,
      `- 可用工具: ${tools.length} 个`,
      '',
      ...tools.slice(0, 12).map((t) => `- \`${t.name}\`：${String(t.description || '').split('\n')[0]}`),
      tools.length > 12 ? `- …另有 ${tools.length - 12} 个工具（见「技能列表」页签）` : null,
    ]);
  }

  if (seatId === 'weiliu') {
    const jobs = d.jobs || [];
    const th = d.probe?.thresholds || {};
    const snap = d.probe?.snapshot || '';
    return md([
      '# 尾流 · 运维值守',
      '',
      '> 数据来源：Hermes cron `/api/jobs` + `~/.hermes/cron/executions.db` + 探针 `infra_watch.py`',
      '',
      '## 值守任务',
      ...jobs.flatMap((j) => [
        `- **${j.name}** · ${j.schedule || '—'} · ${j.mode || '—'}`,
        `  - 下次运行: ${atText(j.next_run_at) || '—'} · 上次: ${atText(j.last_run_at) || '—'}（${j.last_status || '—'}）`,
        `  - 已完成 ${j.runs_completed ?? 0} 次 · 投递: ${j.deliver || '—'}`,
        j.script ? `  - 脚本: \`${j.script}\`` : null,
        j.monitor ? `  - 监视脚本: \`${j.monitor}\`` : null,
        Array.isArray(j.skills) && j.skills.length ? `  - 技能: ${j.skills.join(' / ')}` : null,
      ]),
      '',
      '## 告警阈值',
      `- 磁盘使用率 ≥ ${th.disk ?? '—'}%`,
      `- CPU 使用率 ≥ ${th.cpu ?? '—'}%`,
      `- 内存使用率 ≥ ${th.mem ?? '—'}%`,
      `- 1 分钟负载 ≥ ${th.load ?? '—'}`,
      `- 固态硬盘剩余寿命 ≤ ${th.wear_remain ?? '—'}%（PVE 的 wearout 为剩余寿命，新盘接近 100）`,
      `- inode 使用率 ≥ ${th.inode ?? '—'}%`,
      `- 抑制：阈值类 ${Math.round((th.cooldown_alert_s || 3600) / 3600)} 小时、硬盘健康类 ${Math.round(
        (th.cooldown_health_s || 43200) / 3600,
      )} 小时（同一条告警只报一次）`,
      '',
      '## 硬盘健康监控',
      '- NVMe/SSD 剩余寿命（PVE SMART，取值 = 100 − Percentage Used，越低越危险）',
      '- SMART 健康状态：非 PASSED 即告警',
      '- inode 使用率、根分区只读挂载、内核 I/O 错误',
      '',
      '## 探针',
      `- 脚本: \`${d.probe?.script || 'infra_watch.py'}\``,
      '- watchdog 模式：只在异常时输出，**空输出即静默**',
      '- state 模式：输出稳定快照（无时间戳），供 cron 做字节级变化检测',
      '- 只读：探针与值守任务均不执行任何写操作',
      '',
      '## 边界守望（Edge Sentry）',
      '- 场景：frp 把内网 SSH / RDP / PVE / NAS / 面板暴露到公网，持续被扫描与爆破',
      '- 三层数据源，越往下越可信：',
      '  1. **frps journal** — 入口全景（谁连了哪个代理、频率）。只读，未改动 frps 配置',
      '  2. **PVE haproxy tcplog** — 真实源 IP + 连接时长 + **字节数** + 后端（SSH 专用）',
      '  3. **personal-workbench-8 / ProxCenter-17 的 secure 日志** — 用户名与认证失败次数（`qm guest exec` 按需读）',
      '- 对外提供服务的就这两台：工作台（个人 VM）与管理面板 ProxCenter-17，各自都接了 frpc，',
      '  代理命名风格不同（`pve3-*` 与 `agri`/`prokvm`/`workbuddy-api`/`tunnel-1`），均已纳入映射',
      '- 为什么需要 L2：frps 只记 TCP 建连，一次连接算一条；爆破工具在一个连接里连试多个用户名，',
      '  且「认证失败」与「真的登进去」在 frps 侧完全同形。haproxy 的字节数能区分：',
      '  实测认证失败恒定 1657~1813 字节，超过 4000 字节即疑似进入 shell，直接判严重',
      '- 采集：每 5 分钟增量拉取双源 journald，落 SQLite（`/var/lib/agent-office/security/attacks.db`），保留 7 天',
      '- 按需深挖：`frp_guard.py users`（爆破用户名，两台主机）、`frp_guard.py web`（ProxCenter Web 侧路径/UA/状态码）',
      '- 判定：单 IP 频率 / 服务广度 / 敏感目标 / 同 /24 段协同，四维评分；双源计数取最大值避免重复计数',
      '- 唤醒：快照只保留 4 个粗档位，**只有跨档才唤醒白饭**；日常扫描只入库、不发消息、0 token',
      '- 封禁：白饭只能生成申请单，你批准后才在 frps 上 `ipset add`；授权码一次性、6 小时有效',
      '- 解封：TTL 由探针自己维护（ipset 未开 timeout），**只解自己加的条目**，不动既有封禁',
      '- 白名单：`~/.hermes/scripts/frp_guard_allow.txt`，内网段自动放行',
      '',
      '## 最近一次状态快照（真实采集）',
      ...(String(snap || '').trim()
        ? String(snap)
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => `- ${line}`)
        : ['- （无）']),
    ]);
  }

  /* 拾贝：本地采集服务的真实文件 */
  const h = usage.harvester || {};
  const mem = d.memory || {};
  return md([
    '# 拾贝 · Harvester',
    '',
    '> 数据来源：`/local/harvester/*` 与采集服务自己的落盘文件',
    '',
    '## 采集服务',
    '- 执行器: 本机采集器（纯抓取不经过模型，不消耗 token）',
    `- 站点笔记: ${d.file || '—'}`,
    `- 历史记录: ${d.total ?? 0} 条（最多保留最近 200 条）`,
    `- 记忆库: ${mem.file || '—'}${mem.enabled ? `（已启用，${(mem.entries || []).length} 条）` : '（未启用）'}`,
    '',
    '## 今日 AI 消耗',
    `- ${h.calls || 0} 次模型调用 · ${num(h.tokens)} token`,
    h.note ? `- 说明: ${h.note}` : null,
  ]);
}

/**
 * 取一个页签的数据，归一化成前端能直接画的形状。
 *
 * 归一化放在服务端，是因为"每份数据长什么样"是上游的事 —— 前端只管按
 * 统一形状画。不然五个页签 × 四个岗位 = 十几套字段判断会全散进组件里。
 */
export async function seatTab(seatId, tab) {
  const emp = EMPLOYEES.find((e) => e.id === seatId);
  if (!emp) throw new Error('没有这位员工');
  if (!(SEAT_TABS[seatId] || []).includes(tab)) throw new Error('这个岗位没有这个页签');

  const load = fetchTab[seatId]?.[tab];
  if (!load) throw new Error('这个页签还没有接');

  /* 边界守望：整份快照 + 待授权单一起给。它自带待授权/封禁这类要操作的结构，
     所以与配置文档、技能列表那种"读完就画"的页签分开走 */
  if (tab === 'guard') {
    return { kind: 'guard', ...normalizeSecurity(await load()) };
  }

  if (tab === 'config') {
    const usage = await officeUsage();
    const doc = configDoc(seatId, await load(), usage);
    return {
      kind: 'doc',
      /* 这里**不要再写"数据来源："** —— 前端那一条已经带了标签，
          两处都写会变成"数据来源：数据来源：…" */
      source:
        seatId === 'hermes'
          ? '`/local/config` 直读 Hermes 安装目录与 `~/.hermes` 的真实文件'
          : seatId === 'mcp-filesystem'
            ? '`~/.hermes/config.yaml` 的 `mcp_servers` 段 + 实时 stdio 握手'
            : seatId === 'weiliu'
              ? 'Hermes cron `/api/jobs` + `~/.hermes/cron/executions.db` + 探针 `infra_watch.py` + 边界守望采集库（`/local/security`）'
              : '`/local/harvester/*` 本地采集服务的真实文件',
      markdown: doc,
    };
  }

  if (tab === 'skills') {
    if (seatId === 'hermes') {
      const d = await load();
      return {
        kind: 'skills',
        total: d.count ?? (d.items || []).length,
        groups: Object.entries(d.counts || {}).map(([label, count]) => ({ label, count })),
        items: (d.items || []).map((s) => ({
          name: s.name,
          description: s.description,
          meta: [s.source, s.version ? `v${s.version}` : null].filter(Boolean).join(' · '),
          tags: s.category ? [s.category] : [],
        })),
      };
    }
    if (seatId === 'mcp-filesystem') {
      const d = await load();
      const tools = ((d.probes || [])[0] || {}).tools || [];
      return {
        kind: 'skills',
        total: tools.length,
        groups: [{ label: 'MCP 工具', count: tools.length }],
        items: tools.map((t) => ({
          name: t.name,
          description: String(t.description || '').split('\n')[0],
          meta: 'filesystem MCP',
          tags: [],
        })),
      };
    }
    if (seatId === 'weiliu') {
      const d = await load();
      const items = [];
      for (const j of d.jobs || []) {
        if (j.script) items.push({ name: j.script, description: `${j.name} 的巡检脚本（纯脚本执行，零 token）`, meta: j.schedule || '', tags: ['脚本'] });
        if (j.monitor) items.push({ name: j.monitor, description: `${j.name} 的监视脚本（变化时唤醒 Agent）`, meta: j.schedule || '', tags: ['监视'] });
        for (const sk of j.skills || []) items.push({ name: sk, description: `值守任务用到的技能：${j.name}`, meta: 'Hermes 技能', tags: ['技能'] });
      }
      return { kind: 'skills', total: items.length, groups: [{ label: '值守能力', count: items.length }], items };
    }
    const d = await load();
    const sites = d.items || [];
    return {
      kind: 'skills',
      total: sites.length,
      groups: [{ label: '站点经验', count: sites.length }],
      items: sites.map((s) => ({
        name: s.host,
        description: `成功 ${s.ok ?? 0} · 失败 ${s.fail ?? 0}${(s.lessons || []).length ? ` · 经验 ${(s.lessons || []).length} 条` : ''}`,
        meta: [s.mode, s.updated_at ? tsText(new Date(s.updated_at).getTime() / 1000) : null].filter(Boolean).join(' · '),
        tags: s.mode ? [s.mode] : [],
      })),
    };
  }

  if (tab === 'evo') {
    const d = await load();
    const cur = d.current || {};
    const cap = d.capability || {};
    const restarts = d.gateway_restarts || {};
    const conf = await hermesApi('/local/config', { timeout: 12000 });
    const timeline = [];
    for (const [day, count] of Object.entries(cap.skill_days || {})) {
      timeline.push({
        at: day,
        kind: '能力扩展',
        title: `技能库 +${count}`,
        text: `当日入库技能 ${count} 个，技能总量 ${cap.skills ?? '—'} 个`,
        right: `+${count}`,
      });
    }
    for (const s of d.config_snapshots || []) {
      timeline.push({
        at: s.at ? new Date(Number(s.at) * 1000).toISOString() : '',
        kind: s.kind || '配置快照',
        title: s.name,
        text: `快照大小 ${num(s.bytes)} 字节`,
        right: `${(Number(s.bytes) / 1024).toFixed(1)} KB`,
      });
    }
    for (const u of d.updates || []) {
      timeline.push({
        at: u.finished_at || u.started_at || '',
        kind: '版本更新',
        title: `${u.from || '—'} → ${u.to || '—'}`,
        text: `结果 ${u.outcome || '—'}${u.duration_s ? ` · 耗时 ${u.duration_s}s` : ''}`,
        right: u.outcome === 'success' ? '成功' : String(u.outcome || ''),
      });
    }
    timeline.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return {
      kind: 'evo',
      source: '`/local/*` 直读 Hermes 安装目录与 `~/.hermes` 真实文件（已脱敏）· 更新凭据 `~/.hermes/logs/update_receipts`、配置快照 `~/.hermes/backups/config`',
      stats: [
        { label: '当前版本', value: cur.version || '—' },
        { label: '配置 Schema', value: String(cur.config_schema ?? '—') },
        { label: '技能 / 工具集', value: `${cap.skills ?? '—'} / ${conf?.counts?.toolsets ?? '—'}` },
        { label: '网关重启次数', value: String(restarts.count ?? '—') },
      ],
      timeline,
    };
  }

  /* memory：工作记录 + 记忆库 */
  if (seatId === 'hermes') {
    const d = await load();
    const seen = await officeSessions({ limit: 8 });
    return {
      kind: 'memory',
      records: (seen.data || []).map((s) => ({ at: tsText(s.last_active), text: `${s.title} · ${s.message_count} 条 · ${wanText(s.input_tokens + s.output_tokens)} token` })),
      memories: (d.items || []).map((m) => ({ tag: m.source || '记忆', text: m.text })),
      note: (d.files || []).map((f) => `${f.name}（${num(f.bytes)} 字节）`).join(' · '),
    };
  }
  if (seatId === 'mcp-filesystem') {
    const d = await load();
    return {
      kind: 'memory',
      records: (d.history || []).map((h) => ({
        at: new Date(Number(h.at)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        text: `握手 ${h.name} · ${h.ok ? '成功' : '失败'}${h.latency_ms != null ? ` · ${h.latency_ms} ms` : ''}`,
      })),
      memories: [],
      note: '文件服务不写长期记忆；它在 Hermes 的记忆库里只留下"这个 MCP 可用"这类事实。',
    };
  }
  if (seatId === 'weiliu') {
    const d = await load();
    return {
      kind: 'memory',
      records: (d.runs || []).map((r) => ({
        at: atText(r.started_at),
        text: `${r.job} · ${r.status || '—'}${r.duration_s != null ? ` · 用时 ${r.duration_s}s` : ''}${r.error ? ` · ${String(r.error).slice(0, 60)}` : ''}`,
      })),
      memories: (d.incidents || []).map((i) => ({
        tag: i.state === 'resolved' ? '已闭环' : '未闭环',
        text: `${i.job_name}：${String(i.error || '').replace(/\s+/g, ' ').slice(0, 160)}`,
      })),
      note: d.incidents?.length ? '记忆库这一栏放的是它值守过、且已归档的异常与处置。' : '目前没有归档的异常。',
    };
  }
  const d = await load();
  const sites = await hermesApi('/local/harvester/sites', { timeout: 12000 });
  return {
    kind: 'memory',
    records: (d.items || []).map((h) => ({
      at: tsText(h.ts),
      text: `${h.host || h.url} · ${h.count ?? 0}/${h.total ?? 0} 条${h.elapsed_ms != null ? ` · ${h.elapsed_ms} ms` : ''}${h.ok ? '' : ` · 失败：${String(h.error || '').slice(0, 40)}`}`,
    })),
    memories: ((sites.memory?.entries) || []).map((t) => ({ tag: '采集经验', text: String(t) })),
    note: `站点笔记 ${sites.file || '—'} · 记忆库 ${sites.memory?.file || '—'}`,
  };
}

/**
 * 拾贝「即时交互」的历史抓取记录（原样给它，前端要按当时的卡片样子回放）。
 */
export const harvestHistory = (limit = 200) =>
  hermesApi(`/local/harvester/history?limit=${Number(limit) || 200}`, { timeout: 15000 });

/* ── 边界守望（尾流 · Edge Sentry）────────────────────────────────────
 * 上游把"被扫描"这件事拆成三层：frps 入口日志（谁连了哪个代理）、PVE haproxy
 * 的连接特征（真实源 IP / 时长 / 字节数）、两台对外主机的 secure 日志（用户名）。
 * 采集器每 5 分钟增量抓一次落 SQLite，这里读的是它算好的快照与申请单。
 *
 * **判定逻辑一条都不搬**：阈值、四维评分、跨档唤醒、白名单都是上游的事。
 * 这里只把给人看的那部分归并（severity 转中文、代理名对上、字段换 camelCase）——
 * 搬一套自己的规则过来，两边迟早会对同一个 IP 给出两个不同的结论。
 *
 * 封禁是**真的会在 frps 上执行 ipset add** 的动作，所以：
 *   · 读、写分成两条导出，只有点"批准"才走 securityDecide；
 *   · 授权码只接受单段短字符串（不接受路径、空白、换行），
 *     不给它变成"拼接任意路径去打那台内网机器"的机会；
 *   · 批准的超时给得比拒绝长：它要 ssh 过去执行并回读结果。
 */
export const officeSecurity = () => hermesApi('/local/security', { timeout: 20000 });

/**
 * 工位卡片上那一行摘要：待授权几条、边界告警几项。
 *
 * 单独一条轻量接口：卡片要回答的是"有没有事等着我"，不是整份守望快照
 * （那份有十几 KB，而卡片上只放得下两个数）。读不出来就当没有，不拖黑整页。
 */
export async function officeGuardBrief() {
  const d = await officeSecurity();
  const sn = d?.snapshot || {};
  const high =
    (sn.ips || []).filter((r) => r.severity === 'HIGH' || r.severity === 'CRITICAL').length +
    (sn.subnets || []).filter((s) => s.severity === 'HIGH' || s.severity === 'CRITICAL').length;
  return { pending: (d?.pending || []).length, high, ok: Boolean(d?.snapshot_ok) };
}

/**
 * 单个来源 IP 的画像。首次会顺带从两台主机采 SSH 用户名（`qm guest exec`），
 * 上游自己都说"可能要十几秒"，所以超时按它给的最坏情况留。
 */
export async function securityProfile(ip) {
  const target = String(ip || '').trim();
  /* 只放行 IP 字面量：这个值是拼进查询串再打到内网的 */
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(target)) throw new Error('IP 不合法');
  const d = await hermesApi(`/local/security/profile?ip=${encodeURIComponent(target)}`, { timeout: 45000 });
  return {
    ip: String(d?.ip || target),
    hours: Number(d?.hours) || 24,
    hits: Number(d?.hits) || 0,
    first: String(d?.first || ''),
    last: String(d?.last || ''),
    services: (d?.services || []).map((s) => ({
      name: String(s.name || s.proxy || '未知服务'),
      kind: String(s.kind || ''),
      target: String(s.target || ''),
      hits: Number(s.hits) || 0,
    })),
    /* 逐条连接：haproxy 那侧带字节数，超过 bytes_shell 就是"疑似进了 shell" */
    timeline: (d?.timeline || []).map((t) => ({
      ts: String(t.ts || '').slice(0, 19),
      name: String(t.name || ''),
      src: String(t.src || ''),
      bytes: Number(t.bytes) || 0,
      durMs: Number(t.dur_ms) || 0,
    })),
    dict: (d?.dict || []).map((x) => ({
      host: String(x.host || ''),
      users: Number(x.users) || 0,
      total: Number(x.total) || 0,
      capped: Boolean(x.capped),
      top: (x.top || []).slice(0, 4).map((u) => ({ user: String(u.user || ''), n: Number(u.n) || 0 })),
    })),
    blocks: (d?.blocks || []).map((b) => ({
      id: b.id,
      ip: String(b.ip || ''),
      reason: String(b.reason || ''),
      status: String(b.status || ''),
      requestedAt: String(b.requested_at || ''),
      expiresAt: String(b.expires_at || ''),
    })),
    subnet: d?.subnet ? String(d.subnet) : null,
    subnetPeers: (d?.subnet_peers || []).map(String),
    lifetime: d?.lifetime ? { total: Number(d.lifetime.total) || 0 } : null,
  };
}

/**
 * 批准 / 拒绝一条封禁申请。approve=true 会**真的封禁**（frps 上 ipset add）。
 * 授权码是上游生成的一次性票据（6 小时有效），这里只做形状校验，不解释内容。
 */
export function securityDecide(code, approve) {
  const ticket = String(code || '').trim();
  if (!ticket) throw new Error('缺少授权码');
  if (ticket.length > 64 || /[\s/\\]/.test(ticket)) throw new Error('授权码格式不对');
  return hermesApi(`/local/security/${approve ? 'approve' : 'reject'}`, {
    method: 'POST',
    body: { code: ticket },
    timeout: approve ? 30000 : 15000,
  });
}

const SEV_LABEL = { CRITICAL: '严重', HIGH: '高危', MED: '关注', LOW: '低' };
const BLOCK_LABEL = {
  executed: '已封禁',
  expired: '已到期解封',
  rejected: '已拒绝',
  failed: '执行失败',
  revoked: '已撤销',
  dry_run: '演练未执行',
  expired_ticket: '授权超时',
  pending: '待授权',
};
const SRC_LABEL = { frps: 'frps 入口', haproxy: 'haproxy 特征', 'pve-auth': 'PVE 宿主日志', users: 'SSH 用户名', web: 'Web 日志' };
const LEVEL_LABEL = { ok: '正常', stale: '停滞', retry: '重试中', down: '异常', off: '未启用' };

/** 快照里 `proxy` → 中文服务名的映射：ips[].services 也会补一份，两处都要吃 */
function proxyNames(sn) {
  const map = { ...(sn?.proxy_names || {}) };
  for (const r of sn?.ips || []) {
    for (const s of r.services || []) if (s.proxy && s.name) map[s.proxy] = s.name;
  }
  return map;
}

/**
 * 把 /local/security 归一化成前端能直接画的形状（字段名、中文标签、空值兜底都在这里）。
 * 前端不重复判断"这个 level 该显示什么" —— 那就是又一个会和上游分叉的口径。
 */
function normalizeSecurity(d) {
  const sn = d?.snapshot || {};
  const th = d?.thresholds || {};
  const nameOf = proxyNames(sn);

  const topIps = (sn.ips || []).map((r) => ({
    ip: String(r.ip || ''),
    hits: Number(r.hits) || 0,
    score: Number(r.score) || 0,
    severity: SEV_LABEL[r.severity] ? r.severity : 'LOW',
    severityLabel: SEV_LABEL[r.severity] || String(r.severity || '低'),
    /* 双源确认：同一个 IP 在 frps 与 haproxy 两边都出现过，比单源可信 */
    dual: (r.sources || []).length > 1,
    sources: (r.sources || []).map(String),
    maxBytes: Number(r.max_bytes) || 0,
    /* 认证失败恒定 1657~1813 字节；超过 4000 即疑似进了 shell —— 这条判据是上游定的 */
    shell: Boolean(r.shell),
    last: String(r.last || '').slice(0, 19),
    services: (r.services || []).map((s) => ({
      name: s.name || nameOf[s.proxy] || s.proxy || '未知服务',
      kind: s.kind || '',
      target: s.target || '',
      hits: Number(s.hits) || 0,
    })),
    anomalies: (r.anomaly || []).map((a) => ({ name: a.name || '', ratio: Number(a.ratio) || 0 })),
    slow: r.slow ? { days: Number(r.slow.days) || 0, total: Number(r.slow.total) || 0 } : null,
  }));

  /* 最坏档位只看 IP：同段协同在 subnets 里单独标（上游也是这么算的） */
  const level = topIps.some((r) => r.severity === 'CRITICAL')
    ? 'CRITICAL'
    : topIps.some((r) => r.severity === 'HIGH')
      ? 'HIGH'
      : topIps.length
        ? 'MED'
        : 'LOW';

  /* dict_overlap 可能是对象（旧）也可能是数组（新），两种都吃 */
  const overlapRaw = Array.isArray(sn.dict_overlap) ? sn.dict_overlap[0] : sn.dict_overlap;

  return {
    source:
      '上游 `/local/security`：frps 入口日志 + PVE haproxy 连接特征 + 两台对外主机的 secure 日志（全部只读，未改任何 frps / haproxy 配置）',
    generatedAt: String(d?.generated_at || ''),
    ok: Boolean(d?.snapshot_ok),
    error: String(d?.snapshot_error || ''),
    windowMin: Number(sn.window_min) || Number(th.window_min) || 10,

    /* 24 小时 */
    summary24h: {
      total: Number(d?.summary24h?.total) || 0,
      sources: Number(d?.summary24h?.sources) || 0,
      services: Number(d?.summary24h?.services) || 0,
    },
    hourly: (d?.hourly || []).map((x) => ({ h: String(x.h || ''), n: Number(x.n) || 0 })),
    topProxy: (d?.topProxy || []).map((x) => ({ name: x.name || nameOf[x.proxy] || x.proxy || '未知服务', n: Number(x.n) || 0 })),

    /* 当前窗口 */
    current: { level, levelLabel: SEV_LABEL[level], sources: Number(sn.sources) || 0, total: Number(sn.total) || 0 },
    baseline: {
      enabled: Boolean(sn.baseline?.enabled),
      services: Number(sn.baseline?.services) || 0,
      hours: Number(sn.baseline?.hours) || 0,
      minBuckets: Number(sn.baseline?.min_buckets) || 8,
    },
    health: (sn.health?.sources || []).map((x) => ({
      src: String(x.src || ''),
      label: SRC_LABEL[x.src] || String(x.src || ''),
      level: LEVEL_LABEL[x.level] ? x.level : 'off',
      levelLabel: LEVEL_LABEL[x.level] || '未启用',
      ok: x.ok === null ? null : Boolean(x.ok),
      fails: Number(x.fails) || 0,
      lastOk: x.last_ok || null,
      error: String(x.error || ''),
    })),
    degraded: sn.health?.degraded || [],
    blind: sn.health?.blind || [],

    topIps,
    subnets: (sn.subnets || []).map((s) => ({
      cidr: String(s.cidr || ''),
      ipCount: Number(s.ip_count) || 0,
      hits: Number(s.hits) || 0,
      severity: SEV_LABEL[s.severity] ? s.severity : 'LOW',
      severityLabel: SEV_LABEL[s.severity] || String(s.severity || '低'),
      members: (s.members || []).map(String),
    })),

    /* 暴露面：新入口 / 失联入口比扫描次数更值得看 */
    assets: (sn.assets || []).map((a) => ({
      name: a.name || nameOf[a.proxy] || a.proxy || '未知入口',
      kind: a.kind || '',
      target: a.target || '',
      hits: Number(a.hits) || 0,
      active: Boolean(a.active),
      registered: a.registered !== false,
      external: a.external !== false,
    })),

    /* SSH 字典是**主机级**的（sshd 侧只看到 haproxy 的地址，认不出单个来源在试什么） */
    dict: (sn.dict || []).map((x) => ({
      host: String(x.host || ''),
      users: Number(x.users) || 0,
      total: Number(x.total) || 0,
      capped: Boolean(x.capped),
      targeted: (x.targeted || []).map((u) => ({ user: String(u.user || ''), n: Number(u.n) || 0 })),
    })),
    dictOverlap: overlapRaw
      ? { a: String(overlapRaw.a || ''), b: String(overlapRaw.b || ''), shared: Number(overlapRaw.shared) || 0, cover: Number(overlapRaw.cover) || 0 }
      : null,

    /* 宿主机上真的登录成功过：判"有没有被打穿"最硬的证据 */
    authOk: (sn.auth_ok || []).map((a) => ({
      user: String(a.user || ''),
      fromIp: String(a.from_ip || ''),
      n: Number(a.n) || 0,
      weak: Boolean(a.weak),
      isNew: Boolean(a.new),
    })),

    pending: (d?.pending || []).map((p) => ({
      id: p.id,
      ip: String(p.ip || ''),
      ticket: String(p.ticket || ''),
      reason: String(p.reason || ''),
      requestedAt: String(p.requested_at || ''),
      expiresAt: String(p.expires_at || ''),
      requestedBy: String(p.requested_by || 'agent'),
    })),
    blocks: (d?.blocks || []).map((b) => ({
      id: b.id,
      ip: String(b.ip || ''),
      reason: String(b.reason || ''),
      status: String(b.status || ''),
      statusLabel: BLOCK_LABEL[b.status] || String(b.status || ''),
      requestedAt: String(b.requested_at || ''),
      expiresAt: String(b.expires_at || ''),
      approvedBy: String(b.approved_by || ''),
    })),

    /* 只留界面上会写的几个阈值：整份 thresholds 里还有冷却、日上限这类内部参数 */
    thresholds: {
      hitsMed: Number(th.hits_med) || 8,
      hitsHigh: Number(th.hits_high) || 20,
      hitsCrit: Number(th.hits_crit) || 60,
      subnetIps: Number(th.subnet_ips) || 5,
      bytesFail: Number(th.bytes_fail) || 2500,
      bytesShell: Number(th.bytes_shell) || 4000,
    },
  };
}

/**
 * 给拾贝下一条指令：先让网关上的模型把自然语言转成抓取计划，再交给本机采集器执行。
 *
 * 这与上游是同一条链路（`POST /local/harvester/plan` → `POST /local/scrape`）。
 * 上游还多一步 ai-extract（用户点名要哪些列时做结构化抽取），这里也接上 ——
 * 少了它，"列出名言和作者"这类指令就只能拿到裸文本。
 *
 * 注意这条链路是**真的会去抓网页**的，所以它只挂在 POST 上，且必须走面板自己的会话。
 */
export async function harvestRun(text) {
  const ask = String(text || '').trim();
  if (!ask) throw new Error('说点什么再发');
  const plan = await hermesApi('/local/harvester/plan', { method: 'POST', body: { text: ask }, timeout: 60000 });
  if (!plan?.ok || !plan.plan) throw new Error(plan?.reason || '模型没能把这句话解析成抓取计划');
  const p = plan.plan;
  if (p.action !== 'scrape') {
    /* chat / reject：模型认为这不是抓取指令，把它的话原样交回去 */
    return { kind: 'reply', reply: p.reply || '这句话里没有可执行的抓取目标。', plan: p, usage: { tokens: plan.tokens, elapsed_ms: plan.elapsed_ms, cached: plan.cached } };
  }
  const args = p.args || {};
  if (!args.url) throw new Error('解析出的计划里没有网址');
  const scraped = await hermesApi('/local/scrape', { method: 'POST', body: args, timeout: 120000 });
  return {
    kind: 'scrape',
    plan: p,
    usage: { tokens: plan.tokens, elapsed_ms: plan.elapsed_ms, cached: plan.cached },
    result: scraped,
  };
}

/** 消息体：非本体岗位要带上"问的是谁"，否则智能体不知道在跟谁说话 */
function chatBody(seatId, message) {
  const text = String(message || '').trim();
  const seat = EMPLOYEES.find((e) => e.id === seatId);
  if (!seat || seat.chat === 'agent') return { message: text };
  return {
    message: `【在工作台的「智能工位」里向「${seat.name}（${seat.en} · ${seat.role.split(' · ')[0]}）」提问】\n${text}`,
  };
}

/**
 * 对话（SSE）。把网关的帧翻成工作台自己的事件口径再交给调用方。
 *
 * 为什么在这里翻，而不是让前端认网关的帧名：
 * 前端已经有一套流式渲染（工作台助手 / 文章助手共用 {type:'delta'} 这套），
 * 让第三个调用方去认 `assistant.delta` / `run.completed` 这类网关私有帧名，
 * 等于把"上游长什么样"扩散到界面里；换个网关版本就得改前端。
 *
 * 网关的帧（实测）：
 *   assistant.delta     {delta}
 *   assistant.completed {content}
 *   tool.started/progress {tool_name}
 *   run.completed       {usage:{total_tokens,input_tokens,output_tokens}, runtime:{model}}
 *   error               {message|code}
 */
export async function chatStream(seatId, message, onEvent) {
  if (!hasHermesCredentials()) throw new Error('服务端没有配置 Hermes 口令，无法登录 Hermes');
  const text = String(message || '').trim();
  if (!text) throw new Error('说点什么再发');

  const id = await ensureChatSession();
  const res = await openHermesStream(`/hermes/api/sessions/${encodeURIComponent(id)}/chat/stream`, {
    method: 'POST',
    body: chatBody(seatId, text),
  });

  if (res.statusCode !== 200) {
    /* 出错时上游给的是普通 JSON 而不是流，读完再报，别把 JSON 当 SSE 解析 */
    let raw = '';
    res.setEncoding('utf8');
    await new Promise((resolve) => {
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', resolve);
      res.on('error', resolve);
    });
    let msg = `Hermes 返回 HTTP ${res.statusCode}`;
    try {
      const j = JSON.parse(raw);
      msg = j?.error?.message || j?.error || msg;
    } catch {
      if (raw.trim()) msg = raw.trim().slice(0, 200);
    }
    throw new Error(msg);
  }

  res.setEncoding('utf8');
  let buf = '';
  let seen = false;
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      buf += chunk;
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (!frame || frame.startsWith(':')) continue; /* 心跳注释帧 */
        let name = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let p;
        try {
          p = JSON.parse(data);
        } catch {
          continue; /* 坏帧丢掉，不打断整段回答 */
        }
        if (name === 'assistant.delta' && typeof p?.delta === 'string') {
          seen = true;
          onEvent({ type: 'delta', text: p.delta });
        } else if (name === 'assistant.completed' && typeof p?.content === 'string' && !seen) {
          /* 有些回答不给 delta，直接一次性给 content */
          seen = true;
          onEvent({ type: 'delta', text: p.content });
        } else if ((name === 'tool.started' || name === 'tool.progress') && p?.tool_name && p.tool_name !== '_thinking') {
          onEvent({ type: 'tool', name: String(p.tool_name) });
        } else if (name === 'run.completed') {
          onEvent({
            type: 'done',
            usage: p?.usage
              ? {
                  total: Number(p.usage.total_tokens) || 0,
                  input: Number(p.usage.input_tokens) || 0,
                  output: Number(p.usage.output_tokens) || 0,
                }
              : null,
            model: p?.runtime?.model ? String(p.runtime.model) : null,
          });
        } else if (name === 'error') {
          onEvent({ type: 'error', message: String(p?.message || p?.code || 'Hermes 执行失败') });
        }
      }
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
}
