import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarCheck,
  Heart,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Star,
  Utensils,
  Wallet,
  X,
} from 'lucide-react';
import { useMonitor } from '@/lib/monitor';
import { useStore } from '@/lib/store';
import { cls } from '@/lib/format';
import {
  balanceTier,
  clamp,
  fmtMoney,
  levelOf,
  nextLevel,
  pushDiary,
  runwayDays,
  runwayText,
  spendText,
  TIER_LABEL,
  TIER_TONE,
  todayKey,
  usePetBalance,
  usePetState,
  type PetState,
} from '@/lib/pet';
import { fill, pickLine, type LineGroup } from '@/lib/pet-lines';
import { Button, Input, Toggle } from './ui';
import { Whale, WhaleFace, type Pose } from './PetWhale';

/* ── 右下角的鲸娘 ──────────────────────────────────────────────────────
   常驻在所有页面右下角的一只桌宠。她只做两件事：

   1. **盯着 DeepSeek 的余额**。这是她要办的正事 —— 余额快见底时举牌提醒，
      点开能看到今日消耗、赠金/充值拆分和最近两周的读数。
      凭据在服务端（.env 里的 DEEPSEEK_API_KEY），浏览器侧拿不到。
   2. **陪你说两句话**。摸头、投喂、签到、闲聊，外加对工作台状态的反应
      （机器负载高的时候她会抱着笔记本不吵你）。

   三条自我约束，直接借自参考项目的设计（它那三条写得很准，值得照搬）：

   · **不打断**：采集在跑 / 负载高 / 面板开着时，绝不主动搭话，也不换姿势；
     深夜默认静音。主动说话的间隔是 5–8 分钟，且比 15 分钟更密不会再来一次。
   · **不抢焦点**：默认是装饰（`aria-hidden` 的立绘 + 一个可聚焦的按钮），
     不覆盖任何业务 DOM，不改任何内置文件；键盘上它就是一颗按钮。
   · **不添隐私负担**：无遥测、零外部请求。唯一会读"钱"的功能默认开着，
     但它打的是自己的工作台后端，且可以一键关掉、也可以只显示档位不显示金额
     （截图不泄露金额）。

   状态全在 localStorage 里（见 lib/pet.ts 顶部那段说明），所以不进备份、
   也不跨设备同步 —— 这是刻意的。 */

/**
 * 余额读失败最多这么久说一次。
 *
 * 不用"当天一次"：读失败往往是**持续状态**（Key 被撤、代理挂了），
 * 按天记的话一到零点又会念一遍，而它其实整晚都没好过。
 * 6 小时冷却 = 一天最多四次，既不会漏，也吵不起来。
 */
