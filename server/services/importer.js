import domino from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { fetchBytes, decodeText, sniffCharset } from './http.js';
import { BODY_MAX } from './knowledge.js';

/* ── 外链文章导入 ──────────────────────────────────────────────────────
   把一个网址抓回来、抽出正文、转成 Markdown，交给编辑器让用户过一眼再存。

   为什么是"预览后自己存"而不是直接入库：正文抽取是启发式的，一定会有
   判断失误的时候（菜单被当正文、正文被当菜单都不罕见）。直接入库等于把
   一次猜错变成库里一条脏数据；过一眼的成本远低于事后清理。

   三件事必须知道：
   1. **抓的是服务器所在的网络**，不是你的浏览器。这台机器连不上的站点
      （实测 en.wikipedia.org / huggingface.co 直接超时）在这里同样连不上，
      和程序无关。
   2. **有反爬的站点会直接 403**（实测 openai.com）。绕过去要上无头浏览器，
      不在这个功能的范围内 —— 报错里会说清是"对方拒绝"，不是"地址写错"。
   3. 正文里的图片是**外链**，不下载到本地。原站删图或防盗链时图会失效，
      这是刻意不做的一层：把图搬进来要处理存储、去重、清理，是另一个功能。

   转换用 turndown（+GFM 插件，为了表格 / 任务清单 / 删除线）。它自带一个
   DOM 实现，所以不需要 jsdom —— 那是个几十 MB 的依赖，为了几十 KB 的转换
   不值得。抽取用同一个 DOM（domino），因此也是真正的 DOM 解析而不是正则抠 HTML。 */

const HTML_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
/** 正文长度上限，和知识库正文同一个天花板 */
export const IMPORT_MAX = BODY_MAX;

/** 整块丢掉的标签。这些要么没有正文意义，要么是页面级的框架 */
const DROP_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'canvas',
  'form',
  'button',
  'select',
  'textarea',
  'dialog',
  'nav',
  'header',
  'footer',
  'aside',
];

/**
 * 按 class / id 判断"这块不是正文"。
 *
 * 这一步比"挑出正文"重要得多：漏挑只是正文里少一段，漏删则会把导航、页脚、
 * 评论区一起搬进知识库 —— 后者是用户第一眼就会看到的糟糕结果。
 * 所以宁可删过头，也不放过。
 */
const DROP_PATTERN =
  /(^|[-_ ])(nav|menu|sidebar|footer|header|comment|share|social|related|recommend|advert|ads?|banner|breadcrumb|copyright|subscribe|newsletter|toolbar|pagination|pager|popup|modal|login|search|rating|widget|promo)([-_ ]|$)/i;

/** 语义化的正文容器，按可信度从高到低 */
const CONTAINER_SELECTORS = [
  'article',
  'main',
  '[role=main]',
  '#content',
  '.content',
  '.post-content',
  '.entry-content',
  '.article-content',
  '#main',
  '.post',
  '.article',
];

function turndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  service.use(gfm);
  /* 抽取阶段已经删过一轮，这里再删一次是因为 turndown 也会把
     <script> 里的代码原样搬出来 —— 那是页面脚本，不是文章内容 */
  service.remove(['script', 'style', 'noscript', 'iframe', 'template']);
  return service;
}

const textLen = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim().length;

/** domino 的 querySelectorAll 返回的是类 NodeList —— 有 length 和 forEach，
 *  但**没有 Symbol.iterator**，直接 for...of / 展开都会抛错。一律先转数组。 */
const all = (root, selector) => Array.from(root.querySelectorAll(selector) || []);

function metaOf(doc, keys) {
  for (const key of keys) {
    const el = doc.querySelector(`meta[property="${key}"]`) || doc.querySelector(`meta[name="${key}"]`);
    const value = el?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return '';
}

/**
 * 第一步：删掉"整块肯定不是正文"的标签。
 * 只按标签名删，不看 class/id —— 标签名不会撒谎，而 class 会：
 * arxiv 的正文 `<main>` 挂在一个 class 命中噪声清单的祖容器里，
 * 按 class 全局删会把整篇正文连坐删掉（这个 bug 真踩过）。
 */
function dropChromeTags(root) {
  for (const tag of DROP_TAGS) {
    for (const el of all(root, tag)) el.remove();
  }
}

/** 第二步：按 class/id 删噪声。**只在选中容器的内部做**，容器自己不会被误伤。 */
function dropNoise(root) {
  for (const el of all(root, '[class],[id]')) {
    const marker = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    if (DROP_PATTERN.test(marker)) el.remove();
  }
  for (const el of all(root, '[style]')) {
    const style = el.getAttribute('style') || '';
    // display:none / visibility:hidden 的元素不是给人看的
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) el.remove();
  }
}

