import { pool } from './connection.js';
import { BODY_MAX, normalizeType } from '../services/knowledge.js';

/* ── 值转换 ────────────────────────────────────────────────────────── */

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toIso = (value) => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const str = (value, max) => String(value ?? '').slice(0, max);
const text = (value) => String(value ?? '');
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** JSON 列在 MySQL 8 会被驱动解析成对象，在 MariaDB 里是字符串，两种都要兼容 */
const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
};

const toJson = (value) => JSON.stringify(value ?? null);

/** 助手对话的形状在库里不一定可靠（手工改过库、旧备份导入），读的时候兜一层 */
const aiLog = (value) => (value && Array.isArray(value.turns) ? value : { turns: [] });

/** DATE 列统一按 UTC 还原成 yyyy-mm-dd，与 power.js 里的 dateKey 对齐 */
const dayKey = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/* ── 明细表定义 ────────────────────────────────────────────────────── */
/* 每张表声明：库里怎么存（columns / toRow）、读出来怎么还原（fromRow）、
   以及在内存数据结构里的位置（get / set）。 */

const ENTITIES = [
  {
    name: 'todos',
    table: 'todos',
    orderBy: '`sort_order` ASC, `created_at` ASC',
    get: (d) => d.todos,
    set: (d, list) => {
      d.todos = list;
    },
    columns: ['id', 'text', 'done', 'priority', 'due', 'created_at', 'sort_order'],
    toRow: (t, i) => ({
      id: str(t.id, 48),
      text: str(t.text, 300),
      done: t.done ? 1 : 0,
      priority: str(t.priority || 'P2', 4),
      due: str(t.due, 40),
      created_at: toDate(t.createdAt),
      sort_order: i,
    }),
    fromRow: (r) => ({
      id: r.id,
      text: r.text,
      done: Boolean(r.done),
      priority: r.priority,
      due: r.due,
      createdAt: toIso(r.created_at),
    }),
  },
  {
    name: 'tickets',
    table: 'tickets',
    orderBy: '`sort_order` ASC, `created_at` ASC',
    get: (d) => d.tickets,
    set: (d, list) => {
      d.tickets = list;
    },
    columns: ['id', 'title', 'priority', 'status', 'project', 'section', 'owner', 'due', 'note', 'tags', 'checklist', 'archived_at', 'deleted_at', 'created_at', 'updated_at', 'sort_order'],
    toRow: (t, i) => ({
      id: str(t.id, 48),
      title: str(t.title, 200),
      priority: str(t.priority || 'P2', 4),
      status: str(t.status || 'todo', 16),
      project: str(t.project, 80),
      section: str(t.section, 120),
      owner: str(t.owner, 80),
      due: str(t.due, 40),
      note: text(t.note),
      tags: toJson(Array.isArray(t.tags) ? t.tags : []),
      checklist: toJson(Array.isArray(t.checklist) ? t.checklist : []),
      archived_at: toDate(t.archivedAt),
      deleted_at: toDate(t.deletedAt),
      created_at: toDate(t.createdAt),
      updated_at: toDate(t.updatedAt),
      sort_order: i,
    }),
    fromRow: (r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      status: r.status,
      project: r.project,
      section: r.section ?? '',
      owner: r.owner,
      due: r.due,
      note: r.note,
      tags: parseJson(r.tags, []),
      checklist: parseJson(r.checklist, []),
      archivedAt: toIso(r.archived_at),
      deletedAt: toIso(r.deleted_at),
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    }),
  },
  {
    name: 'groups',
    table: 'bookmark_groups',
    orderBy: '`sort_order` ASC',
    get: (d) => d.groups,
    set: (d, list) => {
      d.groups = list;
    },
    columns: ['id', 'name', 'sort_order'],
    toRow: (g, i) => ({
      id: str(g.id, 48),
      name: str(g.name, 40),
      sort_order: Number.isFinite(Number(g.order)) ? Number(g.order) : i,
    }),
    fromRow: (r) => ({ id: r.id, name: r.name, order: r.sort_order }),
  },
  {
    name: 'bookmarks',
    table: 'bookmarks',
    orderBy: '`sort_order` ASC',
    get: (d) => d.bookmarks,
    set: (d, list) => {
      d.bookmarks = list;
    },
    columns: ['id', 'name', 'url', 'group_id', 'note', 'color', 'sort_order'],
    toRow: (b, i) => ({
      id: str(b.id, 48),
      name: str(b.name, 60),
      url: str(b.url, 1000),
      group_id: str(b.group, 48),
      note: str(b.note, 120),
      color: str(b.color, 16),
      sort_order: i,
    }),
    fromRow: (r) => ({ id: r.id, name: r.name, url: r.url, group: r.group_id, note: r.note, color: r.color }),
  },
  {
    name: 'knowledge',
    table: 'knowledge_items',
    orderBy: '`sort_order` ASC',
    get: (d) => d.knowledge,
    set: (d, list) => {
      d.knowledge = list;
    },
    columns: [
      'id',
      'type',
      'title',
      'tags',
      'summary',
      'steps',
      'body',
      'body_plain',
      'pinned',
      'starred',
      'ai',
      'deleted_at',
      'updated_at',
      'sort_order',
    ],
    toRow: (k, i) => ({
      id: str(k.id, 48),
      type: normalizeType(k.type),
      title: str(k.title, 160),
      tags: toJson(Array.isArray(k.tags) ? k.tags : []),
      summary: str(k.summary, 400),
      // steps 是旧字段：搬成 body 之后不再写入，只原样带着，便于回滚
      steps: toJson(Array.isArray(k.steps) ? k.steps : []),
      body: str(k.body, BODY_MAX),
      body_plain: str(k.body_plain, BODY_MAX),
      pinned: k.pinned ? 1 : 0,
      starred: k.starred ? 1 : 0,
      ai: toJson(aiLog(k.ai)),
      deleted_at: toDate(k.deletedAt),
      updated_at: toDate(k.updatedAt),
      sort_order: i,
    }),
    fromRow: (r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      tags: parseJson(r.tags, []),
      summary: r.summary,
      steps: parseJson(r.steps, []),
      body: r.body == null ? '' : String(r.body),
      body_plain: r.body_plain == null ? '' : String(r.body_plain),
      // TINYINT 在不同驱动下可能是 0/1 也可能是 '0'/'1'，一律按数字判
      pinned: Number(r.pinned) === 1,
      starred: Number(r.starred) === 1,
      ai: aiLog(parseJson(r.ai, null)),
      deletedAt: toIso(r.deleted_at),
      updatedAt: toIso(r.updated_at),
    }),
  },
  {
    name: 'news',
    table: 'news_items',
    orderBy: '`sort_order` ASC',
    get: (d) => d.news?.items,
    set: (d, list) => {
      d.news.items = list;
    },
    columns: [
      'id',
      'title',
      'link',
      'source',
      'published_at',
      'summary',
      'tags',
      'score',
      'reason',
      'aihot_url',
      'sort_order',
    ],
    toRow: (n, i) => ({
      id: str(n.id, 64),
      title: text(n.title),
      link: n.link == null ? null : text(n.link),
      source: str(n.source, 80),
      published_at: toDate(n.publishedAt),
      summary: n.summary == null ? null : text(n.summary),
      tags: toJson(Array.isArray(n.tags) ? n.tags : []),
      /* score 为 null 表示来源还没给这条评分（新条目），是"未知"不是 0 分，
         所以不能兜成 0 —— 否则列表按分排序时未评分的条目会统统沉底 */
      score: Number.isFinite(n.score) ? Math.round(n.score) : null,
      reason: n.reason == null ? null : text(n.reason),
      /* 来源侧那一页。既是为了溯源（数据来自第三方，标出处是应该的），
         也是给读者一个"看完整上下文"的去处。可能为 null。 */
      aihot_url: n.aihotUrl == null ? null : str(n.aihotUrl, 200),
      sort_order: i,
    }),
    fromRow: (r) => ({
      id: r.id,
      title: r.title,
      link: r.link ?? '',
      source: r.source,
      publishedAt: toIso(r.published_at),
      summary: r.summary ?? '',
      tags: parseJson(r.tags, []),
      score: r.score == null ? null : Number(r.score),
      reason: r.reason ?? null,
      aihotUrl: r.aihot_url ?? null,
    }),
  },
];

