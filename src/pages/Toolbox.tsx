import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownAZ, ArrowUpDown, Folder, FolderPlus, GripVertical, Palette, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useStore } from '@/lib/store';
import { type Bookmark, type Group } from '@/lib/api';
import { cls, hostOf } from '@/lib/format';
import { brandTint, paletteTint } from '@/lib/tint';
import { Button, Empty, Input, PageHead, Segmented, Skeleton, Spinner } from '@/components/ui';
import { BookmarkModal, SiteIcon } from '@/components/bookmarks';
import { DragHandle, DropMarker, MoveButtons, useRowReorder, type RowReorder } from '@/components/reorder';

/**
 * 工具箱：把「常用网站」从首页那张小卡片升级成一个完整的页面。
 * 数据与首页共用同一份书签（bookmark_groups + bookmarks），
 * 所以在这里加一个入口，首页的常用网站也会同步出现。
 *
 * 版式照参考图走「柔彩画布 + 一排排糖果色磁贴」：这个页面的用途是"找入口"，
 * 一屏能扫到越多越好。所以用色块本身当分区信号 —— 比边框和留白快得多，
 * 一张磁贴只放图标和名字，host 和备注收进 title。
 *
 * 磁贴的颜色默认跟随站点自己的品牌色（见 lib/tint.ts 与后端
 * services/sitecolor.js）：能取到就按它染色，取不到才退回糖纸色板。
 */

/**
 * 分类名排序器。「按名称排序」用它，中文按**拼音**而不是码点 ——
 * 码点序会把「运维」排到「开发」「文档」前面，用户看到的是一份谁也没法预期的顺序。
 * numeric 让「阶段 2」排在「阶段 10」前面。
 */
const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 搜索联想里最多列几个工具。再多就不像"提示"了：一屏扫不完的列表，
    还不如直接在墙上找 —— 下拉只负责"最可能的几个 + 怎么找其余" */
const SUGGEST_MAX = 8;
/** 分类候选最多列几条。分类是配角，别把工具候选挤下去 */
const SUGGEST_GROUP_MAX = 2;

/**
 * 下拉里的一行。三类：
 * · 工具 —— 主路径，选中即新标签页打开（和点磁贴同一个动作）；
 * · 分类 —— 关键词命中了分类名，选中即切到那个分类；
 * · 越界 —— 当前分类下一条都没有、但别处有匹配，给一条"去全部里看"的出路。
 *
 * 之所以要有后两类：光列工具的话，"搜 «git» 却因为停在某个分类下而空空如也"
 * 就成了一条死路 —— 而那一刻用户最容易以为"这里根本没有这个东西"。
 */
type Suggestion =
  | { kind: 'tool'; bookmark: Bookmark }
  | { kind: 'group'; group: Group }
  | { kind: 'scope'; count: number };

/** 这一页的画布：柔彩波浪底（样式见 index.css 的 .tb-canvas）。
    用 fixed 铺满主区（lg 起跳过 228px 的左轨），页面再长也不会断在半路。 */
function PageCanvas() {
  return <span aria-hidden className="tb-canvas pointer-events-none fixed inset-0 -z-10 lg:left-[228px]" />;
}

