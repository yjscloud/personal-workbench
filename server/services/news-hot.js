import { update } from '../store.js';

/* ── AIHOT：多源热点榜 + 事件故事线 ───────────────────────────────────
   这一块和 news.js（条目流）是两个不同的东西，别混着看：

   · /api/v1/items       是一**条条**资讯，回答"最近有什么"；
   · /api/v1/hot-topics  是一个**事件**榜，回答"现在哪些事最热" ——
     它按"多少家报道了 / 多少条信号"排 Top 10，是条目流给不了的视角；
   · /api/v1/stories/…   是**一个事件**的来龙去脉：跨源报道时间线 + 随事件
     演进增量重写的 AI 综述（还标注与早期报道矛盾之处）。

   榜单和故事线一起存成一份快照（news.hot），原因是它们是**同一时刻的一张榜**，
   混着按条目那样增量管理反而对不上：榜的位次会变，故事会被合并。
   每次抓取整份替换，成本也就十来个请求。

   两条官方规则照做了：
   1. links.story 是给人看的 HTML 地址（而且目前还带着旧域名），**只取末段
      publicId**再拼 API；文档明确说不要自行构造 story id，也不要拿它当 API 请求。
   2. 请求之间留间隔：故事线是逐个取的，十个连发会撞上限流。 */

const API_BASE = 'https://aihot.news/api/v1';
const UA = 'PersonalWorkbench/1.0 (self-hosted; +local)';
const TIMEOUT_MS = 15000;
/* 故事线逐个取，中间停一下。榜单每次 10 条，1 秒间隔一整趟也就 10 秒出头 */
const STORY_PAUSE_MS = 1000;
const MAX_STORIES = 10;

/* 两个接口各有各的 ETag，分开记。同样只放内存：重启丢掉最多多传一次。 */
const etag = { hot: null };

function headersWithEtag(tag) {
  const h = {
    'User-Agent': UA,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, br',
  };
  if (tag) h['If-None-Match'] = tag;
  return h;
}

function rateLimitMessage(res) {
  const raw = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(raw) && raw > 0 ? `，需等待约 ${Math.ceil(raw)} 秒` : '';
  return `被限流（HTTP ${res.status}）${wait}后由下一次定时抓取重试`;
}

async function getJson(path, { ifNoneMatch = null, followRedirect = true } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    redirect: followRedirect ? 'follow' : 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: headersWithEtag(ifNoneMatch),
  });

  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(res.status === 429 || res.status === 503 ? rateLimitMessage(res) : `HTTP ${res.status}`);

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(/^\s*</.test(text) ? '该地址返回的是网页，不是 API 响应' : '返回内容不是 JSON');
  }
  return { body, etag: res.headers.get('etag') };
}

/** links.story 形如 https://<host>/story/<uuid> —— 只要末段。
    拿不到就返回 null，绝不猜、不构造。 */
function publicIdFrom(storyUrl) {
  try {
    const seg = String(storyUrl || '').split('/').filter(Boolean).pop();
    /* 只接受看起来像 id 的串（UUID 或短 id），避免把别的路径段当 id 用 */
    return seg && /^[a-z0-9][a-z0-9-]{7,}$/i.test(seg) ? seg : null;
  } catch {
    return null;
  }
}

function cleanSourceName(name) {
  const cleaned = String(name || '')
    .replace(/[（(]\s*(?:RSS|Atom|网页|Web|Blog)\s*[)）]\s*$/i, '')
    .trim();
  return cleaned || 'AIHOT';
}

function strip(input = '') {
  return String(input).replace(/\s+/g, ' ').trim();
}

/** 榜单条目 → 本地结构。story 字段留空，等抓到故事线再填 */
function toLocalTopic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = strip(raw.title || '');
  if (!title) return null;

  return {
    publicId: publicIdFrom(raw.links?.story),
    rank: Number.isFinite(raw.rank) ? raw.rank : 0,
    title,
    link: raw.links?.original || raw.links?.aihot || '',
    /* 人类可读的 AIHOT 页面。注意它可能是旧域名，但这是给用户"跳过去看"的链接，
       原样保留比自作主张改写域名更诚实 —— 我们只保证不拿它当 API 请求 */
    storyUrl: raw.links?.story || null,
    sourceCount: Number.isFinite(raw.sourceCount) ? raw.sourceCount : 0,
    signalCount: Number.isFinite(raw.signalCount) ? raw.signalCount : 0,
    sourceNames: (Array.isArray(raw.sourceNames) ? raw.sourceNames : []).map(cleanSourceName),
    latestAt: raw.latestAt ? new Date(raw.latestAt).toISOString() : null,
    story: null,
  };
}

