import { sshRun } from './ssh.js';

/* ────────────────────────────────────────────────────────────────────────
 * 硬盘 SMART 健康数据采集
 *
 * PVE 的 /nodes/{node}/disks/smart 只回一小部分字段（项目里此前只拿它取温度），
 * 健康度、通电时长、异常断电、累计读写这些全都没有。要拿全量只能上机跑
 * `smartctl -a -j`，所以这里经 SSH 采集并解析成结构化字段。
 *
 * 两条实践上的注意：
 *
 * 1) smartctl 的退出码是**位掩码**，设备存在告警时照样非 0（比如错误日志里
 *    有条目就置 bit6）。所以不能拿退出码判成败 —— 这里在远端补一句
 *    `echo SMART_RC=$?`，把码带回来做诊断，JSON 该解析照样解析。
 *
 * 2) NVMe 的 data_units_read/written 单位是「512 字节 × 1000」，直接当字节
 *    会差 512000 倍。实测这块盘 9374768 units → 4.80 TB，与此相符。
 * ──────────────────────────────────────────────────────────────────────── */

/** NVMe 一个 data unit 代表多少字节 */
const NVME_UNIT_BYTES = 512 * 1000;

/**
 * SMART 缓存 3 小时。
 * 定值这么长是有道理的：健康度、通电时长、累计读写都是慢变量，
 * 一天之内看不出变化；而 smartctl 每次都要把盘唤醒、跑完整套自检数据读取，
 * 对设备是实打实的打扰。3 小时一次足够跟上"盘在退化"这个量级的变化。
 */
const CACHE_MS = 3 * 60 * 60 * 1000;
let cache = { at: 0, key: '', value: null };

/** 最多采集几块盘：盘多时别让概览页被拖住 */
const MAX_DISKS = 6;

/**
 * 设备名会被拼进远端 shell 命令，必须先过白名单。
 * 只放行 /dev/ 下的简单名字（覆盖 /dev/sda、/dev/nvme0n1 这类），
 * 挡掉 ; && $() 之类的注入。
 */
