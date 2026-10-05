/**
 * 磁贴配色：能拿到站点自己的品牌色就跟它走，拿不到退回糖纸色板。
 *
 * 两级的用意不一样：
 * · 品牌色给出「这是哪家服务」的识别度 —— Proxmox 是橙的、Grafana 是橙红的，
 *   一眼扫过去靠颜色就能定位，不用读字；
 * · 色板负责兜底和"填空" —— 自建面板、纯灰 logo（GitHub / Notion）、
 *   还没探测过的入口，都归到那七色里，保证整面墙永远是彩的。
 *
 * 关键取舍：**只取品牌色的色相和饱和度，明度交给主题决定**。
 * 直接把品牌色刷上去会得到一面浓艳的墙，还会把正文对比度拖到不该有的水平；
 * 固定明度（浅色 92/81、深色 25/15）之后，卡片仍然是参考图那种"糖纸"，
 * 只是每张纸的色相换成了它那家网站的。
 */

/** 糖纸色板。色值写在 index.css 的 .tb-tint-*（深色主题另配一套），这里只负责挑。 */
const PALETTE = ['mint', 'sky', 'butter', 'peach', 'lilac', 'rose', 'ice'] as const;
export type Tint = (typeof PALETTE)[number];

/** 按 id 稳定散列挑一组颜色：同一个入口无论怎么搜索 / 过滤都保持同一张脸色。
    若按数组下标轮着来，一搜索整面墙就重新洗牌，反而更难认。 */
export function paletteTint(seed: string): Tint {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** '#abc' / '#aabbcc' → [r,g,b]；认不出来返回 null */
function parseHex(input?: string): [number, number, number] | null {
  const v = (input || '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return null;
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 卡片用的品牌色相 / 饱和度（百分比）。明度不在这里，由 CSS 按主题给。 */
export type BrandTint = { h: number; s: number };

/**
 * 品牌色 → 卡片色度。返回 null 表示"这个颜色不适合当卡片底色"，
 * 调用方应退回色板。
 *
 * 判据只有"饱和度"和"是不是接近纯黑"：**明度不参与判断**。
 * 因为卡片自己的明度是固定的，品牌色只贡献色相；
 * 有些站点声明的 theme-color 本身就接近白（例如 #EEF4FB），
 * 它的色相照样是可用的"蓝"，直接丢掉反而亏。真正要挡的是两类：
 * · 灰（GitHub #8B949E、Notion 那种黑白标志）：刷上去是一张脏灰卡片，
 *   在整面彩色墙里看着像"这张坏了"；
 * · 纯黑 / 接近纯黑：色相是噪声，且本来就没有识别度。
 */
export function brandTint(input?: string): BrandTint | null {
  const rgb = parseHex(input);
  if (!rgb) return null;

  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (l > 0.5 ? 2 - max - min : max + min);

  if (s < 0.15 || l < 0.08) return null;

  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return {
    h: Math.round(h * 360),
    // 饱和度也要收：品牌色多半是 100% 的浓色，直接铺满会抢戏，
    // 压到 30~62% 才和参考图里那层柔彩对得上 （PS: 灰调的会落到下限）
    s: Math.round(clamp(s * 100, 30, 62)),
  };
}

/* ── 自动生成的图标 ──────────────────────────────────────────────────
   抓不到 favicon 时（内网面板没有图标、聚合服务也连不上）不能只留个
   灰字母 —— 一面墙上几十个同款灰字母，扫读时等于没有信息。
   所以这里生成一个"像那么回事"的应用图标：**品牌色（或糖纸色板）的
   渐变方块 + 首字母**。规则和 Slack / Notion 那类自动头像一样，
   颜色取自工具自己，于是同一个入口在哪儿出现都是同一个色。 */

/** 糖纸色板对应的色相。没有品牌色的工具，图标要和卡片同色相 ——
    否则同一张卡上卡片是薄荷绿、图标是蓝的，看着像两个东西。 */
const PALETTE_HUE: Record<Tint, number> = {
  mint: 150,
  sky: 207,
  butter: 48,
  peach: 30,
  lilac: 256,
  rose: 340,
  ice: 206,
};

/** 生成图标的色相：有品牌色就用它，否则跟随这张卡拿到的糖纸色 */
export function avatarHue(seed: { id?: string; name?: string; url?: string; color?: string }): number {
  const brand = brandTint(seed.color);
  if (brand) return brand.h;
  return PALETTE_HUE[paletteTint(seed.id || seed.name || seed.url || '')];
}

/**
 * 生成图标上的字。不求花哨，只求一眼能认出是谁：
 * · 中文取头一个字 —— 两个字挤在 28px 的方块里反而糊；
 * · 开头就是两个以上大写字母的（IT-Tools、IP 速查）直接用那两个；
 * · 多词的取前两个词的首字母（Nginx Proxy → NP）；
 * · 单词的只取一个字母，这是自动头像的通行做法。
 */
export function monogram(name?: string): string {
  const clean = String(name || '')
    .trim()
    .replace(/[·•·_/|\\–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '?';
  if (/[\u2e80-\u9fff\uac00-\ud7ff\uf900-\ufaff]/.test(clean[0])) return clean[0];

  const words = clean.split(' ').filter(Boolean);
  const lead = /^[A-Z]{2,}/.exec(words[0]);
  if (lead) return lead[0].slice(0, 2);
  if (words.length >= 2 && /^[A-Za-z0-9]/.test(words[1])) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0][0].toUpperCase();
}

/**
 * 生成图标的渐变底色。
 * 黄绿一段（橙黄 / 黄 / 黄绿）本身就显亮，白字压不住，单独压深一档 ——
 * 否则那两个色的图标会白成一片，字母看不清。
 */
export function avatarGradient(hue: number): { backgroundImage: string; boxShadow: string } {
  const bright = hue >= 35 && hue <= 100;
  const [top, bottom] = bright ? [44, 33] : [53, 41];
  return {
    backgroundImage:
      `radial-gradient(120% 120% at 18% 6%, rgb(255 255 255 / 0.24), rgb(255 255 255 / 0) 62%),` +
      `linear-gradient(140deg, hsl(${hue} 58% ${top}%), hsl(${hue} 52% ${bottom}%))`,
    // 上缘一道内高光：没有它，纯色块读起来是"占位符"而不是"图标"
    boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.3), inset 0 -1px 0 rgb(0 0 0 / 0.12)',
  };
}
