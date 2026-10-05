import https from 'node:https';
import http from 'node:http';
import { collectSmart, clearSmartCache } from './smart.js';
import { collectNet, clearNetCache } from './net.js';

/* ────────────────────────────────────────────────────────────────────────
 * PVE 配置解析：优先使用「设置」页里保存的配置，其次读 .env
 * ──────────────────────────────────────────────────────────────────────── */
export function pveConfig(settings) {
  const p = settings?.pve || {};
  const envTls = process.env.PVE_VERIFY_TLS;
  return {
    host: (p.host || process.env.PVE_HOST || '').trim(),
    port: Number(p.port || process.env.PVE_PORT || 8006),
    tokenId: (p.tokenId || process.env.PVE_TOKEN_ID || '').trim(),
    tokenSecret: (p.tokenSecret || process.env.PVE_TOKEN_SECRET || '').trim(),
    node: (p.node || process.env.PVE_NODE || '').trim(),
    verifyTls: typeof p.verifyTls === 'boolean' ? p.verifyTls : envTls === 'true',
  };
}

export function isConfigured(settings) {
  const c = pveConfig(settings);
  return Boolean(c.host && c.tokenId && c.tokenSecret);
}

/**
 * PVE 的部分报错文案会把人带偏，最典型的是「节点不存在」——
 * 它返回的是 "hostname lookup 'pve-master' failed - failed to get address info for: ..."，
 * 看起来完全是 DNS 故障，实际只是节点名写错了。这里换成人能看懂的说法。
 */
function friendlyPveError(message) {
  const text = String(message || '').trim();
  const noNode = /hostname lookup '([^']+)' failed/.exec(text);
  if (noNode) return `PVE 上没有叫「${noNode[1]}」的节点，请检查「默认节点」是否填错`;
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/.test(text)) return `连不上 PVE 主机（${text}）`;
  if (/ECONNREFUSED/.test(text)) return 'PVE 拒绝了连接，请确认 8006 端口可达、地址与协议（https）正确';
  if (/certificate|self-signed|UNABLE_TO_VERIFY/i.test(text)) return '证书校验失败，自签证书请在设置里打开「信任自签证书」';
  if (/401|permission|Authentication/i.test(text)) return '认证失败，请检查 Token ID 与密钥，并确认该 Token 已被授予权限（PVE 默认新建 Token 没有权限）';
  return text || '未知错误';
}

/* ────────────────────────────────────────────────────────────────────────
 * 极简 HTTP 客户端（node:https，支持自签证书）
 * ──────────────────────────────────────────────────────────────────────── */
function request(cfg, apiPath, { method = 'GET', timeout = 8000, body = null } = {}) {
  const mod = cfg.port === 443 ? https : https; // PVE 默认 https
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: cfg.host,
        port: cfg.port,
        path: `/api2/json${apiPath}`,
        method,
        rejectUnauthorized: cfg.verifyTls,
        headers: {
          Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        timeout,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 4 * 1024 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            return reject(new Error(`PVE 返回了非 JSON 内容（HTTP ${res.statusCode}）`));
          }
          if (res.statusCode >= 400) {
            const msg = parsed?.errors
              ? JSON.stringify(parsed.errors)
              : parsed?.message || `HTTP ${res.statusCode}`;
            return reject(new Error(msg));
          }
          resolve(parsed?.data ?? parsed);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('连接 PVE 超时')));
    req.on('error', reject);
    if (body) req.write(new URLSearchParams(body).toString());
    req.end();
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * 小缓存，避免演示页短时间重复打 PVE
 * ──────────────────────────────────────────────────────────────────────── */
const cacheMap = new Map();
async function cached(key, ttlMs, producer) {
  const hit = cacheMap.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await producer();
  cacheMap.set(key, { at: now, value });
  return value;
}
export function clearPveCache() {
  cacheMap.clear();
  clearSmartCache();
  clearNetCache();
}

