import http from 'node:http';
import https from 'node:https';

/* ────────────────────────────────────────────────────────────────────────
 * Home Assistant 数据源
 * ────────────────────────────────────────────────────────────────────────
 * 把米家智能插座的实测读数接进来，替代按 CPU 利用率估算的功耗模型。
 *
 *   当前整机功耗   ← 所有启用插座的电功率之和（W，瞬时值）
 *   用电量         ← 对求和后的功率做时间积分（见 power.js）
 *
 * 插座是可扩展的一组配置（settings.ha.sockets），换插座、加插座都只是
 * 改这个列表，不影响任何统计口径：
 *   · 加一个插座  → 功率自动并入求和，用电量自动跟着涨
 *   · 换一个插座  → 改那一行的实体即可，历史数据不受影响
 *   · 某个插座坏了 → 把它的「启用」关掉，其余照常统计
 *
 * 注意：这块排插（cuco.plug.v3）的「耗电量」累计读数属性是坏的，
 * 所以累计读数只是可选字段，只有所有插座都提供了可用的累计读数时才会采用。
 *
 * 前置条件：HA 侧已通过 Xiaomi Home 集成接入插座；
 * 令牌只从环境变量 HA_TOKEN 读（见 .env），不落库。
 * ──────────────────────────────────────────────────────────────────────── */

/** 兼容旧配置：没有 sockets 时用来兜底的环境变量 */
const LEGACY_POWER_ENV = 'HA_POWER_ENTITY';
const LEGACY_COUNTER_ENV = 'HA_COUNTER_ENTITY';

function socketEntry(raw, index) {
  return {
    id: String(raw?.id || `socket_${index + 1}`),
    name: String(raw?.name || '').trim() || `插座 ${index + 1}`,
    powerEntity: String(raw?.powerEntity || '').trim(),
    counterEntity: String(raw?.counterEntity || '').trim(),
    enabled: raw?.enabled !== false,
  };
}

/**
 * 规范化插座列表：丢掉没填功率实体的行，给缺 ID / 名称的补默认值。
 * 旧版本只有单个扁平字段（powerEntity），这里自动拼成单元素列表，
 * 所以升级后不需要用户重新配置。
 */
export function normalizeSockets(ha) {
  const raw = Array.isArray(ha?.sockets) ? ha.sockets : [];
  const list = raw.map(socketEntry).filter((s) => s.powerEntity);
  if (list.length) return list;

  const legacyPower = String(ha?.powerEntity || process.env[LEGACY_POWER_ENV] || '').trim();
  if (!legacyPower) return [];
  return [
    {
      id: 'socket_1',
      name: '主插座',
      powerEntity: legacyPower,
      counterEntity: String(ha?.counterEntity || process.env[LEGACY_COUNTER_ENV] || '').trim(),
      enabled: true,
    },
  ];
}

export function haConfig(settings) {
  const h = settings?.ha || {};
  const envTls = process.env.HA_VERIFY_TLS;
  return {
    url: String(h.url || process.env.HA_URL || 'http://127.0.0.1:8123')
      .trim()
      .replace(/\/+$/, ''),
    // 令牌只认环境变量：settings 是要落库、会被备份/导出/回显的，
    // 密钥一旦进去就等于跟着数据到处走，所以这里不给它留后门。
    token: String(process.env.HA_TOKEN || '').trim(),
    sockets: normalizeSockets(h),
    verifyTls: typeof h.verifyTls === 'boolean' ? h.verifyTls : envTls === 'true',
  };
}

export function isHaConfigured(settings) {
  const c = haConfig(settings);
  return Boolean(c.url && c.token && c.sockets.some((s) => s.enabled));
}

/**
 * HA 的报错同样容易把人带偏，这里换成能直接照着修的说法。
 */
