import { db, update } from '../store.js';

/* ── DeepSeek 余额 ────────────────────────────────────────────────────
   桌宠盯着的那一个数：账号里还剩多少钱、还能不能再问几句。

   为什么放在服务端：
   API Key 只从环境变量读，浏览器侧永远拿不到它 —— 前端只拿一个已经
   归一化好的余额对象。

   接口是 DeepSeek 官方的 GET /user/balance（返回 is_available 与
   balance_infos[]）。注意它挂在**根路径**上，不在 /v1 下面 ——
   OpenAI 兼容那套前缀是我们填 base_url 时的习惯，余额不跟着走，
   所以下面会把结尾的 /v1 统一削掉。

   为什么要有按天快照：
   接口只给"此刻还剩多少"，它自己不会说"今天花掉多少"。而真正要看的
   就是后者 —— 余额是存量，消耗才是能拿来判断"该不该收着点"的数。
   所以每取到一次就往 data.petBalance 里记一笔当日读数，用
   「上一个有记录的日子的最后一个读数 − 今天最新的读数」算今日消耗。
   （与 ai-usage.js 同一套思路：日粒度的东西按天存，跨零点才不会错位。）

   停摆期间不补算：服务一整天没跑，那天就没有读数，跨过它直接跟再上
   一个有记录的日子比 —— 于是那一段的消耗会被并进"今日"，数字偏大。
   这一点没法从接口里补回来，所以报告里带上基准是哪一天（baselineDay），
   由界面决定要不要说明。 */

/** 官方入口。填 https://api.deepseek.com/v1 也认，结尾的 /v1 会被削掉 */
const DEFAULT_BASE = 'https://api.deepseek.com';

/** 余额变化很慢，一分钟一次足够；主要还是为了别把接口当探针打 */
const CACHE_TTL_MS = 60 * 1000;
/** 读失败后的重试间隔。比 TTL 长得多 —— Key 错、欠费这类事不会自己好，
 *  每分钟往一个注定失败的接口上撞一遍只是白烧日志 */
const RETRY_GAP_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** 快照只留最近这些天：再往前的没有参考价值，留着只是让落库的 JSON 一直长 */
const MAX_DAYS = 60;
/** 趋势给多少天 */
const HISTORY_DAYS = 14;