/** 邻居事件（同一故事线 / 相关事件）。只留标题、关系和"跳过去看"的链接 */
function toNeighbor(raw) {
  if (!raw || typeof raw !== 'object' || !raw.title) return null;
  return {
    publicId: raw.publicId ?? null,
    title: strip(raw.title),
    relation: strip(raw.relation || ''),
    link: raw.links?.aihot || null,
  };
}

/** 故事线 → 本地结构。只留界面用得到的：综述 + 报道时间线 */
function toLocalStory(raw) {
  const s = raw?.story || (raw?.publicId ? raw : null);
  if (!s || typeof s !== 'object') return null;

  const reports = (Array.isArray(s.reports) ? s.reports : [])
    .map((r) => ({
      title: strip(r.title || ''),
      summary: strip(r.summary || '').slice(0, 300),
      source: cleanSourceName(r.source?.name),
      publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
      link: r.links?.original || r.links?.aihot || '',
    }))
    .filter((r) => r.title)
    /* 时间线倒序（接口本来就是倒序，这里再排一次是防止某天顺序变了） */
    .sort((a, b) => (a.publishedAt && b.publishedAt ? (b.publishedAt > a.publishedAt ? 1 : -1) : 0));

  return {
    publicId: s.publicId ?? null,
    status: s.status === 'settled' ? 'settled' : 'active',
    sourceCount: Number.isFinite(s.sourceCount) ? s.sourceCount : 0,
    reportCount: Number.isFinite(s.reportCount) ? s.reportCount : reports.length,
    firstReportAt: s.firstReportAt ? new Date(s.firstReportAt).toISOString() : null,
    latestAt: s.latestAt ? new Date(s.latestAt).toISOString() : null,
    latest: strip(s.latest || ''),
    digest: strip(s.digest || '') || null,
    digestUpdatedAt: s.digestUpdatedAt ? new Date(s.digestUpdatedAt).toISOString() : null,
    reports,
    /* 同故事线 / 相关事件。接口常常给空数组（事件还没被串起来），
       但一旦有，弹窗就能从"一个事件的综述"变成"这条线索的前后文"。 */
    storyline: (Array.isArray(s.storyline) ? s.storyline : []).map(toNeighbor).filter(Boolean),
    related: (Array.isArray(s.related) ? s.related : []).map(toNeighbor).filter(Boolean),
  };
}

/**
 * 抓「多源热点榜」以及榜上每条事件的故事线。
 *
 * 与条目流同一条底线：抓到了才替换，抓不到就保留上一份（并说明原因）。
 * 但这里还有一层：**榜单失败不影响故事线，某条故事线失败不影响其它几条** ——
 * 十个事件里有一个 404（事件被合并/下线）是很常见的事，不该因此整份丢掉。
 */
export async function refreshNewsHot() {
  const errors = [];

  let topics = [];
  let notModified = false;
  try {
    const res = await getJson('/hot-topics', { ifNoneMatch: etag.hot });
    if (res.notModified) {
      notModified = true;
    } else {
      if (res.etag) etag.hot = res.etag;
      const list = Array.isArray(res.body?.items) ? res.body.items : [];
      for (const raw of list) {
        const topic = toLocalTopic(raw);
        if (topic) topics.push(topic);
      }
      /* 接口说榜是 Top 10 且常常正好 10 条；排一次只是保证本地顺序与 rank 一致 */
      topics.sort((a, b) => a.rank - b.rank);
    }
  } catch (err) {
    errors.push(`热点榜: ${err.message}`);
  }

  /* 304 时连故事线也不用再问：整份快照没变 */
  if (!notModified && topics.length) {
    const targets = topics.filter((t) => t.publicId).slice(0, MAX_STORIES);
    for (const topic of targets) {
      try {
        const res = await getJson(`/stories/${encodeURIComponent(topic.publicId)}`);
        if (!res.notModified) topic.story = toLocalStory(res.body);
      } catch (err) {
        /* 单个事件拿不到（404 = 已合并或下线）只记一笔，不连坐其它事件 */
        errors.push(`事件「${topic.title.slice(0, 16)}」: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, STORY_PAUSE_MS));
    }
  }

  const fetchedAt = new Date().toISOString();
  let snapshot = null;
  update((data) => {
    data.news.hot = data.news.hot || { updatedAt: null, topics: [], lastError: null };
    if (notModified) {
      data.news.hot.updatedAt = fetchedAt;
      data.news.hot.lastError = null;
    } else if (topics.length) {
      data.news.hot = { updatedAt: fetchedAt, topics, lastError: errors.length ? errors.join('；') : null };
    } else {
      data.news.hot.lastError = errors.length ? errors.join('；') : '未获取到热点榜';
    }
    snapshot = data.news.hot;
  });

  return {
    ok: topics.length > 0 || notModified,
    count: topics.length,
    withStory: snapshot?.topics?.filter((t) => t.story)?.length ?? 0,
    notModified,
    errors,
    updatedAt: snapshot?.updatedAt || null,
  };
}
