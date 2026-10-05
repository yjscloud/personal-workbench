import { sshRun } from './ssh.js';

/* ────────────────────────────────────────────────────────────────────────
 * 网卡流量
 *
 * 数据取自母机的 /proc/net/dev。为什么不用 PVE 的接口：
 *   · /nodes/{node}/nics 只给网卡的**配置**（类型、是否开机自启），没有计数器；
 *   · RRD 只有节点合计的 netin/netout，分不到具体哪块网卡。
 * 要看"哪块口在跑流量"，只有 /proc/net/dev 有逐口的收发字节与错包。
 *
 * 速率怎么来的：/proc/net/dev 只有累计值，没有速率。所以每次真实采样都
 * 存一份快照，下次采样时用差值除以间隔算出平均速率。
 * 第一次采样没有前值，速率给 null —— 宁可显示"—"，也不拿 0 假装没流量。
 *
 * 哪些口要展示：lo，以及 PVE 给每台虚拟机生成的一串虚拟口
 * （tap、fwbr、fwln、fwpr 开头的），一台机器十来个，混进来会把真实网卡
 * 淹掉，所以按名字前缀过滤掉。
 * ──────────────────────────────────────────────────────────────────────── */

const CACHE_MS = 30000;
let cache = { at: 0, host: '', value: null };
/** 上一次真实采样的计数器，用来算速率 */
let prev = { at: 0, host: '', counters: null };

/** 要跳过的虚拟接口 */
const SKIP = /^(lo|tap|fwbr|fwln|fwpr|veth|docker|br-|virbr|vnet)/;

function kindOf(name) {
  if (/^vmbr/.test(name)) return 'bridge';
  if (/^bond/.test(name)) return 'bond';
  if (/^(eth|eno|ens|enp|enx|nic|wlan|wl)/.test(name)) return 'physical';
  if (/^(vlan|\w+\.\d+)/.test(name)) return 'vlan';
  return 'other';
}

/**
 * 解析 /proc/net/dev。
 * 每行形如 "    lo: 503820650 1427746 0 0 ... "（名字与数字用冒号分隔），
 * 前 8 个是接收，后 8 个是发送。
 */
function parseDev(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const name = line.slice(0, idx).trim();
    const nums = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (!name || nums.length < 16 || nums.some((n) => !Number.isFinite(n))) continue;
    out[name] = {
      rxBytes: nums[0],
      rxPackets: nums[1],
      rxErrs: nums[2],
      rxDrop: nums[3],
      txBytes: nums[8],
      txPackets: nums[9],
      txErrs: nums[10],
      txDrop: nums[11],
    };
  }
  return out;
}

/**
 * @param {string} host PVE 母机地址
 * @returns {Promise<{available: boolean, error: string|null, interfaces: Array, total: object, sampledAt: number}|null>}
 */
export async function collectNet(host) {
  if (!host) return null;

  const now = Date.now();
  if (cache.host === host && now - cache.at < CACHE_MS) return cache.value;

  let counters;
  try {
    const out = await sshRun(host, 'cat /proc/net/dev', { timeout: 10000 });
    counters = parseDev(out);
  } catch (err) {
    // 失败也缓存：SSH 不通时每次都等 8 秒超时，会把概览页拖死
    const value = { available: false, error: `读取网卡计数失败：${err.message}`, interfaces: [], total: null, sampledAt: now };
    cache = { at: now, host, value };
    return value;
  }

  const names = Object.keys(counters).filter((n) => !SKIP.test(n)).sort();

  // 速率：与上一次真实采样比对。换过主机就当没有前值，否则会算出荒谬的数。
  const dt = prev.host === host && prev.counters ? (now - prev.at) / 1000 : 0;
  const canRate = dt > 0.5;

  const interfaces = names.map((name) => {
    const c = counters[name];
    const p = canRate ? prev.counters?.[name] : null;
    // 计数器回绕或被重置时差值会变负，这时宁可不给速率
    const rxRate = p && c.rxBytes >= p.rxBytes ? (c.rxBytes - p.rxBytes) / dt : null;
    const txRate = p && c.txBytes >= p.txBytes ? (c.txBytes - p.txBytes) / dt : null;
    return { ...c, iface: name, kind: kindOf(name), rxRate, txRate };
  });

  // 合计只算物理口与聚合口：桥和物理口有重叠流量，全加会重复计一遍
  const uplink = interfaces.filter((i) => i.kind === 'physical' || i.kind === 'bond');
  const sum = (list, key) => {
    const vals = list.map((i) => i[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const total = {
    rxRate: sum(uplink, 'rxRate') ?? sum(interfaces, 'rxRate'),
    txRate: sum(uplink, 'txRate') ?? sum(interfaces, 'txRate'),
    rxBytes: uplink.reduce((a, i) => a + i.rxBytes, 0),
    txBytes: uplink.reduce((a, i) => a + i.txBytes, 0),
    /** 速率是"刚刚这一段时间"的平均，把这个窗口给出去，界面才好说明 */
    windowSec: canRate ? Math.round(dt) : null,
  };

  const value = {
    available: interfaces.length > 0,
    error: interfaces.length ? null : '没有读到网卡计数器',
    interfaces,
    total,
    sampledAt: now,
  };

  prev = { at: now, host, counters };
  cache = { at: now, host, value };
  return value;
}

export function clearNetCache() {
  cache = { at: 0, host: '', value: null };
  prev = { at: 0, host: '', counters: null };
}