export const deepseekConfigured = () => Boolean(process.env.DEEPSEEK_API_KEY);

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** 本地时区的 YYYY-MM-DD。用 UTC 的话，晚上 8 点之后的读数会被记到第二天 */
function dayKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 余额接口挂在根路径上，所以要把 base_url 里可能带的 /v1 削掉 */
export function deepseekBase() {
  const raw = String(process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return raw.replace(/\/v1$/i, '') || DEFAULT_BASE;
}

/* ── 一次真实请求 ──────────────────────────────────────────────────── */

/** 把错误翻成人话：401 / 429 / 超时这三种最可能撞上，
 *  光给一个状态码，用户不知道该去改哪里。 */
async function request() {
  const res = await fetch(`${deepseekBase()}/user/balance`, {
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    if (/abort|timeout/i.test(String(err?.message || ''))) {
      throw new Error(`余额接口 ${TIMEOUT_MS / 1000} 秒内没有响应`);
    }
    /* 连不上的原始报错只有一句 "fetch failed"（真正的原因埋在 cause 里）。
       而这条路上最可能发生的事就是 base_url 填错 —— 代理地址写成了内网域名、
       或者少写了端口。把地址和 errno 一起给出来，用户才知道去哪儿改。
       注意要往下再挖一层：一个域名解析出多个地址时，undici 抛的是
       AggregateError，code 挂在 cause.errors[0] 上而不是 cause 上。 */
    const code = err?.cause?.errors?.[0]?.code || err?.cause?.code || err?.code || err?.message || err;
    throw new Error(`连不上余额接口（${deepseekBase()}）：${code}`);
  });

  if (res.status === 401) throw new Error('API Key 被拒绝（401）：检查 .env 里的 DEEPSEEK_API_KEY');
  if (res.status === 429) throw new Error('余额接口限流（429），稍后再试');
  if (!res.ok) throw new Error(`余额接口返回 HTTP ${res.status}`);

  const json = await res.json().catch(() => null);
  const list = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
  if (!list.length) throw new Error('余额接口没有返回任何账户');

  /* 三个余额字段接口给的是**字符串**（如 "110.00"），一律转成数字，
     免得下游到处出现 "110.00" + 0 这种把字符串拼接起来的写法 */
  const accounts = list.map((b) => ({
    currency: String(b?.currency || '').toUpperCase() || 'CNY',
    total: num(b?.total_balance),
    granted: num(b?.granted_balance),
    toppedUp: num(b?.topped_up_balance),
  }));

  /* 优先 CNY：账号一般同时挂着美元账户，而"还剩多少钱"要回答的是
     人民币那个。只在没有 CNY 时才退回第一个。 */
  const picked = accounts.find((a) => a.currency === 'CNY') ?? accounts[0];

  return { isAvailable: Boolean(json?.is_available), accounts, ...picked };
}

/* ── 快照落库 ──────────────────────────────────────────────────────── */

/** 记一笔当日读数。同一天反复取只更新 last，first 保持不动 */
function remember(reading) {
  update((data) => {
    /* 老库、导入的旧备份里没有这个字段，第一次写时才建起来。
       与 ai-usage 一样逐层兜底 —— 这是历史记录，任何一次"重置成零"
       都等于把攒下来的趋势抹了。 */
    const b = data.petBalance && typeof data.petBalance === 'object' ? data.petBalance : (data.petBalance = {});
    b.days = b.days && typeof b.days === 'object' ? b.days : {};

    const day = dayKey();
    const prev = b.days[day];
    b.days[day] = {
      currency: reading.currency,
      // first 留着：将来要回答"今天是从多少开始的"不必再加一次改造
      first: prev && Number.isFinite(prev.first) ? prev.first : reading.total,
      last: reading.total,
      at: new Date().toISOString(),
    };
    /* 落库要靠它判断"这份数据变了"（指纹里带时间），没有它就得每轮都写一遍 */
    b.updatedAt = new Date().toISOString();

    const keys = Object.keys(b.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete b.days[k];
  });
}

function daysOf() {
  const b = db()?.petBalance;
  return b && typeof b === 'object' && b.days && typeof b.days === 'object' ? b.days : {};
}

/**
 * 今日消耗 = 上一个有记录的日子（通常就是昨天）的最后一个读数 − 今天最新的读数。
 *
 * 只认**同币种**的日子：中途从美元账户切到人民币账户的话，两个数相减
 * 得到的是一个毫无意义的差额，不如不给。
 */
function spendSince(days, today, currency) {
  const todayRow = days[today];
  /* 今天还没有读数就直接说"不知道"。
     这个分支**不是防御性编程，是真实存在的窗口**：跨零点后的第一分钟里，
     昨天那笔还在、今天那笔要等下一轮取数才写进来；而 memo 里还压着
     "不到 60 秒"的上一次读数，于是这一次调用不会再取数 —— 不挡的话
     这里会读到 undefined，接口直接 500。 */
  if (!todayRow || !Number.isFinite(todayRow.last)) return null;

  const earlier = Object.keys(days)
    .filter((k) => k < today)
    .sort()
    .reverse();

  for (const day of earlier) {
    const v = days[day];
    if (!v || v.currency !== currency || !Number.isFinite(v.last)) continue;
    const amount = v.last - todayRow.last;
    /* 充值会让差值为负 —— 那不是"消耗了负数"，是这一天充过钱，
       界面该说的是"今天没消耗"而不是挂一个负号出来 */
    if (!(amount > 0)) return { amount: 0, baselineDay: day, toppedUp: true };
    return { amount, baselineDay: day, toppedUp: false };
  }
  return null;
}

/** 最近 HISTORY_DAYS 天的读数（同币种、按日期升序），直接可以拿去画柱子 */
function historyOf(days, currency) {
  return Object.keys(days)
    .sort()
    .filter((k) => days[k]?.currency === currency && Number.isFinite(days[k]?.last))
    .slice(-HISTORY_DAYS)
    .map((day) => ({ day, total: days[day].last }));
}

/* ── 缓存（口径与 office.js 的用量摘要一致）─────────────────────────── */

let memo = { val: null, at: 0, triedAt: 0, inflight: null, error: null };

function refresh() {
  memo.triedAt = Date.now();
  memo.inflight = request()
    .then((reading) => {
      remember(reading);
      memo = { ...memo, val: reading, at: Date.now(), inflight: null, error: null };
    })
    .catch((err) => {
      /* 保留上一次的值，只挂上原因：界面据此说明"这个数是旧的"；
         at 推到当下，免得每一轮轮询都往一个不通的接口再撞一次 */
      memo = { ...memo, at: Date.now(), inflight: null, error: err.message };
    });
  return memo.inflight;
}

/**
 * 给接口用的余额报告。
 *
 * 字段**恒定齐全**（没配 Key、读失败时那一组就是 null），前端因此不用去猜
 * "这次到底有没有这个字段" —— 只在 configured 上分一次叉就够了。
 *
 * 第一次调用时手上什么都没有 —— 这时候要等一小下（最多 3 秒），否则
 * 桌宠头顶会先冒一句"读取中"，几百毫秒后再跳成真数字，看着像闪了一下。
 * 之后有值就直接给（过期了在后台刷，调用方不等）。
 */
export async function balanceReport() {
  const envelope = {
    configured: deepseekConfigured(),
    ok: false,
    error: null,
    at: new Date().toISOString(),
    isAvailable: null,
    currency: null,
    total: null,
    granted: null,
    toppedUp: null,
    accounts: [],
    today: null,
    spend: null,
    history: [],
  };

  if (!envelope.configured) return envelope;

  const now = Date.now();
  const stamp = memo.val ? memo.at : memo.triedAt;
  const gap = memo.val ? CACHE_TTL_MS : RETRY_GAP_MS;
  if (now - stamp >= gap && !memo.inflight) refresh();

  if (!memo.val) {
    await Promise.race([memo.inflight ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))]);
    if (!memo.val) return { ...envelope, error: memo.error || '余额还没读回来' };
  }

  const reading = memo.val;
  const days = daysOf();
  const today = dayKey();

  return {
    ...envelope,
    ok: !memo.error,
    /* 有值时带上错误：说明这份是旧的，界面要如实标注而不是假装新鲜 */
    error: memo.error,
    at: new Date(memo.at).toISOString(),
    isAvailable: reading.isAvailable,
    currency: reading.currency,
    total: reading.total,
    granted: reading.granted,
    toppedUp: reading.toppedUp,
    accounts: reading.accounts,
    today: days[today] ?? null,
    spend: spendSince(days, today, reading.currency),
    history: historyOf(days, reading.currency),
  };
}