/* ────────────────────────────────────────────────────────────────────────
 * 演示数据：无 PVE 配置时使用，保证界面完整可用
 *   同一 15 秒窗口内结果稳定，跨窗口缓慢漂移，看起来像真的在跑
 * ──────────────────────────────────────────────────────────────────────── */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86400000;

/* 演示用：以 2026-01-01 为基准日，根分区每天涨约 0.3GB */
const REF_DAY = Math.floor(Date.parse('2026-01-01T00:00:00Z') / DAY_MS);

function demoRootRatio(at) {
  const days = at / DAY_MS - REF_DAY;
  return Math.min(0.94, Math.max(0.2, 0.52 + days * 0.0006));
}

function demoRootUsed(at, total) {
  return total * demoRootRatio(at);
}

function loadCurve(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  // 白天（10-23 点）负载高一些，深夜低
  const daytime = Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2));
  return 0.24 + 0.34 * daytime;
}

function demoStatus(node, at = Date.now()) {
  const bucket = Math.floor(at / 15000);
  const r = rng(hashSeed(`${node}:status:${bucket}`));
  const base = loadCurve(new Date(at)) + (r() - 0.5) * 0.07;
  const cpu = Math.min(0.97, Math.max(0.04, base));
  const memTotal = 32 * 1024 ** 3;
  const memUsed = memTotal * (0.52 + 0.16 * cpu + (r() - 0.5) * 0.03);
  const rootTotal = 512 * 1024 ** 3;
  const rootUsed = demoRootUsed(at, rootTotal) + (r() - 0.5) * 512 * 1024 ** 2;
  const swapTotal = 8 * 1024 ** 3;

  return {
    cpu,
    memory: { used: memUsed, total: memTotal, free: memTotal - memUsed },
    rootfs: { used: rootUsed, total: rootTotal, free: rootTotal - rootUsed, avail: rootTotal - rootUsed },
    swap: { used: swapTotal * 0.12, total: swapTotal, free: swapTotal * 0.88 },
    loadavg: [cpu * 4, cpu * 3.6, cpu * 3.2].map((n) => n.toFixed(2)),
    uptime: Math.floor(at / 1000) % (86400 * 23) + 86400 * 6,
    iowait: Math.max(0.2, cpu * 4 + (r() - 0.5) * 1.5),
    cpuinfo: { cores: 8, cpus: 16, sockets: 1, model: 'Intel(R) Xeon(R) E-2288G CPU @ 3.70GHz', mhz: '3700' },
    pvestatd: { status: 'running' },
  };
}

function demoSensors(node, at = Date.now()) {
  const st = demoStatus(node, at);
  const r = rng(hashSeed(`${node}:sensors:${Math.floor(at / 30000)}`));
  const cpuTemp = 38 + st.cpu * 42 + (r() - 0.5) * 2.5;
  return {
    temperatures: [
      { name: 'CPU Package', value: cpuTemp, chip: 'coretemp-isa-0000', kind: 'cpu' },
      { name: 'System Board', value: 32 + st.cpu * 8, chip: 'acpitz-acpi-0', kind: 'board' },
      { name: 'NVMe 963 (Samsung 970 EVO)', value: 39 + st.cpu * 18, chip: 'nvme-pci-0100', kind: 'disk' },
      { name: 'SATA 0 (WD Red 4TB)', value: 33 + st.cpu * 5, chip: 'drivetemp-scsi-0-0', kind: 'disk' },
      { name: 'SATA 1 (WD Red 4TB)', value: 34 + st.cpu * 5, chip: 'drivetemp-scsi-1-0', kind: 'disk' },
    ],
    // 演示环境不虚构整机功率传感器读数，让功耗走估算模型，
    // 这样切换节能模式时数值会真实变化（真实硬件极少暴露 PSU 功率）
    power: [],
  };
}

