import cron from 'node-cron';
import { db, flush } from '../store.js';
import { haReadings, isHaConfigured } from './ha.js';
import { accumulate, recordMeter } from './power.js';
import { getNodeLoad } from './pve.js';

/* ────────────────────────────────────────────────────────────────────────
 * 服务端用电采样器
 * ────────────────────────────────────────────────────────────────────────
 * 这块插座不提供可用的累计电量读数（其「耗电量」属性云端恒定返回 0.01 kWh），
 * 所以用电量只能由实测电功率按时间积分得到。积分必须持续进行：
 * 光靠前端打开监控页时轮询，页面一关就断档，夜间更是整天漏计。
 *
 * 这里每分钟固定采一次。它和前端轮询共用同一份 lastTs，每个调用只结算
 * "距上次采样这段时间"的电量，所以两边同时跑也不会重复计数。
 * ──────────────────────────────────────────────────────────────────────── */

const INTERVAL_SECONDS = 60;
const CRON_EXPR = '*/1 * * * *';

let job = null;
let lastError = null;
let lastSampleAt = null;

/**
 * 采一次：读插座实测功率 → 积分进当日电量 → 记录累计读数快照 → 落库。
 * HA 读不到就跳过这一轮：宁可少算，也不拿估算值污染真实电量。
 */
export async function sampleOnce(settings) {
  const cfg = settings ?? db().settings;
  if (!isHaConfigured(cfg)) {
    return { ok: false, skipped: true, error: '未配置 Home Assistant' };
  }

  const ha = await haReadings(cfg);
  if (!ha.ok) {
    lastError = ha.error || 'Home Assistant 读数不可用';
    return { ok: false, error: lastError };
  }

  // CPU 负载只用来给实测统计标负载档（区分"空载差异"和"满载差异"），
  // 拿不到就记进 unknown 档、不参与计算，不影响电量累计
  const load = await getNodeLoad(cfg).catch(() => null);

  accumulate(ha.watts, cfg, { eco: cfg.power?.eco, load });
  recordMeter(ha.counterKwh);
  await flush();

  lastError = null;
  lastSampleAt = Date.now();
  return { ok: true, watts: ha.watts, counterKwh: ha.counterKwh };
}

export function samplerStatus() {
  return {
    running: Boolean(job),
    intervalSeconds: INTERVAL_SECONDS,
    lastSampleAt,
    lastError,
  };
}

export function startSampler() {
  if (job) return job;

  // 启动时先采一次，把"停机到开机"这段空档归零，也免得等满一分钟才有第一个点
  sampleOnce().catch((err) => console.error('[sampler] 首次采样失败：', err.message));

  job = cron.schedule(CRON_EXPR, () => {
    sampleOnce().catch((err) => {
      lastError = err.message;
      console.error('[sampler] 采样失败：', err.message);
    });
  });

  console.log(`[sampler] 已启用用电采样，每 ${INTERVAL_SECONDS} 秒一次`);
  return job;
}

export function stopSampler() {
  if (!job) return;
  job.stop();
  job = null;
}
