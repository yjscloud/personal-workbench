import { fetchBytes, decodeText } from './http.js';

/* ── 站点主色探测 ────────────────────────────────────────────────────
   工具箱的磁贴想跟着"这家网站长什么样"走，所以需要一个品牌色。
   两级信号，从便宜到贵：

     1. <meta name="theme-color">：站点自己声明的品牌色，最准，而且只读几 KB HTML；
     2. favicon 的主色：把图标解码成像素，按"出现次数 × 饱和度"投票选代表色。

   都拿不到就返回 null，前端退回糖纸色板 —— 宁可不染色，也不要染错。

   四个必须做对的点：
   · 出站请求走 services/http.js（超时、体积上限、重定向、解码都在那里统一管）。
     探测的对象是用户自己内网的面板，大多用自签证书，所以这里显式开 insecure：
     只发 GET、不带任何凭据，用"不校验证书"换这些入口也能取到色是划算的。
     同一个开关在「外链文章导入」那边是关着的 —— 那边打的是公网，不该关校验。
   · 必须有体积上限：对面是别人的服务器，一个不响应的地址不能把整轮刷新拖死。
   · 灰度色要丢掉：GitHub、Notion 这类标志本身就是灰的，硬套上去只会
     得到一张脏灰卡片，不如退回色板。
   · 图标可能是 PNG / ICO / SVG 三种，三种都解：现代站点用 PNG ⧺ SVG，
     老站点和自建面板几乎全是 .ico（内嵌 PNG 或 BMP）。 */

/* 上限留在调用方：探测只要几 KB 的 HTML 和一张图标，别为了取色把整页拖回来 */
const HTML_LIMIT = 512 * 1024;
const ICON_LIMIT = 1024 * 1024;

/* ── 颜色工具 ──────────────────────────────────────────────────────── */

function rgbToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** HSL。只用 L 判明暗、S 判是不是灰，够用了 */
function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

