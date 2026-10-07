import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookOpen, Check, Cpu,  MemoryStick, Pencil, Plus, Receipt, Search, Trash2, TrendingUp, Zap } from 'lucide-react';
import { useStore } from '@/lib/store';
import { BookmarkModal, SiteIcon } from '@/components/bookmarks';
import { useMonitor } from '@/lib/monitor';
import { api, type Bookmark, type KnowledgeItem, type Priority } from '@/lib/api';
import { cls, fmtBytes, fmtEnergy, fmtMoney, hostOf, todayStr } from '@/lib/format';
import { brandTint, paletteTint } from '@/lib/tint';
import { engineLetters, engineTint, isBrightHue } from '@/lib/engine-color';
import { Button, Card, CardHead, Empty, Input, Select, Skeleton } from '@/components/ui';
import { PriorityBadge, STATUS_META, Stat, Tag } from '@/components/bits';

const PRIORITY_OPTIONS: Priority[] = ['P0', 'P1', 'P2', 'P3'];

/** 首页搜索联想里最多列几条本地命中。再多就把下面那些卡片顶下去了 */
const SUGGEST_TOOL_MAX = 5;
const SUGGEST_POST_MAX = 3;

/** 打字的停顿时间。250ms 大致是"还在打"和"打完了"的那条分界：
    再短就是一个字一个请求，再长候选词就显得迟钝 */
const SUGGEST_DEBOUNCE_MS = 250;

/** 知识库条目的短标签。刻意不共用 Knowledge.tsx 里那份 TYPE_META：
    它是那一页的模块内常量，首页 import 会把整个知识库 chunk 拖进首屏
    （那一页专门做了懒加载），为三个字不值得 */
const POST_TYPE_LABEL: Record<KnowledgeItem['type'], string> = {
  sop: 'SOP',
  runbook: 'Runbook',
  excerpt: '摘录',
};

/**
 * 首页搜索框下拉里的一行：
 * · tool    —— 工具箱里的入口，选中即新标签页打开（和点磁贴同一个动作）；
 * · post    —— 知识库条目，选中即进阅读页；
 * · suggest —— 搜索引擎自己的候选词（外部接口取回来的），选中即用它去搜；
 * · search  —— 用当前引擎搜**输入框里的原文**。它**永远排在最后**：那是这个框
 *              原本唯一的动作，也是没有高亮时回车的结果，得让它一直看得见。
 *
 * 前两类是"本站已有的东西"，后两类是"去外面找" —— 顺序也按这个来。
 */
type SearchSuggestion =
  | { kind: 'tool'; bookmark: Bookmark }
  | { kind: 'post'; post: KnowledgeItem }
  | { kind: 'suggest'; word: string }
  | { kind: 'search' };

