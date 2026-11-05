import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Heart,
  History,
  MessageCircle,
  Moon,
  Play,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Star,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import { cls } from '@/lib/format';
import {
  CHAT_KEEP,
  clamp,
  MOOD_LABEL,
  MOOD_TTL_MS,
  moodNow,
  pushChat,
  pushDiary,
  stageInfo,
  stageOf,
  todayKey,
  usePetState,
  type PetChatEntry,
  type PetMood,
  type PetState,
} from '@/lib/pet';
import { fill, pickLine, type LineGroup } from '@/lib/pet-lines';
import { onPetCue } from '@/lib/pet-bus';
import { api } from '@/lib/api';
import { Button, Input, Toggle } from './ui';
import { hasClips, roamArt, warmClips, Whale, WhaleAvatar, WhaleFace, type Pose } from './PetWhale';
import {
  pickRoamGap,
  shuffleRoam,
  ROAM_GAP_LABELS,
  ROAM_GAPS,
  ROAM_GROUPS,
  ROAM_ITEMS,
  ROAM_POOL,
} from '@/lib/pet-roam';
import { clipSupported } from './PetClip';

/* ── 右下角的思儿 ──────────────────────────────────────────────────────
   常驻在所有页面右下角的一只桌宠。定位是"住在这里的孩子"，不是助手：

   · **不参与工作**：不读待办、不看余额、不催进度、不转达告警。工作台的事
     由工作台自己说（余额在顶栏的用量浮层里）；她只关心人 —— 你有没有吃饭、
     坐太久、是不是不太说话。
   · **关系有温度，但不摆成数值**：三档关系（刚认识/熟络/黏人）与四种情绪，
     只在后台决定她说什么、敢不敢要你陪；没有签到、没有等级、没有奖励兑换。
   · **聊天是聊天窗**：气泡按人分左右、按天分隔，记录存在这台浏览器里，
     翻回上一次的对话还在，也能打开「记录」按关键字找。
   · **不打断**：面板开着、深夜（默认静音）时不主动搭话；主动说话的间隔
     是 5–8 分钟，且 15 分钟内不重复同一类关怀。
   · **不抢焦点**：默认是装饰（`aria-hidden` 的立绘 + 一个可聚焦的按钮），
     不覆盖任何业务 DOM；键盘上它就是一颗按钮。
   · **不添隐私负担**：无遥测、只打自己的工作台后端；聊天记录也不落库、不上传，
     全部在这台浏览器的 localStorage 里。

   状态全在 localStorage 里（见 lib/pet.ts 顶部那段说明），所以不进备份、
   也不跨设备同步 —— 这是刻意的。 */

/* ── 轮换进度：存 sessionStorage ────────────────────────────────────────
   一轮是七八十段，按"正常"档要半个多小时才走完。刷新一次就清零的话，
   用户永远走不到"全部看完"，看到的还是随机抽中的同一小撮 —— 观感上
   就像一直在重复。

   用 sessionStorage 而不是 localStorage：刷新/前进后退保留，关掉标签页
   重新开始。桌面宠物每次打开都从头轮一遍，正合适。 */
const ROAM_STORE = 'pet.roam.queue';

function readRoamQueue(): string[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(ROAM_STORE);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    /* 隐私模式下 sessionStorage 可能直接抛，轮换退化成"刷新重排"，不影响播放 */
    return [];
  }
}

function saveRoamQueue(queue: string[]): void {
  try {
    sessionStorage.setItem(ROAM_STORE, JSON.stringify(queue));
  } catch {
    /* 同上，存不进去就算了 */
  }
}

/** 合法姿势名。外部事件传进来的字符串要先过这一关 —— 拿一个不存在的
 *  pose 去查 TONE / 道具表会拿到 undefined，画面上就是一层没样式的东西 */
const POSE_NAMES: readonly string[] = [
  'idle', 'plush', 'wave', 'morning', 'night', 'winter', 'work', 'watch',
  'alert', 'error', 'sleep', 'pat', 'shy', 'star', 'love', 'drag',
  'feed', 'checkin', 'streak', 'levelup', 'gift', 'surprise', 'swim', 'celebrate',
];