function safeDev(dev) {
  const s = String(dev || '').trim();
  return /^\/dev\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function r2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

/** 取 ATA SMART 属性表里某个 ID 的原始值（raw 优先，其次归一化值） */
function attrRaw(attrs, id) {
  const a = attrs.find((x) => Number(x.id) === id);
  if (!a) return null;
  const raw = num(a.raw?.value ?? a.raw);
  return raw != null ? raw : num(a.value);
}

/**
 * NVMe critical_warning 位掩码。按 NVMe 规范逐位解码，
 * 界面上给的是人话而不是一个数字。
 */
const NVME_WARNING_BITS = [
  [0x01, '可用备用空间低于阈值'],
  [0x02, '温度超过阈值'],
  [0x04, 'NVM 子系统可靠性下降'],
  [0x08, '只读模式'],
  [0x10, '易失性存储备份失败'],
  [0x20, '持久内存区只读'],
];

function decodeCriticalWarning(raw) {
  const v = num(raw, 0) || 0;
  return {
    raw: v,
    flags: NVME_WARNING_BITS.filter(([bit]) => v & bit).map(([, text]) => text),
  };
}

/* ── NVMe 解析 ───────────────────────────────────────────────────────── */

function parseNvme(d, rc) {
  const h = d.nvme_smart_health_information_log || {};
  const used = num(h.percentage_used, num(d.endurance_used?.current_percent));
  const spare = num(h.available_spare, num(d.spare_available?.current_percent));
  const powerOnHours = num(h.power_on_hours, num(d.power_on_time?.hours));
  const readUnits = num(h.data_units_read);
  const writeUnits = num(h.data_units_written);
  const readBytes = readUnits == null ? null : readUnits * NVME_UNIT_BYTES;
  const writeBytes = writeUnits == null ? null : writeUnits * NVME_UNIT_BYTES;

  return {
    kind: 'nvme',
    passed: d.smart_status?.passed ?? null,
    healthPercent: used == null ? null : clampPct(100 - used),
    wearPercent: used == null ? null : clampPct(used),
    temperature: {
      current: num(h.temperature, num(d.temperature?.current)),
      opLimit: num(d.temperature?.op_limit_max),
      criticalLimit: num(d.temperature?.critical_limit_max),
      sensors: Array.isArray(h.temperature_sensors) ? h.temperature_sensors : null,
    },
    powerOnHours,
    powerCycles: num(h.power_cycles, num(d.power_cycle_count)),
    unsafeShutdowns: num(h.unsafe_shutdowns),
    readBytes,
    writeBytes,
    hostReads: num(h.host_reads),
    hostWrites: num(h.host_writes),
    mediaErrors: num(h.media_errors),
    errorLogEntries: num(h.num_err_log_entries),
    controllerBusyMinutes: num(h.controller_busy_time),
    tempWarningMinutes: num(h.warning_temp_time),
    tempCriticalMinutes: num(h.critical_comp_time),
    criticalWarning: decodeCriticalWarning(h.critical_warning),
    spare: {
      available: spare,
      threshold: num(h.available_spare_threshold, num(d.spare_available?.threshold_percent)),
    },
    nvmeVersion: d.nvme_version?.string ?? null,
    namespaces: num(d.nvme_number_of_namespaces),
    selfTest: d.nvme_self_test_log?.current_self_test_operation?.string ?? null,
    /** smartctl 原始退出码：非 0 不代表采集失败，只是设备有告警位 */
    smartctlExit: rc,
  };
}

function clampPct(v) {
  return Math.min(100, Math.max(0, v));
}

/* ── ATA / SATA 解析 ─────────────────────────────────────────────────── */

/* 值得单独拎出来的属性。ATA 没有统一标准，各家命名不同，
   所以按 ID 取（ID 是规范里定死的），名字只作展示。 */
const ATA_IDS = {
  5: { key: 'reallocatedSectors', label: '重映射扇区' },
  9: { key: 'powerOnHours', label: '通电时间' },
  12: { key: 'powerCycles', label: '通电次数' },
  174: { key: 'unsafeShutdowns', label: '异常断电' },
  194: { key: 'temperature', label: '温度' },
  202: { key: 'lifeRemainingPercent', label: '剩余寿命' },
  231: { key: 'ssdLifeLeftPercent', label: 'SSD 剩余寿命' },
  241: { key: 'lbasWritten', label: '累计写入 LBA' },
  242: { key: 'lbasRead', label: '累计读取 LBA' },
};

function parseAta(d, rc) {
  const attrs = d.ata_smart_attributes?.table || [];
  const blockSize = num(d.logical_block_size, 512);

  const extra = {};
  for (const [id, meta] of Object.entries(ATA_IDS)) {
    const v = attrRaw(attrs, Number(id));
    if (v != null) extra[meta.key] = v;
  }

  const powerOnHours = num(extra.powerOnHours);
  const readBytes = extra.lbasRead == null ? null : extra.lbasRead * blockSize;
  const writeBytes = extra.lbasWritten == null ? null : extra.lbasWritten * blockSize;

  // 剩余寿命：优先 202（原始值即百分比）；没有就退 231（归一化值）
  let healthPercent = null;
  if (extra.lifeRemainingPercent != null) healthPercent = clampPct(extra.lifeRemainingPercent);
  else if (extra.ssdLifeLeftPercent != null) healthPercent = clampPct(extra.ssdLifeLeftPercent);

  return {
    kind: 'ata',
    passed: d.smart_status?.passed ?? null,
    healthPercent,
    wearPercent: healthPercent == null ? null : clampPct(100 - healthPercent),
    temperature: {
      current: num(extra.temperature, num(d.temperature?.current)),
      opLimit: num(d.temperature?.op_limit_max),
      criticalLimit: num(d.temperature?.critical_limit_max),
      sensors: null,
    },
    powerOnHours,
    powerCycles: num(extra.powerCycles),
    unsafeShutdowns: num(extra.unsafeShutdowns),
    readBytes,
    writeBytes,
    hostReads: null,
    hostWrites: null,
    mediaErrors: null,
    errorLogEntries: null,
    controllerBusyMinutes: null,
    tempWarningMinutes: null,
    tempCriticalMinutes: null,
    criticalWarning: null,
    spare: null,
    reallocatedSectors: num(extra.reallocatedSectors),
    nvmeVersion: null,
    namespaces: null,
    selfTest: null,
    smartctlExit: rc,
    /** 原始属性表：ATA 盘信息量大，全量给出去让前端按需展示 */
    attrs: attrs.map((a) => ({
      id: num(a.id),
      name: String(a.name || ''),
      value: num(a.value),
      worst: num(a.worst),
      thresh: num(a.thresh),
      raw: num(a.raw?.value ?? a.raw),
      rawString: a.raw?.string ?? null,
      failed: a.when_failed && String(a.when_failed) !== '-' ? String(a.when_failed) : null,
    })),
  };
}

/* ── 采集 ─────────────────────────────────────────────────────────────── */

/**
 * 单块盘。`smartctl -a -j` 的 stdout 是完整 JSON；后面追加一行
 * SMART_RC=<退出码> 用来取回诊断用的退出码。
 */
async function readOne(host, dev) {
  const safe = safeDev(dev);
  if (!safe) return { dev, available: false, error: '设备名不合法，已跳过' };

  let out;
  try {
    // 结尾的 exit 0 不能省：smartctl 在设备有告警时非 0 退出，
    // 那会让 SSH 通道整体判失败，明明拿到了数据却当成错误丢掉。
    out = await sshRun(host, `smartctl -a -j '${safe}' 2>/dev/null; echo "SMART_RC=$?"`, {
      timeout: 20000,
    });
  } catch (err) {
    return { dev, available: false, error: `smartctl 执行失败：${err.message}` };
  }

  const lines = String(out || '').split('\n');
  let rc = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('SMART_RC=')) {
      rc = num(lines[i].slice('SMART_RC='.length));
      lines.splice(i, 1);
      break;
    }
  }
  const json = lines.join('\n').trim();
  if (!json) return { dev, available: false, error: `smartctl 无输出（退出码 ${rc}）` };

  let d;
  try {
    d = JSON.parse(json);
  } catch {
    return { dev, available: false, error: `smartctl 输出无法解析（退出码 ${rc}）` };
  }

  const proto = d.device?.protocol || d.device?.type || '';
  const kind = /nvme/i.test(proto) ? 'nvme' : /ata|sata|scsi/i.test(proto) ? 'ata' : 'unknown';
  const parsed = kind === 'nvme' ? parseNvme(d, rc) : kind === 'ata' ? parseAta(d, rc) : null;

  const base = {
    dev: safe,
    available: true,
    error: null,
    model: d.model_name || null,
    serial: d.serial_number || null,
    firmware: d.firmware_version || null,
    capacityBytes: num(d.user_capacity?.bytes, num(d.nvme_total_capacity)),
    rotationRate: num(d.rotation_rate),
    smartSupport: d.smart_support?.available ?? null,
    smartEnabled: d.smart_support?.enabled ?? null,
  };

  if (!parsed) {
    return { ...base, kind: 'unknown', passed: d.smart_status?.passed ?? null, healthPercent: null };
  }

  /* 派生量：都按"通电时长"折算，盘刚上电（0 小时）时无意义，返回 null */
  const hours = parsed.powerOnHours;
  const days = hours && hours > 0 ? hours / 24 : null;
  const perDayWrite = days && parsed.writeBytes != null ? parsed.writeBytes / days : null;
  const perDayRead = days && parsed.readBytes != null ? parsed.readBytes / days : null;

  /* 剩余寿命小时数：按已消耗百分比对通电时长线性外推。
     这是最朴素的估计——写入强度会变，仅作量级参考，界面上须标注为"按当前速度"。 */
  let lifeRemainingHours = null;
  if (parsed.wearPercent != null && parsed.wearPercent > 0 && hours) {
    lifeRemainingHours = Math.round(((100 - parsed.wearPercent) / parsed.wearPercent) * hours);
  }

  return {
    ...base,
    ...parsed,
    perDayWriteBytes: perDayWrite == null ? null : Math.round(perDayWrite),
    perDayReadBytes: perDayRead == null ? null : Math.round(perDayRead),
    lifeRemainingHours,
    sampledAt: Date.now(),
  };
}

