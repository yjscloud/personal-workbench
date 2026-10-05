import { sshRun } from './ssh.js';

/* ────────────────────────────────────────────────────────────────────────
 * PVE 母机的 CPU 调频器（scaling_governor）
 *
 *   标准模式 → performance   锁住高频
 *   节能模式 → powersave     intel_pstate 下即"按需降频"
 *
 * 为什么走 SSH：PVE **没有任何**改 governor 的 API（/nodes/{node}/sensors
 * 那种不存在的接口就是前车之鉴），只能在宿主上执行命令。这里用
 * `cpupower frequency-set -g <档位>`，是 PVE 官方文档给的做法。
 *
 * 安全约束：档位会被拼进远端 shell 命令，所以两道闸——
 *   1. 只允许 GOVERNORS 白名单里的值（调用方不能随便传字符串）；
 *   2. 执行前先读设备实际支持的列表比对，写一个不支持的档位会让
 *      cpupower 报错并留下半截状态。
 * 另外全程用 execFile + 参数数组，不经本地 shell，地址里的字符不会被解释。
 * ──────────────────────────────────────────────────────────────────────── */

const GOVERNOR_STANDARD = (process.env.PVE_CPU_GOVERNOR_STANDARD || 'performance').trim();
const GOVERNOR_ECO = (process.env.PVE_CPU_GOVERNOR_ECO || 'powersave').trim();

const GOVERNOR_PATH = '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor';
const AVAILABLE_PATH = '/sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors';

/** 运行模式 → governor。对外只认这两个名字 */
export const GOVERNORS = { standard: GOVERNOR_STANDARD, eco: GOVERNOR_ECO };

/* 读一次要开一次 SSH（~150ms）。概览页 5 秒轮询一次，全缓存掉。
   失败也缓存：SSH 不通时连接超时 8 秒，不缓存会让概览每分钟被拖住一次。 */
let cache = { at: 0, host: '', value: null };
/* 调频档位是"设一次就基本不动"的值，没必要每次轮询都 SSH 去读 ——
   SSH 握手比 PVE 那几个 HTTP 接口还慢，是这个接口最容易拖后腿的一环。
   5 分钟足够：手动切换档位时会 force 重读，不受这个缓存影响。 */
const CACHE_MS = 300000;

/**
 * 读当前 governor。读不到返回 null（不抛错）——
 * "读不到"和"读到了是别的值"对界面是两种不同的呈现。
 */
export async function readGovernor(host, { force = false } = {}) {
  if (!host) return null;
  const now = Date.now();
  if (!force && cache.host === host && now - cache.at < CACHE_MS) return cache.value;

  let value = null;
  try {
    value = await sshRun(host, `cat ${GOVERNOR_PATH}`);
  } catch {
    value = null;
  }
  cache = { at: now, host, value };
  return value;
}

/**
 * 切到指定档位，返回切换前后的实际读数。
 * 读回校验是必须的：cpupower 有时会对部分核心静默失败，只看退出码会误判成功。
 */
export async function setGovernor(host, governor) {
  if (!host) throw new Error('尚未配置 PVE 地址，无法下发 CPU 调频策略');
  if (!Object.values(GOVERNORS).includes(governor)) {
    throw new Error(`不支持的调频档位：${governor}`);
  }

  const before = await readGovernor(host, { force: true });
  if (before === governor) return { host, from: before, to: governor, changed: false };

  let available = [];
  try {
    available = (await sshRun(host, `cat ${AVAILABLE_PATH}`)).split(/\s+/).filter(Boolean);
  } catch (err) {
    throw new Error(`连不上 PVE 母机（${err.message}）`);
  }
  if (!available.includes(governor)) {
    throw new Error(`这台 CPU 不支持 ${governor} 档位，可用：${available.join('、') || '未知'}`);
  }

  await sshRun(host, `cpupower frequency-set -g ${governor}`);
  const after = await readGovernor(host, { force: true });
  if (after !== governor) throw new Error(`下发后读回仍是 ${after ?? '未知'}，调频未生效`);
  return { host, from: before, to: after, changed: true };
}

/** 供设置变更后强制刷新 */
export function clearGovernorCache() {
  cache = { at: 0, host: '', value: null };
}