function demoDisks() {
  const gb = 1024 ** 3;
  return [
    { dev: '/dev/nvme0n1', model: 'Samsung SSD 970 EVO Plus 1TB', type: 'nvme', size: 1000 * gb, used: 1000 * gb * 0.62, health: 'PASSED', wearout: 6 },
    { dev: '/dev/sda', model: 'WDC WD40EFRX-68N32N0', type: 'sata', size: 4 * 1000 * gb, used: 4 * 1000 * gb * 0.71, health: 'PASSED', wearout: null },
    { dev: '/dev/sdb', model: 'WDC WD40EFRX-68N32N0', type: 'sata', size: 4 * 1000 * gb, used: 4 * 1000 * gb * 0.68, health: 'PASSED', wearout: null },
  ];
}

const TIMEFRAMES = {
  hour: { points: 60, stepMs: 60 * 1000 },
  day: { points: 72, stepMs: 20 * 60 * 1000 },
  week: { points: 84, stepMs: 2 * 60 * 60 * 1000 },
  month: { points: 120, stepMs: 6 * 60 * 60 * 1000 },
  year: { points: 120, stepMs: 3 * DAY_MS },
};

function demoSeries(node, timeframe = 'hour') {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES.hour;
  const now = Date.now();
  const out = [];
  const r = rng(hashSeed(`${node}:rrd:${timeframe}`));
  const ioScale = TIMEFRAMES.hour.stepMs ? 1 : 1;

  for (let i = tf.points - 1; i >= 0; i -= 1) {
    const time = now - i * tf.stepMs;
    const d = new Date(time);
    const base = loadCurve(d) + (r() - 0.5) * 0.08;
    const cpu = Math.min(0.97, Math.max(0.03, base));
    const memTotal = 32 * 1024 ** 3;
    const rootTotal = 512 * 1024 ** 3;
    const rootUsed = demoRootUsed(time, rootTotal) + (r() - 0.5) * 200 * 1024 ** 2;
    out.push({
      time: Math.floor(time / 1000),
      cpu,
      iowait: Math.max(0.1, cpu * 4 + (r() - 0.5) * 1.2),
      loadavg: cpu * 4,
      memused: memTotal * (0.5 + 0.18 * cpu),
      maxmem: memTotal,
      rootused: rootUsed,
      roottotal: rootTotal,
      netin: (1.5 + cpu * 9 + r() * 2) * ioScale * 1024 ** 2,
      netout: (0.8 + cpu * 5 + r() * 1.6) * ioScale * 1024 ** 2,
      diskread: Math.max(0, (2 + cpu * 90 + r() * 30) * ioScale * 1024 ** 2),
      diskwrite: Math.max(0, (1 + cpu * 55 + r() * 20) * ioScale * 1024 ** 2),
    });
  }
  return out;
}

