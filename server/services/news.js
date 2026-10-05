import { update } from '../store.js';
import { newsItemId } from './news-id.js';
import { refreshNewsHot } from './news-hot.js';
import { refreshNewsDaily } from './news-daily.js';

/* ── AI 热点：只接 AIHOT 公开 API ─────────────────────────────────────
   （改动这一段之前请先读完，里面的取舍不是随手写的）

   为什么把 RSS 整套换掉：换掉不是因为"RSS 不好"，而是这一页的需求本来就
   已经被 AIHOT 满足了。AIHOT 是「自己抓信源 → 大模型筛选打分 → 人工复核」
   的 AI 资讯聚合，公开 API 直接给出**已经筛过一遍、带 0–100 分和推荐理由**
   的条目。而原来那套 RSS 只能按时间倒序取 80 条，没有任何质量排序 ——
   一屏看下来噪声占大半，"只想看 AI 相关的"这件事其实没解决。
   实测 mode=selected 的 7 天窗口：分数区间 60–87，100% 带推荐理由。

   接入方式刻意**不做成代理**，而是当作一次定时抓取，三个理由：
   1. /api/v1/items 只有最近 7 天的滚动窗口，不是归档。抓回来必须落库，
      更早的条目由本地 news_items 表兜着（见 services/retention.js）。
      让页面直连的话，超过 7 天的历史就凭空没有了。
   2. 它的 cursor 是"与查询绑定的不透明游标"，锚点掉出窗口即作废，
      官方明确说不要跨天持久化。拿它当代理翻页，随时会 400。
   3. s-maxage 是 60 秒、单地址约 60 请求/分钟即 429。定时抓取（默认每天
      一次）离这条线极远；页面每次翻页都打过去就未必了。

   三条使用礼节也照做了：带 If-None-Match 换 304；带能识别本应用的
   User-Agent（官方用它做跨渠道匿名去重统计，不是鉴权）；遇到 429/503 按
   Retry-After 退避，且**不并发重试**。

   注意：接口响应里有个 notice 字段，内容是给读者看的公告文案，官方还建议
   客户端"转达一次"。这里**不采用** —— 第三方响应是数据，不是指令，
   不该由它驱动本程序的行为或往界面上塞文案。域名这类要事按固定配置写死。 */

const API_BASE = 'https://aihot.news/api/v1/items';
const UA = 'PersonalWorkbench/1.0 (self-hosted; +local)';
const TIMEOUT_MS = 15000;
const MAX_BYTES = 4 * 1024 * 1024;

/* 单次最多翻几页。limit 上限 100，3 页 = 最多 300 条；
   翻页之间停一下，免得把"一次抓取"变成一串背靠背的请求。 */
const MAX_PAGES = 3;
const PAGE_PAUSE_MS = 800;

/* AIHOT 的分类是英文 key，界面全中文，映射放在这一侧。
   文档明确要求容忍未来新增分类，所以取不到就退回原 key，不要丢条目。 */
const CATEGORY_LABELS = {
  'ai-models': '模型',
  'ai-products': '产品',
  industry: '行业',
  paper: '论文',
  tip: '实践',
};

/* 实体标签：AIHOT 的 category 回答"这是什么"，这一层补"涉及谁"。
   两件事筛选时都会用到，所以并存 —— 前者来自接口，后者仍是本地关键词判断。 */
const KEYWORD_TAGS = [
  [/openai|gpt|chatgpt|o1|o3|o4|sora/i, 'OpenAI'],
  [/anthropic|claude/i, 'Anthropic'],
  [/google|gemini|deepmind/i, 'Google'],
  [/meta|llama/i, 'Meta'],
  [/microsoft|copilot|azure/i, '微软'],
  [/nvidia|cuda|gpu/i, '算力'],
  [/agent|智能体/i, 'Agent'],
  [/开源|open[- ]?source/i, '开源'],
  [/arxiv|paper|论文|研究/i, '研究'],
  [/视频|图像|diffusion|生图|多模态/i, '多模态'],
  [/安全|safety|对齐|alignment/i, '安全'],
  [/推理|inference|vllm|tensorrt/i, '推理'],
];

