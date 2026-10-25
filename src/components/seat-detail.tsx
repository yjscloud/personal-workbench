import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Armchair,
  Boxes,
  Check,
  Clock,
  Copy,
  FileText,
  FolderArchive,
  KeyRound,
  MessagesSquare,
  RefreshCw,
  Send,
  Shield,
  ShieldAlert,
  Sparkles,
  Sprout,
  Square,
  Target,
  X,
  Zap,
} from 'lucide-react';
import {
  api,
  type OfficeChatEvent,
  type OfficeEmployee,
  type OfficeGuardHealth,
  type OfficeGuardIp,
  type OfficeGuardPending,
  type OfficeGuardProfile,
  type OfficeGuardSeverity,
  type OfficeHarvestItem,
  type OfficeHarvestRun,
  type OfficeMessage,
  type OfficeSeatChip,
  type OfficeSeatTab,
  type OfficeSeatTabKey,
  type OfficeSession,
} from '@/lib/api';
import { cls, fmtDateTime, fmtDuration, fmtRelative } from '@/lib/format';
import { useStore } from '@/lib/store';
import { Badge, Button, Led, Skeleton, Spinner, buttonClass } from '@/components/ui';
import { Markdown } from '@/components/Markdown';

/* ────────────────────────────────────────────────────────────────────────
 * 工位详情：点开一位员工之后那个弹窗
 * ────────────────────────────────────────────────────────────────────────
 * 结构与上游控制台一致：抬头是"头像 + 名字 + 岗位 + 四个小标签"，下面是页签，
 * 每个岗位的页签集合不一样（进化档案只给本体；MCP 与值守不能对话）。
 *
 * 页签集合、抬头标签的口径都由**服务端**给（见 server/services/office.js）：
 * 那是上游自己定的规矩，抄一份到前端，两边迟早会不一致。
 * ──────────────────────────────────────────────────────────────────────── */

const wan = (n: number | null | undefined) => `${((Number(n) || 0) / 10000).toFixed(2)}万`;
const at = (sec: number | null | undefined) => (Number.isFinite(Number(sec)) ? Number(sec) * 1000 : null);

/**
 * 页签的表头（图标 + 文案 + 图标色）。顺序就是显示的顺序。
 *
 * 图标**各自一色**（和上游控制台一致）：一排页签里五个同位素图标长得都差不多，
 * 给它们分色之后，"我要找的是那个橙色文件夹"比"第几个"好认得多。
 * 颜色只落在图标上，文字保持中性 —— 一排彩色文字会把整条位置变成彩虹。
 * 选中态则统一交给 accent（连图标一起），否则会出现"橙图标 + 蓝下划线"这种
 * 两个各说一半的指示。
 */
const TAB_META: Record<OfficeSeatTabKey, { label: string; icon: typeof FileText; color: string }> = {
  config: { label: '配置文档', icon: FileText, color: 'text-slate-400' },
  skills: { label: '技能列表', icon: Boxes, color: 'text-violet-500' },
  evo: { label: '进化档案', icon: Sprout, color: 'text-sky-500' },
  guard: { label: '边界守望', icon: Shield, color: 'text-emerald-500' },
  memory: { label: '工作记录 & 记忆库', icon: FolderArchive, color: 'text-amber-500' },
  chat: { label: '即时交互', icon: MessagesSquare, color: 'text-rose-400' },
};

const CHIP_ICON = { seat: Armchair, token: Zap, clock: Clock, target: Target };

/* ── 弹窗外壳 ──────────────────────────────────────────────────────────
 * 照 ui.tsx 里 Modal 的那套约定：Esc 关、锁背景滚动、scrim 点击关、
 * role=dialog + aria-modal，并且**保留可见焦点**（键盘用户要知道焦点在哪）。
 * 窄屏铺满整宽：中间弹窗在手机上留出的一圈背景只会挤掉正文宽度。
 */
export function ModalShell({
  open,
  onClose,
  label,
  width = 'max-w-3xl',
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  width?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="scrim fixed inset-0" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cls(
          'panel relative z-10 flex max-h-[90vh] w-full flex-col overflow-hidden outline-none',
          width,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** 页签数据：按 (员工, 页签) 缓存，来回切页签不重复拉 */
const tabCache = new Map<string, OfficeSeatTab>();

function useSeatTab(seat: string, tab: OfficeSeatTabKey, enabled: boolean) {
  const key = `${seat}:${tab}`;
  const [data, setData] = useState<OfficeSeatTab | null>(() => tabCache.get(key) ?? null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (force = false) => {
      if (!enabled) return;
      const hit = force ? null : tabCache.get(key);
      if (hit) {
        setData(hit);
        setError('');
        return;
      }
      setLoading(true);
      api.office
        .seatTab(seat, tab)
        .then((d) => {
          tabCache.set(key, d);
          setData(d);
          setError('');
        })
        .catch((err) => setError(err instanceof Error ? err.message : '读取失败'))
        .finally(() => setLoading(false));
    },
    [enabled, key, seat, tab],
  );

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: () => load(true) };
}

/* ── 抬头 ───────────────────────────────────────────────────────────── */

function Chip({ chip }: { chip: OfficeSeatChip }) {
  const Icon = CHIP_ICON[chip.icon] ?? Target;
  const text = chip.seconds != null ? fmtDuration(chip.seconds) : (chip.value ?? '—');
  return (
    <span
      title={chip.tip}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel/70 px-2.5 py-1 text-2xs text-muted"
    >
      <Icon size={12} aria-hidden className="shrink-0 text-faint" />
      <span className="text-faint">{chip.label}</span>
      <span className="num font-medium text-ink">{text}</span>
    </span>
  );
}

function SeatHead({
  employee,
  chips,
  online,
  onClose,
}: {
  employee: OfficeEmployee;
  chips: OfficeSeatChip[];
  online: boolean;
  onClose: () => void;
}) {
  return (
    <div className="relative shrink-0 border-b border-line bg-gradient-to-r from-accent-soft/70 via-panel/40 to-transparent px-4 py-4">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="h-[68px] w-[68px] shrink-0 overflow-hidden rounded-xl2 border border-line bg-panel"
        >
          <img src={employee.avatar} alt="" className="h-full w-full object-cover object-top" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold leading-tight text-ink">{employee.name}</span>
            <span className="text-xs text-faint">{employee.en}</span>
            <span
              className={cls(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium',
                online ? 'bg-ok-soft text-ok' : 'bg-bg-3 text-muted',
              )}
            >
              <Led tone={online ? 'ok' : 'neutral'} />
              {online ? '在线' : '离线'}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted">{employee.role}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <Chip key={c.key} chip={c} />
            ))}
          </div>
        </div>

        {/* 右上角那盏"呼吸灯"：与在线状态同源，文字在名字旁边也写了一遍 */}
        <span className="hidden shrink-0 flex-col items-center gap-1 pr-8 sm:flex" aria-hidden>
          <span
            className={cls(
              'grid h-9 w-9 place-items-center rounded-full border',
              online ? 'border-ok/40 bg-ok-soft' : 'border-line bg-bg-2',
            )}
          >
            <span className={cls('h-2.5 w-2.5 rounded-full', online ? 'bg-ok' : 'bg-faint')} />
          </span>
          <span className={cls('text-2xs', online ? 'text-ok' : 'text-faint')}>{online ? '在线' : '离线'}</span>
        </span>

        <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" className="absolute right-3 top-3">
          <X size={16} />
        </Button>
      </div>
    </div>
  );
}

