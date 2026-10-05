import { update } from '../store.js';

/* ── AIHOT 每日日报 ───────────────────────────────────────────────────
   /api/v1/dailies/latest 是来源每天 08:00（Asia/Shanghai）发的一期日报：
   一段"今日头条"（lead）+ 几个分区（sections）+ 若干快讯（flashes）。

   它和条目流（news.js）、热点榜（news-hot.js）是三种互补的读法：
     · 条目流 —— 最近有什么，适合翻
     · 热点榜 —— 现在哪些事最热，按多源覆盖度排
     · 日报   —— 今天到底发生了什么，已经归好类

   同样存成整份快照：日报"只编辑一次"，但撤回的引用会从后续响应里移除，
   文档明确说不能永久缓存、要按 Cache-Control 重新校验 —— 所以带上
   If-None-Match，没变就保留手上一份，变了才整份替换。 */

const API_BASE = 'https://aihot.news/api/v1';
const UA = 'PersonalWorkbench/1.0 (self-hosted; +local)';
const TIMEOUT_MS = 15000;

/* 这份 ETag 单独记：榜单、条目、日报是三个接口，各有各的 */
let etag = null;

function strip(input = '') {
  return String(input).replace(/\s+/g, ' ').trim();
}

function cleanSourceName(name) {
  const cleaned = String(name || '')
    .replace(/[（(]\s*(?:RSS|Atom|网页|Web|Blog)\s*[)）]\s*$/i, '')
    .trim();
  return cleaned || 'AIHOT';
}

function rateLimitMessage(res) {
  const raw = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(raw) && raw > 0 ? `，需等待约 ${Math.ceil(raw)} 秒` : '';
  return `被限流（HTTP ${res.status}）${wait}后由下一次定时抓取重试`;
}

function toLocalDaily(raw) {
  const r = raw?.report || (raw?.date ? raw : null);
  if (!r || typeof r !== 'object') return null;

  const lead = r.lead && typeof r.lead === 'object' ? r.lead : null;

  return {
    date: r.date ? String(r.date) : null,
    generatedAt: r.generatedAt ? new Date(r.generatedAt).toISOString() : null,
    windowStart: r.windowStart ? new Date(r.windowStart).toISOString() : null,
    windowEnd: r.windowEnd ? new Date(r.windowEnd).toISOString() : null,
    /* 日报在 AIHOT 上的那一页。给读者"跳过去看整期"用 */
    link: r.links?.aihot || null,
    lead: lead ? { title: strip(lead.title || ''), paragraph: strip(lead.leadParagraph || '') } : null,
    sections: (Array.isArray(r.sections) ? r.sections : [])
      .map((s) => ({
        label: strip(s.label || ''),
        items: (Array.isArray(s.items) ? s.items : [])
          .map((it) => ({
            title: strip(it.title || ''),
            summary: strip(it.summary || '').slice(0, 300),
            source: cleanSourceName(it.source?.name),
            link: it.links?.original || it.links?.aihot || '',
          }))
          .filter((it) => it.title),
      }))
      .filter((s) => s.label && s.items.length),
    flashes: (Array.isArray(r.flashes) ? r.flashes : [])
      .map((f) => ({
        title: strip(f.title || ''),
        source: cleanSourceName(f.source?.name),
        publishedAt: f.publishedAt ? new Date(f.publishedAt).toISOString() : null,
        link: f.links?.original || f.links?.aihot || '',
      }))
      .filter((f) => f.title),
  };
}

/**
 * 抓最新一期日报。
 * 与热点榜同一条底线：抓到才替换，抓不到就留着上一期并说明原因。
 *
 * 一个例外：**404 不算失败**。它表示"当天这一期还没出"（出刊时间是每天
 * 08:00），是正常状态。所以不能像别的坏法那样记进 lastError —— 否则每轮
 * 抓取都会往界面上写一句"日报抓取失败：HTTP 404"，而它其实什么都没坏。
 */
export async function refreshNewsDaily() {
  const errors = [];
  let daily = null;
  let notModified = false;
  let notPublished = false;

  try {
    const headers = { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, br' };
    if (etag) headers['If-None-Match'] = etag;

    const res = await fetch(`${API_BASE}/dailies/latest`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
    });

    if (res.status === 304) {
      notModified = true;
    } else if (res.status === 404) {
      notPublished = true;
    } else if (!res.ok) {
      throw new Error(res.status === 429 || res.status === 503 ? rateLimitMessage(res) : `HTTP ${res.status}`);
    } else {
      const tag = res.headers.get('etag');
      if (tag) etag = tag;
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(/^\s*</.test(text) ? '该地址返回的是网页，不是 API 响应' : '返回内容不是 JSON');
      }
      daily = toLocalDaily(body);
      if (!daily) throw new Error('响应里没有可用的日报');
    }
  } catch (err) {
    errors.push(`日报: ${err.message}`);
  }

  const fetchedAt = new Date().toISOString();
  let snapshot = null;
  update((data) => {
    data.news.daily = data.news.daily || { updatedAt: null, lastError: null, report: null };
    if (notModified) {
      data.news.daily.updatedAt = fetchedAt;
      data.news.daily.lastError = null;
    } else if (daily) {
      data.news.daily = { updatedAt: fetchedAt, lastError: null, report: daily };
    } else if (notPublished) {
      /* 今天还没出刊：**不动 updatedAt**（它不是一次成功同步），也不写 lastError。
         顺手清掉上一次的失败原因是对的 —— 能明确回 404 说明对端是好的。
         保留上一期，界面上那句"可能已过期"由 updatedAt 变旧自然触发。 */
      data.news.daily.lastError = null;
    } else {
      data.news.daily.lastError = errors.join('；') || '未获取到日报';
    }
    snapshot = data.news.daily;
  });

  return {
    ok: Boolean(daily) || notModified,
    date: snapshot?.report?.date ?? null,
    notModified,
    /** true = 当天那一期还没发布（404），既不是失败也不是成功同步 */
    notPublished,
    errors,
    updatedAt: snapshot?.updatedAt || null,
  };
}