function demoGuests() {
  return {
    qemu: [
      { vmid: 100, name: 'web-01', status: 'running', cpu: 0.21, maxmem: 4 * 1024 ** 3, mem: 2.6 * 1024 ** 3, uptime: 86400 * 12 },
      { vmid: 101, name: 'web-02', status: 'running', cpu: 0.34, maxmem: 4 * 1024 ** 3, mem: 3.6 * 1024 ** 3, uptime: 86400 * 12 },
      { vmid: 102, name: 'db-01', status: 'running', cpu: 0.12, maxmem: 8 * 1024 ** 3, mem: 5.1 * 1024 ** 3, uptime: 86400 * 40 },
      { vmid: 110, name: 'win11-lab', status: 'stopped', cpu: 0, maxmem: 8 * 1024 ** 3, mem: 0, uptime: 0 },
    ],
    lxc: [
      { vmid: 200, name: 'monitor', status: 'running', cpu: 0.08, maxmem: 2 * 1024 ** 3, mem: 1.2 * 1024 ** 3, uptime: 86400 * 40 },
      { vmid: 201, name: 'dns', status: 'running', cpu: 0.01, maxmem: 512 * 1024 ** 2, mem: 180 * 1024 ** 2, uptime: 86400 * 40 },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * 真实 PVE 数据归一化
 * ──────────────────────────────────────────────────────────────────────── */
function num(v, fallback = 0) {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 容忍多种 sensors 返回结构，递归提取温度 / 功耗 */
export function parseSensors(payload) {
  // PVE 的 thermalstate 给的就是 sensors 原始文本，先分流到文本解析器
  if (typeof payload === 'string') return parseSensorsText(payload);

  const temperatures = [];
  const power = [];

  const push = (bucket, name, value, chip, kind) => {
    if (!Number.isFinite(value) || value <= 0) return;
    bucket.push({ name, value, chip, kind });
  };

  const classify = (label) => {
    const l = label.toLowerCase();
    // 风扇转速（RPM）本项目读不到、也不展示，这里显式归到 other 丢弃。
    // 不能只是删掉这条分支——"CPU Fan" 这类标签会往下掉进温度规则里被误判。
    if (/fan|rpm/.test(l)) return 'other';
    if (/power|watt|pwr/.test(l)) return 'power';
    if (/temp|°c|package|composite|core/.test(l)) return 'temp';
    return 'other';
  };

  const walk = (node, chip, keyHint) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, chip, keyHint));
      return;
    }
    if (typeof node !== 'object') return;

    // 形态 A：{ name, type, value }
    if (node.name !== undefined && (node.value !== undefined || node.temp !== undefined)) {
      const value = num(node.value ?? node.temp, NaN);
      const label = String(node.name);
      const chipName = node.chip || chip || '';
      const kind = node.type ? String(node.type).toLowerCase() : classify(label);
      if (/temp|thermal/.test(kind)) push(temperatures, label, value, chipName, guessKind(label));
      else if (/power/.test(kind)) push(power, label, value, chipName);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (value == null) continue;
      if (typeof value === 'string' || typeof value === 'number') {
        // 形态 B：sensors -j 的 xxx_input
        if (/_input$/.test(key)) {
          const label = key.replace(/_input$/, '').replace(/_/g, ' ');
          const group = (keyHint || '').toLowerCase();
          if (/fan/.test(group)) continue; // fan*_input 通道不采集
          const kind = /power|curr/.test(group) ? 'power' : 'temp';
          const v = num(value, NaN);
          if (kind === 'power') push(power, label, v, chip);
          else push(temperatures, label, v, chip, guessKind(label));
        }
        continue;
      }
      walk(value, chip || key, key);
    }
  };

  walk(payload, '', '');
  return { temperatures, power };
}

function guessKind(label) {
  const l = label.toLowerCase();
  if (/package|core|cpu|tctl|tdie/.test(l)) return 'cpu';
  if (/nvme|composite|ssd|drive|hdd|sata/.test(l)) return 'disk';
  if (/board|acpi|system|mb|chipset|pch/.test(l)) return 'board';
  return 'other';
}

/* 温度归类：优先看「芯片名」，认不出来才退回按标签猜。
 *
 * 只按标签分类在这台机器上会直接失效：主板（acpitz）和网卡（r8169 mdio）
 * 报的读数都叫 `temp1`，标签完全一样，但一个是主板、一个不是。
 * 所以芯片名才是可靠信号：
 *   coretemp-isa-0000     → CPU（Package id 0 + Core 0..N）
 *   acpitz-acpi-0         → 主板（ACPI 热区，本机唯一能代表主板/机箱的温度点）
 *   nvme-pci-0100         → 硬盘
 *   r8169_...-mdio-0      → 网卡，落到 other
 */
function chipKind(chip, label = '') {
  const c = String(chip || '').toLowerCase();
  if (/coretemp|k10temp|zenpower|cpu_thermal|soc_thermal|pkg_temp/.test(c)) return 'cpu';
  if (/acpitz|nct[0-9]|it87|w83|f718|sch5|smsc/.test(c)) return 'board';
  if (/nvme|drivetemp|scsi|sata|ssd|hdd/.test(c)) return 'disk';
  return guessKind(label);
}

