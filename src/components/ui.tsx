import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cls } from '@/lib/format';

/* ── 卡片 ─────────────────────────────────────────────────────────── */
export function Card({
  className,
  children,
  flush,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  flush?: boolean;
}) {
  return (
    /* 窄屏用 16px 内边距：375px 的屏幕上，20px 左右内边距 + 页面本身的
       px-3 一共要吃掉 64px，正文只剩 310px 出头 —— 表格、读数和按钮
       都会挤到换行。桌面端维持 24px。 */
    <div className={cls('panel', flush ? '' : 'p-4 sm:p-6', className)} {...rest}>
      {children}
    </div>
  );
}

/** 面板头：标题 + 说明 + 右侧动作，下面压一条发丝线把头和身分开 */
export function CardHead({
  title,
  hint,
  right,
  className,
  level = 3,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  /**
   * 标题层级。默认 h3 —— 常规用法是「Section(h2) 里的卡片」。
   * 整页直接铺卡片、中间没有 Section 的页面（设置页）要传 2：
   * 否则文档大纲会从 h1 直接跳到 h3，读屏按标题跳读时会整级漏掉。
   */
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cls('mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        {/* 这里不加 text-wrap: balance：truncate 意味着它根本不会折行，
            balance 只对多行文本有效，加了是摆设 */}
        <Heading className="truncate text-sm font-semibold">{title}</Heading>
        {/* 与 Field 的说明文字同一个 8px（见下面 Field 处的说明）：
            卡片标题下面那句通常是完整的一句话，4px 撑不开它与标题的距离 */}
        {hint ? <p className="mt-2 text-2xs leading-relaxed text-muted">{hint}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

/* ── 页面骨架 ─────────────────────────────────────────────────────── */
/* 全站只有这两种块级容器：PageHead（每页第一行）和 Section（内容区块）。
   页面不再自己造横幅、工具条、控制台卡。 */

/** 页面第一行：页面名 + 一句话说明 + 页面级动作 */
export function PageHead({
  title,
  hint,
  actions,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cls('mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4', className)}>
      <div className="min-w-0">
        {/* text-balance：页面名折行时把两行拉成等长，避免末行只剩一两个字
            （中文标题尤其常见）。只加在**会折行**的标题上 ——
            下面的 CardHead 那条带 truncate，本来就不折行，加了没有意义 */}
        <h1 className="text-balance text-2xl font-semibold tracking-display">{title}</h1>
        {hint ? <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 内容区块：统一的标题行 + 下方内容。区块间距固定 32px。
 *  这里以前有个 `domain` 参数，在标题左侧画一道域色竖导轨。
 *  域色收敛成同一支冷色之后，那道线对每一块都是同一个颜色、不再说明任何事，
 *  就撤掉了 —— 区块之间靠留白和标题层级分开，比多画一道线安静。 */
export function Section({
  title,
  hint,
  actions,
  children,
  className,
  id,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cls('mb-8 last:mb-0', className)}>
      {title ? (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 className="text-balance text-base font-semibold">{title}</h2>
            {/* 同上：说明文字统一 8px */}
            {hint ? <p className="mt-2 text-2xs leading-relaxed text-muted">{hint}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/* ── 按钮 ─────────────────────────────────────────────────────────── */
type BtnVariant = 'primary' | 'soft' | 'ghost' | 'danger';
type BtnSize = 'sm' | 'md' | 'icon';
const BTN_VARIANT: Record<BtnVariant, string> = {
  // Carbon 式：主按钮是实色蓝，方角，没有渐变和辉光
  primary: 'btn-primary border',
  soft: 'bg-bg-2 text-ink hover:bg-bg-3',
  ghost: 'border border-transparent bg-transparent text-muted hover:bg-bg-2 hover:text-ink',
  danger: 'bg-transparent text-crit hover:bg-crit-soft',
};

const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-2xs',
  md: 'h-10 gap-2 px-4 text-sm',
  icon: 'h-9 w-9 justify-center',
};

const BTN_BASE =
  'inline-flex select-none items-center justify-center rounded-field font-medium transition-[background,color,border-color,filter,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-45';

/**
 * 按钮的类名。
 *
 * 抽出来是为了页面上那些"长得像按钮、但不是 button"的东西 —— 下载链接用的
 * 是 `<a>`（它得走浏览器下载，不能用 button）。这类元素必须与真按钮**逐字
 * 一致**：之前它自己写了一串 `h-9 px-3.5`，而 Button 是 `h-10 px-4` ——
 * 差 4px 高、左右各 2px，并排摆在同一行时那种"挤在一起"不是错觉，
 * 是真的没对齐。现在两边共用同一份类，谁也走不偏。
 */
export function buttonClass(variant: BtnVariant = 'soft', size: BtnSize = 'md', className?: string) {
  return cls(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className);
}

export function Button({
  variant = 'soft',
  size = 'md',
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize }) {
  return (
    <button type="button" className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

/* ── 标签 / 状态点 ────────────────────────────────────────────────── */
export function Badge({
  children,
  tone = 'neutral',
  className,
  dot,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'crit' | 'signal' | 'accent';
  className?: string;
  dot?: boolean;
}) {
  const toneClass: Record<string, string> = {
    neutral: 'text-muted bg-bg-3',
    ok: 'text-ok bg-ok-soft',
    warn: 'text-warn bg-warn-soft',
    crit: 'text-crit bg-crit-soft',
    signal: 'text-signal bg-signal-soft',
    accent: 'text-accent bg-accent-soft',
  };
  return (
    <span
      className={cls(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium',
        toneClass[tone],
        className,
      )}
    >
      {dot ? <Led tone={tone} /> : null}
      {children}
    </span>
  );
}

export function Led({ tone = 'neutral', pulse }: { tone?: string; pulse?: boolean }) {
  const color: Record<string, string> = {
    neutral: 'var(--faint)',
    ok: 'var(--ok)',
    warn: 'var(--warn)',
    crit: 'var(--crit)',
    signal: 'var(--accent-2)',
    accent: 'var(--accent)',
  };
  return (
    <span
      aria-hidden
      className={cls('inline-block h-1.5 w-1.5 shrink-0 rounded-full', pulse && 'animate-pulse-dot')}
      style={{ background: color[tone] ?? color.neutral, boxShadow: `0 0 0 2px color-mix(in srgb, ${color[tone] ?? color.neutral} 22%, transparent)` }}
    />
  );
}

/* ── 表单 ─────────────────────────────────────────────────────────── */
export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cls('field text-sm', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cls('field resize-y text-sm leading-relaxed', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cls('field cursor-pointer text-sm', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cls('block', className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {/* 说明文字离控件 8px（mt-2），不是原来的 4px。
          4px 在 12px 的字号下读起来像"还贴在输入框的下沿"，而不是一句说明 ——
          尤其输入框本身有边框，两者之间几乎没有空气。
          这个 8px 与设置页里"控件下面的说明文字"是同一个值
          （见 Settings.tsx 备份卡那段注释），全站说明文字统一用它。 */}
      {hint ? <span className="mt-2 block text-2xs leading-relaxed text-faint">{hint}</span> : null}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cls(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200 disabled:opacity-50',
        checked ? 'border-transparent bg-accent' : 'border-line bg-panel-2',
      )}
    >
      <span
        className={cls(
          'block h-4 w-4 rounded-full transition-transform duration-200',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
        style={{ background: checked ? 'var(--on-accent)' : 'var(--faint)' }}
      />
    </button>
  );
}

/* ── 弹层 ─────────────────────────────────────────────────────────── */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
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

  /* overscroll-contain：弹窗滚到底时不要再把滚动接力给背后的页面。
     没有它，在弹窗里多滑一下，背景整页跟着动，松手后视野就错位了 */
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain p-4 sm:items-center">
      <div className="scrim fixed inset-0" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        /* 窄屏用 p-4：手机上 24px 的内边距会吃掉一成的可用宽度，
           留给正文的只剩 300px 出头。桌面端维持 p-6。 */
        className={cls('panel relative z-10 my-6 w-full animate-fade-rise p-4 shadow-pop outline-none sm:my-8 sm:p-6', width)}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="text-balance text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </Button>
        </div>
        <div className="space-y-3.5">{children}</div>
        {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ── 空态 / 加载 ──────────────────────────────────────────────────── */
export function Empty({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 border border-dashed border-line px-4 py-10 text-center sm:px-6 sm:py-12">
      {/* 图标是装饰：含义已经由下面的 title 说了，读屏不该把它当内容念出来。
          lucide 默认**不**注入 aria-hidden（见 lucide-react 的 defaultAttributes），
          所以这里必须显式关掉，否则所有用到 Empty 的页面都会多念一个无名图形 */}
      {icon ? (
        <div aria-hidden className="text-faint">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="max-w-sm text-[13px] leading-relaxed text-muted">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cls('inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent', className)}
      aria-hidden
    />
  );
}

/* ── 骨架屏 ──────────────────────────────────────────────────────────
   这两类等待要分开：
   · **整页 / 整块首次加载** → 骨架屏。数据还没到，但布局已经知道长什么样，
     先把形状摆出来，高度就不会在数据到达时跳一下，也不会有"先白一下"。
   · **某个按钮点下去之后的等待** → 仍然用 Spinner。那是"我这一个动作在做"，
     不是"这一页还没搭起来"，骨架屏在这里没有形状可摆。
   下面三个是拼骨架用的零件：块、行、卡。形状全由调用方给，
   因为这个项目每一页的布局都不一样，写死一套"通用骨架"只会到处不对劲。 */

/** 一块会呼吸的占位面，默认就是白卡面（.panel）。
    之所以默认给白底：这个项目的画布是浅蓝，而 --line / --bg-3 压在画布上
    几乎同色，只有白面能从底色里立起来 —— 骨架块事实上都得是白的。
    尺寸和圆角由 className 给，要换底色自己覆盖 bg-* 。 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cls('panel animate-pulse', className)} />;
}

/** 文字占位：几条长短不一的灰线，末行短一截 ——
    等长的几根棍看起来像表格，短一截才像一段话。 */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  const widths = [100, 94, 88, 96];
  return (
    <div aria-hidden className={cls('space-y-2.5', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded-sm bg-line"
          /* 只有"多行"才把末行收短：单行时收短会读成"一小截"，不像一行内容 */
          style={{ width: lines > 1 && i === lines - 1 ? '58%' : `${widths[i % widths.length]}%` }}
        />
      ))}
    </div>
  );
}

/** 卡片骨架：白卡面 + 一行标题线 + 几条文字线，最常用的一档。
    卡面本身**不**呼吸，只有里面的线在呼吸 —— 于是读起来是"卡在了、内容在路上"，
    而不是"整块白面在闪"。 */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cls('panel p-4 sm:p-6', className)}>
      <Skeleton className="mb-4 h-3.5 w-1/4 rounded-sm bg-line" />
      <SkeletonLines lines={lines} />
    </div>
  );
}

/* ── 数值 / 计量 ──────────────────────────────────────────────────── */
export function useCountUp(value: number, duration = 600): number {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number>();

  useEffect(() => {
    if (!Number.isFinite(value)) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(from + (value - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = value;
    };
  }, [value, duration]);

  return display;
}

export function Meter({
  ratio,
  tone = 'accent',
  className,
  height = 4,
}: {
  ratio: number;
  /** 语义色或指标域色，统一走 TONE_COLOR */
  tone?: string;
  className?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;
  const color = TONE_COLOR[tone] ?? TONE_COLOR.accent;
  return (
    <div className={cls('w-full overflow-hidden rounded-full bg-panel-2', className)} style={{ height }}>
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{
          width: `${pct}%`,
          backgroundImage: `linear-gradient(90deg, ${color} 0%, color-mix(in srgb, ${color} 78%, #0a1a3c) 100%)`,
        }}
      />
    </div>
  );
}

/** 按阈值给出语义色调 */
export function toneByRatio(ratio: number, warn = 0.75, crit = 0.9): 'ok' | 'warn' | 'crit' {
  if (!Number.isFinite(ratio)) return 'ok';
  if (ratio >= crit) return 'crit';
  if (ratio >= warn) return 'warn';
  return 'ok';
}

/**
 * 色调 → 真实色值（内联样式 / SVG 用，Tailwind 类不适用的地方都在这里取色）。
 *
 * 两类色并排放在一起，各有各的职责：
 * · ok / warn / crit —— **状态**：只在越界时出现，颜色用来报警，不是装饰；
 * · cpu / mem / store / net / thermal —— **指标域**：贯穿图标块、环形读数、
 *   曲线、进度条，让"哪一项"一眼可辨。
 *
 * 域色**不按色相分**，而是同一支冷色相的四个明度档（--tone-cool-1..4）：
 * 这些读数是同一台机器的几个侧面，用四五种色相区分只会让卡片各喊各的，
 * 一页看下来是"花"而不是"清楚"。是哪一项由标签和位置说；
 * 颜色留给真正要报警的地方。thermal 仍然留给琥珀 —— 热、功耗、阈值
 * 本来就是同一件事，那支暖色在这里是有话可说的，不是装饰。
 *
 * 也刻意不复用 --accent-azure 那一组：那是「设置 → 强调色」的候选，
 * 用户换一次强调色，整页的域色就跟着串位。--accent 同样只留给
 * 全站级的按钮与选中态。
 */
export const TONE_COLOR: Record<string, string> = {
  neutral: 'var(--faint)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
  signal: 'var(--accent-2)',
  accent: 'var(--accent)',
  cpu: 'var(--tone-cool-1)',
  mem: 'var(--tone-cool-3)',
  store: 'var(--tone-cool-2)',
  // 网络与存储共用第二档：两者从不出现在同一张图里
  net: 'var(--tone-cool-2)',
  thermal: 'var(--warn)',
};

/** 数据块左侧的语义色条：全站统一的"仪表"语言 */
export function ToneBar({ tone = 'neutral', width = 3 }: { tone?: string; width?: number }) {
  return (
    <span
      aria-hidden
      className="absolute inset-y-0 left-0"
      style={{ width, background: TONE_COLOR[tone] ?? TONE_COLOR.neutral }}
    />
  );
}

/** 带扩散波纹的实时指示点：只做状态传达，不含文字，读屏器依赖相邻文案。
 *  `color` 用来在深色焦点面上指定一档亮色 —— 那上面的 --ok / --warn
 *  是给浅色面配的，压上去读不出来。 */
export function LiveDot({
  tone = 'ok',
  ping = true,
  className,
  color: explicit,
}: {
  tone?: string;
  ping?: boolean;
  className?: string;
  color?: string;
}) {
  const color = explicit ?? TONE_COLOR[tone] ?? TONE_COLOR.neutral;
  return (
    <span aria-hidden className={cls('relative inline-flex h-1.5 w-1.5 shrink-0', className)}>
      {ping ? <span className="absolute inset-0 rounded-full animate-live-ping" style={{ background: color }} /> : null}
      <span className="relative inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

/* ── 分段控制 ─────────────────────────────────────────────────────── */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cls(
        'scrollbar-none inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-field bg-bg-2 p-1',
        className,
      )}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cls(
              'shrink-0 whitespace-nowrap rounded-field font-medium transition-[background,color,box-shadow] duration-150',
              size === 'sm' ? 'px-2.5 py-1 text-2xs' : 'px-3.5 py-1.5 text-[13px]',
              active ? 'bg-panel text-accent shadow-soft' : 'text-muted hover:text-ink',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
