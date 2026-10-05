import { update } from '../store.js';

/* ── 全站 token 计量 ───────────────────────────────────────────────────
   每次调用大模型都记一笔：总量、按天、按用途。

   为什么按天：总量只增不减，看久了没有信息量；"今天用了多少"才是能拿来
   判断"该不该收着点"的数。

   为什么按用途：这个端点单次调用的 prompt 就有约 15000 tokens —— Hermes
   agent 自带一大套脚手架，跟问题长短几乎无关。也就是说花销基本由"调用
   多少次"决定，不分用途就看不出钱花在哪。

   数字来自上游返回的 usage，**不是估算**：实测该端点流式与非流式都会给
   （所以不必加 stream_options —— 少一个可能被对方拒绝的参数）。
   拿不到时不编一个数出来，宁可这一笔不记。

   状态放在 data.aiUsage 里（跟热点、日报那些一样由 store 统一落库），
   所以重启不清零。 */

/** 保留多少天的日粒度。再往前的没有参考价值，留着只是让落库的 JSON 一直长 */
const MAX_DAYS = 60;

/** 快照里带多少天的日序列。14 天够看出"哪几天在猛用"，又不至于把长尾都传过去 */
const SERIES_DAYS = 14;

/** 用途 → 显示名。界面要用，所以不能只留内部键 */
export const SOURCE_LABELS = {
  assistant: '工作台助手',
  article: '文章助手',
  news: 'AI 读',
  other: '其它',
};

const zero = () => ({ prompt: 0, completion: 0, calls: 0 });

export const emptyUsage = () => ({ total: zero(), days: {}, sources: {} });

/** 本地时区的 YYYY-MM-DD，offset 是相对今天的天数偏移。
 *  用 UTC 的话，晚上 8 点之后的用量会被记到第二天。 */
function dayKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const bump = (bucket, prompt, completion) => {
  bucket.prompt += prompt;
  bucket.completion += completion;
  bucket.calls += 1;
  return bucket;
};

/** 记一笔用量。上游没给 usage 时直接返回，不估一个数来充 */
export function recordUsage(source, usage) {
  const prompt = Math.max(0, Math.round(Number(usage?.prompt_tokens) || 0));
  const completion = Math.max(0, Math.round(Number(usage?.completion_tokens) || 0));
  if (!prompt && !completion) return;

  const key = SOURCE_LABELS[source] ? source : 'other';
  const day = dayKey();

  update((data) => {
    /* 老库、导入的旧备份里没有这个字段，第一次写时才建起来。
       逐层兜底而不是整体替换：它是累加量，任何一次"重置成零"都等于把历史抹了。 */
    const u = data.aiUsage && typeof data.aiUsage === 'object' ? data.aiUsage : (data.aiUsage = emptyUsage());
    u.total = u.total || zero();
    u.days = u.days || {};
    u.sources = u.sources || {};

    bump(u.total, prompt, completion);
    bump((u.days[day] = u.days[day] || zero()), prompt, completion);
    bump((u.sources[key] = u.sources[key] || zero()), prompt, completion);
    /* 落库要靠它判断"这份数据变了"（指纹里带时间），没有它就得每轮都写一遍 */
    u.updatedAt = new Date().toISOString();

    const keys = Object.keys(u.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DAYS))) delete u.days[k];
  });
}

/** 给接口用的快照。today / yesterday 由服务端算好，前端不必自己推日期 ——
 *  它算出来的日子和这里的日桶未必是同一个（跨零点、时区差），而"较昨日"
 *  算错的症状是数字看着莫名其妙。 */
export function usageSnapshot(data) {
  const u = data?.aiUsage && typeof data.aiUsage === 'object' ? data.aiUsage : emptyUsage();
  return {
    total: u.total || zero(),
    today: u.days?.[dayKey()] || zero(),
    yesterday: u.days?.[dayKey(-1)] || zero(),
    sources: u.sources || {},
    days: u.days || {},
    /* 最近 14 天，按日期升序、缺的天补零，直接可以拿去画柱子。
       日期一律在服务端算 —— 客户端自己推的话，跨零点和时区差会让柱子和
       日桶错位，而错位的症状是"明明记得昨天用过，图上却是空的"。 */
    series: Array.from({ length: SERIES_DAYS }, (_, i) => {
      const key = dayKey(i - (SERIES_DAYS - 1));
      const v = u.days?.[key];
      return { key, prompt: v?.prompt || 0, completion: v?.completion || 0, calls: v?.calls || 0 };
    }),
    labels: SOURCE_LABELS,
  };
}
