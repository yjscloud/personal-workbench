import { db, flush } from '../store.js';

/* ────────────────────────────────────────────────────────────────────────
 * 数据留存
 *
 *   逐日明细（每日电量/电费、插座累计读数快照）  保留 3 个自然月
 *   月度电费归档                                保留 12 个月
 *   AI 热点条目                                 保留 7 天
 *
 * 关键在于「删之前先归档」。直接按日期把 energy_daily 删掉，每个月的电费
 * 就永久没了 —— 而"每个月花了多少电费"恰恰是回头翻时最有用的一条线。
 * 所以先把要删的天滚成一行月汇总，再删明细；两级各自过期、互不影响。
 *
 * 用自然月而不是 90 天：月度归档本身就是按月存的，用天数切会出现
 * "某个整月里只留了半个月"这种和汇总对不上的状态。
 *
 * 热点是另一套逻辑：它不需要归档，过期的内容只该消失（见文件末尾）。
 *
 * 两个模块都遵守同一件事 —— **必须改内存镜像再落库**。
 * news_items 是"整表按内存重写"的列表表，绕过 store 直接 SQL DELETE，
 * 下一次任何写操作落库时就会被内存里的旧数组原样写回来。
 * ──────────────────────────────────────────────────────────────────────── */

/** 逐日明细保留的完整自然月数（不含当前月） */
export const DAILY_KEEP_MONTHS = 3;
/** 月度归档保留的自然月数（含当前月） */
export const MONTHLY_KEEP_MONTHS = 12;

const pad2 = (n) => String(n).padStart(2, '0');
const monthKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const dayKeyOf = (d) => `${monthKeyOf(d)}-${pad2(d.getDate())}`;

/**
 * 两条清理边界。
 * 日期键是零填充的 YYYY-MM-DD / YYYY-MM，所以字符串比较就等于日期比较，
 * 不用去 parse 成 Date —— 还顺手避开了时区。
 */
export function retentionCutoffs(now = new Date()) {
  const dailyFrom = new Date(now.getFullYear(), now.getMonth() - DAILY_KEEP_MONTHS, 1);
  const monthlyFrom = new Date(now.getFullYear(), now.getMonth() - (MONTHLY_KEEP_MONTHS - 1), 1);
  return {
    dailyFromKey: dayKeyOf(dailyFrom),
    monthlyFromKey: monthKeyOf(monthlyFrom),
    dailyKeepMonths: DAILY_KEEP_MONTHS,
    monthlyKeepMonths: MONTHLY_KEEP_MONTHS,
  };
}

/**
 * 就地清理一份 energy 数据（纯函数式操作传入的对象，便于单测）。
 * 返回摘要，调用方拿去落日志。
 */
export function runRetention(data, now = new Date()) {
  const e = (data.energy ||= {});
  e.daily ||= {};
  e.meterDaily ||= {};
  e.monthly ||= {};

  const { dailyFromKey, monthlyFromKey } = retentionCutoffs(now);
  const summary = {
    dailyFromKey,
    monthlyFromKey,
    archivedDays: 0,
    archivedMonths: [],
    purgedMeterDays: 0,
    purgedMonths: [],
  };

  // 1. 过期的日明细：先汇总进月归档，再删
  for (const day of Object.keys(e.daily)) {
    if (day >= dailyFromKey) continue;
    const v = e.daily[day] || {};
    const m = day.slice(0, 7);
    const slot = (e.monthly[m] ||= { kwh: 0, cost: 0, ecoKwh: 0, days: 0 });
    slot.kwh += Number(v.kwh) || 0;
    slot.cost += Number(v.cost) || 0;
    slot.ecoKwh += Number(v.ecoKwh) || 0;
    slot.days += 1;
    if (!summary.archivedMonths.includes(m)) summary.archivedMonths.push(m);
    delete e.daily[day];
    summary.archivedDays += 1;
  }

  /* meter_daily 只删不归档：它是"插座累计读数的当日首末快照"，
     存在的意义只是推导当日用量，跨月存一个汇总值没有意义。
     真正需要的月度电费已经在 energy_monthly 里了。 */
  for (const day of Object.keys(e.meterDaily)) {
    if (day >= dailyFromKey) continue;
    delete e.meterDaily[day];
    summary.purgedMeterDays += 1;
  }

  // 2. 过期的月归档
  for (const m of Object.keys(e.monthly)) {
    if (m >= monthlyFromKey) continue;
    delete e.monthly[m];
    summary.purgedMonths.push(m);
  }

  summary.keptDays = Object.keys(e.daily).length;
  summary.keptMonths = Object.keys(e.monthly).length;
  return summary;
}

const signatureOf = (energy) =>
  JSON.stringify([energy?.daily, energy?.meterDaily, energy?.monthly]);

/**
 * 对外入口：跑一次清理并落库。
 *
 * 直接调 flush() 就行 —— 它内部只写真正变化的表，不会因为这次调用
 * 把别的表也重写一遍。没东西可删时干脆不碰数据库。
 */
