import { useCallback, useEffect, useState } from 'react';
import { api, type PetBalance } from './api';

/* ── 看板娘（桌宠）的本地状态 ──────────────────────────────────────────
   名字叫「思儿」：原型是 DeepSeek 的吉祥物鲸鱼，这里画的是它的人形版本。

   为什么整套养成数据放 localStorage，而不是跟任务、设置一样进 MySQL：

   · **它是"这台浏览器上的这只思儿"的事** —— 停靠在哪、睡没睡、
     今天跟你说了几句话。换一台设备时位置本来就该重算，把旧坐标拖过去
     只会让它出现在一个不存在的角落里；
   · **它不该跟着备份走**。备份的语义是"把知识库和工具箱搬回去"，
     不是"把桌宠住哪儿改回上周三"。混进去之后，恢复一次备份会静默
     改掉一个跟数据无关的东西，这比丢几条闲聊难解释得多；
   · 也正因为如此，这里没有任何需要保护的凭据 —— 唯一的凭据
     （DeepSeek 的 API Key）只存在服务端 .env 里，浏览器侧拿不到。

   唯一进库的是余额快照，那份在服务端（services/deepseek.js）。

   与参考项目一致的取舍：**偏好默认开、会读内容/金额的功能默认开但可关**，
   且没有任何遥测与外部请求 —— 余额那一条也是打自己的后端。 */

export const PET_KEY = 'pet:state';

export type PetDiaryEntry = { at: string; text: string };

/**
 * 一条对话。只存角色、正文与时间，不存思考过程与动作指令。
 *
 * `at` 是给聊天窗画时间分隔用的（"今天 14:20" / "11月3日"）。老存档里没有这个
 * 字段，读回来时补空串 —— 界面会把这些归到「更早」，而不是假装是今天说的。
 */
export type PetChatEntry = { role: 'user' | 'assistant'; text: string; at: string };

/** 聊天记录留多少条。一条百来字节，200 条约 40KB，localStorage 放得下 */
export const CHAT_KEEP = 200;

/** 追加一条并裁到上限。问与答两处都走它，裁剪口径就不会写岔 */
export function pushChat(chat: PetChatEntry[], entry: PetChatEntry): PetChatEntry[] {
  return [...chat, entry].slice(-CHAT_KEEP);
}

/** 情绪：安静是底，其余会自己散掉 */
export type PetMood = 'calm' | 'happy' | 'shy' | 'sulk';
/** 关系阶段：刚认识 / 熟络 / 黏人 */
export type PetStage = 0 | 1 | 2;

/**
 * 阈值与称号。
 *
 * 刻意**不做等级数字**：她不会在你生日那天突然 Lv+1，也不会因为你三天没来掉级。
 * 阶段只用来解锁台词和"她敢不敢主动要陪伴"—— 是关系的温度，不是成就列表。
 */
export const BOND_STAGES = [
  { at: 0, stage: 0 as PetStage, title: '刚认识', hint: '她还在偷偷看你' },
  { at: 24, stage: 1 as PetStage, title: '熟络', hint: '会主动讲她的一天' },
  { at: 60, stage: 2 as PetStage, title: '黏人', hint: '会直说要你陪' },
] as const;

/** 亲密度落在哪一档 */
export function stageOf(bond: number): PetStage {
  if (bond >= 60) return 2;
  if (bond >= 24) return 1;
  return 0;
}

export function stageInfo(stage: PetStage) {
  return BOND_STAGES[stage] ?? BOND_STAGES[0];
}

/** 情绪自己散掉的时间。闹别扭比开心长一点，像小孩记一会儿仇 */
export const MOOD_TTL_MS: Record<Exclude<PetMood, 'calm'>, number> = {
  happy: 4 * 60 * 1000,
  shy: 3 * 60 * 1000,
  sulk: 6 * 60 * 1000,
};

export const MOOD_LABEL: Record<PetMood, string> = {
  calm: '安静',
  happy: '开心',
  shy: '害羞',
  sulk: '闹别扭',
};