/* sensors 里大量读数只叫 temp1 / Sensor 1，光看标签分不清是主板还是网卡——
   本机 acpitz（主板）和 r8169 网卡报的都叫 temp1，界面上就是两行一模一样的
   "temp1"，谁也认不出。标签是这种占位名时，用芯片名换一个能读懂的说法。 */
const GENERIC_SENSOR_LABEL = /^(temp|sensor|thermal|tctl|tdie|tcc)\s*\d*$/i;

const CHIP_LABELS = [
  [/acpitz|nct[0-9]|it87|f718|sch5/, 'ACPI 热区'],
  [/coretemp|k10temp|zenpower/, 'CPU'],
  [/nvme/, 'NVMe'],
  [/drivetemp|scsi|sata/, 'SATA 盘'],
  [/r8169|mdio|igb|e1000|igc|rtl8/, '板载网卡'],
  [/amdgpu|i915|radeon/, '核显'],
];

function friendlySensorName(chip, label) {
  if (!GENERIC_SENSOR_LABEL.test(String(label).trim())) return label;
  const c = String(chip || '').toLowerCase();
  for (const [re, name] of CHIP_LABELS) {
    if (re.test(c)) return name;
  }
  return label;
}

/**
 * 解析 `sensors` 命令的原始文本。
 *
 * PVE 节点状态里有个 thermalstate 字段，内容就是这段文本：
 *   coretemp-isa-0000
 *   Package id 0:  +41.0°C  (high = +80.0°C, crit = +100.0°C)
 *   Core 0:        +32.0°C  (high = +80.0°C, crit = +100.0°C)
 *   acpitz-acpi-0
 *   temp1:         +27.8°C
 *
 * 三个必须踩对的地方：
 *   1. 只取冒号后的**第一个**温度。后面括号里的 high/crit 是阈值不是读数，
 *      按行抓数字会把 100°C 当成实测值报出去。
 *   2. 不能用「这行有没有冒号」来分辨芯片行：芯片名自己就带冒号
 *      （r8169_0_300:00-mdio-0），而阈值续行反倒一个冒号都没有
 *      （"(crit = +94.8°C)"）。判据换成——能匹配 `标签: +数字` 的才是读数行，
 *      含 `=` 或 `(` 的是阈值续行（丢弃），其余才当芯片行。
 *   3. 数值后面那个度符号在 PVE 返回里是乱码（`Â°`），所以只认数字，
 *      不依赖任何单位字符。
 */
export function parseSensorsText(text) {
  if (typeof text !== 'string') return { temperatures: [], power: [] };

  const readings = [];
  let chip = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const reading = /^([^:]+):\s*([+-]\d+(?:\.\d+)?)/.exec(line);
    if (reading) {
      const label = reading[1].trim();
      const value = Number(reading[2]);
      // 上限卡 150：sensors 里 high/crit 动辄 65261.8，漏进来会毁掉整张卡片
      if (Number.isFinite(value) && value > 0 && value < 150) readings.push({ label, value, chip });
      continue;
    }
    if (line.includes('=') || line.includes('(')) continue; // 阈值续行
    chip = line;
  }

  /* 先数一遍同一芯片下有几路占位标签。NVMe 会报 Sensor 1 / Sensor 2，
     如果都简化成「NVMe」，既分不清是哪一路、key 还会重复（React 会告警）。
     所以只有同芯片下重名时才把原标签的序号补回来：→ NVMe 1 / NVMe 2。
     单路的（ACPI 热区、板载网卡）就不加那个多余的 1。 */
  const dupCount = new Map();
  for (const r of readings) {
    if (!GENERIC_SENSOR_LABEL.test(r.label)) continue;
    const key = `${r.chip}|${friendlySensorName(r.chip, r.label)}`;
    dupCount.set(key, (dupCount.get(key) || 0) + 1);
  }

  const temperatures = readings.map((r) => {
    let name = r.label;
    if (GENERIC_SENSOR_LABEL.test(r.label)) {
      const base = friendlySensorName(r.chip, r.label);
      const ordinal = /(\d+)\s*$/.exec(r.label);
      name = dupCount.get(`${r.chip}|${base}`) > 1 && ordinal ? `${base} ${ordinal[1]}` : base;
    }
    return { name, value: r.value, chip: r.chip, kind: chipKind(r.chip, r.label) };
  });

  return { temperatures, power: [] };
}