/**
 * 挑正文容器，然后清理它内部的噪声。
 *
 * 顺序是刻意的：**先按语义挑，再在容器内部清**。
 * 反过来（先全局清、再挑）会踩上面说的连坐问题。
 * 语义标签找不到时才退化成"按文字量猜"，那种情况要先全局清一轮，
 * 否则页脚/侧栏的文字量会把真正的正文比下去 —— 猜出来的结果
 * 要在界面上说清楚，用户才知道该多检查两眼。
 */
function extractContent(doc) {
  dropChromeTags(doc.body);

  for (const selector of CONTAINER_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el && textLen(el) >= 200) {
      dropNoise(el);
      return { el, confident: true };
    }
  }

  dropNoise(doc.body);
  let best = null;
  for (const el of all(doc, 'div,section,td,article,main')) {
    const len = textLen(el);
    if (!best || len > best.len) best = { el, len };
  }
  if (best && best.len >= 200) return { el: best.el, confident: false };
  return { el: doc.body, confident: false };
}

/**
 * 掐掉正文首尾的"页面壳"：面包屑、分享按钮、App 下载提示。
 *
 * 这些东西的共同特征是**链接密度高、去掉链接文字后剩不下什么**，
 * 而且贴在首尾。所以只在首尾各看 6 行，中间一行都不动 ——
 * 正文中段出现一个短链接是正常的（参考文献、相关链接），删了就是真丢内容。
 */
function trimChromeLines(markdown) {
  const lines = markdown.split('\n');
  const chrome = (line) => {
    const t = line.trim();
    if (!t) return true; // 空行跟着一起吞
    if (!/\]\(/.test(t)) return false;
    /* 判据要量**去掉链接后的可见文字**，不能量原始行：
       一条三个链接的面包屑光 URL 就上百字符，按原始长度看永远不像"短导航条"。 */
    const visible = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[|·\s]+/g, '').trim();
    return visible.length < 26;
  };

  let start = 0;
  while (start < Math.min(6, lines.length) && chrome(lines[start])) start += 1;
  let end = lines.length;
  while (end > Math.max(start, lines.length - 6) && chrome(lines[end - 1])) end -= 1;

  const kept = lines.slice(start, end);

  /* 开头常常是一行署名（"作者 · 2026-10-05 · 3 分钟读完"、
     "2026/9/7 16:36 来源：某某网"）。它没有"去掉链接就没内容"的特征，
     上面那条规则抓不到，所以单独加一条更窄的判据：
     短、含日期、并且带链接或用 ·/| 分隔。
     它可能就在第一行，也可能紧跟在正文标题下面，两种情况都看。 */
  const byline = (line) =>
    Boolean(line) &&
    !line.startsWith('#') &&
    line.length <= 90 &&
    /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(line) &&
    (/\]\(/.test(line) || /[·|｜]/.test(line));

  const nextText = (from) => {
    let i = from;
    while (i < kept.length && !kept[i].trim()) i += 1;
    return i;
  };

  const head = nextText(0);
  if (byline(kept[head]?.trim() || '')) {
    kept.splice(head, 1);
  } else if ((kept[head]?.trim() || '').startsWith('#')) {
    const after = nextText(head + 1);
    if (byline(kept[after]?.trim() || '')) kept.splice(after, 1);
  }

  return kept.join('\n').trim();
}

/** 把相对地址补成绝对地址：不补的话导入后的链接和图片全是死链 */
function absolutize(root, baseUrl) {
  for (const el of all(root, 'a[href]')) {
    const href = el.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    try {
      el.setAttribute('href', new URL(href, baseUrl).href);
    } catch {
      /* 解析不了就原样留着，总比删掉强 */
    }
  }
  for (const img of all(root, 'img')) {
    /* 懒加载：src 常常是一张占位图，真地址在 data-src 这类属性里 */
    const lazy = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc'].map((k) => img.getAttribute(k)).find(Boolean);
    const raw = lazy || img.getAttribute('src') || '';
    if (!raw) continue;
    try {
      img.setAttribute('src', new URL(raw, baseUrl).href);
    } catch {
      /* 同上 */
    }
    // 留着 srcset 会让 Markdown 里出现一段没人看得懂的 URL 列表
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    img.removeAttribute('decoding');
  }
}

const collapse = (text) =>
  String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** 站点名加在标题尾巴上很常见（"标题 - 某某网"），去掉它 */
function stripSiteSuffix(title, siteName) {
  if (!siteName) return title;
  const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`\\s*[-|·—–_]\\s*${escaped}\\s*$`, 'i'), '').trim() || title;
}

/**
 * 抓一个网址并转成 Markdown。**不写库**，返回值交给界面预览。
 * @returns {Promise<{url,title,summary,markdown,siteName,publishedAt,tags,warnings}>}
 */
