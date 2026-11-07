/* ────────────────────────────────────────────────────────────────────────
 * 边界守望 · 出口 IP 自动白名单
 * ────────────────────────────────────────────────────────────────────────
 * 白名单（frp_guard_allow.txt）命中 = 不评分、不告警、不开申请单，是"自己人
 * 不会被自己封掉"的最后一道阀。问题是这道阀要人手抄 IP，而家宽 / 4G 的出口
 * 是**会变**的：PPPoE 重拨那天，旧 IP 静悄悄失效，新 IP 被当成攻击者。
 *
 * 这里做三件事：
 *   1. 找出「网关看到的我们」是哪个 IP；
 *   2. 每 30 分钟对一次；变了就把**自己加的那一条**删掉换成新的；
 *   3. 把人手工写的条目完全隔离 —— 只认备注里带 MARK 的行，别的一条都不碰。
 *
 * 探测顺序（这一点是踩过坑才改的）：
 *   ① 网关自报：ssh 过去 `printenv SSH_CLIENT`，它眼里的对端地址就是 frps /
 *      haproxy 日志里会出现的源 IP —— 白名单判定的正是这个值，一步不用猜。
 *   ② 国内回显接口：网关在国内时和 ① 是同一条路径。
 *   ③ 国际回显接口：只在前两条都不可用时兜底，而且**只当参考**。
 *   为什么不是直接问 ipify：分流环境下"去国外"和"去网关"是两个出口
 *   （实测：ipify 看到香港，网关看到广州移动），拿前者加白等于保护错对象。
 *
 * 几条刻意保留的护栏：
 *   · 私有 / 保留地址一律不接受 —— 那说明检测链路自己被代理接管了，写进去等于白写；
 *   · 多源投票打平就放弃（宁可不改，也不猜）；
 *   · 检测失败连续累积时不删任何东西 —— 旧 IP 可能仍然有效，删了就没人保护了；
 *   · 一次只能在名单里留一个自动条目（多留着就是给旧 IP 永久开口子）；
 *   · 已经手工加过的同值条目不接管（否则下一轮换 IP 会连人家手写的配置一起删掉）。
 * ──────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../store.js';
import { isLocalConfigured } from './hermes-config.js';
import { bridgeCall } from './hermes-local.js';
import { securityAllowList, securityAllowSave } from './office.js';

/** 自动条目的备注标记。写在白名单行尾，也是"这条是我加的"的唯一凭据 */
export const EGRESS_ALLOW_MARK = '自动·工位出口';

/** 30 分钟一轮：家宽重拨不会比这更频繁，再密只是徒增出网请求 */
const INTERVAL_MS = Math.max(60_000, Number(process.env.EGRESS_ALLOW_INTERVAL_MS || 30 * 60 * 1000));
/** 固定出口的环境（专线 / 固定 IP）可以不探测，直接写死 */
const FIXED_IP = String(process.env.EGRESS_ALLOW_IP || '').trim();
/** 每个外部源最多等这么久；同一组源是并发的，整体不超过一轮超时 */
const SOURCE_TIMEOUT_MS = 6000;
const HISTORY_MAX = 10;

const STATE_FILE = path.join(DATA_DIR, 'security-egress.json');
const NOTE = `${EGRESS_ALLOW_MARK}（每 ${Math.round(INTERVAL_MS / 60000)} 分钟自动检测）`;

export const VIA_LABEL = {
  gateway: '网关自报（frps 看到的就是它）',
  domestic: '国内回显接口',
  global: '国际回显接口（可能不是网关那条路）',
  fixed: '配置写死',
};

/* ── 出口 IP 探测 ─────────────────────────────────────────────────────── */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 只要 IPv4 字面量：白名单文件与 frp_guard.py 都按 IPv4/CIDR 解析 */
export function parseIpv4(text) {
  const v = String(text || '').trim().split(/\s+/)[0] || '';
  const m = IPV4.exec(v);
  if (!m) return '';
  return m.slice(1).every((n) => Number(n) <= 255) ? v : '';
}