/* ── 单行表定义 ────────────────────────────────────────────────────── */

const SINGLETONS = [
  {
    name: 'settings',
    table: 'app_settings',
    columns: ['id', 'payload', 'updated_at'],
    rows: (d) => [{ id: 1, payload: toJson(d.settings ?? {}), updated_at: toDate(d.settings?.updatedAt) ?? new Date(0) }],
  },
  {
    name: 'news_state',
    table: 'news_state',
    columns: ['id', 'updated_at', 'last_error', 'dropped_count'],
    rows: (d) => [
      {
        id: 1,
        updated_at: toDate(d.news?.updatedAt),
        last_error: d.news?.lastError == null ? null : String(d.news.lastError).slice(0, 1000),
        dropped_count: Number.isFinite(d.news?.dropped) ? Math.round(d.news.dropped) : 0,
      },
    ],
  },
  {
    name: 'news_hot',
    table: 'news_hot',
    columns: ['id', 'payload', 'updated_at'],
    rows: (d) => [{ id: 1, payload: toJson(d.news?.hot ?? null), updated_at: toDate(d.news?.hot?.updatedAt) }],
  },
  {
    name: 'news_daily',
    table: 'news_daily',
    columns: ['id', 'payload', 'updated_at'],
    rows: (d) => [{ id: 1, payload: toJson(d.news?.daily ?? null), updated_at: toDate(d.news?.daily?.updatedAt) }],
  },
  {
    /* token 用量。updatedAt 由 recordUsage 每次累加时刷新 ——
       指纹里带上它，界面上的数字变了才会触发写入 */
    name: 'ai_usage',
    table: 'ai_usage',
    columns: ['id', 'payload', 'updated_at'],
    rows: (d) => [{ id: 1, payload: toJson(d.aiUsage ?? null), updated_at: toDate(d.aiUsage?.updatedAt) }],
  },
  {
    name: 'energy_state',
    table: 'energy_state',
    columns: ['id', 'last_ts', 'last_watts', 'total_kwh', 'total_cost', 'eco_saved_kwh'],
    rows: (d) => [
      {
        id: 1,
        last_ts: d.energy?.lastTs == null ? null : Math.round(num(d.energy.lastTs)),
        last_watts: num(d.energy?.lastWatts),
        total_kwh: num(d.energy?.totalKwh),
        total_cost: num(d.energy?.totalCost),
        eco_saved_kwh: num(d.energy?.ecoSavedKwh),
      },
    ],
  },
  {
    name: 'energy_daily',
    table: 'energy_daily',
    columns: ['day', 'kwh', 'cost', 'eco_kwh', 'samples'],
    rows: (d) =>
      Object.keys(d.energy?.daily ?? {})
        .sort()
        .map((day) => {
          const v = d.energy.daily[day] ?? {};
          return { day, kwh: num(v.kwh), cost: num(v.cost), eco_kwh: num(v.ecoKwh), samples: Math.round(num(v.samples)) };
        }),
  },
  {
    name: 'meter_daily',
    table: 'meter_daily',
    columns: ['day', 'counter_in', 'counter_out'],
    rows: (d) =>
      Object.keys(d.energy?.meterDaily ?? {})
        .sort()
        .map((day) => {
          const v = d.energy.meterDaily[day] ?? {};
          return { day, counter_in: num(v.in), counter_out: num(v.out) };
        }),
  },
  {
    name: 'energy_monthly',
    table: 'energy_monthly',
    columns: ['month', 'kwh', 'cost', 'eco_kwh', 'days'],
    rows: (d) =>
      Object.keys(d.energy?.monthly ?? {})
        .sort()
        .map((month) => {
          const v = d.energy.monthly[month] ?? {};
          return {
            month,
            kwh: num(v.kwh),
            cost: num(v.cost),
            eco_kwh: num(v.ecoKwh),
            days: Math.round(num(v.days)),
          };
        }),
  },
  {
    name: 'mode_samples',
    table: 'mode_samples',
    columns: ['mode', 'band', 'hours', 'kwh'],
    /* 复合主键 (mode, band)，必须显式声明：去重默认只认第一列，
       按 mode 去重会把 eco 下除首个 band 以外的行整条丢掉 ——
       实测攒出来的 eco/light 时长因此一直写不进库。 */
    key: ['mode', 'band'],
    rows: (d) =>
      Object.keys(d.energy?.modeStats ?? {})
        .sort()
        .map((mode) =>
          Object.keys(d.energy.modeStats[mode] ?? {})
            .sort()
            .map((band) => {
              const v = d.energy.modeStats[mode][band] ?? {};
              return { mode, band, hours: num(v.hours), kwh: num(v.kwh) };
            }),
        )
        .flat(),
  },
];