function normalizeStatus(node, raw) {
  return {
    node,
    cpu: num(raw?.cpu),
    memory: {
      used: num(raw?.memory?.used),
      total: num(raw?.memory?.total),
      free: num(raw?.memory?.free),
    },
    rootfs: {
      used: num(raw?.rootfs?.used),
      total: num(raw?.rootfs?.total),
      free: num(raw?.rootfs?.free),
      avail: num(raw?.rootfs?.avail),
    },
    swap: {
      used: num(raw?.swap?.used),
      total: num(raw?.swap?.total),
    },
    loadavg: Array.isArray(raw?.loadavg) ? raw.loadavg.map((v) => String(v)) : ['0', '0', '0'],
    uptime: num(raw?.uptime),
    iowait: num(raw?.iowait),
    cpuinfo: {
      cores: num(raw?.cpuinfo?.cores, 1),
      cpus: num(raw?.cpuinfo?.cpus, 1),
      sockets: num(raw?.cpuinfo?.sockets, 1),
      model: raw?.cpuinfo?.model || '未知 CPU',
      mhz: raw?.cpuinfo?.mhz || '',
    },
    pvestatd: { status: raw?.pvestatd?.status || 'unknown' },
  };
}

function normalizeSeries(rows) {
  return (rows || [])
    .map((r) => ({
      time: num(r.time),
      cpu: num(r.cpu),
      iowait: num(r.iowait),
      loadavg: num(r.loadavg),
      memused: num(r.memused),
      maxmem: num(r.maxmem),
      rootused: num(r.rootused),
      roottotal: num(r.roottotal),
      netin: num(r.netin),
      netout: num(r.netout),
      diskread: r.diskread === undefined ? null : num(r.diskread),
      diskwrite: r.diskwrite === undefined ? null : num(r.diskwrite),
    }))
    .filter((r) => r.time > 0);
}

/* ────────────────────────────────────────────────────────────────────────
 * 对外接口
 * ──────────────────────────────────────────────────────────────────────── */
export async function listNodes(settings) {
  const cfg = pveConfig(settings);
  if (!isConfigured(settings)) {
    return [{ node: 'pve-demo', status: 'online', cpu: 0.31, maxcpu: 16, mem: 20 * 1024 ** 3, maxmem: 32 * 1024 ** 3, uptime: 86400 * 6, demo: true }];
  }
  const rows = await cached('nodes', 10000, () => request(cfg, '/nodes'));
  return (rows || []).map((n) => ({ ...n, demo: false }));
}

/**
 * 只取节点状态里的 CPU 利用率。给用电采样器标注负载档用。
 * 复用 `status:${node}` 这个缓存键（4 秒），和概览页共享同一份缓存，
 * 所以采样器这一分钟一次调用基本不会真的多打 PVE。
 * 取不到返回 null —— 负载只影响统计分档，拿不到不该影响电量累计。
 */
export async function getNodeLoad(settings) {
  if (!isConfigured(settings)) return null;
  const cfg = pveConfig(settings);
  const available = (await listNodes(settings)).map((n) => n.node).filter(Boolean);

  const want = String(cfg.node || '').trim();
  const node = want && available.includes(want) ? want : available[0];
  if (!node) return null;

  const status = await cached(`status:${node}`, 4000, () => request(cfg, `/nodes/${node}/status`));
  const cpu = Number(status?.cpu);
  return Number.isFinite(cpu) ? cpu : null;
}