/**
 * 这个地址能不能拿去加白。
 *
 * 私有段 / 回环 / 链路本地 / CGNAT 出现在"我的公网出口"这个位置上，只能说明
 * 查询被代理或劫持了 —— 这种值写进白名单既保护不了自己，又白白给一个内网段开口子。
 */
export function isUsableEgress(ip) {
  if (!parseIpv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

const firstIp = (raw) => {
  const m = String(raw || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? parseIpv4(m[1]) : '';
};

/** 纯文本回显（ipify / ifconfig.me / ip.3322.net 都是这个形状） */
function textIp(raw) {
  return { ip: parseIpv4(raw), place: '' };
}

/** cloudflare 的 trace 是 key=value 多行，IP 在 ip= 那一行 */
function traceIp(raw) {
  const line = String(raw || '').split('\n').find((l) => l.startsWith('ip='));
  return { ip: parseIpv4(line ? line.slice(3) : ''), place: '' };
}

/** ipip.net：「当前 IP：1.2.3.4  来自于：中国 广东 广州  移动」 */
function ipipText(raw) {
  const text = String(raw || '');
  const place = (text.split('来自于')[1] || '').trim().replace(/\s+/g, ' ');
  return { ip: firstIp(text), place };
}

/** 国内 JSON 回显（useragentinfo / speedtest.cn）：字段名各家不同，一起兜 */
function jsonPlace(raw) {
  try {
    const d = JSON.parse(raw);
    const ip = parseIpv4(d.ip || d.query || (d.data && (d.data.ip || d.data.query)) || '');
    const place = [d.country, d.province || d.region, d.city, d.isp]
      .filter(Boolean).join(' ').trim();
    return { ip, place };
  } catch {
    return { ip: firstIp(raw), place: '' };
  }
}

/*
 * 两组源。顺序有意义：国内那组走的是"去国内"的路由，和 frp 网关同一条；
 * 国际那组会走分流，只在前面全挂了时兜底，且结果只当参考。
 */
const DOMESTIC_SOURCES = [
  { name: 'ipip.net', url: 'https://myip.ipip.net', parse: ipipText },
  { name: 'ip.3322.net', url: 'http://ip.3322.net', parse: textIp },
  { name: 'useragentinfo', url: 'https://ip.useragentinfo.com/json', parse: jsonPlace },
  { name: 'speedtest.cn', url: 'https://forge.speedtest.cn/api/location/info', parse: jsonPlace },
];

const GLOBAL_SOURCES = [
  { name: 'cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: traceIp },
  { name: 'ipify', url: 'https://api.ipify.org', parse: textIp },
  { name: 'ipinfo', url: 'https://ipinfo.io/ip', parse: textIp },
  { name: 'ifconfig.me', url: 'https://ifconfig.me/ip', parse: textIp },
];

async function askSource(src) {
  const res = await fetch(src.url, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: { 'user-agent': 'personal-workbench/1.0 (security-egress)', accept: 'text/plain, application/json' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return src.parse(await res.text());
}

/**
 * 问一组源，按票数取多数。
 *
 * 打平或者只有一个源能通时不猜：单源可能是中间设备的答案，写错了等于把
 * 白名单给了别人。宁可这一轮失败（旧条目留着），等下一轮再说。
 */
async function voteFrom(sources) {
  const settled = await Promise.all(
    sources.map(async (src) => {
      try {
        const got = await askSource(src);
        return { name: src.name, ok: Boolean(got.ip), ip: got.ip, place: got.place, error: got.ip ? '' : '返回内容里没有 IPv4' };
      } catch (e) {
        return { name: src.name, ok: false, ip: '', place: '', error: e?.message || String(e) };
      }
    }),
  );

  const tally = new Map();
  const places = new Map();
  for (const s of settled) {
    if (!s.ok || !isUsableEgress(s.ip)) continue;
    tally.set(s.ip, (tally.get(s.ip) || 0) + 1);
    if (s.place && !places.has(s.ip)) places.set(s.ip, s.place);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const list = settled.map(({ name, ok, ip }) => ({ name, ok, ip }));

  if (!ranked.length) {
    return { ip: '', place: '', sources: list, error: settled.map((s) => `${s.name}：${s.error}`).join('；') || '没有可用结果' };
  }
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return {
      ip: '',
      place: '',
      sources: list,
      error: `多个源给出的出口不同且票数相同（${ranked.map(([ip]) => ip).join(' / ')}），本轮不写入`,
    };
  }
  return { ip: ranked[0][0], place: places.get(ranked[0][0]) || '', sources: list, error: '' };
}

/** 网关自报：桥 ssh 到 frps 主机问 SSH_CLIENT（见 hwb-bridge 的 probeEgressFromGateway） */
async function probeViaGateway() {
  try {
    const d = await bridgeCall('/local/security/egress', { timeout: 20000, cacheTtl: 0 });
    const ip = parseIpv4(d?.ip);
    if (!d?.ok || !ip) {
      return { ip: '', error: String(d?.error || '网关没有返回来源地址').slice(0, 200) };
    }
    if (!isUsableEgress(ip)) return { ip: '', error: `网关报的来源是不可用于加白的地址：${ip}` };
    return { ip, target: String(d.target || ''), error: '' };
  } catch (e) {
    return { ip: '', error: e.message || String(e) };
  }
}

/** 归属地只用于显示（证明"这个 IP 真的是广州那条线"），查不到不影响判定 */
async function lookupPlace(ip) {
  if (!ip) return '';
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`,
      { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS), headers: { accept: 'application/json' } },
    );
    if (!res.ok) return '';
    const d = await res.json();
    if (d.status !== 'success') return '';
    return [d.country, d.regionName, d.city, d.isp].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/**
 * 找出「网关看到的工位出口 IP」。
 *
 * 返回 `via` 说明这个值是怎么来的：gateway 最可信，global 只是兜底 ——
 * 页面要把它显示出来，否则用户没法判断这个 IP 到底对不对（分流环境下
 * 两者可以完全是两个国家的地址）。
 */
export async function detectEgressIp() {
  if (FIXED_IP) {
    if (!isUsableEgress(FIXED_IP)) {
      return { ip: '', via: '', place: '', sources: [], error: `EGRESS_ALLOW_IP 不是可用的公网 IPv4：${FIXED_IP}` };
    }
    return { ip: FIXED_IP, via: 'fixed', place: '', sources: [{ name: 'env', ok: true, ip: FIXED_IP }], error: '' };
  }

  const errors = [];

  /* ① 网关自报：白名单判定用的就是它眼里的源地址 */
  const gw = await probeViaGateway();
  if (gw.ip) {
    return {
      ip: gw.ip,
      via: 'gateway',
      place: await lookupPlace(gw.ip),
      sources: [{ name: gw.target ? `gateway:${gw.target}` : 'gateway', ok: true, ip: gw.ip }],
      error: '',
    };
  }
  errors.push(`网关自报失败：${gw.error}`);

  /* ② 国内回显：网关在国内时与 ① 同一条路由 */
  if (isLocalConfigured()) {
    const domestic = await voteFrom(DOMESTIC_SOURCES);
    if (domestic.ip) return { ...domestic, via: 'domestic' };
    errors.push(`国内回显失败：${domestic.error}`);
  }

  /* ③ 国际回显：只当参考，页面上会明说 */
  const global = await voteFrom(GLOBAL_SOURCES);
  if (global.ip) return { ...global, via: 'global' };
  errors.push(`国际回显失败：${global.error}`);

  return { ip: '', via: '', place: '', sources: [...global.sources], error: errors.join('；') };
}

/* ── 状态（落盘，重启后页面还能看到上一轮的结果） ───────────────────── */

let state = null;
let stateLoading = null;

function emptyState() {
  return {
    enabled: true,
    ip: '',
    appliedIp: '',
    via: '',
    place: '',
    checkedAt: '',
    changedAt: '',
    nextAt: '',
    failStreak: 0,
    lastError: '',
    sources: [],
    history: [],
  };
}

async function loadState() {
  if (state) return state;
  if (!stateLoading) {
    stateLoading = (async () => {
      const base = emptyState();
      try {
        const raw = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
        state = {
          ...base,
          ...raw,
          enabled: raw?.enabled !== false,
          sources: Array.isArray(raw?.sources) ? raw.sources : [],
          history: Array.isArray(raw?.history) ? raw.history.slice(0, HISTORY_MAX) : [],
        };
      } catch {
        state = base; /* 文件不存在 / 坏了：当作默认开启、还没检测过 */
      }
      return state;
    })();
  }
  return stateLoading;
}

async function saveState(next) {
  state = next;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.chmod(STATE_FILE, 0o600).catch(() => {});
  } catch (e) {
    console.warn('[egress] 状态落盘失败：', e.message);
  }
}

const isManaged = (e) => String(e?.note || '').startsWith(EGRESS_ALLOW_MARK);

/** 给页面看的完整状态：含下一次检测时间、探测途径、变更历史 */
export async function egressStatus() {
  const st = await loadState();
  return {
    ok: true,
    enabled: st.enabled,
    intervalMinutes: Math.round(INTERVAL_MS / 60000),
    marker: EGRESS_ALLOW_MARK,
    fixed: Boolean(FIXED_IP),
    bridgeReady: isLocalConfigured(),
    ip: st.ip,
    appliedIp: st.appliedIp,
    via: st.via,
    viaLabel: VIA_LABEL[st.via] || '',
    place: st.place,
    checkedAt: st.checkedAt,
    changedAt: st.changedAt,
    nextAt: st.nextAt,
    failStreak: st.failStreak,
    lastError: st.lastError,
    sources: st.sources,
    history: st.history,
    note: NOTE,
  };
}

export async function setEgressEnabled(enabled) {
  const st = await loadState();
  const next = { ...st, enabled: Boolean(enabled) };
  /* 关掉就别再挂着"下次检测"，免得页面显示一个不会发生的计划；
     刚打开时按此刻重算，不用等定时器跑完第一轮才有个准时间 */
  next.nextAt = next.enabled ? new Date(Date.now() + INTERVAL_MS).toISOString() : '';
  await saveState(next);
  /* 从关到开：名单可能已经过期一整段时间了，别让用户等 30 分钟才看到它自己修好。
     不 await —— 检测要 ssh 要出网，接口没必要陪着等，页面上"立即检测"是给想盯的人 */
  if (next.enabled && !st.enabled) void syncEgress({ by: '重新开启' }).catch(() => {});
  return egressStatus();
}

/* ── 同步一轮 ─────────────────────────────────────────────────────────── */

let inflight = null;

/**
 * 检测 → 比对 → 换白。
 *
 * apply=false 只检测不写（自动同步关掉时，手动点一下就是这样：让人看见当前
 * 出口是什么、会改哪一条，但不替他把名单改了）。
 */
export function syncEgress(opts = {}) {
  /* 定时与手动很容易撞在一起：并发跑两轮会互相删对方的条目 */
  if (inflight) return inflight;
  inflight = doSync(opts).finally(() => { inflight = null; });
  return inflight;
}

async function doSync({ apply, by = 'auto' } = {}) {
  const st = await loadState();
  const shouldApply = apply === undefined ? st.enabled : Boolean(apply);
  const now = new Date().toISOString();
  const base = { ...st, checkedAt: now };

  const det = await detectEgressIp();
  if (!det.ip) {
    /* 检测失败不动名单：旧 IP 可能还在用，删掉才是真的失守 */
    const next = {
      ...base,
      sources: det.sources || [],
      lastError: det.error || '检测出口 IP 失败',
      failStreak: st.failStreak + 1,
    };
    await saveState(next);
    return { ...(await egressStatus()), ok: false, applied: false, error: next.lastError };
  }

  const changed = Boolean(st.ip) && st.ip !== det.ip;
  const next = {
    ...base,
    ip: det.ip,
    via: det.via,
    place: det.place,
    sources: det.sources || [],
    failStreak: 0,
    lastError: '',
    changedAt: changed ? now : st.changedAt,
    history: st.history,
  };
  if (changed) {
    next.history = [{ at: now, from: st.ip, to: det.ip, by }, ...st.history].slice(0, HISTORY_MAX);
  }

  if (!isLocalConfigured()) {
    const err = '数据桥未配置（HERMES_LOCAL_HOST 为空），检测到了也写不进白名单';
    await saveState({ ...next, lastError: err, failStreak: st.failStreak + 1 });
    return { ...(await egressStatus()), ok: false, applied: false, error: err };
  }

  if (!shouldApply) {
    await saveState({ ...next, appliedIp: st.appliedIp });
    return {
      ...(await egressStatus()),
      ok: true,
      applied: false,
      changes: { added: [], removed: [], applied: false },
      expected: { add: det.ip, remove: st.appliedIp && st.appliedIp !== det.ip ? st.appliedIp : '' },
    };
  }

  const added = [];
  const removed = [];
  const errors = [];

  let list;
  try {
    list = await securityAllowList();
  } catch (e) {
    const err = `读白名单失败：${e.message}`;
    await saveState({ ...next, lastError: err, failStreak: st.failStreak + 1 });
    return { ...(await egressStatus()), ok: false, applied: false, error: err };
  }

  /* 先删旧的再加新的：反过来的话，中间那一刻名单里同时有两条自动条目，
     旧 IP 就多留了一个轮次的口子。删失败不算致命 —— 记下来，下一轮继续。 */
  for (const e of list.entries.filter(isManaged)) {
    if (e.value === det.ip) continue;
    try {
      await securityAllowSave(e.value, 'remove');
      removed.push(e.value);
    } catch (err) {
      errors.push(`删 ${e.value} 失败：${err.message}`);
    }
  }

  /* 这条已经在名单里就什么都不做 —— 尤其不能"顺手补个备注"：
     手工加的同值条目一旦被改成自动备注，下一轮换 IP 就会把它删掉，
     等于悄悄接手了人家的配置。 */
  const alreadyProtected = list.entries.some((e) => e.value === det.ip);
  if (!alreadyProtected) {
    try {
      await securityAllowSave(det.ip, 'add', NOTE);
      added.push(det.ip);
    } catch (err) {
      errors.push(`加 ${det.ip} 失败：${err.message}`);
    }
  }

  const error = errors.join('；');
  /* 写失败时不要谎报"白名单里是新的那个"：删旧的成功、加新的失败，
     那一刻名单里什么都没有，页面必须显示得出来 */
  const appliedIp = added.length || alreadyProtected ? det.ip : '';
  await saveState({ ...next, appliedIp, lastError: error });
  return {
    ...(await egressStatus()),
    ok: !error,
    applied: true,
    changes: { added, removed, applied: true },
    error,
  };
}

/* ── 定时器 ───────────────────────────────────────────────────────────── */

let timer = null;

/** 启动时挂上。与 index.js 里用量采样同一个写法：unref 掉，别拦着进程退出 */
export function startEgressSync() {
  if (timer) return;
  const tick = () => {
    syncEgress({ by: '定时检测' })
      .then((r) => {
        if (r.applied && r.changes?.added?.length) {
          console.log(`[egress] 出口 IP 已同步：${r.ip}（删 ${r.changes.removed.join(',') || '—'}）`);
        } else if (!r.ok) {
          console.warn('[egress] 本轮检测失败：', r.error || r.lastError);
        }
      })
      .catch((e) => console.warn('[egress] 检测异常：', e.message))
      .finally(() => {
        const st = state;
        if (st) {
          const nextAt = new Date(Date.now() + INTERVAL_MS).toISOString();
          if (st.nextAt !== nextAt) void saveState({ ...st, nextAt });
        }
      });
  };
  /* 启动先等 20 秒：开机瞬间出网、SSH、数据库都在抢带宽，这会儿测出来的
     超时只能说明"正在启动"，说明不了出口 IP 是什么 */
  const first = setTimeout(tick, 20_000);
  first.unref?.();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  console.log(`[egress] 已启用出口 IP 自动白名单，间隔 ${Math.round(INTERVAL_MS / 60000)} 分钟`);
}
