import { useCallback, useEffect, useState } from 'react';
import { api, type PetBalance } from './api';

/* ── 看板娘（桌宠）的本地状态 ──────────────────────────────────────────
   名字叫「鲸娘」：DeepSeek 的吉祥物是一条鲸鱼，这里画的是它的人形版本。

   为什么整套养成数据放 localStorage，而不是跟任务、设置一样进 MySQL：

   · **它是"这台浏览器上的这只鲸娘"的事** —— 停靠在哪、心情多少、
     今天跟你说了几句话。换一台设备时位置本来就该重算，把旧坐标拖过去
     只会让它出现在一个不存在的角落里；
   · **它不该跟着备份走**。备份的语义是"把知识库和工具箱搬回去"，
     不是"把桌宠的心情恢复到上周三"。混进去之后，恢复一次备份会静默
     改掉一个跟数据无关的东西，这比丢几个心情值难解释得多；
   · 也正因为如此，这里没有任何需要保护的凭据 —— 唯一的凭据
     （DeepSeek 的 API Key）只存在服务端 .env 里，浏览器侧拿不到。

   唯一进库的是余额快照，那份在服务端（services/deepseek.js）。

   与参考项目一致的取舍：**偏好默认开、会读内容/金额的功能默认开但可关**，
   且没有任何遥测与外部请求 —— 余额那一条也是打自己的后端。 */

export const PET_KEY = 'pet:state';

export type PetDiaryEntry = { at: string; text: string };

export type PetState = {
  v: 1;
  /* ── 偏好 ── */
  /** 看板娘开关。关掉之后右下角留一颗鲸鱼按钮唤回 */
  enabled: boolean;
  /** 台词气泡。关掉只是不冒话，摸头之类的反应还在 */
  bubble: boolean;
  /** 主动闲聊（5–8 分钟一次） */
  chatter: boolean;
  /** 点击特效（爱心 / 星星） */
  particles: boolean;
  /** 深夜静音：23:00–6:00 不主动搭话 */
  quiet: boolean;
  /** 余额关心：按时轮询余额，低了主动提醒 */
  watchBalance: boolean;
  /** 余额显示数字。关掉只显示档位措辞，截图不泄露金额 */
  showNumber: boolean;
  /** 低余额阈值（元）。低于它就要提醒 */
  lowThreshold: number;
  /** 它该怎么称呼你 */
  nickname: string;

  /* ── 养成 ── */
  mood: number;
  affection: number;
  /** 点心库存（投喂用） */
  food: number;
  streak: number;
  lastCheckIn: string;
  /** 累计摸头次数 */
  pats: number;
  /** 首次见面的时间 */
  since: string;
  /** todayPats 属于哪一天，跨零点要归零 */
  day: string;
  todayPats: number;
  /** 低余额提醒当天只弹一次 */
  lowWarnedDay: string;
  /** "照这个用量撑不过一周"当天只提醒一次 */
  burnWarnedDay: string;
  /**
   * 上一次因为读不到余额而开口的时间（ISO）。
   * 用时间戳而不是"当天一次"：读失败往往连着发生很多次（Key 撤了、代理挂了），
   * 按天记的话一到零点又会念一遍，而这件事其实是持续状态；
   * 冷却 6 小时，一天最多说四次。
   */
  balanceErrorAt: string;
  diary: PetDiaryEntry[];
  /** 相对右下角的偏移（px）。null = 还没拖过，用默认位置 */
  pos: { x: number; y: number } | null;
};

export const defaultPetState = (): PetState => ({
  v: 1,
  enabled: true,
  bubble: true,
  chatter: true,
  particles: true,
  quiet: true,
  watchBalance: true,
  showNumber: true,
  lowThreshold: 10,
  nickname: '',
  mood: 72,
  affection: 0,
  food: 3,
  streak: 0,
  lastCheckIn: '',
  pats: 0,
  since: new Date().toISOString(),
  day: todayKey(),
  todayPats: 0,
  lowWarnedDay: '',
  burnWarnedDay: '',
  balanceErrorAt: '',
  diary: [],
  pos: null,
});