export default function Toolbox() {
  const { bookmarks, groups, bookmarksApi, ready, notify } = useStore();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string>('all');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [creating, setCreating] = useState(false);
  const [groupMgr, setGroupMgr] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const [syncing, setSyncing] = useState(false);
  /** 排序模式。默认关着，见下面 <ToolTile> 顶部那段说明 */
  const [sorting, setSorting] = useState(false);

  /**
   * 让磁贴去问各家站点"你是什么颜色、图标长什么样"，两件事一起做。
   *
   * 传 ids 是新增 / 改址之后的静默补全，成与不成都不出声 —— 用户刚点完"保存"，
   * 再弹一条"取色失败"只会让人以为保存也出了问题。
   * 不传 ids 是手动点「同步站点图标与配色」，这时要把结果说清楚：各取到几个。
   *
   * 两个请求并发发出去（它们都是去同一批站点取东西）：串起来等于把等待时间
   * 翻倍，而各自都只是不带凭据的 GET，服务端那边也各自限了并发 4。
   *
   * force 用于"地址改了"这种情形：抓来的图标和探测到的配色都属于上一个站点，
   * 必须重来一遍，而默认口径是"只补没有的"。
   */
  async function syncSiteMeta(ids?: string[], force = false) {
    setSyncing(true);
    try {
      const opts = { ids, force };
      const [colors, icons] = await Promise.all([bookmarksApi.syncColors(opts), bookmarksApi.syncIcons(opts)]);
      if (ids) return;
      const failed = colors.failed.length + icons.failed.length;
      const done = `已更新 ${colors.updated} 个配色、${icons.updated} 个图标`;
      notify(
        failed ? `${done}，${failed} 个没取到（打不开的站点、纯灰图标或站点没有图标）` : done,
        failed ? 'warn' : 'ok',
      );
    } catch (err) {
      if (!ids) notify(err instanceof Error ? err.message : '同步站点信息失败', 'crit');
    } finally {
      setSyncing(false);
    }
  }

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bookmarks.filter((b) => {
      if (active !== 'all' && b.group !== active) return false;
      if (q && !`${b.name} ${b.url} ${b.note}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [bookmarks, active, query]);

  /* 按分类聚合；没有命中的分类整块不渲染，避免空区块 */
  const grouped = useMemo(
    () =>
      groups
        .map((group) => ({ group, items: matched.filter((b) => b.group === group.id) }))
        .filter(({ items }) => items.length > 0),
    [groups, matched],
  );

  const countOf = (id: string) => bookmarks.filter((b) => b.group === id).length;

  /* 整面墙的顺序（分类依次排下来），排序交互认的就是它。
     hook 必须声明在下面那个 early return 之前 —— 骨架那一帧也走一次渲染。 */
  const flatIds = useMemo(() => grouped.flatMap(({ items }) => items.map((b) => b.id)), [grouped]);
  /** 磁贴在全墙里的位置。前后移动按整墙算，所以下标不能只用分类内的 */
  const wallIndex = useMemo(() => new Map(flatIds.map((id, i) => [id, i])), [flatIds]);

  /**
   * 一次排序收尾：把这面墙的新顺序交给 store。
   *
   * 页面是"按分类分开的一排排磁贴"，而库里存的是一维数组的顺序
   * （见 server/db/repository.js：bookmarks 的 sort_order 就是数组下标），
   * 所以这里要翻译两件事：
   *
   * · **位置**：只把这一屏看得见的磁贴按新顺序摆回它们原先占着的那些下标上。
   *   搜索或按分类筛选时，被筛掉的磁贴不在这面墙上 —— 不能因为拖了一张，
   *   就把墙外的磁贴挤到末尾去。
   * · **分类**：被拖的那一张如果现在夹在别的分类的邻居之间，就跟着归入那个分类
   *   （把它放到某分类两张磁贴中间，意思本来就是"我要归到这一类"）。
   *   只认 movedId 一张：一墙一次只挪一个，别的磁贴的分类不该被这一拖改写。
   */
  function commitWallOrder(nextIds: string[], movedId: string) {
    const byId = new Map(bookmarks.map((b) => [b.id, b]));
    const onWall = new Set(flatIds);

    const slots: number[] = [];
    bookmarks.forEach((b, i) => {
      if (onWall.has(b.id)) slots.push(i);
    });
    const full = bookmarks.slice();
    slots.forEach((slot, k) => {
      const b = byId.get(nextIds[k]);
      if (b) full[slot] = b;
    });

    const moved = byId.get(movedId);
    const at = nextIds.indexOf(movedId);
    /* 邻居取"前一个"，没有前一个（拖到了墙头）就看后一个 */
    const neighbour = at > 0 ? byId.get(nextIds[at - 1]) : byId.get(nextIds[at + 1]);
    const changed = moved && neighbour && neighbour.group !== moved.group;
    void bookmarksApi.reorder(
      full.map((b) => b.id),
      changed ? [{ id: movedId, group: neighbour.group }] : [],
    );
  }

  const wallSort = useRowReorder(flatIds, commitWallOrder, 'x');

  /* ── 搜索联想 ──────────────────────────────────────────────────────
     输入时在框下摆一排候选。值得做的理由：这一页几十张磁贴，靠眼睛扫着找
     「那个 Grafana」很慢，而名字、网址、备注本来就在手边 —— 打两个字就该直达。
     选中一个工具就是新标签页打开，和点磁贴是同一个动作。

     候选与墙上**同一套口径**（都来自 matched），所以"下拉里列出来的"
     必然就是"墙上会出现的那一批"。两处一旦分叉，就会出现"下拉说有一个、
     墙上却什么都没有"这种自相矛盾，那比没有联想更让人困惑。 */
  const [sugOpen, setSugOpen] = useState(false);
  const [sugIndex, setSugIndex] = useState(0);
  const sugWrapRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  /** 下拉里每行右端那点分类名。按 id 查一次，不必每行 find 一遍 */
  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  const suggestions = useMemo<Suggestion[]>(() => {
    const rows: Suggestion[] = matched.slice(0, SUGGEST_MAX).map((bookmark) => ({ kind: 'tool', bookmark }));
    if (!needle) return rows;
    for (const group of groups.filter((g) => g.name.toLowerCase().includes(needle)).slice(0, SUGGEST_GROUP_MAX)) {
      rows.push({ kind: 'group', group });
    }
    /* 当前分类下一条都没有、别处却有：补一条"去全部里看"的出路。
       数字按同一个口径现数一遍 —— 它就是这个下拉里唯一能救命的那一行 */
    if (matched.length === 0) {
      const elsewhere = bookmarks.filter((b) => `${b.name} ${b.url} ${b.note}`.toLowerCase().includes(needle)).length;
      if (elsewhere > 0) rows.push({ kind: 'scope', count: elsewhere });
    }
    return rows;
  }, [matched, groups, bookmarks, needle]);

  /* 有词才露。空词时摆一排"全部工具"没有意义 —— 那不是联想，是把墙抄进框里 */
  const sugVisible = sugOpen && needle.length > 0;
  /* 候选会随输入变短（数据被别处改也可能变），高亮位置跟着夹一下，
     否则回车会打到一条已经不存在的东西上 */
  const sugActive = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  /* 点在外面就收起。用 document 上的 mousedown，而不是输入框的 blur：
     blur 在按住候选行的那一刻就发生，下拉先消失，那一下点击就落空了。
     （候选行自己也 mousedown + preventDefault，把焦点留在输入框里） */
  useEffect(() => {
    if (!sugVisible) return;
    const onDown = (e: MouseEvent) => {
      if (!sugWrapRef.current?.contains(e.target as Node)) setSugOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sugVisible]);

  function pickSuggestion(s: Suggestion) {
    if (s.kind === 'tool') {
      /* 和磁贴同一个动作：新标签页打开。搜索词**不清** ——
         接着挑下一个时不用把刚才那两个字重打一遍 */
      window.open(s.bookmark.url, '_blank', 'noopener,noreferrer');
    } else if (s.kind === 'group') {
      /* 选分类 = 想"看这一类"，所以把词清掉：留着它，切过去之后墙上还是
         「该分类 ∧ 关键词」，看着像点了没反应 */
      setActive(s.group.id);
      setQuery('');
    } else {
      setActive('all');
    }
    setSugOpen(false);
  }

  if (!ready) {
    return (
      <div className="relative">
        <PageCanvas />
        <div className="mx-auto w-full max-w-[1600px]" role="status" aria-busy="true">
          <PageHead title="常用工具" hint="内网面板、开发工具与文档入口，按用途分类。" />
          {/* 磁贴骨架用真实那一套网格与尺寸（见下面 <ul> 的 grid-cols 与磁贴的
              h-[54px]），数据到位时才不会重排 */}
          {[0, 1].map((g) => (
            <div key={g} className="mb-8">
              <Skeleton className="mb-4 h-4 w-24 rounded-field" />
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <Skeleton key={i} className="h-[54px] rounded-xl2" />
                ))}
              </div>
            </div>
          ))}
          <span className="sr-only">正在读取工具列表…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <PageCanvas />

      <div className="mx-auto w-full max-w-[1600px]">
        <PageHead
          title="常用工具"
          hint={`日常要用的内网面板、开发工具与文档入口都收在这里，按用途分成 ${groups.length} 类，共 ${bookmarks.length} 个。点图标直接在新标签页打开；要让某个入口出现在首页的「常用网站」，编辑它时打开「设为常用」。磁贴颜色默认跟随站点自己的品牌色，取不到的退回糖纸色板。`}
          actions={
            <>
              {/* 输入框 + 联想下拉。relative 归这一层，下拉才能贴着框定位 */}
              <div ref={sugWrapRef} className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    /* 每敲一下都把高亮拉回第一条：不重置的话，回车会打开
                       "上一轮留下的第 3 条"，而它跟这次输的词可能毫无关系 */
                    setSugIndex(0);
                    setSugOpen(true);
                  }}
                  onFocus={() => {
                    if (needle) setSugOpen(true);
                  }}
                  onKeyDown={(e) => {
                    /* Esc 给两级退路：先收下拉，已经收着就把词清掉 ——
                       于是不必再去够一个"清除"按钮（框里也没放） */
                    if (e.key === 'Escape') {
                      if (sugVisible) {
                        e.preventDefault();
                        setSugOpen(false);
                      } else if (query) {
                        e.preventDefault();
                        setQuery('');
                      }
                      return;
                    }
                    if (!sugVisible || suggestions.length === 0) return;
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const delta = e.key === 'ArrowDown' ? 1 : -1;
                      /* 环绕：到底了从头上再来，比"到头就不动"少一次茫然 */
                      setSugIndex((i) => (i + delta + suggestions.length) % suggestions.length);
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      pickSuggestion(suggestions[sugActive]);
                    }
                  }}
                  placeholder="搜索名称、网址或备注"
                  className="w-[13rem] pl-8"
                  aria-label="搜索工具"
                  /* 关掉浏览器自己的补全：它和这一份会叠着弹，两个候选框打架 */
                  autoComplete="off"
                  spellCheck={false}
                  /* combobox + listbox 那套：方向键改的是 aria-activedescendant，
                     焦点始终留在输入框里，读屏会跟着念当前那一条 */
                  role="combobox"
                  aria-expanded={sugVisible}
                  aria-controls={suggestions.length ? 'tb-suggest' : undefined}
                  aria-autocomplete="list"
                  aria-activedescendant={sugVisible && suggestions.length ? `tb-suggest-${sugActive}` : undefined}
                />

                {sugVisible ? (
                  /* 锚**左**缘，不是右缘。面板比输入框宽（20rem vs 13rem），
                     锚右缘就会往左伸出去：顶上这一排控件在标题够宽时会换行贴到
                     左边、窗口窄于 lg 时左轨还会隐藏，那两种情况下面板都会有一截
                     落到屏幕左边之外，看上去就是"打字没反应"。
                     锚左缘 + 宽度按视口封顶，任何一种窗口宽度都装得下。 */
                  <div className="absolute left-0 top-full z-30 mt-1.5 w-[20rem] max-w-[86vw] overflow-hidden rounded-field border border-line bg-panel shadow-[0_8px_24px_-12px_rgba(20,40,80,.35)]">
                    {suggestions.length ? (
                      <ul
                        id="tb-suggest"
                        role="listbox"
                        aria-label="工具候选"
                        className="max-h-[17rem] overflow-y-auto overscroll-contain py-1"
                      >
                        {suggestions.map((s, i) => (
                          <li
                            key={
                              s.kind === 'tool' ? `t:${s.bookmark.id}` : s.kind === 'group' ? `g:${s.group.id}` : 'scope'
                            }
                            /* listbox 的子元素只该是 option，包一层的 li 交还给普通列表语义 */
                            role="presentation"
                          >
                            <button
                              type="button"
                              id={`tb-suggest-${i}`}
                              role="option"
                              aria-selected={i === sugActive}
                              /* mousedown 而不是 click：click 之前输入框已经失焦，
                                 外面那层"点别处就收"会抢先关掉下拉，这一下就点空了 */
                              onMouseDown={(ev) => {
                                ev.preventDefault();
                                pickSuggestion(s);
                              }}
                              /* 44px 是触控目标的下限（22px 图标 + 上下各 11px 内边距
                                 正好够），再高就长得像一列按钮了 */
                              className={cls(
                                'flex min-h-[44px] w-full items-center gap-2.5 px-2.5 py-2.5 text-left transition-colors',
                                i === sugActive ? 'bg-accent-soft' : 'hover:bg-bg-2',
                              )}
                            >
                              {s.kind === 'tool' ? (
                                <>
                                  <SiteIcon bookmark={s.bookmark} size={22} />
                                  <span
                                    className={cls(
                                      'min-w-0 flex-1 truncate text-xs',
                                      i === sugActive ? 'text-accent' : 'text-ink',
                                    )}
                                  >
                                    {s.bookmark.name}
                                  </span>
                                  {/* 右端给分类而不是网址：墙上就是按分类排的，
                                      知道它属于哪一类，闭着眼也能再找到 */}
                                  <span className="shrink-0 text-2xs text-faint">
                                    {groupNames.get(s.bookmark.group) ?? '未分类'}
                                  </span>
                                </>
                              ) : s.kind === 'group' ? (
                                <>
                                  <Folder size={14} aria-hidden className="shrink-0 text-faint" />
                                  <span
                                    className={cls(
                                      'min-w-0 flex-1 truncate text-xs',
                                      i === sugActive ? 'text-accent' : 'text-ink',
                                    )}
                                  >
                                    {s.group.name}
                                  </span>
                                  <span className="shrink-0 text-2xs text-faint">切到该分类</span>
                                </>
                              ) : (
                                <>
                                  <Search size={14} aria-hidden className="shrink-0 text-faint" />
                                  <span
                                    className={cls(
                                      'min-w-0 flex-1 truncate text-xs',
                                      i === sugActive ? 'text-accent' : 'text-ink',
                                    )}
                                  >
                                    在全部工具里找「{query.trim()}」
                                  </span>
                                  <span className="num shrink-0 text-2xs text-faint">{s.count} 个</span>
                                </>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      /* 无结果也得给下一步。"死路不友好"说的正是这一刻：
                         一个空白下拉会让人以为搜索坏了 */
                      <p className="px-2.5 py-2.5 text-2xs leading-relaxed text-faint">
                        没有匹配的工具。搜的是名称、网址和备注 —— 换个词，或按 Esc 清空搜索看全部。
                      </p>
                    )}
                    <p className="border-t border-line px-2.5 py-1 text-2xs text-faint">
                      ↑↓ 选择 · Enter 选中 · Esc 关掉
                    </p>
                  </div>
                ) : null}
              </div>
              <Button
                variant={sorting ? 'primary' : 'soft'}
                size="sm"
                disabled={flatIds.length < 2}
                onClick={() => setSorting((v) => !v)}
                title={
                  flatIds.length < 2
                    ? '至少要有两个磁贴才谈得上排序'
                    : '开启后可以拖动磁贴调整顺序，也能把磁贴拖进别的分类'
                }
              >
                <ArrowUpDown size={13} />
                {sorting ? '结束排序' : '调整顺序'}
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={syncing}
                onClick={() => void syncSiteMeta()}
                title="去各站点读它们的主题色与站点图标，写进书签。图标会存下来，之后刷新页面不再去访问那些站点"
              >
                {syncing ? <Spinner /> : <Palette size={13} />}
                {syncing ? '同步中…' : '同步站点图标与配色'}
              </Button>
              <Button variant="soft" size="sm" onClick={() => setGroupMgr(true)}>
                <FolderPlus size={13} />
                管理分类
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus size={13} />
                添加工具
              </Button>
            </>
          }
        />

        <Segmented
          className={sorting ? 'mb-4' : 'mb-8'}
          value={active}
          onChange={setActive}
          options={[
            { value: 'all', label: `全部 ${bookmarks.length}` },
            ...groups.map((g) => ({ value: g.id, label: `${g.name} ${countOf(g.id)}` })),
          ]}
        />

        {/* 排序模式的说明。写在墙上而不是弹一条 toast：
            排序是"边看边调"的事，规则得一直摆在那儿 
            —— 尤其"拖进别的分类"这条，不说没人会去试 */}
        {sorting ? (
          <p className="mb-7 flex flex-wrap items-center gap-1.5 text-2xs text-faint">
            <GripVertical size={13} aria-hidden />
            按住磁贴拖动即可换位置；拖到别的分类的磁贴之间，它就归到那个分类。触屏与键盘用磁贴上的 ◀ ▶ 前后移动。
          </p>
        ) : null}

        {grouped.length === 0 ? (
          <Empty
            title={query.trim() ? '没有匹配的工具' : '这个分类还是空的'}
            hint={query.trim() ? '换个关键词，或者清空搜索看全部。' : '点右上角「添加工具」把地址存进来。'}
            action={
              query.trim() ? (
                <Button size="sm" onClick={() => setQuery('')}>
                  清空搜索
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={13} />
                  添加工具
                </Button>
              )
            }
          />
        ) : (
          /* 分类之间只靠留白分开：画布本身已经是整片柔彩，再给每类套一层
             白面板等于在画上又贴一张纸，色块的分区信号会被压掉 */
          <div className="space-y-9">
            {grouped.map(({ group, items }) => (
              <section key={group.id} aria-label={group.name}>
                {/* 分类名可以带上自己的 emoji（在「管理分类」里改），这里原样显示。
                    不再在这行右端放条目数：数字被 flex-1 顶到页面最右边，
                    离标题隔着半屏，看着像是别的区块的东西。 */}
                <h2 className="mb-3.5 min-w-0 truncate text-[15.5px] font-semibold text-ink">{group.name}</h2>

                {/* 磁贴墙：小屏两列，宽屏最多八列 —— 和参考图一样，一行扫过去
                    就是一组入口，不用横向折行去找。
                    列数按"一张磁贴约 200px"定：栅格宽了还只放五六个，
                    磁贴会被拉成一条长胶囊，看着像表单行而不是入口块 */}
                <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                  {items.map((bm) => (
                    <ToolTile
                      key={bm.id}
                      bookmark={bm}
                      sorting={sorting}
                      sortable={wallSort}
                      index={wallIndex.get(bm.id) ?? 0}
                      count={flatIds.length}
                      onEdit={() => setEditing(bm)}
                      onDelete={() => {
                        void bookmarksApi.remove(bm.id);
                        notify(`已删除「${bm.name}」`);
                      }}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <BookmarkModal
          open={creating || Boolean(editing)}
          bookmark={editing}
          groups={groups}
          defaultGroup={active === 'all' ? groups[0]?.id : active}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (payload) => {
            if (editing) {
              /* 地址改了：抓来的图标与探测到的配色都属于上一个站点，重来一遍 */
              const repointed = editing.url !== payload.url;
              await bookmarksApi.patch(editing.id, payload);
              if (repointed) void syncSiteMeta([editing.id], true);
            } else {
              const added = await bookmarksApi.add(payload as Partial<Bookmark> & { name: string; url: string });
              // 新增的入口顺手问一次它自己的颜色与图标。放到后台跑，不挡弹窗关闭；
              // 这两样晚一瞬到位，用户不用为此再点一次「同步站点图标与配色」。
              if (added) void syncSiteMeta([added.id]);
            }
            setCreating(false);
            setEditing(null);
          }}
        />

        <GroupManager
          open={groupMgr}
          groups={groups}
          countOf={countOf}
          newName={newGroup}
          onNewNameChange={setNewGroup}
          onClose={() => setGroupMgr(false)}
          onCreate={(name) => {
            void bookmarksApi.createGroup(name);
            setNewGroup('');
          }}
          onRename={(id, name) => void bookmarksApi.renameGroup(id, name)}
          onReorder={(ids) => void bookmarksApi.reorderGroups(ids)}
          onSortByName={() => {
            const ids = [...groups]
              .sort((a, b) => nameCollator.compare(a.name, b.name))
              .map((g) => g.id);
            void bookmarksApi.reorderGroups(ids).then((done) => {
              if (done) notify('已按名称重新排列');
            });
          }}
        />
      </div>
    </div>
  );
}

/**
 * 单个工具磁贴：一颗糖果色方块，左边图标、右边名称（和参考图同构）。
 * 名称左对齐而不是居中 —— 一行里图标都对齐在同一条竖线上，名字自然向左读，
 * 居中反而每格都要重新找起点。
 *
 * 颜色优先跟随站点品牌色：有品牌色就带 data-brand 并只传色相 / 饱和度，
 * 明度交给 CSS 按主题决定（见 index.css 的 .tb-card[data-brand]）；
 * 颜色太灰、太亮太暗或压根没探测过的，退回按 id 散列出来的糖纸色。
 *
 * 两个操作按钮在 hover 时从右侧浮出来，刻意不压在图标上：
 * favicon 是这一格唯一的图形信息，盖住就只剩色块了。
 * 地址和备注收进 title，需要时 hover 就能看到，不占版面。
 *
 * 「常用」不在这面墙上表示、也不在这里切换（编辑弹窗里有一个开关）：
 * 一整面墙几十张磁贴，几乎每张都带一颗状态星，读起来就像满屏的通知红点，
 * 而它想传达的信息（哪些已标过常用）在"找入口"这个场景里其实用不上。
 *
 * 排序模式下（页面右上角「调整顺序」）这一格变成一个可拖的块，见下面 return 前的说明。
 */
function ToolTile({
  bookmark,
  sorting,
  sortable,
  index,
  count,
  onEdit,
  onDelete,
}: {
  bookmark: Bookmark;
  /** 排序模式：整块可拖、点击不跳转、操作条换成排序控件 */
  sorting: boolean;
  sortable: RowReorder;
  /** 在**整面墙**里的下标。前后移动是跨分类连续的，下标与总数都得按全墙算 */
  index: number;
  count: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const brand = brandTint(bookmark.color);

  /* 拖动与落点都挂在整块磁贴上，不是只在某个小抓手上：
     这一格没有输入框，不存在"拖拽把选词抢走"的问题
     （对比 reorder.tsx 里"抓手必须是整行唯一可拖处"那条约束）；
     而一墙几十张、每张只有 54px 高，让用户去瞄一个 14px 的抓手反而难用。
     抓手图标只当"这块能拖"的提示，拖动范围是整格。
     只有排序模式下才允许拖 —— 平时点磁贴是要跳走的，
     和"按住拖动"共用一个手势迟早误触。
     href 也在排序模式下摘掉：这时点它的意思是"挑它来挪"，
     留着链接就会有人一边排一边被弹到新标签页。 */
  return (
    <li
      {...(sorting ? sortable.rowProps(bookmark.id) : {})}
      {...(sorting ? sortable.handleProps(bookmark.id) : {})}
      className={cls('group/tile relative', sorting && 'cursor-grab select-none active:cursor-grabbing')}
    >
      <a
        href={sorting ? undefined : bookmark.url}
        target="_blank"
        rel="noreferrer noopener"
        title={bookmark.note ? `${bookmark.name} · ${bookmark.note}` : `${bookmark.name} · ${hostOf(bookmark.url)}`}
        data-brand={brand ? '' : undefined}
        style={brand ? ({ '--tb-h': brand.h, '--tb-s': `${brand.s}%` } as CSSProperties) : undefined}
        className={cls(
          'tb-card flex h-[54px] items-center gap-2.5 rounded-xl2 px-2.5',
          brand ? '' : `tb-tint-${paletteTint(bookmark.id || bookmark.name)}`,
        )}
      >
        <span className="tb-icon grid h-9 w-9 shrink-0 place-items-center">
          <SiteIcon bookmark={bookmark} size={28} fill />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-ink">{bookmark.name}</span>
      </a>

      {/* 落点线贴在磁贴的左/右缘，说清"会插到它前头还是后头"（横向，见 DropMarker） */}
      {sorting ? <DropMarker at={sortable.marker(bookmark.id)} axis="x" /> : null}

      {/* 操作条。触屏没有 hover，所以小屏常显 —— 但不能像原来那样
          「绝对定位浮在磁贴上」：375px 两列时每格只有 ~166px，
          图标连成一条横条会把名字盖掉大半。
          小屏让它落到磁贴下面一行（正常流），从 sm 起才回到悬浮覆盖层。
          桌面端收起时连点击一起关掉，否则它会挡住磁贴本身的链接。

          平时这里只留**改这一条自身**的两个动作（编辑 / 删除）。
          「常用」原来也挤在这条上，但它是"这张磁贴属于首页哪一块"的归属设置，
          跟改名、删记录不是一回事；混在一排小图标里既不好认，也让这条更难读。
          现在它归到编辑弹窗里一个带说明的开关（见 BookmarkModal）。

          排序模式下换成另一组控件，并且常显（排序时得先看得见抓手在哪）。
          这时的落点判定是"往哪边挪"，所以用前/后移而不是上/下移；
          上/下这两颗按钮是给触屏和键盘兜底的 —— 触屏根本没有 HTML5 拖拽。 */}
      <div
        className={cls(
          'mt-1 flex items-center justify-end gap-px rounded-field px-0.5 sm:absolute sm:right-1.5 sm:top-1/2 sm:mt-0 sm:-translate-y-1/2 sm:bg-panel/85 sm:shadow-soft sm:backdrop-blur-sm',
          !sorting &&
            'transition-opacity duration-150 sm:pointer-events-none sm:opacity-0 sm:group-hover/tile:pointer-events-auto sm:group-hover/tile:opacity-100 sm:group-focus-within/tile:pointer-events-auto sm:group-focus-within/tile:opacity-100',
        )}
      >
        {sorting ? (
          <>
            <span aria-hidden className="shrink-0 p-1 text-faint sm:p-0.5">
              <GripVertical size={14} />
            </span>
            <MoveButtons sortable={sortable} index={index} count={count} label={bookmark.name} axis="x" />
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`编辑 ${bookmark.name}`}
              title="编辑"
              className="rounded-field p-1.5 text-faint transition-colors hover:bg-bg-3 hover:text-ink sm:p-1"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`删除 ${bookmark.name}`}
              title="删除"
              className="rounded-field p-1.5 text-faint transition-colors hover:bg-crit-soft hover:text-crit sm:p-1"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * 分类管理：改名、新增与排序。
 *
 * 书签里存的是分组 id 而不是名字，所以改名不必回头改任何一条书签 ——
 * 这正是当初用 id 关联的意义。
 *
 * 改名做成「输入框失焦即提交」而不是每行配一个保存按钮：
 * 分类一多，那列按钮会把弹窗挤成一根竖条，而且逐行点保存很烦。
 * 用 defaultValue（非受控）是因为分组列表会被外部改写（新增/改名后重渲染），
 * 受控值反而会把用户正在输入的内容顶掉。
 *
 * 排序交互（拖抓手 / 上移下移）在 components/reorder.tsx 里，这里只管
 * 把新的 id 顺序交给 onReorder —— 落库与乐观更新统一在 store 里。
 * 「按名称排序」是一次性的自动排列：点一下按名称（中文按拼音）重排，
 * 之后仍可继续手动拖 —— 它不是一种"锁定"的模式。
 */
function GroupManager({
  open,
  groups,
  countOf,
  newName,
  onNewNameChange,
  onClose,
  onCreate,
  onRename,
  onReorder,
  onSortByName,
}: {
  open: boolean;
  groups: Group[];
  countOf: (id: string) => number;
  newName: string;
  onNewNameChange: (v: string) => void;
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  /** 排序后的完整 id 顺序 */
  onReorder: (ids: string[]) => void;
  onSortByName: () => void;
}) {
  /* 排序交互收在 useRowReorder 里（见 components/reorder.tsx）：
     设置页的搜索引擎列表用的是同一份。hook 必须声明在 early return 之前 ——
     弹窗常驻挂载、只在 open 为假时返回 null，hook 落到 return 后面就违反了调用顺序 */
  const sortable = useRowReorder(
    groups.map((g) => g.id),
    onReorder,
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="关闭分类管理" onClick={onClose} className="scrim fixed inset-0 cursor-default" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="管理分类"
        className="panel relative z-10 w-full max-w-[26rem] p-5 shadow-pop animate-dialog-in"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">管理分类</h2>
            <p className="mt-1 text-2xs text-faint">
              改名后该类下的工具会自动跟着变，不用重新归类。名字里可以带 emoji。
              拖动左侧抓手可调整顺序，也可用右侧箭头微调。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-field p-1 text-faint transition-colors hover:bg-bg-2 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-3.5 flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={!sortable.canSort}
            onClick={onSortByName}
            title="按名称自动排列（中文按拼音）"
          >
            <ArrowDownAZ size={13} />
            按名称排序
          </Button>
        </div>

        <ul className="mt-1.5 max-h-[15rem] space-y-2 overflow-y-auto overscroll-contain pr-0.5">
          {groups.map((g, i) => (
            <li
              key={g.id}
              {...sortable.rowProps(g.id)}
              className="relative flex items-center gap-1.5"
            >
              <DropMarker at={sortable.marker(g.id)} />

              <DragHandle sortable={sortable} id={g.id} />

              <Input
                defaultValue={g.name}
                aria-label={`分类名称 ${g.name}`}
                className="min-w-0 flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (!next || next === g.name) return;
                  onRename(g.id, next);
                }}
              />

              <span className="num shrink-0 text-2xs text-faint">{countOf(g.id)}</span>

              <MoveButtons sortable={sortable} index={i} count={groups.length} label={g.name} />
            </li>
          ))}
        </ul>

        <form
          className="mt-4 flex items-center gap-2 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            onCreate(name);
          }}
        >
          <Input
            value={newName}
            onChange={(e) => onNewNameChange(e.target.value)}
            placeholder="新分类名称"
            aria-label="新分类名称"
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="soft" disabled={!newName.trim()}>
            <Plus size={13} />
            新增
          </Button>
        </form>
      </div>
    </div>
  );
}