/** '#abc' / '#aabbcc' / '#aabbccdd' / 'rgb(a)' → '#AABBCC'；认不出来返回 null */
function parseCssColor(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return rgbToHex(...hexToRgb(`#${h.slice(0, 3)}`));
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6).toUpperCase()}`;
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (rgb) return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  return null;
}

/** 颜色够不够"有颜色"：太亮、太暗、太灰都不适合当卡片底色 */
const usable = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  const [, s, l] = rgbToHsl(r, g, b);
  return l <= 0.93 && l >= 0.08 && s >= 0.12;
};

/* ── HTML 解析 ─────────────────────────────────────────────────────── */

/** 把标签里的属性抠出来。属性顺序不固定，所以不能靠一条正则硬匹配 content */
function attrsOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

/** 站点声明的主题色。浅/深色各声明一条时会命中第一条能解析的 */
function metaThemeColor(html) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    const a = attrsOf(tag);
    const name = (a.name || a.property || '').toLowerCase();
    if (name !== 'theme-color' && name !== 'msapplication-tilecolor') continue;
    const color = parseCssColor(a.content);
    if (color) return color;
  }
  return null;
}

/** 候选图标：apple-touch-icon 优先（通常是一张实心方图，取色最准），
    其次是 sizes 最大的 icon，最后兜底 /favicon.ico */
function iconCandidates(html, baseUrl) {
  const found = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const a = attrsOf(tag);
    const rel = (a.rel || '').toLowerCase();
    if (!/\bicon\b|apple-touch-icon/.test(rel) || !a.href) continue;
    let href;
    try {
      href = new URL(a.href, baseUrl).href;
    } catch {
      continue;
    }
    const sizes = (a.sizes || '')
      .split(/\s+/)
      .map((s) => parseInt(s, 10) || 0);
    found.push({
      href,
      size: Math.max(0, ...sizes),
      // mask-icon 是单色蒙版（浏览器上色），没有自己的配色，排最后
      weight: /apple-touch/.test(rel) ? 2 : /mask-icon/.test(rel) ? -1 : 1,
    });
  }
  found.sort((a, b) => b.weight - a.weight || b.size - a.size);
  try {
    found.push({ href: new URL('/favicon.ico', baseUrl).href, size: 0, weight: 0 });
  } catch {
    /* baseUrl 不合法时连兜底都没有，交给上层报错 */
  }
  return found;
}

/* ── 图像解码 ──────────────────────────────────────────────────────── */

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);

/** PNG → RGBA。只吃 8 位非隔行的 0/2/3/4/6 型 —— favicon 覆盖到的就这些 */
function decodePng(buf) {
  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR' && len >= 13) {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (!ihdr || !ihdr.width || !ihdr.height || ihdr.interlace !== 0 || ihdr.depth !== 8) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels || (ihdr.colorType === 3 && !plte)) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const { width, height, colorType } = ihdr;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // 反滤波：每行第一个字节是滤波类型，逐行还原（PNG 的滤波依赖上一行，必须顺序来）
  const lines = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const src = raw.subarray(p, p + stride);
    p += stride;
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const up = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i += 1) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 6) {
      r = lines[i * 4];
      g = lines[i * 4 + 1];
      b = lines[i * 4 + 2];
      a = lines[i * 4 + 3];
    } else if (colorType === 2) {
      r = lines[i * 3];
      g = lines[i * 3 + 1];
      b = lines[i * 3 + 2];
    } else if (colorType === 0) {
      r = g = b = lines[i];
    } else if (colorType === 4) {
      r = g = b = lines[i * 2];
      a = lines[i * 2 + 1];
    } else {
      const idx = lines[i];
      r = plte[idx * 3];
      g = plte[idx * 3 + 1];
      b = plte[idx * 3 + 2];
      a = trns && idx < trns.length ? trns[idx] : 255;
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }

  return { width, height, rgba };
}

/** ICO → RGBA。一个 .ico 里可能塞好几张（16/32/48/256），取面积最大的那张 */
function decodeIco(buf) {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const size = buf.readUInt32LE(off + 8);
    const start = buf.readUInt32LE(off + 12);
    if (!size || start + size > buf.length) continue;
    entries.push({
      size: (buf[off] || 256) * (buf[off + 1] || 256),
      data: buf.subarray(start, start + size),
    });
  }
  entries.sort((a, b) => b.size - a.size);

  for (const entry of entries) {
    // 新版 .ico 允许整张直接塞 PNG
    if (isPng(entry.data)) {
      const img = decodePng(entry.data);
      if (img) return img;
      continue;
    }
    const img = decodeBmp(entry.data);
    if (img) return img;
  }
  return null;
}

/** ICO 里内嵌的 BMP（DIB，没有文件头），32/24/8 位 */
function decodeBmp(data) {
  if (data.length < 40) return null;
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  // DIB 的高度把 AND 掩码那半也算进去了，所以是显示高度的两倍
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const bitCount = data.readUInt16LE(14);
  const colorsUsed = data.readUInt32LE(32);
  if (!width || !height || !Number.isInteger(height)) return null;
  if (bitCount !== 32 && bitCount !== 24 && bitCount !== 8) return null;

  /* .ico 里内嵌的是裸 DIB：没有 14 字节的 BITMAPFILEHEADER，
     色表紧跟信息头，所以起点是 headerSize 而不是 14+headerSize。 */
  const paletteStart = headerSize;
  const paletteCount = bitCount <= 8 ? colorsUsed || 1 << bitCount : 0;
  const pixStart = paletteStart + paletteCount * 4;
  const bytesPerRow = Math.floor((bitCount * width + 31) / 32) * 4;
  if (pixStart + bytesPerRow * height > data.length) return null;

  const rgba = new Uint8Array(width * height * 4);
  let opaqueFallback = bitCount === 32;
  for (let y = 0; y < height; y += 1) {
    const rowOff = pixStart + (height - 1 - y) * bytesPerRow; // DIB 自下而上
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (bitCount === 32) {
        const o = rowOff + x * 4;
        b = data[o];
        g = data[o + 1];
        r = data[o + 2];
        a = data[o + 3];
      } else if (bitCount === 24) {
        const o = rowOff + x * 3;
        b = data[o];
        g = data[o + 1];
        r = data[o + 2];
      } else {
        const idx = data[rowOff + x];
        const o = paletteStart + idx * 4;
        b = data[o];
        g = data[o + 1];
        r = data[o + 2];
      }
      const t = (y * width + x) * 4;
      rgba[t] = r;
      rgba[t + 1] = g;
      rgba[t + 2] = b;
      rgba[t + 3] = a;
    }
  }

  /* 老工具导出的 32 位图标常常整张 alpha=0（把它们当透明会得到一张空图）。
     整张都不透明时才认 alpha，否则一律按不透明处理。 */
  if (opaqueFallback) {
    let anyOpaque = false;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 0) {
        anyOpaque = true;
        break;
      }
    }
    if (!anyOpaque) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  }

  return { width, height, rgba };
}

/** SVG 图标：解不出像素，但 fill/stroke 里的十六进制色就是它的配色 */
function svgColor(text) {
  const counts = new Map();
  for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = parseCssColor(`#${m[1]}`);
    if (!hex || !usable(hex)) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  let best = null;
  for (const [hex, n] of counts) if (!best || n > best.n) best = { hex, n };
  return best?.hex || null;
}

