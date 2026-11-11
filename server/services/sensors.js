import { sshRun } from './ssh.js';

/* ────────────────────────────────────────────────────────────────────────
 * 节点温度：到母机上跑 `sensors`
 *
 * 为什么不在 PVE 的接口里取：`/nodes/{node}/status` 里**没有 thermalstate
 * 这个字段**。9.2.26 实测（连 root 直连 pvesh）：返回的 key 只有 boot-info /
 * cpu / cpuinfo / current-kernel / idle / ksm / kversion / loadavg / memory /
 * pveversion / rootfs / swap / uptime / wait，PVE 自己的 Perl 与 JS 里也搜不到
 * thermalstate 这个词。/nodes/{node}/sensors 这个接口同样不存在（"No 'get'
 * handler defined"），/nodes/{node}/hardware 只给 pci 和 usb。
 *
 * 也就是说温度只有一条路：上机执行 sensors。和网卡计数器（net.js）、
 * SMART（smart.js）同一个原因 —— 这三样 PVE 的 API 都没有。
 *
 * 缓存 30 秒：温度是慢变量，而概览页会轮询；SSH 一次要 1 秒上下，
 * 不缓存等于每次刷新都在等一条 ssh。失败也缓存：SSH 不通时每 30 秒
 * 重试一次就够，否则每次请求都白等 8 秒超时，把整页拖死。
 * ──────────────────────────────────────────────────────────────────────── */

const CACHE_MS = 30000;
let cache = { at: 0, host: '', value: null };

/**
 * 远端命令：先探 sensors 在不在。
 * 用 `command -v` 而不是 `which`（后者在最小化系统里不保证有），
 * 并且无论哪种情况都 exit 0 —— 非零退出会让 sshRun 整个判失败，
 * 那样"没装 lm-sensors"和"SSH 连不上"就混成同一条错误，界面上没法给出对的建议。
 */
const CMD = 'command -v sensors >/dev/null 2>&1 || { echo SENSORS_MISSING; exit 0; }; sensors 2>/dev/null';

/**
 * @param {string} host PVE 母机地址
 * @returns {Promise<{available: boolean, raw: string, error: string|null, sampledAt: number}|null>}
 */
export async function collectSensors(host) {
  if (!host) return null;

  const now = Date.now();
  if (cache.host === host && now - cache.at < CACHE_MS) return cache.value;

  let value;
  try {
    const out = String((await sshRun(host, CMD, { timeout: 12000 })) || '').trim();
    if (/^SENSORS_MISSING/.test(out)) {
      value = {
        available: false,
        raw: '',
        error: '母机上没有 sensors 命令，装一下 lm-sensors 并执行 sensors-detect 就能上报温度。',
        sampledAt: now,
      };
    } else {
      value = {
        available: Boolean(out),
        raw: out,
        error: out ? null : '母机上 sensors 没有任何输出（可能没探到温度芯片）',
        sampledAt: now,
      };
    }
  } catch (err) {
    value = { available: false, raw: '', error: `SSH 到母机执行 sensors 失败：${err.message}`, sampledAt: now };
  }

  cache = { at: now, host, value };
  return value;
}

/** 设置变更后强制刷新 */
export function clearSensorsCache() {
  cache = { at: 0, host: '', value: null };
}