/** 把过期的情绪折回 calm —— 只算不写，状态本身留到下一次 patch */
export function moodNow(state: Pick<PetState, 'mood' | 'moodAt'>, at = Date.now()): PetMood {
  if (state.mood === 'calm') return 'calm';
  const since = Date.parse(state.moodAt) || 0;
  return at - since < (MOOD_TTL_MS[state.mood] ?? 0) ? state.mood : 'calm';
}

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
  /** 它该怎么称呼你 */
  nickname: string;
  /**
   * 形象：`clip` = 24 段透明动画（动态桌宠），`pose` = 24 张静态立绘。
   *
   * 默认动效；Safari 不认 VP9-alpha（会渲染成黑底），那种情况下
   * 组件层会自动退回立绘，这里的值只表达"用户的偏好"，不是"实际用的"。
   */
  art: 'clip' | 'pose';
  /**
   * 自由活动：待机时自己玩一会儿（写代码 / 撸猫 / 玩魔方 / 偷吃零食…）。
   * 只在动效模式有意义 —— 立绘是一张静态图，没有"自己在干嘛"这回事。
   */
  roam: boolean;
  /** 换动作的间隔档位（放完一段后再等多久）。安静 30~60s / 正常 7~18s / 活跃 3~7s */
  roamGap: 'quiet' | 'normal' | 'lively';
  /**
   * 参与随机的小动作 id 列表（见 `assets/pet/extra/` 的文件名）。
   *
   * **空数组 = 全部参与**，也是默认值。用空数组而不是"把 78 个 key 都存一遍"，
   * 是为了以后新增素材时不用去改每个人的存档 —— 默认值天然覆盖新动作。
   * 面板上点满之后也会落回空数组（见 Pet.tsx 的 chips）。
   */
  roamPool: string[];
  /**
   * 池子存档的迁移标记。
   *
   * 旧版本把 `roamPool` 读回来时截断到 40 条，一次普通的 patch 就把"半份名单"
   * 落了盘 —— 面板上看着就是只勾了一半。带上这个标记之后，旧存档里的池子
   * 一次性作废、回到"全部参与"（默认全选），之后用户的选择才会照常保存。
   */
  poolV: 2;

  /* ── 她的事（不是你的工作） ── */
  /**
   * 亲密度 0–100。**隐藏值**：界面上不显示数字、没有进度条，
   * 只决定她解锁到哪一档（台词、主动程度）。攒得慢。
   */
  bond: number;
  /** 已经解锁的关系阶段（0 刚认识 / 1 熟络 / 2 黏人），跨过阈值才更新 */
  stage: PetStage;
  /** 当前情绪。会随时间自己回到 calm */
  mood: PetMood;
  /** 情绪是什么时候开始的（ISO），用来算过期 */
  moodAt: string;
  /** 最近一次被摸/投喂/夸/聊天的时间 —— "想被关注"按它算 */
  lastTouchAt: string;
  /** 最近一次陪她玩（点播动作）的时间 */
  lastPlayAt: string;
  /** 上一次主动要关注/要玩的时间，避免反复索取 */
  lastNeedAt: string;
  /** 首次见面的时间。只用来算"一起过的第几天"，不是养成数值 */
  since: string;
  /** 相处记录最后写到哪一天：每天最多记一条，避免反复刷新刷出一堆 */
  diaryDay: string;
  /**
   * 相处记录。**只记事，不给奖励** ——
   * 没有签到、等级、经验条，也没有"陪够三天送点心"那种兑换。
   * 亲密度只藏在后台用来解锁台词，不显示数字，也不拿来索要陪伴。
   */
  diary: PetDiaryEntry[];
  /** 相对右下角的偏移（px）。null = 还没拖过，用默认位置 */
  pos: { x: number; y: number } | null;

  /**
   * 睡着了：完全安静 —— 不轮换小动作、不闲聊、不说梦话以外的任何话。
   * 点她一下或右键「叫醒」起来。
   */
  asleep: boolean;
  /** 和她的对话记录。带时间、留 200 条，用于聊天窗回看、翻历史与上下文 */
  chat: PetChatEntry[];
};

export const defaultPetState = (): PetState => ({
  v: 1,
  enabled: true,
  bubble: true,
  chatter: true,
  particles: true,
  quiet: true,
  nickname: '',
  art: 'clip',
  roam: true,
  roamGap: 'normal',
  roamPool: [],
  poolV: 2,
  bond: 0,
  stage: 0,
  mood: 'calm',
  moodAt: '',
  lastTouchAt: new Date().toISOString(),
  lastPlayAt: new Date().toISOString(),
  lastNeedAt: '',
  since: new Date().toISOString(),
  diaryDay: '',
  diary: [],
  pos: null,
  asleep: false,
  chat: [],
});

