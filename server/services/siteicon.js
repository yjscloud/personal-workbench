import { fetchBytes, decodeText } from './http.js';
import { iconCandidates } from './sitecolor.js';

/* ── 站点图标固化 ──────────────────────────────────────────────────────
   把站点自己的 favicon 抓下来、存进书签，之后页面只从本站取图标。

   为什么要固化（原来每次刷新都现场取，结果是"图标闪一下"）：
   · 每次刷新，每个磁贴都要重新去站点拿 favicon。内网面板大多不给
     缓存头，于是每次都是一次真实的往返；
   · 拿不到还要等第三方聚合服务兜底（那边对内网域名不报错，只回一张
     通用地球图，所以要压 1.2 秒的优先窗口）；
   · 而这段时间里界面只能先画首字色块，等图标到了再切过去 ——
     这次切换就是用户看到的"闪"。

   固化之后：图标变成 /bookmarks/:id/icon 这个同源地址，刷新时命中浏览器
   缓存，并且与站点的可达性、聚合服务的可用性都脱钩（内网面板只在第一次
   同步时被访问一次）。

   抓取口径与 sitecolor.js 一致：站点 HTML 里声明的 icon 优先，
   /favicon.ico 兜底。
*/

/** 页面 HTML 的体积上限，与取色那边同一档 */
const HTML_LIMIT = 512 * 1024;
/**
 * 固化下来的图标体积上限：128KB。
 *
 * 定这个数是被现实逼出来的 —— 下面这几种都**只**能拿到大图：
 * · Hugging Face 的 /favicon.ico 有 79KB（一个多尺寸 ICO 包）；
 * · 飞牛 NAS 的 /favicon.ico 66KB；
 * · Gemini 只声明了一张 512×512 的 PNG（61KB），站点根上没有 favicon.ico（404）。
 * 卡在 64KB 时这三家全都固化失败，于是每次刷新又回落到现场取图 —— 也就是
 * 用户看到的"这个图标还是会闪"。
 *
 * 用它的地方是 22~44px 的磁贴，所以这个上限确实远大于所需；但收进库里的
 * 是"站点唯一愿意给的尺寸"，而拒绝它反而更贵（每个入口每次刷新都要重取一遍）。
 */
const ICON_MAX = 128 * 1024;
/** 一次最多试几个候选：越往后越可能是兜底的 .ico */
const TRY_MAX = 6;

/**
 * 按内容认图片类型，认不出来就丢掉。
 *
 * 不认 content-type：站点把图标配错类型是常事，而 SVG 一律不收 ——
 * 它是能带脚本的，虽然本站只把它当 <img> 用（不会执行），
 * 但 /bookmarks/:id/icon 这个地址是能直接在浏览器里打开的，
 * 那就等于给人一个同源的 XSS 入口，不值得为几张矢量图标冒这个险。
 */
function sniffImage(buf) {
  if (buf.length < 8) return '';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // .ico 的文件头：保留位 0 + 类型 1
  if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return 'image/x-icon';
  return '';
}

/**
 * 图标聚合服务。**与前端 lib/format.ts 里那个兜底是同一个** —— 固化链必须
 * 和页面上那条链一致，否则就会出现"页面显示得出来、却固化不下来"的中间态：
 * Gemini 之前就是这样（它只声明一张 512 的 PNG、站点根上又没有 favicon.ico，
 * 页面靠聚合服务能出图标，固化却一路失败，于是每次刷新都要重走一遍 → 闪）。
 */
const aggregatorUrl = (host) => `https://favicon.cccyun.cc/${host}`;

/** 取一份图并校验：认不出类型、或超过上限的都不算数 */
async function grabImage(href, { insecure }) {
  const { body } = await fetchBytes(href, {
    /* 多读一个字节：刚好卡在上限上的也拒掉 */
    limit: ICON_MAX + 1,
    accept: 'image/*,*/*',
    insecure,
    timeout: 6000,
  });
  if (!body.length || body.length > ICON_MAX) return null;
  const mime = sniffImage(body);
  return mime ? `data:${mime};base64,${body.toString('base64')}` : null;
}

/**
 * 抓一个站点的图标。
 *
 * 三层，从"最准"到"最兜底"：
 *   ① 站点 HTML 里声明的 icon（apple-touch-icon / rel=icon）；
 *   ② 站点根上的 /favicon.ico；
 *   ③ 聚合服务 —— **只在站点自己打得开时**才用它：那家聚合服务对解析不了的
 *      主机不报错，而是回一张通用地球图，那种图存下来比首字色块还差。
 *
 * 全过程**只发不带凭据的 GET**；打站点自己时开 insecure —— 那些多半是
 * 用户内网的面板，自签证书是常态，不关校验就只能拿到一堆失败。
 * 聚合服务走公网，正常校验。
 *
 * @returns {Promise<{dataUrl: string, source: 'declared'|'favicon'|'aggregator'} | null>}
 */
export async function fetchSiteIcon(url) {
  const candidates = [];
  let base = url;
  let siteReachable = false;

  try {
    const page = await fetchBytes(url, {
      limit: HTML_LIMIT,
      accept: 'text/html,application/xhtml+xml,*/*',
      insecure: true,
    });
    base = page.url;
    siteReachable = true;
    /* iconCandidates 已经按"声明过的优先、/favicon.ico 兜底"排好序
       （weight：apple-touch 2 / 普通 icon 1 / mask-icon -1 / 兜底 0） */
    candidates.push(...iconCandidates(decodeText(page.body, page.type), base));
  } catch {
    /* 页面打不开（面板恰好离线、或路径不是网页）不算致命：
       下面还有站点根上的 /favicon.ico 这条路 */
  }

  let root = '';
  try {
    root = new URL('/favicon.ico', base).href;
  } catch {
    root = '';
  }
  /* 页面没取到时候选是空的（那时 iconCandidates 没机会补兜底），自己补上 */
  if (root && !candidates.some((c) => c.href === root)) candidates.push({ href: root, weight: 0, size: 0 });

  /* iconCandidates 是按"取色最准"排的（同一档里大图在前），而固化要的是
     **够用就好**：同一档里先试小的 —— 省下载、省存储，备份也跟着小一号。
     声明里只有大图的（Gemini 就只给一张 512），就只能用它。
     size 为 0 表示站点没写 sizes，当作"可能大"排在小图之后。 */
  const ordered = [...candidates].sort(
    (a, b) => b.weight - a.weight || (a.size || Infinity) - (b.size || Infinity),
  );

  for (const candidate of ordered.slice(0, TRY_MAX)) {
    try {
      const dataUrl = await grabImage(candidate.href, { insecure: true });
      if (dataUrl) return { dataUrl, source: candidate.weight > 0 ? 'declared' : 'favicon' };
    } catch {
      /* 单个候选失败就换下一个 */
    }
  }

  /* 站点自己的都给不出可用图标（没声明、404、或者图太大），而它本身是通的：
     退到聚合服务。Hugging Face 就属于这种 —— 它的 favicon.ico 体积不稳定
     （79KB~200KB 都见过），大过上限时只能靠这一层。 */
  if (siteReachable && base) {
    try {
      const host = new URL(base).host;
      const dataUrl = await grabImage(aggregatorUrl(host), { insecure: false });
      if (dataUrl) return { dataUrl, source: 'aggregator' };
    } catch {
      /* 聚合服务也不给，那就没有 —— 页面会退回首字色块 */
    }
  }

  return null;
}
