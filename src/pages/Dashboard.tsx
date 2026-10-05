import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Cpu, ExternalLink, MemoryStick, Pencil, Plus, Receipt, Trash2, Zap } from 'lucide-react';
import { useStore } from '@/lib/store';
import { BookmarkModal, SiteIcon } from '@/components/bookmarks';
import { useMonitor } from '@/lib/monitor';
import { type Bookmark, type Priority } from '@/lib/api';
import { cls, fmtBytes, fmtEnergy, fmtMoney, hostOf, todayStr } from '@/lib/format';
import { dailyQuote } from '@/lib/quotes';
import { Button, Card, CardHead, Empty, Input, Select, Skeleton } from '@/components/ui';
import { PriorityBadge, Ring, STATUS_META, Stat, Tag } from '@/components/bits';

const PRIORITY_OPTIONS: Priority[] = ['P0', 'P1', 'P2', 'P3'];

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
      <FocusRow />
      <KpiRow />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TodayTodos />
        </div>
        <TopThree />
      </div>

      <QuickLinks />
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

/** 主卡 + 圆环：左边是"今天该干什么"，右边是"还剩多少" */
function FocusRow() {
  const { todos, tickets } = useStore();
  const { overview, error } = useMonitor();

  const status = overview?.status;
  // 待办清单（todos）和任务（tickets）是两张表：右边圆环量的是待办清单的完成度
  const pending = todos.filter((t) => !t.done);
  const doneToday = todos.length - pending.length;
  // 回收站与归档里的任务一律不计：它们已经不在工作流里了
  const liveTickets = tickets.filter((t) => !t.deletedAt && !t.archivedAt);
  const liveDone = liveTickets.filter((t) => t.status === 'done').length;
  const openTickets = liveTickets.length - liveDone;

  // 每日一句：按日期确定性挑选，同一天永远同一句，跨零点自然翻篇（见 lib/quotes.ts）
  const quote = dailyQuote();

  const chips = [
    // 用「进行中的任务数」而不是待办完成度：待办清单常常是空的，
    // 0/0 摆在那里只有噪音，跟下面「今日待办」卡片的口径也对不上
    { value: String(openTickets), unit: '件', label: '进行中的任务' },
    { value: `${liveDone}/${liveTickets.length}`, label: '本周任务已完成' },
    { value: status ? String(Math.floor(status.uptime / 86400)) : '—', unit: '天', label: '节点连续运行' },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]">
      <section className="focus-card relative overflow-hidden rounded-xl2 p-5 sm:p-7">
        <div className="relative z-10">
          <p className="text-2xs tracking-[0.14em] opacity-90">
            今日主题 · {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
          </p>
          {/* 大字留给一句能读进去的话，数据交给下面那句和三个指标——
              卡片才有喘息的余地。语录按日期确定，不会每次渲染都换 */}
          <h2 className="mt-3 max-w-lg text-[22px] font-semibold leading-snug sm:text-[25px]">{quote.text}</h2>
          {quote.from ? <p className="mt-2 text-2xs opacity-70">{quote.from}</p> : null}
          <p className="mt-3 max-w-lg text-xs leading-relaxed opacity-90">
            {error ? `监控接口返回：${error}` : `本周还有 ${openTickets} 件任务没结束。`}
          </p>
          <div className="mt-6 flex flex-wrap gap-x-7 gap-y-4 sm:gap-x-9">
            {chips.map((c) => (
              <div key={c.label}>
                <p className="num text-[22px] font-semibold leading-none">
                  {c.value}
                  {c.unit ? <span className="ml-1 text-xs font-normal opacity-90">{c.unit}</span> : null}
                </p>
                <p className="mt-1.5 text-2xs opacity-90">{c.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel flex flex-col items-center justify-center gap-4 p-5 sm:p-6">
        {/* 待办清单为空时圆环改为量任务：不然永远是 0/1，一个没有信息量的读数 */}
        <Ring value={todos.length ? doneToday : liveDone} total={todos.length || liveTickets.length || 1} />
        <p className="max-w-[13rem] text-center text-2xs leading-relaxed text-muted">
          {pending.length
            ? `还剩 ${pending.length} 件，先挑最重要那件。`
            : openTickets
              ? `待办已清空，还有 ${openTickets} 件任务在跑。`
              : '今天的清单已经清空。'}
        </p>
      </section>
    </div>
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

  /* 只显示标了星（常用）的入口。
     但一个都没标过时退回"全部" —— 否则这块会突然空掉，看上去像数据丢了。
     一旦有人开始标记，就只认标记，这才是"常用"的意义。 */
  const pinned = bookmarks.filter((b) => b.pinned);
  const fallback = pinned.length === 0;
  const scoped = fallback ? bookmarks : pinned;

  const filtered = activeGroup === 'all' ? scoped : scoped.filter((b) => b.group === activeGroup);
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? '未分组';

  return (
    <Card>
      <CardHead
        title="常用网站"
        hint={
          fallback
            ? `${bookmarks.length} 个入口 · 还没标记常用，去工具箱点星标挑选`
            : `${pinned.length} 个常用 · 在工具箱点星标可增减`
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
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((bm) => (
            <div key={bm.id} className="group relative">
              <a
                href={bm.url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-3 rounded-field bg-bg-2/70 p-2.5 pr-16 transition-colors hover:bg-accent-soft"
              >
                <SiteIcon bookmark={bm} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{bm.name}</span>
                  <span className="num block truncate text-2xs text-faint">
                    {hostOf(bm.url)}
                    {bm.note ? ` · ${bm.note}` : ''}
                  </span>
                </span>
              </a>
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
                <a
                  href={bm.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`打开 ${bm.name}`}
                  className="rounded-field p-1.5 text-faint transition-colors hover:bg-panel hover:text-ink"
                >
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          ))}
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
          else await bookmarksApi.add(payload as { name: string; url: string });
          setCreating(false);
          setEditing(null);
        }}
      />
    </Card>
  );
}

/* ── 骨架 ─────────────────────────────────────────────────────────── */
/* 形状照着真实布局摆：两栏头图 + 四张小卡 + 两张大卡 + 一张通栏。
   骨架的价值就是"数据到达时高度不跳"，所以这里不用一套通用形状糊过去。
   末尾原本还跟着一行「转圈 + 正在加载工作台数据…」，已删：上面的块已经在说
   同一件事，再挂一行等于把"加载中"说了两遍。读屏播报交给 sr-only 那句。 */
function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-4" role="status" aria-busy="true">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]">
        <Skeleton className="h-[220px]" />
        <Skeleton className="h-[220px]" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 lg:col-span-2" />
        <Skeleton className="h-72" />
      </div>
      <Skeleton className="h-44" />
      <span className="sr-only">正在加载工作台数据…</span>
    </div>
  );
}
