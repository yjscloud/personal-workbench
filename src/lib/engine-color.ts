import { hostOf } from './format';
import { fallbackHue } from './tint';

/**
 * 搜索引擎的品牌色相。
 *
 * 首页那排引擎标签想「一眼认出哪家是哪家」，这和工具箱磁贴是同一个问题，
 * 但解法不同：磁贴可以**去问站点**要品牌色（services/sitecolor.js），
 * 而引擎的地址是查询模板，探测它只会带回来一张搜索结果页 —— 信号不可靠。
 * 所以这里走一张**内置域名对照表**，没有的退回糖纸色板散列。
 *
 * 关键取舍同 lib/tint.ts：**只给色相和饱和度，明度交给主题**。
 * 组件里所有颜色都写成 hsl(var(--se-h) var(--se-s) L%)，
 * 浅色 / 深色各自取一档明度，换主题不用 JS 重新算。
 */

/** 饱和度统一收在这个区间：太灰认不出是哪家，太浓在小字上会刺眼 */
const SAT_MIN = 18;
const SAT_MAX = 85;

/** 常见搜索引擎的品牌色。色相/饱和度取自各家 logo 的主色。
    `letters` 只有"本身就是多彩"的品牌才有（Google 四个字母四个色）——
    那种光给一个色相是不够的，得逐字上色才认得出是它。 */
const KNOWN: { host: string; h: number; s: number; letters?: string[] }[] = [
  { host: 'baidu.com', h: 228, s: 76 },
  { host: 'google.com', h: 217, s: 89, letters: ['#4285F4', '#EA4335', '#FBBC05', '#4285F4', '#34A853', '#EA4335'] },
  { host: 'duckduckgo.com', h: 14, s: 71 },
  { host: 'bing.com', h: 205, s: 85 },
  { host: 'yandex.com', h: 0, s: 85 },
  { host: 'sogou.com', h: 24, s: 85 },
  { host: 'so.com', h: 140, s: 60 },
  { host: 'github.com', h: 212, s: 18 },
  { host: 'gitlab.com', h: 21, s: 85 },
  { host: 'stackoverflow.com', h: 29, s: 85 },
  { host: 'npmjs.com', h: 0, s: 55 },
  { host: 'docker.com', h: 210, s: 84 },
  { host: 'zhihu.com', h: 210, s: 85 },
  { host: 'bilibili.com', h: 340, s: 85 },
  { host: 'juejin.cn', h: 1, s: 70 },
  { host: 'kagi.com', h: 39, s: 90 },
  { host: 'searx', h: 158, s: 60 },
];

export type EngineTint = { h: number; s: number };

/** 按域名后缀匹配（`www.` 已被 hostOf 去掉）；认不出的返回 undefined */
function matchHost(url: string) {
  const host = hostOf(url).toLowerCase();
  return KNOWN.find((k) => host === k.host || host.endsWith(`.${k.host}`) || host.includes(k.host));
}

/**
 * 引擎 → 色度。认不出的（自建 SearXNG、内网聚合页）按域名散列，
 * 同一个引擎永远同一个颜色。
 */
export function engineTint(url: string): EngineTint {
  const hit = matchHost(url);
  if (hit) return { h: hit.h, s: hit.s };
  return { h: fallbackHue(hostOf(url) || url), s: 62 };
}

/**
 * 逐字上色的品牌色（Google），长度与名字一致；不是多彩品牌就返回 null，
 * 由调用方退回单色。
 *
 * 名字比色板长就循环取用（"Google 搜索"也能上色），短就只用前几个。
 * 用户改了名字也没关系 —— 颜色跟着域名，不跟着字面。
 */
export function engineLetters(url: string, name: string): string[] | null {
  const letters = matchHost(url)?.letters;
  if (!letters) return null;
  return Array.from({ length: name.length }, (_, i) => letters[i % letters.length]);
}

/**
 * 橙黄那段色相（35~100）天生显亮，白字 / 白图标压在上面会白成一片。
 * 用它的地方（实心按钮）要把明度压深一档 —— 与 tint.ts 里 avatarGradient
 * 对黄绿段的处理是同一条规则。
 */
export function isBrightHue(h: number): boolean {
  return h >= 35 && h <= 100;
}
