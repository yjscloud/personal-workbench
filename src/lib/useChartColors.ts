import { useEffect, useState } from 'react';

export type ChartColors = {
  /** 全站强调色（会跟着「设置 → 强调色」变）。UI 元素用，指标请用域色 */
  accent: string;
  signal: string;
  ok: string;
  warn: string;
  crit: string;
  line: string;
  muted: string;
  faint: string;
  panel: string;
  panel2: string;
  /** 指标域色：与卡片、环形读数同一套（见 components/ui.tsx 的 TONE_COLOR） */
  cpu: string;
  mem: string;
  store: string;
  net: string;
  thermal: string;
  /** 双通道量（IO 读 / 写、网络收 / 发）的第二档：同色相、更亮一档 */
  ioWrite: string;
  netTx: string;
  /** 单系列实心柱（每日用电这类）：走冷色主档。
      柱体铺满一整排，面积远大于一条曲线 —— 用琥珀来填等于让人
      一直在看一片"警告色"，真正的告警反而被这片黄盖住了。 */
  bar: string;
  /** 阈值线：上/下两条（80% / 92% 这类） */
  line2: string;
};

/** #rgb / #rrggbb → [r,g,b]；认不出来返回 null */
function parseHex(input: string): [number, number, number] | null {
  const v = input.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return null;
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * 往白色方向提亮一档。
 * 双通道量（读/写、收/发）不用两个域色 —— 那会让"同一件事的两个方向"
 * 看起来像两件不同的事。色相一致 + 明度分开，才是仪表面板的读法。
 * 解析不出来就原样返回，宁可两条线同色，也不要抛错。
 */
function lighter(hex: string, t: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  return toHex(rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t);
}

function read(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  /* 域色取腾讯云那支蓝的三个明度档（见 index.css 的 --tone-cool-*）。
     不按色相分域：CPU / 内存 / 存储 / 网络 是同族不同明度，
     曲线摆在一起像一套仪表，而不是四支互不相干的荧光笔。
     网络与存储共用第二档 —— 两者从不出现在同一张图里。 */
  const cpu = g('--tone-cool-1', '#0052d9');
  const mem = g('--tone-cool-3', '#5f97f2');
  const store = g('--tone-cool-2', '#2e73ee');
  const net = store;

  return {
    accent: g('--accent', '#2563eb'),
    signal: g('--accent-2', '#007d79'),
    ok: g('--ok', '#198038'),
    warn: g('--warn', '#a15c00'),
    crit: g('--crit', '#da1e28'),
    line: g('--line', '#e7eef8'),
    muted: g('--muted', '#4e5969'),
    faint: g('--faint', '#5d6673'),
    panel: g('--panel', '#ffffff'),
    panel2: g('--panel-2', '#f5f8fd'),
    cpu,
    mem,
    store,
    net,
    thermal: g('--warn', '#a15c00'),
    /* 第二通道：读写 / 收发各自同色相提亮一档。暗色主题下也是"更亮"，同样成立。
       提亮幅度从 0.5 收到 0.34：域色整体变浅之后，再提亮一半会让
       "写 / 发"那条几乎化进白底，读不出它也是条曲线。 */
    ioWrite: lighter(store, 0.34),
    netTx: lighter(net, 0.3),
    bar: mem,
    line2: g('--line-2', '#eff4fb'),
  };
}

/** 图表需要真实色值（SVG 不接受 var()），随主题切换自动更新 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() => read());

  useEffect(() => {
    const update = () => setColors(read());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}

/** 示波器式的网格：横向虚线、极淡。不要太密太实，读数才是主角 */
export const GRID_DASH = '2 6';

/** Recharts 的坐标轴时间戳（秒）→ 本地时间标签 */
export function timeLabel(seconds: number, timeframe: string): string {
  const d = new Date(seconds * 1000);
  if (timeframe === 'hour' || timeframe === 'day') {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
