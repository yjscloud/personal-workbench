import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

/* ── 一个够用的出站 GET ────────────────────────────────────────────────
   本项目要访问的外部地址分两类，需求不同，所以这里不引 fetch：

   · 站点主色探测（sitecolor.js）打的是**用户自己内网的面板**，
     PVE / 爱快 / NAS 大量用自签证书，必须能对单个请求关掉证书校验；
   · 外链文章导入（importer.js）打的是公网，反而**不能**关校验。

   所以校验是参数（insecure），默认开启，只有明确知道对方是自签环境的调用方
   才关掉。其余是两者共同需要的：超时、体积上限、重定向、gzip/br 解压、
   GBK/GB2312 解码、以及一个浏览器 UA（许多站点对非常规 UA 直接 403）。 */

/** 许多站点对非常规 UA 直接 403，用浏览器 UA 拿到的才是真页面 */
export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_REDIRECTS = 3;

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (!enc || enc === 'identity') return buf;
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch {
    /* 解压失败就按原文返回：至少还能在乱码里匹配到 ASCII */
  }
  return buf;
}

/**
 * 取一个 URL 的前 limit 字节。超过上限直接掐断连接，不把整张图拖回来。
 * @returns {Promise<{body: Buffer, url: string, type: string, status: number}>}
 */
export function fetchBytes(
  url,
  { limit, timeout = DEFAULT_TIMEOUT_MS, redirects = DEFAULT_REDIRECTS, accept = '*/*', insecure = false } = {},
) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error('地址无法解析'));
    }
    if (!/^https?:$/.test(parsed.protocol)) return reject(new Error(`不支持的协议 ${parsed.protocol}`));

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      {
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, Accept: accept, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        rejectUnauthorized: !insecure,
        timeout,
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, parsed).href;
          } catch {
            return reject(new Error('重定向地址无法解析'));
          }
          return fetchBytes(next, { limit, timeout, redirects: redirects - 1, accept, insecure }).then(resolve, reject);
        }
        if (status < 200 || status >= 300) {
          res.resume();
          // 4xx/5xx 通常带一页说明，但调用方只需要状态码和一句人话
          return reject(new Error(describeStatus(status)));
        }

        const chunks = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            body: decodeBody(Buffer.concat(chunks), res.headers['content-encoding']),
            url: parsed.href,
            type: res.headers['content-type'] || '',
            status,
          });
        };

        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          if (size >= limit) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        // 被 destroy 的响应不会触发 end，在上面 finish 兜住；这里只收拾错误
        res.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`)));
    req.on('error', reject);
    req.end();
  });
}

/** 把状态码翻成人话。403/429 是抓取外部文章时最常见的两种失败，
 *  光给一个数字，用户会以为是程序坏了而不是对面不让抓。 */
function describeStatus(status) {
  if (status === 403) return 'HTTP 403：对方拒绝了这个请求（多半是反爬/Cloudflare），不是地址写错';
  if (status === 404) return 'HTTP 404：页面不存在';
  if (status === 429) return 'HTTP 429：请求过于频繁，被对方限流';
  if (status >= 500) return `HTTP ${status}：对方服务器出错`;
  return `HTTP ${status}`;
}

/**
 * 按 charset 解码。优先级：调用方显式指定 > content-type > utf-8。
 *
 * 显式那一路是给「文章导入」用的：不少中文站点只在 HTML 的
 * `<meta charset>` 里声明 GBK，content-type 上什么都不写，
 * 只认 header 的话整篇会解成乱码。
 */
export function decodeText(buf, type = '', explicit = '') {
  const fromHeader = /charset=([\w-]+)/i.exec(type)?.[1];
  const charset = String(explicit || fromHeader || '').toLowerCase();
  const enc = charset === 'gbk' || charset === 'gb2312' ? 'gbk' : 'utf-8';
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** 从 HTML 头部字节里嗅探 charset（content-type 里没写时的兜底） */
export function sniffCharset(buf) {
  const head = buf.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase() || '';
}
