import { useEffect, useRef, useState } from 'react';
import {
  Armchair,
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  GripVertical,
  LayoutGrid,
  Link2,
  RefreshCw,
  RotateCcw,
  Users,
} from 'lucide-react';
import {
  api,
  type OfficeBoard,
  type OfficeEmployee,
  type OfficeRoster,
  type OfficeSession,
  type OfficeUsage,
} from '@/lib/api';
import { useStore } from '@/lib/store';
import { cls } from '@/lib/format';
import { Button, buttonClass, Card, Empty, Input, Led, PageHead, Skeleton, Spinner } from '@/components/ui';
import { Stat } from '@/components/bits';
import { BoardPanel, EmployeeDesk, FacilitiesPanel, SessionsPanel, StarPanel, TokenPanel, VacantDesk } from '@/components/office';
import { SeatModal, SessionModal } from '@/components/seat-detail';

/**
 * 智能办公室里那几块**可摆放**的面板 —— 也就是两侧那两条边栏里的东西。
 *
 * 「办公室」工位墙不在其中：它钉在三列的正中间（工位是横版场景，要摊得开），
 * 不参与边栏之间的拖拽。所以它没有 key，也不进 hermes.officeLayout ——
 * 旧值里若还留着 'office'，normalizeLayout 会当作"不认得的 key"丢掉。
 *
 * 存进设置的是 **key 而不是文案**：面板改标题、换顺序都不该让存过的布局失效。
 * 新增/下线面板时旧值要还能用，所以下面 normalizeLayout 会把认得的按原序排在前、
 * 不认得的丢掉、缺的按默认序补在后面 —— 界面自己知道补哪些，服务端不参与。
 */
const PANELS = [
  { key: 'sessions', name: '对话明细' },
  { key: 'usage', name: '今日消耗 Token' },
  { key: 'board', name: '全局待办工作表' },
] as const;

type PanelKey = (typeof PANELS)[number]['key'];

const PANEL_KEYS: PanelKey[] = PANELS.map((p) => p.key);
const PANEL_NAME: Record<PanelKey, string> = Object.fromEntries(PANELS.map((p) => [p.key, p.name])) as Record<
  PanelKey,
  string
>;

/** 摆放：左栏放明细（长清单），右栏放用量与待办（读数与小列表） */
type PanelLayout = { left: PanelKey[]; right: PanelKey[] };

/** 一块面板的位置：哪条边栏（0 左 / 1 右）+ 栏内第几块 */
type Pos = { col: 0 | 1; i: number };

/** 默认：左栏只有明细一条长清单，右栏用量与待办自上而下 */
const DEFAULT_LAYOUT: PanelLayout = { left: ['sessions'], right: ['usage', 'board'] };

/**
 * 把存下来的摆放补成完整的一份。
 *
 * 三件事，缺一不可：丢掉不认识的 key（对面下线了某个面板 —— 「办公室」改成
 * 钉在中间那列之后，也是这么从旧值里消失的）、一块面板不能同时出现在两条边栏
 * （否则 React 会拿同一个 key 渲染两次，页面上出现一块重复的面板）、缺的按
 * 默认摆法补回**它原本该在的那条边栏**（补到另一条去会让存过的布局在一次
 * 升级后悄悄变形）。
 */
function normalizeLayout(raw: unknown): PanelLayout {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const seen: PanelKey[] = [];
  const pick = (arr: unknown) => {
    const out: PanelKey[] = [];
    if (!Array.isArray(arr)) return out;
    for (const v of arr) {
      const k = String(v ?? '') as PanelKey;
      if (PANEL_KEYS.includes(k) && !seen.includes(k)) {
        seen.push(k);
        out.push(k);
      }
    }
    return out;
  };
  const left = pick(src?.left);
  const right = pick(src?.right);
  for (const k of DEFAULT_LAYOUT.left) if (!seen.includes(k)) left.push(k);
  for (const k of DEFAULT_LAYOUT.right) if (!seen.includes(k)) right.push(k);
  return { left, right };
}

/** 读到的次序 = 左栏自上而下 + 右栏自上而下。槽位号（1 起）按它算 */
const readingOrder = (l: PanelLayout): PanelKey[] => [...l.left, ...l.right];

/** 读到的第 flatIndex 块，在哪条边栏、栏内第几块 */
function flatToPos(l: PanelLayout, flatIndex: number): { col: 0 | 1; i: number } {
  return flatIndex < l.left.length ? { col: 0, i: flatIndex } : { col: 1, i: flatIndex - l.left.length };
}

