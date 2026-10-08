import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  CheckSquare,
  LayoutGrid,
  LogOut,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Users,
  Wrench,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtTokens, todayTokens, usageTip, useAiUsage } from '@/lib/ai-usage';
import { useStore } from '@/lib/store';
import { useMonitor } from '@/lib/monitor';
import { useAuth } from '@/lib/auth';
import { initialTheme, switchTheme, type AccentName, type ThemeMode } from '@/lib/theme';
import { applyBackground } from '@/lib/background';
import { cls } from '@/lib/format';
import { Button, Led, LiveDot, Skeleton, Spinner } from './ui';
import { SlideHighlight, useSlideBox } from './SlideHighlight';
import { Assistant } from './Assistant';

/* ── 导航定义 ─────────────────────────────────────────────────────── */

/** 一项导航。单独定类型是为了 `short` 可选：不加的话，数组里只要有一项带了它，
 *  TypeScript 会把每一项推成"有的有、有的没有"的联合类型，读 item.short 就报错 */
type NavItem = {
  to: string;
  label: string;
  /** 手机底栏的短名（那一格只放得下两个汉字）。侧栏标签统一四个字之后，
   *  底栏那八格全都放不下，所以每一项都得给；没给就退回 label */
  short?: string;
  hint: string;
  icon: typeof LayoutGrid;
  end: boolean;
  group: string;
};

export const NAV: NavItem[] = [
  /* 名字统一四字：侧栏那八行看起来是一组，而不是"两字、三字、五字"混着排。
     四字在手机底栏放不下（那一格只够两个汉字），所以每一项都配了 short；
     原名里被压掉的信息（AI 热点、智能办公室）留在 hint 与页面自己的 <h1> 里。 */
  { to: '/', label: '今日概览', short: '概览', hint: '今日待办与常用入口', icon: LayoutGrid, end: true, group: '每天' },
  { to: '/week', label: '任务计划', short: '任务', hint: '项目、分类与截止', icon: CheckSquare, end: false, group: '每天' },
  /* 智能办公紧挨着任务：这两处都是"今天要处理的"；工具是翻一次就走的目录，排在后面 */
  { to: '/office', label: '智能办公', short: '办公', hint: '智能办公室 · Hermes 员工与工位', icon: Users, end: false, group: '每天' },
  { to: '/toolbox', label: '常用工具', short: '工具', hint: '分类工具网站', icon: Wrench, end: false, group: '每天' },
  { to: '/monitoring', label: '监控数据', short: '监控', hint: 'PVE 硬件与功耗', icon: Activity, end: false, group: '看与查' },
  /* 知识文库往前：查 SOP 是带目的的，刷热点是随手——常用的排前面 */
  { to: '/knowledge', label: '知识文库', short: '知识', hint: 'SOP 与 Runbook', icon: BookOpen, end: false, group: '看与查' },
  { to: '/news', label: '每日热点', short: '热点', hint: 'AI 热点，每日自动更新', icon: Sparkles, end: false, group: '看与查' },
  { to: '/settings', label: '系统设置', short: '设置', hint: '主题与备份', icon: SettingsIcon, end: false, group: '系统' },
];

/**
 * 当前落在哪个导航项上（返回 NAV 里的 to）。
 *
 * 页面标题和滑动高亮块都要用它，所以只在这里判定一次 ——
 * 两处各写一遍匹配规则的话，改一条路由就会出现"标题是这一项、
 * 高亮块钉在另一项"的错位。
 */
function activeNavKey(pathname: string) {
  return (NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to))) ?? NAV[0]).to;
}

/** 页面名不再出现在顶栏，只用来同步浏览器标签标题 */
function usePageTitle() {
  const { pathname } = useLocation();
  const page = NAV.find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to))) ?? NAV[0];
  useEffect(() => {
    document.title = `${page.label} · 个人工作台`;
  }, [page]);
}

/* ── 外壳 ─────────────────────────────────────────────────────────── */