function friendlyHaError(err, entityId) {
  const text = String(err?.message || err || '').trim();
  if (/ECONNREFUSED/i.test(text)) return 'HA 拒绝了连接，确认地址与端口（默认 http://127.0.0.1:8123）';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return `连不上 Home Assistant（${text}）`;
  if (/ETIMEDOUT|timeout/i.test(text)) return '访问 Home Assistant 超时，检查地址是否可达';
  if (/401|unauthorized/i.test(text)) return '令牌无效或已过期，请到 HA「个人资料 → 长期访问令牌」重新生成';
  if (/404/.test(text)) return `实体 ${entityId} 不存在，请核对实体 ID`;
  return text || '未知错误';
}

/* ── 极简 HTTP 客户端 ─────────────────────────────────────────────────── */
function request(cfg, apiPath, { timeout = 6000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(`${cfg.url}${apiPath}`);
    } catch {
      reject(new Error(`HA 地址不合法：${cfg.url}`));
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        rejectUnauthorized: cfg.verifyTls,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: 'application/json',
        },
        timeout,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > maxBytes) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error('401 Unauthorized'));
          if (res.statusCode === 404) return reject(new Error('404 Not Found'));
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('返回内容不是合法 JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function toNumber(state) {
  if (state === null || state === undefined) return null;
  const text = String(state).trim();
  // HA 在实体不可用时把状态写成这两个字符串，别把它们当成 0
  if (!text || text === 'unknown' || text === 'unavailable' || text === 'None') return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

/** 读单个实体的状态与属性 */
export async function readEntity(cfg, entityId, { timeout = 6000 } = {}) {
  const data = await request(cfg, `/api/states/${encodeURIComponent(entityId)}`, { timeout });
  return {
    entityId,
    state: data?.state ?? null,
    value: toNumber(data?.state),
    unit: data?.attributes?.unit_of_measurement ?? null,
    friendlyName: data?.attributes?.friendly_name ?? null,
    lastUpdated: data?.last_updated ?? null,
  };
}

/* ── 实体候选（供设置页做「选一选」而不是手填）───────────────────────── */

/** 功率 / 电量实体的识别：优先看 device_class，其次退回单位 */
const POWER_UNITS = new Set(['W', 'kW', 'mW']);
const ENERGY_UNITS = new Set(['Wh', 'kWh', 'MWh']);
/** 只有会随时间累积/采样的量才是"读数"；没有 state_class 的多半是设置项 */
const READING_STATE_CLASSES = new Set(['measurement', 'total', 'total_increasing']);

function classify(states) {
  const power = [];
  const energy = [];
  for (const s of states) {
    const attrs = s.attributes || {};
    const unit = attrs.unit_of_measurement;
    const dc = attrs.device_class;
    const sc = attrs.state_class;

    // 只收 sensor 域：number / select 这些是设备的设置项，
    // 比如「最大功率限制 保护阈值」单位也是 W，但它是阈值不是实测功耗。
    if (!String(s.entity_id).startsWith('sensor.')) continue;
    // 再要求带 state_class，滤掉那些同样叫 W 却没有读数语义的实体
    if (!READING_STATE_CLASSES.has(sc)) continue;

    const item = {
      entityId: s.entity_id,
      name: attrs.friendly_name || s.entity_id,
      unit: unit || '',
      deviceClass: dc || '',
      value: toNumber(s.state),
      // 同设备分组用：xiaomi_home 的 friendly_name 是「设备名  服务 属性」，
      // 用连续两个空格切开就能拿到设备名；其它集成拿不到就归到「其它」。
      group: String(attrs.friendly_name || '').split(/\s{2,}/)[0].trim() || '其它',
    };
    if (dc === 'power' || POWER_UNITS.has(unit)) power.push(item);
    else if (dc === 'energy' || ENERGY_UNITS.has(unit)) energy.push(item);
  }
  const byName = (a, b) => a.group.localeCompare(b.group, 'zh') || a.name.localeCompare(b.name, 'zh');
  power.sort(byName);
  energy.sort(byName);
  return { power, energy };
}

/** 拉取 HA 全部实体并按「可作功率用 / 可作累计电量用」分类 */
export async function listEntityOptions(settings, { timeout = 10000 } = {}) {
  const cfg = haConfig(settings);
  if (!cfg.token) throw new Error('服务端没有配置环境变量 HA_TOKEN，请在 .env 里补上并重启服务');

  let states;
  try {
    states = await request(cfg, '/api/states', { timeout, maxBytes: 8 * 1024 * 1024 });
  } catch (err) {
    throw new Error(friendlyHaError(err, '/api/states'));
  }
  if (!Array.isArray(states)) throw new Error('HA 返回的实体列表不是数组');
  const { power, energy } = classify(states);
  return {
    url: cfg.url,
    total: states.length,
    power,
    energy,
    /** 当前配置里已在用的实体，前端可以据此标记 */
    inUse: cfg.sockets.flatMap((s) => [s.powerEntity, s.counterEntity]).filter(Boolean),
  };
}

/**
 * 一次性拉齐所有启用插座的功率与（可选）累计读数。
 *
 * 任何一项失败都不抛异常——功耗面板不该因为 HA 挂了就整页报错，
 * 而是回退到原来的估算模型。
 *
 * 只要有一个启用插座读不到功率，整体就判为失败（watts = null）：
 * 少算电量比不算是更隐蔽的错误。某个插座长期不靠谱就把它关掉。
 */
export async function haReadings(settings, { timeout = 6000 } = {}) {
  const cfg = haConfig(settings);
  const enabled = cfg.sockets.filter((s) => s.enabled);

  const result = {
    ok: false,
    configured: isHaConfigured(settings),
    watts: null,
    sockets: [],
    counterKwh: null,
    counterAllPresent: false,
    lastUpdated: null,
    error: null,
  };

  if (!cfg.token) {
    result.error = '服务端没有配置环境变量 HA_TOKEN';
    return result;
  }
  if (!enabled.length) {
    result.error = '还没有配置任何插座，请到设置页添加';
    return result;
  }

  const specs = [];
  for (const s of enabled) {
    specs.push({ socketId: s.id, kind: 'power', entityId: s.powerEntity });
    if (s.counterEntity) specs.push({ socketId: s.id, kind: 'counter', entityId: s.counterEntity });
  }

  const settled = await Promise.allSettled(specs.map((sp) => readEntity(cfg, sp.entityId, { timeout })));

  const byId = new Map(
    enabled.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        powerEntity: s.powerEntity,
        counterEntity: s.counterEntity,
        watts: null,
        counterKwh: null,
        ok: false,
        error: null,
      },
    ]),
  );

  const errors = [];
  settled.forEach((item, i) => {
    const sp = specs[i];
    const sock = byId.get(sp.socketId);

    if (item.status === 'rejected') {
      // 累计读数只是诊断项，读不到不算故障
      if (sp.kind === 'power') {
        const msg = friendlyHaError(item.reason, sp.entityId);
        sock.error = msg;
        errors.push(`${sock.name}：${msg}`);
      }
      return;
    }

    const { value, lastUpdated } = item.value;
    if (sp.kind === 'power') {
      sock.watts = value;
      sock.ok = value !== null;
      if (value === null) {
        sock.error = '当前没有有效读数';
        errors.push(`${sock.name}：功率实体当前没有有效读数`);
      } else if (!result.lastUpdated) {
        result.lastUpdated = lastUpdated;
      }
    } else {
      sock.counterKwh = value;
    }
  });

  result.sockets = enabled.map((s) => byId.get(s.id));

  const powers = result.sockets.map((s) => s.watts);
  result.ok = powers.length > 0 && powers.every((v) => v !== null);
  result.watts = result.ok ? powers.reduce((a, b) => a + b, 0) : null;

  // 累计读数：必须每个启用插座都配了、且都读到了有效值，才认为可以求和采用
  const counters = result.sockets.map((s) => s.counterKwh);
  result.counterAllPresent = result.sockets.every((s) => s.counterEntity) && counters.every((v) => v !== null);
  result.counterKwh = result.counterAllPresent ? counters.reduce((a, b) => a + b, 0) : null;

  result.error = errors.length ? errors.join('；') : null;
  return result;
}