/** 挂载点。放在 AppShell 里，于是所有页面共用同一只 */
export function Pet() {
  const { state, patch, reset } = usePetState();

  const enabled = state.enabled;

  /* ── 说话 ──────────────────────────────────────────────────────── */
  const [bubble, setBubble] = useState<{ text: string; until: number } | null>(null);
  const lastLine = useRef('');

  /* 多久没人理就打盹。开口说话、被摸头都算"有人理" ——
     所以她自己在旁边念叨两句也会醒过来，而不是一直睡着 */
  const [dozing, setDozing] = useState(false);
  const lastTouchRef = useRef(Date.now());

  /**
   * 睡着的读写都走 ref：叫醒那一句要在 `patch` 之后**同一帧**里说出来，
   * 等 state 生效就赶不上了（闭包里还是旧值）。
   */
  const asleepRef = useRef(state.asleep);
  asleepRef.current = state.asleep;
  /** 梦话是唯一允许在她睡着时开口的来源 */
  const dreamingRef = useRef(false);

  const say = useCallback(
    (text: string, ms = 9000) => {
      /* 睡着时除了梦话一律闭嘴：闲聊也不该把她吵醒 */
      if (asleepRef.current && !dreamingRef.current) return;
      lastTouchRef.current = Date.now();
      setDozing(false);
      /* 气泡关掉就一个字都不冒。这是设置项的字面承诺 */
      if (!state.bubble || !text) return;
      lastLine.current = text;
      setBubble({ text, until: Date.now() + ms });
    },
    [state.bubble],
  );

  const sayGroup = useCallback(
    (group: LineGroup, ms?: number) =>
      say(fill(pickLine(group, lastLine.current), { name: state.nickname }), ms),
    [say, state.nickname],
  );

  /* ── 情绪与亲密度 ─────────────────────────────────────────────────
     亲密度是隐藏值：界面上没有数字、没有进度条，只决定她解锁到哪一档。
     一次互动同时改情绪、亲密度和"最近被关注"的时间，合成一次 patch ——
     分两次写的话，第二次会拿旧的 prev 把第一次盖掉。 */
  const mood = moodNow(state);
  const bondStage = stageOf(state.bond);

  const feelAndBond = useCallback(
    (gain: number, next: PetMood = 'happy') => {
      const now = new Date().toISOString();
      patch((p) => ({
        ...p,
        bond: Math.min(100, p.bond + gain),
        mood: next,
        moodAt: now,
        lastTouchAt: now,
      }));
    },
    [patch],
  );

  /* 情绪过期要有人把她"叫回来"：闹别扭时既不闲聊也不轮换，
     没有这次重渲染的话，那张生闷气的脸会一直挂到下一次交互。 */
  useEffect(() => {
    if (!state.moodAt || mood === 'calm') return;
    const since = Date.parse(state.moodAt) || 0;
    const ttl = state.mood === 'calm' ? 0 : MOOD_TTL_MS[state.mood];
    const left = Math.max(1000, since + ttl + 500 - Date.now());
    const t = window.setTimeout(() => patch((p) => ({ ...p })), left);
    return () => window.clearTimeout(t);
  }, [state.moodAt, state.mood, mood, patch]);

  useEffect(() => {
    if (!bubble) return;
    const left = Math.max(0, bubble.until - Date.now());
    const timer = window.setTimeout(() => setBubble(null), left);
    return () => window.clearTimeout(timer);
  }, [bubble]);

  /* ── 反应姿势：短时的动作，压在工作态之上 ───────────────────────── */
  const [reactPose, setReactPose] = useState<Pose | null>(null);
  const reactTimer = useRef<number | null>(null);

  const react = useCallback((pose: Pose, ms = 2600) => {
    if (reactTimer.current) window.clearTimeout(reactTimer.current);
    setReactPose(pose);
    reactTimer.current = window.setTimeout(() => setReactPose(null), ms);
  }, []);

  useEffect(
    () => () => {
      if (reactTimer.current) window.clearTimeout(reactTimer.current);
    },
    [],
  );

  /* ── 时段与季节：待机那张图跟着日历走 ────────────────────────────
     不额外挂定时器：跟着现有的重渲染顺手算一次 Date 就够了。 */
  const now = new Date();
  const hour = now.getHours();
  const month = now.getMonth() + 1;
  /** 凌晨 / 深夜 / 早间 / 白天。深夜分两档是刻意的：越晚越沉 */
  const slot: 'night' | 'dawn' | 'morning' | 'day' =
    hour >= 23 || hour < 2 ? 'night' : hour < 6 ? 'dawn' : hour < 11 ? 'morning' : 'day';
  const winter = month === 12 || month <= 2;

  /**
   * 待机也要换脸：一直一张 idle 看久了像张贴纸。
   *
   * "蹭玩偶"是**熟络之后才有的形态**：刚认识时她不太敢在你面前滚来滚去，
   * 只安静待着；关系到了，待机才会在 idle 与 plush 之间换。
   */
  const [ambient, setAmbient] = useState<Pose>('idle');
  useEffect(() => {
    const tick = window.setInterval(() => {
      setAmbient((p) => (state.stage >= 1 ? (p === 'idle' ? 'plush' : 'idle') : 'idle'));
    }, 90 * 1000);
    return () => window.clearInterval(tick);
  }, [state.stage]);

  /* 形象素材：24 张立绘 + 24 段透明动画（见 PetWhale / PetClip）。
     动画是一段一段按需下的，所以这里在空闲时把最常用的几段先取进缓存 ——
     否则第一次点她/第一次犯困时会"空一下"，等的就是那 400KB。
     手机不预取：那是有流量代价的，等真用到再下。 */
  useEffect(() => {
    if (!state.enabled || state.art === 'pose' || !hasClips || !clipSupported()) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return;
    /* 高频的业务动作 + 轮换池里排在前面的几段小动作。
       全池预取要 5MB 以上，手机上纯属浪费；这里只取前 6 段，其余用到再下。 */
    const warm = ['wave', 'pat', 'shy', 'sleep', ...(state.roamPool.length ? state.roamPool : ROAM_POOL).slice(0, 6)];
    const run = () => warmClips(warm);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 8000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(run, 5000);
    return () => window.clearTimeout(timer);
  }, [state.enabled, state.art, state.roamPool]);

  /* ── 拖动 ──────────────────────────────────────────────────────── */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<{ x: number; y: number }>(() => state.pos ?? { x: 0, y: 0 });
  const [dragTilt, setDragTilt] = useState<number | null>(null);
  const dragRef = useRef<{
    baseX: number;
    baseY: number;
    startX: number;
    startY: number;
    rect: DOMRect;
    /** offset 的可用范围（相对固定定位原点的位移量） */
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    moved: boolean;
    /** 最近几次指针位置，用来算松手速度 —— 甩抛靠它 */
    samples: { t: number; x: number; y: number }[];
    /** 捕获指针的那个元素，松手时要**在同一个元素**上释放 */
    captured: Element;
  } | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  /* 惯性飞行中。飞行时不能给 transform 加过渡 —— 那是给"归位"用的缓动，
     套在逐帧位移上会变成一坨延迟 */
  const [flying, setFlying] = useState(false);
  const flyRaf = useRef<number | null>(null);
  /** 立绘本体（Q 弹用 Web Animations，避免和内联 transform 打架） */
  const bodyRef = useRef<HTMLButtonElement>(null);

  /** 落地那一下的挤压回弹。用 el.animate 而不是 CSS 类：动画结束自动清干净，
   *  也不会和拖拽时的 rotate 抢 transform */
  const squash = useCallback(() => {
    const el = bodyRef.current;
    if (!el || typeof el.animate !== 'function') return;
    el.animate(
      [
        { transform: 'scale(1, 1)' },
        { transform: 'scale(1.09, 0.9)' },
        { transform: 'scale(0.97, 1.03)' },
        { transform: 'scale(1, 1)' },
      ],
      { duration: 380, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' },
    );
  }, []);

  useEffect(() => () => {
    if (flyRaf.current !== null) window.cancelAnimationFrame(flyRaf.current);
  }, []);

  /** 松手后的惯性：匀速衰减 + 撞边反弹，停下时落盘并 Q 弹一下 */
  const fling = (vx: number, vy: number, bounds: { minX: number; maxX: number; minY: number; maxY: number }) => {
    if (flyRaf.current !== null) window.cancelAnimationFrame(flyRaf.current);
    let x = offsetRef.current.x;
    let y = offsetRef.current.y;
    let sx = vx;
    let sy = vy;
    let last = performance.now();
    setFlying(true);
    const step = (now: number) => {
      /* 切标签页回来时 dt 会很大：夹一下，否则宠物一帧飞到屏幕外 */
      const dt = Math.min(48, Math.max(0, now - last));
      last = now;
      x += sx * dt;
      y += sy * dt;
      if (x <= bounds.minX) {
        x = bounds.minX;
        sx = Math.abs(sx) * 0.5;
      } else if (x >= bounds.maxX) {
        x = bounds.maxX;
        sx = -Math.abs(sx) * 0.5;
      }
      if (y <= bounds.minY) {
        y = bounds.minY;
        sy = Math.abs(sy) * 0.5;
      } else if (y >= bounds.maxY) {
        y = bounds.maxY;
        sy = -Math.abs(sy) * 0.5;
      }
      const damp = Math.pow(0.9, dt / 16);
      sx *= damp;
      sy *= damp;
      const next = { x, y };
      offsetRef.current = next;
      setOffset(next);
      if (Math.hypot(sx, sy) > 0.02) {
        flyRaf.current = window.requestAnimationFrame(step);
        return;
      }
      flyRaf.current = null;
      setFlying(false);
      squash();
      patch((p) => ({ ...p, pos: next }));
    };
    flyRaf.current = window.requestAnimationFrame(step);
  };

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = wrapRef.current;
    if (!el) return;
    /* 抓住她的瞬间就停下上一段飞行，否则会出现"人已经按住了、她还在飘" */
    if (flyRaf.current !== null) {
      window.cancelAnimationFrame(flyRaf.current);
      flyRaf.current = null;
      setFlying(false);
    }
    /* 捕获必须设在**挂着这些事件的那颗按钮**上，不能设在外面那层容器上：
       指针被捕获之后，后续事件（含 pointerup）只会投递给捕获元素及其祖先，
       而按钮是容器的子节点 —— 捕在外层，按钮就再也收不到松手，
       整个点击（摸头）会一声不响地失效。边界计算用容器的包围盒，
       两者是两件事。 */
    /* 万一捕获失败也必须继续往下走：pointerId 失效时 setPointerCapture 会抛
       NotFoundError（快速点按、指针已经抬起，都会撞上）。不兜的话这一次点击
       直接没了 —— 宁可不捕获（拖出窗口时丢一次移动），也不能让摸头失灵 */
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 不捕获就是了 */
    }
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      baseX: offset.x,
      baseY: offset.y,
      startX: e.clientX,
      startY: e.clientY,
      rect,
      bounds: {
        minX: -rect.left + 4,
        maxX: window.innerWidth - rect.right - 4,
        minY: -rect.top + 4,
        maxY: window.innerHeight - rect.bottom - 4,
      },
      moved: false,
      samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
      captured: e.currentTarget,
    };
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    /* 4–5px 的抖动容忍：不设的话，手一抖就把"摸头"判成"拖拽" */
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) {
      d.moved = true;
      sayGroup('pickUp', 5000);
    }
    /* 不许被拖出屏幕。边界用起拖那一刻算好的（拖的过程中 transform 一直在变，
       跟着算会自己追自己） */
    const { minX, maxX, minY, maxY } = d.bounds;
    setOffset({
      x: clamp(d.baseX + dx, minX, maxX),
      y: clamp(d.baseY + dy, minY, maxY),
    });
    setDragTilt(clamp(dx * 0.05, -12, 12));
    /* 留最近十几帧的位置，endDrag 用它估甩出的速度 */
    d.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (d.samples.length > 14) d.samples.shift();
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      d?.captured.releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已经自己释放过了，不必管 */
    }
    setDragTilt(null);
    if (!d) return;
    if (!d.moved) {
      handlePat();
      return;
    }
    /* 甩出去：按最后 140ms 的位移估速度（px/ms）。门限取 0.35 ——
       低于这个数都是"挪一下"，硬套惯性反而显得黏手 */
    const now = performance.now();
    const recent = d.samples.filter((s) => now - s.t <= 140);
    const first = recent[0];
    const tail = recent[recent.length - 1];
    let vx = 0;
    let vy = 0;
    if (first && tail && tail !== first && now - first.t > 10) {
      vx = clamp((tail.x - first.x) / (now - first.t), -4, 4);
      vy = clamp((tail.y - first.y) / (now - first.t), -4, 4);
    }
    sayGroup('dropped', 5000);
    if (Math.hypot(vx, vy) > 0.35) {
      fling(vx, vy, d.bounds);
      return;
    }
    /* 位置在**松手之后**才写：拖到一半刷新页面的话，落盘的是中间态，
       下次打开她会从一个你根本没松手过的角落冒出来 */
    patch((p) => ({ ...p, pos: { ...offsetRef.current } }));
  };

  const backHome = () => {
    setOffset({ x: 0, y: 0 });
    patch((p) => ({ ...p, pos: null }));
    sayGroup('backHome');
  };

  /* ── 互动 ──────────────────────────────────────────────────────── */

  /** 最近一次摸头的时间。4 秒内连摸只做一次反应，不然会被连点刷屏 */
  const lastPatRef = useRef(0);
  const clickTimes = useRef<number[]>([]);
  const clickTimer = useRef<number | null>(null);

  const [bursts, setBursts] = useState<{ id: number; kind: 'heart' | 'star'; x: number; y: number }[]>([]);
  const burstSeq = useRef(0);

  const burst = useCallback(
    (kind: 'heart' | 'star', count = 5) => {
      if (!state.particles) return;
      const next = Array.from({ length: count }, (_, i) => ({
        id: (burstSeq.current += 1) + i,
        kind,
        x: Math.random() * 46 - 23,
        y: Math.random() * 14,
      }));
      setBursts((prev) => [...prev, ...next]);
      /* 粒子自己会飘走（CSS 动画），这里只负责把它们从 state 里摘掉 ——
         不摘的话连点几十下之后 DOM 里会挂着一堆透明的节点 */
      window.setTimeout(() => {
        const ids = new Set(next.map((b) => b.id));
        setBursts((prev) => prev.filter((b) => !ids.has(b.id)));
      }, 1400);
    },
    [state.particles],
  );

  /** 摸一下：换"被摸头"那张图。闹别扭时第一下是"哄"，哄好才算数 */
  function patOnce() {
    const now = Date.now();
    if (now - lastPatRef.current < 4000) {
      react('shy', 1800);
      sayGroup('patCooldown', 5000);
      return;
    }
    lastPatRef.current = now;
    if (mood === 'sulk') {
      /* 她在生气：先给一句"好吧"，不假装没事，也不记仇 */
      feelAndBond(1, 'happy');
      react('shy', 2200);
      sayGroup('sulkForgive', 8000);
      return;
    }
    feelAndBond(1, 'happy');
    react('pat', 2400);
    burst('heart', 5);
    sayGroup('pat');
  }

  function triplePat() {
    lastPatRef.current = Date.now();
    feelAndBond(2, 'shy');
    react('star', 3600);
    burst('star', 8);
    sayGroup('patTriple');
  }

  /** 连点五下的彩蛋：原地转两圈、身后炸开星光。一次要给足反馈 */
  function whaleTime() {
    lastPatRef.current = Date.now();
    feelAndBond(3, 'shy');
    react('surprise', 4200);
    burst('star', 10);
    sayGroup('whaleEaster', 12000);
  }

  /**
   * 单击 / 多连击的**判定**。
   *
   * 做法是"攒 340 毫秒再结算"，而不是"到第 3 下立刻触发"：
   * 后者的问题是三连击会先于五连击命中并清空计数 —— 那么"连点五下"这个
   * 彩蛋永远不可达。等一小会儿再按总次数分流，1–2 下是摸头、3–4 下是星星眼、
   * 5 下以上才放大招。
   */
  /* ── 睡 / 醒 ──────────────────────────────────────────────────── */

  /** 让她睡下：轮换、闲聊全停，只剩梦话 */
  function sleepNow() {
    setPanel('none');
    setRoamKey(null);
    /* 先说完"晚安"再落 asleep —— 反过来 say 会因为她已经睡着而闭嘴 */
    sayGroup('sleepNow', 7000);
    patch((p) => ({ ...p, asleep: true }));
  }

  /** 叫醒：点她、回车、或菜单 */
  function wakeUp() {
    if (!asleepRef.current) return;
    /* 先放 ref 再说话：say 会看它，等 state 生效就赶不上这一句了 */
    asleepRef.current = false;
    patch((p) => ({ ...p, asleep: false }));
    setPanel('none');
    sayGroup('wakeUp', 6000);
    squash();
  }

  function handlePat() {
    if (panel !== 'none') {
      setPanel('none');
      return;
    }
    if (asleepRef.current) {
      wakeUp();
      return;
    }
    const now = Date.now();
    clickTimes.current = [...clickTimes.current.filter((t) => now - t < 1800), now];
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      const count = clickTimes.current.length;
      clickTimes.current = [];
      if (count >= 5) whaleTime();
      else if (count >= 3) triplePat();
      else patOnce();
    }, 340);
  }

  /* ── 面板 ──────────────────────────────────────────────────────── */
  const [panel, setPanel] = useState<'none' | 'menu' | 'settings' | 'chat' | 'actions'>('none');

  useEffect(() => {
    if (panel === 'none') return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPanel('none');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel('none');
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [panel]);

  /* ── 相处记录：每天一条，只记事不给奖励 ─────────────────────────── */

  const todayStr = todayKey();
  useEffect(() => {
    if (!enabled || state.diaryDay === todayStr) return;
    const days = daysTogether(state.since);
    patch((p) =>
      p.diaryDay === todayStr
        ? p
        : { ...p, diaryDay: todayStr, diary: pushDiary(p.diary, `一起过的第 ${days} 天`) },
    );
  }, [enabled, state.diaryDay, state.since, todayStr, patch]);

  /* ── 见面招呼：一次会话只打一次，刷新页面不该再唠一遍 ─────────── */
  useEffect(() => {
    if (!enabled) return;
    const key = `pet:greeted:${todayKey()}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      /* 隐私模式下读不到 sessionStorage：那就退化成"每次刷新都打一次招呼"，无害 */
    }
    const hour = new Date().getHours();
    const group: LineGroup = hour < 6 ? 'night' : hour < 11 ? 'morning' : hour < 17 ? 'noon' : hour < 23 ? 'evening' : 'night';
    const timer = window.setTimeout(() => {
      /* 打招呼配"挥手"那张：招呼是一次性的动作，说完就把手放下 ——
         所以用 react（短时），而不是把它写进待机姿势 */
      react('wave', 3400);
      sayGroup(group, 12000);
    }, 1600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /* ── 主动闲聊与关怀 ───────────────────────────────────────────── */

  /** 下一次主动开口的时间。5–8 分钟 + 每 30 秒检查一次 —— 定时器只负责
   *  "该不该说"，不该被当成节拍器（那样的话她一开口就是整分钟的倍数） */
  const nextTalkRef = useRef(0);

  const quietNow = useCallback(() => {
    if (!state.quiet) return false;
    const h = new Date().getHours();
    return h >= 23 || h < 6;
  }, [state.quiet]);

  /** 主动说话的总闸门：不打断、不半夜吵、不在面板开着的时候插话；闹别扭时先不说话 */
  const canSpeakUp = useCallback(
    () =>
      enabled &&
      state.chatter &&
      state.bubble &&
      !document.hidden &&
      panel === 'none' &&
      !quietNow() &&
      mood !== 'sulk',
    [enabled, state.chatter, state.bubble, panel, quietNow, mood],
  );

  /** 闲聊只挑"人的状态"和她的日常，不看任何工作台数据；说什么跟着关系阶段走 */
  const idleLine = useCallback((): LineGroup => {
    if (mood === 'shy') return 'shyIdle';
    const h = new Date().getHours();
    if (h >= 23 || h < 6) return 'night';
    if (state.stage >= 2 && Math.random() < 0.35) return 'idleAttached';
    if (state.stage >= 1 && Math.random() < 0.45) return 'idleClose';
    if (Math.random() < 0.14) return 'bored';
    return 'idle';
  }, [mood, state.stage]);

  /* ── 关系阶段：跨过阈值才播一次，台词跟着阶段换 ───────────────── */
  useEffect(() => {
    if (bondStage <= state.stage) return;
    const info = stageInfo(bondStage);
    patch((p) => ({
      ...p,
      stage: bondStage,
      mood: 'happy',
      moodAt: new Date().toISOString(),
      diary: pushDiary(p.diary, `和你更熟了：${info.title}`),
    }));
    react('levelup', 4200);
    burst('star', 8);
    sayGroup(bondStage >= 2 ? 'bondUpAttached' : 'bondUpClose', 13000);
  }, [bondStage, state.stage, patch, react, burst, sayGroup]);

  /* ── 她也会开口要东西 ───────────────────────────────────────────
     刚认识时不敢说；熟络了会要你看她一眼，黏人了才敢直接要你陪她玩。
     一次只要一件事，冷却 40 分钟，不反复索取。 */
  useEffect(() => {
    if (!enabled || state.asleep || dozing || panel !== 'none' || quietNow()) return;
    const tick = window.setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const lastTouch = Date.parse(state.lastTouchAt) || now;
      const lastPlay = Date.parse(state.lastPlayAt) || now;
      const lastNeed = Date.parse(state.lastNeedAt) || 0;
      const needCooldown = now - lastNeed < 40 * 60 * 1000;

      /* 要过关注却一直没被理：先小声问，再给自己找个台阶生气。
         她没有"好感度下降"，只是把脸转过去一会儿 —— 摸一下就回来了。 */
      if (
        state.stage >= 1 &&
        lastNeed > 0 &&
        lastTouch < lastNeed &&
        now - lastNeed > 10 * 60 * 1000 &&
        /* 只气这一小段：气过了就自己好，不会陷入"每 6 分钟重新生气" */
        now - lastNeed < 15 * 60 * 1000 &&
        mood !== 'sulk'
      ) {
        patch((p) => ({ ...p, mood: 'sulk', moodAt: new Date(now).toISOString() }));
        return;
      }
      if (needCooldown) return;

      if (state.stage >= 1 && now - lastTouch > 10 * 60 * 1000) {
        const stamp = new Date(now).toISOString();
        patch((p) => ({ ...p, lastNeedAt: stamp, mood: 'shy', moodAt: stamp }));
        react('shy', 2600);
        sayGroup('wantAttention', 12000);
        return;
      }
      if (state.stage >= 2 && now - lastPlay > 25 * 60 * 1000) {
        patch((p) => ({ ...p, lastNeedAt: new Date(now).toISOString() }));
        sayGroup('wantPlay', 12000);
      }
    }, 60 * 1000);
    return () => window.clearInterval(tick);
  }, [
    enabled,
    state.asleep,
    state.stage,
    state.lastTouchAt,
    state.lastPlayAt,
    state.lastNeedAt,
    dozing,
    panel,
    mood,
    quietNow,
    patch,
    react,
    sayGroup,
  ]);

  useEffect(() => {
    if (nextTalkRef.current === 0) nextTalkRef.current = Date.now() + 5 * 60 * 1000 + Math.random() * 3 * 60 * 1000;
    const tick = window.setInterval(() => {
      if (Date.now() < nextTalkRef.current || !canSpeakUp()) return;
      nextTalkRef.current = Date.now() + 5 * 60 * 1000 + Math.random() * 3 * 60 * 1000;
      /* 黏人之后，说话前偶尔会先凑过来（爱心眼），不只靠台词表达 */
      if (state.stage >= 2 && Math.random() < 0.3) react('love', 3000);
      sayGroup(idleLine(), 12000);
    }, 30 * 1000);
    return () => window.clearInterval(tick);
  }, [canSpeakUp, idleLine, sayGroup]);

  /* 离开超过 3 分钟再回来，打个招呼 */
  const awayRef = useRef(Date.now());
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) {
        awayRef.current = Date.now();
        return;
      }
      if (Date.now() - awayRef.current > 3 * 60 * 1000) sayGroup('welcomeBack', 8000);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [sayGroup]);

  /* 闲置 15 分钟就打盹。检查频率给到 1 分钟：它只是"该不该睡"的判据，
     没人要求它秒级准确，而每分钟一次的成本可以忽略 */
  useEffect(() => {
    const tick = window.setInterval(() => {
      /* 页面不在前台时不算"没人理"：你切走了，不是不理她 */
      if (document.hidden) {
        lastTouchRef.current = Date.now();
        return;
      }
      if (!enabled || panel !== 'none') return;
      if (Date.now() - lastTouchRef.current > 15 * 60 * 1000) setDozing(true);
    }, 60 * 1000);
    return () => window.clearInterval(tick);
  }, [enabled, panel]);

  /* ── 投喂 / 夸夸 ────────────────────────────────────────────────
     投喂与夸夸会让她开心、关系近一点，但界面上不会冒出"好感度 +2"，
     也没有库存要攒 —— 想吃就吃，夸她也不该像完成任务。 */
  /** 一分钟内不重复喂：不是怕她吃撑，是别把"亲近"刷成一个点击动作 */
  const lastFeedRef = useRef(0);
  function feed() {
    if (Date.now() - lastFeedRef.current < 60 * 1000) {
      react('shy', 1600);
      sayGroup('feedCooldown', 5000);
      return;
    }
    lastFeedRef.current = Date.now();
    feelAndBond(2, 'happy');
    react('feed', 3200);
    burst('heart', 6);
    sayGroup('feed');
  }

  const lastPraiseRef = useRef(0);
  function praise() {
    if (Date.now() - lastPraiseRef.current < 20000) {
      react('shy', 1600);
      say('好话听太多也会飘的，等会儿再夸。', 6000);
      return;
    }
    lastPraiseRef.current = Date.now();
    feelAndBond(2, 'shy');
    react('love', 3400);
    burst('heart', 4);
    sayGroup('praise');
  }

  /* ── 收起 / 唤回 ──────────────────────────────────────────────── */
  function hide() {
    setPanel('none');
    setBubble(null);
    patch((p) => ({ ...p, enabled: false }));
  }

  function summon() {
    patch((p) => ({ ...p, enabled: true }));
    /* 这句话在**收起状态**下也要能说出口：say 只认 state.bubble，
       不看 enabled —— 所以这里调得动，气泡会跟着立绘一起回来 */
    sayGroup('callBack', 8000);
  }

  /**
   * 当前该画哪一档姿势（24 张里挑一张）。
   *
   * 优先级从高到低，排序本身就是设计：
   *   1. **拖着**（drag）—— 手正按着，必须是它
   *   2. **睡着**（sleep）—— 睡下之后压过一切
   *   3. **刚发生的反应**（reactPose）—— 摸头、投喂…刚做完的事要立刻有回执
   *   4. **时段**（凌晨 swim / 深夜 night）
   *   5. **季节**（winter）
   *   6. **打盹**（sleep）
   *   7. **闹别扭**（用 shy 那张：捂着脸，像在生闷气）
   *   8. **待机**（idle ⇄ plush 轮换）
   *
   * **早间不再钉 `morning`**：那段素材就是"晨间刷牙"，钉在 6–11 点意味着
   * 每放完一个小动作都回到刷牙，看着像一直在刷牙。现在早上跟其他时段一样
   * 用 idle ⇄ plush 待机，刷牙退回成池子里的普通动作（`brush`），一轮一次。
   */
  const pose: Pose =
    dragTilt !== null
      ? 'drag'
      : state.asleep
        ? 'sleep'
        : (reactPose ??
          (slot === 'dawn'
            ? 'swim'
            : slot === 'night'
              ? 'night'
              : winter
                ? 'winter'
                : dozing
                  ? 'sleep'
                  : mood === 'sulk'
                    ? 'shy'
                    : ambient));

  /* ── 空闲动作轮换 ────────────────────────────────────────────────
     不做事的时候在池子里随机换动作，而不是循环同一段。
     之前只认 `pose === 'idle'`，而时段会把姿势钉在 night / winter，
     于是"她自己玩"几乎从不触发 —— 看起来就是同一段在循环。现在按"闲不闲"
     判断，而不是按某一个具体姿势。

       · 池子：`idle` 兜底 + 用户勾选的小动作（`ROAM_POOL` 默认全选）
       · 间隔：设置里的档位（安静 / 正常 / 活跃），到点后在区间里取随机
       · 时长：`ROAM_ITEMS` 的 seconds / loops；不写就自然播完（最自然）
       · 不重复：记住上一段，下一次从池子里排除它
       · 独立性：lastRoam 与随机源都在实例内，多开时各走各的

     它不进 Pose：那是业务状态，这是装饰，不该被任何判断逻辑引用。 */
  const [roamKey, setRoamKey] = useState<string | null>(null);
  const lastRoam = useRef<string | null>(null);
  const roam = roamKey ? roamArt(roamKey) : null;

  /**
   * 闲着：没有交互姿态、也没有在拖。
   *
   * 打盹（`dozing`）**不算**"不闲"：她睡着也能翻个身、偷吃零食，
   * 否则十几分钟没人碰之后一进入 sleep 姿势，就永远循环同一段 ——
   * 那正是"看着像没轮换"最容易被撞上的场景。
   */
  const idleLike = !reactPose && dragTilt === null;

  /**
   * 参与轮换的只有小动作本身，**不再有兜底动作**。
   *
   * 以前池子空了会塞一个 `idle` 进去凑数，结果就是"轮换到待机"——
   * 画面上什么都没发生，看着跟没换一样。池子是空的就干脆不轮换，
   * 让业务姿势（工作 / 打盹 / 时段待机）自己待着。
   *
   * 顺手滤掉已经没有素材的 key：素材改名/删段之后，旧配置里可能还留着
   * 它们，抽到就是"一段播不出来的动作"，看着像卡住不动。
   */
  const roamPool = useMemo(
    () =>
      (state.roamPool.length ? state.roamPool : ROAM_POOL).filter(
        (k) => k !== 'idle' && roamArt(k) !== null,
      ),
    [state.roamPool],
  );

  /**
   * 这一轮的播放顺序。**抽完才重排**，所以一轮之内每段只出现一次；
   * 等整个池子放完，才洗下一轮 —— 这才叫"不重样"。
   */
  const roamQueue = useRef<string[]>(useMemo(readRoamQueue, []));

  /** 取下一段：先耗尽本轮，空了才洗牌；池子为空返回 null（不播） */
  const drawRoam = (): string | null => {
    if (!roamPool.length) return null;
    /* 用户中途改了勾选：保留本轮里还有效的剩余段落，失效的直接丢掉 */
    let queue = roamQueue.current.filter((k) => roamPool.includes(k));
    if (!queue.length) queue = shuffleRoam(roamPool, lastRoam.current);
    const [next, ...rest] = queue;
    roamQueue.current = rest;
    saveRoamQueue(rest);
    lastRoam.current = next;
    return next;
  };

  /**
   * 池子一变就重排：新勾的动作不必等这一轮放完才轮到。
   *
   * 必须跳过首次执行 —— 挂载时 roster 刚从 sessionStorage 读回来，
   * 这里一清就等于上次的进度全白存了。`roamPool` 来自 useMemo，
   * 引用不变就是同一个池子。
   */
  const roamPoolRef = useRef(roamPool);
  useEffect(() => {
    if (roamPoolRef.current === roamPool) return;
    roamPoolRef.current = roamPool;
    roamQueue.current = [];
    saveRoamQueue([]);
  }, [roamPool]);

  /** 面板里的「换一个」：从本轮队列里取，不会打乱"不重样"的保证 */
  const tryRoam = () => {
    const next = drawRoam();
    if (next) setRoamKey(next);
  };

  /**
   * 先把队列里的下一段取进 HTTP 缓存。
   *
   * 池子里大部分动作是冷门的：第一次轮到时才下 400KB，正好压在切换那一刻 ——
   * 旧层顶着画面的时间被拉长，看着就是"卡一下才换"。上一段在播的十秒里
   * 足够把下一段取完，切换就只剩解码。
   */
  useEffect(() => {
    if (!state.enabled || state.art === 'pose' || !hasClips || !clipSupported()) return;
    const next = roamQueue.current[0];
    if (next) warmClips([next]);
  }, [roamKey, roamPool, state.enabled, state.art]);

  /* ── 点播与聊天 ────────────────────────────────────────────────── */

  /** 点播一段：立刻播，并从本轮队列摘掉（不然这一轮又抽到它） */
  const playOnce = (key: string) => {
    if (!roamArt(key)) return;
    lastRoam.current = key;
    roamQueue.current = roamQueue.current.filter((k) => k !== key);
    saveRoamQueue(roamQueue.current);
    setRoamKey(key);
    setPanel('none');
    /* 陪她玩算一次亲近：她刚开口要过的话，这一下正好接住 */
    const askedRecently = Date.now() - (Date.parse(state.lastNeedAt) || 0) < 5 * 60 * 1000;
    const now = new Date().toISOString();
    patch((p) => ({
      ...p,
      bond: Math.min(100, p.bond + 1),
      mood: 'happy',
      moodAt: now,
      lastTouchAt: now,
      lastPlayAt: now,
    }));
    if (askedRecently) sayGroup('playTogether', 6000);
  };

  const [chatBusy, setChatBusy] = useState(false);
  /** 聊天两分钟内只算一次亲近：连发十句不该等于陪了她一下午 */
  const lastChatBondRef = useRef(0);

  /**
   * 问她一句。
   *
   * 走她自己的链路 `/pet/chat`（非流式），不是工作台助手 —— 那条会答待办、
   * 监控、也会替人执行操作，她不该碰那些。
   *
   * 记忆靠**本地记录**：每次带上最近十几条真实对话（服务端只取最后六轮，
   * 再多它也不看）。记录存在 localStorage 里，所以刷新、关掉标签页、第二天
   * 再打开，她都还记得；这也是聊天窗能往回翻的那份数据。
   */
  const askPet = async (text: string) => {
    const message = text.trim();
    if (!message || chatBusy) return;
    setChatBusy(true);
    const mine: PetChatEntry = { role: 'user', text: message, at: new Date().toISOString() };
    const now = new Date().toISOString();
    const gain = Date.now() - lastChatBondRef.current > 2 * 60 * 1000 ? 1 : 0;
    if (gain) lastChatBondRef.current = Date.now();
    patch((p) => ({
      ...p,
      chat: pushChat(p.chat, mine),
      bond: Math.min(100, p.bond + gain),
      mood: 'happy',
      moodAt: now,
      lastTouchAt: now,
    }));
    try {
      const res = await api.pet.chat(message, {
        /* 多带几条：她"记得"的深度由这里决定，服务端会再截到自己的上限 */
        history: state.chat.slice(-12),
        nickname: state.nickname,
        stage: state.stage,
        mood,
      });
      const reply = (res.reply || '').trim() || '……我一时没想好怎么答。';
      const hers: PetChatEntry = { role: 'assistant', text: reply, at: new Date().toISOString() };
      patch((p) => ({ ...p, chat: pushChat(p.chat, hers) }));
    } catch {
      /* 失败也别冒出"请求失败"这种系统腔，她只会说自己的话 */
      const hers: PetChatEntry = { role: 'assistant', text: '没连上。等会儿再说吧。', at: new Date().toISOString() };
      patch((p) => ({ ...p, chat: pushChat(p.chat, hers) }));
    } finally {
      setChatBusy(false);
    }
  };

  /* ── 外部事件总线 ────────────────────────────────────────────────
     任何模块都可以 `petCue({ say, play, pose })` 让她说一句、播一段。
     这个口子只留给"人"的事（喝水、久坐、下班）—— 不拿她当工作台的喇叭。 */
  useEffect(
    () =>
      onPetCue((cue) => {
        if (cue.say) say(cue.say, cue.ms);
        if (cue.pose && POSE_NAMES.includes(cue.pose)) react(cue.pose as Pose, 2800);
        if (cue.play && roamArt(cue.play)) {
          /* 点播的这一段从本轮队列摘掉：不然刚看完，这一轮又抽到它 */
          lastRoam.current = cue.play;
          roamQueue.current = roamQueue.current.filter((k) => k !== cue.play);
          saveRoamQueue(roamQueue.current);
          setRoamKey(cue.play);
        }
      }),
    [say, react],
  );

  /* ── 梦话 ────────────────────────────────────────────────────────
     睡着之后按周期嘟囔一句。三分之一概率，固定节奏会像定时报时。 */
  useEffect(() => {
    if (!state.asleep || !state.bubble) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (Math.random() > 0.35) return;
      dreamingRef.current = true;
      sayGroup('dream', 12000);
      dreamingRef.current = false;
    }, 3 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [state.asleep, state.bubble, sayGroup]);

  const canRoam =
    state.enabled &&
    state.roam &&
    !state.asleep &&
    mood !== 'sulk' &&
    state.art !== 'pose' &&
    clipSupported() &&
    roamPool.length > 0;

  /** 后台标签页里不排下一段：回来时会重新计时，省解码也省电 */
  const [docHidden, setDocHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!canRoam || !idleLike || roamKey || docHidden || bubble) return;
    const gap = pickRoamGap(ROAM_GAPS[state.roamGap]);
    const timer = window.setTimeout(() => {
      const next = drawRoam();
      if (next) setRoamKey(next);
    }, gap);
    return () => window.clearTimeout(timer);
  }, [canRoam, idleLike, roamKey, docHidden, bubble, roamPool, state.roamGap]);

  /** 配了时长的动作：到点收回；没配就是自然播完（onEnded） */
  const roamSeconds = (() => {
    const cfg = roamKey ? ROAM_ITEMS[roamKey] : null;
    if (!cfg) return null;
    if (cfg.seconds) return cfg.seconds;
    /* 素材一段约 10 秒；要"循环几遍"就按遍数换算成时长，行为等价 */
    if (cfg.loops && cfg.loops > 1) return cfg.loops * 10;
    return null;
  })();

  useEffect(() => {
    if (!roamKey || !roamSeconds) return;
    const t = window.setTimeout(() => setRoamKey(null), roamSeconds * 1000);
    return () => window.clearTimeout(t);
  }, [roamKey, roamSeconds]);

  /* 她一开始干别的（被摸、被拖、睡着、生闷气…）就立刻收回小动作 */
  useEffect(() => {
    if (!idleLike || mood === 'sulk') setRoamKey(null);
  }, [idleLike, mood]);

  /* 兜底：视频没触发 ended（被自动播放策略拦下 / 解码失败）也要收回来 */
  useEffect(() => {
    if (!roamKey) return;
    const t = window.setTimeout(() => setRoamKey(null), (roamSeconds ?? 11) * 1000 + 2000);
    return () => window.clearTimeout(t);
  }, [roamKey, roamSeconds]);

  /* 收起状态：只在右下角留一颗鲸鱼。它是**唯一**的唤回入口，
     所以要一直有，且能键盘 Tab 到 */
  if (!enabled) {
    return (
      <button
        type="button"
        onClick={summon}
        aria-label="唤起思儿"
        title="思儿在下面休息，点一下叫她回来"
        className="pet-dock fixed bottom-24 right-3 z-40 grid h-11 w-11 place-items-center rounded-full border border-line bg-panel/90 p-1.5 shadow-pop backdrop-blur transition-transform hover:scale-105 lg:bottom-5 lg:right-4"
      >
        {/* 收起状态用**一张脸**的圆头像：缩到 30px 还放全身的话，
            那块地方只剩一团蓝，认不出是谁 */}
        <WhaleFace size={32} art={state.art} />
      </button>
    );
  }

  return (
    /* 这一层刻意不写 touch-none：它会给整棵子树定死"不许平移"，
       于是里面的设置面板在手机上滚不动了。touch-none 落在立绘那颗
       按钮上，阻止的只是"手指按着它拖页面"，正是拖拽要的效果 */
    <div
      ref={wrapRef}
      className="pet-root fixed bottom-24 right-3 z-40 lg:bottom-5 lg:right-4"
      style={{
        transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
        transition:
          dragTilt !== null || flying ? 'none' : 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {/* 聊天窗比别的面板宽一档：左右两列气泡、还要放时间与头像，268px 里
          每行只剩十来个字。其余面板维持原宽度 —— 菜单和设置本来就该窄 */}
      <div
        className={cls(
          'relative flex flex-col items-end gap-2',
          panel === 'chat' ? 'w-[340px] max-w-[calc(100vw-24px)]' : 'w-[268px]',
        )}
      >
        {/* 气泡 / 面板都挂在同一根竖轴上：底端对齐，于是它们永远长在头像上方 */}
        {bubble ? (
          <div
            role="status"
            className="pet-bubble relative max-w-[240px] rounded-field border border-line bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-ink shadow-pop"
          >
            {bubble.text}
          </div>
        ) : null}

        {/* 投喂 / 夸夸 / 签到点完就把菜单收起来：它们是"一次性动作"，
            留着菜单只会挡住她的反应（气泡和姿势才是这三个动作的回执）。
            聊天 / 设置不在此列 —— 那两个是把菜单换成另一块面板 */}
        {panel === 'menu' ? (
          <PetMenu
            state={state}
            onFeed={() => {
              setPanel('none');
              feed();
            }}
            onPraise={() => {
              setPanel('none');
              praise();
            }}
            onChat={() => setPanel('chat')}
            onActions={() => setPanel('actions')}
            onSleep={sleepNow}
            onWake={wakeUp}
            onSettings={() => setPanel('settings')}
            onHome={backHome}
            onHide={hide}
          />
        ) : null}

        {panel === 'chat' ? (
          <ChatPanel
            chat={state.chat}
            busy={chatBusy}
            asleep={state.asleep}
            nickname={state.nickname}
            art={state.art}
            onSend={(text) => void askPet(text)}
            onWake={wakeUp}
            onClear={() => patch((p) => ({ ...p, chat: [] }))}
            onClose={() => setPanel('none')}
          />
        ) : null}

        {panel === 'actions' ? (
          <ActionsPanel onPlay={playOnce} onClose={() => setPanel('none')} />
        ) : null}

        {panel === 'settings' ? (
          <SettingsPanel
            state={state}
            onPatch={patch}
            onReset={reset}
            onTryRoam={tryRoam}
            onClose={() => setPanel('none')}
          />
        ) : null}

        {/* 立绘本体。它是一个 button：键盘 Tab 得到、回车/空格就是摸头。
            不拦键盘、不换 DOM 结构，摸头之外不做任何事 —— 3 条自我约束里
            的"不抢焦点"就是这个意思。她头顶不挂任何数值：钱与进度都是
            工作台的事。 */}
        <button
            type="button"
            ref={bodyRef}
            aria-label="思儿。摸一下头，右键看菜单"
            title="思儿 · 摸一下头，右键看菜单"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onContextMenu={(e) => {
              e.preventDefault();
              setPanel(panel === 'menu' ? 'none' : 'menu');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handlePat();
              }
            }}
            className="pet-body relative block cursor-grab touch-none select-none active:cursor-grabbing"
            style={
              dragTilt !== null
                ? { transform: `rotate(${dragTilt}deg) scale(1.05)`, transition: 'none' }
                : { transition: 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)' }
            }
          >
            <Whale
              pose={pose}
              size={132}
              talk={Boolean(bubble)}
              art={state.art}
              extra={roam}
              extraLoop={Boolean(roamSeconds)}
              onExtraEnd={() => setRoamKey(null)}
            />
            {/* 睡着：Zzz 标。她不会说话、不会动，只有这一枚说明"是我让她睡的" */}
            {state.asleep ? (
              <span className="absolute right-[-8px] top-0 whitespace-nowrap rounded-full bg-bg-2 px-1.5 text-[10px] leading-4 text-muted shadow-pop">
                Zzz
              </span>
            ) : null}
          </button>

        {/* 点击特效。放在最外层是因为它要能飘出立绘的边界 */}
        <div aria-hidden className="pointer-events-none absolute bottom-2 right-10 h-0 w-0">
          {bursts.map((b) => (
            <span
              key={b.id}
              className={cls('pet-burst', b.kind === 'heart' ? 'text-crit' : 'text-warn')}
              style={{ marginLeft: `${b.x}px`, bottom: `${b.y}px` }}
            >
              {b.kind === 'heart' ? <Heart size={13} fill="currentColor" /> : <Star size={13} fill="currentColor" />}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 一起过了多少天：首尾都算，所以最小是 1 */
function daysTogether(since: string): number {
  const start = new Date(since);
  if (Number.isNaN(start.getTime())) return 1;
  return Math.max(1, Math.floor((Date.now() - start.getTime()) / 86_400_000) + 1);
}

/* ── 右键菜单 ──────────────────────────────────────────────────────── */

function PetMenu({
  state,
  onFeed,
  onPraise,
  onChat,
  onActions,
  onSleep,
  onWake,
  onSettings,
  onHome,
  onHide,
}: {
  state: PetState;
  onFeed: () => void;
  onPraise: () => void;
  onChat: () => void;
  onActions: () => void;
  onSleep: () => void;
  onWake: () => void;
  onSettings: () => void;
  onHome: () => void;
  onHide: () => void;
}) {
  return (
    <div role="menu" aria-label="思儿的菜单" className="pet-panel w-[190px] p-1">
      <MenuItem icon={<Utensils size={13} />} onClick={onFeed}>
        投喂点心
      </MenuItem>
      <MenuItem icon={<Sparkles size={13} />} onClick={onPraise}>
        夸夸她
      </MenuItem>
      <div aria-hidden className="my-1 h-px bg-line" />
      <MenuItem icon={<MessageCircle size={13} />} onClick={onChat} hint={state.asleep ? '睡着' : undefined}>
        聊聊天
      </MenuItem>
      <MenuItem icon={<Play size={13} />} onClick={onActions}>
        点播动作
      </MenuItem>
      <MenuItem icon={<Moon size={13} />} onClick={state.asleep ? onWake : onSleep}>
        {state.asleep ? '叫醒她' : '睡一会儿'}
      </MenuItem>
      <div aria-hidden className="my-1 h-px bg-line" />
      <MenuItem icon={<Settings2 size={13} />} onClick={onSettings}>
        看板娘设置
      </MenuItem>
      {state.pos ? (
        <MenuItem icon={<RotateCcw size={13} />} onClick={onHome}>
          回到右下角
        </MenuItem>
      ) : null}
      <div aria-hidden className="my-1 h-px bg-line" />
      <MenuItem icon={<X size={13} />} onClick={onHide} tone="muted">
        先下去休息
      </MenuItem>
    </div>
  );
}

/* ── 聊天面板 ──────────────────────────────────────────────────────── */

/**
 * 和她的聊天窗。
 *
 * 版式照着微信来：自己的话靠右、她的话靠左带头像，跨天与隔了五分钟以上的地方
 * 插一条时间；输入框贴着底边，Enter 发送、Shift + Enter 换行。
 *
 * 记录只存在 `pet:state.chat` 这一份（带时间、最多 200 条）—— 窗口里看到的
 * 就是喂给模型的那一份，不存在"显示一套、记忆另一套"。点「记录」按天翻，
 * 也能按关键字搜。
 */

const CHAT_GAP_MS = 5 * 60 * 1000;

/** 一条消息属于哪一天（本地时区）。老记录没有 at，归到空串 = 「更早」 */
function chatDay(at: string): string {
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) ? todayKey(d) : '';
}

/** 那一天的称呼：今天 / 昨天 / 11月3日 / 更早 */
function dayLabel(day: string): string {
  if (!day) return '更早';
  const today = todayKey();
  if (day === today) return '今天';
  if (day === todayKey(new Date(Date.now() - 86_400_000))) return '昨天';
  const [, m, d] = day.split('-');
  const year = day.slice(0, 4) === today.slice(0, 4) ? '' : `${day.slice(0, 4)}年`;
  return `${year}${Number(m)}月${Number(d)}日`;
}

/** 时:分。日期由分隔条负责，这里只给时刻 */
function chatTime(at: string): string {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

type ChatRow =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'msg'; key: string; msg: PetChatEntry };

/**
 * 把连续对话摊成"分隔条 + 消息"的一维序列。
 *
 * 分隔规则跟微信一致：跨天写「今天 14:20」，同一天里隔了五分钟以上只写「14:20」。
 * 时间戳坏掉的记录不给分隔条 —— 宁可少一行，也别在中间插一个空标签。
 */
function chatRows(chat: PetChatEntry[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let prev: PetChatEntry | null = null;
  chat.forEach((msg, i) => {
    const day = chatDay(msg.at);
    const prevDay = prev ? chatDay(prev.at) : null;
    const t = msg.at ? new Date(msg.at).getTime() : NaN;
    const pt = prev?.at ? new Date(prev.at).getTime() : NaN;
    const gap = Number.isFinite(t) && Number.isFinite(pt) ? t - pt : Number.POSITIVE_INFINITY;
    const time = chatTime(msg.at);
    if (day !== prevDay && (day || time)) {
      rows.push({ kind: 'divider', key: `d-${i}`, label: `${dayLabel(day)}${time ? ` ${time}` : ''}` });
    } else if (gap > CHAT_GAP_MS && time) {
      rows.push({ kind: 'divider', key: `d-${i}`, label: time });
    }
    rows.push({ kind: 'msg', key: `m-${i}`, msg });
    prev = msg;
  });
  return rows;
}

function ChatPanel({
  chat,
  busy,
  asleep,
  nickname,
  art,
  onSend,
  onWake,
  onClear,
  onClose,
}: {
  chat: PetChatEntry[];
  busy: boolean;
  asleep: boolean;
  /** 她怎么称呼你 —— 记录里自己的那几条用它署名 */
  nickname: string;
  art: PetState['art'];
  onSend: (text: string) => void;
  onWake: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const rows = useMemo(() => chatRows(chat), [chat]);

  /* 新消息进来滚到底：不然她回了三行，用户还停在第一行 */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, busy, historyOpen]);

  /** 输入框跟着内容长高，到四行左右封顶（再高就把消息挤没了） */
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 88)}px`;
  };

  const send = () => {
    const value = text.trim();
    if (!value || busy || asleep) return;
    setText('');
    if (boxRef.current) boxRef.current.style.height = 'auto';
    onSend(value);
  };

  return (
    <section
      className="pet-panel relative flex w-full flex-col"
      /* 高度取 420px 与"屏幕上还剩多少"的较小值：底边距 + 立绘本身还要占一截，
         写死会在小屏上把聊天窗顶出屏幕上沿 */
      style={{ height: 'min(420px, calc(100vh - 300px))' }}
      aria-label="和思儿聊天"
    >
      {historyOpen ? (
        <ChatHistory chat={chat} nickname={nickname} onClear={onClear} onBack={() => setHistoryOpen(false)} />
      ) : (
        <>
          <header className="pet-panel-head">
            <WhaleAvatar size={26} art={art} />
            <div className="min-w-0 flex-1 leading-tight">
              <h3 className="truncate text-[12.5px] font-semibold text-ink">思儿</h3>
              <p className="text-3xs text-faint">{asleep ? '睡着了' : busy ? '正在输入…' : '在的'}</p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="聊天记录"
              title="聊天记录"
              className="rounded-field p-1 text-muted transition-colors hover:text-ink"
            >
              <History size={13} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded-field p-1 text-muted transition-colors hover:text-ink"
            >
              <X size={12} />
            </button>
          </header>

          <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {rows.length === 0 ? (
              <p className="text-[12px] leading-relaxed text-faint">
                还没和她说过话。随便聊点什么都行 —— 她只关心人，不管工作台的事。
              </p>
            ) : null}
            {rows.map((row) =>
              row.kind === 'divider' ? (
                <p key={row.key} className="py-0.5 text-center text-3xs text-faint">
                  {row.label}
                </p>
              ) : (
                <ChatBubble key={row.key} msg={row.msg} art={art} />
              ),
            )}
            {busy ? <TypingBubble art={art} /> : null}
          </div>

          {asleep ? (
            <div className="border-t border-line p-2">
              <Button size="sm" variant="soft" onClick={onWake} className="w-full">
                她睡着了，叫醒她
              </Button>
            </div>
          ) : (
            <div className="flex items-end gap-1.5 border-t border-line p-2">
              <textarea
                ref={boxRef}
                value={text}
                rows={1}
                onChange={(e) => {
                  setText(e.target.value);
                  grow(e.currentTarget);
                }}
                onKeyDown={(e) => {
                  /* isComposing：中文输入法选词那一下的 Enter 不该把消息发出去 */
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="和她说点别的…"
                aria-label="对她说的话"
                className="field max-h-[88px] min-w-0 flex-1 resize-none py-1.5 text-[12px] leading-relaxed"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={send}
                disabled={busy || !text.trim()}
                aria-label="发送"
                className="shrink-0"
              >
                <Send size={12} aria-hidden />
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** 一条消息。自己的靠右、纯色；她的靠左、带一枚小头像 */
function ChatBubble({ msg, art }: { msg: PetChatEntry; art: PetState['art'] }) {
  const mine = msg.role === 'user';
  return (
    <div className={cls('flex items-end gap-1.5', mine ? 'justify-end' : 'justify-start')}>
      {mine ? null : <WhaleAvatar size={22} art={art} />}
      <p
        className={cls(
          'max-w-[78%] whitespace-pre-wrap break-words rounded-xl2 px-2.5 py-1.5 text-[12px] leading-relaxed',
          /* 靠头像那一角收成小圆角，像微信里的气泡尾巴 */
          mine ? 'rounded-br-md bg-accent text-on-accent' : 'rounded-bl-md border border-line bg-panel text-ink',
        )}
      >
        {msg.text}
      </p>
    </div>
  );
}

/** "正在输入"：三个依次呼吸的点。文字版会被读屏念成省略号，所以补一句 sr-only */
function TypingBubble({ art }: { art: PetState['art'] }) {
  return (
    <div className="flex items-end gap-1.5">
      <WhaleAvatar size={22} art={art} />
      <span className="flex items-center gap-1 rounded-xl2 rounded-bl-md border border-line bg-panel px-2.5 py-[9px]">
        <span className="sr-only">她正在输入</span>
        {[0, 1, 2].map((i) => (
          <i
            key={i}
            aria-hidden
            className="h-1 w-1 animate-pulse rounded-full bg-faint"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
    </div>
  );
}

/**
 * 聊天记录：同一个面板里的另一个视图（绝对定位盖满，不另开一层）。
 *
 * 数据就是聊天窗那份，所以"能看到的历史"和"她记得的历史"是同一批 ——
 * 差别只在版式：这里按天分组、带署名与时刻，顶上还能搜。
 */
function ChatHistory({
  chat,
  nickname,
  onClear,
  onBack,
}: {
  chat: PetChatEntry[];
  nickname: string;
  onClear: () => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return chatRows(kw ? chat.filter((m) => m.text.toLowerCase().includes(kw)) : chat);
  }, [chat, q]);
  const who = nickname.trim() || '我';

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-panel">
      <header className="pet-panel-head">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回聊天"
          className="rounded-field p-1 text-muted transition-colors hover:text-ink"
        >
          <ChevronLeft size={13} />
        </button>
        <h3 className="flex-1 text-[12.5px] font-semibold text-ink">聊天记录</h3>
        {/* 清空要点两下：这个按钮挨着返回，误触一次就全没了 */}
        <button
          type="button"
          onClick={() => (confirmClear ? onClear() : setConfirmClear(true))}
          aria-label={confirmClear ? '再点一次清空聊天记录' : '清空聊天记录'}
          title={confirmClear ? '再点一次就清空' : '清空聊天记录'}
          className={cls(
            'rounded-field p-1 transition-colors',
            confirmClear ? 'text-crit' : 'text-muted hover:text-crit',
          )}
        >
          <Trash2 size={12} />
        </button>
      </header>

      <div className="border-b border-line px-2 py-1.5">
        <div className="relative">
          <Search
            size={12}
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜一句说过的话"
            aria-label="搜索聊天记录"
            className="field w-full py-1 pl-7 pr-2 text-[12px]"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-3xs text-faint">
            {chat.length ? '没有找到对得上的话' : '还没有记录。'}
          </p>
        ) : null}
        {rows.map((row) =>
          row.kind === 'divider' ? (
            <p key={row.key} className="py-1 text-center text-3xs text-faint">
              {row.label}
            </p>
          ) : (
            <div key={row.key} className="py-1">
              <p className="mb-0.5 flex items-baseline gap-1.5 text-3xs text-faint">
                <span className={row.msg.role === 'user' ? 'text-accent' : 'text-muted'}>
                  {row.msg.role === 'user' ? who : '思儿'}
                </span>
                <span className="num">{chatTime(row.msg.at)}</span>
              </p>
              <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">{row.msg.text}</p>
            </div>
          ),
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-3xs text-faint">
        <span>
          共 {chat.length} 条 · 最多留 {CHAT_KEEP} 条
        </span>
        {confirmClear ? <span className="text-crit">再点一次垃圾桶就清空</span> : <span>只在这台浏览器</span>}
      </footer>
    </div>
  );
}

/* ── 点播动作 ──────────────────────────────────────────────────────── */

function ActionsPanel({ onPlay, onClose }: { onPlay: (key: string) => void; onClose: () => void }) {
  return (
    <section className="pet-panel w-full" aria-label="点播动作">
      <header className="pet-panel-head">
        <Play size={13} aria-hidden className="text-accent" />
        <h3 className="flex-1 text-[12.5px] font-semibold text-ink">点播一段</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded-field p-1 text-muted transition-colors hover:text-ink"
        >
          <X size={12} />
        </button>
      </header>
      <div className="max-h-64 space-y-2 overflow-y-auto p-2">
        {ROAM_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="mb-1 text-3xs text-faint">{group.title}</p>
            <div className="flex flex-wrap gap-1">
              {Object.entries(group.items).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onPlay(key)}
                  className="rounded-full border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  hint?: string;
  tone?: 'muted';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cls(
        'flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-bg-2',
        tone === 'muted' ? 'text-muted' : 'text-ink',
      )}
    >
      <span aria-hidden className="shrink-0 text-faint">
        {icon}
      </span>
      <span className="flex-1 truncate">{children}</span>
      {hint ? <span className="num shrink-0 text-3xs text-faint">{hint}</span> : null}
    </button>
  );
}

/* ── 设置面板 ──────────────────────────────────────────────────────── */

function SettingsPanel({
  state,
  onPatch,
  onReset,
  onTryRoam,
  onClose,
}: {
  state: PetState;
  onPatch: (mutate: (prev: PetState) => PetState) => void;
  onReset: () => void;
  /** 立刻换一段小动作（轮换的"手动触发"） */
  onTryRoam: () => void;
  onClose: () => void;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  const mood = moodNow(state);
  const stage = stageInfo(state.stage);
  /* 空数组 = 全部参与；渲染时算一次，别在九十多个 chips 的循环里反复判断 */
  const pickedRoam: readonly string[] = state.roamPool.length ? state.roamPool : ROAM_POOL;
  /* 显式存了全部也算全选：判断的是"每个 key 都在"，不是"数组为空" */
  const allRoam = ROAM_POOL.every((k) => pickedRoam.includes(k));

  return (
    <section className="pet-panel w-full" aria-label="看板娘设置">
      <header className="pet-panel-head">
        <Settings2 size={13} aria-hidden className="text-accent" />
        <h3 className="flex-1 text-[12.5px] font-semibold text-ink">看板娘</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded-field p-1 text-muted transition-colors hover:text-ink"
        >
          <X size={12} />
        </button>
      </header>

      <div className="max-h-[60vh] space-y-0.5 overflow-y-auto px-3 py-2">
        <Row label="陪着我" hint="关掉之后右下角留一颗鲸鱼，点一下叫回来">
          <Toggle
            checked={state.enabled}
            onChange={(v) => {
              onPatch((p) => ({ ...p, enabled: v }));
              /* 关掉的那一下要说一声，不然她会"咻"地消失得不明不白 */
              if (!v) window.setTimeout(onClose, 0);
            }}
            label="看板娘开关"
          />
        </Row>

        <Row label="台词气泡" hint="关掉只是不冒话，摸头之类的反应还在">
          <Toggle checked={state.bubble} onChange={(v) => onPatch((p) => ({ ...p, bubble: v }))} label="台词气泡" />
        </Row>

        <Row label="主动闲聊" hint="5–8 分钟一次；面板开着或深夜时不开口">
          <Toggle checked={state.chatter} onChange={(v) => onPatch((p) => ({ ...p, chatter: v }))} label="主动闲聊" />
        </Row>

        <Row label="点击特效" hint="摸头飞出的爱心与星星">
          <Toggle
            checked={state.particles}
            onChange={(v) => onPatch((p) => ({ ...p, particles: v }))}
            label="点击特效"
          />
        </Row>

        <Row
          label="自由活动"
          hint={
            state.art === 'pose' || !clipSupported()
              ? '只在动效模式下有效：她会自己玩一会儿'
              : '待机时自己找点事做：啃饼干、撸猫、玩魔方、偷吃零食'
          }
        >
          <Toggle checked={state.roam} onChange={(v) => onPatch((p) => ({ ...p, roam: v }))} label="自由活动" />
        </Row>

        {state.roam && state.art !== 'pose' && clipSupported() ? (
          <>
            <Row label="换动作的间隔" hint="太慢像站岗，太快像抽风">
              <div className="flex shrink-0 gap-1">
                {(['quiet', 'normal', 'lively'] as const).map((g) => (
                  <Button
                    key={g}
                    variant={state.roamGap === g ? 'soft' : 'ghost'}
                    size="sm"
                    onClick={() => onPatch((p) => ({ ...p, roamGap: g }))}
                  >
                    {ROAM_GAP_LABELS[g]}
                  </Button>
                ))}
              </div>
            </Row>

            <div className="py-1.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-ink">参与随机的动作</p>
                  <p className="text-3xs leading-snug text-faint">
                    默认全选（{ROAM_POOL.length} 段）。一轮之内每段只播一次，
                    全部放完才重新洗牌，所以不会连着看到同一段。
                  </p>
                </div>
                {/* 勾掉几段以后想恢复全选，不该靠一个个点回来。
                    写回的仍是空数组 = "全部"：以后新加的动作也自动参与 */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  disabled={allRoam}
                  onClick={() => onPatch((p) => ({ ...p, roamPool: [] }))}
                >
                  全选
                </Button>
              </div>
              {/* 九十多段平铺会翻半天，按类别分组、整块自己滚 */}
              <div className="mt-1.5 max-h-40 space-y-2 overflow-y-auto pr-1">
                {ROAM_GROUPS.map((group) => (
                  <div key={group.title}>
                    <p className="mb-1 text-3xs text-faint">{group.title}</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(group.items).map(([k, label]) => {
                        const on = pickedRoam.includes(k);
                        return (
                          <button
                            key={k}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              onPatch((p) => {
                                const cur = p.roamPool.length ? p.roamPool : ROAM_POOL;
                                const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
                                /* 一个都不留 = 退回"全部"，视觉上会跳回全选，所以干脆不允许 */
                                if (!next.length) return p;
                                /* 重新点满也落回空数组：全选就该是"全部"，新加的动作
                                   才会自动进来，而不是被一份旧的完整名单挡在外面 */
                                const full = ROAM_POOL.every((x) => next.includes(x));
                                return { ...p, roamPool: full ? [] : next };
                              })
                            }
                            className={cls(
                              'rounded-full border px-2 py-0.5 text-2xs transition-colors',
                              on
                                ? 'border-accent bg-accent-soft text-accent'
                                : 'border-line text-faint hover:text-ink',
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="soft" onClick={onTryRoam} className="shrink-0">
                  换一个
                </Button>
                <span className="text-3xs leading-snug text-faint">
                  立刻切一段，不必等间隔；切换是叠层淡入淡出，不会闪黑
                </span>
              </div>
            </div>
          </>
        ) : null}

        <Row
          label="形象"
          hint={
            !hasClips
              ? '动画素材没装进这份构建'
              : !clipSupported()
                ? '这台浏览器不支持透明视频（Safari / iOS），只能显示立绘'
                : `动效：24 段姿势 + ${ROAM_POOL.length} 段小动作；立绘：静态姿势图（省流量）`
          }
        >
          <div className="flex shrink-0 gap-1">
            <Button
              variant={state.art === 'clip' ? 'soft' : 'ghost'}
              size="sm"
              disabled={!hasClips || !clipSupported()}
              onClick={() => onPatch((p) => ({ ...p, art: 'clip' }))}
            >
              动效
            </Button>
            <Button
              variant={state.art === 'pose' ? 'soft' : 'ghost'}
              size="sm"
              onClick={() => onPatch((p) => ({ ...p, art: 'pose' }))}
            >
              立绘
            </Button>
          </div>
        </Row>

        <Row label="深夜静音" hint="23:00–6:00 不主动搭话（你摸她还是会应）">
          <Toggle checked={state.quiet} onChange={(v) => onPatch((p) => ({ ...p, quiet: v }))} label="深夜静音" />
        </Row>

        <div aria-hidden className="my-2 h-px bg-line" />

        <label className="flex items-center justify-between gap-2 py-1.5">
          <span className="text-[12px] text-ink">怎么称呼你</span>
          <Input
            value={state.nickname}
            maxLength={16}
            placeholder="留空就是「你」"
            onChange={(e) => onPatch((p) => ({ ...p, nickname: e.target.value }))}
            className="w-28 px-2 py-1 text-[12px]"
          />
        </label>
        {/* 记录条数写在设置里：她记得多少、这些记忆存在哪儿，都该说清楚 */}
        <p className="pb-1 text-3xs leading-snug text-faint">
          聊天记录 {state.chat.length} 条（最多留 {CHAT_KEEP} 条），只存在这台浏览器里，
          不落库也不上传。
        </p>

        <div aria-hidden className="my-2 h-px bg-line" />

        <div className="space-y-1 pb-1">
          <p className="text-[12px] text-ink">
            和你的关系：{stage.title}
            <span className="ml-2 text-3xs font-normal text-faint">她现在{MOOD_LABEL[mood]}</span>
          </p>
          <p className="text-3xs text-faint">
            {stage.hint}
            {state.stage < 2 ? '；再多陪陪她，会解锁新的话' : '；她已经敢直接说要你陪了'}
          </p>
          <p className="text-3xs text-faint">
            一起过的第 {daysTogether(state.since)} 天 · 从 {new Date(state.since).toLocaleDateString('zh-CN')} 起
          </p>
          <p className="text-3xs text-faint">亲密度不显示数字，也不给奖励 —— 熟一点，她才会多说一点。</p>
        </div>

        {state.diary.length ? (
          <div className="space-y-1 border-t border-line pt-2">
            <p className="text-2xs font-medium text-muted">相处记录</p>
            {state.diary.slice(0, 5).map((d) => (
              <p key={`${d.at}-${d.text}`} className="text-3xs text-faint">
                <span className="num">{new Date(d.at).toLocaleDateString('zh-CN')}</span> {d.text}
              </p>
            ))}
          </div>
        ) : null}

        {hasClips ? (
          <p className="text-3xs leading-snug text-faint">
            动效素材来自 dsh-pet（PC2005-cloud），CC BY-NC-SA 4.0，非商业使用。
          </p>
        ) : null}

        <div className="border-t border-line pt-2">
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-3xs text-crit">养成的数值与位置会全部清掉，确定？</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onReset();
                  setConfirmReset(false);
                }}
              >
                确定
              </Button>
              <Button variant="soft" size="sm" onClick={() => setConfirmReset(false)}>
                算了
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="text-3xs text-faint underline-offset-2 transition-colors hover:text-crit hover:underline"
            >
              重置她的数据
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    /* 面板只有三百来像素宽：标签必须拿到一份稳定宽度（flex-1），
       字多的控件宁可整块换到下一行，也别把「换动作的间隔」压成竖排 */
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-ink">{label}</p>
        {hint ? <p className="text-3xs leading-snug text-faint">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
