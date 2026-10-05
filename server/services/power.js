import { exec } from 'node:child_process';
import { update } from '../store.js';
import { pveConfig } from './pve.js';
import { GOVERNORS, setGovernor } from './cpu.js';
import { DAILY_KEEP_MONTHS, MONTHLY_KEEP_MONTHS } from './retention.js';

/**
 * 功耗模型
 * ────────────────────────────────────────────────────────────────
 * 说明：Proxmox 本身不提供整机功耗读数（除非主板/BMC 通过 sensors 暴露）。
 * 因此这里用「CPU 利用率 → 功耗」的工程估算模型：
 *   整机功耗 ≈ 基础功耗(芯片组/主板/网卡等 extraW)
 *            + 硬盘功耗(每块 perDiskW)
 *            + CPU 功耗(idleW ~ maxW 之间按利用率非线性插值)
 * 若有真实的 sensors 功耗读数，则优先采用真实值。
 * 参数可在「设置 → 功耗与电费」里按实测校准。
 */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function pickRealWatts(sensors) {
  const list = sensors?.power || [];
  if (!list.length) return null;
  // 取读数里最像「整机输入功率」的那个（PSU / Input / Total 优先）
  const preferred = list.find((p) => /psu|input|total|system/i.test(p.name)) || list[0];
  const v = Number(preferred?.value);
  return Number.isFinite(v) && v > 5 && v < 5000 ? v : null;
}

export function estimateWatts(status, sensors, settings) {
  const p = settings.power || {};
  const eco = Boolean(p.eco);
  const ecoFactor = Number(p.ecoFactor ?? 0.85);

  const real = pickRealWatts(sensors);
  if (real != null) {
    return { watts: real, cpuWatts: null, baseWatts: null, source: 'sensor' };
  }

  const ratio = clamp(Number(status?.cpu) || 0, 0, 1);
  const idleW = Number(p.idleW ?? 45);
  const maxW = Number(p.maxW ?? 190) * (eco ? ecoFactor : 1);
  const perDiskW = Number(p.perDiskW ?? 6);
  const extraW = Number(p.extraW ?? 28);

  const diskCount = Math.max(1, (status?.disks?.length ?? 2));
  const cpuWatts = idleW + Math.max(0, maxW - idleW) * Math.pow(ratio, 1.15);
  const baseWatts = diskCount * perDiskW + extraW;

  return {
    watts: cpuWatts + baseWatts,
    cpuWatts,
    baseWatts,
    ratio,
    idleW,
    maxW,
    diskCount,
    source: 'model',
  };
}

function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 在 yyyy-mm-dd 上做加减；用正午做基准，避开夏令时边界 */
function shiftDay(key, delta) {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return dateKey(d);
}

/** key 当天或之前最近一天的收盘读数 */
function lastOutAtOrBefore(meterDaily, key) {
  const days = Object.keys(meterDaily).filter((k) => k <= key).sort();
  if (!days.length) return null;
  return meterDaily[days[days.length - 1]]?.out ?? null;
}

/** 有记录的第一天的开盘读数，用作最早的基线 */
function earliestIn(meterDaily) {
  const days = Object.keys(meterDaily).sort();
  if (!days.length) return null;
  return meterDaily[days[0]]?.in ?? null;
}

/**
 * 用插座的累计读数推导一段窗口内的用量。
 *
 * 关键是"锚点"取哪天：锚点用收盘值而不是开盘值，这样即使工作台在
 * 凌晨那几个小时没被访问，夜间的耗电也会算进今天，而不是被吞掉。
 *
 * @param days null=今日；数字=向前滚动的天数
 */
function meterUsage(meterDaily, counter, days = null) {
  if (!Number.isFinite(counter)) return null;
  const today = dateKey();

  let anchor;
  if (days === null) {
    // 今日：优先用「昨天的收盘读数」，这样凌晨那几小时没被访问也不会漏算夜间耗电。
    // 但昨天没有记录时不能一路往前找——那会把前几天的用电算进"今日"，宁可少算。
    const yesterday = shiftDay(today, -1);
    anchor = meterDaily[yesterday]?.out ?? meterDaily[today]?.in ?? null;
  } else {
    anchor = lastOutAtOrBefore(meterDaily, shiftDay(today, -days));
    // 还没有那么久的历史时，退到有记录的第一天，并如实报告"自开始记录以来"
    if (anchor == null) anchor = earliestIn(meterDaily);
  }
  if (!Number.isFinite(anchor)) return null;

  const used = counter - anchor;
  // 计数器被设备重置（读数倒退）时，只能给出重置之后的用量
  return used >= 0 ? used : counter;
}