/** 本地时区的 YYYY-MM-DD。用 UTC 的话，晚上 8 点之后的互动会被记到第二天 */
export function todayKey(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/**
 * 读一次。**逐字段兜底而不是整份退回默认** ——
 * 一个字段坏掉就把攒了几个月的相处记录和对话抹平，代价太大。
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
    nickname: typeof stored.nickname === 'string' ? stored.nickname.slice(0, 16) : base.nickname,
    art: stored.art === 'pose' || stored.art === 'clip' ? stored.art : base.art,
    roam: bool(stored.roam, base.roam),
    roamGap:
      stored.roamGap === 'quiet' || stored.roamGap === 'lively' || stored.roamGap === 'normal'
        ? stored.roamGap
        : base.roamGap,
    /* 旧存档（没有 poolV）里那份池子可能是被截断过的半份名单，直接作废、
       回到"全部参与"；新存档才按用户勾选读。上限 200 只是挡住被写坏的数据 */
    roamPool:
      stored.poolV === 2 && Array.isArray(stored.roamPool)
        ? [...new Set(stored.roamPool.filter((x): x is string => typeof x === 'string'))].slice(0, 200)
        : base.roamPool,
    poolV: 2,
    bond: Math.min(100, Math.max(0, Math.round(num(stored.bond, base.bond)))),
    stage: Math.min(2, Math.max(0, Math.round(num(stored.stage, base.stage)))) as PetStage,
    mood: (['calm', 'happy', 'shy', 'sulk'] as const).includes(stored.mood as PetMood)
      ? (stored.mood as PetMood)
      : base.mood,
    moodAt: typeof stored.moodAt === 'string' ? stored.moodAt : base.moodAt,
    lastTouchAt: typeof stored.lastTouchAt === 'string' ? stored.lastTouchAt : base.lastTouchAt,
    lastPlayAt: typeof stored.lastPlayAt === 'string' ? stored.lastPlayAt : base.lastPlayAt,
    lastNeedAt: typeof stored.lastNeedAt === 'string' ? stored.lastNeedAt : base.lastNeedAt,
    since: typeof stored.since === 'string' ? stored.since : base.since,
    diaryDay: typeof stored.diaryDay === 'string' ? stored.diaryDay : base.diaryDay,
    diary: Array.isArray(stored.diary)
      ? stored.diary
          .filter((e): e is PetDiaryEntry => Boolean(e) && typeof (e as PetDiaryEntry).text === 'string')
          .slice(0, 12)
      : base.diary,
    pos:
      stored.pos && Number.isFinite(Number(stored.pos.x)) && Number.isFinite(Number(stored.pos.y))
        ? { x: Number(stored.pos.x), y: Number(stored.pos.y) }
        : null,
    asleep: bool(stored.asleep, base.asleep),
    /* 老存档只剩 20 条、也没有 at：照样读进来，缺时间的归到「更早」那一段。
       单条正文也截一下 —— 被写坏的存档不该把整份设置顶爆 */
    chat: Array.isArray(stored.chat)
      ? stored.chat
          .filter(
            (e): e is PetChatEntry =>
              Boolean(e) &&
              typeof (e as PetChatEntry).text === 'string' &&
              ((e as PetChatEntry).role === 'user' || (e as PetChatEntry).role === 'assistant'),
          )
          .map((e) => ({
            role: e.role,
            text: e.text.slice(0, 2000),
            at: typeof e.at === 'string' ? e.at : '',
          }))
          .slice(-CHAT_KEEP)
      : base.chat,
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

/* ── 余额读数（顶栏用量浮层用；桌宠本身已经不看余额了） ─────────────── */

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
 * 余额浮层里那句"今天花了多少"。
 *
 * 没有可比的一天时如实说，不摆一个 0 冒充结论 —— "今天是第一笔记录"和
 * "今天还没花钱"是两件事，混成一句就会让人以为账户一直没动。
 */
export function spendText(balance: PetBalance | null): string {
  if (!balance || !balance.ok) return '今天还没读到可比的数据';
  if (!balance.spend) return '今天是第一笔记录，明天才有消耗值';
  if (balance.spend.toppedUp) return '今天充过钱，所以没有消耗数';
  if (balance.spend.amount <= 0) return '今天还没花钱';
  return `今天花了 ${fmtMoney(balance.spend.amount, balance.currency)}`;
}

/* ── React 侧的挂载 ────────────────────────────────────────────────── */

/**
 * 她的状态 + 落盘。
 *
 * patch 收一个函数（而不是一个对象）：多处交互会在同一帧改同一份状态
 * （比如睡下和位置同时变），传对象的话后一次会把前一次整个盖掉。
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

  const reset = useCallback(() => {
    clearPetState();
    setState(defaultPetState());
  }, []);

  return { state, patch, reset };
}

/**
 * 余额轮询。
 *
 * 只有顶栏的用量浮层在用（桌宠自己不看了，余额是工作台的事）。
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