const BALANCE_ERROR_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** 挂载点。放在 AppShell 里，于是所有页面共用同一只 */
export function Pet() {
  const { state, patch, reset } = usePetState();
  const { todos } = useStore();
  const { overview, error: monitorError } = useMonitor();

  const enabled = state.enabled;
  /* 收起来之后就不必再问余额了 —— 没人看见那颗标，问一次就是白花一次请求。
     设置面板里的开关仍然生效：回来时会立刻对一次（usePetBalance 里那手
     visibilitychange 之外，enabled 变 true 本身就会重新起轮询）。 */
  const { balance, loading: balanceLoading, refresh: refreshBalance } = usePetBalance(state.watchBalance && enabled);
  const tier = balanceTier(balance, state.lowThreshold);

  /* ── 说话 ──────────────────────────────────────────────────────── */
  const [bubble, setBubble] = useState<{ text: string; until: number } | null>(null);
  const lastLine = useRef('');

  /* 多久没人理就打盹。开口说话、被摸头都算"有人理" ——
     所以她自己在旁边念叨两句也会醒过来，而不是一直睡着 */
  const [dozing, setDozing] = useState(false);
  const lastTouchRef = useRef(Date.now());

  const say = useCallback(
    (text: string, ms = 9000) => {
      lastTouchRef.current = Date.now();
      setDozing(false);
      /* 气泡关掉就一个字都不冒。这是设置项的字面承诺，
         所以连"重要提醒"也一起闭嘴 —— 余额那件事还有牌子（立绘）和
         侧边的档位标，不会因此丢掉。 */
      if (!state.bubble || !text) return;
      lastLine.current = text;
      setBubble({ text, until: Date.now() + ms });
    },
    [state.bubble],
  );

  const sayGroup = useCallback(
    (group: LineGroup, ms?: number, vars?: { days?: number }) =>
      say(fill(pickLine(group, lastLine.current), { name: state.nickname, ...vars }), ms),
    [say, state.nickname],
  );

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

  /* ── 工作态要联动的那几个信号 ────────────────────────────────── */

  /* 机器忙 → 抱着笔记本。带**回滞**：进 0.8、出 0.6。
     没有回滞的话，负载在阈值上下抖一次她就换一次姿势，看着像闪灯。 */
  const [busy, setBusy] = useState(false);
  const cpu = overview?.status?.cpu ?? null;
  useEffect(() => {
    if (cpu === null) return;
    setBusy((prev) => (prev ? cpu > 0.6 : cpu > 0.8));
  }, [cpu]);

  const pendingTodos = useMemo(() => todos.filter((t) => !t.done).length, [todos]);
  /* 给"挂载时"那些一次性逻辑读的镜像：它们只跑一次，闭包里拿到的是首帧的值 */
  const pendingRef = useRef(0);
  pendingRef.current = pendingTodos;

  /* ── 时段与季节：待机那张图跟着日历走 ────────────────────────────
     不额外挂定时器：桌宠本来就因为余额轮询（5 分钟）和监控轮询（1 分钟）
     在反复重渲染，跟着重算一次 Date 就够了。 */
  const now = new Date();
  const hour = now.getHours();
  const month = now.getMonth() + 1;
  /** 凌晨 / 深夜 / 早间 / 白天。深夜分两档是刻意的：越晚越沉 */
  const slot: 'night' | 'dawn' | 'morning' | 'day' =
    hour >= 23 || hour < 2 ? 'night' : hour < 6 ? 'dawn' : hour < 11 ? 'morning' : 'day';
  const winter = month === 12 || month <= 2;

  /** 待机也要换脸：一直一张 idle 看久了像张贴纸。90 秒在 idle 与"蹭玩偶"之间换 */
  const [ambient, setAmbient] = useState<Pose>('idle');
  useEffect(() => {
    const tick = window.setInterval(() => setAmbient((p) => (p === 'idle' ? 'plush' : 'idle')), 90 * 1000);
    return () => window.clearInterval(tick);
  }, []);

  /** 负载中等：拿放大镜看图表。它和"在忙"是两档，阈值错开才有区分度 */
  const watching = !busy && cpu !== null && cpu > 0.5;

  /** 监控或余额读不到 —— 这两件事都该让她抱头，而不是若无其事地站着 */
  const monitorDown = Boolean(monitorError) || Boolean(balance?.configured && !balance.ok);

  /* 立绘只有一张（白饭本人那张，41KB），随首屏一起下来，
     不再需要"提前把 24 张拉进缓存"那套 —— 状态差异全在叠加件与动效上 */

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
    moved: boolean;
    /** 捕获指针的那个元素，松手时要**在同一个元素**上释放 */
    captured: Element;
  } | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = wrapRef.current;
    if (!el) return;
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
    dragRef.current = {
      baseX: offset.x,
      baseY: offset.y,
      startX: e.clientX,
      startY: e.clientY,
      rect: el.getBoundingClientRect(),
      moved: false,
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
    /* 不许被拖出屏幕。按拖动开始那一刻的包围盒算边界 —— 拖的过程中
       transform 一直在变，跟着算会自己追自己 */
    const minX = -d.rect.left + 4;
    const maxX = window.innerWidth - d.rect.right - 4;
    const minY = -d.rect.top + 4;
    const maxY = window.innerHeight - d.rect.bottom - 4;
    setOffset({
      x: clamp(d.baseX + dx, minX, maxX),
      y: clamp(d.baseY + dy, minY, maxY),
    });
    setDragTilt(clamp(dx * 0.05, -12, 12));
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
    /* 位置在**松手之后**才写：拖到一半刷新页面的话，落盘的是中间态，
       下次打开她会从一个你根本没松手过的角落冒出来 */
    patch((p) => ({ ...p, pos: { ...offsetRef.current } }));
    sayGroup('dropped', 5000);
  };

  const backHome = () => {
    setOffset({ x: 0, y: 0 });
    patch((p) => ({ ...p, pos: null }));
    sayGroup('backHome');
  };

  /* ── 互动 ──────────────────────────────────────────────────────── */

  /** 最近一次摸头的时间。4 秒内连摸只算一次好感度，避免一路点到满级 */
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

  /** 摸一下：加好感度，换"被摸头"那张图。4 秒内连摸只算一次，免得一路点到满级 */
  function patOnce() {
    const now = Date.now();
    if (now - lastPatRef.current < 4000) {
      react('shy', 1800);
      sayGroup('patCooldown', 5000);
      return;
    }
    lastPatRef.current = now;
    patch((p) => ({
      ...p,
      affection: p.affection + 1,
      mood: clamp(p.mood + 2, 0, 100),
      pats: p.pats + 1,
      todayPats: p.todayPats + 1,
    }));
    react('pat', 2400);
    burst('heart', 5);
    sayGroup('pat');
  }

  function triplePat() {
    lastPatRef.current = Date.now();
    patch((p) => ({ ...p, affection: p.affection + 2, mood: clamp(p.mood + 5, 0, 100), pats: p.pats + 3 }));
    react('star', 3600);
    burst('star', 8);
    sayGroup('patTriple');
  }

  /** 连点五下的彩蛋：原地转两圈、身后炸开星光。一次要给足反馈 */
  function whaleTime() {
    lastPatRef.current = Date.now();
    patch((p) => ({ ...p, affection: p.affection + 3, mood: clamp(p.mood + 8, 0, 100), pats: p.pats + 5 }));
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
  function handlePat() {
    if (panel !== 'none') {
      setPanel('none');
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
  const [panel, setPanel] = useState<'none' | 'menu' | 'balance' | 'settings'>('none');

  /* 点开余额面板就现取一次。
     不能只靠上面那个轮询：关掉「余额关心」之后轮询是停的，而"我要看余额"
     仍然是这一下才发生的事 —— 光靠轮询的话面板上会写"还没配 Key"，
     可明明配了。服务端有 60 秒缓存，多问这一次不花什么。 */
  useEffect(() => {
    if (panel !== 'balance') return;
    void refreshBalance();
  }, [panel, refreshBalance]);

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

  /* ── 余额：低余额提醒 ─────────────────────────────────────────── */

  useEffect(() => {
    if (!state.watchBalance || !enabled) return;
    if (!balance?.configured || !balance.ok || balance.total === null) return;
    if (tier !== 'low' && tier !== 'empty') return;
    /* 每天只提醒一次。余额是慢变量，5 分钟轮询一次的话，
       不设这道闸就是每 5 分钟念一遍同一句话 */
    if (state.lowWarnedDay === todayKey()) return;
    patch((p) => ({ ...p, lowWarnedDay: todayKey(), mood: clamp(p.mood - 6, 0, 100) }));
    react('alert', 7000);
    sayGroup(tier === 'empty' ? 'balanceEmpty' : 'balanceLow', 14000);
  }, [enabled, state.watchBalance, state.lowWarnedDay, tier, balance, patch, react, sayGroup]);

  /**
   * 读不到余额要说一声。
   *
   * 这是这个桌宠最容易"静默失效"的地方：Key 被撤了、代理挂了、网络断了，
   * 界面上只是那颗标从数字变成"待读取" —— 谁会注意到监控已经停了？
   * 所以失败也要开口，但**不能每次都开口**（轮询是 5 分钟一轮）。
   */
  useEffect(() => {
    if (!state.watchBalance || !enabled) return;
    if (!balance?.configured || balance.ok) return;
    const last = Date.parse(state.balanceErrorAt) || 0;
    if (Date.now() - last < BALANCE_ERROR_COOLDOWN_MS) return;
    patch((p) => ({ ...p, balanceErrorAt: new Date().toISOString() }));
    /* 抱头，不是举牌：举牌是"钱快没了"，抱头才是"我没读到数"。
       这两个状态在同一张脸上会让人误判"是不是余额出事了" */
    react('error', 5200);
    sayGroup('balanceError', 12000);
  }, [enabled, state.watchBalance, state.balanceErrorAt, balance, patch, react, sayGroup]);

  /**
   * 照今天的用量撑不过一周时提一句。
   *
   * 这一条和"余额偏低"是两件事：余额还剩不少、但今天一天就烧掉一大截，
   * 也该有人提醒 —— 前者看的是**存量**，这一条看的是**速度**。
   */
  useEffect(() => {
    if (!state.watchBalance || !enabled) return;
    /* 余额已经告急时让位：两条提醒会抢同一个气泡，后说的把先说的顶掉，
       而"快没钱了"比"花得快"更该被看见。（面板里那行天数照样显示） */
    if (tier === 'low' || tier === 'empty') return;
    const days = runwayDays(balance);
    if (days === null || days >= 7) return;
    if (state.burnWarnedDay === todayKey()) return;
    patch((p) => ({ ...p, burnWarnedDay: todayKey() }));
    sayGroup(days < 1 ? 'balanceBurnToday' : 'balanceBurnFast', 13000, { days: Math.floor(days) });
  }, [enabled, state.watchBalance, state.burnWarnedDay, tier, balance, patch, sayGroup]);

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
      /* 待办没清完就在招呼后面补一句 —— 它比"午安"有用。
         读 ref 而不是闭包里的 pendingTodos：那个数在挂载这一刻还是 0
         （它要等 /bootstrap 回来），照搬的话这一句永远不会出现 */
      if (pendingRef.current > 0 && Math.random() < 0.5) {
        window.setTimeout(() => sayGroup('todoPending', 12000), 9000);
      }
    }, 1600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /* ── 主动闲聊与关怀 ───────────────────────────────────────────── */

  /** 下一次主动开口的时间。5–8 分钟 + 每 30 秒检查一次 —— 定时器只负责
   *  "该不该说"，不该被当成节拍器（那样的话她一开口就是整分钟的倍数） */
  const nextTalkRef = useRef(0);
  const lastCareRef = useRef(0);

  const quietNow = useCallback(() => {
    if (!state.quiet) return false;
    const h = new Date().getHours();
    return h >= 23 || h < 6;
  }, [state.quiet]);

  /** 主动说话的总闸门：不打断、不半夜吵、不在面板开着的时候插话 */
  const canSpeakUp = useCallback(
    () => enabled && state.chatter && state.bubble && !document.hidden && panel === 'none' && !busy && !quietNow(),
    [enabled, state.chatter, state.bubble, panel, busy, quietNow],
  );

  const idleLine = useCallback((): LineGroup => {
    if (monitorError) return 'monitorDown';
    /* 余额**告急**时不在这里提：那件事有专门的举牌提醒，一天一次、说得很清楚；
       闲聊再念一遍"没钱了"就变成唠叨了。这里只在账上宽裕时偶尔夸一句。
       （这一条同时也避开了"低余额时说余额充足"那种自相矛盾的话） */
    if (balance?.configured && balance.ok && tier === 'good' && Math.random() < 0.25) return 'balanceOk';
    if (overview?.mode === 'demo') return 'demoMode';
    if (cpu !== null && cpu > 0.6) return 'cpuHigh';
    if (pendingTodos === 0 && todos.length > 0) return 'todoClear';
    if (pendingTodos > 0 && Math.random() < 0.4) return 'todoPending';
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 6) return 'night';
    if (Math.random() < 0.12) return 'bored';
    return 'idle';
  }, [monitorError, balance, tier, overview?.mode, cpu, pendingTodos, todos.length]);

  useEffect(() => {
    if (nextTalkRef.current === 0) nextTalkRef.current = Date.now() + 5 * 60 * 1000 + Math.random() * 3 * 60 * 1000;
    const tick = window.setInterval(() => {
      if (Date.now() < nextTalkRef.current || !canSpeakUp()) return;
      /* 关怀类的话（余额、机器热）15 分钟内不重复；普通闲聊只要间隔到了就说 */
      const next = idleLine();
      const care = next === 'cpuHigh' || next === 'monitorDown' || next === 'balanceOk';
      if (care && Date.now() - lastCareRef.current < 15 * 60 * 1000) return;
      if (care) lastCareRef.current = Date.now();
      nextTalkRef.current = Date.now() + 5 * 60 * 1000 + Math.random() * 3 * 60 * 1000;
      sayGroup(next, 12000);
    }, 30 * 1000);
    return () => window.clearInterval(tick);
  }, [canSpeakUp, idleLine, sayGroup]);

  /* 工作态开始的瞬间说一句"我不吵你"。冷却 15 分钟，不然每次负载抬头都念 */
  const workSpokeRef = useRef(0);
  useEffect(() => {
    if (!busy || !enabled || !state.bubble) return;
    if (Date.now() - workSpokeRef.current < 15 * 60 * 1000) return;
    workSpokeRef.current = Date.now();
    sayGroup('busy', 6000);
  }, [busy, enabled, state.bubble, sayGroup]);

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
      if (!enabled || panel !== 'none' || busy) return;
      if (Date.now() - lastTouchRef.current > 15 * 60 * 1000) setDozing(true);
    }, 60 * 1000);
    return () => window.clearInterval(tick);
  }, [enabled, panel, busy]);

  /* ── 羁绊升级 ─────────────────────────────────────────────────── */
  const levelRef = useRef(levelOf(state.affection).level);
  useEffect(() => {
    const now = levelOf(state.affection);
    if (now.level <= levelRef.current) return;
    levelRef.current = now.level;
    patch((p) => ({
      ...p,
      mood: clamp(p.mood + 12, 0, 100),
      food: p.food + 1,
      diary: pushDiary(p.diary, `羁绊升到 Lv${now.level} · ${now.title}`),
    }));
    react('levelup', 4400);
    burst('star', 10);
    say(`羁绊到 Lv${now.level} 了。从现在起，你可以叫我「${now.title}」。`, 12000);
  }, [state.affection, patch, react, burst, say]);

  /**
   * 待办清空的那一刻。
   *
   * 只看"待办数变成 0"是不够的：首屏加载完成时这个数也会从 0 变成 N 再变成 0
   * （异步取回来的），所以要用**上一次的值**做对比 —— 上一刻还有活、这一刻
   * 没了，才是真的有人把活干完了。加载期间那一次（0 → N）不触发。
   */
  const prevPendingRef = useRef<number | null>(null);
  useEffect(() => {
    const before = prevPendingRef.current;
    prevPendingRef.current = pendingTodos;
    if (!enabled || before === null || before === 0 || pendingTodos !== 0) return;
    react('celebrate', 4400);
    burst('star', 8);
    sayGroup('celebrate', 12000);
  }, [pendingTodos, enabled, react, burst, sayGroup]);

  /**
   * 好感度每到 25 的整数倍，把小鲸鱼递给你一次。
   *
   * 用"跨过了第几阶"而不是"等于 25"：好感度一次能涨 2–3 点，
   * 判等会直接漏掉那一阶。ref 里存的是上一轮的阶数，升了才触发。
   */
  const giftStepRef = useRef(Math.floor(state.affection / 25));
  useEffect(() => {
    const step = Math.floor(state.affection / 25);
    if (step <= giftStepRef.current) return;
    giftStepRef.current = step;
    react('gift', 5000);
    patch((p) => ({ ...p, food: p.food + 1 }));
    sayGroup('gift', 13000);
  }, [state.affection, react, patch, sayGroup]);

  /* ── 投喂 / 夸夸 / 签到 ───────────────────────────────────────── */
  function feed() {
    if (state.food <= 0) {
      sayGroup('feedEmpty', 8000);
      return;
    }
    patch((p) => ({ ...p, food: p.food - 1, mood: clamp(p.mood + 8, 0, 100), affection: p.affection + 2 }));
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
    patch((p) => ({ ...p, mood: clamp(p.mood + 6, 0, 100), affection: p.affection + 2 }));
    react('love', 3400);
    burst('heart', 4);
    sayGroup('praise');
  }

  function checkIn() {
    const today = todayKey();
    if (state.lastCheckIn === today) {
      say('今天已经签过了。明天我还在这个位置等你。', 7000);
      return;
    }
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    /* 断签就从 1 重新数。这是"连续"的字面意思，
       给宽限（比如隔一天还算连签）会让这个数变得没有意义 */
    const streak = state.lastCheckIn === yesterday ? state.streak + 1 : 1;
    patch((p) => ({
      ...p,
      lastCheckIn: today,
      streak,
      food: p.food + 1,
      mood: clamp(p.mood + 10, 0, 100),
      affection: p.affection + 2,
      diary: pushDiary(p.diary, `连续签到 ${streak} 天`),
    }));
    /* 连签三天以上换成"举奖杯"那张：签到和连签是两件事，
       前者是"今天来了"，后者是"你一直来" —— 同一张图会把后者说小 */
    react(streak >= 3 ? 'streak' : 'checkin', 3800);
    burst('star', 6);
    sayGroup(streak >= 7 ? 'checkinStreak7' : streak >= 3 ? 'checkinStreak3' : 'checkin', 11000);
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

  const level = levelOf(state.affection);
  const next = nextLevel(state.affection);

  /**
   * 当前该画哪一档姿势（24 张里挑一张）。
   *
   * 优先级从高到低，排序本身就是设计：
   *   1. **拖着**（drag）—— 手正按着，必须是它
   *   2. **刚发生的反应**（reactPose）—— 摸头、投喂、升级…刚做完的事要立刻有回执
   *   3. **余额告急**（alert）—— 存量告急比"她在干活"更该被看见
   *   4. **出事**（error）—— 监控/余额读不到，不能装作若无其事
   *   5. **在忙 / 巡检**（work / watch）—— 机器在干活，她跟着动
   *   6. **时段**（凌晨 swim / 深夜 night / 早间 morning）
   *   7. **季节**（winter）
   *   8. **打盹**（sleep）
   *   9. **待机**（idle ⇄ plush 轮换）
   *
   * 时段排在"在忙"之后是有意的：白天在跑备份时才该看到笔记本，
   * 而"现在是凌晨"这件事跟负载无关，不该抢占它在忙的状态。
   */
  const pose: Pose =
    dragTilt !== null
      ? 'drag'
      : (reactPose ??
        (tier === 'empty' || tier === 'low'
          ? 'alert'
          : monitorDown
            ? 'error'
            : busy
              ? 'work'
              : watching
                ? 'watch'
                : slot === 'dawn'
                  ? 'swim'
                  : slot === 'night'
                    ? 'night'
                    : slot === 'morning'
                      ? 'morning'
                      : winter
                        ? 'winter'
                        : dozing
                          ? 'sleep'
                          : ambient));

  /* 收起状态：只在右下角留一颗鲸鱼。它是**唯一**的唤回入口，
     所以要一直有，且能键盘 Tab 到 */
  if (!enabled) {
    return (
      <button
        type="button"
        onClick={summon}
        aria-label="唤起鲸娘"
        title="鲸娘在下面休息，点一下叫她回来"
        className="pet-dock fixed bottom-24 right-3 z-40 grid h-11 w-11 place-items-center rounded-full border border-line bg-panel/90 p-1.5 shadow-pop backdrop-blur transition-transform hover:scale-105 lg:bottom-5 lg:right-4"
      >
        {/* 收起状态用**一张脸**的圆头像：缩到 30px 还放全身的话，
            那块地方只剩一团蓝，认不出是谁 */}
        <WhaleFace size={32} />
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
        transition: dragTilt !== null ? 'none' : 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <div className="relative flex w-[268px] flex-col items-end gap-2">
        {/* 气泡 / 面板都挂在同一根竖轴上：底端对齐，于是它们永远长在头像上方，
            也不会盖住下面那颗余额标 */}
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
            看余额 / 设置不在此列 —— 那两个是把菜单换成另一块面板 */}
        {panel === 'menu' ? (
          <PetMenu
            state={state}
            checkedIn={state.lastCheckIn === todayKey()}
            onFeed={() => {
              setPanel('none');
              feed();
            }}
            onPraise={() => {
              setPanel('none');
              praise();
            }}
            onCheckIn={() => {
              setPanel('none');
              checkIn();
            }}
            onBalance={() => setPanel('balance')}
            onSettings={() => setPanel('settings')}
            onHome={backHome}
            onHide={hide}
          />
        ) : null}

        {panel === 'balance' ? (
          <BalancePanel
            balance={balance}
            loading={balanceLoading}
            threshold={state.lowThreshold}
            showNumber={state.showNumber}
            onRefresh={() => void refreshBalance()}
            onClose={() => setPanel('none')}
          />
        ) : null}

        {panel === 'settings' ? (
          <SettingsPanel
            state={state}
            level={level.level}
            levelTitle={level.title}
            nextLeft={next?.left ?? null}
            onPatch={patch}
            onReset={reset}
            onClose={() => setPanel('none')}
          />
        ) : null}

        {/* 余额标与立绘**同轴上下排**（上面那颗标、下面那个她）。
            上一版是左右并排：而立绘四周自带一圈透明留白（当时裁得松，左右各约 11%），
            两个间距一叠，标离她的身体就有 40 多 px —— 读起来像两块互不相干的东西。
            立绘已经裁紧了，这里改成竖排，标直接落在她头顶；点开余额时面板又叠在
            标上面，整串从上到下贴着同一根轴。 */}
        <div className="flex flex-col items-end gap-2">
          <BalancePill
            balance={balance}
            tier={tier}
            showNumber={state.showNumber}
            loading={balanceLoading}
            onClick={() => setPanel(panel === 'balance' ? 'none' : 'balance')}
          />

          {/* 立绘本体。它是一个 button：键盘 Tab 得到、回车/空格就是摸头。
              不拦键盘、不换 DOM 结构，摸头之外不做任何事 —— 3 条自我约束里
              的"不抢焦点"就是这个意思 */}
          <button
            type="button"
            aria-label={`鲸娘：${level.title}。摸一下头，右键看菜单`}
            title={`${level.title} · Lv${level.level} · 好感度 ${state.affection}${next ? `（再 ${next.left} 到下一级）` : ''}`}
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
            className={cls(
              'pet-body relative block cursor-grab touch-none select-none active:cursor-grabbing',
              busy && 'pet-body-work',
            )}
            style={
              dragTilt !== null
                ? { transform: `rotate(${dragTilt}deg) scale(1.05)`, transition: 'none' }
                : { transition: 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)' }
            }
          >
            <Whale pose={pose} size={132} talk={Boolean(bubble)} />
            {/* 工作中：头上一圈淡蓝光晕 + 一枚文字标。不靠一个颜色单独表意 */}
            {busy && pose === 'work' ? <span className="pet-work-chip">工作中</span> : null}
          </button>
        </div>

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

/* ── 余额标 ────────────────────────────────────────────────────────── */

/**
 * 头顶那颗余额标。它是这个桌宠的"仪表"：
 *
 * · 关掉「余额显示数字」时只显示档位措辞（很充裕 / 还够用 / 快见底 / 已用尽），
 *   于是截图、录屏、投屏都不会带出金额 —— 参考项目那个取舍很值得抄；
 * · 颜色只是**加强**：每一档都带文字，色相本身不承担意思。
 */
function BalancePill({
  balance,
  tier,
  showNumber,
  loading,
  onClick,
}: {
  balance: ReturnType<typeof usePetBalance>['balance'];
  tier: ReturnType<typeof balanceTier>;
  showNumber: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const tone = TIER_TONE[tier];
  const dot = tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'crit' ? 'bg-crit' : 'bg-faint';
  /* 没配 Key 与"还没读回来"是两回事，别让它们共用一句"待读取" ——
     前者要用户去改 .env，后者只要等一秒 */
  const text = !balance?.configured
    ? '未配 Key'
    : showNumber && balance?.total != null
      ? fmtMoney(balance.total, balance.currency)
      : TIER_LABEL[tier];

  /* 两处刻意的减法：
     · 去掉原来的 mb-3 —— 它是为了在"左右并排"时把标顶到她身体那一档高度，
       改成上下排之后只会把标从头顶推开；
     · 去掉 11px 的钱包图标 —— 这个尺寸下它糊成一根竖条，认不出是什么，
       而"这是一笔钱"其实不用图标说：¥ 号已经在金额里，没开数字时那一档
       本身就是措辞（很充裕 / 快见底）。留下的那颗档位色点才是真在读的东西。 */
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        balance?.configured
          ? `DeepSeek 余额：${TIER_LABEL[tier]}（点开看明细）`
          : '还没有配 DeepSeek 的 API Key（点开看怎么配）'
      }
      className="pet-pill inline-flex items-center gap-1.5 rounded-full border border-line bg-panel/90 py-0.5 pl-2 pr-2.5 text-2xs font-medium text-ink shadow-soft backdrop-blur transition-colors hover:border-faint"
    >
      <span aria-hidden className={cls('h-1.5 w-1.5 shrink-0 rounded-full', dot, loading && 'animate-pulse')} />
      {/* num：金额与档位都是"读数"，用等宽字体，数字跳动时不会左右晃 */}
      <span className="num">{text}</span>
    </button>
  );
}

/**
 * 档位 chip 的底色。走全站那四个语义色（见 TIER_TONE），不新造颜色 ——
 * 档位在标上、面板里、以及低余额提醒里必须是同一个绿/黄/红。
 */
const TIER_CHIP: Record<'ok' | 'warn' | 'crit' | 'neutral', string> = {
  ok: 'bg-ok-soft text-ink',
  warn: 'bg-warn-soft text-ink',
  crit: 'bg-crit-soft text-ink',
  neutral: 'bg-bg-2 text-muted',
};

/* ── 余额面板 ──────────────────────────────────────────────────────── */

function BalancePanel({
  balance,
  loading,
  threshold,
  showNumber,
  onRefresh,
  onClose,
}: {
  balance: ReturnType<typeof usePetBalance>['balance'];
  loading: boolean;
  threshold: number;
  showNumber: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const tier = balanceTier(balance, threshold);
  const max = Math.max(...(balance?.history ?? []).map((h) => h.total), 1);
  const runway = runwayText(balance);
  /* 关掉「显示余额数字」时，面板里**每一处**金额都得跟着藏 ——
     只藏上面那个大数，下面赠送/充值还挂着具体金额，等于没藏 */
  const money = (v: number | null) => (showNumber ? fmtMoney(v, balance?.currency ?? null) : '已隐藏');

  return (
    /* w-full：面板是**收缩宽度**的（外面那列是 items-end），
       不写满就会缩到最宽那一行正文的宽度 —— 下面那条柱子图是 flex-1，
       在收缩宽度里没有基准，整块会塌成一条线 */
    <section className="pet-panel w-full" aria-label="DeepSeek 余额">
      <header className="pet-panel-head">
        <Wallet size={13} aria-hidden className="text-accent" />
        <h3 className="flex-1 text-[12.5px] font-semibold text-ink">DeepSeek 余额</h3>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="刷新余额"
          className="rounded-field p-1 text-muted transition-colors hover:text-ink"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
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

      {!balance?.configured ? (
        <div className="space-y-2 p-3 text-[12px] leading-relaxed text-muted">
          <p className="text-ink">还没配 DeepSeek 的 API Key。</p>
          <p>
            在 <code className="num rounded-xs bg-bg-2 px-1 py-0.5 text-[11px]">.env</code> 里加上：
          </p>
          {/* 这里刻意把 Key 的**名字**写出来而不是"见文档" —— 配不上唯一的原因是
              不知道变量叫什么，而它本身不是秘密（秘密是它的值） */}
          <pre className="num overflow-x-auto rounded-field bg-bg-2 p-2 text-[11px] leading-5 text-ink">
{`DEEPSEEK_API_KEY=sk-xxx`}
          </pre>
          <p className="text-faint">
            Key 只在服务端使用，不会下发到浏览器。改完重启一次服务即可。
          </p>
        </div>
      ) : !balance.ok ? (
        <div className="space-y-1.5 p-3 text-[12px] leading-relaxed">
          <p className="text-crit">没读到余额</p>
          <p className="text-muted">{balance.error}</p>
          {/* 旧值还在就先摆出来：比一句"读取失败"有用得多 */}
          {balance.total != null ? (
            <p className="text-faint">
              上一次读到的是 {showNumber ? fmtMoney(balance.total, balance.currency) : TIER_LABEL[tier]}，
              取数时间 {new Date(balance.at).toLocaleTimeString('zh-CN', { hour12: false })}。
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {/* 大数 + 档位。档位做成**紧挨数字**的一枚 chip，不再右对齐飘在边上 ——
              在 268px 里把一个孤零零的词挂在右侧，它会被读成"另一列数据"，
              而它其实是这个数字的注解 */}
          <div className="flex items-center gap-2 px-3 pt-2.5">
            <span className="num text-xl font-semibold tracking-display text-ink">
              {showNumber ? fmtMoney(balance.total, balance.currency) : TIER_LABEL[tier]}
            </span>
            <span className={cls('rounded-full px-1.5 py-0.5 text-3xs font-medium', TIER_CHIP[TIER_TONE[tier]])}>
              {TIER_LABEL[tier]}
            </span>
          </div>

          {/* 今日消耗单独一行跟在余额下面：它本来就是余额的注脚（存量底下跟着流速）。
              原来它和"赠送 / 充值"并排在一张 dl 里，但两者量纲不同 —— 一个是流速、
              一个是存量构成，并排就会被拿来互相比；而且原来那格写的是
              「¥5.00 / ¥13.42」，一个斜杠塞两个数，看着像分数 */}
          <p
            className="px-3 pb-2 pt-0.5 text-2xs text-muted"
            title={balance.spend ? `消耗基准：${balance.spend.baselineDay}` : undefined}
          >
            {spendText(balance, showNumber)}
          </p>

          <dl className="grid grid-cols-2 gap-x-3 border-t border-line px-3 py-2 text-2xs">
            <div>
              <dt className="text-faint">赠送</dt>
              <dd className="num text-ink">{money(balance.granted)}</dd>
            </div>
            <div>
              <dt className="text-faint">充值</dt>
              <dd className="num text-ink">{money(balance.toppedUp)}</dd>
            </div>
          </dl>

          {/* 按今天的速度推算的可用天数。它**不是**余额的另一种写法：
              同样的 18 块钱，一天花 2 块能用一周，一天花 9 块只够两天 ——
              要不要充值看的是这个数，而不是余额本身。
              只在低于一周时才出现，免得天天挂着让人麻木 */}
          {runway ? (
            <p className="mx-3 mb-2 rounded-field bg-warn-soft px-2 py-1 text-2xs text-ink">
              {runway}
            </p>
          ) : null}

          {/* 最近两周的读数。柱子从 0 到这几天的最大值 —— 余额是同一个量纲，
              用绝对高度比才看得出"下去了一截"。
              两端各标一个日期、底下补一条基线：没有参照物的一排柱子只是
              "有些高低"，读不出它在讲哪一段时间 */}
          {balance.history.length > 1 ? (
            <div className="border-t border-line px-3 py-2">
              <div className="mb-1.5 flex items-baseline justify-between gap-2 text-3xs text-faint">
                <span>最近 {balance.history.length} 天</span>
                <span className="num">
                  {balance.history[0].day.slice(5)} – {balance.history[balance.history.length - 1].day.slice(5)}
                </span>
              </div>
              <div className="flex h-9 items-end gap-[3px] border-b border-line" aria-hidden>
                {balance.history.map((h) => (
                  <span
                    key={h.day}
                    /* 悬停才给金额：藏起数字时连这里也一起藏，
                       否则鼠标一停就把"已隐藏"的金额又漏出去了 */
                    title={showNumber ? `${h.day} · ${fmtMoney(h.total, balance.currency)}` : h.day}
                    className="min-h-[2px] flex-1 rounded-t-xs bg-accent/70"
                    style={{ height: `${Math.max(4, (h.total / max) * 100)}%` }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="border-t border-line px-3 py-2 text-3xs text-faint">
              余额每天记一笔，攒够两天就能看到趋势。
            </p>
          )}

          <footer className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-3xs text-faint">
            <span>
              取数 {new Date(balance.at).toLocaleTimeString('zh-CN', { hour12: false })}
              {balance.isAvailable === false ? ' · 已不可用' : ''}
            </span>
            <span className="text-muted">阈值 {fmtMoney(threshold, balance.currency)}</span>
          </footer>
        </>
      )}
    </section>
  );
}

/* ── 右键菜单 ──────────────────────────────────────────────────────── */

function PetMenu({
  state,
  checkedIn,
  onFeed,
  onPraise,
  onCheckIn,
  onBalance,
  onSettings,
  onHome,
  onHide,
}: {
  state: PetState;
  checkedIn: boolean;
  onFeed: () => void;
  onPraise: () => void;
  onCheckIn: () => void;
  onBalance: () => void;
  onSettings: () => void;
  onHome: () => void;
  onHide: () => void;
}) {
  return (
    <div role="menu" aria-label="鲸娘的菜单" className="pet-panel w-[190px] p-1">
      <MenuItem icon={<Utensils size={13} />} onClick={onFeed} hint={`${state.food} 块`}>
        投喂点心
      </MenuItem>
      <MenuItem icon={<Sparkles size={13} />} onClick={onPraise}>
        夸夸她
      </MenuItem>
      <MenuItem icon={<CalendarCheck size={13} />} onClick={onCheckIn} hint={checkedIn ? `已签 · ${state.streak} 天` : `连续 ${state.streak} 天`}>
        每日签到
      </MenuItem>
      <div aria-hidden className="my-1 h-px bg-line" />
      <MenuItem icon={<Wallet size={13} />} onClick={onBalance}>
        看 DeepSeek 余额
      </MenuItem>
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
  level,
  levelTitle,
  nextLeft,
  onPatch,
  onReset,
  onClose,
}: {
  state: PetState;
  level: number;
  levelTitle: string;
  nextLeft: number | null;
  onPatch: (mutate: (prev: PetState) => PetState) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [confirmReset, setConfirmReset] = useState(false);

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

        <Row label="主动闲聊" hint="5–8 分钟一次；忙着的时候不开口">
          <Toggle checked={state.chatter} onChange={(v) => onPatch((p) => ({ ...p, chatter: v }))} label="主动闲聊" />
        </Row>

        <Row label="点击特效" hint="摸头飞出的爱心与星星">
          <Toggle
            checked={state.particles}
            onChange={(v) => onPatch((p) => ({ ...p, particles: v }))}
            label="点击特效"
          />
        </Row>

        <Row label="深夜静音" hint="23:00–6:00 不主动搭话（你摸她还是会应）">
          <Toggle checked={state.quiet} onChange={(v) => onPatch((p) => ({ ...p, quiet: v }))} label="深夜静音" />
        </Row>

        <div aria-hidden className="my-2 h-px bg-line" />

        <Row label="余额关心" hint="按时读 DeepSeek 余额，见底时举牌提醒">
          <Toggle
            checked={state.watchBalance}
            onChange={(v) => onPatch((p) => ({ ...p, watchBalance: v }))}
            label="余额关心"
          />
        </Row>

        <Row label="显示余额数字" hint="关掉只显示档位措辞，截图不泄露金额">
          <Toggle
            checked={state.showNumber}
            onChange={(v) => onPatch((p) => ({ ...p, showNumber: v }))}
            label="显示余额数字"
          />
        </Row>

        <label className="flex items-center justify-between gap-2 py-1.5">
          <span className="text-[12px] text-ink">低余额阈值</span>
          <Input
            type="number"
            min={0}
            step={1}
            value={String(state.lowThreshold)}
            onChange={(e) => {
              const v = Number(e.target.value);
              onPatch((p) => ({ ...p, lowThreshold: Number.isFinite(v) ? Math.max(0, v) : p.lowThreshold }));
            }}
            className="num w-20 px-2 py-1 text-right text-[12px]"
          />
        </label>
        <p className="pb-1 text-3xs text-faint">低于这个数就要提醒你。档位（够用 / 见底）也是按它算的。</p>

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

        <div aria-hidden className="my-2 h-px bg-line" />

        <div className="space-y-1 pb-1">
          <p className="text-[12px] text-ink">
            Lv{level} · {levelTitle}
          </p>
          <p className="text-3xs text-faint">
            好感度 {state.affection} · 摸头 {state.pats} 次 · 连续签到 {state.streak} 天 · 点心 {state.food}
            {nextLeft !== null ? ` · 再 ${nextLeft} 到下一级` : ' · 已满级'}
          </p>
          <p className="text-3xs text-faint">
            从 {new Date(state.since).toLocaleDateString('zh-CN')} 开始陪着你
          </p>
        </div>

        {state.diary.length ? (
          <div className="space-y-1 border-t border-line pt-2">
            <p className="text-2xs font-medium text-muted">成长日记</p>
            {state.diary.slice(0, 5).map((d) => (
              <p key={`${d.at}-${d.text}`} className="text-3xs text-faint">
                <span className="num">{new Date(d.at).toLocaleDateString('zh-CN')}</span> {d.text}
              </p>
            ))}
          </div>
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
              重置养成数据
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-[12px] text-ink">{label}</p>
        {hint ? <p className="text-3xs leading-snug text-faint">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