/** 本地时区的 YYYY-MM-DD。用 UTC 的话，晚上 8 点之后的互动会被记到第二天 */
export function todayKey(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/**
 * 读一次。**逐字段兜底而不是整份退回默认** ——
 * 一个字段坏掉就把攒了几个月的签到和好感度抹平，代价太大。
 */
export function loadPetState(): PetState {
  const base = defaultPetState();
  let raw: unknown = null;
  try {
    raw = JSON.parse(window.localStorage.getItem(PET_KEY) || 'null');
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object') return base;

  const stored = raw as Partial<PetState>;
  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

  return {
    v: 1,
    enabled: bool(stored.enabled, base.enabled),
    bubble: bool(stored.bubble, base.bubble),
    chatter: bool(stored.chatter, base.chatter),
    particles: bool(stored.particles, base.particles),
    quiet: bool(stored.quiet, base.quiet),
    watchBalance: bool(stored.watchBalance, base.watchBalance),
    showNumber: bool(stored.showNumber, base.showNumber),
    lowThreshold: Math.max(0, num(stored.lowThreshold, base.lowThreshold)),
    nickname: typeof stored.nickname === 'string' ? stored.nickname.slice(0, 16) : base.nickname,
    mood: clamp(num(stored.mood, base.mood), 0, 100),
    affection: Math.max(0, Math.round(num(stored.affection, base.affection))),
    food: Math.max(0, Math.round(num(stored.food, base.food))),
    streak: Math.max(0, Math.round(num(stored.streak, base.streak))),
    lastCheckIn: typeof stored.lastCheckIn === 'string' ? stored.lastCheckIn : base.lastCheckIn,
    pats: Math.max(0, Math.round(num(stored.pats, base.pats))),
    since: typeof stored.since === 'string' ? stored.since : base.since,
    day: typeof stored.day === 'string' ? stored.day : base.day,
    todayPats: Math.max(0, Math.round(num(stored.todayPats, base.todayPats))),
    lowWarnedDay: typeof stored.lowWarnedDay === 'string' ? stored.lowWarnedDay : base.lowWarnedDay,
    burnWarnedDay: typeof stored.burnWarnedDay === 'string' ? stored.burnWarnedDay : base.burnWarnedDay,
    balanceErrorAt: typeof stored.balanceErrorAt === 'string' ? stored.balanceErrorAt : base.balanceErrorAt,
    diary: Array.isArray(stored.diary)
      ? stored.diary
          .filter((e): e is PetDiaryEntry => Boolean(e) && typeof (e as PetDiaryEntry).text === 'string')
          .slice(0, 12)
      : base.diary,
    pos:
      stored.pos && Number.isFinite(Number(stored.pos.x)) && Number.isFinite(Number(stored.pos.y))
        ? { x: Number(stored.pos.x), y: Number(stored.pos.y) }
        : null,
  };
}

export function savePetState(state: PetState): void {
  try {
    window.localStorage.setItem(PET_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式 / 配额满了：这一次不记就是了，不该把交互打断 */
  }
}

export function clearPetState(): void {
  try {
    window.localStorage.removeItem(PET_KEY);
  } catch {
    /* 同上 */
  }
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/* ── 羁绊等级 ──────────────────────────────────────────────────────── */

/** need = 到这一级需要的累计好感度。称号在升级那一下会进成长日记 */
export type PetLevel = { level: number; need: number; title: string };

export const LEVELS: readonly PetLevel[] = [
  { level: 1, need: 0, title: '刚认识的鲸鱼' },
  { level: 2, need: 15, title: '会打招呼的搭档' },
  { level: 3, need: 40, title: '熟络的鲸娘' },
  { level: 4, need: 80, title: '并肩值的夜班' },
  { level: 5, need: 140, title: '鲸汐守护者' },
  { level: 6, need: 210, title: '深海同频' },
  { level: 7, need: 300, title: '不离不弃的羁绊' },
];

export function levelOf(affection: number): PetLevel {
  let found = LEVELS[0];
  for (const l of LEVELS) {
    if (affection >= l.need) found = l;
  }
  return found;
}

/** 距离下一级还差多少好感度；满级返回 null */
export function nextLevel(affection: number): { need: number; left: number } | null {
  const next = LEVELS.find((l) => l.need > affection);
  return next ? { need: next.need, left: next.need - affection } : null;
}

/* ── 余额档位 ──────────────────────────────────────────────────────── */

export type BalanceTier = 'unknown' | 'empty' | 'low' | 'fair' | 'good';

/**
 * 档位由阈值推出来，而不是写死几个金额：
 * 阈值是用户自己定的"该充钱了"那条线，档位必须跟着它走 ——
 * 写死的话（比如 5 元以下算低），把阈值调到 50 之后措辞就跟提醒对不上了。
 *
 * 关掉「余额显示数字」时界面上只有这个档位的措辞，所以它既要能一眼看出
 * 严重程度，也不能靠色相单独表意（colorless 也要读得懂）。
 */
export function balanceTier(balance: PetBalance | null, threshold: number): BalanceTier {
  if (!balance || !balance.configured || !balance.ok || balance.total === null) return 'unknown';
  const total = balance.total;
  const line = threshold > 0 ? threshold : 10;
  if (total <= 0) return 'empty';
  if (total <= line) return 'low';
  if (total <= line * 3) return 'fair';
  return 'good';
}

export const TIER_LABEL: Record<BalanceTier, string> = {
  unknown: '待读取',
  empty: '已用尽',
  low: '快见底',
  fair: '还够用',
  good: '很充裕',
};

/** 档位 → 语气色（走全站那几个语义色，不新造颜色） */
export const TIER_TONE: Record<BalanceTier, 'ok' | 'warn' | 'crit' | 'neutral'> = {
  unknown: 'neutral',
  empty: 'crit',
  low: 'crit',
  fair: 'warn',
  good: 'ok',
};

const CURRENCY_SIGN: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥' };

/** 金额。小数固定两位 —— 余额那个数只有两位是有意义的，多给是假精度 */
export function fmtMoney(value: number | null, currency: string | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = CURRENCY_SIGN[String(currency || 'CNY').toUpperCase()] ?? `${currency || ''} `;
  return `${sign}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * 照今天的消耗推算还能用几天。
 *
 * 为什么这个数值得算：余额是**存量**，光看"还剩 18 块"没法判断要不要充值 ——
 * 剩 18 块、一天花 2 块，能用一周；剩 180 块、一天花 90，三天就没了。
 * 真正能拿来做决定的是"还能撑多久"。
 *
 * 数据不足（没读到、今天没消耗、余额未知）时返回 null ——
 * 这时候不该编一个数，静默就是正确答案。
 */
export function runwayDays(balance: PetBalance | null): number | null {
  if (!balance?.ok || balance.total === null || !balance.spend) return null;
  const spend = balance.spend.amount;
  if (!(spend > 0)) return null;
  return balance.total / spend;
}

/** 面板里那行小字。低于一周才算"值得说"，否则不给数字免得天天一惊一乍 */
export function runwayText(balance: PetBalance | null): string | null {
  const days = runwayDays(balance);
  if (days === null) return null;
  if (days >= 7) return null;
  const n = Math.floor(days);
  return n < 1 ? '照今天的用量，今天就见底' : `照今天的用量，还能用 ${n} 天`;
}

/**
 * 余额面板里那句"今天花了多少"。
 *
 * 没有可比的一天时如实说，不摆一个 0 冒充结论；关掉「显示余额数字」时
 * **连这句话里的金额也要藏掉** —— 只把上面那个大数字藏起来是假的，
 * 消耗量同样是钱。
 */
export function spendText(balance: PetBalance | null, showNumber = true): string {
  if (!balance || !balance.ok) return '今天还没读到可比的数据';
  if (!balance.spend) return '今天是第一笔记录，明天才有消耗值';
  if (balance.spend.toppedUp) return '今天充过钱，所以没有消耗数';
  if (balance.spend.amount <= 0) return '今天还没花钱';
  return showNumber ? `今天花了 ${fmtMoney(balance.spend.amount, balance.currency)}` : '今天有消耗（金额已隐藏）';
}

/* ── React 侧的挂载 ────────────────────────────────────────────────── */

/**
 * 养成状态 + 落盘。
 *
 * patch 收一个函数（而不是一个对象）：多处交互会在同一帧改同一个数
 * （摸头同时加心情和好感度），传对象的话后一次会把前一次整个盖掉。
 */
export function usePetState() {
  const [state, setState] = useState<PetState>(() => loadPetState());

  const patch = useCallback((mutate: (prev: PetState) => PetState) => {
    setState((prev) => {
      const next = mutate(prev);
      savePetState(next);
      return next;
    });
  }, []);

  /* 跨零点时把"今天摸了几次"归零。挂在状态上而不是定时器里：
     空闲标签页的定时器会被浏览器掐到分钟级，而归零这件事晚几秒无所谓。 */
  useEffect(() => {
    const day = todayKey();
    if (state.day === day) return;
    patch((prev) => ({ ...prev, day, todayPats: 0 }));
  }, [state.day, patch]);

  const reset = useCallback(() => {
    clearPetState();
    setState(defaultPetState());
  }, []);

  return { state, patch, reset };
}

/**
 * 余额轮询。
 *
 * 间隔比 token 用量（30 秒）松得多：余额是"钱"，变化只发生在你真的花了钱，
 * 而服务端本身还有 60 秒缓存 —— 打得太密只是自己空转。
 * 但**切回窗口时会立刻对一次**：刚问完模型回到页面，看到旧数会以为没扣钱。
 */
export function usePetBalance(enabled: boolean, intervalMs = 5 * 60 * 1000) {
  const [balance, setBalance] = useState<PetBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.pet.balance();
      setBalance(next);
      setError(next.configured && !next.ok ? next.error : null);
    } catch (err) {
      /* 拿不到就先不显示：这是附加信息，不该为它弹错误或打断页面 */
      setError(err instanceof Error ? err.message : '余额读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      void load();
    };
    run();
    const timer = window.setInterval(run, intervalMs);
    const onVisible = () => {
      if (!document.hidden) run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, load]);

  return { balance, loading, error, refresh: load };
}

/** 成长日记：倒序、最多 12 条。与参考项目同一个上限，够看又不至于把面板顶高 */
export function pushDiary(diary: PetDiaryEntry[], text: string): PetDiaryEntry[] {
  return [{ at: new Date().toISOString(), text }, ...diary].slice(0, 12);
}