/* ── 写入 ──────────────────────────────────────────────────────────── */

const warnedDuplicate = new Set();

async function replaceTable(conn, table, columns, rows, keyCols) {
  await conn.query(`DELETE FROM \`${table}\``);
  if (!rows.length) return;

  /* 去重键默认取第一列（多数表是单列主键）。复合主键的表必须用 def.key
     显式列出全部键列 —— 否则只按第一列比对，同前缀的其余行会被整条丢掉。
     历史 JSON 数据里出现过重复主键（老版本热点 ID 截断导致），这层兜底
     保证迁移不会被历史脏数据打断。 */
  const cols = keyCols?.length ? keyCols : [columns[0]];
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const k = cols.map((c) => String(row[c])).join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(row);
  }
  if (unique.length !== rows.length && !warnedDuplicate.has(table)) {
    warnedDuplicate.add(table);
    console.warn(`[db] ${table} 有 ${rows.length - unique.length} 条主键重复，已保留首条`);
  }
  rows = unique;

  const colSql = columns.map((c) => `\`${c}\``).join(', ');
  // 单条 INSERT 的参数上限是 65535，按列数切块保持安全余量
  const chunkSize = Math.max(1, Math.floor(5000 / columns.length));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const valuesSql = slice.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const params = slice.flatMap((row) => columns.map((c) => row[c]));
    await conn.query(`INSERT INTO \`${table}\` (${colSql}) VALUES ${valuesSql}`, params);
  }
}