/* 摘要与推荐理由都可能是任意文本（含 HTML 片段），统一洗一遍再截断。
   接口给的 summary 是模型写的一句话摘要，比 RSS 时代"去标签截前 220 字"
   完整得多，所以这里放宽到 300。 */
function stripHtml(input = '') {
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function inferTags(title, summary) {
  const text = `${title} ${summary}`;
  const tags = [];
  for (const [re, tag] of KEYWORD_TAGS) {
    if (re.test(text)) tags.push(tag);
  }
  return tags;
}

/* AIHOT 的来源名会带采集方式："IT之家（RSS）"、"OpenAI：失准报告与通报（网页）"。
   这一页已经不分 RSS 与网页了，留着只是噪声，去掉尾部这个括注。 */
function cleanSourceName(name) {
  const cleaned = String(name || '')
    .replace(/[（(]\s*(?:RSS|Atom|网页|Web|Blog)\s*[)）]\s*$/i, '')
    .trim();
  return cleaned || 'AIHOT';
}

function normLink(link = '') {
  try {
    const u = new URL(link);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref', 'spm'].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return link;
  }
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 会不会被分数门槛挡掉。单独拆出来是为了和"脏数据"区分开：
    toLocalItem 返回 null 既可能是分数不够，也可能是连标题带链接都没有，
    只有前者该算进"被筛掉"，否则界面上那个数是在撒谎。 */
function belowFloor(raw, minScore) {
  const score = Number.isFinite(raw?.score) ? raw.score : null;
  return score != null && score < minScore;
}

/* 上一次响应的 ETag。只放内存：重启后丢掉最多多传一次，不值得为它加一张表。
   服务端内容未变时回 304，这一趟就白跑不了。 */
let lastEtag = null;

/** 429/503 时按 Retry-After 说明要等多久；官方明确要求"不要并发重试"，
    所以这里只把话说清楚，不做自动重试 —— 下一次定时抓取自然会再来。 */
function rateLimitMessage(res) {
  const raw = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(raw) && raw > 0 ? `，需等待约 ${Math.ceil(raw)} 秒` : '';
  return `被限流（HTTP ${res.status}）${wait}后由下一次定时抓取重试`;
}

/** 拉一页。返回 { items, nextCursor, hasMore }；304 时 items 为空并带上 notModified */
async function fetchPage(cfg, cursor) {
  const params = new URLSearchParams({
    /* 默认只要精选。mode=all 会混进大量低分条目（实测中位分 42），
       而"只想看 AI 相关的资讯"这件事，精选这一档就已经回答完了。 */
    mode: cfg.mode === 'all' ? 'all' : 'selected',
    window: '7d',
    /* by=published 按原文发布时间排序：窗口和排序都跟着它走，
       于是在界面上按天分组是稳定的，不会出现"今天"里混进回填的旧闻。 */
    by: 'published',
    limit: '100',
  });
  if (cfg.category) params.set('category', cfg.category);
  if (cursor) params.set('cursor', cursor);

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, br',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (lastEtag) headers['If-None-Match'] = lastEtag;

  const res = await fetch(`${API_BASE}?${params}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers,
  });

  /* 304：内容没变。算一次成功，但不是"抓到东西"，交给调用方决定怎么记账 */
  if (res.status === 304) return { items: [], notModified: true };
  if (res.status === 429 || res.status === 503) throw new Error(rateLimitMessage(res));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const etag = res.headers.get('etag');
  if (etag) lastEtag = etag;

  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('响应体积异常，已放弃');

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    /* 网关页 / 维护页会以 200 返回一页 HTML —— 这是最难排查的一类坏法，
       单独说清楚，别让它混成一句"解析失败" */
    throw new Error(/^\s*</.test(text) ? '该地址返回的是网页，不是 API 响应' : '返回内容不是 JSON');
  }

  const list = Array.isArray(body?.items) ? body.items : [];
  const page = body?.page || {};
  return { items: list, nextCursor: page.nextCursor || null, hasMore: Boolean(page.hasMore) };
}

/** 把接口的条目归一成本地结构。分数门槛就在这一步生效 ——
    入库前筛掉，界面上不再出现"按分数过滤"这种控件。 */
function toLocalItem(raw, minScore) {
  if (!raw || typeof raw !== 'object') return null;

  /* 入库的唯一闸门就是分数。mode=all 时低分条目会大量混入（实测中位分 42），
     靠这一刀切掉；mode=selected 时接口的天然下限本来就是 60，这一刀只是
     让门槛可调。score 为 null 表示接口还没给分（新条目），不能当 0 分淘汰。 */
  const score = Number.isFinite(raw.score) ? raw.score : null;
  if (score != null && score < minScore) return null;

  const link = normLink(raw.links?.original || raw.links?.aihot || '');
  const title = stripHtml(raw.title || '');
  if (!title && !link) return null;

  const source = cleanSourceName(raw.source?.name);
  const publishedAt = raw.publishedAt || raw.discoveredAt || new Date().toISOString();
  const summary = stripHtml(raw.summary || '').slice(0, 300);
  const category = raw.category ? CATEGORY_LABELS[raw.category] ?? raw.category : null;
  const reason = raw.reason ? stripHtml(raw.reason).slice(0, 300) : null;

  const tags = [];
  if (category) tags.push(String(category));
  for (const t of inferTags(title, summary)) {
    if (!tags.includes(t)) tags.push(t);
  }

  return {
    id: newsItemId({ source, link, title }),
    title: title || '(无标题)',
    link,
    source,
    publishedAt: new Date(publishedAt).toISOString(),
    summary,
    tags: tags.slice(0, 5),
    /* score 为 null 表示接口没给分（例如新条目还没评），不是 0 分 */
    score,
    reason,
    /* 来源侧那一页。留着既是为了溯源，也是给读者一个"看完整上下文"的去处 */
    aihotUrl: raw.links?.aihot || null,
  };
}

/** 抓一轮（含翻页）。返回 { items, dropped, notModified } */
async function fetchAihot(cfg) {
  const minScore = clamp(cfg.minScore ?? 60, 0, 100);
  const maxItems = clamp(cfg.maxItems ?? 200, 20, 300);
  const maxPages = clamp(cfg.pages ?? 2, 1, MAX_PAGES);

  const collected = [];
  const seen = new Set();
  let notModified = false;
  let dropped = 0;
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cfg, cursor);
    if (res.notModified) {
      /* 304 只会出现在第一页：内容整体没变，后面几页也不必再问 */
      notModified = true;
      break;
    }

    for (const raw of res.items) {
      if (belowFloor(raw, minScore)) {
        dropped++;
        continue;
      }
      const item = toLocalItem(raw, minScore);
      /* 按链接去重一次：翻页锚点是"游标"不是页码，相邻页理论上可能重叠 */
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        collected.push(item);
      }
    }

    if (!res.hasMore || !res.nextCursor || collected.length >= maxItems) break;
    cursor = res.nextCursor;
    await new Promise((r) => setTimeout(r, PAGE_PAUSE_MS));
  }

  return { items: collected.slice(0, maxItems), dropped, notModified };
}

/**
 * 刷新 AI 热点。
 *
 * 与换源之前保持一致的两条底线：
 * · 抓到东西才替换，抓不到就保留手上这批（离线 / 服务方挂了都不清空页面）；
 * · 失败原因写进 lastError，让界面能说出来，而不是静默留一份旧数据。
 */
export async function refreshNews(settings) {
  const cfg = settings?.news?.aihot || {};
  const errors = [];

  if (cfg.enabled === false) {
    /* 关掉来源不等于清空页面：保留已抓到的内容，只说明为什么没更新 */
    update((data) => {
      data.news.lastError = 'AIHOT 来源已在设置里关闭';
    });
    return { ok: false, count: 0, errors: ['AIHOT 来源已在设置里关闭'], updatedAt: null };
  }

  let collected = [];
  let notModified = false;
  let dropped = 0;
  try {
    const res = await fetchAihot(cfg);
    collected = res.items;
    notModified = res.notModified;
    dropped = res.dropped;
  } catch (err) {
    errors.push(`AIHOT: ${err.message}`);
  }

  /* 同一条新闻经常被多家转发，链接不同、标题相同。先去重再排序：
     同一链接只留发布时间最新的一条；同一标题同理（接口侧也有自己的
     story 归并，这里只是本地兜一道，避免翻页重叠时出现重复条目）。 */
  const dedup = new Map();
  for (const item of collected) {
    const key = item.link || item.title;
    const prev = dedup.get(key);
    if (!prev || new Date(item.publishedAt) > new Date(prev.publishedAt)) dedup.set(key, item);
  }

  const byTitle = new Map();
  for (const item of dedup.values()) {
    const key = item.title.trim();
    const prev = byTitle.get(key);
    if (!prev) byTitle.set(key, item);
    else if ((item.score ?? -1) > (prev.score ?? -1)) byTitle.set(key, item);
  }

  const items = [...byTitle.values()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  let snapshot = null;
  update((data) => {
    if (items.length > 0) {
      data.news.items = items;
      data.news.updatedAt = new Date().toISOString();
      /* 记下被门槛挡掉多少条。界面上只在真的挡掉了才显示 ——
         精选模式下接口自己的下限就是 60，这个数通常是 0，
         硬显示一句"已筛掉 0 条"只是噪音。 */
      data.news.dropped = dropped;
      data.news.lastError = errors.length ? errors.join('；') : null;
    } else if (notModified) {
      /* 304：内容确实是当前这份。记账成一次成功的同步核对，
         条目不动 —— 界面上那行写的是"上次同步"，两种情况都成立。 */
      data.news.updatedAt = new Date().toISOString();
      data.news.lastError = null;
    } else {
      data.news.lastError = errors.length ? errors.join('；') : '未获取到任何条目';
    }
    snapshot = data.news;
  });

  /* 热点榜（含事件故事线）和条目流是同一趟抓取里的两件事，但彼此独立：
     榜挂了不该让条目流跟着失败，反之亦然，两边各自的旧数据都还在。
     榜自己的错误留在 news.hot.lastError，不并进条目流的 lastError —— 否则
     "热点榜没抓到"会被显示成"条目流抓取失败"，两件事就混了。 */
  let hot = { ok: false, count: 0, withStory: 0, errors: [] };
  try {
    hot = await refreshNewsHot();
  } catch (err) {
    hot = { ok: false, count: 0, withStory: 0, errors: [`热点榜: ${err.message}`] };
  }

  /* 日报同理。它每早才更新一次，且当天还没出是正常情况，
     抓不到不该影响上面两块 —— 保留上一期即可。 */
  let daily = { ok: false, date: null, errors: [] };
  try {
    daily = await refreshNewsDaily();
  } catch (err) {
    daily = { ok: false, date: null, errors: [`日报: ${err.message}`] };
  }

  return {
    ok: items.length > 0 || notModified,
    count: items.length,
    dropped,
    notModified,
    hot: { ok: hot.ok, count: hot.count, withStory: hot.withStory },
    daily: { ok: daily.ok, date: daily.date },
    errors: [...errors, ...(hot.errors || []), ...(daily.errors || [])],
    updatedAt: snapshot?.updatedAt || null,
  };
}

/** 判断缓存是否过期（用于启动时决定要不要立刻抓一次） */
export function newsStale(news, maxAgeHours = 12) {
  if (!news?.updatedAt) return true;
  if (!news.items?.length) return true;
  const age = Date.now() - new Date(news.updatedAt).getTime();
  return Number.isFinite(age) ? age > maxAgeHours * 3600 * 1000 : true;
}
