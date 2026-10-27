import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { resolvePublicTarget } from './ssrf.js';

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

/**
 * 响应头的体积上限，放宽到 64KB。
 *
 * Node 默认只给 16KB，而 Google 这类站点的响应头能到 26KB（一大串
 * CSP / Report-To / Set-Cookie），超了直接抛 `Parse Error: Header overflow`
 * —— 表现是"这个站点的页面根本读不出来"，连它声明在 HTML 里的图标地址
 * 都拿不到。实测 gemini.google.com 就是这么挂的。
 * 这只是解析缓冲，不常用的大头上限换一次可用性，划算。
 */
const MAX_HEADER_BYTES = 64 * 1024;

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
 *
 * guard=true 是给"地址由用户填、抓的是服务器所在网络"的场景用的
 * （见 services/ssrf.js）：只允许公网 http/https，每一跳重定向都重新校验，
 * 并且**连解析出来的 IP**，而不是再让系统解析一次域名。
 * 站点取色 / 取图标打的是用户自己的内网面板，不能开这个开关。
 *
 * @returns {Promise<{body: Buffer, url: string, type: string, status: number}>}
 */
export async function fetchBytes(
  url,
  { limit, timeout = DEFAULT_TIMEOUT_MS, redirects = DEFAULT_REDIRECTS, accept = '*/*', insecure = false, guard = false } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('地址无法解析');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`不支持的协议 ${parsed.protocol}`);

  /* 解析 + 校验在建立连接之前完成。失败时抛 SsrfError（code=SSRF_BLOCKED），
     路由层据此返回一句"这个地址不允许抓取"，而不是把内网细节带出去。

     guard 是三态：
       false  不校验（关掉了，调用方自己负责）
       true   只允许公网 —— 导入文章这类「地址由用户填、抓的是服务器所在网络」
       'lan'  放行内网段（10/172.16/192.168/ULA），但回环、链路本地（云元数据）、
              组播仍然拒绝 —— 书签图标 / 取色要打用户自己的面板，但不该顺手
              把本机 MySQL 和 169.254.169.254 也变成可读对象 */
  const pinned = guard
    ? await resolvePublicTarget(parsed, { allowPrivate: guard === 'lan' })
    : null;

  return new Promise((resolve, reject) => {
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': BROWSER_UA,
      Accept: accept,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    const options = {
      method: 'GET',
      headers,
      rejectUnauthorized: !insecure,
      maxHeaderSize: MAX_HEADER_BYTES,
      timeout,
    };

    if (pinned) {
      /* 连 IP、Host 头写域名：校验过的那一个地址就是唯一可能被连的地址 */
      headers.Host = parsed.host;
      options.host = pinned.address;
      options.port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
      options.path = `${parsed.pathname}${parsed.search}`;
      /* SNI 与证书校验仍然按域名来；目标本身就是 IP 时不能写 servername，
         否则 TLS 会拿 IP 去校验证书并报 altname 不匹配 */
      if (parsed.protocol === 'https:' && !net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) {
        options.servername = parsed.hostname;
      }
    }

    const onResponse = (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, parsed).href;
        } catch {
          return reject(new Error('重定向地址无法解析'));
        }
        /* 每一跳都重新过 guard —— 首跳公网、第二跳 127.0.0.1 是最常见的绕过 */
        return fetchBytes(next, { limit, timeout, redirects: redirects - 1, accept, insecure, guard }).then(resolve, reject);
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
    };

    /* 传 URL 与传 options 是两种调用形态：pinned 时所有字段都在 options 里，
       不能再把 options 当 URL 传进去（会被当成 url 参数解析）。 */
    const req = pinned ? mod.request(options, onResponse) : mod.request(parsed, options, onResponse);

    req.on('timeout', () => req.destroy(new Error(`请求超时（${Math.round(timeout / 1000)} 秒）`)));
    req.on('error', (err) => {
      /* guard 模式下底层错误里带着 IP:端口（ECONNREFUSED 127.0.0.1:6379），
         原样回显就等于送了一个端口扫描器。统一成一句人话。 */
      if (!guard) return reject(err);
      const timeoutHit = /超时/.test(err.message || '');
      reject(new Error(timeoutHit ? '抓取失败：对方响应超时' : '抓取失败：这个地址没有响应（可能不可达，或不是网页服务）'));
    });
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
