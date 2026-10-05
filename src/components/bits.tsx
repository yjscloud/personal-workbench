import type { ReactNode } from 'react';
import type { Priority, TicketStatus } from '@/lib/api';
import { cls, fmtBytes, ratioPercent } from '@/lib/format';
import { Badge, Led, Meter, TONE_COLOR, ToneBar, toneByRatio } from './ui';

export const PRIORITY_META: Record<Priority, { label: string; tone: 'crit' | 'warn' | 'signal' | 'neutral' }> = {
  P0: { label: 'P0', tone: 'crit' },
  P1: { label: 'P1', tone: 'warn' },
  P2: { label: 'P2', tone: 'signal' },
  P3: { label: 'P3', tone: 'neutral' },
};

export const STATUS_META: Record<TicketStatus, { label: string; tone: 'neutral' | 'signal' | 'warn' | 'ok' }> = {
  todo: { label: '待处理', tone: 'neutral' },
  doing: { label: '进行中', tone: 'signal' },
  review: { label: '待验证', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
};

/**
 * 图标块 / 指标域调色。
 *
 * 值全部来自设计 token，不再写死 hex —— 两个原因：
 * 1. 写死浅色渐变的后果是深色主题下变成"白底 + 浅色字"，直接不可读；
 *    混 var(--panel) 之后两套主题各自成立。
 * 2. 域色（cpu / mem / store / net / thermal）必须是固定 token，
 *    不能跟着「设置 → 强调色」走，否则用户换一次强调色，整页语义就串了。
 */
const domain = (tint: string) => ({
  tint,
  bg: `linear-gradient(135deg, color-mix(in srgb, ${tint} 26%, var(--panel)) 0%, color-mix(in srgb, ${tint} 9%, var(--panel)) 100%)`,
  fg: tint,
});

const DOMAIN_TILE: Record<string, { bg: string; fg: string; tint: string }> = {
  cpu: domain('var(--accent-azure)'),
  mem: domain('var(--accent-violet)'),
  store: domain('var(--accent-copper)'),
  net: domain('var(--accent-signal)'),
  thermal: domain('var(--warn)'),
  ok: domain('var(--ok)'),
  crit: domain('var(--crit)'),
};

/** 旧的色名保留（首页等地方还在用），值指向同一套 token。新代码请用域色名 */
export const TILE: Record<string, { bg: string; fg: string; tint: string }> = {
  ...DOMAIN_TILE,
  blue: DOMAIN_TILE.cpu,
  purple: DOMAIN_TILE.mem,
  orange: DOMAIN_TILE.store,
  cyan: DOMAIN_TILE.net,
  green: DOMAIN_TILE.ok,
  red: DOMAIN_TILE.crit,
};

/**
 * 卡片洗染：把域色按很低的比例混进当前主题的面板色。
 * 关键在于「混 --panel」而不是「混白色」（见上面的说明）。
 * 比例停在 14%：再高就成了"糖果色卡片"，一面墙看下来很吵。
 */
export function tileWash(tile?: string) {
  const t = TILE[tile ?? 'cpu'] ?? TILE.cpu;
  return {
    backgroundImage: `linear-gradient(135deg, color-mix(in srgb, ${t.tint} 14%, var(--panel)) 0%, var(--panel) 58%)`,
  };
}

export function TileIcon({
  tile = 'cpu',
  children,
  size = 38,
}: {
  tile?: string;
  children: ReactNode;
  size?: number;
}) {
  const t = TILE[tile] ?? TILE.cpu;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-field"
      style={{
        width: size,
        height: size,
        backgroundImage: t.bg,
        color: t.fg,
        // 一圈同色细边 + 上缘高光：方块才读得出是"元件"而不是一块色斑
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${t.tint} 24%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.3)`,
      }}
    >
      {children}
    </span>
  );
}

export function PriorityBadge({ priority, withLabel }: { priority: Priority; withLabel?: boolean }) {
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.P2;
  const label: Record<string, string> = { P0: '紧急', P1: '高', P2: '中', P3: '低' };
  return (
    <Badge tone={meta.tone}>
      <span className="num">{meta.label}</span>
      {withLabel ? <span className="text-faint">{label[meta.label]}</span> : null}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.todo;
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}

export function Tag({
  children,
  active,
  onClick,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      /* 选中态原来只靠颜色和描边表达，读屏用户完全不知道哪个筛选是开的。
         补上 aria-pressed —— 只给可点的那个加，span 上放这个属性没意义。 */
      aria-pressed={onClick ? Boolean(active) : undefined}
      className={cls(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-2xs transition-colors',
        active ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line bg-panel-2 text-muted',
        onClick && !active && 'hover:border-faint hover:text-ink',
        className,
      )}
    >
      {children}
    </Comp>
  );
}

export function Ring({
  value,
  total,
  size = 132,
  thickness = 11,
  tone = 'accent',
}: {
  value: number;
  total: number;
  size?: number;
  thickness?: number;
  tone?: string;
}) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const color = TONE_COLOR[tone] ?? TONE_COLOR.accent;

  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - ratio)}
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
      </svg>
      <p className="num absolute text-[26px] font-semibold leading-none">
        {value}
        <span className="text-sm font-normal text-muted">/{total}</span>
      </p>
    </div>
  );
}

/**
 * 环形读数。仪表盘感的来源：径向进度天生比横条更像"仪器"，
 * 而且几个环并排时，形状差异（快满 / 半满 / 空）比几根长度不同的横条好认得多。
 *
 * 环色默认取**指标域色**（身份：这是哪一项），只在该项越界时切到 warn / crit
 * （状态：该不该管）。两套颜色语言在这一处合流——平时认得出是谁，
 * 出事时一眼看出是哪一项，而不需要读数字。
 */
export function RingStat({
  label,
  ratio,
  valueText,
  hint,
  tone = 'cpu',
  warn = 0.75,
  crit = 0.9,
  icon,
  size = 92,
  className,
}: {
  label: string;
  /** 0–1 */
  ratio: number;
  /** 环心里那行短读数（"62%" 这种；长的绝对值放进 hint） */
  valueText: ReactNode;
  hint?: ReactNode;
  /** 指标域色 */
  tone?: string;
  warn?: number;
  crit?: number;
  icon?: ReactNode;
  size?: number;
  className?: string;
}) {
  const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const state = safe >= crit ? 'crit' : safe >= warn ? 'warn' : tone;
  const color = TONE_COLOR[state] ?? TONE_COLOR.accent;
  const domainColor = TONE_COLOR[tone] ?? TONE_COLOR.accent;
  /* 8px 的环在 92px 的圈里显得笨重，像四块甜甜圈；收到 6px 之后
     弧线细下来，环心里的读数才是主角。阈值一到，颜色照旧翻成琥珀 / 红。 */
  const thickness = 6;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;

  return (
    <div className={cls('relative flex items-center gap-4 overflow-hidden rounded-xl2 bg-panel p-4 shadow-soft', className)}>
      {/* 同域极淡洗染：卡片之间因此有色彩过渡，而不是一摞一模一样的白纸。
          9%：再多就变成"四块不同的底色在互相较劲"，再少则四张白卡糊成一片。
          这一档刚好让卡片有一层认得出的蓝晕，又不至于压过环里的读数 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(125% 105% at 0% 0%, color-mix(in srgb, ${domainColor} 9%, transparent) 0%, transparent 60%)`,
        }}
      />
      <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={thickness} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - safe)}
            style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1), stroke 200ms linear' }}
          />
        </svg>
        <span className="num absolute text-[15px] font-semibold leading-none tracking-display">{valueText}</span>
      </div>
      <div className="relative min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-2xs text-muted">
          {icon ? (
            <span className="shrink-0" style={{ color: domainColor }}>
              {icon}
            </span>
          ) : null}
          <span className="truncate">{label}</span>
        </p>
        {hint ? (
          /* 和 Stat 一样预留两行高度：并排的几个环，下面的说明才能对齐 */
          <p className="mt-1.5 min-h-[2.75em] text-2xs leading-snug text-faint">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 数值配色：只有 warn / crit 上色，正常读数一律墨色。
 * 颜色要用来报警，不是用来装饰——满屏彩色的数字等于没有重点。
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  icon,
  tile = 'blue',
  variant = 'card',
  progress,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'crit' | 'signal' | 'accent';
  /** 左侧彩色图标块里的图标；不传则回落成左侧语义色条 */
  icon?: ReactNode;
  tile?: string;
  /**
   * card：独立指标卡（自带圆角 + 投影 + 同色洗染）
   * cell：一张卡里的格子（圆角/投影/底色都由外层容器提供，只留内容 + 洗染）
   * flat：软填充块
   */
  variant?: 'card' | 'cell' | 'flat';
  /** 0–1：卡片底部一条细进度条 */
  progress?: number;
  className?: string;
}) {
  const toneText: Record<string, string> = {
    neutral: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
    crit: 'text-crit',
    signal: 'text-signal',
    accent: 'text-accent',
  };
  // 独立指标卡铺一层与图标同色的极淡渐变，卡片之间就有了色彩过渡
  const sheen = variant !== 'flat' && icon ? tileWash(tile) : undefined;
  return (
    <div
      style={sheen}
      className={cls(
        'relative flex flex-col overflow-hidden p-4',
        variant === 'cell' ? '' : variant === 'card' ? 'rounded-xl2 bg-panel shadow-soft' : 'rounded-xl2 bg-bg-2',
        className,
      )}
    >
      <div className="flex items-start gap-3.5">
        {icon ? <TileIcon tile={tile}>{icon}</TileIcon> : <ToneBar tone={tone} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs text-muted">{label}</p>
          <p className={cls('num mt-1.5 truncate text-[22px] font-semibold leading-none tracking-display', toneText[tone])}>
            {value}
            {unit ? <span className="ml-1 text-xs font-normal text-muted">{unit}</span> : null}
          </p>
          {hint ? (
          /* 说明允许折两行；用 min-h 预留两行高度，四张卡的进度条才能对齐 */
          <p className="mt-1.5 min-h-[2.75em] text-2xs leading-snug text-faint">{hint}</p>
        ) : null}
        </div>
      </div>
      {typeof progress === 'number' ? (
        /* 压在卡片底边上会被圆角切掉，所以走内联的圆角细条 */
        <span aria-hidden className="mt-3.5 block h-1 w-full overflow-hidden rounded-full bg-bg-3">
          <span
            className="block h-full rounded-full transition-[width] duration-500 ease-out"
            style={{
              width: `${Math.min(100, Math.max(0, progress * 100))}%`,
              backgroundImage: `linear-gradient(90deg, ${(TONE_COLOR[tone] ?? TONE_COLOR.accent)}, color-mix(in srgb, ${TONE_COLOR[tone] ?? TONE_COLOR.accent} 72%, #0a1a3c))`,
            }}
          />
        </span>
      ) : null}
    </div>
  );
}

export function RatioStat({
  label,
  used,
  total,
  warn = 0.75,
  crit = 0.9,
  hint,
  valueText,
  icon,
  tile = 'blue',
  variant = 'card',
  className,
}: {
  label: string;
  used: number;
  total: number;
  warn?: number;
  crit?: number;
  hint?: ReactNode;
  /** 覆盖主数值（用于 CPU 这类"比率不是字节"的指标） */
  valueText?: ReactNode;
  icon?: ReactNode;
  tile?: string;
  variant?: 'card' | 'flat';
  className?: string;
}) {
  const ratio = total > 0 ? used / total : 0;
  const tone = toneByRatio(ratio, warn, crit);
  const sheen = variant === 'card' && icon ? tileWash(tile) : undefined;
  return (
    <div
      style={sheen}
      className={cls(
        'relative overflow-hidden rounded-xl2 p-4',
        variant === 'card' ? 'bg-panel shadow-soft' : 'bg-bg-2',
        className,
      )}
    >
      <div className="flex items-start gap-3.5">
        {icon ? <TileIcon tile={tile}>{icon}</TileIcon> : <ToneBar tone={tone} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-2xs text-muted">{label}</p>
            <p className="num shrink-0 text-2xs text-faint">{ratioPercent(used, total)}</p>
          </div>
          <p className="num mt-1.5 truncate text-[22px] font-semibold leading-none tracking-display">
            {valueText ?? fmtBytes(used)}
          </p>
        </div>
      </div>
      <Meter ratio={ratio} tone={tone} className="mt-3" />
      <p className="mt-2 truncate text-2xs leading-relaxed text-faint">{hint ?? `共 ${fmtBytes(total)}`}</p>
    </div>
  );
}

export function ToneLed({ tone, label }: { tone: 'ok' | 'warn' | 'crit' | 'signal' | 'neutral'; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-muted">
      <Led tone={tone} />
      {label}
    </span>
  );
}