export default function Dashboard() {
  const { ready, error: storeError } = useStore();

  if (!ready) return <PageSkeleton />;
  if (storeError) {
    return (
      <Card>
        <Empty title="后端接口没有响应" hint={`${storeError}。请确认服务已启动：npm run dev`} />
      </Card>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      <GreetingBar />
      <SearchBar />
      <KpiRow />

      {/* 常用网站排在待办之前：它是每天真正会点的东西（一排入口），
          先扫完入口再看清单，顺序才跟着一天的动作走 */}
      <QuickLinks />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TodayTodos />
        </div>
        <TopThree />
      </div>

      <HintStrip />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   首屏：问候 → 主卡 + 圆环 → KPI 行
   ══════════════════════════════════════════════════════════════════ */

/** 顶部问候：时间 + 今天的状态，替代"页面名"这种冷冰冰的开场 */
/**
 * 顶部问候。
 *
 * 这里原本还有一行「日期 + 节点状态」，以及一个「PVE 实时」徽章，都已移除：
 *   日期   —— 今日主题卡里就有「今日主题 · 10月4日 星期日」
 *   节点状态 —— 顶栏状态条（实时采集中 / 演示数据 / 监控离线 + 呼吸点）覆盖了全部三态
 * 两处都是重复信息，去掉后整块只剩一句问候。
 */
function GreetingBar() {
  const { settings } = useStore();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(t);
  }, []);

  const h = now.getHours();
  const greet = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  // 称呼在「设置 → 个人」里配。留空就只显示问候语——不要硬拼出一个
  // 「早上好，」这样带个孤零零逗号的结果。
  const name = settings?.profile?.name?.trim();

  return (
    <h1 className="text-[26px] font-semibold tracking-display sm:text-[30px]">
      {greet}
      {name ? `，${name}` : ''}
    </h1>
  );
}

/**
 * 首页搜索条：一条通栏输入框 + 一行引擎标签，铺在一块浅蓝焦点面上。
 *
 * 引擎来自「设置 → 搜索」（settings.search.engines），所以这里只负责
 * "选一个、把词拼进它的地址"。地址模板里的 %s 由服务端保证存在（缺 %s 的
 * 引擎保存时就被拒了），这里仍然兜一手：真碰上了就退回原地址，不让它变成
 * 一个静默吞掉关键词的空操作。
 *
 * ── 为什么是"焦点面"而不是又一张白卡 ──────────────────────────────
 * 这块位置原来就是那张蓝色 hero 卡。只放一张和白卡同质的 panel，页面顶部
 * 就没了主次。改用 .focus-card.sky（与监控页顶上那块同源）把它重新变成
 * "另一块面"，白条再从浅蓝底上浮起来 —— 这正是参考图里"白条压在有底色的
 * 背景上"的关系。
 *
 * 外框不给圆角：全站只有两类面，容器（卡片/面板）是 16px 圆角、focus 面
 * 是方角（监控页那块也没圆角）。跟它走，别把这块变成"一张圆角大卡"。
 *
 * ── 颜色从哪来 ──────────────────────────────────────────────────────
 * 每颗引擎标签的**字**带自己的品牌色：色相按引擎地址的域名查一张内置表，
 * 认不出的按域名散列（同一个引擎永远同一个颜色）。所以用户在设置里
 * 加任何一个搜索引擎，它都自带颜色，不必再多填一个色值 ——
 * 这是这块"有颜色"的关键：四个灰底小方块并排，谁也认不出是哪家。
 * 底色反而是**中性**的（一层半透明白）：一排彩底会互相抢，
 * 只有彩色落在字上，才能一眼扫过去认出哪家是哪家。
 * Google 那种本身就是多彩的，逐字上色（见 lib/engine-color.ts）。
 * 选中引擎的色相还会染到白条的聚焦环、搜索按钮和整块面右上角那团柔光，
 * 于是换一下引擎，整块搜索区的颜色跟着变。
 * 明度一律交给主题（CSS 里 hsl(var(--se-h) var(--se-s) L%)），JS 不算颜色。
 *
 * 占位符用当前引擎自己的名字（「在 百度 中搜索」）而不是参考图里写死的
 * 「百度一下」—— 引擎是可配的，写死的提示语在换掉引擎之后就成了假话。
 *
 * ── 联想 ────────────────────────────────────────────────────────────
 * 输入时在白条下面列候选，四类来源见 SearchSuggestion：本站的工具入口、
 * 知识库文章，以及**外部搜索引擎自己的候选词**（由服务端代取，见
 * server/services/suggest.js —— 那几家都不给 CORS 头，浏览器直连读不到响应）。
 *
 * "回车 = 用当前引擎搜"这条老行为一个字都没改：默认不高亮任何候选，
 * 按了方向键才进入候选，选中了才会离开本页。外发只发生在"设置里开着联想
 * 且当前引擎在映射表里认得出"这一种情况下。
 */
function SearchBar() {
  const { settings, bookmarks, groups, knowledge } = useStore();
  const navigate = useNavigate();
  const engines = settings?.search?.engines ?? [];
  const newTab = settings?.search?.newTab ?? true;
  const [picked, setPicked] = useState('');
  const [q, setQ] = useState('');

  /* 引擎列表可能在别处被改（设置页存完会刷新全站设置）：选中的那个要是被删了，
     就回落到默认项、再回落到第一个，而不是留着悬空 id 让选中态和实际不一致。
     它算在最前面（而不是像原来那样算在下面）：下面那个联想 effect 的依赖里
     要用到它，而 hook 的依赖数组是在渲染时就求值的。 */
  const active =
    engines.find((e) => e.id === picked) ??
    engines.find((e) => e.id === settings?.search?.defaultEngine) ??
    engines[0];

  /* ── 搜索联想 ──────────────────────────────────────────────────────
     这个框原来是"打词 → 回车 → 新标签页打开搜索引擎"。联想不接外部搜索建议：
     那要么依赖非官方接口、要么把用户输入发给第三方，对一个内网工具都不合适。
     改成列**你自己的东西** —— 工具箱里的入口与知识库里的文章，本来就在内存里，
     零延迟，而且"搜到就能直达"。

     只在真有本地命中时才弹面板：否则纯外部搜索每敲一个字都顶出一层
     "用 百度 搜索…"，纯属打扰 —— 那件事回车本来就做，不必再说一遍。 */
  const [sugOpen, setSugOpen] = useState(false);
  /* -1 = 没有任何一条高亮。默认必须是这样：回车在这个框里的含义要**保持原样**
     （用当前引擎搜），不能被联想悄悄改掉。按 ↓ 才进入候选。 */
  const [sugIndex, setSugIndex] = useState(-1);
  const suggRef = useRef<HTMLDivElement>(null);

  /* 外部联想词。它比本地候选慢一截（要出网），所以单独存一份：
     本地命中立刻出现，外部候选到了再插进来，互不阻塞。 */
  const [remote, setRemote] = useState<string[]>([]);
  const [remoteLabel, setRemoteLabel] = useState('');
  /* 当前引擎在服务端的映射表里认不出来（自建引擎、GitHub…）：
     问过一次就不再问，省掉每个字一次注定空手而归的请求 */
  const [remoteOff, setRemoteOff] = useState(false);
  const suggestOn = settings?.search?.suggest !== false;
  /* 请求序号：只认最后一次发出的那个响应。打字快时响应会乱序回来，
     不认序号就会出现"候选词和你此刻打的字对不上" */
  const suggestSeq = useRef(0);

  const needle = q.trim().toLowerCase();

  useEffect(() => {
    if (!needle || !suggestOn || remoteOff || !active?.id) {
      setRemote([]);
      return;
    }
    const seq = (suggestSeq.current += 1);
    /* debounce：一个字一个请求既没必要，也容易被对面当成异常流量 */
    const timer = window.setTimeout(() => {
      api.search
        .suggest(active.id, needle)
        .then((res) => {
          if (seq !== suggestSeq.current) return;
          if (!res.supported || !res.enabled) {
            setRemoteOff(true);
            setRemote([]);
            return;
          }
          setRemote(res.items);
          setRemoteLabel(res.label ?? '');
          /* 候选是异步插进列表的，到达时列表长度会变。这时把高亮收回"没选中"：
             否则回车会打在那条刚插进来的候选上 —— 而用户以为自己选的是另一条。
             回车的含义始终是"搜当前输入"，这条不变式比"保住高亮"重要。 */
          setSugIndex(-1);
        })
        /* 服务端已经把失败吞成空数组了，这里再兜一层网络异常：
           联想拿不到不该在首页弹错误 */
        .catch(() => {
          if (seq === suggestSeq.current) setRemote([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [needle, suggestOn, remoteOff, active?.id]);

  const rows = useMemo<SearchSuggestion[]>(() => {
    if (!needle) return [];
    const local: SearchSuggestion[] = [
      ...bookmarks
        .filter((b) => `${b.name} ${b.url} ${b.note}`.toLowerCase().includes(needle))
        .slice(0, SUGGEST_TOOL_MAX)
        .map((bookmark) => ({ kind: 'tool' as const, bookmark })),
      /* 回收站里的不算命中：它已经"删掉了"，在首页又搜出来只会让人以为没删成 */
      ...knowledge
        .filter((k) => !k.deletedAt && `${k.title} ${k.summary} ${k.tags.join(' ')}`.toLowerCase().includes(needle))
        .slice(0, SUGGEST_POST_MAX)
        .map((post) => ({ kind: 'post' as const, post })),
    ];
    const outside: SearchSuggestion[] = remote.map((word) => ({ kind: 'suggest' as const, word }));
    /* 本地与外部一条都没有时**不弹面板**：那会变成"每敲一个字都顶出一层
       '用 百度 搜索…'"，而那是回车本来就会做的事，不必再说一遍。
       外部候选词一到，面板才有真正的新内容可给。 */
    if (!local.length && !outside.length) return [];
    /* 顺序：自己的东西优先（零延迟、直达），别人的候选词其次，最后是搜索动作 */
    return [...local, ...outside, { kind: 'search' as const }];
  }, [bookmarks, knowledge, remote, needle]);

  const sugVisible = sugOpen && rows.length > 0;
  /* 高亮位置夹一下：候选会随输入变短。sugIndex 为 -1 时这里仍是 -1（没高亮） */
  const sugActive = Math.min(sugIndex, rows.length - 1);

  /* 点外面就收起。与工具箱那处同一个理由：不用输入框的 blur ——
     blur 会抢在"按住候选行"之前发生，下拉先消失，那一下点击就落空了 */
  useEffect(() => {
    if (!sugVisible) return;
    const onDown = (e: MouseEvent) => {
      if (!suggRef.current?.contains(e.target as Node)) setSugOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sugVisible]);

  if (!active) {
    return (
      <section aria-label="搜索" className="focus-card sky relative p-4 sm:p-6">
        <p className="text-xs leading-relaxed text-muted">
          还没有配置搜索引擎。去「设置 → 搜索」添加一个，这里就会出现搜索框。
        </p>
      </section>
    );
  }

  /** 已确认非空，供下面的事件处理函数使用（闭包里的类型收窄会丢） */
  const engine = active;
  /* 选中引擎的色相。它挂在 section 上：白条的聚焦环、搜索按钮、右上角那团光
     都用它；每颗标签再各自覆盖一份自己的色相（见下面的 map），互不干扰 */
  const tint = engineTint(engine.url);

  /** 候选行右端那点说明用的分类名 */
  function groupName(id: string) {
    return groups.find((g) => g.id === id)?.name ?? '未分类';
  }

  /**
   * 用当前引擎搜：这个框原来的、也是默认的动作（没有高亮时回车走它）。
   * 传词就搜那个词（选中外部候选词时用），不传就搜输入框里的原文。
   */
  function runSearch(word: string = q) {
    const value = word.trim();
    if (!value) return;
    const target = engine.url.includes('%s') ? engine.url.replace('%s', encodeURIComponent(value)) : engine.url;
    if (newTab) window.open(target, '_blank', 'noopener,noreferrer');
    else window.location.href = target;
    setQ('');
    setSugIndex(-1);
    setSugOpen(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    runSearch();
  }

  /** 选中一行候选 */
  function pick(s: SearchSuggestion) {
    if (s.kind === 'tool') {
      /* 和工具箱里的磁贴同一个动作。搜索词**不清** ——
         接着挑下一个时不用把刚才那两个字重打一遍 */
      window.open(s.bookmark.url, '_blank', 'noopener,noreferrer');
    } else if (s.kind === 'post') {
      /* 文章是站内的，用不上"新标签页"：直接换页更顺 */
      navigate(`/knowledge/${s.post.id}`);
      setQ('');
    } else if (s.kind === 'suggest') {
      /* 候选词本身就是"拿它去搜"，所以直接当搜索词提交，
         不必先把它填回输入框再让用户按一次回车 */
      runSearch(s.word);
    } else {
      runSearch();
    }
    setSugIndex(-1);
    setSugOpen(false);
  }

  return (
    <section
      aria-label="搜索"
      className="focus-card sky relative p-4 sm:p-6"
      style={{ '--se-h': tint.h, '--se-s': `${tint.s}%` } as CSSProperties}
    >
      {/* 右上角一团同色相的柔光（换引擎时整块面的颜色跟着变）。
          绝对定位铺满、内容是 z-10，所以它只出现在背景这一层。 */}
      <span aria-hidden className="se-glow pointer-events-none absolute inset-0" />

      <div className="relative z-10">
        {/* 引擎切换：每颗标签带**自己的品牌色** —— 色相由 lib/engine-color.ts
            按域名给出，所以用户在设置里加任何一个引擎，它都自带颜色，
            不必再多填一个色值。选中那颗换白底 + 一圈同色相细边 + 软投影。
            gap-2（8px）：相邻可点元素之间至少留 8px，手指才不会点到隔壁；
            左边不留负边距 —— 第一颗胶囊的左缘和白条左缘对齐，
            这条竖线比省几像素重要得多。 */}
        <div role="group" aria-label="选择搜索引擎" className="flex flex-wrap items-center gap-2">
          {engines.map((e) => {
            const t = engineTint(e.url);
            const on = e.id === engine.id;
            /* 多彩品牌（Google）逐字上色，其余整块一个颜色 */
            const letters = engineLetters(e.url, e.name);
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => setPicked(e.id)}
                aria-pressed={on}
                data-active={on ? 'true' : undefined}
                style={{ '--se-h': t.h, '--se-s': `${t.s}%` } as CSSProperties}
                className="se-chip h-8 shrink-0 rounded-full px-3.5 text-xs font-medium"
              >
                {letters ? (
                  <span aria-hidden className="se-ml">
                    {letters.map((c, i) => (
                      <span key={i} style={{ color: c }}>
                        {e.name[i]}
                      </span>
                    ))}
                  </span>
                ) : (
                  e.name
                )}
              </button>
            );
          })}
        </div>

      {/* 白条与搜索按钮同处一个容器：间距、对齐、聚焦环都只在这一层处理，
          不必用绝对定位去压输入框的右侧内边距（那样窄屏上按钮会盖住文字）。
          h-14 比常规输入框高一档 —— 这是首页唯一的主动作。
          按钮是选中引擎的实心品牌色，聚焦环也染成同一色相：换引擎时整块
          搜索区一起换色，这是它"有颜色"的主要来源。
          （黄橙那段色相白图标压不住，由 data-bright 压深一档，见 engine-color.ts） */}
      <form role="search" onSubmit={submit} className="mt-4">
        {/* 联想面板锚在这一层：左右都与白条齐平，于是它天生不会越出屏幕
            （工具箱那个框的教训：锚在输入框窄边、面板却更宽，窄窗口下会有一截
            跑到视口外面，看上去就是"打字没反应"） */}
        <div ref={suggRef} className="relative">
          <div className="se-bar flex h-14 items-center gap-2 rounded-field pl-4 pr-1.5">
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                /* 每敲一下都把高亮拉回"没选中"：否则回车会打在上一条上，
                   而它跟这次输的词可能毫无关系 */
                setSugIndex(-1);
                setSugOpen(true);
              }}
              onFocus={() => {
                if (needle) setSugOpen(true);
              }}
              onKeyDown={(e) => {
                /* Esc 两级退路：先收下拉，已经收着就把词清掉 */
                if (e.key === 'Escape') {
                  if (sugVisible) {
                    e.preventDefault();
                    setSugOpen(false);
                  } else if (q) {
                    e.preventDefault();
                    setQ('');
                  }
                  return;
                }
                if (!sugVisible) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const delta = e.key === 'ArrowDown' ? 1 : -1;
                  /* 从"没高亮"进来时：↓ 落到第一条，↑ 落到最后一条（= 搜索）。
                     之后环绕，比"到头就不动"少一次茫然 */
                  setSugIndex((i) =>
                    i < 0 ? (delta > 0 ? 0 : rows.length - 1) : (i + delta + rows.length) % rows.length,
                  );
                  return;
                }
                /* 只有真的高亮着某一条时才拦回车；否则回车照旧 = 搜索 */
                if (e.key === 'Enter' && sugActive >= 0) {
                  e.preventDefault();
                  pick(rows[sugActive]);
                }
              }}
              placeholder={`在 ${engine.name} 中搜索`}
              aria-label={`用 ${engine.name} 搜索`}
              /* 不用 type="search"：WebKit 会再画一个原生清除叉，
                 和右边那颗搜索按钮挤在同一角上，看着像出了故障。
                 手机上要的"回车即搜"由 enterKeyHint 给。 */
              enterKeyHint="search"
              /* 关掉浏览器自己的补全：它和这一份会叠着弹，两个候选框打架 */
              autoComplete="off"
              spellCheck={false}
              /* combobox + listbox 那套：方向键改的是 aria-activedescendant，
                 焦点始终留在输入框里，读屏会跟着念当前那一条 */
              role="combobox"
              aria-expanded={sugVisible}
              aria-controls={sugVisible ? 'home-suggest' : undefined}
              aria-autocomplete="list"
              aria-activedescendant={sugVisible && sugActive >= 0 ? `home-suggest-${sugActive}` : undefined}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              data-bright={isBrightHue(tint.h) ? '' : undefined}
              aria-label={`用 ${engine.name} 搜索`}
              title={`用 ${engine.name} 搜索`}
              className="se-go grid h-11 w-11 shrink-0 place-items-center rounded-field"
            >
              <Search size={17} aria-hidden />
            </button>
          </div>

          {sugVisible ? (
            <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-field border border-line bg-panel shadow-pop">
              <ul
                id="home-suggest"
                role="listbox"
                aria-label="本地面板与文章"
                className="max-h-[19rem] overflow-y-auto overscroll-contain py-1"
              >
                {rows.map((s, i) => (
                  <li
                    key={
                      s.kind === 'tool'
                        ? `t:${s.bookmark.id}`
                        : s.kind === 'post'
                          ? `p:${s.post.id}`
                          : s.kind === 'suggest'
                            ? `s:${s.word}`
                            : 'search'
                    }
                    /* listbox 的子元素只该是 option，包一层的 li 交还给普通列表语义 */
                    role="presentation"
                  >
                    <button
                      type="button"
                      id={`home-suggest-${i}`}
                      role="option"
                      aria-selected={i === sugActive}
                      /* mousedown 而不是 click：click 之前输入框已经失焦，
                         外面那层"点别处就收"会抢先关掉下拉，这一下就点空了 */
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        pick(s);
                      }}
                      /* 44px 是触控目标的下限（22px 图标 + 上下各 11px 内边距正好够） */
                      className={cls(
                        'flex min-h-[44px] w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                        i === sugActive ? 'bg-accent-soft' : 'hover:bg-bg-2',
                      )}
                    >
                      {s.kind === 'tool' ? (
                        <>
                          <SiteIcon bookmark={s.bookmark} size={22} />
                          <span
                            className={cls(
                              'min-w-0 flex-1 truncate text-[13px]',
                              i === sugActive ? 'text-accent' : 'text-ink',
                            )}
                          >
                            {s.bookmark.name}
                          </span>
                          <span className="shrink-0 text-2xs text-faint">{groupName(s.bookmark.group)}</span>
                        </>
                      ) : s.kind === 'post' ? (
                        <>
                          {/* 图标占位与 SiteIcon 的 22px 对齐，一行行才会齐 */}
                          <span aria-hidden className="grid h-[22px] w-[22px] shrink-0 place-items-center text-faint">
                            <BookOpen size={15} />
                          </span>
                          <span
                            className={cls(
                              'min-w-0 flex-1 truncate text-[13px]',
                              i === sugActive ? 'text-accent' : 'text-ink',
                            )}
                          >
                            {s.post.title}
                          </span>
                          <span className="shrink-0 text-2xs text-faint">{POST_TYPE_LABEL[s.post.type] ?? '文章'}</span>
                        </>
                      ) : s.kind === 'suggest' ? (
                        <>
                          <span aria-hidden className="grid h-[22px] w-[22px] shrink-0 place-items-center text-faint">
                            <TrendingUp size={15} />
                          </span>
                          <span
                            className={cls(
                              'min-w-0 flex-1 truncate text-[13px]',
                              i === sugActive ? 'text-accent' : 'text-ink',
                            )}
                          >
                            {s.word}
                          </span>
                          {/* 标出来源：这几行是外面给的，和上面"自己的东西"不是一回事 */}
                          <span className="shrink-0 text-2xs text-faint">
                            {remoteLabel ? `${remoteLabel} 建议` : '搜索建议'}
                          </span>
                        </>
                      ) : (
                        <>
                          <span aria-hidden className="grid h-[22px] w-[22px] shrink-0 place-items-center text-faint">
                            <Search size={15} />
                          </span>
                          <span
                            className={cls(
                              'min-w-0 flex-1 truncate text-[13px]',
                              i === sugActive ? 'text-accent' : 'text-ink',
                            )}
                          >
                            用 {engine.name} 搜索「{q.trim()}」
                          </span>
                          <span className="shrink-0 text-2xs text-faint">回车</span>
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="border-t border-line px-3 py-1 text-2xs text-faint">↑↓ 选择 · Enter 选中 · Esc 关掉</p>
            </div>
          ) : null}
        </div>
      </form>
      </div>
    </section>
  );
}

/**
 * KPI 行：节点 pve 的四个实时读数。
 * 这一行原本是"四张死数据卡"——清单能点、任务能点、常用网站能点，只有它不能，
 * 所以看着像个贴上去的组件。现在整行归到「监控快照」这个模块下：
 * 有自己的小标题、有出口（点卡片进监控数据页）、有悬浮反馈，和页面其它块同一个层级。
 */
function KpiRow() {
  const { overview } = useMonitor();
  const status = overview?.status;
  const power = overview?.power;
  const cpu = status?.cpu ?? 0;
  const memRatio = status?.memory.total ? status.memory.used / status.memory.total : 0;

  const tiles = [
    {
      label: 'CPU 负载',
      value: (cpu * 100).toFixed(1),
      unit: '%',
      hint: `${status?.cpuinfo?.cores ?? '—'} 核的瞬时占用`,
      tile: 'blue',
      icon: <Cpu size={18} />,
      progress: cpu,
      tone: cpu > 0.85 ? 'crit' : cpu > 0.65 ? 'warn' : 'accent',
    },
    {
      label: '内存占用',
      value: status?.memory.total ? (memRatio * 100).toFixed(1) : '—',
      unit: status?.memory.total ? '%' : '',
      hint: `已用 ${fmtBytes(status?.memory.used ?? 0)} / 共 ${fmtBytes(status?.memory.total ?? 0, 0)}`,
      tile: 'purple',
      icon: <MemoryStick size={18} />,
      progress: memRatio,
      tone: memRatio > 0.9 ? 'crit' : memRatio > 0.75 ? 'warn' : 'accent',
    },
    {
      // 多路插座时这是合计值，标题不能还写"整机"
      label: power && power.ha.sockets.length > 1 ? '监控总功耗' : '整机功耗',
      value: power ? power.watts.toFixed(1) : '—',
      unit: power ? 'W' : '',
      hint: `${
        power?.source === 'ha' ? '米家智能插座实测' : power?.source === 'sensor' ? '硬件传感器读数' : '按各部件功耗模型估算'
      }${power ? ` · 今日 ${fmtEnergy(power.today.kwh)}` : ''}`,
      tile: 'orange',
      icon: <Zap size={18} />,
      progress: power ? Math.min(1, power.watts / 260) : 0,
      tone: power && power.watts > 200 ? 'warn' : 'accent',
    },
    {
      label: '预估月电费',
      value: power ? fmtMoney(power.projection.monthCost, power.price.currency) : '—',
      unit: '',
      hint: power
        ? `插座${power.window.hasFullWindow ? '近一月' : '累计'} ${fmtEnergy(power.projection.monthKwh)} × ${power.price.perKwh} 元/kWh`
        : '按插座用电量与电价折算',
      tile: 'green',
      icon: <Receipt size={18} />,
      // 进度条表示滚动窗口攒了多少：未满 30 天时月用量还不是完整的月
      progress: power ? Math.min(1, power.window.days / power.window.windowDays) : 0,
      tone: 'accent',
    },
  ];

  return (
    <section aria-label="监控快照">
      <div className="mb-3.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">监控快照</h2>
          <p className="mt-1 text-2xs text-muted">节点 {overview?.node ?? '—'} 的实时读数，点任意一张进监控数据页</p>
        </div>
        <Link
          to="/monitoring"
          className="inline-flex shrink-0 items-center gap-1 text-2xs text-accent transition-colors hover:text-accent-hover"
        >
          查看全部
          <ArrowUpRight size={11} />
        </Link>
      </div>

      {/* 四张独立卡：各自带边框，边界清楚；再给每张配一句说明，
          数字才有上下文，不至于只是四个孤零零的读数 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to="/monitoring" className="group block rounded-xl2">
            <Stat
              label={t.label}
              value={t.value}
              unit={t.unit}
              hint={t.hint}
              tile={t.tile}
              icon={t.icon}
              progress={t.progress}
              tone={t.tone as 'accent' | 'warn' | 'crit'}
              className="h-full border border-line transition-colors duration-200 group-hover:border-accent/45"
            />
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * 本周最重要的三件事。
 * 卡片撑满右列高度：顶部补一块「本周任务完成度」，底部钉一个跳转链接，
 * 中间用 flex-1 吸收高度差——否则左边的清单一长，右边就留一块说不通的空白。
 */
function TopThree() {
  const { tickets } = useStore();
  const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  /* 回收站与归档里的任务不算"还在跑"：移进去以后它们就该从首页的指标里消失，
     否则在任务页删掉一条，这里的「还剩 N 件」反而会变多 */
  const live = tickets.filter((t) => !t.deletedAt && !t.archivedAt);
  const open = live.filter((t) => t.status !== 'done');
  const top = open
    .slice()
    .sort((a, b) => rank[a.priority] - rank[b.priority] || String(a.due ?? '').localeCompare(String(b.due ?? '')))
    .slice(0, 3);
  const doneCount = live.length - open.length;
  const weekPct = live.length ? Math.round((doneCount / live.length) * 100) : 0;

  return (
    <Card className="flex h-full flex-col">
      <CardHead title="本周最重要的三件事" hint="按优先级从未结束的任务里挑" />

      <div className="mb-4 rounded-field bg-bg-2 px-3.5 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xs text-muted">本周任务完成</span>
          <span className="num text-[15px] font-semibold leading-none">
            {doneCount}
            <span className="text-xs font-normal text-faint">/{live.length}</span>
          </span>
        </div>
        <span aria-hidden className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-panel">
          <span
            className="block h-full rounded-full transition-[width] duration-500 ease-out"
            style={{
              width: `${weekPct}%`,
              backgroundImage: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 72%, #0a1a3c))',
            }}
          />
        </span>
        <p className="mt-2 text-2xs text-faint">还剩 {open.length} 件没收尾</p>
      </div>

      {top.length === 0 ? (
        <Empty title="本周任务已全部结束" hint="去「任务」新建一件。" />
      ) : (
        /* 整行都是一个链接，不只是标题：这一行里没有别的可点东西
           （今日待办那几行左边有勾选框，所以那边只有标题是链接），
           整行可点在这里既统一，又把触摸目标从一行小字扩到整条。
           目标同样是任务页现成的 ?open=<id> 深链。
           space-y 从 3.5 收到 1：行内多出来的 py-1.5 是给悬浮底色留的，
           合起来才和原来的行距一样密。 */
        <ol className="flex-1 space-y-1">
          {top.map((t, i) => (
            <li key={t.id}>
              <Link
                to={`/week?open=${encodeURIComponent(t.id)}`}
                className="group -mx-2 flex gap-3 rounded-field px-2 py-1.5 transition-colors hover:bg-bg-2/70"
              >
                <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-2xs font-semibold text-accent">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium transition-colors group-hover:text-accent">{t.title}</p>
                  <p className="mt-1 truncate text-2xs text-faint">
                    {t.project} · {STATUS_META[t.status]?.label ?? t.status}
                    {t.due ? `（截止 ${String(t.due).slice(5, 10)}）` : ''}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}

      <Link
        to="/week"
        className="mt-4 inline-flex w-fit items-center gap-1 border-t border-line pt-3.5 text-2xs text-accent transition-colors hover:text-accent-hover"
      >
        查看全部任务
        <ArrowUpRight size={11} />
      </Link>
    </Card>
  );
}

/** 页脚提示带：说明数据从哪来、什么时候取的 */
function HintStrip() {
  const { lastUpdated, error } = useMonitor();
  return (
    <p className="rounded-xl2 bg-bg-2 px-4 py-3 text-2xs leading-relaxed text-muted">
      待办与任务的改动会立刻写入 MySQL。
      {error || !lastUpdated
        ? '监控数据暂时不可用，可在「设置 → Proxmox 连接」里点「测试连接」排查。'
        : `监控数据最近一次采样在 ${new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}。`}
    </p>
  );
}

/* ══════════════════════════════════════════════════════════════════
   今日待办（置顶区块）
   ══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   今日执行清单
   ══════════════════════════════════════════════════════════════════ */

/**
 * 右对齐的到期文案。把「截止 2026-10-18」这种书面语压成「逾期 3 天 / 今天 / 3 天后」，
 * 窄格里放得下，扫一眼也知道急不急。
 */
function dueMeta(due: string | undefined, today: string): { text: string; tone: string } | null {
  if (!due) return null;
  const days = Math.round((Date.parse(`${due}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000);
  if (Number.isNaN(days)) return { text: due.slice(5), tone: 'text-faint' };
  if (days < 0) return { text: `逾期 ${Math.abs(days)} 天`, tone: 'text-crit' };
  if (days === 0) return { text: '今天', tone: 'text-warn' };
  if (days === 1) return { text: '明天', tone: 'text-muted' };
  if (days <= 7) return { text: `${days} 天后`, tone: 'text-muted' };
  return { text: due.slice(5), tone: 'text-faint' };
}

function TodayTodos() {
  const { todos, todosApi, tickets, ticketsApi } = useStore();
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [showDone, setShowDone] = useState(true);

  const today = todayStr();
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const overdue = open.filter((t) => t.due && t.due < today);
  const visible = showDone ? [...open, ...done] : open;

  /* 「今日待办」原本只认待办清单那张表，跟任务表互不相干 ——
     在任务页建的活在这里一条都看不到，看起来就像"没载入"，其实是压根不同源。
     这里把未完成任务一并纳进来，排成：已逾期 → 今天到期 → 其余。 */
  const openTickets = tickets
    .filter((t) => t.status !== 'done' && !t.deletedAt && !t.archivedAt)
    .sort((a, b) => {
      // due 可能是带时刻的 ISO 串，先截到日期再比：
      // 否则 '2026-10-04T10:00:00Z' <= '2026-10-04' 为假，今天到期的会被排到"以后"
      const key = (d: unknown) => {
        const s = d ? String(d).slice(0, 10) : '';
        return !s ? 2 : s <= today ? 0 : 1;
      };
      return key(a.due) - key(b.due) || String(a.due ?? '').slice(0, 10).localeCompare(String(b.due ?? '').slice(0, 10));
    });
  const openCount = open.length + openTickets.length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText('');
    await todosApi.add(value, priority);
  }

  return (
    <Card className="flex h-full flex-col">
      <CardHead
        title="今日待办"
        hint={`${openCount} 项未完成 · 已逾期 ${overdue.length} 项，已完成 ${done.length} 项`}
        right={
          <>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="rounded-full bg-bg-2 px-2.5 py-1 text-2xs text-muted transition-colors hover:bg-bg-3 hover:text-ink"
            >
              {showDone ? '隐藏已完成' : '显示已完成'}
            </button>
            {done.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => void todosApi.clearDone()}>
                清理
              </Button>
            ) : null}
          </>
        }
      />

      <form onSubmit={submit} className="mb-3 flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="今天要做什么？回车即可加入"
          aria-label="新增待办"
        />
        <Select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          className="w-[4.5rem] shrink-0"
          aria-label="优先级"
        >
          {PRIORITY_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" size="icon" className="h-[2.35rem] w-[2.35rem] shrink-0" aria-label="添加待办">
          <Plus size={16} />
        </Button>
      </form>

      {openTickets.length === 0 && visible.length === 0 ? (
        <Empty
          title="今天还没有待办"
          hint="在上面输入一条，回车就加进来了；任务页里新建的未完成工作也会出现在这里。"
        />
      ) : (
        <div className="flex-1 space-y-0.5">
          {/* 未完成任务排在前面：它们才是"今天要交"的东西，待办清单更像随手的速记 */}
          {openTickets.length ? (
            <>
              <p className="px-2 pb-1 pt-1 text-2xs text-faint">进行中的任务</p>
              <ul className="space-y-0.5">
                {openTickets.map((t) => {
                  const due = t.due ? String(t.due) : null;
                  const late = Boolean(due && due < today);
                  return (
                    <li key={t.id} className="group flex items-start gap-3 rounded-field px-2 py-2.5 transition-colors hover:bg-bg-2/70">
                      <button
                        type="button"
                        onClick={() => void ticketsApi.patch(t.id, { status: 'done' })}
                        aria-label={`完成任务「${t.title}」`}
                        className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-xs border border-line-strong transition-colors hover:border-accent"
                      />
                      <div className="min-w-0 flex-1">
                        {/* 直接进那一条工单：`?open=<id>` 是任务页现成的深链入口，
                            进去后它自己会把参数从地址栏摘掉（见 Week.tsx）。
                            原来只跳到 /week —— 落地是整张任务表，还得自己再找一遍。 */}
                        <Link
                          to={`/week?open=${encodeURIComponent(t.id)}`}
                          className="block truncate text-[13.5px] leading-snug text-ink transition-colors hover:text-accent"
                        >
                          {t.title}
                        </Link>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="num text-2xs text-faint">{t.id}</span>
                          <PriorityBadge priority={t.priority} />
                          {due ? (
                            <span className={cls('num text-2xs', late ? 'text-crit' : 'text-muted')}>
                              {late ? '已逾期 ' : '截止 '}
                              {due.slice(5, 10)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {visible.length ? (
            <>
              {openTickets.length ? <p className="px-2 pb-1 pt-3 text-2xs text-faint">待办清单</p> : null}
              <ul className="space-y-0.5">
                {visible.map((todo) => {
            const late = !todo.done && todo.due && todo.due < today;
            const meta = dueMeta(todo.due, today);
            return (
              <li key={todo.id} className="group flex items-start gap-3 rounded-field px-2 py-2.5 transition-colors hover:bg-bg-2/70">
                <button
                  type="button"
                  onClick={() => void todosApi.toggle(todo)}
                  aria-label={todo.done ? '标记为未完成' : '标记为完成'}
                  className={cls(
                    'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors',
                    todo.done ? 'border-transparent bg-accent text-on-accent' : 'border-line-strong hover:border-accent',
                  )}
                >
                  {todo.done ? <Check size={11} strokeWidth={3} /> : null}
                </button>

                <div className="min-w-0 flex-1">
                  <p className={cls('text-[13.5px] leading-snug', todo.done && 'text-faint line-through')}>{todo.text}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <PriorityBadge priority={todo.priority} />
                    {late ? <span className="text-2xs text-crit">已逾期</span> : null}
                  </div>
                </div>

                {/* 右对齐的到期信息，对应参考图里那一列时长 */}
                {meta ? <span className={cls('num mt-0.5 shrink-0 whitespace-nowrap text-2xs', meta.tone)}>{meta.text}</span> : null}

                <button
                  type="button"
                  onClick={() => void todosApi.remove(todo.id)}
                  aria-label="删除待办"
                  className="mt-0.5 shrink-0 rounded-field p-1 text-faint opacity-0 transition-opacity hover:text-crit group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
                })}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════
   常用网站
   ══════════════════════════════════════════════════════════════════ */
function QuickLinks() {
  const { bookmarks, groups, bookmarksApi } = useStore();
  const [activeGroup, setActiveGroup] = useState<string>('all');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [creating, setCreating] = useState(false);

  /* 只显示标记为常用的入口。
     但一个都没标过时退回"全部" —— 否则这块会突然空掉，看上去像数据丢了。
     一旦有人开始标记，就只认标记，这才是"常用"的意义。
     标记本身在「编辑工具」弹窗里的「设为常用」开关上（工具箱那边也一样），
     这一页只负责把标过的东西摆出来。 */
  const pinned = bookmarks.filter((b) => b.pinned);
  const fallback = pinned.length === 0;
  const scoped = fallback ? bookmarks : pinned;

  const filtered = activeGroup === 'all' ? scoped : scoped.filter((b) => b.group === activeGroup);

  return (
    <Card>
      <CardHead
        title="常用网站"
        hint={
          fallback
            ? `${bookmarks.length} 个入口 · 还没标记常用，编辑工具时打开「设为常用」即可挑选`
            : `${pinned.length} 个常用 · 编辑工具里的「设为常用」可增减`
        }
        right={
          <Button size="sm" variant="soft" onClick={() => setCreating(true)}>
            <Plus size={13} />
            添加
          </Button>
        }
      />

      <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
        <Tag active={activeGroup === 'all'} onClick={() => setActiveGroup('all')}>
          全部 {scoped.length}
        </Tag>
        {groups.map((g) => {
          const count = scoped.filter((b) => b.group === g.id).length;
          if (!count) return null;
          return (
            <Tag key={g.id} active={activeGroup === g.id} onClick={() => setActiveGroup(g.id)}>
              {g.name} {count}
            </Tag>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <Empty
          title="这个分组还是空的"
          hint="把每天都要打开的面板加进来，之后一键直达。"
          action={
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus size={13} />
              添加网站
            </Button>
          }
        />
      ) : (
        /* 正方形磁贴：图标在上、名字在下，一眼扫过去就是"一排入口"。
           配色直接借工具箱那套 tb-card（品牌色 / 糖纸色）—— 首页与工具箱
           于是是同一族磁贴，不会出现"首页一种、工具箱另一种"。
           列数按"一张约 90~100px"定：再大，一屏就放不下几个。
           间距给到 gap-4（16px）—— 原来的 8px 正好压在"相邻可点元素
           最小间距"的下限上，磁贴一大就显得挤在一起。 */
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-13">
          {filtered.map((bm) => {
            const brand = brandTint(bm.color);
            return (
              <div key={bm.id} className="group relative">
                <a
                  href={bm.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={bm.note ? `${bm.name} · ${hostOf(bm.url)} · ${bm.note}` : `${bm.name} · ${hostOf(bm.url)}`}
                  data-brand={brand ? '' : undefined}
                  style={brand ? ({ '--tb-h': brand.h, '--tb-s': `${brand.s}%` } as CSSProperties) : undefined}
                  className={cls(
                    'tb-card flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl2 p-1.5',
                    brand ? '' : `tb-tint-${paletteTint(bm.id || bm.name)}`,
                  )}
                >
                  <span className="tb-icon grid place-items-center">
                    <SiteIcon bookmark={bm} size={30} fill />
                  </span>
                  <span className="w-full truncate px-1 text-center text-xs font-medium text-ink">{bm.name}</span>
                </a>
                <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-field bg-panel/85 p-0.5 backdrop-blur-sm opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => setEditing(bm)}
                    aria-label={`编辑 ${bm.name}`}
                    className="rounded-field p-1.5 text-faint transition-colors hover:bg-panel hover:text-ink"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void bookmarksApi.remove(bm.id)}
                    aria-label={`删除 ${bm.name}`}
                    className="rounded-field p-1.5 text-faint transition-colors hover:bg-panel hover:text-crit"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <BookmarkModal
        open={creating || Boolean(editing)}
        bookmark={editing}
        groups={groups}
        defaultGroup={activeGroup === 'all' ? groups[0]?.id : activeGroup}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={async (payload) => {
          if (editing) await bookmarksApi.patch(editing.id, payload);
          else await bookmarksApi.add(payload as Partial<Bookmark> & { name: string; url: string });
          setCreating(false);
          setEditing(null);
        }}
      />
    </Card>
  );
}

/* ── 骨架 ─────────────────────────────────────────────────────────── */
/* 形状照着真实布局摆：搜索条 + 四张监控小卡 + 常用网站 + 两张大卡。
   骨架的价值就是"数据到达时高度不跳"，所以这里不用一套通用形状糊过去。
   末尾原本还跟着一行「转圈 + 正在加载工作台数据…」，已删：上面的块已经在说
   同一件事，再挂一行等于把"加载中"说了两遍。读屏播报交给 sr-only 那句。 */
function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4" role="status" aria-busy="true">
      {/* 搜索条：浅蓝焦点面 = 上下内边距 + 一行 32px 引擎标签 + 一条 56px 输入框 */}
      <Skeleton className="h-[136px] sm:h-[152px]" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px]" />
        ))}
      </div>
      {/* 常用网站：一排正方形磁贴（约 132px 一档：卡头 + 标签行 + 一行磁贴） */}
      <Skeleton className="h-[132px]" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 lg:col-span-2" />
        <Skeleton className="h-72" />
      </div>
      <span className="sr-only">正在加载工作台数据…</span>
    </div>
  );
}