export async function getOverview(settings, { node, timeframe = 'hour' } = {}) {
  const cfg = pveConfig(settings);
  const live = isConfigured(settings);

  if (!live) {
    const n = node || 'pve-demo';
    const status = demoStatus(n);
    return {
      mode: 'demo',
      node: n,
      warning: '尚未配置 Proxmox 连接，当前展示的是演示数据。可在「设置 → Proxmox 连接」中填入 PVE 地址与 API Token。',
      status,
      sensors: demoSensors(n),
      disks: demoDisks(),
      diskHealth: null, // 演示模式没有母机可连，硬盘详情整块不展示
      net: null,
      series: demoSeries(n, timeframe),
      guests: demoGuests(),
      templateCount: 0,
      timeframe,
    };
  }

  /* 先拿节点列表再拼 URL：配置里的节点名可能已经不存在了（主机改名、手填写错、
     跨集群迁移都会遇到）。PVE 对不存在的节点返回的是 "hostname lookup 'x' failed"，
     看上去像 DNS 故障，很容易把排查方向带偏，所以这里显式校验并回退，
     而不是拿一个来路不明的名字去硬打接口。 */
  const available = (await listNodes(settings)).map((n) => n.node).filter(Boolean);
  if (!available.length) throw new Error('这个 API Token 读不到任何节点，请检查它的权限');

  const want = String(node || cfg.node || '').trim();
  const resolvedNode = want && available.includes(want) ? want : available[0];
  const nodeWarning =
    want && !available.includes(want)
      ? `设置的默认节点「${want}」在 PVE 上不存在，本次已自动改用「${resolvedNode}」。当前可用节点：${available.join('、')}。到「设置 → Proxmox 连接」改正后这条提示会消失。`
      : null;

  let fetched;
  try {
    fetched = await Promise.all([
      cached(`status:${resolvedNode}`, 4000, () => request(cfg, `/nodes/${resolvedNode}/status`)),
      cached(`disks:${resolvedNode}`, 60000, () => request(cfg, `/nodes/${resolvedNode}/disks/list`).catch(() => [])),
      cached(`rrd:${resolvedNode}:${timeframe}`, 30000, () =>
        request(cfg, `/nodes/${resolvedNode}/rrddata?timeframe=${timeframe}&cf=AVERAGE`).catch(() => []),
      ),
      cached(`qemu:${resolvedNode}`, 15000, () => request(cfg, `/nodes/${resolvedNode}/qemu`).catch(() => [])),
      cached(`lxc:${resolvedNode}`, 15000, () => request(cfg, `/nodes/${resolvedNode}/lxc`).catch(() => [])),
    ]);
  } catch (err) {
    throw new Error(`读取节点「${resolvedNode}」失败：${friendlyPveError(err.message)}`);
  }
  const [statusRaw, disksRaw, seriesRaw, qemuRaw, lxcRaw] = fetched;

  /* 温度从 /status 的 thermalstate 里取。
     以前这里打的是 /nodes/{node}/sensors —— 那个接口在 PVE 上并不存在，
     返回 "Method not implemented"，又被 .catch(() => []) 吞掉，
     于是温度永远是空的、界面上也看不到任何报错。
     thermalstate 就在已经请求过的 /status 里，顺带还省掉一次 HTTP。 */
  const sensors = parseSensors(statusRaw?.thermalstate);
  const disks = (disksRaw || []).map((d) => ({
    dev: d.devpath || d.dev || '—',
    model: d.model || d.vendor || '未知磁盘',
    type: d.type || 'unknown',
    size: num(d.size),
    used: num(d.used),
    health: d.health || 'UNKNOWN',
    wearout: d.wearout === undefined ? null : num(d.wearout),
  }));

  /* 这里以前会把 SMART 读到的盘温也推进 sensors.temperatures，现已去掉。
     两个原因：
     1) 重复 —— /status 的 thermalstate 本来就带盘温（这块盘是 Composite/NVMe 1/2），
        再叠一条 "/dev/nvme0n1 (SMART)" 只是同一个温度的第二个名字；
     2) 它会抢走「最高」徽章 —— SMART 报 49°C、thermalstate 报 47.9°C，
        于是温度卡顶上挂的是硬盘，而真正该被盯的 CPU/主板反而不显眼。
        盘温该看的阈值（45/55）也比 CPU（65/80）低一档，混在"最高"里比不出高低。
     盘温仍由 thermalstate 提供，且硬盘健康卡里有更完整的读数。 */

  const series = normalizeSeries(seriesRaw);
  const ioAvailable = series.some((p) => p.diskread !== null || p.diskwrite !== null);

  /* 完整 SMART 健康数据。上面那次 disks/smart 只够拿温度，健康度、通电时长、
     异常断电、累计读写都得在母机上跑 smartctl —— 走 SSH，见 services/smart.js。
     SSH 不通或没装 smartctl 时返回 null，这里也不抛错：
     少一块硬盘详情可以接受，概览页整个打不开不行。 */
  let diskHealth = null;
  try {
    diskHealth = await collectSmart(cfg.host, disks);
  } catch {
    diskHealth = null;
  }

  /* 网卡流量。同样走 SSH（PVE 没有逐口计数器的接口），
     失败时返回 null，不拖累整页。 */
  let net = null;
  try {
    net = await collectNet(cfg.host);
  } catch {
    net = null;
  }

  return {
    mode: 'live',
    node: resolvedNode,
    warning: nodeWarning,
    status: normalizeStatus(resolvedNode, statusRaw),
    sensors,
    disks,
    diskHealth,
    net,
    series,
    ioAvailable,
    guests: {
      /* 模板不是"停着的机器"，是拿来克隆的镜像：它永远 stopped、占着 VMID、
         也会拖慢列表。PVE 在 /nodes/{node}/qemu 里给模板带 template: 1
         （LXC 同样有 template 字段），这里直接筛掉。
         注意 qm list 不区分模板，别拿它来验证筛没筛干净。 */
      qemu: (qemuRaw || [])
        .filter((g) => !isTemplate(g))
        .map((g) => ({ vmid: g.vmid, name: g.name, status: g.status, cpu: num(g.cpu), maxmem: num(g.maxmem), mem: num(g.mem), uptime: num(g.uptime) })),
      lxc: (lxcRaw || [])
        .filter((g) => !isTemplate(g))
        .map((g) => ({ vmid: g.vmid, name: g.name, status: g.status, cpu: num(g.cpu), maxmem: num(g.maxmem), mem: num(g.mem), uptime: num(g.uptime) })),
    },
    /** 被筛掉的模板数量：界面上要让人知道列表不是"少读了"，而是有意排除 */
    templateCount: (qemuRaw || []).filter(isTemplate).length + (lxcRaw || []).filter(isTemplate).length,
    timeframe,
  };
}