export async function purgeOldMonitoringData(now = new Date()) {
  const energy = db().energy;
  const before = signatureOf(energy);
  const summary = runRetention(db(), now);
  const changed = before !== signatureOf(db().energy);

  if (changed) await flush();
  return { ...summary, changed };
}

/* ── AI 热点留存 ─────────────────────────────────────────────────────
 * 「热点」的价值全在时效上：一周前的条目不会有人翻，留着只是占库。
 * 保留窗口是固定的业务规则，不做成设置项 —— 和上面的监控留存同一个
 * 理由：改这里比改配置更不容易出事。
 *
 * 这道清理正常情况下是**兜底**：抓取是整份替换 items（见 services/news.js），
 * 成功一次库里就只剩那一批，本来就不会堆积。真正会删到东西的是另一种情况
 * —— 源连续失败、news.items 一直没被换掉，那些条目会无限期留在库里。
 * 所以这里按 publishedAt 切，而不是按"第几次抓取"。 */

/** 热点保留天数 */
export const NEWS_KEEP_DAYS = 7;

const DAY_MS = 86400 * 1000;

/**
 * 就地清掉过期的热点条目（纯函数式操作传入的对象，便于单测）。
 * 返回摘要，调用方拿去落日志。
 */
export function runNewsRetention(data, now = new Date()) {
  const news = (data.news ||= { items: [] });
  const items = Array.isArray(news.items) ? news.items : [];
  const cutoffMs = now.getTime() - NEWS_KEEP_DAYS * DAY_MS;

  const kept = items.filter((it) => {
    /* 先用真值判断挡一道，再解析：new Date(null) 得到的不是 Invalid Date，
       而是 1970-01-01（时间戳 0）—— 少了这一步，publishedAt 为 null 的条目
       会被当成"五十多年前"，当作过期内容误删掉。
       空值 / 读不出来的时间一律留着：宁可多留一条，
       也不要因为一个脏时间戳就把内容删掉。 */
    const t = it.publishedAt ? new Date(it.publishedAt).getTime() : NaN;
    return !Number.isFinite(t) || t >= cutoffMs;
  });

  news.items = kept;
  return {
    keepDays: NEWS_KEEP_DAYS,
    cutoff: new Date(cutoffMs).toISOString(),
    purged: items.length - kept.length,
    kept: kept.length,
  };
}

/**
 * 对外入口：跑一次热点清理并落库。
 * 同样只在真的删了东西时才落库 —— 没东西可删就不碰数据库。
 */
export async function purgeOldNews(now = new Date()) {
  const before = db().news?.items?.length ?? 0;
  const summary = runNewsRetention(db(), now);
  const changed = (db().news?.items?.length ?? 0) !== before;

  if (changed) await flush();
  return { ...summary, changed };
}

/* ── 知识库回收站 ─────────────────────────────────────────────────────
 *
 * 删掉的文章在回收站里留 7 天，到期永久删除（路由见 routes.js 的
 * `/knowledge/:id/trash`）。删除本身是软删除，所以「误删」不是终局 ——
 * 这条清理才是唯一真正会丢内容的地方，因此它比别的清理更保守：
 *
 * · 按 `deletedAt` 切，而**时间读不出来的一律留着**。和热点同一条理由：
 *   宁可多占几行，也不要因为一个脏时间戳把别人的文章永久删掉。
 * · 只碰回收站里的条目，没删过的（deletedAt 为空）连判断都不参与。
 *
 * 7 天是固定的业务规则，不做成设置项 —— 和监控留存、热点留存同一个理由：
 * 这是「删错了还救得回来」的兜底时长，改代码比改配置更不容易出事。
 * 前端那句「保留 7 天」的文案取自这里，见 GET /settings 的 knowledgeTrashKeepDays。
 */
export const KNOWLEDGE_TRASH_KEEP_DAYS = 7;

/** 就地清掉回收站里过期的条目（纯函数式操作传入的对象，便于单测） */
export function runKnowledgeTrashPurge(data, now = new Date()) {
  const items = Array.isArray(data.knowledge) ? data.knowledge : [];
  const cutoffMs = now.getTime() - KNOWLEDGE_TRASH_KEEP_DAYS * DAY_MS;

  const kept = items.filter((k) => {
    if (!k.deletedAt) return true;
    const t = new Date(k.deletedAt).getTime();
    return !Number.isFinite(t) || t >= cutoffMs;
  });
  data.knowledge = kept;

  return {
    keepDays: KNOWLEDGE_TRASH_KEEP_DAYS,
    cutoff: new Date(cutoffMs).toISOString(),
    purged: items.length - kept.length,
    keptInTrash: kept.filter((k) => k.deletedAt).length,
  };
}

/** 对外入口：跑一次回收站清理并落库。没删到东西就不碰数据库 */
export async function purgeOldKnowledge(now = new Date()) {
  const before = db().knowledge?.length ?? 0;
  const summary = runKnowledgeTrashPurge(db(), now);
  const changed = (db().knowledge?.length ?? 0) !== before;

  if (changed) await flush();
  return { ...summary, changed };
}