export async function importFromUrl(rawUrl, options = {}) {
  /** 指定正文容器。留空 = 按语义/文字量猜（默认行为，导入知识库走这条） */
  const selector = options.selector ? String(options.selector) : '';
  const input = String(rawUrl || '').trim();
  if (!input) throw new Error('请填一个网址');

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('地址无法解析，检查一下有没有写错');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http / https 地址');

  const warnings = [];

  const page = await fetchBytes(target.href, {
    limit: HTML_LIMIT,
    timeout: TIMEOUT_MS,
    redirects: MAX_REDIRECTS,
    accept: 'text/html,application/xhtml+xml,*/*',
    // 打的是公网，证书该校验就校验（和站点取色那边的取舍正相反）
    insecure: false,
  });

  const type = page.type || '';
  if (type && !/html|xml/i.test(type)) {
    throw new Error(`这个地址返回的是 ${type.split(';')[0]}，不是网页`);
  }

  const html = decodeText(page.body, type, sniffCharset(page.body));
  if (!html.trim()) throw new Error('这个地址返回了空内容');

  const doc = domino.createWindow(html).document;
  const baseUrl = page.url || target.href;

  /* 元信息要在瘦身之前取：og:title 这些标签本身就在 <head> 里，
     而且正文里的 <h1> 常在会被删掉的 <header> 中 */
  const siteName = metaOf(doc, ['og:site_name']) || target.hostname.replace(/^www\./, '');
  const rawTitle =
    metaOf(doc, ['og:title', 'twitter:title']) ||
    doc.querySelector('h1')?.textContent?.trim() ||
    doc.querySelector('title')?.textContent?.trim() ||
    target.hostname;
  const summary = metaOf(doc, ['og:description', 'description', 'twitter:description']).slice(0, 400);
  const publishedAt =
    metaOf(doc, ['article:published_time', 'og:published_time', 'pubdate']) ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime') ||
    '';
  const tagList = all(doc, 'meta[property="article:tag"]')
    .map((el) => (el.getAttribute('content') || '').trim())
    .filter(Boolean)
    .slice(0, 6);

  /* 页面结构已知时直接指到容器上，不走"猜正文"。
     典型场景是 AIHOT 的条目页：外面裹着导航、AI 导读、推荐理由、末尾标签，
     而且原文与译文是同一页上的两个视图 —— 通用抽取器挑出来的那块会把
     这些都带进去（实测一篇英文稿抽出 1.5 万字，其中只有 28% 是中文，
     等于连英文原文一起吃了）。指不到就抛错，让调用方退回去抓真正的原文，
     而不是拿一坨掺了壳的东西去喂模型。 */
  let container;
  let confident = true;
  if (selector) {
    container = doc.querySelector(selector);
    if (!container) throw new Error(`页面结构变了：没找到 ${selector} 容器`);
  } else {
    const picked = extractContent(doc);
    container = picked.el;
    confident = picked.confident;
    if (!confident) {
      warnings.push('没找到明显的正文容器，已按"文字最多的那块"来取，可能混进菜单或侧栏，存之前扫一眼');
    }
  }
  absolutize(container, baseUrl);

  let markdown = trimChromeLines(collapse(turndownService().turndown(container.innerHTML || '')));
  if (!markdown) throw new Error('这个页面里没抽出可读的正文（可能是纯 JS 渲染的页面）');
  if (markdown.length < 120) {
    warnings.push('只抽到不到 120 字，多半没抓全 —— 有些页面的正文是 JS 渲染出来的，服务器这边拿不到');
  }

  if (markdown.length > IMPORT_MAX) {
    markdown = markdown.slice(0, IMPORT_MAX);
    warnings.push(`正文超过 ${Math.round(IMPORT_MAX / 1000)} 千字，已截断`);
  }

  const title = stripSiteSuffix(rawTitle, siteName).slice(0, 160);

  /* 正文开头那个一级标题和条目自己的「标题」字段是同一句话，
     留着的话阅读页会连着出现两遍。只在两串"去掉空白和标点后相等"时才删，
     免得把真正不同的小标题误删。 */
  markdown = markdown.replace(/^#\s+(.+)\n+/, (whole, text) =>
    loose(text) === loose(title) ? '' : whole,
  );

  return {
    url: baseUrl,
    title,
    summary,
    markdown,
    siteName,
    publishedAt: publishedAt ? safeIso(publishedAt) : '',
    tags: tagList,
    warnings,
  };
}

/** 只留中日韩文字、字母和数字，用来做"这两个标题是不是同一句"的比较 */
const loose = (text) => String(text || '').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');

/** 时间戳来自第三方页面，格式五花八门，认不出来就当没有 */
function safeIso(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}
