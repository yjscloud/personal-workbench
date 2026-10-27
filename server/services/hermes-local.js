import { spawn } from 'node:child_process';
import { localConfig } from './hermes-config.js';

/* ────────────────────────────────────────────────────────────────────────
 * Hermes 本机数据桥（SSH）
 * ────────────────────────────────────────────────────────────────────────
 * 用法：bridgeCall('/local/usage')、bridgeCall('/local/scrape', { method:'POST', body })
 *
 * 一次调用 = 一个 ssh 进程 = 远端桥脚本读一份数据 = 一行 JSON。
 * 为什么不是「工作台直接用 SFTP 逐文件读」：
 *   · 用量要跑 SQL（state.db）、守望要跑 frp_guard.py、MCP 要 stdio 握手，
 *     这些只能在数据所在的那台机器上做；
 *   · 一个接口一次往返，比按文件多次拉取稳定，也更容易做缓存。
 *
 * 约束：
 *   · 只允许桥脚本支持的路径（/local/* 与 /public/agents），不接受任意命令；
 *   · 远端有 timeout 兜底，本地 spawn 也有超时，任何一边卡住都不会拖住页面；
 *   · 读请求缓存 cacheTtl（默认 20s），写/动作请求不缓存。
 * ──────────────────────────────────────────────────────────────────────── */

const cache = new Map(); /* key → { at, value, ttl } */
let cacheEpoch = 0;      /* invalidate 时 +1，阻止在途的旧刷新把数据写回来 */
const refreshing = new Set();
let active = 0;
const waiters = [];
const MAX_CONCURRENCY = Number(process.env.HERMES_LOCAL_CONCURRENCY || 3);

function acquire() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
}

/** 返回新鲜值或 stale 值；超过 stale 窗口就丢弃 */
function cachePeek(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age <= hit.ttl) return { value: hit.value, stale: false };
  const staleMax = Math.max(hit.ttl * 8, 120000);
  if (age <= staleMax) return { value: hit.value, stale: true, ttl: hit.ttl };
  cache.delete(key);
  return null;
}

function cacheSet(key, value, ttl) {
  if (ttl > 0) cache.set(key, { at: Date.now(), value, ttl });
  /* 简单上限：单用户面板，缓存键也就那么几个 */
  if (cache.size > 80) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

export function invalidateLocal(prefix = '') {
  cacheEpoch += 1;
  for (const key of [...cache.keys()]) {
    if (!prefix || key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * 后台刷新（stale-while-revalidate）。
 * 缓存过期但还在 stale 窗口内时：先把旧值给页面，同时异步取一次新值。
 * 这样第二次打开页面是 0 延迟，数据最多晚一个刷新周期。
 */
async function revalidate(key, pathname, opts, ttl) {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  const epoch = cacheEpoch;
  try {
    await acquire();
    try {
      const value = await sshRun(
        {
          path: pathname,
          method: 'GET',
          body: null,
          query: opts.query ?? null,
        },
        opts.timeout ?? localConfig().timeout,
      );
      if (epoch === cacheEpoch) cacheSet(key, value, ttl);
    } finally {
      release();
    }
  } catch {
    /* 刷新失败就保留旧值，下一次请求再试 */
  } finally {
    refreshing.delete(key);
  }
}

function sshRun(payload, timeout) {
  const cfg = localConfig();
  if (!cfg.host) return Promise.reject(new Error('未配置 HERMES_LOCAL_HOST，读不到 Hermes 本机数据'));

  const text = JSON.stringify(payload);
  const seconds = Math.max(5, Math.ceil(timeout / 1000));
  /* 远端也套一层 timeout：本地 ssh 被 kill 时，远端 node 不要继续挂着 */
  const remote = `timeout -k 5 ${seconds} node ${cfg.bridgePath}`;

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-i', cfg.key,
        `${cfg.user}@${cfg.host}`,
        remote,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      reject(new Error(`Hermes 数据桥超时（${seconds}s）`));
    }, timeout + 3000);

    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > 12 * 1024 * 1024) {
        try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      }
    });
    child.stderr.on('data', (c) => { err += c; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法连接 Hermes 数据桥：${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = out.trim();
      if (!body) {
        reject(new Error(err.trim() || `数据桥没有返回内容（exit ${code}）`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        reject(new Error(`数据桥返回了非 JSON：${body.slice(0, 160)}`));
        return;
      }
      if (!parsed.ok) {
        /* 桥把 4xx 的原因放在 data 里（data.error / data.output），
           顶层只有 error 字段的话错误就丢了 —— 表现是"数据桥失败（HTTP 400）"，
           什么也没说清楚 */
        const detail = parsed.error || parsed.data?.error || parsed.data?.output || '';
        reject(new Error(detail ? String(detail).slice(0, 300) : `数据桥失败（HTTP ${parsed.status}）`));
      } else resolve(parsed.data);
    });

    child.stdin.on('error', () => { /* 远端提前退出时忽略 EPIPE */ });
    child.stdin.end(text);
  });
}

/**
 * @param {string} path      /local/usage、/local/security/profile、/public/agents…
 * @param {object} [opts]
 * @param {object} [opts.query]   查询参数（会被 URLSearchParams 编码）
 * @param {'GET'|'POST'} [opts.method]
 * @param {object} [opts.body]    POST 请求体
 * @param {number} [opts.timeout] 毫秒
 * @param {number} [opts.cacheTtl] 毫秒；0 表示不缓存
 */
export async function bridgeCall(pathname, opts = {}) {
  const cfg = localConfig();
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const cacheable = method === 'GET' && opts.cacheTtl !== 0;
  const key = pathname + (opts.query ? '?' + new URLSearchParams(opts.query).toString() : '');
  const ttl = opts.cacheTtl ?? cfg.cacheTtl;

  if (cacheable) {
    const hit = cachePeek(key);
    if (hit && !hit.stale) return hit.value;
    if (hit) {
      /* 先返回旧值，后台补新值：页面不必为"数据刚好过期"再等一次 SSH */
      void revalidate(key, pathname, opts, hit.ttl);
      return hit.value;
    }
  }

  await acquire();
  let value;
  try {
    value = await sshRun(
      {
        path: pathname,
        method,
        body: opts.body ?? null,
        query: opts.query ?? null,
      },
      opts.timeout ?? cfg.timeout,
    );
  } finally {
    release();
  }

  if (cacheable) cacheSet(key, value, ttl);
  return value;
}

/** 网关 + 数据桥的一次性自检（设置页 / hermes:probe 用） */
export async function testLocalBridge() {
  const cfg = localConfig();
  const started = Date.now();
  try {
    const data = await bridgeCall('/__ping', { timeout: 12000, cacheTtl: 0 });
    return {
      ok: true,
      host: cfg.host,
      bridgePath: cfg.bridgePath,
      elapsedMs: Date.now() - started,
      ...data,
    };
  } catch (err) {
    return {
      ok: false,
      host: cfg.host,
      bridgePath: cfg.bridgePath,
      elapsedMs: Date.now() - started,
      error: err.message,
    };
  }
}