/** 把 from 那一块挪到 to 那个位置（可跨栏；下标越界会自动夹到合法范围） */
function movePanel(l: PanelLayout, from: { col: 0 | 1; i: number }, to: { col: 0 | 1; i: number }): PanelLayout {
  const next: PanelLayout = { left: [...l.left], right: [...l.right] };
  const [item] = next[from.col === 0 ? 'left' : 'right'].splice(from.i, 1);
  const target = to.col === 0 ? 'left' : 'right';
  next[target].splice(Math.max(0, Math.min(next[target].length, to.i)), 0, item);
  return next;
}

const sameLayout = (a: PanelLayout, b: PanelLayout) =>
  a.left.length === b.left.length && a.right.length === b.right.length && a.left.every((k, i) => k === b.left[i]) && a.right.every((k, i) => k === b.right[i]);

/**
 * 智能办公室：把局域网里那台 Hermes「Agent Office」搬进工作台。
 *
 * ── 摆放：三列，中间是工位墙，两边两条边栏可以改 ────────────────────
 * 统计数字（工位总数 / 在编 / 待入驻 / 在线）横在最上面，它下面是三列：
 * **左栏（窄）本月之星 + 对话明细 ｜ 中间（宽）办公室工位墙 + 它正下方的
 * 办公设施 ｜ 右栏（窄）今日消耗 Token + 全局待办工作表**。两条边栏里那三块
 * 面板的摆放存在设置里（`hermes.officeLayout`），页面右上「编辑布局」进
 * 编辑态：按住面板上方那条窄条拖走，或按前移/后移，可跨栏，落手即生效。
 *
 * 工位墙（和它下面那条办公设施）为什么不参与摆放：它们是这一页的主体
 * （另外三块都是"顺带看一眼"的事），而且工位墙是一面**横着摊开**的墙 ——
 * 挤进边栏里要么人缩小到看不清、要么把边栏撑变形。钉在正中间它才拿得到
 * 这条最宽的轨道。三列在 1280 以下收成一列（边栏插到墙后面去），手机上是
 * "墙 → 设施 → 明细 → 用量 → 待办"。
 *
 * 为什么是显式两条边栏、而不是一个顺序数组按对半切：两条边栏数量可以不等
 * （1+2），数组切不出这个，只能靠"前一半/后一半"的硬规则 —— 那规则下用户
 * 把某块从最末位往前挪一位就换栏了，位置不跟手。
 *
 * 两条边栏宽度不同（左 300 / 右 360）是有理由的：明细每行是"来源 + 标题 +
 * 时间"三件事挤一行，标题要留得下几个字；右栏那两块都是紧凑的读数与短列表，
 * 窄一点更好读。中间那条 `1fr` 把剩下的全吃掉。
 *
 * 右栏**不拉伸**（self-start + 吸顶）：它比中间那列矮得多，跟着拉齐会在卡里
 * 空出一大片。改成滚到哪儿都钉在右上 —— 往下读工位墙与明细时，用量与待办
 * 一直在视野里，那块空白也就不再是"缺了一块"，而是有用的常驻。
 *
 * 数据来源分两类：工位状态（含在线标记）走免登录接口，立绘与其余三块都在
 * 登录墙后面（服务端用自己的会话代取，见 services/office.js）。所以它们
 * **分开加载、各自报错**：口令没配时工位照样画得出来，只是立绘与那几块会
 * 说明原因 —— 而不是整页变黑，让人以为连工位都挂了。
 *
 * ── 刷新 ──────────────────────────────────────────────────────────────
 * 工位状态是网关周期性探测的结果（`checkedAt` 就是它那一刻），跟着全站的
 * refreshSeconds 对一次即可；切回窗口时立刻对一次，免得看到的是离开之前的状态。
 * 下面三块的节奏与工位一致 —— 明细、用量与待办都是分钟级变化，更密没有意义。
 */