/** 代表色：把像素按 16 级量化分桶投票，饱和度越高的像素票越重 */
function dominantColor(img) {
  const { width, height, rgba } = img;
  // 大图按步长抽样，几十万像素没必要逐点统计
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)));
  const buckets = new Map();

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] < 128) continue;
      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      const hex = rgbToHex(r, g, b);
      if (!usable(hex)) continue;
      const [, s] = rgbToHsl(r, g, b);
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucket = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
      const w = 1 + s * 3;
      bucket.w += w;
      bucket.r += r * w;
      bucket.g += g * w;
      bucket.b += b * w;
      buckets.set(key, bucket);
    }
  }

  let best = null;
  for (const b of buckets.values()) if (!best || b.w > best.w) best = b;
  if (!best || best.w <= 0) return null;
  return rgbToHex(best.r / best.w, best.g / best.w, best.b / best.w);
}

/* ── 对外 ──────────────────────────────────────────────────────────── */

async function fetchIconColor(url) {
  const { body, type } = await fetchBytes(url, { limit: ICON_LIMIT, accept: 'image/*,*/*', insecure: true });
  if (!body.length) return null;

  if (isPng(body)) {
    const img = decodePng(body);
    return img ? dominantColor(img) : null;
  }
  if (body.length > 4 && body.readUInt16LE(0) === 0 && body.readUInt16LE(2) === 1) {
    const img = decodeIco(body);
    return img ? dominantColor(img) : null;
  }
  // SVG 是文本，content-type 有时是错的，所以按内容再认一次
  const head = body.subarray(0, 512).toString('latin1').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || type.includes('svg')) {
    return svgColor(body.toString('utf8'));
  }
  return null;
}

/**
 * 探测一个站点的品牌色。
 * @returns {Promise<{color: string, source: 'theme-color'|'icon'} | null>}
 */
export async function probeSiteColor(url) {
  const page = await fetchBytes(url, { limit: HTML_LIMIT, accept: 'text/html,application/xhtml+xml,*/*', insecure: true });
  const html = decodeText(page.body, page.type);

  const declared = metaThemeColor(html);
  if (declared) return { color: declared, source: 'theme-color' };

  // 只试前几个候选：越往后越可能是兜底的 .ico，没必要都拉一遍
  for (const candidate of iconCandidates(html, page.url).slice(0, 4)) {
    try {
      const color = await fetchIconColor(candidate.href);
      if (color && usable(color)) return { color, source: 'icon' };
    } catch {
      /* 单个图标失败就换下一个，全部失败才返回 null */
    }
  }
  return null;
}