/**
 * 记录插座累计计数器的当日快照。
 * 用累计值而不是对瞬时功率做积分：服务停机期间设备照样在耗电，
 * 只有累计值能在恢复后把这段时间补回来。
 */
export function recordMeter(counterKwh) {
  if (!Number.isFinite(counterKwh)) return null;
  return update((data) => {
    const e = (data.energy ||= emptyEnergy());
    e.meterDaily ||= {};
    const key = dateKey();
    const day = (e.meterDaily[key] ||= { in: counterKwh, out: counterKwh });
    if (counterKwh < day.out) day.in = counterKwh; // 设备计数器被重置
    if (!Number.isFinite(day.in)) day.in = counterKwh;
    day.out = counterKwh;
  });
}

function emptyEnergy() {
  return { lastTs: null, lastWatts: 0, daily: {}, meterDaily: {}, totalKwh: 0, totalCost: 0, ecoSavedKwh: 0 };
}

/**
 * 采样累计：服务器每次被轮询时，按时间差把电量累加到当日
 */
export function accumulate(watts, settings, { eco, load } = {}) {
  const price = Number(settings.power?.pricePerKwh ?? 0.62);
  const now = Date.now();
  const key = dateKey();

  return update((data) => {
    const e = (data.energy ||= emptyEnergy());
    e.daily ||= {};
    e.daily[key] ||= { kwh: 0, cost: 0, ecoKwh: 0, samples: 0 };

    const prevTs = e.lastTs ? Number(e.lastTs) : null;
    let dtHours = 0;
    if (prevTs) {
      const dtSec = (now - prevTs) / 1000;
      // 只累计合理区间（20s ~ 30min），避免服务停机造成虚增
      if (dtSec >= 10 && dtSec <= 1800) dtHours = dtSec / 3600;
    }

    const kwh = (watts * dtHours) / 1000;
    const cost = kwh * price;

    e.daily[key].kwh += kwh;
    e.daily[key].cost += cost;
    e.daily[key].samples += 1;
    if (eco) {
      /* 这里存的是「节能模式下实际用了多少电」，不是「省了多少」。
         节省量留到出报表时按当下的实测系数反推（见 powerReport）——
         以前是把 kwh × 15% 当节省量直接累加，既用了写死的系数，
         又让存量数据永远锁死在当时的系数上，系数后来变准了也回不来。
         注意 eco_kwh 这一列语义变过：旧值含义是"节省量"，但量级只有亚 Wh
         （切换功能刚上线，节能模式没跑多久），沿用即可。 */
      e.daily[key].ecoKwh += kwh;
    }

    /* 运行模式实测对照：按时间累积进「模式 × 负载档」。
       kwh / hours 即该档的平均功率。存时长而不是样本计数——
       本函数被前端 5 秒轮询和服务端 60 秒采样器共用，
       按次数计权会让"页面开着"的时候权重被灌成 12:1。

       这里刻意不复用上面那个 dtHours：它有个 10 秒下限，而前端每 5 秒
       轮询一次会把共享的 lastTs 一直刷到 5 秒前，导致 10 秒下限永远不满足
       —— 监控页一开着，实测统计就完全停摆。时间加权的好处正是
       拆成多少个小区间都不影响总和，所以这里下限放到 1 秒。 */
    if (prevTs) {
      const dtSecMode = (now - prevTs) / 1000;
      if (dtSecMode >= 1 && dtSecMode <= 1800) {
        const dtH = dtSecMode / 3600;
        e.modeStats ||= {};
        const mode = eco ? 'eco' : 'standard';
        const band = loadBand(load);
        e.modeStats[mode] ||= {};
        const slot = (e.modeStats[mode][band] ||= { hours: 0, kwh: 0 });
        slot.hours += dtH;
        slot.kwh += (watts * dtH) / 1000;
      }
    }

    e.totalKwh = (e.totalKwh || 0) + kwh;
    e.totalCost = (e.totalCost || 0) + cost;
    e.lastTs = now;
    e.lastWatts = watts;
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * 节能效果实测
 *
 * 这个数以前写死在配置里（ecoFactor: 0.85），"累计节省"就是把节能期间的
 * 用电量乘 15% —— 也就是说你在节能模式下耗得越多，它声称你省得越多。
 * 现在改成从实测数据里算。
 *
 * 为什么必须分负载档：governor 对功耗的影响和负载强相关。performance
 * 空载也锁高频，差距最大；满载时两者都跑高频、几乎趋同。拿两段时间的
 * 平均功率直接相减，差值里混的是"那阵子在忙什么"。
 *
 * 为什么每个档要两侧都有足够时长：否则就成了拿"标准模式忙了 3 小时"
 * 去比"节能模式闲了 2 分钟"，出来的比例毫无意义。
 * ──────────────────────────────────────────────────────────────────────── */

export const MODE_BANDS = ['idle', 'light', 'mid', 'busy'];

/** 每个负载档两侧各需积累的时长下限，低于此不参与计算（单位：小时） */
const MIN_BAND_HOURS = 0.5;

export function loadBand(load) {
  const v = Number(load);
  if (load == null || !Number.isFinite(v)) return 'unknown';
  if (v < 0.05) return 'idle';
  if (v < 0.2) return 'light';
  if (v < 0.5) return 'mid';
  return 'busy';
}

function bandAvgWatts(stat) {
  if (!stat || !(stat.hours > 0)) return null;
  return (stat.kwh / stat.hours) * 1000;
}

/**
 * 算节能系数 = 节能模式平均功率 / 标准模式平均功率（< 1 表示节能确实更省）。
 * 数据不够返回 null —— 宁可让界面显示"测量中"，也不要给一个编出来的数。
 */
export function measureEcoFactor(modeStats) {
  const std = modeStats?.standard || {};
  const eco = modeStats?.eco || {};

  const bands = [];
  let weightSum = 0;
  let weightedRatio = 0;

  for (const band of MODE_BANDS) {
    const s = std[band];
    const e = eco[band];
    if (!s || !e) continue;
    if (!(s.hours >= MIN_BAND_HOURS) || !(e.hours >= MIN_BAND_HOURS)) continue;

    const sw = bandAvgWatts(s);
    const ew = bandAvgWatts(e);
    if (sw == null || ew == null || sw <= 0) continue;

    // 权重取两侧时长的较小值：某档只有一边数据多时，不该由它主导结论
    const w = Math.min(s.hours, e.hours);
    bands.push({
      band,
      standardWatts: round(sw, 2),
      ecoWatts: round(ew, 2),
      hours: round(w, 2),
      savedWatts: round(sw - ew, 2),
      ratio: round(ew / sw, 4),
    });
    weightedRatio += w * (ew / sw);
    weightSum += w;
  }

  // 各档已积累的时长：无论算不算得出比例都要给出去。
  // 否则界面只能显示一句"测量中"，用户不知道还要等多久。
  const evidence = MODE_BANDS.concat('unknown').map((band) => ({
    band,
    standardHours: round(std[band]?.hours || 0, 2),
    ecoHours: round(eco[band]?.hours || 0, 2),
  }));

  if (!bands.length || weightSum <= 0) {
    return { factor: null, savedPercent: null, bands: [], comparedHours: 0, minBandHours: MIN_BAND_HOURS, evidence };
  }

  const factor = weightedRatio / weightSum;
  return {
    factor: round(factor, 4),
    savedPercent: round((1 - factor) * 100, 1),
    bands,
    comparedHours: round(weightSum, 2),
    minBandHours: MIN_BAND_HOURS,
    evidence,
  };
}

export function powerReport({ status, sensors, settings, wattsInfo, energy, ha }) {
  const p = settings.power || {};
  const price = Number(p.pricePerKwh ?? 0.62);
  const currency = p.currency || 'CNY';
  const eco = Boolean(p.eco);

  const watts = wattsInfo.watts;
  const todayKey = dateKey();
  const e = energy || {};
  // 本地按瞬时功率积出来的当日值，只在插座读数不可用时兜底
  const sampled = e.daily?.[todayKey] || { kwh: 0, cost: 0, ecoKwh: 0, samples: 0 };

  /* 节能比例优先用实测（measureEcoFactor），样本不够才回退到手填的 ecoFactor。
     两个来源必须在界面上能区分开：一个是量出来的，一个是拍的。 */
  const manualFactor = Number(p.ecoFactor ?? 0.85);
  const measured = measureEcoFactor(e.modeStats);
  const ecoFactor = measured.factor ?? manualFactor;
  const ecoBasis = measured.factor != null ? 'measured' : 'manual';

  const standardWatts = eco ? watts / ecoFactor : watts;
  const savedWatts = Math.max(0, standardWatts - watts);

  /* 累计节省 = 节能模式下用掉的电 × (1/factor - 1)。
     在出报表时按当下的系数反推，不在累计时就乘死——
     否则系数后来变准了，历史数据也回不来。 */
  const ecoKwhTotal = Object.values(e.daily || {}).reduce((a, d) => a + (d?.ecoKwh || 0), 0);
  const savedKwhTotal = Math.max(0, ecoKwhTotal * (1 / ecoFactor - 1));

  /* ── 月度序列 ───────────────────────────────────────────────────────
     近期月份由日明细现算，更早的月份取自归档表，拼成一条连续的时间线。
     只用归档那部分的话，新装的工作台前 4 个月会是一张空表 ——
     而"每个月花了多少电费"这件事从第一天就该看得到。

     按自然月切分意味着某个月要么整体在日明细里、要么整体在归档里，不会重复。
     万一真重叠了（例如恢复过旧备份），这里取相加 —— 和 runRetention
     归档时"累加到已存在的月份"保持同一套语义。 */
  const currentMonth = todayKey.slice(0, 7);
  const monthRollup = {};
  for (const day of Object.keys(e.daily || {})) {
    const m = day.slice(0, 7);
    const slot = (monthRollup[m] ||= { kwh: 0, cost: 0, days: 0, archived: false });
    slot.kwh += e.daily[day]?.kwh || 0;
    slot.cost += e.daily[day]?.cost || 0;
    slot.days += 1;
  }
  for (const m of Object.keys(e.monthly || {})) {
    const slot = (monthRollup[m] ||= { kwh: 0, cost: 0, days: 0, archived: false });
    slot.kwh += e.monthly[m]?.kwh || 0;
    slot.cost += e.monthly[m]?.cost || 0;
    slot.days += Math.round(e.monthly[m]?.days || 0);
    slot.archived = true;
  }
  const monthlySeries = Object.keys(monthRollup)
    .sort()
    .slice(-MONTHLY_KEEP_MONTHS)
    .reverse()
    .map((m) => ({
      month: m,
      kwh: round(monthRollup[m].kwh, 2),
      cost: round(monthRollup[m].cost, 2),
      days: monthRollup[m].days,
      /** true = 来自归档表（日明细已被清理），false = 由日明细现算 */
      archived: monthRollup[m].archived,
      /** 当月还没过完，摆在完整月份旁边容易被误读成"这个月用电少" */
      partial: m === currentMonth,
    }));

  /* ── 用电量口径 ─────────────────────────────────────────────────────
     这块插座（cuco.plug.v3）的「耗电量」属性是坏的：云端恒定返回 0.01 kWh，
     而米家 App 能显示"今日 0.9 度"。说明 App 的数字不是从设备属性读的，而是
     小米云端拿「电功率」按时间积分算出来的——设备本身不提供可用的累计读数。

     所以这里走同一条路：对实测电功率做时间积分得到每日电量，再按天汇总。
     这块插座的电功率是秒级推送的，积分结果就是真实用电量。
     累计读数仍照常记录，一旦它真的开始增长就自动切回那个口径（更抗停机）。 */
  const meterDaily = e.meterDaily || {};
  const counter = Number.isFinite(ha?.counterKwh) ? ha.counterKwh : null;
  const meterTodayKwh = counter == null ? null : meterUsage(meterDaily, counter, null);
  const meterMonthKwh = counter == null ? null : meterUsage(meterDaily, counter, 30);
  // 累计读数要"每个启用插座都提供了、且读到了值"（ha.counterAllPresent）才敢求和采用；
  // 再加上一整个窗口下来确实在涨，否则说明这些属性是坏的，不能拿 0 冒充真实用电。
  const meterAlive = Boolean(ha?.counterAllPresent) && meterMonthKwh != null && meterMonthKwh > 0;

  // 实测功率积分出来的每日电量
  const dailyKeys = Object.keys(e.daily || {}).sort();
  const last30 = dailyKeys.slice(-30);
  const sampledMonthKwh = last30.reduce((a, k) => a + (e.daily[k]?.kwh || 0), 0);

  const costBasis = meterAlive ? 'meter' : 'integrated';
  const kwhToday = meterAlive ? meterTodayKwh : sampled.kwh;
  const monthKwh = meterAlive ? meterMonthKwh : sampledMonthKwh;

  const costToday = kwhToday * price;
  const monthCost = monthKwh * price;

  // 今天还没过完，剩余小时按当前功率外推
  const hoursLeft = 24 - (new Date().getHours() + new Date().getMinutes() / 60);
  const projectedDayKwh = kwhToday + (watts * hoursLeft) / 1000;
  const projectedDayCost = projectedDayKwh * price;

  const meterDays = Object.keys(meterDaily).sort();

  // 每日曲线跟用电量同源：累计读数可用就用相邻两天差值，否则用实测功率积分
  const meterHistory = [];
  for (let i = 1; i < meterDays.length; i += 1) {
    const diff = Number(meterDaily[meterDays[i]]?.out) - Number(meterDaily[meterDays[i - 1]]?.out);
    if (Number.isFinite(diff) && diff >= 0) {
      meterHistory.push({ date: meterDays[i], kwh: round(diff, 3), cost: round(diff * price, 3) });
    }
  }
  const history = (meterAlive && meterHistory.length
    ? meterHistory
    : dailyKeys.map((k) => ({ date: k, kwh: round(e.daily[k].kwh, 3), cost: round(e.daily[k].cost, 3) }))
  ).slice(-14);

  return {
    watts: round(watts, 1),
    source: wattsInfo.source,
    ha: {
      configured: Boolean(ha?.configured),
      online: Boolean(ha?.ok),
      /** 各插座的分项读数，供页面展示与排障 */
      sockets: (ha?.sockets ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        powerEntity: s.powerEntity,
        watts: s.watts == null ? null : round(s.watts, 1),
        counterKwh: s.counterKwh == null ? null : round(s.counterKwh, 3),
        ok: Boolean(s.ok),
        error: s.error ?? null,
      })),
      /** 所有插座累计读数之和；只有全部插座都提供可用读数时才有值 */
      counterKwh: counter == null ? null : round(counter, 3),
      lastUpdated: ha?.lastUpdated ?? null,
      error: ha?.error ?? null,
    },
    /**
     * 插座「耗电量」属性。这块设备的该属性实测是坏的（云端恒定 0.01 kWh），
     * 所以只作为诊断字段暴露出来；哪天它恢复增长，alive 会变 true 并自动接管口径。
     */
    meter: {
      counterKwh: counter == null ? null : round(counter, 3),
      todayKwh: meterTodayKwh == null ? null : round(meterTodayKwh, 3),
      monthKwh: meterMonthKwh == null ? null : round(meterMonthKwh, 3),
      alive: meterAlive,
    },
    /** 当前口径的时间覆盖：不足窗口时，"近一月"其实只是"自开始记录以来" */
    window: {
      basis: costBasis,
      days: costBasis === 'meter' ? meterDays.length : dailyKeys.length,
      since: costBasis === 'meter' ? (meterDays[0] ?? null) : (dailyKeys[0] ?? null),
      windowDays: 30,
      hasFullWindow: (costBasis === 'meter' ? meterDays.length : dailyKeys.length) > 30,
    },
    costBasis,
    model: {
      idleW: wattsInfo.idleW ?? Number(p.idleW ?? 45),
      maxW: wattsInfo.maxW ?? Number(p.maxW ?? 190),
      perDiskW: Number(p.perDiskW ?? 6),
      extraW: Number(p.extraW ?? 28),
      cpuWatts: wattsInfo.cpuWatts == null ? null : round(wattsInfo.cpuWatts, 1),
      baseWatts: wattsInfo.baseWatts == null ? null : round(wattsInfo.baseWatts, 1),
      cpuRatio: wattsInfo.ratio == null ? null : round(wattsInfo.ratio, 3),
    },
    eco: {
      enabled: eco,
      factor: ecoFactor,
      /** measured = 由实测数据算出；manual = 样本不足，回退到设置里手填的系数 */
      basis: ecoBasis,
      manualFactor,
      /** 实测明细：每个负载档两种模式的平均功率与已积累时长，basis='manual' 时为 null */
      measured,
      standardWatts: round(standardWatts, 1),
      savedWatts: round(savedWatts, 1),
      savedPercent: standardWatts > 0 ? round((savedWatts / standardWatts) * 100, 1) : 0,
      ecoKwhTotal: round(ecoKwhTotal, 4),
      totalSavedKwh: round(savedKwhTotal, 4),
      totalSavedCost: round(savedKwhTotal * price, 2),
    },
    monthly: monthlySeries,
    retention: { dailyKeepMonths: DAILY_KEEP_MONTHS, monthlyKeepMonths: MONTHLY_KEEP_MONTHS },
    price: { perKwh: price, currency },
    today: {
      // 保留 5 位：这块插座满打满算一天也就 1 kWh 上下，凌晨时段累计值还在
      // 亚 Wh 量级，按 3 位取整会被抹成 0，前端就什么都看不到了。
      kwh: round(kwhToday, 5),
      cost: round(costToday, 4),
      // 本地按瞬时功率积出来的值，留着做对照，能看出停机漏了多少
      sampledKwh: round(sampled.kwh, 5),
      ecoKwh: round(sampled.ecoKwh || 0, 5),
      samples: sampled.samples || 0,
    },
    projection: {
      dayKwh: round(projectedDayKwh, 5),
      dayCost: round(projectedDayCost, 4),
      monthKwh: round(monthKwh, 5),
      monthCost: round(monthCost, 4),
      yearCost: round(monthKwh * 12, 2),
    },
    cumulative: {
      monthKwh: round(monthKwh, 5),
      monthCost: round(monthCost, 4),
      sampledMonthKwh: round(sampledMonthKwh, 5),
      sampledMonthCost: round(sampledMonthKwh * price, 4),
      totalKwh: round(e.totalKwh || 0, 5),
      totalCost: round(e.totalCost || 0, 4),
      daysTracked: dailyKeys.length,
    },
    history,
    sampledAt: Date.now(),
  };
}

function round(v, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(v) || 0) * f) / f;
}