/**
 * PVE 的模板标记。qemu 与 lxc 都给 template 字段，
 * 但取值可能是数字 1 或字符串 "1"，所以宽松判断。
 */
function isTemplate(g) {
  const v = g?.template;
  return v === 1 || v === '1' || v === true;
}

/** 容量增长趋势：用 week 序列做线性回归，给出 GB/天 与预计可用天数 */
export async function getGrowth(settings, node, usedRatioNow) {
  const overview = await getOverview(settings, { node, timeframe: 'week' });
  const pts = (overview.series || []).filter((p) => p.rootused > 0 && p.roottotal > 0);
  if (pts.length < 6) {
    return { perDayBytes: 0, daysLeft: null, samples: pts.length, available: false };
  }
  const t0 = pts[0].time;
  const xs = pts.map((p) => (p.time - t0) / 86400);
  const ys = pts.map((p) => p.rootused);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num2 += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num2 / den; // bytes / day
  const total = pts[pts.length - 1].roottotal;
  const used = pts[pts.length - 1].rootused;
  const free = Math.max(0, total - used);
  const daysLeft = slope > 1024 * 1024 ? free / slope : null;
  return {
    perDayBytes: slope,
    daysLeft,
    samples: n,
    available: true,
    usedRatio: usedRatioNow ?? used / total,
  };
}