/** 页面懒加载时的兜底。这里不知道将要出现的是哪一页，所以只摆最通用的一屏：
    一条页头 + 一块通栏 + 两栏卡面。比原来那条"转圈 + 正在加载…"好在
    文档高度相近 —— 页面 chunk 到位时不会整页往下推一截。 */
function PageLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4" role="status" aria-busy="true">
      <Skeleton className="h-7 w-40 rounded-field" />
      <Skeleton className="h-20" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <span className="sr-only">正在加载…</span>
    </div>
  );
}

export function AppShell() {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [theme, setTheme] = useState(() => initialTheme());
  const { settings } = useStore();
  usePageTitle();
  const staleVersion = useUpdateNotice();

  /* 服务端保存的主题优先（首次进入或换设备时） */
  useEffect(() => {
    if (!settings?.theme) return;
    const mode = settings.theme.mode as ThemeMode;
    const accent = settings.theme.accent as AccentName;
    setTheme({ mode, accent });
    switchTheme(mode, accent);
  }, [settings?.theme?.mode, settings?.theme?.accent]);

  /* 背景图同理：存服务端，落到 :root 上。
     uploadedAt 也要看——换了图但 kind/overlay 没变时，得靠它更新图片地址。 */
  useEffect(() => {
    applyBackground(settings?.background);
  }, [
    settings?.background?.kind,
    settings?.background?.url,
    settings?.background?.overlay,
    settings?.background?.blur,
    settings?.background?.uploadedAt,
    settings?.background?.hasUpload,
  ]);

  /* Ctrl/Cmd + K 唤起助手 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAssistantOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function flipTheme() {
    const next: ThemeMode = theme.mode === 'dark' ? 'light' : 'dark';
    setTheme({ ...theme, mode: next });
    switchTheme(next, theme.accent);
  }

  return (
    <div className="relative z-10 flex min-h-screen w-full">
      {/* 全站唯一的一条 mesh 光带，压在控制台最上沿 */}
      <span aria-hidden className="accent-rail pointer-events-none fixed inset-x-0 top-0 z-40 h-[2px]" />

      {/* 跳到主内容。键盘用户此前每切一次页，都要先 Tab 过顶栏再 Tab 过左轨
          那 8 个导航项才到得了正文。平时 sr-only（视觉上不存在），
          一旦被 Tab 聚焦就浮到左上角。
          z-[60] 必须高过顶栏和那条 mesh 光带（z-40），否则浮出来也看不见。 */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-field focus:border focus:border-line focus:bg-panel focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-ink focus:shadow-pop"
      >
        跳到主内容
      </a>

      {/* 左轨：磨砂玻璃立柱。底色半透明 + 24px 背板模糊 + 亮白描边，
          具体样式在 index.css 的 .rail 里（跟随主题切换底色与描边强度）。
          注意这里不能再用 bg-panel：不透明工具类会盖掉 .rail 的半透明底。 */}
      <aside className="rail sticky top-0 hidden h-screen w-[228px] shrink-0 flex-col lg:flex">
        <div className="px-4 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-9 w-9 place-items-center rounded-field ring-1 ring-inset ring-white/25"
              style={{
                backgroundImage: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-deep) 100%)',
                boxShadow: '0 5px 16px -8px rgba(20, 40, 80, 0.3), 0 1px 2px rgba(20, 40, 80, 0.2)',
              }}
            >
              <span className="flex flex-col gap-[3px]">
                <i className="block h-[2px] w-4 rounded-full bg-white/95" />
                <i className="block h-[2px] w-3 rounded-full bg-white/70" />
                <i className="block h-[2px] w-2 rounded-full bg-white/45" />
              </span>
            </span>
            {/* 副标题那行 "HOME LAB · CONSOLE" 已删。
                它对内网工具没有任何信息量，只是让界面"看起来像个产品"；
                真正的状态在左轨底部那块（连接状态、整机读数）。 */}
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-tight">个人工作台</p>
            </div>
          </div>

          {/* 左上角的 AI 助手入口 */}
          <button
            type="button"
            onClick={() => setAssistantOpen(true)}
            className="group mt-4 flex w-full items-center gap-2.5 rounded-field border border-accent/25 bg-accent-soft px-3 py-2.5 text-left transition-colors duration-150 hover:border-accent/50"
          >
            <Sparkles size={15} className="shrink-0 text-accent transition-transform duration-200 group-hover:scale-110" />
            <span className="flex-1 text-[13px] font-medium text-ink">AI 助手</span>
            {/* 用 text-ink：蓝立柱里 pill 是浅蓝块，压 faint 只有 3:1 */}
            <kbd className="num border border-line bg-panel px-1.5 py-0.5 text-[10px] text-ink">⌘K</kbd>
          </button>
        </div>

        {/* 品牌区与导航之间压一道分隔线：立柱内容其实分两块，
            没有这条线，品牌、AI 入口和下面那排导航项连成一片 */}
        <div aria-hidden className="mx-3 mt-3 h-px bg-gradient-to-r from-transparent via-line to-transparent" />

        {/* 侧栏不再有滑动高亮块：当前页只由「强调色字重 + 左缘刻度条」标出
            （见下面 NavLink 里的指示条）。
            底部导航那一块保留 —— 那是另一个容器，手机上没有侧栏 */}
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2">
          {NAV.map((item, i) => (
            <Fragment key={item.to}>
              {/* 分组标题：只在分组切换处出现一次 */}
              {item.group !== NAV[i - 1]?.group ? (
                <p className="flex items-center gap-2 px-3 pb-1.5 pt-3.5 text-2xs font-medium tracking-wide text-faint first:pt-0.5">
                  {item.group}
                  {/* 标题后接一条延伸细线：把分组切干净。
                      原来只有一小撮灰字悬在两项之间，看不出是"分区"还是"某一项"。 */}
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </p>
              ) : null}
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cls(
                  /* 选中态只剩字色和字重：侧栏不再画那块高亮底，
                     当前页靠左缘那道刻度条钉住（见下面的指示条 span） */
                  'group relative flex items-center gap-2.5 rounded-field px-3 py-2.5 text-[13px] transition-colors duration-150',
                  isActive ? 'font-semibold text-accent' : 'font-medium text-muted hover:bg-bg-2/70 hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {/* 选中指示条：左缘一道实色刻度。浅色轨上只靠浅蓝胶囊，
                      当前页在视觉上不够"钉住"，扫一眼定位不到。
                      不发光：它本身已经是纯强调色，靠和轨底色的色相差就钉得住，
                      再往外撒一圈彩雾只会让它看着像颗 LED。 */}
                  <span
                    aria-hidden
                    className={cls(
                      'absolute left-[3px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full transition-opacity duration-150',
                      isActive ? 'opacity-100' : 'opacity-0',
                    )}
                    style={isActive ? { background: 'var(--accent)' } : undefined}
                  />
                  {/* 图标套一层定宽容器：各图标视觉重量不同，
                      直接排会让文字左边参差不齐 */}
                  {/* aria-hidden：图标只是给"科技感"的一眼定位，
                      导航项的名字由后面的文字给。lucide 默认不注入 aria-hidden，
                      不关掉的话读屏会在每个导航项前多念一个无名图形 */}
                  <span aria-hidden className="grid h-[18px] w-[18px] shrink-0 place-items-center">
                    <item.icon
                      size={16}
                      className={cls('transition-colors', isActive ? 'text-accent' : 'text-faint group-hover:text-muted')}
                    />
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                </>
              )}
            </NavLink>
            </Fragment>
          ))}
        </nav>

        <RailFooter />
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar theme={theme} onFlipTheme={flipTheme} onOpenAssistant={() => setAssistantOpen(true)} />

        {/* id + tabIndex=-1：跳过链接要真的把焦点搬到正文来。
            光有 href="#main" 在部分浏览器里只滚动、不移动焦点。
            scroll-mt-20：顶栏是 sticky 的，不留出这一段，
            跳过去之后标题会被压在顶部栏下面 */}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 scroll-mt-20 px-3 pb-28 pt-4 sm:px-5 lg:pb-10">
          {/* 页面是按路由懒加载的，这里兜住加载那一下。
              兜底刻意做得和页面里的加载态同款，避免"先白一下再出现内容" */}
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <MobileNav />
      <Toasts />
      <UpdateNotice show={staleVersion} />
      <Assistant open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}