/**
 * 运行模式联动。三件事，按重要性排：
 *
 *   1. CPU 调频（主要）—— 标准模式 performance / 节能模式 powersave，
 *      经 SSH 下发到 PVE 母机。这是这个开关里唯一真的改变了硬件行为的动作，
 *      其余都是功耗模型上的折算。
 *   2. webhook（可选）  —— ECO_WEBHOOK_URL
 *   3. 本地命令（可选） —— PVE_ECO_COMMAND，注意它在**工作台本机**执行
 *
 * 任何一步失败都不阻断其它步：调频挂了，功耗模型侧仍照常切换，
 * 错误放进 result.errors 让界面能看见，而不是整个开关哑掉。
 */
export async function applyEco(enabled, settings) {
  const result = { enabled, webhook: 'skipped', command: 'skipped', governor: null, errors: [] };

  /* 调频放在最前面：它是这个开关的主要动作，而且 webhook 有 5 秒超时，
     排在后面会让"按下节能"要多等好几秒才真的降频。 */
  const host = pveConfig(settings).host;
  if (!host) {
    // 演示模式没有 PVE 地址，跳过是预期行为，不计入 errors
    result.governor = { ok: false, skipped: true, error: '尚未配置 PVE 地址，未下发 CPU 调频策略' };
  } else {
    const target = enabled ? GOVERNORS.eco : GOVERNORS.standard;
    try {
      const r = await setGovernor(host, target);
      result.governor = { ok: true, ...r };
    } catch (err) {
      result.governor = { ok: false, error: err.message, host, target };
      result.errors.push(`CPU 调频下发失败：${err.message}`);
    }
  }

  const hook = (process.env.ECO_WEBHOOK_URL || '').trim();
  if (hook) {
    try {
      const res = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, at: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000),
      });
      result.webhook = res.ok ? 'ok' : `http ${res.status}`;
      if (!res.ok) result.errors.push(`webhook 返回 ${res.status}`);
    } catch (err) {
      result.webhook = 'error';
      result.errors.push(`webhook 调用失败：${err.message}`);
    }
  }

  const cmd = (process.env.PVE_ECO_COMMAND || '').trim();
  if (cmd) {
    try {
      await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });
      result.command = 'ok';
    } catch (err) {
      result.command = 'error';
      result.errors.push(`本地命令执行失败：${err.message}`);
    }
  }

  return result;
}