/* 上一次成功落库时的数据指纹：内容没变的表直接跳过，避免每次写请求全表重写 */
const savedSignature = new Map();

export function resetSignatures() {
  savedSignature.clear();
}

/** 刚从库里读出来的数据，指纹等于库里现状，不需要立刻回写一遍 */
export function primeSignatures(data) {
  for (const step of buildPlan(data)) savedSignature.set(step.name, step.signature);
}

function buildPlan(data) {
  const steps = [];
  const add = (name, table, columns, rows, key) => {
    const signature = JSON.stringify(rows);
    if (savedSignature.get(name) === signature) return;
    steps.push({ name, signature, table, columns, rows, key });
  };

  for (const def of ENTITIES) add(def.name, def.table, def.columns, (def.get(data) || []).map(def.toRow), def.key);
  for (const def of SINGLETONS) add(def.name, def.table, def.columns, def.rows(data), def.key);
  return steps;
}

/**
 * 把内存中的数据结构整体同步到 MySQL。
 * 全过程跑在一个事务里：要么全部写入，要么全部回滚，读端不会看到中间状态。
 */
export async function sync(data) {
  const steps = buildPlan(data);
  if (!steps.length) return 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const step of steps) await replaceTable(conn, step.table, step.columns, step.rows, step.key);
    await conn.commit();
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  } finally {
    conn.release();
  }

  // 提交成功后才更新指纹，失败时下次会重试同一批数据
  for (const step of steps) savedSignature.set(step.name, step.signature);
  return steps.length;
}

/* ── 读取 ──────────────────────────────────────────────────────────── */

async function loadEnergy(base = {}) {
  const [[state]] = await pool.query('SELECT * FROM `energy_state` WHERE `id` = 1');
  const [dailyRows] = await pool.query('SELECT * FROM `energy_daily` ORDER BY `day` ASC');

  const daily = {};
  for (const r of dailyRows) {
    daily[dayKey(r.day)] = { kwh: num(r.kwh), cost: num(r.cost), ecoKwh: num(r.eco_kwh), samples: Math.round(num(r.samples)) };
  }

  const [meterRows] = await pool.query('SELECT * FROM `meter_daily` ORDER BY `day` ASC');
  const meterDaily = {};
  for (const r of meterRows) {
    meterDaily[dayKey(r.day)] = { in: num(r.counter_in), out: num(r.counter_out) };
  }

  const [modeRows] = await pool.query('SELECT * FROM `mode_samples`');
  const modeStats = {};
  for (const r of modeRows) {
    const mode = String(r.mode || '');
    if (!mode) continue;
    modeStats[mode] ||= {};
    modeStats[mode][String(r.band || 'unknown')] = { hours: num(r.hours), kwh: num(r.kwh) };
  }

  const [monthRows] = await pool.query('SELECT * FROM `energy_monthly` ORDER BY `month` ASC');
  const monthly = {};
  for (const r of monthRows) {
    monthly[String(r.month)] = { kwh: num(r.kwh), cost: num(r.cost), ecoKwh: num(r.eco_kwh), days: Math.round(num(r.days)) };
  }

  return {
    lastTs: state?.last_ts == null ? (base.lastTs ?? null) : Number(state.last_ts),
    lastWatts: state ? num(state.last_watts) : num(base.lastWatts),
    daily,
    meterDaily,
    monthly,
    modeStats,
    totalKwh: state ? num(state.total_kwh) : num(base.totalKwh),
    totalCost: state ? num(state.total_cost) : num(base.totalCost),
    ecoSavedKwh: state ? num(state.eco_saved_kwh) : num(base.ecoSavedKwh),
  };
}