export default function Office() {
  const { settings, saveSettings } = useStore();
  const [roster, setRoster] = useState<OfficeRoster | null>(null);
  const [board, setBoard] = useState<OfficeBoard | null>(null);
  const [usage, setUsage] = useState<OfficeUsage | null>(null);
  const [sessions, setSessions] = useState<OfficeSession[] | null>(null);
  /** 工位这一路的错误：它读不到就是页面级的事（地址错 / 机器关机） */
  const [error, setError] = useState('');
  /* 右栏三块各自记自己的错：一块坏了不该把另外两块一起变成错误块 */
  const [boardError, setBoardError] = useState('');
  const [usageError, setUsageError] = useState('');
  const [sessionsError, setSessionsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** 点开的是哪位员工的详情（弹窗里带页签：配置文档 / 技能 / 进化档案 / 记录 / 即时交互） */
  const [detailWith, setDetailWith] = useState<OfficeEmployee | null>(null);
  const [viewSession, setViewSession] = useState<OfficeSession | null>(null);

  /** 「打开完整办公室」跳去哪。留空 = 用服务端 .env 那份 */
  const savedOfficeUrl = settings?.hermes?.officeUrl?.trim() || '';
  const officeUrl = savedOfficeUrl || roster?.baseUrl || '';
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');

  /* ── 面板摆放（可拖拽换位置、可跨栏） ──────────────────────────────── */
  /**
   * 刚挪完、还没落库的那一份摆放。
   *
   * 存设置是一次网络往返，"存完才动"会让卡片先弹回原位、过一会儿再跳过去 ——
   * 看着就像拖不动（这一页当初就是这么被反馈的）。所以先动、再落库：
   * 落库成功时两者相等（界面不跳），失败就退回服务端那一份。
   */
  const [optimistic, setOptimistic] = useState<PanelLayout | null>(null);
  const stored = normalizeLayout(settings?.hermes?.officeLayout);
  /** 界面上真正用的一份：本地刚挪的优先 */
  const layout = optimistic ?? stored;
  /* 服务端那份追上本地那份（落库回来了）就把本地覆盖撤掉。不直接在
     persistLayout 里清：那一刻 store 未必已经应用了新设置，清早了要闪一下 */
  useEffect(() => {
    if (optimistic && sameLayout(stored, optimistic)) setOptimistic(null);
  }, [stored, optimistic]);
  /** 拖动过程中不重挂监听器，所以摆放要走 ref 读 —— 存成功之前它不会变 */
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [editingLayout, setEditingLayout] = useState(false);
  /** 拖动中：from 是正被拖的那块，to 是准备落下的位置（列 + 列内下标） */
  const [drag, setDrag] = useState<{ from: Pos; to: Pos } | null>(null);
  const dragRef = useRef<{ from: Pos; to: Pos } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** 刚挪过的那一块：键盘挪完看不见落点，得有句回执（拖动时靠高亮已经够了） */
  const [movedNote, setMovedNote] = useState('');
  /** 读到的次序（左列读完再读右列）：槽位号与"前后移"都按它算 */
  const order = readingOrder(layout);
  const isDefaultLayout = sameLayout(layout, DEFAULT_LAYOUT);

  const interval = Math.max(30, settings?.refreshSeconds ?? 60);

  const reason = (r: PromiseSettledResult<unknown>, fallback: string) =>
    r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : fallback) : '';

  async function refresh(manual = false) {
    if (manual) setBusy(true);
    /* allSettled 而不是 all：四路互相独立，一路失败不该让另外三路的结果丢掉 */
    const [rosterRes, boardRes, usageRes, sessionsRes] = await Promise.allSettled([
      api.office.roster(),
      api.office.board(),
      api.office.usage(),
      api.office.sessions(16),
    ]);

    if (rosterRes.status === 'fulfilled') {
      setRoster(rosterRes.value);
      setError('');
    } else {
      setError(reason(rosterRes, '读取工位状态失败'));
    }
    if (boardRes.status === 'fulfilled') setBoard(boardRes.value);
    if (usageRes.status === 'fulfilled') setUsage(usageRes.value);
    if (sessionsRes.status === 'fulfilled') setSessions(sessionsRes.value.data);
    setBoardError(reason(boardRes, '读取待办工作表失败'));
    setUsageError(reason(usageRes, '读取用量失败'));
    setSessionsError(reason(sessionsRes, '读取对话明细失败'));

    setLoading(false);
    setBusy(false);
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), interval * 1000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [interval]);

  /**
   * 拖动过程中：算落点，落下就存。
   *
   * 落点怎么算：先看指针压在哪条**边栏**上，再在栏里按 y 找"该插在第几块
   * 之前"，最后换算成全局槽位。用**槽位**而不是"目标元素"表达，是为了能接住
   * "拖到某一栏最下面"这种没有元素可指的落点。
   *
   * 为什么不按 x 对半切：中间那列工位墙夹在两条边栏之间，网格的左半 ≠ 左栏。
   * 改成"点在不在这一栏的框里"之后，并排时它等价于按 x 分左右、窄屏上三列
   * 竖着堆时等价于按 y 分上下，一套判定两边都对。
   *
   * 拖动期间**不重排 DOM**（只高亮目标槽）：边拖边排会让命中判定一直追着
   * 移动的卡片跑，指针底下那张卡反复变，人到最后也不知道自己拖的是哪一块。
   */
  useEffect(() => {
    if (!drag) return;

    /** 指针落在哪条边栏、栏内第几块之前。允许"栏末尾"（插到该栏最后） */
    const slotAt = (x: number, y: number): Pos => {
      const grid = gridRef.current;
      if (!grid) return drag.to;
      const rails = [...grid.querySelectorAll<HTMLElement>('[data-col]')];
      if (!rails.length) return drag.to;
      const midX = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      /* 指针正压在中间那列工位墙上、落在栏与栏之间的缝里、或者压在一条已经被
         拖空的边栏上（它没有高度，框是空的）时，取横向最近的一条边栏：
         往中间拖的手感是"就近归入"，不会掉进一个没有落点的空洞。 */
      const hit =
        rails.find((el) => {
          const r = el.getBoundingClientRect();
          return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
        }) ?? rails.reduce((best, el) => (Math.abs(midX(el) - x) < Math.abs(midX(best) - x) ? el : best));
      const cards = [...hit.querySelectorAll<HTMLElement>('[data-slot]')];
      let i = cards.length;
      for (let k = 0; k < cards.length; k += 1) {
        const r = cards[k].getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          i = k;
          break;
        }
      }
      return { col: Number(hit.dataset.col) === 0 ? 0 : 1, i };
    };

    const onMove = (e: PointerEvent) => {
      /* 不 preventDefault 的话触屏上会跟着滚页面，拖不动 */
      e.preventDefault();
      const to = slotAt(e.clientX, e.clientY);
      const cur = dragRef.current;
      if (cur && (cur.to.col !== to.col || cur.to.i !== to.i)) {
        dragRef.current = { ...cur, to };
        setDrag(dragRef.current);
      }
    };
    const finish = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d || (d.to.col === d.from.col && d.to.i === d.from.i)) return;
      const cur = layoutRef.current;
      const name = PANEL_NAME[(d.from.col === 0 ? cur.left : cur.right)[d.from.i]];
      setMovedNote(`「${name}」挪到了${d.to.col === 0 ? '左' : '右'}栏第 ${d.to.i + 1} 位`);
      void persistLayout(movePanel(cur, d.from, d.to));
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    /* 只依赖 drag：拖动中 order 不会变，重挂监听器只会把正在拖的那一下打断 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  if (loading && !roster) return <OfficeSkeleton />;

  const seats = roster?.seats ?? null;
  const staffed = roster?.staffed ?? null;
  const vacant = roster?.vacant ?? null;
  const online = roster?.online ?? null;
  const items = roster?.items ?? [];
  /* 空位优先用网关给的数，它没给就按"总数 - 在编"补 */
  const emptySeats = Math.max(0, vacant ?? (seats != null && staffed != null ? seats - staffed : 0));
  const onlineRatio = staffed ? (online ?? 0) / staffed : 0;

  const openOffice = () => {
    if (officeUrl) window.open(officeUrl, '_blank', 'noopener,noreferrer');
  };

  /* 存完就收起：存失败时 saveSettings 会自己弹错误并返回 null，这里不关，
     让用户能接着改（地址校验是服务端做的，前端不重复一遍规则） */
  async function saveOfficeUrl(next: string) {
    const saved = await saveSettings({ hermes: { officeUrl: next.trim() } });
    if (saved) setEditingUrl(false);
  }

  /** 换完摆放：先动界面，再落库。落库失败 saveSettings 自己会弹错误，界面退回原样 */
  async function persistLayout(next: PanelLayout) {
    setOptimistic(next);
    const saved = await saveSettings({ hermes: { officeLayout: next } });
    if (!saved) setOptimistic(null);
  }

  /**
   * 按钮/键盘挪一块。参数是**读到的次序**里的位置，所以"往前移一位"跨列时
   * 也是连着的（左列末位往前挪一位就是换到右列/左列的首位）。
   * 挪完报一句 —— 键盘操作没有"落点高亮"这个视觉回执。
   */
  function shift(fromFlat: number, toFlat: number) {
    if (toFlat < 0 || toFlat >= order.length || toFlat === fromFlat) return;
    const next = movePanel(layout, flatToPos(layout, fromFlat), flatToPos(layout, toFlat));
    const at = readingOrder(next).indexOf(order[fromFlat]);
    setMovedNote(
      `「${PANEL_NAME[order[fromFlat]]}」现在是第 ${at + 1} 块（${flatToPos(next, at).col === 0 ? '左' : '右'}栏）`,
    );
    void persistLayout(next);
  }

  /** 按下把手只记起点，落在哪由窗口上的 pointermove 算（手会移出这条窄条） */
  function startDrag(at: Pos) {
    return (e: React.PointerEvent<HTMLElement>) => {
      /* 只吃主键与触摸：右键拖动是"打开菜单"，别把它变成排序 */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { from: at, to: at };
      setDrag({ from: at, to: at });
      setMovedNote('');
    };
  }

  /**
   * 工位墙：钉在三列的正中间，不参与拖拽摆放。
   *
   * **不挂 flex-1**：三列的高度由最高的那一列决定，而左右两条边栏都是长清单
   * （十几条会话、五条定时任务），中间这列几乎总是矮的那条。卡片一拉齐到行高，
   * 工位下面就会空出一大片 —— 那看起来像"卡里缺了一块"。让余量落回页面底色
   * 上：那一列到此为止，是正常的留白。
   */
  function renderOffice() {
    return (
      <Card>
        <h2 className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-semibold">
          办公室
          <span className="text-2xs font-normal text-muted">
            {staffed ?? 0} 位在编{emptySeats ? `，${emptySeats} 个空位` : ''} · 点一位就能说话
          </span>
        </h2>
        {/* 列数跟着**中间这一列的可用宽度**走，而不是跟着窗口：三列版里它拿到的是
            剩下的那部分（本页 max-w 1600，减去两条边栏各 300 / 360 与两道缝之后
            还剩 850 上下）。xl 上它 530~850，两列每张 260~420（工位里的名牌、
            显示器都读得清）；到 2xl 摊三列每张 280 上下，一屏能多放一位。
            窄屏（sm~xl）三列收成一列，这一列就是整幅页面宽，两列也宽裕；
            手机一列 —— 工位是横版场景，手机两列会把里面的人缩得看不清。 */}
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {items.map((e) => (
            <li key={e.id}>
              <EmployeeDesk employee={e} onOpen={() => setDetailWith(e)} />
            </li>
          ))}
          {Array.from({ length: emptySeats }, (_, i) => (
            <li key={`vacant-${i}`}>
              <VacantDesk index={i} />
            </li>
          ))}
        </ul>

        {roster?.unknown?.length ? (
          <p className="mt-3 text-2xs text-warn">
            网关回来了 {roster.unknown.length} 个档案里没有的员工（{roster.unknown.join('、')}）——
            对面加了人，服务端的档案表还没跟上，那几位不会出现在这儿。
          </p>
        ) : null}

        {!roster?.credentials ? (
          <p className="mt-3 text-2xs leading-relaxed text-faint">
            服务端还没配 Hermes 口令（.env 里的 HERMES_USER / HERMES_PASSWORD），所以立绘取不到、
            明细、待办与用量也读不了 —— 工位状态是免登录的，不受影响。
          </p>
        ) : null}
      </Card>
    );
  }

  /**
   * 两条边栏里的一块面板。grow 只给**每栏最后一块**：三条列的底边要齐平，
   * 而三列的内容高矮由数据定（工位数、任务数、会话数），先靠条数把三列调到
   * 大致一样高，剩下那几十像素由每列最后一张卡吃掉。
   *
   * 为什么不让每张卡都长：中间那列的第一张是工位墙，它一旦拉齐到行高，工位
   * 底下就会空出一大片（那正是被反馈过的问题）。收口的只放一张卡，而且
   * 各卡把余量分摊在自己内部（待办分到清单中间、设施分到标题与格子之间），
   * 不落在卡底。
   */
  function renderPanel(key: PanelKey, grow: boolean) {
    /* flex-auto（flex: 1 1 auto）而不是 flex-1：flex-1 的基准是 **0**，一张卡
       在网格算"这一列该多高"时贡献就近乎 0，整行被算矮、三列各自溢出到自己的
       自然高度 —— 底边于是参差（这就是"还是有留白"的原因）。basis 取内容高
       之后，行高 = 最高的那一列，其余两列再长出来补齐。 */
    const growCls = grow ? 'flex-auto' : undefined;
    if (key === 'board') return <BoardPanel board={board} error={boardError} className={growCls} />;
    if (key === 'usage') return <TokenPanel usage={usage} error={usageError} className={growCls} />;
    return <SessionsPanel sessions={sessions} error={sessionsError} onOpen={setViewSession} className={growCls} />;
  }

  /**
   * 一条边栏（0 左 / 1 右），里面是它那几个面板 + 编辑态的手柄。
   *
   * 栏本身带 `data-col`：拖动时"指针压在哪一栏上"就是读它（见上面那段
   * pointermove），所以工位墙那列**不能**有这个属性 —— 那会让落点判定
   * 认出一栏根本放不了东西的地方。
   */
  function renderRail(col: 0 | 1, head?: React.ReactNode) {
    const keys = col === 0 ? layout.left : layout.right;
    /* 槽位号按"读到的次序"（左栏读完再读右栏），编辑态里那个 N 就是它 */
    const flatBase = col === 0 ? 0 : layout.left.length;
    return (
      <div
        data-col={col}
        /* 不挂 self-start、也不吸顶：这两条边栏现在的目标是"底边与中间那列齐平"，
           所以要让它们跟着行高拉伸，再由栏里最后一张卡吃掉余量。以前右栏短得多，
           靠 self-start + 吸顶把空白"变成常驻"，现在三列同高，那段理由不成立了。 */
        className="flex flex-col gap-5"
      >
        {/* 栏头：钉在栏里、不参与摆放的那一块（左栏是本月之星）。
            它没有 data-slot，所以既拖不走、也不会成为落点 */}
        {head}
        {keys.map((key, i) => {
          const flat = flatBase + i;
          const name = PANEL_NAME[key];
          const here = { col, i } as const;
          /* 落点高亮：命中这块，或者要插到这一栏的末尾（就落在最后一块上） */
          const isTarget =
            !!drag && drag.to.col === col && (drag.to.i === i || (drag.to.i === keys.length && i === keys.length - 1));
          const isTail = !!drag && drag.to.col === col && drag.to.i === keys.length && i === keys.length - 1;
          return (
            <div key={key} data-slot={flat} className="flex flex-col gap-1.5">
              {editingLayout ? (
                /* 把手放在卡片**外面**的一条窄条里，而不是压在卡片右上角：
                   那几个位置已经有徽标（"16 条"、"无未闭环异常"），压上去
                   只能靠叠一层半透明底，读都读不清。
                   **整条都能拖**（不是只让那个 14px 的图标能抓）：手柄太小
                   在触屏上基本抓不住，那正是"编辑布局不好用"的来源。 */
                <div
                  onPointerDown={(e) => {
                    /* 箭头按钮（data-arrow）上按下来是"移一位"，不是拖动 */
                    if ((e.target as HTMLElement).closest('button[data-arrow]')) return;
                    startDrag(here)(e);
                  }}
                  className={cls(
                    'flex cursor-grab touch-none items-center gap-1.5 rounded-field border border-dashed px-2 py-1.5 transition-colors active:cursor-grabbing',
                    isTarget ? 'border-accent bg-accent/10' : 'border-line bg-bg-2/70',
                    drag?.from.col === col && drag?.from.i === i && 'opacity-50',
                  )}
                >
                  {/* 这个按钮只负责键盘：Tab 过来按 ← → 就能换位置（手柄本身
                      不再单独吃指针事件 —— 手势统一交给上面整条） */}
                  <button
                    type="button"
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') shift(flat, flat - 1);
                      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') shift(flat, flat + 1);
                    }}
                    title="拖动这条窄条换位置；键盘上按 ← → 也行"
                    aria-label={`移动「${name}」：按住这条拖动，或用左右方向键（当前${col === 0 ? '左' : '右'}栏第 ${i + 1} 位，读到的次序第 ${flat + 1} 块，共 ${order.length} 块）`}
                    className="rounded-xs text-muted transition-colors hover:text-ink"
                  >
                    <GripVertical size={15} aria-hidden />
                  </button>
                  <span className="text-2xs text-muted">
                    {flat + 1}. {name}
                    {isTail ? <span className="text-accent"> · 放到这栏末尾</span> : null}
                  </span>
                  {/* 拖拽之外的第二条路：手指/鼠标不方便拖时，这两个按钮
                      同样能换位置（并且有 aria-label 念得出来） */}
                  <span className="ml-auto flex items-center gap-0.5">
                    <button
                      type="button"
                      data-arrow
                      disabled={flat === 0}
                      aria-label={`把「${name}」往前移`}
                      onClick={() => shift(flat, flat - 1)}
                      className="rounded-xs p-1 text-muted transition-colors hover:text-ink disabled:opacity-30"
                    >
                      <ArrowLeft size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      data-arrow
                      disabled={flat === order.length - 1}
                      aria-label={`把「${name}」往后移`}
                      onClick={() => shift(flat, flat + 1)}
                      className="rounded-xs p-1 text-muted transition-colors hover:text-ink disabled:opacity-30"
                    >
                      <ArrowRight size={13} aria-hidden />
                    </button>
                  </span>
                </div>
              ) : null}

              {renderPanel(key, i === keys.length - 1)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5">
      <PageHead
        title="智能办公室"
        hint={
          roster
            ? `Hermes 智能员工办公室（${roster.baseUrl}${roster.gatewayVersion ? ` · 网关 ${roster.gatewayVersion}` : ''}）。工位 ${interval} 秒对一次；点员工可以直接说话。`
            : 'Hermes 智能员工办公室：工位、待办与用量。'
        }
        actions={
          <>
            {/* 面板换位置：编辑态才出现手柄，平时不占版面 */}
            <Button
              variant={editingLayout ? 'primary' : 'soft'}
              size="sm"
              aria-pressed={editingLayout}
              onClick={() => {
                setEditingLayout((v) => !v);
                setMovedNote('');
              }}
              title="拖动面板换位置"
            >
              <LayoutGrid size={13} aria-hidden />
              {editingLayout ? '完成' : '编辑布局'}
            </Button>
            {editingLayout && !isDefaultLayout ? (
              <Button
                variant="ghost"
                size="sm"
                title="恢复默认排列"
                onClick={() => {
                  setMovedNote('已恢复默认排列');
                  void persistLayout(DEFAULT_LAYOUT);
                }}
              >
                <RotateCcw size={13} aria-hidden />
                默认排列
              </Button>
            ) : null}
            <Button variant="soft" size="sm" disabled={busy} onClick={() => void refresh(true)}>
              {busy ? <Spinner /> : <RefreshCw size={13} />}
              {busy ? '刷新中…' : '刷新'}
            </Button>
            {officeUrl ? (
              <>
                {/* 这一格的地址可以自己改见下面的编辑条：同一台机器在内网里
                    常有多个入口（IP / 主机名 / 反代域名），默认那个未必顺手 */}
                <Button
                  variant="soft"
                  size="sm"
                  onClick={() => {
                    setUrlDraft(savedOfficeUrl);
                    setEditingUrl((v) => !v);
                  }}
                  title={savedOfficeUrl ? `自定义地址：${savedOfficeUrl}` : '自定义「打开完整办公室」的地址'}
                  aria-expanded={editingUrl}
                >
                  <Link2 size={13} aria-hidden />
                  链接
                </Button>
                <a href={officeUrl} target="_blank" rel="noreferrer noopener" className={buttonClass('primary', 'sm')}>
                  <ExternalLink size={13} aria-hidden />
                  打开完整办公室
                </a>
              </>
            ) : null}
          </>
        }
      />

      {/* 自定义地址条。收起时不占版面；展开时把当前值填进去，
          占位符就是服务端那份默认地址，空着保存即"回到默认" */}
      {editingUrl ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl2 border border-line bg-panel px-3 py-2.5">
          <label htmlFor="office-url" className="text-2xs text-muted">
            完整办公室地址
          </label>
          <Input
            id="office-url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder={roster?.baseUrl || 'http://…'}
            spellCheck={false}
            className="min-w-[14rem] flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveOfficeUrl(urlDraft);
              if (e.key === 'Escape') setEditingUrl(false);
            }}
          />
          <Button size="sm" onClick={() => void saveOfficeUrl(urlDraft)}>
            保存
          </Button>
          <Button
            variant="soft"
            size="sm"
            disabled={!savedOfficeUrl}
            title="改回服务端 .env 里配置的地址"
            onClick={() => void saveOfficeUrl('')}
          >
            恢复默认
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditingUrl(false)}>
            取消
          </Button>
        </div>
      ) : null}

      {/* 编辑提示。移动结果也报在这里：键盘挪完没有"落点高亮"这个视觉回执 */}
      {editingLayout ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl2 border border-line bg-panel px-3 py-2 text-2xs text-muted"
        >
          <span>按住面板上方那条窄条，拖到新位置（键盘：聚焦手柄后按 ← → ↑ ↓）。</span>
          <span className="text-faint">
            只挪两侧边栏里那三块清单，可跨栏；工位墙、办公设施与本月之星是钉住的。松手即生效，随后自动保存。
          </span>
          {movedNote ? <span className="font-medium text-accent">{movedNote}</span> : null}
        </p>
      ) : null}

      {error && !roster ? (
        <Card>
          <Empty
            title="连不上 Hermes 网关"
            hint={`${error}。地址在服务端 .env 的 HERMES_BASE_URL 里；那台机器关机、或地址变了都会走到这里。`}
            action={
              <Button size="sm" onClick={() => void refresh(true)}>
                重试
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="工位总数"
              value={seats ?? '—'}
              hint="网关登记的智能员工席位"
              tile="blue"
              icon={<Users size={18} />}
            />
            <Stat
              label="在编员工"
              value={staffed ?? '—'}
              hint={seats ? `已入驻 ${staffed ?? 0} / ${seats} 个工位` : '已入驻的智能员工'}
              tile="purple"
              icon={<Bot size={18} />}
              progress={seats ? (staffed ?? 0) / seats : 0}
            />
            <Stat
              label="待入驻"
              value={vacant ?? '—'}
              hint="还空着的工位"
              tile="orange"
              icon={<Armchair size={18} />}
            />
            <Stat
              label="在线"
              value={online ?? '—'}
              hint={staffed ? `${staffed} 位员工里 ${online ?? 0} 位在线` : '当前在线的员工'}
              /* 全员在线才是"正常"：少一个就该看一眼，所以满员给 ok、缺员给 warn */
              tone={onlineRatio === 1 ? 'ok' : onlineRatio > 0 ? 'warn' : 'crit'}
              tile="green"
              icon={
                <span className="grid place-items-center">
                  <Led tone={onlineRatio === 1 ? 'ok' : onlineRatio > 0 ? 'warn' : 'crit'} pulse />
                </span>
              }
              progress={onlineRatio}
            />
          </div>

          {/* 三列：左栏（窄）本月之星 + 明细 ｜ 中间（宽）工位墙 + 办公设施 ｜
              右栏（窄）用量与待办。两条边栏里那三块可以改（见 renderRail），
              栏头（本月之星）与中间那列都是钉住的。
              三列同高：行高由内容最高的那列定，另外两列拉齐，余量交给每列
              最后一张卡吃掉（见 renderPanel、FacilitiesPanel 的 className）——
              所以三列底边齐平，卡里也不会空出一块。 */}
          <div ref={gridRef} className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
            {/* 左栏：本月之星钉在最上面（它是个"人"，不跟那三张清单一起被摆放） */}
            {renderRail(0, <StarPanel roster={roster} board={board} />)}

            {/* 中间：工位墙 + 它下面的办公设施。这两块都不参与拖拽摆放
                （拖动时的落点判定只认两条边栏），所以不带 data-col；
                order-first 让窄屏（三列收成一列）时它排到最前 ——
                这一页的主体是这面墙，明细与用量都是"顺带看一眼" */}
            <div className="order-first flex flex-col gap-5 xl:order-none">
              {renderOffice()}
              {/* 办公设施钉在工位墙正下方：它讲的是"这间办公室里发生的事"，
                  跟工位墙是一体的一层，不跟着边栏那三块到处跑 */}
              <FacilitiesPanel
                roster={roster}
                board={board}
                usage={usage}
                error={usageError || boardError}
                /* 中间这列的收口卡：三列底边靠它对齐（余量落在标题与格子之间）。
                   必须是 flex-auto —— 理由见 renderPanel */
                className="flex-auto"
              />
            </div>

            {renderRail(1)}
          </div>
        </>
      )}

      {/* 弹窗放在最后一层：它们自己是 fixed 定位，与上面的布局无关 */}
      <SeatModal employee={detailWith} onClose={() => setDetailWith(null)} onOpenOffice={openOffice} />
      <SessionModal session={viewSession} onClose={() => setViewSession(null)} />
    </div>
  );
}

/** 骨架：形状照着真实布局摆（四个数 → 左本月之星 + 明细 ｜ 中工位墙 + 办公设施 ｜ 右用量 + 待办），数据到位时不跳 */
function OfficeSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-5" role="status" aria-busy="true">
      <Skeleton className="h-7 w-40 rounded-field" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px]" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
        {/* 左栏：本月之星（矮）+ 对话明细（长） */}
        <div className="space-y-5">
          <Skeleton className="h-[240px]" />
          <Skeleton className="h-[420px]" />
        </div>
        {/* 中列最高：工位墙两列排下来比两侧的清单长，它下面还有一条设施 */}
        <div className="space-y-5">
          <Skeleton className="h-[520px]" />
          <Skeleton className="h-[300px]" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-[200px]" />
          <Skeleton className="h-[280px]" />
        </div>
      </div>
      <span className="sr-only">正在读取工位状态…</span>
    </div>
  );
}
