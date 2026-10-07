import { fetchBytes, decodeText } from './http.js';

/* ── 外部搜索建议 ──────────────────────────────────────────────────────
   首页大搜索框的"联想词"。原来那里只列本地的东西（工具箱入口、知识库文章），
   现在多一层：把词发给搜索引擎，取它自己的候选词。

   为什么必须由服务端代取：这几家都不给 CORS 头，浏览器直连读不到响应体；
   而 JSONP 那条老路（百度 succ 的 cb=）返回的是 GBK 编码的 JS，
   还得再解一次码，不如服务端直接拿 JSON。

   ── 为什么是一张写死的表，而不是按用户的引擎地址去猜 ──────────────────
   搜索引擎的地址是**用户可填**的（设置页可以随便改）。如果拿它推导出上游
   地址去请求，这个接口就成了"能用后端身份访问任意地址"的跳板（SSRF）：
   填一个内网地址进去，服务端就会替你去请求它。
   所以上游主机全部写死在这张表里，认不出来就不提供建议 —— 页面上
   只是没有联想词，本地候选照旧。
*/

/** 上游一次最多读多少字节。这几家的响应都在几 KB 以内，64KB 是保险量 */
const LIMIT = 64 * 1024;
/** 上游超时。比 http.js 默认的 8 秒短：联想是"顺手给的"，等太久不如不给 */
const TIMEOUT_MS = 4000;
/** 单条建议的长度上限，以及一次最多给几条 */
const MAX_ITEM = 60;
const MAX_ITEMS = 8;

/**
 * 支持的建议源。match 比的是引擎地址的**主机名**，不是整串地址。
 * pick 负责把各家的响应形状归一成"一串词"：
 * · 百度 sugrec  {q, g: [{q}]}
 * · Google / Bing  OpenSearch JSON  [原文, [候选…], …]（Bing 也是这个格式）
 * · 360 sug      {result: [{word}]}
 */
const SOURCES = [
  {
    id: 'baidu',
    label: '百度',
    match: /(^|\.)baidu\.com$/i,
    url: (q) => `https://www.baidu.com/sugrec?prod=pc&wd=${encodeURIComponent(q)}`,
    pick: (json) => (Array.isArray(json?.g) ? json.g.map((x) => x?.q) : []),
  },
  {
    id: 'google',
    label: 'Google',
    match: /(^|\.)google\.[a-z.]{2,}$/i,
    url: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
    pick: (json) => (Array.isArray(json?.[1]) ? json[1] : []),
  },
  {
    id: 'bing',
    label: 'Bing',
    match: /(^|\.)bing\.com$/i,
    url: (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
    pick: (json) => (Array.isArray(json?.[1]) ? json[1] : []),
  },
  {
    id: 'so',
    label: '360',
    match: /(^|\.)(so|360)\.(com|cn)$/i,
    url: (q) => `https://sug.so.360.cn/suggest?word=${encodeURIComponent(q)}&encodein=utf-8&encodeout=utf-8`,
    pick: (json) => (Array.isArray(json?.result) ? json.result.map((x) => x?.word) : []),
  },
];

/** 引擎的搜索地址 → 建议源。认不出来返回 null（页面就不会来问） */
export function suggestSource(url) {
  let host = '';
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return null;
  }
  return SOURCES.find((s) => s.match.test(host)) ?? null;
}

/**
 * 结果短时缓存。
 *
 * 打字是一个字一个字来的，而联想请求在 debounce 之后仍然会重复：
 * 打错一个字删掉重来、来回改前缀，同一串前缀会被问好几遍。
 * 缓存 60 秒足够覆盖这类重复，也让上游少挨几轮 —— 尤其 Google
 * 在国内动辄两三秒，同一串词问第二遍毫无意义。
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.items;
}

function cacheSet(key, items) {
  cache.set(key, { at: Date.now(), items });
  // Map 保留插入顺序，超上限就从最早的那条开始丢
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * 取某个词的联想词。
 *
 * **任何失败都返回空数组**：联想拿不到不是错误，不该在界面上报错、
 * 也不该让搜索框跳一下。用户关心的是"能不能搜"，不是"候选词有没有回来"。
 * 失败同样进缓存 —— 否则上游挂了之后，每敲一个字都会再去等一次超时。
 *
 * @returns {Promise<string[]>}
 */
export async function fetchSuggest(source, q) {
  const key = `${source.id}\u0000${q}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let items = [];
  try {
    const res = await fetchBytes(source.url(q), {
      limit: LIMIT,
      timeout: TIMEOUT_MS,
      accept: 'application/json,text/javascript,*/*',
    });
    const json = JSON.parse(decodeText(res.body, res.type));
    const words = source.pick(json)
      .map((x) => String(x ?? '').trim().slice(0, MAX_ITEM))
      /* 与输入完全相同的候选没有信息量（各家都爱把它放在第一条） */
      .filter((x) => x && x.toLowerCase() !== q.toLowerCase());
    items = [...new Set(words)].slice(0, MAX_ITEMS);
  } catch {
    items = [];
  }

  cacheSet(key, items);
  return items;
}