/**
 * 读取全部数据。以种子数据结构为骨架，逐表回填，
 * 这样旧库缺字段时也能自动补齐（与早期 JSON 版本行为一致）。
 */
export async function loadAll(base) {
  const data = structuredClone(base);

  for (const def of ENTITIES) {
    const [rows] = await pool.query(`SELECT * FROM \`${def.table}\` ORDER BY ${def.orderBy}`);
    def.set(data, rows.map(def.fromRow));
  }

  const [[settingsRow]] = await pool.query('SELECT `payload` FROM `app_settings` WHERE `id` = 1');
  if (settingsRow) {
    const stored = parseJson(settingsRow.payload, {});
    // 早期版本把 HA 令牌存进过库，读到就地丢弃，免得它被原样写回去继续扩散
    const ha = { ...data.settings.ha, ...(stored.ha || {}) };
    delete ha.token;
    // 老配置用的是扁平字段（powerEntity）：必须让位，否则 seed 里的示例插座会盖过去，
    // 万一两者实体不同就会静默用错设备。
    if (!stored.ha?.sockets && (stored.ha?.powerEntity || stored.ha?.counterEntity)) ha.sockets = [];
    // 这几个是嵌套配置，必须逐层合并：浅合并会让"后来新增的字段"被库里的旧对象整体盖掉，
    // 例如给 ha 补上 counterEntity 后，老库里的 ha 会把新字段吞掉。
    data.settings = {
      ...data.settings,
      ...stored,
      theme: { ...data.settings.theme, ...(stored.theme || {}) },
      pve: { ...data.settings.pve, ...(stored.pve || {}) },
      power: { ...data.settings.power, ...(stored.power || {}) },
      ha,
      news: { ...data.settings.news, ...(stored.news || {}), aihot: { ...data.settings.news.aihot, ...(stored.news?.aihot || {}) } },
      // 同 store.js 的 normalize：backup.cos 是嵌套对象，必须逐层合并
      backup: {
        ...data.settings.backup,
        ...(stored.backup || {}),
        cos: { ...data.settings.backup.cos, ...(stored.backup?.cos || {}) },
      },
    };
  }

  const [[newsState]] = await pool.query(
    'SELECT `updated_at`, `last_error`, `dropped_count` FROM `news_state` WHERE `id` = 1',
  );
  if (newsState) {
    data.news.updatedAt = toIso(newsState.updated_at);
    data.news.lastError = newsState.last_error ?? null;
    data.news.dropped = Number(newsState.dropped_count) || 0;
  }

  /* 快照类的（热点榜、日报）读回来就是读回来，不做逐层合并：
     它们是"某一时刻的一张榜 / 一期日报"，拿旧字段去补新的只会让
     位次、故事线、分区对不上。解不出来就整份放弃，宁可显示空。 */
  const [[newsHot]] = await pool.query('SELECT `payload` FROM `news_hot` WHERE `id` = 1');
  if (newsHot?.payload) {
    const hot = parseJson(newsHot.payload, null);
    if (hot && Array.isArray(hot.topics)) data.news.hot = hot;
  }

  const [[newsDaily]] = await pool.query('SELECT `payload` FROM `news_daily` WHERE `id` = 1');
  if (newsDaily?.payload) {
    const daily = parseJson(newsDaily.payload, null);
    if (daily?.report) data.news.daily = daily;
  }

  /* token 用量：是纯粹的累加量，没有需要逐层合并的配置，读回来整份替换即可。
     解析失败时**保持种子里的空壳，不要覆盖成空** —— 它是历史记录，
     一次坏数据把它清零就再也找不回来了。 */
  const [[aiUsageRow]] = await pool.query('SELECT `payload` FROM `ai_usage` WHERE `id` = 1');
  const aiUsage = parseJson(aiUsageRow?.payload, null);
  if (aiUsage && typeof aiUsage === 'object') data.aiUsage = aiUsage;

  data.energy = await loadEnergy(data.energy);
  return data;
}

/** 是否是一个全新的库（没有写过设置，说明从没初始化过） */
export async function isEmpty() {
  const [[row]] = await pool.query('SELECT COUNT(*) AS `n` FROM `app_settings`');
  return Number(row?.n ?? 0) === 0;
}

/** 各表行数，用于健康检查与启动日志 */
export async function tableStats() {
  const tables = [...ENTITIES.map((e) => e.table), ...SINGLETONS.map((s) => s.table)];
  const stats = {};
  for (const table of new Set(tables)) {
    const [[row]] = await pool.query(`SELECT COUNT(*) AS \`n\` FROM \`${table}\``);
    stats[table] = Number(row?.n ?? 0);
  }
  return stats;
}