/* ── 页签条 ─────────────────────────────────────────────────────────── */

function TabBar({
  tabs,
  value,
  onChange,
}: {
  tabs: OfficeSeatTabKey[];
  value: OfficeSeatTabKey;
  onChange: (t: OfficeSeatTabKey) => void;
}) {
  return (
    <div role="tablist" className="scrollbar-none flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3">
      {tabs.map((t) => {
        const meta = TAB_META[t];
        const Icon = meta.icon;
        const active = t === value;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t)}
            className={cls(
              'relative flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs transition-colors',
              active ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {/* 选中时图标跟着走 accent，未选中各用本色 */}
            <Icon size={13} aria-hidden className={active ? undefined : meta.color} />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── 页签内容 ───────────────────────────────────────────────────────── */

/** 数据来源条。上游每个页签顶部都有这么一条，写清"这些数是哪来的" */
function SourceNote({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-field bg-bg-2 px-3 py-2 text-2xs leading-relaxed text-muted">
      <span className="shrink-0 text-faint">数据来源：</span>
      <span className="min-w-0 break-all">{text.replace(/`/g, '')}</span>
    </p>
  );
}

function PaneError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-field bg-warn-soft px-3 py-2 text-2xs leading-relaxed text-warn">
      <AlertTriangle size={13} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onRetry} className="shrink-0 rounded-[3px] underline decoration-dotted">
        重试
      </button>
    </p>
  );
}

function DocPane({ seat }: { seat: string }) {
  const { data, error, loading, reload } = useSeatTab(seat, 'config', true);
  const { notify } = useStore();
  const [copied, setCopied] = useState(false);

  const doc = data?.kind === 'doc' ? data : null;

  async function copy() {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.markdown);
      setCopied(true);
      notify?.('已复制这份文档的 Markdown');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      notify?.('复制失败：浏览器没给剪贴板权限', 'crit');
    }
  }

  return (
    <div className="space-y-3">
      {doc ? <SourceNote text={doc.source} /> : null}
      {error ? <PaneError text={error} onRetry={reload} /> : null}
      {loading && !doc ? <Skeleton className="h-64" /> : null}
      {doc ? (
        <>
          <div className="flex justify-end">
            <Button variant="soft" size="sm" onClick={() => void copy()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? '已复制' : '复制 MD'}
            </Button>
          </div>
          <div className="rounded-field border border-line bg-panel px-4 py-3">
            <Markdown className="text-xs">{doc.markdown}</Markdown>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SkillsPane({ seat }: { seat: string }) {
  const { data, error, loading, reload } = useSeatTab(seat, 'skills', true);
  const [q, setQ] = useState('');
  const list = data?.kind === 'skills' ? data : null;

  const items = (list?.items ?? []).filter((it) =>
    q.trim() ? `${it.name} ${it.description} ${it.meta} ${it.tags.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()) : true,
  );

  return (
    <div className="space-y-3">
      {error ? <PaneError text={error} onRetry={reload} /> : null}
      {loading && !list ? <Skeleton className="h-64" /> : null}
      {list ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs text-muted">
              共 <b className="num text-ink">{list.total}</b> 项
            </span>
            {list.groups.map((g) => (
              <Badge key={g.label} tone="neutral">
                {g.label} {g.count}
              </Badge>
            ))}
            {list.items.length > 12 ? (
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="筛选…"
                aria-label="筛选列表"
                className="ml-auto w-40 rounded-field border border-line bg-bg-2 px-2.5 py-1.5 text-2xs text-ink outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/35"
              />
            ) : null}
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {items.map((it) => (
              <li key={`${it.name}-${it.meta}`} className="rounded-field border border-line bg-bg-2 px-3 py-2.5">
                <p className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-ink">{it.name}</span>
                  {it.tags.map((t) => (
                    <Badge key={t} tone="accent">
                      {t}
                    </Badge>
                  ))}
                </p>
                <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-muted">{it.description || '—'}</p>
                {it.meta ? <p className="mt-1 truncate text-2xs text-faint">{it.meta}</p> : null}
              </li>
            ))}
            {!items.length ? <li className="text-2xs text-faint">没有匹配的项。</li> : null}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function EvoPane({ seat }: { seat: string }) {
  const { data, error, loading, reload } = useSeatTab(seat, 'evo', true);
  const evo = data?.kind === 'evo' ? data : null;
  return (
    <div className="space-y-3">
      {evo ? <SourceNote text={evo.source} /> : null}
      {error ? <PaneError text={error} onRetry={reload} /> : null}
      {loading && !evo ? <Skeleton className="h-64" /> : null}
      {evo ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {evo.stats.map((s) => (
              <div key={s.label} className="rounded-field bg-bg-2 px-3 py-2.5">
                <p className="text-2xs text-faint">{s.label}</p>
                <p className="num mt-1 truncate text-base font-semibold text-ink">{s.value}</p>
              </div>
            ))}
          </div>
          <ol className="relative space-y-4 border-l border-line pl-5">
            {evo.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} className="relative">
                <span
                  aria-hidden
                  className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-accent bg-panel"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{e.kind}</Badge>
                  <span className="text-2xs text-faint">{e.at ? fmtDateTime(e.at) : '—'}</span>
                  {e.right ? <span className="num ml-auto text-2xs text-faint">{e.right}</span> : null}
                </div>
                <p className="mt-1 break-all text-xs font-medium text-ink">{e.title}</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-muted">{e.text}</p>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

function MemoryPane({ seat }: { seat: string }) {
  const { data, error, loading, reload } = useSeatTab(seat, 'memory', true);
  const mem = data?.kind === 'memory' ? data : null;
  return (
    <div className="space-y-3">
      {error ? <PaneError text={error} onRetry={reload} /> : null}
      {loading && !mem ? <Skeleton className="h-64" /> : null}
      {mem ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
              工作记录
            </h4>
            <ol className="space-y-2.5 border-l border-line pl-4">
              {mem.records.map((r, i) => (
                <li key={`${r.at}-${i}`} className="relative">
                  <span aria-hidden className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-faint" />
                  <p className="text-2xs text-faint">{r.at}</p>
                  <p className="mt-0.5 break-words text-2xs leading-relaxed text-muted">{r.text}</p>
                </li>
              ))}
              {!mem.records.length ? <li className="text-2xs text-faint">还没有记录。</li> : null}
            </ol>
          </section>
          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-2" />
              记忆库（长期记忆）
            </h4>
            <ul className="space-y-2">
              {mem.memories.map((m, i) => (
                <li key={i} className="rounded-field bg-bg-2 px-3 py-2">
                  <Badge tone="neutral">{m.tag}</Badge>
                  <p className="mt-1.5 break-words text-2xs leading-relaxed text-muted">{m.text}</p>
                </li>
              ))}
              {!mem.memories.length ? (
                <li className="text-2xs leading-relaxed text-faint">这位岗位没有长期记忆条目。</li>
              ) : null}
            </ul>
          </section>
          {mem.note ? <p className="text-2xs leading-relaxed text-faint lg:col-span-2">{mem.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── 边界守望（尾流 · Edge Sentry）─────────────────────────────────────
 * 前置边界（frp 暴露出去的 SSH / RDP / 面板）被扫描与爆破的真实记录。
 *
 * 三件事决定了这一页的画法：
 * 1. **只显示上游的结论**。频率、服务广度、同段协同、字节数判定线全在采集器里，
 *    这里不再算一遍 —— 两套规则迟早会对同一个 IP 给出不同的档位。
 * 2. **采集源的健康度要单独摆出来**。整体一个"正常"会掩盖某一源瞎了
 *    （比如 frps 那台 ssh 超时），而"哪个源瞎了"恰恰决定了这份结论可不可信。
 * 3. **封禁是危险动作**。批准会在 frps 上真的执行 ipset add，所以按钮前面
 *    必须有一次明确的确认，且授权码要原样展示（人能核对它和申请单是不是同一条）。
 * ──────────────────────────────────────────────────────────────────── */

const SEV_TONE: Record<OfficeGuardSeverity, 'crit' | 'warn' | 'accent' | 'neutral'> = {
  CRITICAL: 'crit',
  HIGH: 'warn',
  MED: 'accent',
  LOW: 'neutral',
};

const num = (n: number | null | undefined) => (Number(n) || 0).toLocaleString('zh-CN');

const healthCls = (level: OfficeGuardHealth['level']) =>
  level === 'ok' ? 'text-ok' : level === 'down' ? 'text-crit' : level === 'off' ? 'text-faint' : 'text-warn';

function GuardBlock({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-field border border-line bg-panel px-3 py-2.5">
      <h4 className="mb-2 flex flex-wrap items-baseline gap-x-1.5 text-xs font-semibold text-ink">
        {title}
        {hint ? <span className="text-2xs font-normal text-faint">{hint}</span> : null}
      </h4>
      {children}
    </section>
  );
}

type ProfileState = { ip: string; loading: boolean; error: string; data: OfficeGuardProfile | null };

/** 单 IP 画像：连接 / 流量 / 用户名 / 封禁史四层证据合一（上游同款口径） */
function GuardProfileCard({ state, onClose }: { state: ProfileState; onClose: () => void }) {
  const d = state.data;
  const shell = (d?.timeline || []).some((t) => t.bytes >= 4000);
  return (
    <section className="rounded-field border border-accent/40 bg-accent-soft/40 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-semibold text-ink">攻击画像 · {state.ip}</span>
            {d ? (
              <>
                <span className="text-2xs text-muted">
                  近 {d.hours} 小时 <b className="num text-ink">{num(d.hits)}</b> 次
                </span>
                {shell ? <Badge tone="crit">⚠️ 有交互流量</Badge> : null}
              </>
            ) : null}
            {state.loading ? (
              <span className="flex items-center gap-1.5 text-2xs text-faint">
                <Spinner /> 正在读画像（首次要采 SSH 用户名，可能要十几秒）…
              </span>
            ) : null}
          </p>
          {state.error ? <p className="mt-1.5 text-2xs text-warn">画像读取失败：{state.error}</p> : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭画像">
          <X size={14} />
        </Button>
      </div>

      {d ? (
        <div className="mt-2 space-y-2">
          <p className="text-2xs leading-relaxed text-muted">
            目标：{d.services.length ? d.services.map((s) => `${s.name}×${s.hits}`).join('、') : '—'}
          </p>
          {d.dict.length ? (
            <p className="text-2xs leading-relaxed text-muted">
              SSH 字典（主机级）：
              {d.dict
                .slice(0, 2)
                .map((x) => `${x.host} ${x.users} 个用户名 / ${num(x.total)} 次${x.top.length ? `（${x.top.map((u) => u.user).join('、')}）` : ''}`)
                .join('；')}
            </p>
          ) : null}
          {d.subnet && d.subnetPeers.length ? (
            <p className="text-2xs leading-relaxed text-muted">
              同段：{d.subnet} 内另有 {d.subnetPeers.length} 个活跃来源
            </p>
          ) : null}
          <p className="text-2xs leading-relaxed text-muted">
            历史：累计 {num(d.lifetime?.total ?? d.hits)} 次
            {d.blocks.length ? ` · 封禁记录 ${d.blocks.length} 条` : ''}
            {d.first ? ` · 首次 ${d.first}` : ''}
          </p>
          <ol className="max-h-[180px] space-y-0.5 overflow-y-auto overscroll-contain rounded-field bg-panel/70 px-2 py-1.5">
            {d.timeline.slice(-24).map((t, i) => (
              <li key={`${t.ts}-${i}`} className="flex items-baseline gap-2 text-2xs leading-relaxed">
                <span className="num shrink-0 text-faint">{t.ts.slice(11, 19)}</span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {t.name}
                  {t.src === 'haproxy' ? <span className="ml-1 text-accent">haproxy</span> : null}
                </span>
                <span className={cls('num shrink-0', t.bytes >= 4000 ? 'font-medium text-crit' : 'text-faint')}>
                  {t.bytes ? `${num(t.bytes)}B` : '—'}
                </span>
              </li>
            ))}
            {!d.timeline.length ? <li className="text-2xs text-faint">（窗口内无事件）</li> : null}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function GuardStat({ label, value, tone }: { label: string; value: string; tone?: 'crit' | 'warn' }) {
  return (
    <div className="rounded-field bg-bg-2 px-2.5 py-2">
      <p
        className={cls(
          'num text-base font-semibold',
          tone === 'crit' ? 'text-crit' : tone === 'warn' ? 'text-warn' : 'text-ink',
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-2xs text-faint">{label}</p>
    </div>
  );
}

/**
 * 尾流的「边界守望」页签。
 *
 * 数据一次取全（`/office/seat/weiliu/tab/guard` 已经把快照、24 小时汇总、
 * 待授权与封禁史归并好了）。只有"画像"是按需再取 —— 它要去两台主机现采用户名，
 * 十几秒起步，不适合跟着页签一起等。
 */
function GuardPane({ seat }: { seat: string }) {
  const { data, error, loading, reload } = useSeatTab(seat, 'guard', true);
  const { notify } = useStore();
  const guard = data?.kind === 'guard' ? data : null;
  const [busy, setBusy] = useState('');
  const [profile, setProfile] = useState<ProfileState | null>(null);

  async function decide(p: OfficeGuardPending, approve: boolean) {
    const tip = approve
      ? `批准封禁 ${p.ip}？\n\n批准后会立刻在 frps 上执行 ipset add，记录到期 ${p.expiresAt || '—'}。\n理由：${p.reason || '（未填）'}`
      : `拒绝 ${p.ip} 这条封禁申请？`;
    if (!window.confirm(tip)) return;
    setBusy(p.ticket);
    try {
      await api.office.securityDecide(p.ticket, approve);
      notify?.(approve ? `已封禁 ${p.ip}` : `已拒绝 ${p.ip} 的封禁申请`);
      reload();
    } catch (e) {
      notify?.(e instanceof Error ? e.message : '操作失败', 'crit');
    } finally {
      setBusy('');
    }
  }

  async function openProfile(ip: string) {
    setProfile({ ip, loading: true, error: '', data: null });
    try {
      const d = await api.office.securityProfile(ip);
      setProfile({ ip, loading: false, error: '', data: d });
    } catch (e) {
      setProfile({ ip, loading: false, error: e instanceof Error ? e.message : '画像读取失败', data: null });
    }
  }

  const high = (guard?.topIps || []).filter((r) => r.severity === 'HIGH' || r.severity === 'CRITICAL');
  const shown = (high.length ? high : guard?.topIps || []).slice(0, 8);
  const maxHour = Math.max(1, ...(guard?.hourly || []).map((x) => x.n));

  return (
    <div className="space-y-3">
      {guard ? <SourceNote text={`${guard.source} · 生成于 ${fmtDateTime(guard.generatedAt)}`} /> : null}
      {error ? <PaneError text={error} onRetry={reload} /> : null}
      {loading && !guard ? <Skeleton className="h-64" /> : null}

      {guard ? (
        <>
          {!guard.ok && guard.error ? (
            <p className="flex items-start gap-2 rounded-field bg-crit-soft px-3 py-2 text-2xs leading-relaxed text-crit">
              <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0" />
              <span>采集异常：{guard.error}</span>
            </p>
          ) : null}

          {/* 采集健康度：哪个源瞎了一眼看出来，而不是整体一个「正常」 */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-field bg-bg-2 px-3 py-2 text-2xs text-muted">
            <span className="flex items-center gap-1.5 font-medium text-ink">
              <Shield size={12} aria-hidden />
              分析窗口 {guard.windowMin} 分钟
            </span>
            <span className={guard.ok ? 'text-ok' : 'text-crit'}>{guard.ok ? '采集正常' : '采集异常'}</span>
            {guard.health.map((h) => (
              <span
                key={h.src}
                title={[h.error, h.lastOk ? `最后成功 ${h.lastOk}` : ''].filter(Boolean).join(' · ')}
                className="whitespace-nowrap"
              >
                {h.label} <b className={healthCls(h.level)}>{h.levelLabel}</b>
                {h.ok === false && h.fails ? <span className="text-crit"> ×{h.fails}</span> : null}
              </span>
            ))}
            {guard.degraded.length ? <span className="text-warn">降级：{guard.degraded.join('、')}</span> : null}
          </p>

          {profile ? <GuardProfileCard state={profile} onClose={() => setProfile(null)} /> : null}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <GuardStat
              label={`当前窗口 ${guard.windowMin} 分钟来源`}
              value={num(guard.current.sources)}
              tone={guard.current.level === 'CRITICAL' ? 'crit' : undefined}
            />
            <GuardStat label="当前窗口连接" value={num(guard.current.total)} />
            <GuardStat label="近 24 小时连接" value={num(guard.summary24h.total)} />
            <GuardStat label="近 24 小时独立来源" value={num(guard.summary24h.sources)} />
          </div>

          {guard.pending.length ? (
            <GuardBlock title="待你授权" hint="白饭只能申请，执行必须你批准 · 授权码 6 小时内有效">
              <ul className="space-y-2">
                {guard.pending.map((p) => (
                  <li key={p.id} className="rounded-field border border-warn/40 bg-warn-soft/60 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <ShieldAlert size={13} aria-hidden className="text-warn" />
                      <span className="num text-sm font-semibold tracking-wide text-ink">{p.ip}</span>
                      <Badge tone="warn">申请 #{p.id}</Badge>
                      <code className="rounded bg-panel px-1.5 py-0.5 text-2xs tracking-[0.15em] text-ink">{p.ticket}</code>
                    </div>
                    <p className="mt-1 text-2xs leading-relaxed text-muted">{p.reason || '（未填理由）'}</p>
                    <p className="mt-1 text-2xs text-faint">
                      申请 {p.requestedAt || '—'} · 记录到期 {p.expiresAt || '—'} · 来自 {p.requestedBy || 'agent'}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button size="sm" disabled={busy === p.ticket} onClick={() => void decide(p, true)}>
                        {busy === p.ticket ? <Spinner /> : <Check size={12} />}
                        批准封禁
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy === p.ticket} onClick={() => void decide(p, false)}>
                        <X size={12} />
                        拒绝
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </GuardBlock>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <GuardBlock title="当前窗口来源" hint={high.length ? `其中高危 ${high.length} 个` : '窗口内没有高危'}>
              {shown.length && !high.length ? (
                <p className="mb-1.5 text-2xs leading-relaxed text-faint">
                  窗口内没有高危来源，扫描噪声只入库未告警；下面是全部来源。
                </p>
              ) : null}
              <ul className="space-y-1.5">
                {shown.map((r: OfficeGuardIp) => (
                  <li key={r.ip} className="rounded-field bg-bg-2 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={SEV_TONE[r.severity]}>{r.severityLabel}</Badge>
                      <span className="num text-xs font-medium text-ink">{r.ip}</span>
                      <span className="text-2xs text-muted">{num(r.hits)} 次</span>
                      {r.dual ? <span className="text-2xs text-accent">双源确认</span> : null}
                      {r.shell ? <Badge tone="crit">交互流量 {num(r.maxBytes)}B</Badge> : r.maxBytes ? (
                        <span className="num text-2xs text-faint">{num(r.maxBytes)}B</span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void openProfile(r.ip)}
                        className="ml-auto shrink-0 rounded-full border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                      >
                        画像
                      </button>
                    </div>
                    <p className="mt-1 text-2xs leading-relaxed text-faint">
                      {r.services.slice(0, 3).map((s) => `${s.name}×${s.hits}`).join('、') || '—'}
                      {r.anomalies.length ? ` · 突增 ${r.anomalies[0].name} ${r.anomalies[0].ratio}x` : ''}
                      {r.slow ? ` · 慢速 ${r.slow.days} 天/${r.slow.total} 次` : ''}
                    </p>
                  </li>
                ))}
                {!shown.length ? <li className="text-2xs text-faint">窗口内没有高危来源，扫描噪声只入库未告警。</li> : null}
              </ul>
            </GuardBlock>

            <GuardBlock title="近 24 小时" hint={`${num(guard.summary24h.services)} 个服务被扫`}>
              {guard.hourly.length ? (
                <>
                  <span className="flex h-[52px] items-end gap-[2px]" aria-hidden>
                    {guard.hourly.map((x) => (
                      <span
                        key={x.h}
                        title={`${x.h}:00 · ${x.n} 次`}
                        style={{ height: `${Math.max(2, Math.round((x.n / maxHour) * 48))}px` }}
                        className="flex-1 rounded-t-[2px] bg-accent/70"
                      />
                    ))}
                  </span>
                  <p className="mt-1 text-2xs text-faint">按小时（悬停看数值）</p>
                </>
              ) : null}
              {guard.topProxy.length ? (
                <ul className="mt-2 space-y-0.5">
                  {guard.topProxy.slice(0, 5).map((x) => (
                    <li key={x.name} className="flex items-baseline gap-2 text-2xs">
                      <span className="min-w-0 flex-1 truncate text-muted">{x.name}</span>
                      <span className="num shrink-0 font-medium text-ink">{num(x.n)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </GuardBlock>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <GuardBlock
              title="同段协同"
              hint={
                guard.dictOverlap
                  ? `与 ${guard.dictOverlap.a} 共用 ${num(guard.dictOverlap.shared)} 个生僻名`
                  : undefined
              }
            >
              <ul className="space-y-1">
                {guard.subnets.slice(0, 5).map((s) => (
                  <li key={s.cidr} className="flex flex-wrap items-baseline gap-x-2 text-2xs">
                    <Badge tone={SEV_TONE[s.severity]}>{s.severityLabel}</Badge>
                    <span className="num text-ink">{s.cidr}</span>
                    <span className="text-muted">
                      {s.ipCount} IP / {num(s.hits)} 次
                    </span>
                  </li>
                ))}
                {!guard.subnets.length ? <li className="text-2xs text-faint">窗口内没有成段协同的迹象。</li> : null}
              </ul>
            </GuardBlock>

            <GuardBlock title="SSH 字典" hint="主机级：sshd 只看到 haproxy 的地址">
              <ul className="space-y-1">
                {guard.dict.slice(0, 2).map((x) => (
                  <li key={x.host} className="text-2xs leading-relaxed">
                    <span className="text-ink">{x.host}</span>
                    <span className="text-muted">
                      {' '}
                      · <b className="num text-ink">{x.users}</b> 用户名 / {num(x.total)} 次
                      {x.capped ? '（采样封顶）' : ''}
                    </span>
                    {x.targeted.length ? (
                      <p className="text-warn">⚠️ 疑似针对性：{x.targeted.slice(0, 4).map((u) => u.user).join('、')}</p>
                    ) : null}
                  </li>
                ))}
                {!guard.dict.length ? <li className="text-2xs text-faint">还没有采到用户名。</li> : null}
              </ul>
            </GuardBlock>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <GuardBlock title="暴露面" hint="失联 / 未登记比扫描次数更值得看">
              <ul className="space-y-1">
                {guard.assets.slice(0, 8).map((a) => (
                  <li key={`${a.name}-${a.target}`} className="flex items-baseline gap-2 text-2xs">
                    <span
                      aria-hidden
                      className={cls('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', a.active ? 'bg-ok' : 'bg-crit')}
                    />
                    <span className="min-w-0 flex-1 truncate text-muted">{a.name}</span>
                    {!a.registered ? <span className="shrink-0 text-warn">未登记</span> : null}
                    {!a.external ? <span className="shrink-0 text-faint">非对外</span> : null}
                    {!a.active ? <span className="shrink-0 text-crit">失联</span> : null}
                  </li>
                ))}
                {!guard.assets.length ? <li className="text-2xs text-faint">没有暴露面记录。</li> : null}
              </ul>
            </GuardBlock>

            <GuardBlock title="宿主机登录" hint="真被打穿的硬证据">
              <ul className="space-y-1">
                {guard.authOk.slice(0, 4).map((a, i) => (
                  <li key={`${a.user}-${a.fromIp}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-2xs">
                    <KeyRound size={11} aria-hidden className="text-faint" />
                    <span className="text-ink">{a.user}</span>
                    <span className="text-faint">←</span>
                    <span className="num text-muted">{a.fromIp}</span>
                    <span className="text-muted">{a.n} 次</span>
                    {a.weak ? <Badge tone="crit">弱口令</Badge> : null}
                    {a.isNew ? <Badge tone="warn">新来源</Badge> : null}
                  </li>
                ))}
                {!guard.authOk.length ? <li className="text-2xs text-faint">窗口内没有成功登录记录。</li> : null}
              </ul>
            </GuardBlock>
          </div>

          <GuardBlock title="封禁记录" hint={guard.blocks.length ? `最近 ${Math.min(guard.blocks.length, 6)} 条` : undefined}>
            <ul className="space-y-1">
              {guard.blocks.slice(0, 6).map((b) => (
                <li key={b.id} className="flex flex-wrap items-baseline gap-x-2 text-2xs">
                  <span className="num shrink-0 text-faint">{(b.requestedAt || '').slice(5, 16) || '—'}</span>
                  <span className="num text-ink">{b.ip}</span>
                  <span
                    className={cls(
                      'font-medium',
                      b.status === 'executed' ? 'text-crit' : b.status === 'failed' ? 'text-warn' : 'text-faint',
                    )}
                  >
                    {b.statusLabel}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">{b.reason}</span>
                </li>
              ))}
              {!guard.blocks.length ? <li className="text-2xs text-faint">还没有封禁记录。</li> : null}
            </ul>
          </GuardBlock>

          <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-faint">
            <Activity size={12} aria-hidden className="mt-0.5 shrink-0" />
            判定线：单 IP {guard.thresholds.hitsHigh} 次/窗口为高危、{guard.thresholds.hitsCrit} 次为严重；同段{' '}
            {guard.thresholds.subnetIps} 个 IP 协同即报段扫描；haproxy 字节数 ≥ {guard.thresholds.bytesShell} 直接判严重（疑似已登入）。
            普通扫描只入库不发消息，只有跨档才唤醒白饭；白名单与内网来源不参与判定。
          </p>
        </>
      ) : null}
    </div>
  );
}

/* ── 即时交互 ───────────────────────────────────────────────────────── */

type Bubble = {
  role: 'user' | 'assistant';
  text: string;
  tool?: string | null;
  usage?: { total: number; input: number; output: number } | null;
  model?: string | null;
  error?: boolean;
};

/** 网关的记录里 role 可能是 tool / system，这里只画人和助手说的话 */
const spoken = (m: OfficeMessage) =>
  (m.role === 'user' || m.role === 'assistant') && Boolean(String(m.content || '').trim());

function ChatBubble({ bubble }: { bubble: Bubble }) {
  const mine = bubble.role === 'user';
  return (
    <div className={cls('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div
        className={cls(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-field px-3 py-2 text-xs leading-relaxed',
          mine ? 'bg-accent-soft text-ink' : bubble.error ? 'bg-crit-soft text-crit' : 'bg-bg-2 text-ink',
        )}
      >
        {bubble.text || (bubble.tool ? '' : '…')}
      </div>
      {bubble.tool ? (
        <span className="flex items-center gap-1.5 text-2xs text-faint">
          <Spinner /> 正在调用 {bubble.tool}…
        </span>
      ) : null}
      {bubble.usage ? (
        <span className="num text-2xs text-faint">
          本次 {wan(bubble.usage.total)} token（in {bubble.usage.input} / out {bubble.usage.output}）
          {bubble.model ? ` · ${bubble.model}` : ''}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 白饭的即时交互：真实会话（SSE 流式）。
 *
 * 用流式是必须的：Hermes 处理复杂问题实测几十秒，非流式的话点发送之后界面
 * 要冻住一整个回答的时间，用户会以为没发出去。所以先把气泡摆上、边收边填。
 * 发送中不禁用输入框（只禁用发送按钮）：几十秒里想改下一句很正常。
 */
function AgentChatPane({ seat }: { seat: string }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.office
      .chatHistory(30)
      .then((res) => {
        if (alive) setBubbles(res.data.filter(spoken).map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content })));
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : '读历史失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, [seat]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles, loading]);

  async function send() {
    const message = text.trim();
    if (!message || sending) return;
    setText('');
    setSending(true);
    setBubbles((cur) => [...cur, { role: 'user', text: message }, { role: 'assistant', text: '' }]);
    const patch = (fn: (b: Bubble) => Bubble) =>
      setBubbles((cur) => (cur.length ? [...cur.slice(0, -1), fn(cur[cur.length - 1])] : cur));
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.office.chat(
        seat,
        message,
        (event: OfficeChatEvent) => {
          if (event.type === 'delta') patch((b) => ({ ...b, text: b.text + event.text }));
          else if (event.type === 'tool') patch((b) => ({ ...b, tool: event.name }));
          else if (event.type === 'done') patch((b) => ({ ...b, tool: null, usage: event.usage, model: event.model }));
          else if (event.type === 'error') patch((b) => ({ ...b, tool: null, error: true, text: b.text || event.message }));
        },
        controller.signal,
      );
    } catch (e) {
      const msg = controller.signal.aborted ? '已停止' : e instanceof Error ? e.message : '发送失败';
      patch((b) => ({ ...b, tool: null, error: true, text: b.text || msg }));
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={bodyRef} role="log" aria-live="polite" className="min-h-[32vh] flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-4 py-4">
        {loading ? (
          <p className="flex items-center gap-2 text-2xs text-faint">
            <Spinner /> 正在读这段对话的历史…
          </p>
        ) : null}
        {err ? <p className="rounded-field bg-warn-soft px-2.5 py-2 text-2xs text-warn">读历史失败：{err}</p> : null}
        {!loading && !bubbles.length ? (
          <p className="text-2xs leading-relaxed text-faint">
            还没有聊过。发一句试试 —— 这条会话接的是办公室里的那个智能体，它有自己的工具与权限，会真的去做事。
          </p>
        ) : null}
        {bubbles.map((b, i) => (
          <ChatBubble key={i} bubble={b} />
        ))}
      </div>
      <ChatComposer
        value={text}
        onChange={setText}
        onSend={send}
        sending={sending}
        onStop={() => {
          abortRef.current?.abort();
          abortRef.current = null;
          setSending(false);
        }}
        placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
        label="给办公室的消息"
      />
    </div>
  );
}

function ChatComposer({
  value,
  onChange,
  onSend,
  sending,
  onStop,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  onStop: () => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="shrink-0 border-t border-line px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            /* Enter 发送、Shift+Enter 换行。多行提问很常见，所以换行要留着 */
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder={placeholder}
          aria-label={label}
          className="min-h-[52px] w-full resize-none rounded-field border border-line bg-bg-2 px-3 py-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/35"
        />
        {sending ? (
          <Button variant="soft" size="sm" className="shrink-0" onClick={onStop} title="停止这一轮">
            <Square size={13} />
            停止
          </Button>
        ) : (
          <Button size="sm" className="shrink-0" disabled={!value.trim()} onClick={onSend}>
            <Send size={13} />
            发送
          </Button>
        )}
      </div>
    </div>
  );
}

/** 一条抓取记录的卡片：抬头是那几个元数据小标签，下面是抓到的内容 */
function HarvestCard({ item }: { item: Partial<OfficeHarvestItem> & { columns?: string[]; rows?: string[][] } }) {
  const rows = item.items?.length
    ? item.items.map((it) => it.values?.filter(Boolean).join(' · ') || it.text)
    : (item.rows || []).map((r) => r.filter(Boolean).join(' · '));
  const ok = item.ok !== false;
  return (
    <div className="rounded-field border border-line bg-panel px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-2xs">
        <span className={cls('flex items-center gap-1 font-medium', ok ? 'text-ok' : 'text-crit')}>
          <Sparkles size={12} aria-hidden />
          {ok ? '抓取完成' : '抓取失败'}
        </span>
        {item.ts ? <span className="text-faint">{new Date(item.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}</span> : null}
        <span className="text-faint">
          模式 {item.mode || '—'}
          {item.selector ? ' · 选择器' : ' · 正文'}
        </span>
        {item.status ? <span className="text-faint">HTTP {item.status}</span> : null}
        <span className="num text-faint">
          {item.count ?? rows.length} / {item.total ?? rows.length} 条
        </span>
        {item.elapsed_ms != null ? <span className="num text-faint">{(item.elapsed_ms / 1000).toFixed(1)}s</span> : null}
      </p>
      {item.blocked ? <p className="mt-1 text-2xs text-warn">反爬提示：{item.blocked}</p> : null}
      {item.title ? <p className="mt-1.5 text-xs font-medium text-ink">{item.title}</p> : null}
      {item.error ? <p className="mt-1 text-2xs text-crit">{item.error}</p> : null}
      {rows.length ? (
        <ol className="mt-1.5 space-y-1">
          {rows.slice(0, 6).map((r, i) => (
            <li key={i} className="line-clamp-2 text-2xs leading-relaxed text-muted">
              <span className="num mr-1 text-faint">{i + 1}.</span>
              {r || '—'}
            </li>
          ))}
          {rows.length > 6 ? <li className="text-2xs text-faint">…另有 {rows.length - 6} 条</li> : null}
        </ol>
      ) : null}
      {item.field_names?.length ? (
        <p className="mt-1.5 text-2xs text-faint">字段：{item.field_names.join(' / ')}</p>
      ) : null}
    </div>
  );
}

const HARVEST_TIPS = [
  '帮我抓 quotes.toscrape.com 前 3 页的名言和作者',
  'https://quotes.toscrape.com/ 抓 .quote 字段 名言 作者',
];

/**
 * 拾贝的即时交互：回放真实抓取记录 + 下达新指令。
 *
 * 它的"对话"就是**一条条抓取**：左边是给它的指令（网址或一句话），
 * 右边是抓取结果卡。这与上游一致 —— 采集器没有闲聊能力，给它网址才有意义。
 *
 * 下指令会**真的去抓网页**（模型解析成计划 → 本机采集器执行），所以这里是
 * 一个明确的动作按钮，不是打字即发。
 */
function HarvestPane({ seat }: { seat: string }) {
  const [items, setItems] = useState<OfficeHarvestItem[] | null>(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ ask: string; result: OfficeHarvestRun }[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setErr('');
    api.office
      .harvestHistory(200)
      .then((d) => setItems(d.items))
      .catch((e) => setErr(e instanceof Error ? e.message : '读取失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live, items]);

  async function run() {
    const ask = text.trim();
    if (!ask || busy) return;
    setText('');
    setBusy(true);
    try {
      const result = await api.office.harvest(ask);
      setLive((cur) => [...cur, { ask, result }]);
      /* 新指令会落在服务端的记录里，抓完顺手对一次，历史那条就出现了 */
      load();
    } catch (e) {
      setLive((cur) => [...cur, { ask, result: { kind: 'reply', reply: `失败：${e instanceof Error ? e.message : '未知错误'}` } }]);
    } finally {
      setBusy(false);
    }
  }

  /* 按天分组：一天之内的记录连成一段，和上游的时间线一致 */
  const groups: { day: string; rows: OfficeHarvestItem[] }[] = [];
  for (const it of items || []) {
    const day = new Date(it.ts * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(it);
    else groups.push({ day, rows: [it] });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={bodyRef} className="min-h-[32vh] flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
        <p className="rounded-field bg-bg-2 px-3 py-2 text-2xs leading-relaxed text-muted">
          📜 历史抓取记录 {items?.length ?? 0} 条 · 存于本机服务端（最多保留最近 200 条）
          <br />
          以下是真实记录，新指令会接在末尾。
        </p>
        {err ? <PaneError text={err} onRetry={load} /> : null}
        {items === null && !err ? <Skeleton className="h-24" /> : null}

        {groups.map((g) => (
          <div key={g.day} className="space-y-2.5">
            <p className="text-center text-2xs text-faint">{g.day}</p>
            {g.rows.map((it, i) => (
              <div key={`${it.ts}-${i}`} className="space-y-1.5">
                <div className="flex justify-end">
                  <span className="max-w-[80%] break-all rounded-field bg-accent px-3 py-1.5 text-2xs text-white">
                    {it.url}
                  </span>
                </div>
                <HarvestCard item={it} />
              </div>
            ))}
          </div>
        ))}

        {live.map((l, i) => (
          <div key={`live-${i}`} className="space-y-1.5">
            <div className="flex justify-end">
              <span className="max-w-[80%] break-all rounded-field bg-accent px-3 py-1.5 text-2xs text-white">{l.ask}</span>
            </div>
            {l.result.kind === 'scrape' ? (
              <HarvestCard item={l.result.result} />
            ) : (
              <div className="flex flex-col items-start gap-1">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-field bg-bg-2 px-3 py-2 text-xs text-ink">
                  {l.result.reply}
                </div>
                {l.result.usage?.tokens ? <span className="text-2xs text-faint">解析用掉 {wan(l.result.usage.tokens)} token</span> : null}
              </div>
            )}
          </div>
        ))}

        {!items?.length && !live.length && !err ? (
          <p className="text-2xs text-faint">还没有抓过东西。给它一个网址，或点下面的例子。</p>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {HARVEST_TIPS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setText(t)}
              className="rounded-full border border-line px-2.5 py-1 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void run();
              }
            }}
            rows={2}
            placeholder="向 TA 下达指令，回车发送…"
            aria-label="给拾贝的抓取指令"
            className="min-h-[52px] w-full resize-none rounded-field border border-line bg-bg-2 px-3 py-2 text-xs text-ink outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/35"
          />
          <Button size="sm" className="shrink-0" disabled={!text.trim() || busy} onClick={() => void run()}>
            {busy ? <Spinner /> : <Send size={13} />}
            {busy ? '抓取中…' : '发送'}
          </Button>
        </div>
        <p className="mt-2 text-2xs text-faint">
          发送即真的去抓网页：先由模型把这句话解析成抓取计划，再交给本机采集器执行。纯抓取不消耗 token。
        </p>
      </div>
    </div>
  );
}

/* ── 员工详情弹窗 ───────────────────────────────────────────────────── */

export function SeatModal({
  employee,
  onClose,
  onOpenOffice,
}: {
  employee: OfficeEmployee | null;
  onClose: () => void;
  onOpenOffice: () => void;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.office.seat>> | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const [tab, setTab] = useState<OfficeSeatTabKey>('config');

  useEffect(() => {
    if (!employee) return;
    let alive = true;
    setDetail(null);
    setDetailErr('');
    setTab('config');
    api.office
      .seat(employee.id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setTab(d.tabs[0] ?? 'config');
      })
      .catch((e) => {
        if (alive) setDetailErr(e instanceof Error ? e.message : '读取工位详情失败');
      });
    return () => {
      alive = false;
    };
  }, [employee]);

  if (!employee) return null;
  const tabs = detail?.tabs ?? ['config'];
  const isChat = tab === 'chat';

  return (
    <ModalShell open onClose={onClose} label={`${employee.name} 的工位详情`} width="max-w-5xl">
      <SeatHead
        employee={employee}
        chips={detail?.chips ?? []}
        online={employee.online}
        onClose={onClose}
      />
      {detailErr ? (
        <div className="px-4 py-3">
          <PaneError text={detailErr} onRetry={() => setDetailErr(detailErr)} />
        </div>
      ) : null}
      {!detail && !detailErr ? (
        <div className="space-y-3 px-4 py-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : null}

      {detail ? (
        <>
          <TabBar tabs={tabs} value={tab} onChange={setTab} />
          {isChat ? (
            employee.id === 'shabei' ? (
              <HarvestPane seat={employee.id} />
            ) : (
              <AgentChatPane seat={employee.id} />
            )
          ) : (
            <div className="min-h-[46vh] flex-1 overflow-y-auto overscroll-contain px-4 py-4">
              {tab === 'config' ? <DocPane seat={employee.id} /> : null}
              {tab === 'skills' ? <SkillsPane seat={employee.id} /> : null}
              {tab === 'evo' ? <EvoPane seat={employee.id} /> : null}
              {tab === 'guard' ? <GuardPane seat={employee.id} /> : null}
              {tab === 'memory' ? <MemoryPane seat={employee.id} /> : null}
            </div>
          )}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
            <span className="mr-auto text-2xs text-faint">要改配置、看更细的日志，去完整办公室操作</span>
            <a href="#" onClick={(e) => { e.preventDefault(); onOpenOffice(); }} className={buttonClass('soft', 'sm')}>
              完整办公室
            </a>
          </div>
        </>
      ) : null}
    </ModalShell>
  );
}

/* ── 会话明细弹窗（只读） ──────────────────────────────────────────── */

/**
 * 一次会话的逐条明细。只读，没有输入框 —— 这些是已经发生过的记录
 * （定时任务、命令行、微信），往里插一句话没有意义；要说话去工位上找员工。
 */
export function SessionModal({ session, onClose }: { session: OfficeSession | null; onClose: () => void }) {
  const [msgs, setMsgs] = useState<OfficeMessage[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setMsgs(null);
    setError('');
    api.office
      .messages(session.id, 50)
      .then((res) => {
        if (alive) setMsgs(res.data.filter(spoken));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '读取失败');
      });
    return () => {
      alive = false;
    };
  }, [session]);

  return (
    <ModalShell open={Boolean(session)} onClose={onClose} label={session ? `对话明细：${session.title}` : '对话明细'}>
      {session ? (
        <>
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{session.title}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
                <Badge tone={session.source === 'cron' ? 'accent' : 'neutral'}>{session.source}</Badge>
                <span>{fmtDateTime(at(session.started_at))}</span>
                <span>{session.message_count} 条</span>
                <span className="num">{wan(session.input_tokens + session.output_tokens)} token</span>
                {session.model ? <span>{session.model}</span> : null}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </Button>
          </div>
          <div className="min-h-[38vh] flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-4 py-4">
            {error ? <PaneError text={error} onRetry={() => setError('')} /> : null}
            {!error && !msgs ? <Skeleton className="h-24" /> : null}
            {!error && msgs && !msgs.length ? (
              <p className="text-2xs text-faint">这次会话没有人说的话（可能只是工具调用）。</p>
            ) : null}
            {(msgs || []).map((m) => (
              <ChatBubble key={m.id} bubble={{ role: m.role === 'user' ? 'user' : 'assistant', text: m.content }} />
            ))}
          </div>
          <div className="shrink-0 border-t border-line px-4 py-2.5 text-2xs text-faint">
            {session.last_active ? `最近活动 ${fmtRelative(at(session.last_active))}` : ''}
            {session.end_reason ? ` · 结束原因 ${session.end_reason}` : ''}
          </div>
        </>
      ) : null}
    </ModalShell>
  );
}

/* 供页面复用的图标导出（免得页面再引一遍 lucide） */
export { RefreshCw };