/* ── 左轨页脚：状态收口卡 ─────────────────────────────────────────── */
function RailFooter() {
  const { overview, error, secondsLeft } = useMonitor();
  const demo = overview?.mode === 'demo';
  const label = error ? '监控不可用' : demo ? '演示数据' : '正常运转';

  // 整机读数：CPU 是 0~1 的小数，内存要自己算百分比
  const cpu = overview?.status?.cpu ?? null;
  const mem = overview?.status?.memory;
  const memPct = mem && mem.total ? (mem.used / mem.total) * 100 : null;

  return (
    <div className="p-3">
      {/* ── 收口卡：一块满强调色的面 ────────────────────────────────────
          侧栏从头到尾是浅蓝，走到这里用一块实色把视线收住；它同时也是
          "这台机器现在怎么样"的答案（不必为了看一眼状态再回首页）。

          卡上的标记一律走 --on-accent，**不再按阈值染色**：状态点的绿
          （#198038）压在强调蓝上只有 1.03:1，读数条的琥珀也只有 1.9:1 ——
          两种都读不出来。好坏改由**文字**说（正常运转 / 演示数据 /
          监控不可用），这也正是全站一贯的做法：徽章、告警都带文字，
          不靠色相单独表意。

          --on-accent 就是"压在强调色实心块上的前景"（浅色主题是白，
          深色主题是深墨 —— 那里的强调色本身是浅蓝）。所以下面这些
          bg-on-accent/25、bg-on-accent 两套主题都成立。 */}
      <div className="rounded-field bg-accent px-3 py-3 text-on-accent">
        <div className="flex items-center gap-2">
          {/* currentColor：跟着卡上的前景色走，深色主题下自动翻成深墨 */}
          <LiveDot color="currentColor" ping={!error} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{label}</span>
          <span className="num shrink-0 text-2xs">{error ? '离线' : `${secondsLeft}s`}</span>
        </div>

        {cpu === null && memPct === null ? null : (
          <div className="mt-3 space-y-2">
            {cpu !== null ? <RailMeter label="CPU" value={cpu * 100} /> : null}
            {memPct !== null ? <RailMeter label="内存" value={memPct} /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 收口卡上的一根读数条。不复用 Meter：它自带 6px 高度和整块背景，
 * 压进 228px 宽的轨里会把"状态读数"抬成一张图表卡，抢了上面导航的分量。
 *
 * 不再按阈值染色（原来是 >65% 琥珀、>85% 红）：这块底是实色强调，
 * 只有 --on-accent 的对比度够。越界与否在监控页那几根大读数条上看，
 * 侧栏这一格只需要回答"现在大概什么水位"。
 * 标签与数值的层次交给字重（数值 font-medium），不靠透明度 ——
 * 12px 的小字用 80% 的 --on-accent 只有 3.9:1，够不到 4.5:1。
 */
function RailMeter({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs">{label}</span>
        <span className="num text-2xs font-medium">{pct.toFixed(1)}%</span>
      </div>
      <span aria-hidden className="mt-1 block h-1 overflow-hidden rounded-full bg-on-accent/25">
        <span
          className="block h-full rounded-full bg-on-accent transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/* ── 顶栏 ─────────────────────────────────────────────────────────── */
function TopBar({
  theme,
  onFlipTheme,
  onOpenAssistant,
}: {
  theme: { mode: ThemeMode; accent: AccentName };
  onFlipTheme: () => void;
  onOpenAssistant: () => void;
}) {
  const [clock, setClock] = useState(() => new Date());
  const { overview, error } = useMonitor();
  const { enabled: authEnabled, user, logout } = useAuth();

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const tone = error ? 'crit' : overview?.mode === 'demo' ? 'warn' : 'ok';
  const label = error ? '监控离线' : overview?.mode === 'demo' ? '演示数据' : '实时采集中';

  return (
    /* 顶栏只是状态条：页面名归 PageHead，这里不再重复一遍标题 */
    <header className="glass relative sticky top-0 z-30 border-b border-line">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button variant="soft" size="sm" className="lg:hidden" onClick={onOpenAssistant}>
            <Sparkles size={13} className="text-accent" />
            AI
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <TokenUsage />
          {/* 采集状态：一个会呼吸的点 + 文案，替代"藏在角落"的连接信息 */}
          <span className="hidden items-center gap-1.5 border border-line px-2 py-1 text-2xs text-muted md:inline-flex">
            <LiveDot tone={tone} ping={!error} />
            {label}
          </span>
          <RefreshIndicator />
          <span className="num hidden text-xs text-muted sm:inline">{clock.toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <Button variant="ghost" size="icon" onClick={onFlipTheme} aria-label={theme.mode === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
            {theme.mode === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </Button>
          {/* 退出登录：只有服务端开了登录才出现。
              放在顶栏而不是设置页里 —— 手机上没有左轨，设置页要翻半天才能退出去 */}
          {authEnabled && user ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void logout()}
              aria-label="退出登录"
              title={`退出登录（当前账号 ${user}）`}
            >
              <LogOut size={15} />
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * 顶栏的今日 token 消耗。
 *
 * 必须带上一句「今日消耗 Token」：光摆一个「3.5 万」，没人知道那是什么数。
 * 位置在"实时采集中"左边 —— 它和那个状态一样，回答的是"这台机器此刻在
 * 干什么"，而不是某张卡片里的业务数据。
 *
 * 显示**今日**而不是累计：累计只增不减，看久了等于没看。
 *
 * 这个数是**网关记账**（含智能办公室里那几位员工：定时任务、巡检、采集），
 * 不是面板自己调了几次 —— 面板自己那点只是其中一小块，光看它会以为一天没花什么。
 * 读到网关那份时在数后面缀一句「含员工」：否则"面板没怎么用过，怎么这么多"
 * 会让人以为数错了。悬停能看到按来源的拆分。网关那份还没读到时退回本地记账。
 */
function TokenUsage() {
  const usage = useAiUsage();
  if (!usage) return null;
  const gateway = usage.gateway;

  return (
    <span
      className="hidden items-center gap-1.5 border border-line px-2 py-1 text-2xs text-muted md:inline-flex"
      title={usageTip(usage)}
    >
      <Activity size={11} aria-hidden className="shrink-0 text-accent" />
      今日消耗 Token
      <span className="num font-medium text-ink">{fmtTokens(todayTokens(usage))}</span>
      {gateway ? <span className="hidden text-faint lg:inline">含员工</span> : null}
    </span>
  );
}

function RefreshIndicator() {
  const { loading, refresh, secondsLeft, lastUpdated } = useMonitor();
  const [manual, setManual] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        setManual(true);
        await refresh();
        setManual(false);
      }}
      className="group flex items-center gap-1.5 rounded-field border border-line bg-panel-2 px-2 py-1 text-2xs text-muted transition-colors hover:border-faint hover:text-ink"
      title={lastUpdated ? `上次更新 ${new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}` : '刷新监控数据'}
    >
      {loading || manual ? <Spinner className="h-3 w-3" /> : <RefreshCw size={11} className="group-hover:rotate-90 transition-transform duration-300" />}
      <span className="num">{loading || manual ? '读取中' : `${secondsLeft}s`}</span>
    </button>
  );
}

/* ── 移动端底部导航 ───────────────────────────────────────────────── */
function MobileNav() {
  const { pathname } = useLocation();
  const ref = useRef<HTMLElement>(null);
  /* inset 4：给圆角块留一圈呼吸。顶满整格就贴着格线了，看着像把格子填了色，
     而不是"这一项被选中" */
  const box = useSlideBox(ref, activeNavKey(pathname), 4);

  return (
    <nav
      ref={ref}
      className="glass fixed inset-x-0 bottom-0 z-30 grid border-t border-line pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_20px_-12px_rgba(20,40,80,.24)] lg:hidden"
      /* 列数按 NAV 的长度算，不写死。原来写的是 grid-cols-7：
         导航一多一项，第 8 项就换到第二行去，整个底栏跟着错位 ——
         而"加一个导航项"是再正常不过的改动。 */
      style={{ gridTemplateColumns: `repeat(${NAV.length}, minmax(0, 1fr))` }}
    >
      {/* 原本每项自己画的那道 2px 顶条撤掉了：一块圆角底已经说清"当前项"，
          再压一道实色条就成了两个各说一半的指示器。
          和左轨一样 —— 每个导航的指示器数量保持原样，只是让它会滑。 */}
      <SlideHighlight box={box} className="rounded-field bg-accent-soft" />
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          data-slide-key={item.to}
          className={({ isActive }) =>
            cls(
              'relative z-10 flex min-w-0 flex-col items-center gap-1 px-0.5 py-2.5 text-[10px] transition-colors',
              isActive ? 'text-accent' : 'text-faint',
            )
          }
        >
          <item.icon size={17} aria-hidden />
          {/* 底栏一格在手机上只有 ~48px，放得下两个汉字。左轨用完整名字，
              这里用 short（没给就退回全名）—— 否则"智能办公室"会被截成
              "智能办…"这种既读不通、又占两行的东西 */}
          <span className="w-full truncate text-center">{item.short ?? item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/* ── 轻提示 ───────────────────────────────────────────────────────── */
function Toasts() {
  const { toasts, dismissToast } = useStore();
  /* 容器常驻，不随"有没有消息"挂载 / 卸载。
     读屏只在**已经存在**的 live region 里播报新增内容：
     原来空的时候整块 return null，等于每次都要先建一个 empty 区域再往里塞，
     第一条提示永远不会被念出来。
     aria-atomic="false"：只念新增的那一条。默认的 true 会把当前
     所有提示整段重念一遍，连着来两条时会重复。 */
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-20 right-4 z-50 flex flex-col items-end gap-2 lg:bottom-6"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismissToast(t.id)}
          className="pointer-events-auto flex max-w-xs items-start gap-2 rounded-xl2 border border-line bg-panel px-3 py-2 text-left text-xs shadow-pop animate-fade-rise"
        >
          <Led tone={t.tone === 'ok' ? 'ok' : t.tone === 'warn' ? 'warn' : 'crit'} />
          <span className="text-ink">{t.text}</span>
        </button>
      ))}
    </div>
  );
}

/* ── 新版本提示 ───────────────────────────────────────────────────── */

/**
 * 部署新前端后，已经开着的页面不会自己更新，手里还是旧 JS（会按旧逻辑继续调接口）。
 * 这里在加载时记下产物版本，之后每分钟复查一次，变了就提示刷新。
 * 只提示、不自动重载：正在等助手回答或填表单时被强制刷新丢掉内容，比晚几分钟更新更糟。
 */
function useUpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let mine: string | null = null; // 本页面加载时服务器上的产物版本
    let stopped = false;

    const check = async () => {
      try {
        const { version } = await api.version();
        // dev 模式没有产物版本，取不到就当作这次没检查
        if (stopped || !version) return;
        if (mine === null) {
          mine = version;
          return;
        }
        if (version !== mine) setStale(true);
      } catch {
        // 这只是个便利功能，网络抖动不该打扰用户
      }
    };

    void check();
    const timer = window.setInterval(check, 60000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return stale;
}

function UpdateNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 lg:bottom-6">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-panel py-1.5 pl-3.5 pr-1.5 text-xs shadow-pop animate-fade-rise">
        <span className="text-ink">工作台有新版本</span>
        <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
          刷新
        </Button>
      </div>
    </div>
  );
}