/**
 * 采集一组盘的健康数据。
 *
 * @param {string} host PVE 母机地址；为空（演示模式）直接返回 null
 * @param {Array<{dev: string}>} disks 来自 /nodes/{node}/disks/list
 * @returns {Promise<{disks: Array, available: boolean, error: string|null}|null>}
 */
export async function collectSmart(host, disks) {
  if (!host) return null;

  const targets = (disks || [])
    .filter((d) => d && d.dev && d.type !== 'unknown')
    .slice(0, MAX_DISKS);

  const key = `${host}|${targets.map((d) => d.dev).join(',')}`;
  const now = Date.now();
  if (cache.key === key && now - cache.at < CACHE_MS) return cache.value;

  let value;
  if (!targets.length) {
    value = { disks: [], available: false, error: '没有可采集的磁盘' };
  } else {
    const results = await Promise.all(targets.map((d) => readOne(host, d.dev)));
    const ok = results.filter((r) => r.available);
    value = {
      disks: results,
      available: ok.length > 0,
      error: ok.length ? null : (results[0]?.error ?? 'SMART 数据不可用'),
    };
  }

  cache = { at: now, key, value };
  return value;
}

/** 设置变更后强制刷新 */
export function clearSmartCache() {
  cache = { at: 0, key: '', value: null };
}

/** 字节 → 人类可读。用 1000 进制：硬盘厂商标称与 SMART 计数都是十进制 */
export function humanBytes(v) {
  if (v == null || !Number.isFinite(v)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  return { value: r2(n), unit: units[i] };
}
