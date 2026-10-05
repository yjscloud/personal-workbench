import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { ArrowLeft, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { useStore } from '@/lib/store';
import { api, type KnowledgeItem } from '@/lib/api';
import { Button, Card, Empty, PageHead } from '@/components/ui';
import { normalizeTitle } from '@/lib/wiki-link';
import { clamp, cls } from '@/lib/format';

/* ── 知识图谱 ─────────────────────────────────────────────────────────
   节点 = 文章 + 标签，边 = 共用标签 + 正文里的 `[[双链]]`。

   刻意**不用大模型抽实体关系**，理由不是省 token，而是：
   抽出来的边不可解释、两次跑结果还不一样。而"这两篇共用 PVE 标签"
   和"这篇正文里链了那篇"都是能指着说的关系 —— 图谱的价值在于
   看清自己写下的东西之间有什么联系，不是看模型觉得有什么联系。

   布局用 d3-force，但**一次性算完再画**：几百次迭代跑完只要几毫秒，
   而每帧 setState 会让 React 重渲染几百轮，反而不如直接摆到位。
   拖动之后补几十次迭代让周边重新排。 */

const W = 1100;
const H = 640;

/* 视图窗口：x/y 是左上角，w/h 是尺寸。**缩放 = 改 w/h**（见下面 viewBox 那段）。
   宽高比始终锁在 W:H，否则 viewBox 和元素的宽高比不一致，SVG 会留出letterbox。 */
type View = { x: number; y: number; w: number; h: number };
const VIEW_HOME: View = { x: 0, y: 0, w: W, h: H };

/**
 * 初始视图，同时也是「重置」的目标。
 *
 * 窄屏上把 1100×640 整张图压进 375px 宽，字号和节点半径会缩到 3~4px：
 * 标签读不出来、节点也点不准。所以手机上开局先按 1.8 倍放大一档
 * （居中裁到画面中央），用户还能用右上角的按钮继续调。
 */
function homeView(): View {
  if (typeof window === 'undefined' || window.innerWidth >= 640) return VIEW_HOME;
  const w = W / 1.8;
  const h = w * (H / W);
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
/* 缩放的上下界。留界是为了防止一滚就滚进"什么都没有"的空域里出不来 */
const MIN_W = W / 4; // 放大到 4 倍
const MAX_W = W * 2.5; // 缩小到 0.4 倍

type NodeKind = 'article' | 'tag';
type GNode = SimulationNodeDatum & {
  id: string;
  kind: NodeKind;
  label: string;
  type?: 'sop' | 'runbook' | 'excerpt';
  degree: number;
  r: number;
};
type GLink = SimulationLinkDatum<GNode> & { kind: 'tag' | 'wiki' };

const WIKI_RE = /\[\[([^\]\n]+)\]\]/g;

export default function KnowledgeGraph() {
  const { ready } = useStore();
  const navigate = useNavigate();

  /* 图谱要把**所有**正文扫一遍找 [[双链]] —— 它是唯一一处真需要全量正文的
     地方，所以单独走 ?full=1：这一份流量只有进这一页的人才付，
     而不是每个页面都为它买单（列表和首屏已经不带正文了）。 */
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  useEffect(() => {
    let alive = true;
    api.knowledge
      .listFull()
      .then((list) => {
        /* 回收站里的条目不上图。?full=1 是整份下发（软删除的也在里面），
           而图谱画的是"知识库现在有什么" —— 把删掉的文章连它的双链一起
           画出来，等于告诉人这些内容还在。恢复之后它们自然会回来 */
        if (alive) setItems(list.filter((k) => !k.deletedAt));
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wheelRef = useRef<((e: WheelEvent) => void) | null>(null);
  const nodesRef = useRef<GNode[]>([]);
  const simRef = useRef<Simulation<GNode, GLink> | null>(null);
  const dragRef = useRef<string | null>(null);
  const movedRef = useRef(false);
  const panRef = useRef<{ cx: number; cy: number; vx: number; vy: number } | null>(null);

  /* ── 视图变换（滚轮缩放 / 空白处平移）────────────────────────────────
     缩放做在 viewBox 上，不给 <g> 加 transform：viewBox 一变，线宽、字号、
     节点半径会跟着一起缩放，这正是"放大看细节"该有的样子；加 transform 的话
     还得逐个元素配 vector-effect 去抵消缩放，反而更绕。 */
  const [view, setView] = useState<View>(homeView);
  /* 同一份数据放两处：state 供渲染，ref 供事件回调读最新值 ——
     滚轮监听器只绑一次，闭包里读 state 会永远停在挂载那一刻 */
  const viewRef = useRef<View>(view);
  /* 「重置」的目标视图。窗口尺寸在一次会话里基本不变，量一次就够 */
  const home = useMemo(homeView, []);

  const applyView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  /** 以某个屏幕坐标为锚点缩放。factor > 1 = 放大 */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect?.width) return;
      const v = viewRef.current;
      const w = clamp(v.w / factor, MIN_W, MAX_W);
      const ratio = w / v.w;
      /* 锚点在缩放前后要停在同一个屏幕位置，否则放大时视野会往左上角溜走 */
      const ax = v.x + ((clientX - rect.left) / rect.width) * v.w;
      const ay = v.y + ((clientY - rect.top) / rect.height) * v.h;
      applyView({ x: ax - (ax - v.x) * ratio, y: ay - (ay - v.y) * ratio, w, h: v.h * ratio });
    },
    [applyView],
  );

  /** 以画布中心缩放。给按钮用 —— 滚轮不是人人都有，键盘用户更得靠它 */
  const zoomBy = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  const resetView = () => applyView(home);

  /**
   * svg 的 ref。用**回调 ref** 而不是 useRef + useEffect 挂滚轮监听：
   * 这个组件在 `ready === false` 时会提前 return，此时 `<svg>` 还没挂载，
   * 而 effect 的依赖没变就不会重跑 —— 监听会永远挂不上（滚轮毫无反应）。
   * 回调 ref 在节点真正挂载/卸载时触发，天然没有这个时序问题。
   *
   * 监听器必须是**原生**的 + `passive: false`：React 把 onWheel 挂到根容器上时
   * 用被动监听，里面调 preventDefault 不生效（控制台会警告），
   * 结果就是"一边缩放一边把整页滚下去"。
   */
  const attachSvg = useCallback(
    (el: SVGSVGElement | null) => {
      const prev = svgRef.current;
      if (prev && wheelRef.current) prev.removeEventListener('wheel', wheelRef.current);
      svgRef.current = el;
      if (!el) return;

      const onWheel = (e: WheelEvent) => {
        if (!e.deltaY) return;
        e.preventDefault();
        /* 指数缩放而不是线性步进：滚一格的视觉变化在任何缩放级别都差不多，
           线性步进则会越到边缘越迟钝。deltaY 的绝对值各设备差异很大，
           所以系数取得小。 */
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
      };
      wheelRef.current = onWheel;
      el.addEventListener('wheel', onWheel, { passive: false });
    },
    [zoomAt],
  );

  const graph = useMemo(() => {
    const nodes: GNode[] = [];
    const links: GLink[] = [];
    const byTitle = new Map(items.map((k) => [normalizeTitle(k.title), k.id]));

    /* 先算双链的度，节点半径要按它来定 */
    const wikiDeg = new Map<string, number>();
    const seen = new Set<string>();
    for (const k of items) {
      for (const m of String(k.body || '').matchAll(WIKI_RE)) {
        const to = byTitle.get(normalizeTitle(m[1]));
        // 指向自己不算关系，是笔误
        if (!to || to === k.id) continue;
        const key = [k.id, to].sort().join('~');
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: k.id, target: to, kind: 'wiki' });
        wikiDeg.set(k.id, (wikiDeg.get(k.id) ?? 0) + 1);
        wikiDeg.set(to, (wikiDeg.get(to) ?? 0) + 1);
      }
    }

    const tagCount = new Map<string, number>();
    for (const k of items) {
      // 同一篇里重复写同一个标签只算一条边
      for (const t of new Set(k.tags || [])) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
    for (const k of items) {
      for (const t of new Set(k.tags || [])) links.push({ source: k.id, target: `tag:${t}`, kind: 'tag' });
    }

    for (const k of items) {
      const degree = new Set(k.tags || []).size + (wikiDeg.get(k.id) ?? 0);
      nodes.push({
        id: k.id,
        kind: 'article',
        label: k.title,
        type: k.type,
        degree,
        r: 9 + Math.min(12, degree * 1.7),
      });
    }
    for (const [tag, n] of tagCount) {
      nodes.push({ id: `tag:${tag}`, kind: 'tag', label: tag, degree: n, r: 6 + Math.min(9, n * 1.9) });
    }

    return { nodes, links, isolated: nodes.filter((n) => n.kind === 'article' && n.degree === 0).length };
  }, [items]);

  useEffect(() => {
    if (!graph.nodes.length) return;
    /* 复制一份再交给 d3：它会往节点和链接上写 x/y/index，
       直接在 memo 的结果上改，下次重建会拿到脏数据 */
    const nodes = graph.nodes.map((n) => ({ ...n }));
    const links = graph.links.map((l) => ({ ...l }));
    nodesRef.current = nodes;

    const sim = forceSimulation<GNode, GLink>(nodes)
      .force(
        'link',
        forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance((l) => (l.kind === 'tag' ? 80 : 140))
          .strength(0.55),
      )
      .force('charge', forceManyBody().strength(-280))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide<GNode>().radius((d) => d.r + 18))
      .stop();

    for (let i = 0; i < 320; i += 1) sim.tick();
    setPos(Object.fromEntries(nodes.map((n) => [n.id, { x: n.x ?? W / 2, y: n.y ?? H / 2 }])));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [graph]);

  /* 拖动。位置直接写进 d3 的节点对象（fx/fy），松手后再补几十次迭代
     让周边重新排 —— 拖动过程中不迭代，不然整张图会在手底下乱窜。

     屏幕坐标 → SVG 用户坐标时必须带上当前视窗：放缩之后，"光标底下那个点"
     和平格按原始尺寸算出来的点已经不是同一个了，不带视窗拖节点会跑偏。 */
  const toSvg = (e: ReactPointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect?.width) return { x: 0, y: 0 };
    const v = viewRef.current;
    return {
      x: v.x + ((e.clientX - rect.left) / rect.width) * v.w,
      y: v.y + ((e.clientY - rect.top) / rect.height) * v.h,
    };
  };

  const onDown = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = id;
    movedRef.current = false;
    const node = nodesRef.current.find((n) => n.id === id);
    if (node) {
      const p = toSvg(e);
      node.fx = p.x;
      node.fy = p.y;
    }
  };

  const onMove = (e: ReactPointerEvent<SVGGElement>, id: string) => {
    if (dragRef.current !== id) return;
    movedRef.current = true;
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    const p = toSvg(e);
    node.fx = p.x;
    node.fy = p.y;
    setPos((prev) => ({ ...prev, [id]: p }));
  };

  const onUp = (id: string) => {
    if (dragRef.current !== id) return;
    dragRef.current = null;
    const node = nodesRef.current.find((n) => n.id === id);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    const sim = simRef.current;
    if (!sim) return;
    /* alpha 已经降到最小了，直接 tick 不会再动，先把温度抬起来 */
    sim.alpha(0.35);
    for (let i = 0; i < 70; i += 1) sim.tick();
    sim.stop();
    setPos(Object.fromEntries(nodesRef.current.map((n) => [n.id, { x: n.x ?? W / 2, y: n.y ?? H / 2 }])));
  };

  const pick = (n: GNode) => {
    if (movedRef.current) return; // 刚拖过，不算点击
    if (n.kind === 'tag') navigate(`/knowledge?tag=${encodeURIComponent(n.label)}`);
    else navigate(`/knowledge/${n.id}`);
  };

  /* 空白处拖动 = 平移。缩放之后没有平移基本没法用：
     放大看某个角落时，别处就再也够不着了。
     节点自己的 pointerdown 会 stopPropagation，所以拖节点不会误触发平移。 */
  const onCanvasDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { cx: e.clientX, cy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
  };

  const onCanvasMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!pan || !rect?.width) return;
    const v = viewRef.current;
    /* 用 pointerdown 时的起点算总位移（而不是逐帧累加），换算成 SVG 用户坐标：
       放大之后同样一段鼠标位移对应的画布距离更长，不换算就会"跟不上手" */
    applyView({
      ...v,
      x: pan.vx - ((e.clientX - pan.cx) / rect.width) * v.w,
      y: pan.vy - ((e.clientY - pan.cy) / rect.height) * v.h,
    });
  };

  const onCanvasUp = () => {
    panRef.current = null;
  };

  /* 带一点容差：放大再缩回来不可能精确回到 1100，严格相等会让「重置」
     按钮一直赖着不走 */
  const atHome = Math.abs(view.w - home.w) < 1 && Math.abs(view.x - home.x) < 1 && Math.abs(view.y - home.y) < 1;

  /** 高亮时用得到的邻居集合 */
  const neighbors = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const l of graph.links) {
      const a = String(l.source);
      const b = String(l.target);
      if (a === hover) set.add(b);
      if (b === hover) set.add(a);
    }
    return set;
  }, [hover, graph.links]);

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-[1720px]">
        <Card>
          <p className="text-xs text-faint">正在加载知识库…</p>
        </Card>
      </div>
    );
  }

  const articles = items.length;
  const tags = graph.nodes.filter((n) => n.kind === 'tag').length;
  const wikiLinks = graph.links.filter((l) => l.kind === 'wiki').length;

  return (
    <div className="mx-auto w-full max-w-[1720px] space-y-4">
      <button
        type="button"
        onClick={() => navigate('/knowledge')}
        className="inline-flex items-center gap-1.5 text-2xs font-medium text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={13} aria-hidden />
        知识库
      </button>

      <PageHead
        title="知识图谱"
        hint={`${articles} 篇文章 · ${tags} 个标签 · ${wikiLinks} 条双链。边只有两种来历：共用标签，或正文里写了 [[另一篇的标题]]。`}
      />

      {!articles ? (
        <Card>
          <Empty title="还没有文章" hint="先写几篇，图谱才有东西可连。" />
        </Card>
      ) : (
        <Card flush className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-2.5 text-2xs text-faint">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
              文章
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent-2)' }} />
              Runbook
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--muted)' }} />
              摘录
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-bg-3 ring-1 ring-line-strong" />
              标签
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-px w-5" style={{ background: 'var(--accent)' }} />
              双链
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-px w-5"
                style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--line-strong) 0 3px, transparent 3px 6px)' }}
              />
              共用标签
            </span>
            {/* 手机上既没有滚轮也没有双指缩放（只实现了单指平移），
                所以文案里得把右上角那排按钮也算进操作路径 */}
            <span className="ml-auto">右上角按钮或滚轮缩放、空白处拖动平移；拖节点重排，点文章进正文，点标签筛列表</span>
          </div>

          {/* 缩放做在 viewBox 上：w/h 一起变，里面的线宽、字号、节点半径自动跟着缩放 */}
          <div className="relative">
            <svg
              ref={attachSvg}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              className={cls('h-auto w-full touch-none select-none', panRef.current ? 'cursor-grabbing' : 'cursor-grab')}
              role="img"
              aria-label="知识图谱"
              onPointerDown={onCanvasDown}
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              onPointerCancel={onCanvasUp}
            >
              {graph.links.map((l, i) => {
                const a = pos[String(l.source)];
                const b = pos[String(l.target)];
                if (!a || !b) return null;
                const active = neighbors ? neighbors.has(String(l.source)) && neighbors.has(String(l.target)) : false;
                return (
                  <line
                    key={`${l.source}-${l.target}-${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={l.kind === 'wiki' ? 'var(--accent)' : 'var(--line-strong)'}
                    strokeWidth={active ? 2 : 1}
                    strokeDasharray={l.kind === 'wiki' ? undefined : '3 3'}
                    opacity={neighbors ? (active ? 0.85 : 0.12) : l.kind === 'wiki' ? 0.7 : 0.35}
                  />
                );
              })}

              {graph.nodes.map((n) => {
                const p = pos[n.id];
                if (!p) return null;
                const dim = neighbors ? !neighbors.has(n.id) : false;
                const isTag = n.kind === 'tag';
                /* 摘录用中性色，和知识库列表里那一条色保持一致 ——
                   同一类条目在两个视图里应该是同一个颜色 */
                const fill = isTag
                  ? 'var(--bg-3)'
                  : n.type === 'runbook'
                    ? 'var(--accent-2)'
                    : n.type === 'excerpt'
                      ? 'var(--muted)'
                      : 'var(--accent)';
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    className="cursor-pointer"
                    opacity={dim ? 0.22 : 1}
                    onPointerDown={(e) => onDown(e, n.id)}
                    onPointerMove={(e) => onMove(e, n.id)}
                    onPointerUp={() => onUp(n.id)}
                    onClick={() => pick(n)}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover(null)}
                  >
                    <circle r={n.r} fill={fill} stroke={isTag ? 'var(--line-strong)' : 'transparent'} strokeWidth={1.5} />
                    <text
                      y={n.r + 12}
                      textAnchor="middle"
                      className={cls('text-[10px]', isTag ? 'fill-[color:var(--faint)]' : 'fill-[color:var(--text)]')}
                    >
                      {n.label.length > 14 ? `${n.label.slice(0, 14)}…` : n.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* 滚轮不是人人都有（外接鼠标、键盘用户），所以缩放也得给按钮。
                「重置」只在视图动过之后才出现，平时不占位置 */}
            <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-field border border-line bg-panel">
              <ZoomBtn label="放大" onClick={() => zoomBy(1.3)}>
                <ZoomIn size={13} aria-hidden />
              </ZoomBtn>
              <ZoomBtn label="缩小" onClick={() => zoomBy(1 / 1.3)}>
                <ZoomOut size={13} aria-hidden />
              </ZoomBtn>
              {atHome ? null : (
                <ZoomBtn label="重置视图" onClick={resetView}>
                  <RotateCcw size={13} aria-hidden />
                </ZoomBtn>
              )}
            </div>
          </div>

          {wikiLinks === 0 ? (
            <p className="border-t border-line px-4 py-3 text-2xs leading-relaxed text-faint">
              目前还没有任何双链 —— 在图里写 <code className="num">[[另一篇的标题]]</code> 就能把两篇连起来，
              比只靠标签精确得多。标签边是自动的，双链边是你要表达的意思。
            </p>
          ) : null}
          {graph.isolated ? (
            <p className="border-t border-line px-4 py-3 text-2xs leading-relaxed text-faint">
              有 {graph.isolated} 篇既没有标签也没有双链，它们在图上是孤立的点。
            </p>
          ) : null}
        </Card>
      )}
    </div>
  );
}

/** 画布右上角那颗小按钮。工具栏那一排用的是 ToolButton，尺寸和层级都不同，不复用 */
function ZoomBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      /* 触屏上这就是缩放图谱唯一的入口，点击区不能只有 29px */
      className="border-b border-line p-2.5 text-muted transition-colors last:border-b-0 hover:bg-panel-2 hover:text-ink sm:p-2"
    >
      {children}
    </button>
  );
}
