#!/usr/bin/env node
'use strict';
/**
 * 个人工作台 · Hermes 数据桥（hwb-bridge）
 *
 * 定位：工作台自己的只读数据面。由工作台后端通过 SSH 以「一次进程、一个 JSON」
 *       的方式调用，不监听端口、不提供 HTTP、不影响 Hermes 网关。
 *
 * 为什么要有这一层：
 *   · 智能办公需要的用量 / 待办 / 配置 / 技能 / 记忆 / 进化 / MCP / 值守 / 边界守望
 *     都是 Hermes 主机上的本地文件与脚本，网关 API 没有这些接口；
 *   · 这些数据必须精确（用量按天分摊、安全按 24h 窗口），所以只能在本机读；
 *   · 读文件、连 sqlite、跑探针的代码放在 Hermes 主机上执行最省往返，
 *     但代码归属工作台仓库（server/remote/），随工作台一起版本化、一起部署。
 *
 * 与 agent_office 的关系：数据聚合逻辑从它的 server.js 合并而来，但已彻底去掉
 *   HTTP 服务、静态托管、登录会话、反向代理与前端页面；这里只保留只读取数与
 *   少量需要人工授权的动作（边界守望审批、拾贝抓取），不再有第二个网页入口。
 *
 * 调用协议（stdin 一个 JSON，stdout 一个 JSON）：
 *   {"path":"/local/usage"}                       只读
 *   {"path":"/local/security/profile","query":{"ip":"1.2.3.4"}}
 *   {"path":"/local/scrape","method":"POST","body":{...}}
 *   {"path":"/public/agents"}
 *   {"path":"/__ping"}                            自检（版本 / 路径 / 凭证状态）
 * 输出：{"ok":true,"status":200,"data":<接口原样 JSON>}
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { execFile, spawn, execSync } = require('child_process');

const ROOT = __dirname;
const GATEWAY = new URL(process.env.HERMES_GATEWAY || 'http://127.0.0.1:8642');

/* ---------- 网关凭证：只在本机进程内使用 ---------- */
function loadApiKey() {
  const fromEnv = (process.env.API_SERVER_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, from: 'env API_SERVER_KEY' };
  const envPath = process.env.HERMES_ENV || path.join(os.homedir(), '.hermes', '.env');
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    const m = text.match(/^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return { key: m[1].replace(/^["']|["']$/g, ''), from: envPath };
  } catch (_) { /* 以无凭证模式继续：只读文件类接口仍可用 */ }
  return { key: '', from: '(未找到)' };
}
const CRED = loadApiKey();
const API_KEY = CRED.key;

/* ---------- 供 handleLocal 复用的最小 HTTP 适配 ---------- */
function clientIp(req) {
  const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try { resolve(text ? JSON.parse(text) : {}); } catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ============================================================
 * 以下为从 agent_office 合并进来的数据聚合层（只读）
 *   数据来源：Hermes 安装目录、~/.hermes 下的真实文件 + 网关接口
 *   只输出白名单字段，并对疑似密钥/口令做脱敏
 * ============================================================ */
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const INSTALL_DIR = process.env.HERMES_INSTALL || '/usr/local/lib/hermes-agent';
/* 本服务自己落盘的数据目录（不在静态根目录内，HTTP 访问不到） */
const HARVESTER_DIR = process.env.AO_DATA_DIR || '/var/lib/agent-office';
const SKILL_DIRS = [
  { dir: path.join(HERMES_HOME, 'skills'), source: '用户安装', label: '~/.hermes/skills' },
  { dir: path.join(INSTALL_DIR, 'skills'), source: '内置', label: 'hermes-agent/skills' },
];
const CACHE_TTL_MS = 30000;
const _cache = new Map();

function cached(key, fn) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.val);
  return Promise.resolve(fn()).then((val) => { _cache.set(key, { at: now, val }); return val; });
}

/* 进程真实启动时间（epoch 秒）：/proc/<pid>/stat 第 22 字段（时钟滴答）+ /proc/stat btime */
function procStartEpoch(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = parseInt(fields[19], 10);            // 22 - 3
    const btime = parseInt((readTextSafe('/proc/stat').match(/^btime\s+(\d+)/m) || [])[1], 10);
    const hz = 100;                                         // 常见 CLK_TCK
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return 0;
    return btime + startTicks / hz;
  } catch (_) { return 0; }
}

function readTextSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function statSafe(p) { try { return fs.statSync(p); } catch (_) { return null; } }

/* 脱敏：口令 / token / 私钥 / API Key */
function redact(text) {
  return String(text)
    .replace(/(密码|口令|password|passwd|pwd|token|secret|api[_\- ]?key)\s*[:：=]?\s*\S+/gi, '$1=***')
    .replace(/\bsk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
    .replace(/MIIB[A-Za-z0-9+/=]{20,}/g, 'MIIB***（已脱敏）');
}

/* 调网关（服务端持凭证） */
function gwGet(pathname) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: GATEWAY.hostname, port: GATEWAY.port || 80, path: pathname, method: 'GET',
      headers: API_KEY ? { authorization: 'Bearer ' + API_KEY } : {},
    }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(8000, () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/* 往网关 POST（拾贝的意图解析走这里；失败一律 reject，由调用方回退） */
function gwPostJson(pathname, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = GATEWAY.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      Accept: 'application/json',
    }, API_KEY ? { authorization: 'Bearer ' + API_KEY } : {});
    const req = mod.request({
      hostname: GATEWAY.hostname, port: GATEWAY.port || 80, path: pathname, method: 'POST', headers,
    }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          return reject(new Error('网关 HTTP ' + r.statusCode + ' ' + body.slice(0, 120)));
        }
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('网关返回不是 JSON')); }
      });
    });
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('网关响应超时')));
    req.on('error', (e) => reject(e));
    req.end(data);
  });
}

/* 遍历目录收集 SKILL.md */
function walkSkills(dir, source, out, depth, label, base) {
  if (depth > 6 || out.length > 800) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walkSkills(full, source, out, depth + 1, label, base); continue; }
    if (e.name !== 'SKILL.md') continue;
    const text = readTextSafe(full).slice(0, 4000);
    const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
    const meta = {};
    if (fm) {
      /* 支持 YAML 块标量（description: | 的多行写法），否则描述会被解析成 "|" */
      const lines = fm[1].split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const m = lines[i].match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim();
        const indent = (lines[i].match(/^\s*/) || [''])[0].length;
        if (/^[|>][-+]?$/.test(val)) {
          const cont = [];
          while (i + 1 < lines.length) {
            const nxt = lines[i + 1];
            if (!nxt.trim()) break;
            if ((nxt.match(/^\s*/) || [''])[0].length <= indent) break;
            cont.push(nxt.trim());
            i += 1;
          }
          val = cont.join(' ');
        }
        meta[key] = val.replace(/^["']|["']$/g, '').trim();
      }
    }
    const rel = path.relative(base, full).split(path.sep);
    const st = statSafe(full);
    out.push({
      name: meta.name || rel[0],
      description: meta.description || '',
      version: meta.version || '',
      category: rel.length > 2 ? rel.slice(0, -2).join('/') : '未分类',
      source,
      path: label + '/' + rel.join('/'),
      mtime: st ? Math.round(st.mtimeMs / 1000) : 0,
    });
  }
}

function skillsPayload() {
  const items = [];
  for (const s of SKILL_DIRS) walkSkills(s.dir, s.source, items, 0, s.label, s.dir);
  const counts = {};
  items.forEach((s) => { counts[s.source] = (counts[s.source] || 0) + 1; });
  const days = {};
  items.forEach((s) => {
    if (!s.mtime) return;
    const d = new Date(s.mtime * 1000).toISOString().slice(0, 10);
    days[d] = (days[d] || 0) + 1;
  });
  return { count: items.length, counts, days, items };
}

function memoriesPayload() {
  const out = { files: [], items: [] };
  for (const name of ['MEMORY.md', 'USER.md']) {
    const p = path.join(HERMES_HOME, 'memories', name);
    const st = statSafe(p);
    if (!st) continue;
    out.files.push({ name, bytes: st.size, mtime: Math.round(st.mtimeMs / 1000) });
    const entries = readTextSafe(p).split(/^\s*§\s*$/m).map((s) => s.trim()).filter(Boolean);
    entries.forEach((text, i) => {
      out.items.push({ source: name, index: i + 1, chars: text.length, text: redact(text) });
    });
  }
  out.total = out.items.length;
  return out;
}

function evolutionPayload() {
  const state = readJsonSafe(path.join(HERMES_HOME, 'gateway_state.json')) || {};
  const receiptsDir = path.join(HERMES_HOME, 'logs', 'update_receipts');
  let receipts = [];
  try {
    receipts = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.json') && f !== 'latest.json')
      .map((f) => readJsonSafe(path.join(receiptsDir, f))).filter(Boolean);
  } catch (_) { /* 无更新记录 */ }
  const latest = readJsonSafe(path.join(receiptsDir, 'latest.json'));
  if (latest && !receipts.some((r) => r.started_at === latest.started_at)) receipts.push(latest);

  const snapsDir = path.join(HERMES_HOME, 'backups', 'config');
  let snapshots = [];
  try {
    snapshots = fs.readdirSync(snapsDir).map((f) => {
      const st = statSafe(path.join(snapsDir, f));
      return { name: f, bytes: st ? st.size : 0, at: st ? Math.round(st.mtimeMs / 1000) : 0,
               kind: f.includes('.pre-setup.') ? '初始化前' : '配置良好快照' };
    }).sort((a, b) => b.at - a.at);
  } catch (_) { /* 无备份 */ }

  const starts = readTextSafe(path.join(HERMES_HOME, 'gateway-starts.log'))
    .split('\n').map((s) => parseFloat(s)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  const skills = skillsPayload();
  const cfg = readTextSafe(path.join(HERMES_HOME, 'config.yaml'));

  return {
    current: {
      version: state.code_version || (latest && latest.post_update && latest.post_update.version) || '',
      sha: (state.code_sha || '').slice(0, 8),
      updated_at: (latest && latest.finished_at) || '',
      config_schema: (cfg.match(/^_config_version:\s*(\d+)/m) || [])[1] || '',
      install_path: INSTALL_DIR,
    },
    updates: receipts.map((r) => ({
      started_at: r.started_at, finished_at: r.finished_at, outcome: r.outcome,
      from: (r.pre_update && (r.pre_update.version + ' (' + r.pre_update.short_sha + ')')) || '',
      to: (r.post_update && (r.post_update.version + ' (' + r.post_update.short_sha + ')')) || '',
      duration_s: Math.round(((Date.parse(r.finished_at) - Date.parse(r.started_at)) || 0) / 1000),
      steps: (r.steps || []).map((s) => ({ name: s.name, ok: !!s.ok, detail: redact(s.detail || '') })),
      restart: r.gateway_restart ? (r.gateway_restart.restarted_services || []).join(', ') : '',
    })).sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at)),
    config_snapshots: snapshots,
    gateway_restarts: { count: starts.length, first: starts[0] || 0, last: starts[starts.length - 1] || 0 },
    capability: { skills: skills.count, skills_counts: skills.counts, skill_days: skills.days },
  };
}

function configPayload() {
  const cfg = readTextSafe(path.join(HERMES_HOME, 'config.yaml'));
  const pick = (re) => { const m = cfg.match(re); return m ? m[1].trim() : ''; };
  const env = readTextSafe(path.join(HERMES_HOME, '.env'));
  const envVal = (k) => { const m = env.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+)$', 'm')); return m ? m[1].trim() : ''; };
  return cached('config', async () => {
    const state = readJsonSafe(path.join(HERMES_HOME, 'gateway_state.json')) || {};
    const [sessions, toolsets, jobs] = await Promise.all([
      gwGet('/api/sessions?limit=200'), gwGet('/v1/toolsets'), gwGet('/api/jobs'),
    ]);
    const rows = (sessions && sessions.data) || [];
    const active = rows.find((r) => r.model);
    const skills = skillsPayload();
    const mems = memoriesPayload();
    /* gateway_state.json 里的 start_time 是进程启动的时钟滴答数（非 epoch），
       这里用 /proc/<pid>/stat 的 starttime + /proc/stat 的 btime 换算真实运行时长 */
    const up = procStartEpoch(state.pid) ? Math.round(Date.now() / 1000 - procStartEpoch(state.pid)) : 0;
    return {
      runtime: {
        version: state.code_version || '', sha: (state.code_sha || '').slice(0, 8),
        install_path: INSTALL_DIR, hermes_home: HERMES_HOME,
        python: (readTextSafe(path.join(INSTALL_DIR, 'venv', 'pyvenv.cfg')).match(/^version\s*=\s*(\S+)/m) || [])[1]
          || (readTextSafe(path.join(INSTALL_DIR, 'venv', 'pyvenv.cfg')).match(/^version_info\s*=\s*(\S+)/m) || [])[1] || '',
        os: (readTextSafe('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1] || '',
        hostname: os.hostname(), node: process.version, platform: os.platform() + ' ' + os.release(),
      },
      gateway: {
        state: state.gateway_state || 'unknown', pid: state.pid || 0, uptime_s: up,
        active_agents: state.active_agents ?? 0,
        platforms: Object.entries(state.platforms || {}).map(([k, v]) => ({ name: k, state: v.state })),
        profiles: state.served_profiles || [],
      },
      api_server: {
        enabled: envVal('API_SERVER_ENABLED') === 'true',
        host: envVal('API_SERVER_HOST') || '', port: envVal('API_SERVER_PORT') || '',
        key_configured: !!API_KEY, key_source: CRED.from,
        max_concurrent_runs: (cfg.match(/max_concurrent_runs:\s*(\d+)/) || [])[1] || '',
      },
      model: { active: (active && active.model) || '', advertised: (await gwGet('/v1/models'))?.data?.[0]?.id || '' },
      agent: {
        max_turns: pick(/^\s{2}max_turns:\s*(\d+)/m), reasoning_effort: pick(/^\s{2}reasoning_effort:\s*(\S+)/m),
        fast_auto_seconds: pick(/^\s{2}fast_auto_seconds:\s*(\d+)/m),
        compression: pick(/^\s{2}enabled:\s*(true|false)/m), threshold: pick(/^\s{2}threshold:\s*([\d.]+)/m),
      },
      counts: {
        skills_user: skills.counts['用户安装'] || 0, skills_builtin: skills.counts['内置'] || 0,
        toolsets: ((toolsets && toolsets.data) || []).length,
        sessions: rows.length, memory_entries: mems.total,
        cron_jobs: ((jobs && jobs.jobs) || []).length,
        config_snapshots: evolutionPayload().config_snapshots.length,
      },
      config_schema_version: pick(/^_config_version:\s*(\d+)/m),
      generated_at: new Date().toISOString(),
    };
  });
}

/* ---------- 模型定价（来自 ~/.hermes/models_dev_cache.json，仅供折算参考） ---------- */
let _catalog = null;
function modelPricing(model) {
  if (!model) return null;
  try {
    if (!_catalog) _catalog = readJsonSafe(path.join(HERMES_HOME, 'models_dev_cache.json')) || {};
    for (const prov of Object.values(_catalog)) {
      const m = prov && prov.models && prov.models[model];
      if (m && m.cost) {
        return {
          model, provider: prov.id || prov.name || '',
          input: m.cost.input ?? null, output: m.cost.output ?? null, cache_read: m.cost.cache_read ?? null,
          free: (m.cost.input === 0 && m.cost.output === 0),
          source: 'models.dev 目录缓存（models_dev_cache.json）',
        };
      }
    }
  } catch (_) { /* 目录不可读则不返回定价 */ }
  return null;
}

/* ---------- 真实 Token 用量：只读 ~/.hermes/state.db ---------- */
const DAY_S = 86400;
function localDay(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function dayBounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000;
  return { start, end: start + DAY_S };
}

/* ---------- 按天精确记账：累计值快照差分 ----------
 *
 * 问题：session_model_usage 只有「会话×模型×任务」的**累计**行，没有按天拆分。
 * 跨天会话只能按每日 assistant 轮次占比去摊 —— 而每轮 token 差异可达百倍
 * （长上下文一轮几十万，短问答几百），于是"今日"被系统性低估：
 * 实测 2026-10-27 官网 10.76M，分摊只算出 4.22M（2.55 倍）。
 *
 * 做法：每次采样把各行的累计值记成基线，下次采样做差 —— 增量就是这段时间里
 * 真实发生的调用量，把它归到采样时刻所在的那一天。与官网的差距只剩采样间隔
 * （面板每 15 分钟采一次，跨午夜最多偏一个间隔）。
 *
 * 首次部署没有历史基线：当天用原来的分摊值打底（seeded），之后的增量往上加，
 * 数字不会突然掉到 0；从第二天起是纯真实值。
 *
 * 快照落在桥自己的目录（与本文件同目录，root 可写），不碰 Hermes 的数据。
 */
const USAGE_SNAPSHOT = path.join(__dirname, 'usage-daily.json');
const SNAPSHOT_KEEP_DAYS = 60;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 简单文件锁：桥是一次一进程，但不排除页面与定时采样同时进来 */
function withUsageLock(fn) {
  const lock = USAGE_SNAPSHOT + '.lock';
  let fd = null;
  for (let i = 0; i < 40; i++) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      /* 残留锁：进程被 kill 时来不及删，一直留着会让记账永久停摆。
         超过 2 分钟就认为它已经死了，删掉重抢 */
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      sleepMs(25);
    }
  }
  if (fd === null) return null; /* 抢不到锁：这次只读，不改基线 */
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

/* ---------- 费用：DeepSeek 官方人民币单价 ----------
 * 来源：api-docs.deepseek.com「模型 & 价格」（2026-10）
 *   deepseek-flash     空闲 0.02 / 1   / 4     高峰 0.04 / 2   / 8
 *   deepseek-v4-pro    空闲 0.15 / 4.5 / 13.5  高峰 0.30 / 9   / 27
 * 单位：元 / 百万 tokens，顺序为 缓存命中 / 未命中 / 输出。
 * 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00，其余为空闲（半价）。
 * 旧名 deepseek-v4-flash 实际由 V4.1-Flash 提供服务，按 Flash 计费。
 * 表里没有的模型（如免费的 agnes）不计费 —— 宁可显示 0，也不要编一个数。
 */
const CNY_PRICING = {
  'deepseek-flash': { idle: { cache: 0.02, input: 1, output: 4 }, peak: { cache: 0.04, input: 2, output: 8 } },
  'deepseek-v4-flash': { idle: { cache: 0.02, input: 1, output: 4 }, peak: { cache: 0.04, input: 2, output: 8 } },
  'deepseek-v4-pro': { idle: { cache: 0.15, input: 4.5, output: 13.5 }, peak: { cache: 0.30, input: 9, output: 27 } },
};

/** 当前是否高峰时段。显式按 UTC+8 算，不依赖宿主机时区 */
function isPeakHour(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const h = bj.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 一段增量花多少钱（元）。reasoning 按输出价 —— DeepSeek 的思维链算在输出里 */
function costOf(model, d, peak) {
  const p = CNY_PRICING[model];
  if (!p) return 0;
  const t = peak ? p.peak : p.idle;
  return ((d.i || 0) / 1e6) * t.input
    + ((d.cr || 0) / 1e6) * t.cache
    + (((d.o || 0) + (d.rt || 0)) / 1e6) * t.output;
}

function bucketKey(b) {
  return [b.session_id, b.model || '', b.task || '', b.billing_mode || ''].join('\u0001');
}

function usageCells(b) {
  return {
    i: Number(b.input_tokens) || 0,
    o: Number(b.output_tokens) || 0,
    cr: Number(b.cache_read_tokens) || 0,
    cw: Number(b.cache_write_tokens) || 0,
    rt: Number(b.reasoning_tokens) || 0,
    c: Number(b.api_call_count) || 0,
  };
}

function emptyDay() {
  return {
    input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, api_calls: 0,
    /* 人民币花费。按每次采样的时段（高峰/空闲）与模型单价累加 */
    cost_cny: 0,
    sources: {}, sessions: {}, session_count: 0, seeded: false,
  };
}

/** 把原来 pick() 的估算结果转成记账结构，作为首次部署当天的底数 */
function dayFromEstimate(est) {
  const rec = emptyDay();
  rec.input = est.input;
  rec.output = est.output;
  rec.cache_read = est.cache_read;
  rec.cache_write = est.cache_write;
  rec.reasoning = est.reasoning;
  rec.api_calls = est.api_calls;
  rec.sources = { ...(est.sources || {}) };
  rec.session_count = est.sessions || 0;
  for (const s of est.top_sessions || []) rec.sessions[s.id] = s.token;
  /* 底数是分摊 token，拆不出模型，也拆不出高峰/空闲：一律按 deepseek-flash
     空闲价折算（偏低）。只影响首次上线的这一天，之后按时段真实计价 */
  rec.cost_cny = costOf('deepseek-flash', {
    i: est.input, o: est.output, cr: est.cache_read, rt: est.reasoning,
  }, false);
  rec.seeded = true;
  return rec;
}

/** 记账结构 → 与 pick() 同形的日结果 */
function dayToPick(rec, day, sessMap) {
  const rnd = (n) => Math.round(n);
  const top = Object.entries(rec.sessions || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, tok]) => {
      const s = sessMap.get(id) || {};
      return { id, title: s.title || s.display_name || id, source: s.source || '', token: rnd(tok) };
    });
  return {
    day,
    input: rnd(rec.input),
    output: rnd(rec.output),
    cache_read: rnd(rec.cache_read),
    cache_write: rnd(rec.cache_write),
    reasoning: rnd(rec.reasoning),
    /* 总消耗 = 未命中 + **缓存命中** + 输出（含推理）。缓存命中也是真处理过的
       prompt，漏掉它会把"今天用了多少"少报一个数量级（4.2M 显示成 23 万）。
       与 DeepSeek 官网用量页的口径一致：命中 + 未命中 + 输出 = 总计。 */
    total: rnd(rec.input + rec.cache_read + rec.output + rec.reasoning),
    /* 计费口径（缓存按 1/10 计价，所以单独给一个数，不能拿它当"消耗量"） */
    billed: rnd(rec.input + rec.output + rec.reasoning),
    api_calls: rnd(rec.api_calls),
    sessions: Math.max(rec.session_count || 0, Object.keys(rec.sessions || {}).length),
    sources: Object.fromEntries(Object.entries(rec.sources || {}).map(([k, v]) => [k, rnd(v)])),
    top_sessions: top,
    /* 当天花掉的钱（元），保留 2 位小数；前端只负责拼 ¥ */
    cost_cny: Math.round((rec.cost_cny || 0) * 100) / 100,
    /* true = 这一天的底数还是分摊估算（首次部署的那天），之后的增量是真实的 */
    seeded: Boolean(rec.seeded),
    measured: true,
  };
}

/**
 * 采样一次：读快照 → 与当前累计值做差 → 增量记到今天 → 写回。
 * @param buckets session_model_usage 的全部行
 * @param sessMap  session_id → sessions 行（用来归因来源）
 * @param estimate 首次部署时的分摊估算（(day) => pick 结果）
 * @returns {{ days: Record<string, object> } | null} 记账表；拿不到锁时为 null
 */
function measureUsage(buckets, sessMap, estimate) {
  const now = Date.now() / 1000;
  const day = localDay(now);

  const cur = new Map();
  for (const b of buckets) cur.set(bucketKey(b), usageCells(b));

  return withUsageLock(() => {
    let file = null;
    try {
      file = JSON.parse(fs.readFileSync(USAGE_SNAPSHOT, 'utf8'));
    } catch {
      file = null;
    }
    if (!file || typeof file !== 'object' || !file.baseline || !file.days) {
      /* 首次：只建基线。当天底数用分摊估算，避免"刚上线就显示 0" */
      const days = { [day]: dayFromEstimate(estimate(day)) };
      writeSnapshot({ version: 1, baseline: Object.fromEntries(cur), days });
      return { days, firstRun: true };
    }

    const rec = file.days[day] || emptyDay();
    /* 老快照（这个字段还没有时）按 seed 的同一口径补一次金额，避免今天显示 ¥0 */
    if (rec.seeded && typeof rec.cost_cny !== 'number') {
      rec.cost_cny = costOf('deepseek-flash', {
        i: rec.input, o: rec.output, cr: rec.cache_read, rt: rec.reasoning,
      }, false);
    }
    const peak = isPeakHour();
    for (const b of buckets) {
      const key = bucketKey(b);
      const after = cur.get(key);
      const before = file.baseline[key];
      if (!after) continue;
      if (!before) {
        /* 基线里没有这行 = 采样间隔内新开的会话：整行都是新量 */
        addDelta(rec, after, sessMap.get(b.session_id), b.model, peak);
        continue;
      }
      const d = {
        i: after.i - before.i, o: after.o - before.o,
        cr: after.cr - before.cr, cw: after.cw - before.cw,
        rt: after.rt - before.rt, c: after.c - before.c,
      };
      /* 负增量说明这一行被删/被压缩重建过，按 0 处理并把基线刷新到当前 */
      if (d.i <= 0 && d.o <= 0 && d.cr <= 0 && d.cw <= 0 && d.rt <= 0 && d.c <= 0) continue;
      addDelta(rec, d, sessMap.get(b.session_id), b.model, peak);
    }

    file.days[day] = rec;
    /* 基线整体刷新成当前值：DB 里消失的行也一并清掉，免得越攒越大 */
    file.baseline = Object.fromEntries(cur);
    /* 只留最近 SNAPSHOT_KEEP_DAYS 天 */
    const days = Object.keys(file.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - SNAPSHOT_KEEP_DAYS))) delete file.days[d];
    writeSnapshot(file);
    return { days: file.days };
  });
}

function addDelta(rec, d, sess, model, peak) {
  const di = Math.max(0, d.i || 0), dout = Math.max(0, d.o || 0), dcr = Math.max(0, d.cr || 0);
  const dcw = Math.max(0, d.cw || 0), drt = Math.max(0, d.rt || 0), dc = Math.max(0, d.c || 0);
  if (!di && !dout && !dcr && !dcw && !drt && !dc) return;
  rec.input += di;
  rec.output += dout;
  rec.cache_read += dcr;
  rec.cache_write += dcw;
  rec.reasoning += drt;
  rec.api_calls += dc;
  /* 计价跟着增量走：一次采样跨时段（比如 9:00 那条线）时按采样时刻算，
     误差最多一个采样间隔，比整天都按高峰/空闲一刀切准得多 */
  rec.cost_cny = (rec.cost_cny || 0) + costOf(model, { i: di, o: dout, cr: dcr, rt: drt }, peak);
  const tok = di + dout + drt;
  if (tok > 0) {
    const src = (sess && sess.source) || 'unknown';
    rec.sources[src] = (rec.sources[src] || 0) + tok;
    if (sess) rec.sessions[sess.id || ''] = (rec.sessions[sess.id || ''] || 0) + tok;
  }
}

function writeSnapshot(obj) {
  const tmp = USAGE_SNAPSHOT + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, USAGE_SNAPSHOT);
}

function usagePayload() {
  return cached('usage', () => {
    const dbPath = path.join(HERMES_HOME, 'state.db');
    if (!fs.existsSync(dbPath)) throw new Error('未找到 ' + dbPath);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let buckets = [], turns = [], sessions = [];
    try {
      buckets = db.prepare(`select session_id, model, task, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen
        from session_model_usage`).all();
      turns = db.prepare(`select session_id, date(timestamp,'unixepoch','localtime') d, count(*) c
        from messages where role='assistant' group by 1,2`).all();
      sessions = db.prepare(`select id, source, title, display_name, model, last_activity_at,
        api_call_count, input_tokens, output_tokens, cache_read_tokens from sessions`).all();
    } finally { db.close(); }

    const turnMap = new Map();
    turns.forEach((t) => {
      if (!turnMap.has(t.session_id)) turnMap.set(t.session_id, new Map());
      turnMap.get(t.session_id).set(t.d, t.c);
    });
    const sessMap = new Map(sessions.map((s) => [s.id, s]));

    const days = new Map();
    let singleDayRows = 0, proratedRows = 0;
    const bump = (day, r, w) => {
      if (!(w > 0)) return;
      const cur = days.get(day) || { day, input: 0, output: 0, cache_read: 0, cache_write: 0,
        reasoning: 0, api_calls: 0, sessions: new Map(), sources: new Map() };
      cur.input += r.input_tokens * w;
      cur.output += r.output_tokens * w;
      cur.cache_read += r.cache_read_tokens * w;
      cur.cache_write += r.cache_write_tokens * w;
      cur.reasoning += r.reasoning_tokens * w;
      cur.api_calls += r.api_call_count * w;
      const tok = (r.input_tokens + r.output_tokens + r.reasoning_tokens) * w;
      const src = (sessMap.get(r.session_id) || {}).source || 'unknown';
      cur.sources.set(src, (cur.sources.get(src) || 0) + tok);
      cur.sessions.set(r.session_id, (cur.sessions.get(r.session_id) || 0) + tok);
      days.set(day, cur);
    };

    buckets.forEach((r) => {
      const d1 = localDay(r.first_seen), d2 = localDay(r.last_seen);
      if (d1 === d2) { singleDayRows++; bump(d1, r, 1); return; }
      /* 跨天会话：按该会话每天的 assistant 轮次占比分摊（无轮次数据时回退为时间重叠比例） */
      const per = turnMap.get(r.session_id) || new Map();
      const inWin = [...per.entries()].filter(([d]) => {
        const b = dayBounds(d);
        return b.start < r.last_seen && b.end > r.first_seen;
      });
      const totalTurns = inWin.reduce((s, [, c]) => s + c, 0);
      if (totalTurns > 0) {
        proratedRows++;
        inWin.forEach(([d, c]) => bump(d, r, c / totalTurns));
      } else {
        const span = Math.max(1, r.last_seen - r.first_seen);
        for (let s = Math.floor(r.first_seen); s < r.last_seen;) {
          const d = localDay(s), b = dayBounds(d);
          const ov = Math.min(b.end, r.last_seen) - Math.max(b.start, r.first_seen);
          bump(d, r, Math.max(0, ov) / span);
          s = b.end;
        }
      }
    });

    const pick = (day) => {
      const d = days.get(day);
      if (!d) return { day, total: 0, billed: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
        reasoning: 0, api_calls: 0, sessions: 0, sources: {}, top_sessions: [] };
      const rnd = (n) => Math.round(n);
      const top = [...d.sessions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, tok]) => {
        const s = sessMap.get(id) || {};
        return { id, title: s.title || s.display_name || id, source: s.source || '', token: rnd(tok) };
      });
      return {
        day,
        input: rnd(d.input), output: rnd(d.output), cache_read: rnd(d.cache_read),
        cache_write: rnd(d.cache_write), reasoning: rnd(d.reasoning),
        /* 同 dayToPick：总消耗含缓存命中，billed 才是"算钱"的那部分 */
        total: rnd(d.input + d.cache_read + d.output + d.reasoning),
        billed: rnd(d.input + d.output + d.reasoning),
        api_calls: rnd(d.api_calls), sessions: d.sessions.size,
        sources: Object.fromEntries([...d.sources.entries()].map(([k, v]) => [k, rnd(v)])),
        top_sessions: top,
      };
    };

    /* 14 天：监控页那张卡片的柱状图要 14 根，之前只算 7 天，于是右半边永远空着。
       多算 7 天是纯内存聚合，没有额外查询。 */
    const now = Date.now() / 1000;
    const series = [];
    for (let i = 13; i >= 0; i--) series.push(pick(localDay(now - i * DAY_S)));

    /* 有记账的日子用真实值覆盖上面的分摊值（见 measureUsage 的说明）。
       今天与昨天都从 series 里取：series 末位是今天。 */
    let measured = null;
    try {
      measured = measureUsage(buckets, sessMap, pick);
    } catch (err) {
      /* 记账失败不能拖垮整个页面：退回分摊值，只在 attribution 里说清楚 */
      console.warn('[usage] 按天记账失败：', err.message);
    }
    if (measured) {
      for (let i = 0; i < series.length; i++) {
        const rec = measured.days[series[i].day];
        if (rec) series[i] = dayToPick(rec, series[i].day, sessMap);
      }
    }
    const today = series[series.length - 1];
    const yesterday = series[series.length - 2] || pick(localDay(now - DAY_S));

    const state = readJsonSafe(path.join(HERMES_HOME, 'gateway_state.json')) || {};
    /* 模型清单只取**近 14 天内有用量**的（窗口与上面的 series 对齐）。
       原来取全表 distinct，于是几个月前试过一次、之后一直没用的模型
       （比如 mimo-v2.6-flash）会永远挂在面板"模型 a / b"那一行，
       看着像现在还在花它的钱。 */
    const windowStart = dayBounds(series[0].day).start;
    const models = [...new Set(
      buckets.filter((b) => !b.task && b.last_seen >= windowStart).map((b) => b.model),
    )];
    return {
      today,
      yesterday,
      series,
      budget_tokens: 10000000,
      budget_label: '1000万',
      models,
      pricing: modelPricing(models[0]),
      gateway: {
        version: state.code_version || '', pid: state.pid || 0,
        uptime_s: procStartEpoch(state.pid) ? Math.round(now - procStartEpoch(state.pid)) : 0,
      },
      /* 拾贝自己的 AI 消耗（理解指令 / 生成选择器 / 清洗 / 自愈），与上面的网关口径分开 */
      harvester: Object.assign(harvUsageToday(), {
        file: HARV_USAGE_FILE,
        note: '只统计为拾贝花的模型调用；纯抓取走本地执行器，不消耗 token',
      }),
      /* 数据桥是一次一进程，自身的 uptime 没有意义；这里给 Hermes 主机的连续运行时长 */
      service: {
        pid: process.pid,
        uptime_s: Math.round(os.uptime()),
        started_at: new Date(Date.now() - Math.round(os.uptime()) * 1000).toISOString(),
        note: 'Hermes 主机运行时长；数据桥按需启动',
      },
      /* 网关拉起的 MCP 常驻子进程 —— 司册的「连续在线」看这个。
         注意口径：MCP 是文件操作类服务，动作都在本机完成、不经过模型，
         所以它没有 token 消耗（页面上「今日 Token」会显示「不适用」而不是数字）。 */
      mcp: {
        items: mcpProcesses(),
        note: '文件操作类 MCP 不经过模型，无 token 消耗',
      },
      attribution: {
        basis: 'state.db 的 session_model_usage 累计值 + 按天快照差分（每次采样记账，增量归当天）',
        single_day_rows: singleDayRows,
        multi_day_rows: proratedRows,
        /* measured：这一天的数走的是"快照差分"（真实增量）。
           seeded：当天的底数还是首次部署时的分摊估算，之后的增量是真实的。
           两个都为 false 时才是纯分摊值（服务刚部署、还没采到过） */
        measured_today: Boolean(today.measured),
        seeded_today: Boolean(today.seeded),
        note: today.measured
          ? (today.seeded
              ? '今天的底数为分摊估算，之后按采样增量累加；明天起为纯真实值'
              : '今日为按调用的真实增量（采样间隔内归当天）')
          : (proratedRows ? '跨天会话按每日 assistant 轮次占比分摊（尚未建立快照基线）' : '全部用量均落在同一天，无需分摊'),
        /* 金额口径单独说清楚：单价来自官方文档，时段按采样时刻判定 */
        cost: {
          currency: 'CNY',
          basis: 'DeepSeek 官方单价（元/百万 tokens：缓存命中 / 未命中 / 输出）',
          peak_hours: '工作日 9:00–12:00、14:00–18:00（北京时间），其余为空闲半价',
          models: CNY_PRICING,
          note: '按采样时刻的时段计价；seed 的那天按空闲价估算',
        },
      },
      generated_at: new Date().toISOString(),
    };
  });
}

/* ---------- 对话明细 + 全局待办：会话状态、定时任务、执行记录、事故 ---------- */
/* 时间字段归一：epoch 秒 → ISO；已是字符串则原样返回 */
function toIsoTime(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString();
  return v ? String(v) : '';
}

function sqliteAll(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

function boardPayload() {
  return cached('board', async () => {
    const jobsRaw = ((await gwGet('/api/jobs')) || {}).jobs || [];
    const dbPath = path.join(HERMES_HOME, 'state.db');
    const sessions = sqliteAll(dbPath, `select id, source, title, display_name, started_at, ended_at,
      end_reason, last_activity_at, message_count, tool_call_count, api_call_count,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, model from sessions`);
    const executions = sqliteAll(path.join(HERMES_HOME, 'cron', 'executions.db'),
      `select id, job_id, source, status, started_at, finished_at, error, delivery_outcome,
        scheduled_instant from executions order by started_at desc`);
    const incidents = sqliteAll(path.join(HERMES_HOME, 'cron', 'executions.db'),
      `select id, job_id, state, failure_type, first_seen_at, last_seen_at, closed_at, error
        from cron_incidents order by last_seen_at desc`);

    const jobNames = new Map(jobsRaw.map((j) => [j.id, j.name]));
    const tokOf = (s) => (s.input_tokens || 0) + (s.output_tokens || 0) + (s.reasoning_tokens || 0);

    /* 会话 → 对话明细口径 */
    const now = Date.now() / 1000;
    const today = localDay(now);
    const bySource = {};
    sessions.forEach((s) => { bySource[s.source || 'unknown'] = (bySource[s.source || 'unknown'] || 0) + 1; });
    const conversations = {
      total: sessions.length,
      active: sessions.filter((s) => !s.ended_at).length,      /* 进行中 = 未结束 */
      done: sessions.filter((s) => s.ended_at).length,          /* 已完成 = 已结束 */
      today_new: sessions.filter((s) => s.started_at && localDay(s.started_at) === today).length,
      by_source: bySource,
      end_reasons: [...new Set(sessions.map((s) => s.end_reason).filter(Boolean))],
      definition: '进行中 = 尚未结束的会话；已完成 = 已结束（' +
        [...new Set(sessions.map((s) => s.end_reason).filter(Boolean))].join(' / ') + '）',
    };

    /* 定时任务（含累计 token：按 cron_<job_id>_* 会话汇总） */
    const jobs = jobsRaw.map((j) => ({
      id: j.id, name: j.name, enabled: !!j.enabled, state: j.state || '',
      schedule: j.schedule_display || (j.schedule && j.schedule.expr) || '',
      next_run_at: j.next_run_at || '', last_run_at: j.last_run_at || '',
      last_status: j.last_status || '', failure_streak: j.failure_streak || 0,
      runs_completed: (j.repeat && j.repeat.completed) || 0,
      script: j.script || '', deliver: j.deliver || '',
      prompt: String(j.prompt || '').slice(0, 1200),
      tokens: sessions.filter((s) => s.id.startsWith('cron_' + j.id + '_')).reduce((a, s) => a + tokOf(s), 0),
      runs: executions.filter((e) => e.job_id === j.id).slice(0, 6).map((e) => ({
        id: e.id, status: e.status, source: e.source,
        started_at: e.started_at, finished_at: e.finished_at,
        duration_s: (e.started_at && e.finished_at)
          ? Math.round((Date.parse(e.finished_at) - Date.parse(e.started_at)) / 1000) : 0,
        delivery: e.delivery_outcome || '', error: e.error || '' })),
      incidents: incidents.filter((i) => i.job_id === j.id).map((i) => ({
        id: i.id, state: i.state, failure_type: i.failure_type, error: i.error,
        first_seen_at: i.first_seen_at, last_seen_at: i.last_seen_at, closed_at: i.closed_at })),
      tokens_note: '累计 token = 该任务历次执行会话的 输入+输出+推理',
    }));

    /* 等待回复的会话（最后一条是用户消息） */
    let lastRoles = [];
    try {
      lastRoles = sqliteAll(dbPath, `select m.session_id, m.role, m.content, m.timestamp
        from messages m join (select session_id, max(id) mid from messages group by session_id) x
        on m.id = x.mid`);
    } catch (_) { /* 忽略 */ }
    const roleMap = new Map(lastRoles.map((r) => [r.session_id, r]));
    const pending_sessions = sessions.filter((s) => {
      const r = roleMap.get(s.id);
      return r && r.role === 'user';
    }).map((s) => {
      const r = roleMap.get(s.id) || {};
      return { id: s.id, title: s.title || s.display_name || s.id, source: s.source,
        last_activity_at: s.last_activity_at, preview: String(r.content || '').slice(0, 120) };
    });

    /* 委托任务（多智能体）与未投递消息 —— 属于真实待办 */
    const delegations = sqliteAll(dbPath, `select delegation_id, state, dispatched_at, completed_at,
      task_json, result_json, delivery_state, delivery_attempts, origin_session_id
      from async_delegations order by rowid desc limit 20`);
    const deliveryPending = sqliteAll(dbPath, `select obligation_id, platform, chat_id, content, state,
      attempts, created_at, updated_at, last_error from delivery_obligations
      where state <> 'delivered' order by rowid desc limit 10`);

    return {
      conversations,
      delegations: delegations.map((d) => ({
        id: d.delegation_id, state: d.state,
        dispatched_at: toIsoTime(d.dispatched_at), completed_at: toIsoTime(d.completed_at),
        delivery_state: d.delivery_state || '', delivery_attempts: d.delivery_attempts || 0,
        origin_session: d.origin_session_id || '',
        task: redact(String(d.task_json || '').slice(0, 1200)),
        result: redact(String(d.result_json || '').slice(0, 1200)),
      })),
      delivery_pending: deliveryPending.map((o) => ({
        id: o.obligation_id, platform: o.platform || '', state: o.state, attempts: o.attempts || 0,
        created_at: toIsoTime(o.created_at), updated_at: toIsoTime(o.updated_at),
        content: redact(String(o.content || '').slice(0, 400)), last_error: o.last_error || '',
      })),
      jobs,
      runs: executions.slice(0, 8).map((e) => ({
        id: e.id, job_id: e.job_id, job_name: jobNames.get(e.job_id) || e.job_id,
        status: e.status, source: e.source, started_at: e.started_at, finished_at: e.finished_at,
        duration_s: (e.started_at && e.finished_at)
          ? Math.round((Date.parse(e.finished_at) - Date.parse(e.started_at)) / 1000) : 0,
        delivery: e.delivery_outcome || '', error: e.error || '' })),
      incidents: incidents.map((i) => ({
        id: i.id, job_id: i.job_id, job_name: jobNames.get(i.job_id) || i.job_id,
        state: i.state, failure_type: i.failure_type, error: i.error,
        first_seen_at: i.first_seen_at, last_seen_at: i.last_seen_at, closed_at: i.closed_at })),
      pending_sessions,
      generated_at: new Date().toISOString(),
    };
  });
}

/* ---------- MCP server 真实状态：配置 + 探活 + 网关侧连接 ---------- */
const _mcpHistory = [];                      /* 探活历史（内存环形缓冲，最多 30 条） */

/* 用 Hermes 自带的 venv python 精确解析 config.yaml 的 mcp_servers 段 */
function readMcpConfig() {
  return new Promise((resolve) => {
    const py = path.join(INSTALL_DIR, 'venv', 'bin', 'python');
    const cfg = path.join(HERMES_HOME, 'config.yaml');
    if (!fs.existsSync(py)) return resolve({});
    const code = 'import yaml,json,sys;d=yaml.safe_load(open(sys.argv[1])) or {};'
      + 'print(json.dumps(d.get("mcp_servers") or {}))';
    execFile(py, ['-c', code, cfg], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({});
      try { resolve(JSON.parse(stdout)); } catch (_) { resolve({}); }
    });
  });
}

/* stdio 握手探活：initialize + tools/list，返回真实工具清单与延迟 */
function probeMcp(server, timeoutMs) {
  return new Promise((resolve) => {
    if (!server.command) return resolve({ ok: false, error: '非 stdio 传输（url 型），未做本地探活' });
    const t0 = Date.now();
    let child, done = false, buf = '', info = null, proto = '';
    const finish = (r) => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch (_) {} resolve(r); };
    try {
      child = spawn(server.command, server.args || [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) { return resolve({ ok: false, error: err.message }); }
    const timer = setTimeout(() => finish({ ok: false, error: '探活超时 ' + (timeoutMs || 8000) + 'ms' }), timeoutMs || 8000);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    child.on('close', () => { clearTimeout(timer); finish({ ok: false, error: '进程提前退出' }); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === 1 && msg.result) {
          info = msg.result.serverInfo || null;
          proto = msg.result.protocolVersion || '';
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          finish({ ok: true, latency_ms: Date.now() - t0, protocol: proto, server: info,
            tools: (msg.result.tools || []).map((t) => ({ name: t.name,
              description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 300) })) });
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-office', version: '1.0' } } }) + '\n');
  });
}

/* 网关侧是否已拉起该 MCP 子进程 */
function gatewayMcpPids(server) {
  const needle = (server.args || []).join(' ');
  if (!needle) return [];
  try {
    return execSync('ps -eo pid,args', { timeout: 3000 }).toString().split('\n')
      .filter((l) => l.includes(needle) && l.includes(server.command))
      .map((l) => l.trim().split(/\s+/)[0]);
  } catch (_) { return []; }
}

/* 网关日志里登记的 MCP 工具数（真实注册记录） */
function registeredMcpTools(name) {
  const log = readTextSafe(path.join(HERMES_HOME, 'logs', 'agent.log'));
  const re = new RegExp("MCP server '" + name + "'[^\\n]*registered (\\d+) tool", 'g');
  let m, last = null, at = null;
  while ((m = re.exec(log))) {
    last = Number(m[1]);
    const line = log.slice(log.lastIndexOf('\n', m.index) + 1, log.indexOf('\n', m.index));
    at = (line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || null;
  }
  return { tools: last, at };
}

function mcpPayload() {
  return cached('mcp', async () => {
    const cfg = await readMcpConfig();
    const servers = Object.entries(cfg).map(([name, v]) => ({
      name,
      transport: v.url ? 'http(s)' : 'stdio',
      command: v.command || '',
      args: Array.isArray(v.args) ? v.args : (v.args ? [String(v.args)] : []),
      url: v.url || '',
      /* 作用域：形如 /xxx 且不是脚本文件的参数（即授权目录） */
      scope: (Array.isArray(v.args) ? v.args : []).filter((a) => {
        const s = String(a);
        return s.startsWith('/') && !/\.(js|mjs|cjs|py)$/i.test(s) && fs.existsSync(s);
      }),
      env_keys: Object.keys(v.env || {}),
      source: '~/.hermes/config.yaml · mcp_servers.' + name,
    }));
    const probes = [];
    for (const s of servers) {
      const p = await probeMcp(s);
      const reg = registeredMcpTools(s.name);
      const pids = gatewayMcpPids(s);
      probes.push({
        name: s.name, transport: s.transport, ok: p.ok, error: p.error || '',
        latency_ms: p.latency_ms || 0, protocol: p.protocol || '',
        server_info: p.server || null, tools: p.tools || [],
        scope: s.scope,
        gateway: { connected: pids.length > 0, pids, registered_tools: reg.tools, registered_at: reg.at },
      });
      _mcpHistory.unshift({ at: Date.now(), name: s.name, ok: p.ok, latency_ms: p.latency_ms || 0,
        tools: (p.tools || []).length, error: p.error || '' });
      if (_mcpHistory.length > 30) _mcpHistory.pop();
    }
    return { servers, probes, history: _mcpHistory.slice(0, 20),
      config_source: path.join(HERMES_HOME, 'config.yaml'),
      generated_at: new Date().toISOString() };
  });
}

/* ---------- 运维值守真实数据（定时任务 + 执行记录 + 事故 + 探针快照） ---------- */
function runWatchScript(mode, timeoutMs) {
  return new Promise((resolve) => {
    execFile('python3', [path.join(HERMES_HOME, 'scripts', 'infra_watch.py'), mode],
      { timeout: timeoutMs || 20000, maxBuffer: 1 << 20 }, (err, stdout) => {
        resolve({ ok: !err, output: String(stdout || '').trim(), error: err ? err.message : '' });
      });
  });
}

/* 探针结果：内存 → 磁盘 → 实跑。
 *
 * 桥是「一次调用一个进程」，内存缓存跨调用无效；而 infra_watch.py 的
 * state/alerts 要读磁盘、CPU、SMART，单次约 5 秒。所以把结果落盘：
 *   · 10 分钟内：直接当新鲜值；
 *   · 10 分钟 ~ 24 小时：先返回旧值，后台 detached 子进程刷新；
 *   · 超过 24 小时或从未跑过：同步跑一次（只有首次）。
 * 开销：一次探针 = 两个 python 进程约 5 秒，且只在有人看尾流页签时触发，
 * 最多 10 分钟一次；没人看就不跑。
 */
const _probeCache = { at: 0, val: null };
const PROBE_TTL = 600000;
const PROBE_MAX_STALE = 24 * 3600 * 1000;
const PROBE_FILE = path.join(HARVESTER_DIR, 'cache', 'watch-probe.json');
const PROBE_LOCK = path.join(HARVESTER_DIR, 'cache', 'watch-probe.lock');
const PROBE_LOCK_TTL = 120000;        /* 后台刷新最多跑 2 分钟，锁过期即视为失败 */

function readProbeFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'));
    if (raw && typeof raw.at === 'number' && raw.val && typeof raw.val === 'object') return raw;
  } catch (_) { /* 没有缓存或文件损坏，按未缓存处理 */ }
  return null;
}

function writeProbeFile(at, val) {
  try {
    fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true });
    const tmp = `${PROBE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at, val }));
    fs.renameSync(tmp, PROBE_FILE);
  } catch (err) {
    console.warn('[hwb-bridge] 探针缓存写入失败:', err.message);
  }
}

function buildProbe(snapshot, alerts) {
  const scriptPath = path.join(HERMES_HOME, 'scripts', 'infra_watch.py');
  const src = readTextSafe(scriptPath);
  const pick = (re, d) => { const m = src.match(re); return m ? Number(m[1]) : d; };
  return {
    script: scriptPath,
    thresholds: {
      disk: pick(/^TH_DISK = (\d+)/m, 70), cpu: pick(/^TH_CPU = (\d+)/m, 50),
      mem: pick(/^TH_MEM = (\d+)/m, 80), load: pick(/^TH_LOAD = ([\d.]+)/m, 8),
      // wearout：PVE 的剩余寿命 %（= 100 − SMART Percentage Used），越低越危险
      wear_remain: pick(/^TH_WEAR_REMAIN = (\d+)/m, 20), inode: pick(/^TH_INODE = (\d+)/m, 85),
      cooldown_alert_s: pick(/^COOLDOWN_ALERT = (\d+)/m, 3600),
      cooldown_health_s: pick(/^COOLDOWN_HEALTH = (\d+)/m, 43200),
    },
    snapshot: snapshot.output, snapshot_ok: snapshot.ok,
    alerts: alerts.output, alerts_ok: alerts.ok,
    fetched_at: new Date().toISOString(),
  };
}

async function refreshWatchProbe() {
  const [snapshot, alerts] = await Promise.all([runWatchScript('state'), runWatchScript('alerts')]);
  const val = buildProbe(snapshot, alerts);
  const at = Date.now();
  _probeCache.at = at;
  _probeCache.val = val;
  writeProbeFile(at, val);
  return val;
}

function scheduleProbeRefresh() {
  const dir = path.dirname(PROBE_LOCK);
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const st = fs.statSync(PROBE_LOCK);
      if (Date.now() - st.mtimeMs < PROBE_LOCK_TTL) return;  /* 已有刷新在跑 */
      fs.unlinkSync(PROBE_LOCK);
    } catch (_) { /* 没有锁 */ }
    fs.writeFileSync(PROBE_LOCK, String(process.pid));
  } catch (_) {
    return;
  }
  try {
    const child = spawn(process.execPath, [__filename, '--refresh-watch'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) {
    try { fs.unlinkSync(PROBE_LOCK); } catch (__) { /* 忽略 */ }
  }
}

function probeInfo() {
  if (_probeCache.val && Date.now() - _probeCache.at < PROBE_TTL) return Promise.resolve(_probeCache.val);
  const disk = readProbeFile();
  if (disk) {
    const age = Date.now() - disk.at;
    if (age < PROBE_TTL) {
      _probeCache.at = disk.at;
      _probeCache.val = disk.val;
      return Promise.resolve(disk.val);
    }
    if (age < PROBE_MAX_STALE) {
      _probeCache.at = disk.at;
      _probeCache.val = disk.val;
      scheduleProbeRefresh();          /* 先给旧值，后台补新值 */
      return Promise.resolve(disk.val);
    }
  }
  return refreshWatchProbe();
}

function watchPayload() {
  return cached('watch', async () => {
    const jobs = ((await gwGet('/api/jobs')) || {}).jobs || [];
    const ops = jobs.filter((j) => /运维值守/.test(j.name || ''));
    const ids = new Set(ops.map((j) => j.id));
    const ex = sqliteAll(path.join(HERMES_HOME, 'cron', 'executions.db'),
      `select id, job_id, status, started_at, finished_at, error, delivery_outcome, source
        from executions order by started_at desc limit 200`);
    const inc = sqliteAll(path.join(HERMES_HOME, 'cron', 'executions.db'),
      `select id, job_id, state, failure_type, first_seen_at, last_seen_at, closed_at, error
        from cron_incidents order by last_seen_at desc limit 50`);
    const names = new Map(ops.map((j) => [j.id, j.name]));

    return {
      jobs: ops.map((j) => ({
        id: j.id, name: j.name, enabled: !!j.enabled, state: j.state || '',
        schedule: j.schedule_display || (j.schedule && j.schedule.expr) || '',
        mode: j.no_agent ? 'no-agent（纯脚本，零 token）' : 'agent（变化时唤醒）',
        monitor: j.monitor_script || j.monitor_url || '',
        script: j.script || '', skills: j.skills || [],
        next_run_at: j.next_run_at || '', last_run_at: j.last_run_at || '',
        last_status: j.last_status || '', runs_completed: (j.repeat && j.repeat.completed) || 0,
        deliver: j.deliver || '',
      })),
      runs: ex.filter((e) => ids.has(e.job_id)).slice(0, 12).map((e) => ({
        id: e.id, job: names.get(e.job_id) || e.job_id, status: e.status,
        started_at: e.started_at, finished_at: e.finished_at,
        duration_s: (e.started_at && e.finished_at)
          ? Math.round((Date.parse(e.finished_at) - Date.parse(e.started_at)) / 1000) : 0,
        delivery: e.delivery_outcome || '', error: e.error || '', source: e.source || '',
      })),
      incidents: inc.map((i) => ({
        id: i.id, job: names.get(i.job_id) || i.job_id, state: i.state,
        failure_type: i.failure_type || '', error: i.error || '',
        first_seen_at: i.first_seen_at, last_seen_at: i.last_seen_at, closed_at: i.closed_at,
      })),
      probe: await probeInfo(),
      generated_at: new Date().toISOString(),
    };
  });
}

/* ---------- 边界守望（尾流 · Edge Sentry）真实数据 ----------
 * 数据源：/var/lib/agent-office/security/attacks.db（由 frp_guard.py 采集落盘）
 *          + frp_guard.py json（实时 10 分钟窗口，服务名映射只在 Python 维护）
 * 只读聚合，不返回任何 frps 凭证/口令。封禁是唯一写操作，走独立 POST 且必须带授权码。 */
const SECURITY_DB = path.join(HARVESTER_DIR, 'security', 'attacks.db');
const FRP_GUARD_PY = path.join(HERMES_HOME, 'scripts', 'frp_guard.py');

function runFrpGuard(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('python3', [FRP_GUARD_PY].concat(args),
      { timeout: timeoutMs || 40000, maxBuffer: 2 << 20 }, (err, stdout, stderr) => {
        /* 失败原因两边都可能：frp_guard.py 常把"授权码不存在"这类话写在 stdout，
           stderr 只剩一行 traceback 或干脆是空的。两个都带上 ——
           人要看到的是"为什么失败"，不是"哪条命令失败了" */
        const parts = [String(stderr || '').trim(), String(stdout || '').trim()].filter(Boolean);
        resolve({
          ok: !err,
          output: String(stdout || '').trim(),
          error: err ? (parts.join('\n') || String(err.message || '').trim()) : '',
        });
      });
  });
}

/* 本机时间 → 'YYYY-MM-DD HH:MM:SS'，与 events.ts 的前缀格式一致 */
function secTs(msAgo) {
  const d = new Date(Date.now() - msAgo);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function securityPayload() {
  return cached('security', async () => {
    const since24 = secTs(24 * 3600 * 1000);

    const sum = sqliteAll(SECURITY_DB,
      `select count(*) n, count(distinct ip) ips, count(distinct proxy) svc
         from events where ts >= '${since24}'`)[0] || { n: 0, ips: 0, svc: 0 };

    const topIps = sqliteAll(SECURITY_DB,
      `select ip, count(*) n, count(distinct proxy) svc, max(ts) last_ts
         from events where ts >= '${since24}'
        group by ip order by n desc limit 10`);

    const topProxyRaw = sqliteAll(SECURITY_DB,
      `select proxy, count(*) n from events where ts >= '${since24}'
        group by proxy order by n desc limit 20`);

    /* 24h 全量 proxy 计数：用于按「中文服务名」去重统计涉及服务数，
       否则同一 SSH 服务在 frps / haproxy 各算一次，数字会翻倍。 */
    const svcRowsRaw = sqliteAll(SECURITY_DB,
      `select proxy, count(*) n from events where ts >= '${since24}' group by proxy`);

    const hourly = sqliteAll(SECURITY_DB,
      `select substr(ts, 12, 2) h, count(*) n from events where ts >= '${since24}'
        group by h order by h`);

    /* geo / message_id 是后补的列（补列在 frp_guard.py 的 _init_schema 里）。
       先看一眼表结构再拼 SQL —— 老库上直接 select 不存在的列会让整块快照黑掉，
       而这块黑了，页面连「谁被封了」都看不到。 */
    let bcols = new Set();
    try { bcols = new Set(sqliteAll(SECURITY_DB, 'pragma table_info(blocks)').map((c) => c.name)); } catch (e) { /* 表还没建 */ }
    const geoCol = bcols.has('geo') ? "coalesce(geo,'') geo" : "'' geo";
    const midCol = bcols.has('message_id') ? "coalesce(message_id,'') message_id" : "'' message_id";

    const pending = sqliteAll(SECURITY_DB,
      `select id, ip, reason, ticket, requested_by, requested_at, expires_at, ${geoCol}, ${midCol}
         from blocks where status = 'pending' order by id desc limit 20`);

    const blocks = sqliteAll(SECURITY_DB,
      `select id, ip, reason, status, requested_by, approved_by, requested_at,
              approved_at, expires_at, result, ${geoCol}
         from blocks where status <> 'pending' order by id desc limit 15`);

    /* 归属地：补丁之后新开的单在申请时就写进库了，但老单这一列是空的。
       这里用 frp_guard 的 geo 缓存批量补一次 —— 同一份 30 天缓存，不额外打外部接口。
       申请卡上没有归属地，人就少了「机房扫描还是同城家宽」这个判断依据。 */
    const geoFill = [];
    pending.forEach((p) => { if (p.ip && !p.geo && !geoFill.includes(p.ip)) geoFill.push(p.ip); });
    blocks.forEach((b) => { if (b.ip && !b.geo && !geoFill.includes(b.ip)) geoFill.push(b.ip); });
    if (geoFill.length) {
      const g = await runFrpGuard(['geo', '--ips', geoFill.slice(0, 60).join(',')], 15000);
      let geoMap = {};
      try { geoMap = g.ok && g.output ? JSON.parse(g.output) : {}; } catch (e) { geoMap = {}; }
      const fill = (row) => {
        if (!row.geo) row.geo = String((geoMap[row.ip] || {}).place || '');
      };
      pending.forEach(fill);
      blocks.forEach(fill);
    }

    const live = await runFrpGuard(['json'], 40000);
    let snapshot = null;
    try { snapshot = live.ok && live.output ? JSON.parse(live.output) : null; } catch (e) { snapshot = null; }

    /* 阈值从脚本常量读，和 infra_watch 的做法保持一致，避免两处维护 */
    const src = readTextSafe(FRP_GUARD_PY);
    const pick = (re, d) => { const m = src.match(re); return m ? Number(m[1]) : d; };

    /* 同一个 SSH 服务会同时出现在 frps（按 proxy 名）和 haproxy（按后端名）两侧，
       这里按「中文服务名」合并，避免页面上同一服务出现两行。 */
    const alias = (snapshot && snapshot.proxy_names) || {};
    const merged = new Map();
    topProxyRaw.forEach((t) => {
      const name = alias[t.proxy] || t.proxy;
      merged.set(name, (merged.get(name) || 0) + t.n);
    });
    const topProxy = [...merged.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);

    /* 24h 涉及服务数按中文名去重（双源合并后口径） */
    const services24 = new Set(svcRowsRaw.map((r) => alias[r.proxy] || r.proxy)).size;

    /* 自动封禁开关的真实状态。
       不返回它，面板上那个 Toggle 只能显示默认的「关闭」—— 用户以为没开、
       实际开着，值守脚本照旧自动执行。老库没有 settings 表时按关闭处理，
       与 frp_guard.py 的 auto_ban_enabled() 保持同一语义。 */
    let autoBan = { enabled: false, updated_at: '', updated_by: '' };
    try {
      const row = sqliteAll(SECURITY_DB,
        "select value, updated_at, updated_by from settings where key = 'auto_ban_foreign'")[0];
      const v = String((row && row.value) || '').trim().toLowerCase();
      autoBan = {
        enabled: ['1', 'true', 'on', 'yes'].includes(v),
        updated_at: (row && row.updated_at) || '',
        updated_by: (row && row.updated_by) || '',
      };
    } catch (e) { /* 没有 settings 表：保持关闭 */ }

    return {
      summary24h: { total: sum.n || 0, sources: sum.ips || 0, services: services24 },
      topIps, topProxy, hourly, pending, blocks,
      auto_ban: autoBan,
      snapshot,
      snapshot_ok: live.ok,
      snapshot_error: live.error || '',
      thresholds: {
        window_min: pick(/^WINDOW_MIN = (\d+)/m, 10),
        hits_med: pick(/^TH_HITS_MED = (\d+)/m, 8),
        hits_high: pick(/^TH_HITS_HIGH = (\d+)/m, 20),
        hits_crit: pick(/^TH_HITS_CRIT = (\d+)/m, 60),
        sensitive: pick(/^TH_SENSITIVE = (\d+)/m, 8),
        subnet_ips: pick(/^TH_SUBNET_IPS = (\d+)/m, 5),
        bytes_fail: pick(/^TH_BYTES_FAIL = (\d+)/m, 2500),
        bytes_shell: pick(/^TH_BYTES_SHELL = (\d+)/m, 4000),
        cooldown_alert_s: pick(/^COOLDOWN_ALERT = (\d+)/m, 3600),
        alert_min_interval_s: pick(/^ALERT_MIN_INTERVAL = (\d+)/m, 1800),
        max_block_per_day: pick(/^MAX_BLOCK_PER_DAY = (\d+)/m, 20),
        default_ttl_s: pick(/^DEFAULT_BLOCK_TTL = (\d+)/m, 86400),
      },
      generated_at: new Date().toISOString(),
    };
  });
}

/**
 * 审批完成后把飞书那张卡改成结果态。
 *
 * 卡片是助手机上的 feishu_ban_card.py 发的，message_id 也记在 blocks 里，
 * 所以这里只给授权码，让脚本自己去查。**页面这条路以前完全不管卡片** ——
 * 在页面上点了批准，群里那张卡还停在「待审批」、按钮还亮着，看起来像没生效。
 *
 * best-effort：改卡失败不影响封禁已经执行这件事，更不能把接口返回变成失败。
 */
function syncBanCard(code, approve, detail) {
  const script = path.join(HERMES_HOME, 'scripts', 'feishu_ban_card.py');
  if (!fs.existsSync(script)) return;
  try {
    const child = spawn('python3', [
      script, 'update', '--code', code,
      '--state', approve ? 'approved' : 'rejected',
      '--by', '网页', '--detail', String(detail || '').slice(0, 120),
    ], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch (e) { /* 卡片只是通知，不是事实来源 */ }
}

/* 授权封禁：必须同时具备「已登录会话」+「有效授权码」。
 * 授权码由白饭通过 frp_guard.py request 生成，6 位、6 小时过期、一次性。
 * 服务端只做转发，真正的校验在 Python 侧（ticket + pending + 有效期 + 白名单 + 配额）。 */
async function handleSecurityDecision(req, res, approve) {
  const body = await readJsonBody(req, 32 * 1024);
  const code = String((body && body.code) || '').trim().toUpperCase();
  const send = (obj, code2 = 200) => sendJson(res, code2, obj);

  if (!/^[A-Z0-9]{6}$/.test(code)) return send({ error: '授权码格式不正确' }, 400);

  /* 谁批的：网页和飞书这两条路都会走到这里，审计要分得清。
     飞书那侧自己会把卡片改成结果态（还带操作人名），所以这里不再重复 PATCH。
     operator 是飞书回调里的点击者姓名：面板侧已经按所有者白名单校验过身份，
     这里负责把"是谁"落到审计里 —— 只写"飞书授权"的话，事后查不出人。 */
  const by = String((body && body.by) || '').trim() === '飞书' ? '飞书' : '网页';
  const operator = String((body && body.operator) || '').trim().slice(0, 40);
  const byLabel = by + '授权' + (operator ? `（${operator}）` : '');

  const d = approve
    ? await runFrpGuard(['approve', '--code', code, '--by', byLabel, '--apply'], 45000)
    : await runFrpGuard(['reject', '--code', code, '--by', byLabel.replace('授权', '拒绝')], 20000);

  _cache.delete('security');   /* 决策后立刻失效缓存，页面能马上看到状态 */
  /* 决策落库之后同步飞书卡片：不 await，卡片慢不该拖住接口 */
  if (d.ok && by !== '飞书') syncBanCard(code, approve, d.output);

  /* 失败时必须给出原因：Python 侧 stderr 可能是空的，只回 ok:false 的话
     面板只能显示"数据桥失败（HTTP 400）"，人完全不知道发生了什么 */
  const detail = String(d.error || '').trim() || String(d.output || '').trim()
    || '助手侧未给出原因（命令可能没有执行）';
  return send({ ok: d.ok, output: d.output, error: detail }, d.ok ? 200 : 400);
}

/**
 * 手动解封。
 *
 * 和封禁一样会真的改 frps 规则，所以只挂在 POST 上、只收 IP 字面量；
 * 是否真删掉由 frp_guard.py 决定（它删不成功就不会把记录改成 revoked）。
 */
async function handleSecurityUnblock(req, res) {
  const body = await readJsonBody(req, 8 * 1024);
  const ip = String((body && body.ip) || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 400, { error: 'IP 格式不正确' });

  const d = await runFrpGuard(['unblock', '--ip', ip, '--apply', '--by', '网页解封'], 45000);
  _cache.delete('security');
  const detail = String(d.error || '').trim() || String(d.output || '').trim();
  if (!d.ok) return sendJson(res, 400, { ok: false, error: detail || '助手机未给出原因' });
  return sendJson(res, 200, { ok: true, ip, output: d.output });
}

/* 白名单文件与 frp_guard.py 的 ALLOW_FILE 同一个：它是「自己人不会被自己封」
   的最后一道阀，页面能改才算真正可用（以前只能 ssh 上去编辑）。 */
const ALLOW_FILE = path.join(HERMES_HOME, 'scripts', 'frp_guard_allow.txt');

function readAllowLines() {
  try {
    return fs.readFileSync(ALLOW_FILE, 'utf8').split('\n');
  } catch (e) { return []; }
}

function allowEntries() {
  const out = [];
  readAllowLines().forEach((line) => {
    const body = line.split('#')[0].trim();
    if (!body) return;
    out.push({ value: body, note: (line.split('#')[1] || '').trim() });
  });
  return out;
}

/* 写之前先校验。一个手滑的 0.0.0.0/0 等于把整套防护关掉，
   这种事不能靠人自觉 —— 掩码比 /8 还宽的一律拒掉。 */
function parseAllowEntry(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split('.').every((n) => Number(n) <= 255) ? v : null;
  }
  const m = v.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  if (!m[1].split('.').every((n) => Number(n) <= 255)) return null;
  const bits = Number(m[2]);
  if (bits < 8 || bits > 32) return null;
  return v;
}

async function handleSecurityAllow(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, { path: ALLOW_FILE, entries: allowEntries() });
  }
  let body;
  try { body = await readJsonBody(req, 8 * 1024); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const action = String(body?.action || 'add');
  const entry = parseAllowEntry(body?.entry);
  if (!entry) return sendJson(res, 400, { error: '只接受 IPv4 或 CIDR（掩码不小于 /8）' });

  const lines = readAllowLines();
  const exists = allowEntries().some((e) => e.value === entry);
  if (action === 'add' && !exists) {
    /* 追加前补一个换行：文件末尾没有换行时直接 push 会把两条粘成一条 */
    if (lines.length && lines[lines.length - 1].trim()) lines.push(entry);
    else lines.push(entry);
  } else if (action === 'remove' && exists) {
    const kept = lines.filter((l) => l.split('#')[0].trim() !== entry);
    lines.length = 0;
    kept.forEach((l) => lines.push(l));
  }
  try {
    fs.writeFileSync(ALLOW_FILE, lines.join('\n'), { mode: 0o600 });
    /* mode 只在新建文件时生效；覆盖已有文件会保留旧权限，
       所以显式再 chmod 一次，别在磁盘上留一份 0644 的名单 */
    try { fs.chmodSync(ALLOW_FILE, 0o600); } catch (e) { /* 文件系统不支持就算了 */ }
  } catch (e) {
    return sendJson(res, 500, { error: '写白名单失败：' + e.message });
  }
  return sendJson(res, 200, { ok: true, entries: allowEntries() });
}

/**
 * 境外 IP 自动封禁总开关。
 *
 * 这个接口以前根本没实现：面板上那个 Toggle 一点就 405（Method Not Allowed），
 * 所以"关掉了"其实什么也没关 —— 库里 auto_ban_foreign 还是老值，值守脚本
 * 继续按旧状态自动执行。教训是：开关这种能改变"封禁要不要等人"的东西，
 * 必须把写入链路走通，否则界面在撒谎。
 *
 * 只认显式布尔：传错类型一律按"关闭"处理，绝不因为缺参而把开关打开。
 */
async function handleSecurityAutoBan(req, res) {
  const body = await readJsonBody(req, 8 * 1024);
  const enabled = body?.enabled === true;
  const d = await runFrpGuard(['auto-ban', enabled ? '--on' : '--off', '--by', '网页设置'], 20000);
  _cache.delete('security');
  const detail = String(d.error || '').trim() || String(d.output || '').trim();
  if (!d.ok) return sendJson(res, 400, { ok: false, error: detail || '助手侧未给出原因（命令可能没有执行）' });
  return sendJson(res, 200, { ok: true, enabled, output: d.output });
}

/* ---------- 公开的工位状态（登录页用，无需登录） ----------
 * 只暴露「数量 + 在线与否」，不含任何路径/凭证/业务数据。
 * 在编名单以 index.html 的 AGENTS 为准（司册 / 白饭 / 拾贝 / 尾流），改名单时两处一起改。
 * 在线判定全部走真实探活：网关健康检查、MCP stdio 握手、scrapling 可导入、运维值守任务存在。 */
const OFFICE_SEATS = 6;
const OFFICE_ROSTER = [
  { id: 'mcp-filesystem', name: '司册', en: 'Filesystem MCP' },
  { id: 'hermes', name: '白饭', en: 'Hermes' },
  { id: 'shabei', name: '拾贝', en: 'Harvester' },
  { id: 'weiliu', name: '尾流', en: 'Wake' },
];

/* 拾贝在线判定：抓取执行器在位 + 本机 python 真的能 import scrapling
   （结果缓存 5 分钟，避免每次轮询都 spawn 一个解释器） */
const SCRAPLING_TTL = 300000;
let _scrapling = { at: 0, ok: false, version: '' };
function scraplingReady() {
  if (Date.now() - _scrapling.at < SCRAPLING_TTL) return Promise.resolve(_scrapling);
  if (!fs.existsSync(path.join(ROOT, 'scripts', 'scrape.py'))) {
    _scrapling = { at: Date.now(), ok: false, version: '' };
    return Promise.resolve(_scrapling);
  }
  return new Promise((resolve) => {
    execFile(PY, ['-c', 'import scrapling;print(getattr(scrapling,"__version__","") or "")'],
      { timeout: 8000 }, (err, stdout) => {
        _scrapling = { at: Date.now(), ok: !err, version: err ? '' : String(stdout || '').trim() };
        resolve(_scrapling);
      });
  });
}

let _officeStatus = { at: 0, val: null };
const OFFICE_STATUS_TTL = 5000;        /* 5 秒内复用，登录页轮询不会打到网关 */

/* 在线判断只要「有没有值守任务」，不要跑 infra_watch.py 的 state/alerts 探针
   （那两个加起来约 5 秒）。完整探针留给 /local/watch 页签按需取。 */
function watchJobCount() {
  return gwGet('/api/jobs')
    .then((d) => ((d && d.jobs) || []).filter((j) => /运维值守/.test(j.name || '')).length)
    .catch(() => 0);
}

function buildOfficeStatus() {
  return Promise.all([
    gwGet('/health/detailed').catch(() => null),
    mcpPayload().catch(() => null),
    watchJobCount(),
    scraplingReady().catch(() => ({ ok: false })),
  ]).then(([gw, mcp, watchJobs, scr]) => {
    const mcpProbe = ((mcp && mcp.probes) || []).find((p) => p.name === 'filesystem');
    const flags = {
      'hermes': !!(gw && gw.status === 'ok'),
      'mcp-filesystem': !!(mcpProbe && mcpProbe.ok),
      'shabei': !!(scr && scr.ok),
      'weiliu': watchJobs > 0,
    };
    const items = OFFICE_ROSTER.map((a) => ({
      id: a.id, name: a.name, en: a.en, online: !!flags[a.id],
    }));
    return {
      seats: OFFICE_SEATS,
      staffed: items.length,
      vacant: Math.max(0, OFFICE_SEATS - items.length),
      online: items.filter((a) => a.online).length,
      gateway_version: (gw && gw.version) || '',
      items,
      checked_at: new Date().toISOString(),
    };
  });
}
function officeStatusPayload() {
  if (_officeStatus.val && Date.now() - _officeStatus.at < OFFICE_STATUS_TTL) {
    return Promise.resolve(_officeStatus.val);
  }
  return buildOfficeStatus().then((val) => {
    _officeStatus = { at: Date.now(), val };
    return val;
  });
}

/* ---------- 拾贝 · 意图解析（AI 层） ----------
 * 目标：把「把 quotes 站前 3 页的名言和作者列出来」这类自然语言，交给网关上的模型
 *       解析成结构化的抓取计划，再交给确定性的 scrape.py 执行。
 * 注意：网关只暴露一个 hermes-agent 模型，它本身是「会自己动手」的智能体
 *       （实测即使传 tools:[] 也会自行联网抓取）。所以这里用强约束的
 *       「纯文本转换器」system prompt，并保留本地正则作为兜底，
 *       解析不出来时行为与以前完全一致。 */
const PLAN_TIMEOUT_MS = 30000;
const PLAN_MAX_CHARS = 600;
const PLAN_MEMO_TTL = 300000;
const PLAN_MEMO_MAX = 40;
const _planMemo = new Map();          /* text -> {at, res}，同一句话不重复喂模型 */

/* 暴露给模型的工具描述（网关目前不会回 tool_calls，但保持标准形态，便于以后换成真工具调用） */
const SCRAPE_TOOL = {
  type: 'function',
  function: {
    name: 'web_scrape',
    description: '用本机采集器抓取网页并抽取结构化字段（支持翻页、字段映射、CSV 导出）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http(s) 地址' },
        selector: { type: 'string', description: '每条记录的 CSS 选择器，留空表示取正文' },
        pages: { type: 'integer', description: '翻页深度 1-10' },
        mode: { type: 'string', enum: ['fast', 'stealth', 'dynamic'], description: '抓取引擎' },
        columns: { type: 'array', items: { type: 'string' }, description: '用户想要的列名（不清楚选择器时只给列名，由后续智能抽取生成选择器）' },
        fields: { type: 'object', description: '字段名 -> CSS 选择器，仅在用户明确写出「列名=选择器」时使用' },
      },
      required: ['url'],
    },
  },
};

const PLAN_SYSTEM = [
  '你是「拾贝」的指令解析器，只做文本到 JSON 的转换。',
  '绝对不要联网、不要调用任何工具、不要真的去抓取，只输出 JSON。',
  '把用户的话转成一行 JSON，除 JSON 本身外不要输出任何内容（不要 Markdown 代码块、不要解释）。',
  '输出结构：',
  '{"action":"scrape","args":{"url":"https://...","selector":"","pages":1,"mode":"fast","columns":["列名"],"fields":{}},"reply":""}',
  '规则：',
  '- 抓取/采集/爬取某个网址 -> action=scrape，url 必填且必须以 http(s):// 开头；缺协议时补 https://',
  '- pages 默认 1；用户说「翻N页」「N页」「所有页」时取 N，范围 1-10',
  '- mode 默认 fast；提到「隐身/绕过/反爬」用 stealth；提到「动态/JS 渲染/滚动加载」用 dynamic',
  '- 用户只说想要哪些列（如「文章标题」「名言和作者」）时，把列名原样放进 columns 数组，fields 留空 {}；',
  '  你并没有看过页面，禁止猜 CSS 选择器（不要写 .title / h1 这类），列名会交给下一步的智能抽取去生成选择器',
  '- 只有用户自己写明了「列名=选择器」（如 标题=.title 链接=a@href）时，才放进 fields',
  '- 只是闲聊、问你能做什么、与抓取无关 -> action=chat，reply 用一句中文简短回答（40 字内）',
  '- 要求抓内网/本机/云元数据地址，或明显违法 -> action=reject，reply 说明原因',
  '只输出 JSON。',
].join('\n');

/* 从模型输出里抠出第一个平衡的 JSON 对象（容忍 ```json 围栏与前后废话） */
function extractJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/* 计划白名单校验：模型说什么都行，能落地的只有这三类 */
function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = String(raw.action || '').trim().toLowerCase();
  const reply = harvestClipped(raw.reply, 400);
  if (action === 'chat' || action === 'reject') return { action, reply, args: null };
  if (action !== 'scrape') return null;
  const a = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args : {};
  let url = String(a.url || '').trim();
  /* 模型常漏协议头，这里补上（scrape.py 也会再规范化一次） */
  if (!/^https?:\/\//i.test(url)) {
    if (/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(?:\/\S*)?$/i.test(url)) url = 'https://' + url;
    else return null;
  }
  const mode = ['fast', 'stealth', 'dynamic'].indexOf(String(a.mode)) >= 0 ? String(a.mode) : 'fast';
  return {
    action: 'scrape',
    reply,
    args: {
      url: url.slice(0, 500),
      selector: String(a.selector || '').trim().slice(0, 120),
      pages: clampPages(a.pages),
      mode,
      columns: sanitizeColumns(a.columns),
      fields: sanitizeFields(a.fields),
    },
  };
}

/* 列名白名单：只收名字，不收选择器 —— 选择器交给看到页面之后的智能抽取去生成 */
function sanitizeColumns(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map((c) => String(c == null ? '' : c).replace(/\s+/g, ' ').trim().slice(0, 30))
    .filter(Boolean).slice(0, SCRAPE_MAX_FIELDS);
}

async function harvesterPlan(text) {
  const key = String(text || '').trim().slice(0, PLAN_MAX_CHARS);
  const hit = _planMemo.get(key);
  if (hit && Date.now() - hit.at < PLAN_MEMO_TTL) return Object.assign({ cached: true }, hit.res);

  /* 自我进化：这句话里出现的域名如果有历史经验，一并喂给模型 */
  const host = (key.match(/(?:https?:\/\/)?((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,})/i) || [])[1] || '';
  const notes = host ? siteNotePrompt(host.replace(/^www\./, '')) : '';

  const t0 = Date.now();
  const d = await gwPostJson('/v1/chat/completions', {
    model: 'hermes-agent',
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: (notes ? notes + '\n' : '') + key },
    ],
    tools: [SCRAPE_TOOL],
    temperature: 0,
    max_tokens: 400,
  }, PLAN_TIMEOUT_MS);

  const msg = ((d && d.choices) || [{}])[0].message || {};
  harvUsageBump('plan', (d && d.usage && d.usage.total_tokens) || 0);
  let raw = null;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const argsStr = (msg.tool_calls[0].function || {}).arguments;
    try { raw = JSON.parse(argsStr || '{}'); } catch (_) { raw = null; }
    if (raw && !raw.action) raw = { action: 'scrape', args: raw, reply: '' };
  }
  if (!raw) raw = extractJsonObject(msg.content);
  const plan = sanitizePlan(raw);
  if (!plan) throw new Error('模型输出无法解析为合法计划');

  const res = {
    source: 'llm', plan,
    model: (d && d.model) || '',
    tokens: ((d && d.usage) || {}).total_tokens || 0,
    elapsed_ms: Date.now() - t0,
  };
  _planMemo.set(key, { at: Date.now(), res });
  if (_planMemo.size > PLAN_MEMO_MAX) _planMemo.delete(_planMemo.keys().next().value);
  return res;
}

async function handlePlan(req, res) {
  let body;
  try { body = await readJsonBody(req, 4096); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  const text = String(body.text || '').trim().slice(0, PLAN_MAX_CHARS);
  if (!text) return sendJson(res, 400, { error: '缺少 text' });
  if (!API_KEY) return sendJson(res, 200, { ok: false, reason: '网关凭证未配置，已回退本地解析' });
  try {
    return sendJson(res, 200, Object.assign({ ok: true }, await harvesterPlan(text)));
  } catch (err) {
    console.warn('[hwb-bridge] 拾贝意图解析失败，回退本地规则：' + err.message);
    return sendJson(res, 200, { ok: false, reason: err.message });   /* 200 + ok:false，页面据此回退 */
  }
}

/* ============================================================
 * 拾贝 「AI 抽取 / 清洗 / 自愈」层
 *   统一的调用约定：所有模型调用都在服务端，提示词写死在这里，
 *   模型只产出 JSON，落地前一律过白名单校验；
 *   抽取结果必须做回校验（值要能在页面原文里找到），防幻觉。
 * ============================================================ */
const AI_TIMEOUT_MS = 60000;
const AI_MAX_ROWS = 10;
const SAMPLE_FOR_AI_CHARS = 12000;
const MAX_CELL_CHARS = 300;
const harnessMode = (m) => (['fast', 'stealth', 'dynamic'].indexOf(String(m)) >= 0 ? String(m) : '');

/* 宽容解析：原样试一次，再容忍尾随逗号 / 弯引号这类常见小瑕疵 */
function jsonLoose(str) {
  try { return JSON.parse(str); } catch (_) { /* 继续修 */ }
  try {
    const fixed = str.replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
    return JSON.parse(fixed);
  } catch (_) { return undefined; }
}

/* 逐个「{ / [」起点做括号配对，返回第一个能解析成功的 JSON；都不行返回 null。
   为什么要逐个试：模型常在 JSON 前面写一段解释，里面也可能带 { 或 [，
   旧实现只试第一个起点、一失败就放弃，导致明明后面有完整 JSON 也判为失败。 */
function scanFirstJson(s) {
  let tried = 0;
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== '{' && open !== '[') continue;
    if (++tried > 50) break;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const got = jsonLoose(s.slice(start, i + 1));
          if (got !== undefined) return got;
          break;                      /* 这一段不是 JSON，换下一个起点 */
        }
      }
    }
  }
  return null;
}

/* 从模型输出里抠出 JSON（对象或数组）。能容忍：
   - ```json 代码围栏、前后解释性废话
   - 模型把 JSON 又当字符串输出（整段多包一层引号、内部引号被转义成 \"）
   - 尾随逗号、中文弯引号
   实测网关偶发返回 "{\"row_selector\":...}" 这种双编码，旧实现会直接判失败。 */
function extractJsonValue(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return null;

  /* 双编码：整段是一个 JSON 字符串字面量，它的值才是真正的 JSON */
  for (let i = 0; i < 3 && s[0] === '"'; i++) {
    const inner = jsonLoose(s);
    if (typeof inner !== 'string' || !inner.trim()) break;
    s = inner.trim();
  }
  /* 外层引号不合法（被截断或内部没转义）：手动剥壳还原转义后再扫 */
  if (s[0] === '"') {
    const body = s.replace(/^"+|"+$/g, '')
      .replace(/\\(["\\/])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t');
    const manual = scanFirstJson(body);
    if (manual != null) return manual;
  }

  /* 整段就是 JSON（最常见） */
  const whole = jsonLoose(s);
  if (whole !== undefined && whole !== null && typeof whole === 'object') return whole;

  return scanFirstJson(s);
}

/* 一次模型调用，要求返回 JSON。kind 用于把消耗记到「拾贝今日 Token」上。
   模型偶尔把 JSON 放进推理字段或 tool_calls，这里逐个兜住；
   真的解析不出来时把原始输出前 500 字写进服务日志，下次可直接定位。 */
async function aiJson(system, user, maxTokens, kind) {
  const t0 = Date.now();
  const d = await gwPostJson('/v1/chat/completions', {
    model: 'hermes-agent',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: maxTokens || 900,
  }, AI_TIMEOUT_MS);
  const choice = ((d && d.choices) || [])[0] || {};
  const msg = choice.message || {};
  /* 先记用量：即使这次输出解析失败，token 也已经花掉了 */
  const tokens = (d && d.usage && d.usage.total_tokens) || 0;
  harvUsageBump(kind || 'ai', tokens);

  let raw = extractJsonValue(msg.content);
  if (raw == null && !String(msg.content == null ? '' : msg.content).trim()) {
    /* 正文为空：JSON 可能在推理字段里 */
    raw = extractJsonValue(msg.reasoning_content != null ? msg.reasoning_content : msg.reasoning);
    if (raw != null) console.warn('[hwb-bridge] AI 正文为空，已改从推理字段取 JSON');
  }
  if (raw == null && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    /* 模型改用工具调用承载参数 */
    raw = extractJsonValue((msg.tool_calls[0].function || {}).arguments);
    if (raw != null) console.warn('[hwb-bridge] AI 走的是 tool_calls，已取其中的参数');
  }
  if (raw == null) {
    console.warn('[hwb-bridge] AI 输出解析失败 kind=' + (kind || 'ai') + ' finish=' + (choice.finish_reason || '-')
      + ' tokens=' + tokens + ' 原文前 500 字：'
      + String(msg.content == null ? '(空)' : msg.content).slice(0, 500));
    throw new Error(choice.finish_reason === 'length'
      ? '模型输出被长度上限截断（max_tokens=' + (maxTokens || 900) + '）'
      : '模型输出无法解析为 JSON');
  }
  return { raw, usage: (d && d.usage) || {}, model: (d && d.model) || '', elapsed_ms: Date.now() - t0 };
}

/* ---------- 站点经验库（自我进化：越用越懂每个站） ---------- */
const SITE_NOTES_FILE = path.join(HARVESTER_DIR, 'site-notes.json');
const SITE_NOTE_MAX = 200;
let _siteNotes = null;
function siteNotesLoad() {
  if (_siteNotes) return _siteNotes;
  const d = readJsonSafe(SITE_NOTES_FILE);
  _siteNotes = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  return _siteNotes;
}
function siteNotesSave() {
  try {
    fs.mkdirSync(HARVESTER_DIR, { recursive: true });
    const tmp = SITE_NOTES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_siteNotes), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, SITE_NOTES_FILE);
  } catch (err) {
    console.warn('[hwb-bridge] 站点经验写入失败：' + err.message);
  }
}
function siteHostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}
/* 记一笔经验：成功的抓取配置 / 自愈出来的教训 / 失败原因 */
function siteNoteRecord(host, patch) {
  if (!host) return null;
  const all = siteNotesLoad();
  const cur = all[host] || { ok: 0, fail: 0, lessons: [] };
  const next = Object.assign({}, cur);
  if (patch.ok) next.ok = (cur.ok || 0) + 1;
  if (patch.fail) {
    next.fail = (cur.fail || 0) + 1;
    next.last_error = harvestClipped(patch.fail, 200);
  }
  if (patch.mode) next.mode = harnessMode(patch.mode);
  if (patch.selector) next.selector = harvestClipped(patch.selector, 160);
  if (patch.fields && Object.keys(patch.fields).length) next.fields = patch.fields;
  if (patch.lesson) {
    const l = harvestClipped(patch.lesson, 200);
    next.lessons = [l].concat((cur.lessons || []).filter((x) => x !== l)).slice(0, 5);
    next.learned_at = new Date().toISOString();
  }
  next.updated_at = new Date().toISOString();
  all[host] = next;
  const keys = Object.keys(all);
  if (keys.length > SITE_NOTE_MAX) {
    keys.sort((a, b) => String(all[a].updated_at || '').localeCompare(String(all[b].updated_at || '')));
    delete all[keys[0]];
  }
  siteNotesSave();
  return next;
}
/* ---------- 自我进化（可读层）：把经验追加进 Hermes 的 MEMORY.md ----------
 * 为什么是 MEMORY.md：它被所有 Hermes 智能员工共享，写进去等于让白饭它们也学会
 * 「哪个站怎么抓」。格式沿用 Hermes 记忆文件约定：条目之间用单独一行 § 分隔。
 * 安全边界：
 *   - 只追加 / 只删我们自己带标记的旧条目，别的内容一个字都不动
 *   - 内容重复则不写（按空白归一化后比较）
 *   - 写入用「临时文件 + rename」原子替换，避免与网关自己的记忆写入撞车写坏文件
 *   - AO_MEMORY_FILE 设为空字符串可整体关闭；AO_MEMORY_MAX 控制我们最多留几条 */
const MEMORY_FILE = process.env.AO_MEMORY_FILE != null
  ? String(process.env.AO_MEMORY_FILE).trim()
  : path.join(HERMES_HOME, 'memories', 'MEMORY.md');
const MEMORY_TAG = '[拾贝采集]';
const MEMORY_MAX_ENTRIES = Number(process.env.AO_MEMORY_MAX || 24);

function memorySplit(content) {
  const blocks = [];
  let cur = [];
  String(content || '').split('\n').forEach((ln) => {
    if (ln.trim() === '§') { blocks.push(cur.join('\n')); cur = []; }
    else cur.push(ln);
  });
  blocks.push(cur.join('\n'));
  return blocks;
}
function memoryEntries() {
  if (!MEMORY_FILE) return [];
  let content = '';
  try { content = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch (_) { return []; }
  return memorySplit(content).filter((b) => b.trim().startsWith(MEMORY_TAG));
}
/* 追加一条经验；返回 {written, reason} */
function memoryAppend(rawLine) {
  if (!MEMORY_FILE) return { written: false, reason: 'MEMORY.md 写入已关闭（AO_MEMORY_FILE 为空）' };
  const line = String(rawLine || '').replace(/\s+/g, ' ').trim();
  if (!line) return { written: false, reason: '空内容' };

  let content = '';
  try { content = fs.readFileSync(MEMORY_FILE, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') return { written: false, reason: err.message }; }

  /* 整个读-改-写是同步的，进程内不会被打断；跨进程靠原子替换 */
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(line);
  const blocks = memorySplit(content);
  if (blocks.some((b) => norm(b) === target)) return { written: false, reason: '已存在相同经验' };

  let kept = blocks.filter((b) => b.trim());
  const ours = kept.filter((b) => b.trim().startsWith(MEMORY_TAG));
  if (ours.length >= MEMORY_MAX_ENTRIES) kept = kept.filter((b) => b !== ours[0]);  /* 只淘汰我们最旧的一条 */
  kept.push(line);

  const out = '\n' + kept.map((b) => b.trim()).join('\n§\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const tmp = MEMORY_FILE + '.ao-tmp';
    fs.writeFileSync(tmp, out, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, MEMORY_FILE);
  } catch (err) {
    return { written: false, reason: err.message };
  }
  console.log('[hwb-bridge] 拾贝经验已写入 ' + MEMORY_FILE + '：' + line.slice(0, 80));
  return { written: true };
}
/* 一条经验的统一格式：标记 + 站点 + 内容 */
function memoryLearn(host, text) {
  const t = harvestClipped(text, 240);
  if (!host || !t) return { written: false, reason: '缺少站点或内容' };
  return memoryAppend(MEMORY_TAG + ' ' + host + '：' + t);
}

/* ---------- 拾贝自己的 AI 消耗（按天累计，给工位「今日 Token」用） ----------
 * 口径：只统计「为拾贝花的模型调用」——理解指令 / 生成选择器 / 清洗 / 自愈。
 * 纯抓取（scrape.py）不经过模型，不消耗 token。 */
const HARV_USAGE_FILE = path.join(HARVESTER_DIR, 'harvester-usage.json');
const HARV_USAGE_KEEP_DAYS = 30;
let _harvUsage = null;
function harvUsageLoad() {
  if (_harvUsage) return _harvUsage;
  const d = readJsonSafe(HARV_USAGE_FILE);
  _harvUsage = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  return _harvUsage;
}
function harvUsageSave() {
  try {
    fs.mkdirSync(HARVESTER_DIR, { recursive: true });
    const tmp = HARV_USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_harvUsage), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, HARV_USAGE_FILE);
  } catch (err) { console.warn('[hwb-bridge] 拾贝用量写入失败：' + err.message); }
}
function harvUsageBump(kind, tokens) {
  const n = Math.floor(Number(tokens) || 0);
  if (n <= 0) return;
  const day = localDay(Math.floor(Date.now() / 1000));
  const all = harvUsageLoad();
  const cur = all[day] || { tokens: 0, calls: 0, by_kind: {} };
  cur.tokens += n;
  cur.calls += 1;
  cur.by_kind[kind] = (cur.by_kind[kind] || 0) + n;
  all[day] = cur;
  const keys = Object.keys(all).sort();
  while (keys.length > HARV_USAGE_KEEP_DAYS) delete all[keys.shift()];
  _harvUsage = all;
  harvUsageSave();
}
function harvUsageToday() {
  const day = localDay(Math.floor(Date.now() / 1000));
  const cur = harvUsageLoad()[day] || { tokens: 0, calls: 0, by_kind: {} };
  return { day, tokens: cur.tokens || 0, calls: cur.calls || 0, by_kind: cur.by_kind || {} };
}

/* 本机服务已连续运行多少秒（拾贝的「连续在线」就看这个：采集执行器跑在这个进程里） */
/* 网关拉起的 MCP 常驻子进程（stdio 长连接）。
 * 直接扫 /proc 拿真实进程与启动时间，不去解析 config.yaml，也不依赖网关自报。 */
const MCP_PROC_TTL = 10000;
let _mcpProc = { at: 0, list: [] };
function mcpProcesses() {
  if (Date.now() - _mcpProc.at < MCP_PROC_TTL) return _mcpProc.list;
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync('/proc'); } catch (_) { return _mcpProc.list; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').replace(/\0/g, ' ').trim(); } catch (_) { continue; }
    const m = cmd.match(/@modelcontextprotocol\/server-([\w.-]+)/);
    if (!m) continue;
    const pid = Number(d);
    const startedAt = procStartEpoch(pid);
    out.push({
      pid,
      name: m[1].replace(/-server$/, ''),          /* server-filesystem -> filesystem */
      uptime_s: startedAt ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt) : 0,
      started_at: startedAt ? new Date(startedAt * 1000).toISOString() : '',
      cmd: cmd.slice(0, 180),
    });
  }
  out.sort((a, b) => b.uptime_s - a.uptime_s);
  _mcpProc = { at: Date.now(), list: out };
  return out;
}

/* 给提示词用的「本站经验」文本块 */
function siteNotePrompt(host) {
  const n = siteNotesLoad()[host];
  if (!n) return '';
  const parts = [];
  if (n.mode) parts.push('可用引擎 ' + n.mode);
  if (n.selector) parts.push('可用记录选择器 ' + n.selector);
  if (n.fields && Object.keys(n.fields).length) parts.push('可用字段 ' + JSON.stringify(n.fields));
  if (n.ok || n.fail) parts.push('历史成功 ' + (n.ok || 0) + ' 次 / 失败 ' + (n.fail || 0) + ' 次');
  const lines = [];
  if (parts.length) lines.push('· ' + parts.join('；'));
  if (n.last_error) lines.push('· 上次失败原因：' + n.last_error);
  (n.lessons || []).forEach((l) => lines.push('· 经验：' + l));
  if (!lines.length) return '';
  return '本站历史经验（优先参考，别重复踩坑）：\n' + lines.join('\n') + '\n';
}

/* ---------- 回校验：抽出来的值必须能在页面原文里找到 ---------- */
const normForMatch = (s) => String(s == null ? '' : s)
  .toLowerCase()
  .replace(/&nbsp;|&amp;/g, ' ')
  .replace(/[\s\u3000]+/g, '')
  .replace(/[,]/g, '');
const digitsOf = (s) => (String(s == null ? '' : s).match(/\d+(?:\.\d+)?/g) || []).join('');

/* 单元格核对：
   exact  = 归一化后能在原文里找到
   loose  = 数字部分能对上（模型只是改写了格式，例如 2026-09-27 -> 2026/09/27）
   missing= 找不到，疑似幻觉
   short/empty = 信息太少不做判断 */
function verifyCell(value, pageText, normText, digitStream) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return 'empty';
  if (v.length < 2) return 'short';
  if (normText.indexOf(normForMatch(v)) >= 0) return 'exact';
  const d = digitsOf(v);
  if (d && d.length >= 2 && normText.indexOf(d) >= 0) return 'loose';
  if (d && d.length >= 3 && digitStream && digitStream.indexOf(d) >= 0) return 'loose';
  return 'missing';
}
function verifyRows(columns, rows, sourceText) {
  const normText = normForMatch(sourceText);
  const digitStream = (String(sourceText || '').match(/\d/g) || []).join('');
  const cells = [];
  const colStat = columns.map((c) => ({ field: c, ok: 0, flagged: 0, empty: 0 }));
  rows.forEach((row, ri) => {
    columns.forEach((col, ci) => {
      const status = verifyCell(row[ci], sourceText, normText, digitStream);
      if (status === 'empty') colStat[ci].empty++;
      else if (status === 'missing') { colStat[ci].flagged++; cells.push({ row: ri, col, value: harvestClipped(row[ci], 80), status }); }
      else colStat[ci].ok++;
    });
  });
  const checked = colStat.reduce((n, s) => n + s.ok + s.flagged, 0);
  const confidence = checked ? Math.round((checked - cells.length) / checked * 100) : 0;
  return {
    checked, flagged: cells.length, confidence, cells: cells.slice(0, 40),
    columns: colStat,
    note: rows.length ? '核对范围：本次页面原文（含 HTML 标签内文本）' : '没有可核对的行',
  };
}

/* ---------- B：智能抽取（自动生成选择器 / 直接语义抽取） ---------- */
const AI_SELECTOR_SYSTEM = [
  '你是网页结构分析器。只输出 JSON，绝对不要联网、不要执行抓取。',
  '下面会给你一段网页 HTML 样本和一组字段名，请给出每个字段对应的 CSS 选择器。',
  '输出结构：{"row_selector":"每条记录的容器选择器（列表页才需要，详情页留空）","selectors":{"字段名":"css选择器"}}',
  '要求：',
  '- 记录选择器必须限定在内容区域，不要匹配到导航、页脚、广告位、登录入口那些列表项',
  '- 选择器写在「一条记录内部」，不要以 html/body 开头，尽量用稳定的 class/id，别用 :nth-child 这类脆弱定位',
  '- 取属性用 @属性名，例如 链接=a@href、图片=img@src；记录选择器本身就是 <a> 时链接写成 @href',
  '- 字段选择器必须能在记录元素内部真正匹配到内容，宁可用「父级 + 子元素」这种稳一点的组合',
  '- 找不到对应元素的字段，不要出现在 selectors 里（宁缺勿编）',
  '- 只输出 JSON',
].join('\n');

const AI_VALUE_SYSTEM = [
  '你是网页信息抽取器。只输出 JSON，绝对不要联网。',
  '从下面的 HTML 样本里抽取指定字段。',
  '输出结构：{"fields":["字段名"],"rows":[{"字段名":"值"}]}',
  '要求：',
  '- 值必须是页面里真实存在的原文，原样摘录，不要改写、不要翻译、不要编造、不要自己算',
  '- 列表页最多抽 ' + AI_MAX_ROWS + ' 条；详情页就 1 条',
  '- 抽不到的字段给空字符串，不要猜',
  '- 只输出 JSON',
].join('\n');

function samplePayloadOf(body) {
  return {
    url: String(body.url || '').trim(),
    mode: harnessMode(body.mode) || 'fast',
    limit: 1, adaptive: true, robots: body.robots !== false, sample: true,
  };
}

async function handleAiExtract(req, res) {
  let body;
  try { body = await readJsonBody(req, 16384); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  if (!API_KEY) return sendJson(res, 200, { ok: false, reason: '网关凭证未配置' });

  const args = samplePayloadOf(body);
  if (!/^https?:\/\//i.test(args.url)) return sendJson(res, 400, { error: '缺少合法 url' });
  const strategy = String(body.strategy || 'selectors') === 'values' ? 'values' : 'selectors';
  /* 用户自己写死的字段选择器：AI 只补剩下的列 */
  const fixed = sanitizeFields(body.fixed);
  const fixedKeys = Object.keys(fixed);
  const want = (Array.isArray(body.fields) ? body.fields : [])
    .map((f) => String(f || '').trim().slice(0, 30)).filter(Boolean)
    .filter((f) => !fixed[f]).slice(0, SCRAPE_MAX_FIELDS);
  const host = siteHostOf(args.url);
  const t0 = Date.now();

  let smp;
  try { smp = await runScrape(args); } catch (err) { return sendJson(res, 200, { ok: false, step: 'sample', reason: err.message }); }
  if (!smp || !smp.ok) return sendJson(res, 200, { ok: false, step: 'sample', reason: (smp && smp.error) || '取样失败' });
  /* 取样阶段就发现是登录墙/验证墙：直接说清楚，别浪费一次模型调用 */
  if (smp.blocked) {
    return sendJson(res, 200, {
      ok: false, step: 'sample', blocked: smp.blocked, title: smp.title || '',
      reason: (smp.blocked_reason || '页面被登录/验证墙拦住') + '，看不到真正的内容',
    });
  }

  const notes = siteNotePrompt(host);
  const sample = harvestClipped(smp.sample, SAMPLE_FOR_AI_CHARS);
  let out, usage = {}, model = '', elapsed_ai = 0;

  if (strategy === 'values') {
    const ask = want.length
      ? '字段：' + want.join('、')
      : '用户没指定字段：请按页面主题自行给出 2-6 个最值得抽的字段名（中文，简短）';
    try {
      const r = await aiJson(AI_VALUE_SYSTEM, (notes ? notes + '\n' : '') + ask + '\n\nHTML 样本：\n' + sample, 1200, 'extract');
      out = r.raw; usage = r.usage; model = r.model; elapsed_ai = r.elapsed_ms;
    } catch (err) {
      return sendJson(res, 200, { ok: false, step: 'ai', reason: err.message, sample_title: smp.title });
    }
    const cols = (Array.isArray(out.fields) ? out.fields : want)
      .map((f) => String(f || '').trim().slice(0, 30)).filter(Boolean).slice(0, SCRAPE_MAX_FIELDS);
    if (!cols.length) return sendJson(res, 200, { ok: false, step: 'ai', reason: '模型没有给出字段名' });
    const rawRows = Array.isArray(out.rows) ? out.rows.slice(0, AI_MAX_ROWS) : [];
    const rows = rawRows.map((r) => cols.map((c) => {
      const v = (r && typeof r === 'object') ? r[c] : '';
      return Array.isArray(v) ? v.join(' / ') : harvestClipped(v, MAX_CELL_CHARS);
    }));
    /* 也留一份到抓取历史，保持「历史抓取记录」完整 */
    harvesterRecord({ url: args.url, selector: '(AI 语义抽取)', mode: args.mode }, {
      ok: true, host, mode: args.mode, title: smp.title || '', status: smp.status,
      fields: cols, count: rows.length, total: rows.length, elapsed_ms: Date.now() - t0,
      items: rows.map((r) => ({
        text: r.join(' | '),
        fields: Object.fromEntries(cols.map((c, i) => [c, r[i]])),
      })),
    });
    return sendJson(res, 200, {
      ok: true, strategy: 'values', url: args.url, source_url: smp.url, host,
      title: smp.title || '', columns: cols, rows,
      verify: verifyRows(cols, rows, smp.verify_text || smp.text || ''),
      meta: { model, tokens: usage.total_tokens || 0, ai_ms: elapsed_ai, total_ms: Date.now() - t0, notes_used: !!notes },
    });
  }

  /* strategy = selectors：先生成选择器，再用确定性执行器真抓一遍；
     跑完按列统计非空率，哪列一条都没匹配到就把情况反馈给模型重来一次（只重试一次）。 */
  let retried = false;
  try {
    const r = await aiJson(AI_SELECTOR_SYSTEM, (notes ? notes + '\n' : '') + '字段：' + (want.join('、') || '（自行判断）')
      + (fixedKeys.length ? '（这些列已由用户指定选择器，不用你给：' + fixedKeys.join('、') + '）' : '')
      + '\n\nHTML 样本：\n' + sample, 1600, 'extract');
    out = r.raw; usage = r.usage; model = r.model; elapsed_ai = r.elapsed_ms;
  } catch (err) {
    return sendJson(res, 200, { ok: false, step: 'ai', reason: err.message, sample_title: smp.title });
  }
  const first = readSelectors(out);
  if (!first) return sendJson(res, 200, { ok: false, step: 'ai', reason: '模型没有给出可用选择器' });

  /* 用户自己写死的字段选择器优先，AI 只补缺的列 */
  const mergedSel = Object.assign({}, first.selectors, fixed);
  let attempt = await runSelectorAttempt(args.url, args.mode, body, first.rowSelector, mergedSel);
  if (attempt.dropped) logLine('丢弃导航/垃圾行 ' + attempt.dropped + ' 行');
  if (needSelectorRetry(attempt)) {
    const problems = selectorProblems(attempt);
    logLine('AI 选择器需要修正：' + problems.join('；'));
    try {
      const r2 = await aiJson(AI_SELECTOR_SYSTEM, selectorFeedback(notes, smp, want, fixedKeys, attempt, problems), 900, 'extract');
      const second = readSelectors(r2.raw);
      if (second) {
        const merged2 = Object.assign({}, second.selectors, fixed);
        const a2 = await runSelectorAttempt(args.url, args.mode, body, second.rowSelector, merged2);
        if (!a2.error && scoreOf(a2) > scoreOf(attempt)) {
          attempt = a2; out = r2.raw; retried = true;
          usage = { total_tokens: (usage.total_tokens || 0) + (r2.usage.total_tokens || 0) };
          elapsed_ai += r2.elapsed_ms;
        }
      }
    } catch (err) { logLine('选择器自我修正失败，沿用第一版: ' + err.message); }
  }
  if (attempt.error) {
    return sendJson(res, 200, { ok: false, step: 'execute', reason: attempt.error, selectors: mergedSel, row_selector: first.rowSelector });
  }
  const { exec, cols, rows, selMap, rowSel } = attempt;
  /* 没抓到有效行就不是「跑通」，只记失败原因，别把无效配置沉淀成经验 */
  if (!rows.length) {
    siteNoteRecord(host, { fail: 'AI 生成的选择器没抓到有效内容' });
    return sendJson(res, 200, {
      ok: false, step: 'execute', blocked: '',
      reason: 'AI 生成的选择器没抓到有效内容（可能该页需要登录、或页面结构特殊）',
      selectors: selMap, row_selector: rowSel,
    });
  }
  siteNoteRecord(host, { ok: 1, mode: args.mode, selector: rowSel, fields: selMap });
  /* 自我进化：AI 摸索出来的可用选择器值得沉淀（同一份配置只会写一次） */
  const memory = memoryLearn(host, (retried ? 'AI 修正后的选择器跑通了' : 'AI 生成的选择器跑通了')
    + '：记录 ' + (rowSel || '(正文)') + '，字段 ' + JSON.stringify(selMap));
  harvesterRecord(
    { url: args.url, selector: rowSel, mode: args.mode },
    Object.assign({}, exec, { selector: rowSel || '(AI 生成)' }),
  );
  /* 回校验只能拿「取样页」的原文来对：翻了多页时，超出第一页的行不能核对，
     否则会把第 2 页的真实数据误判成幻觉 —— 所以这里缩小范围并明确告知。 */
  const firstCount = (exec.pages && exec.pages[0] && exec.pages[0].count) || rows.length;
  const scoped = rows.slice(0, firstCount);
  const verify = verifyRows(cols, scoped, smp.verify_text || smp.text || '');
  verify.partial = rows.length > scoped.length;
  verify.scope = verify.partial
    ? ('只核对了取样页（第 1 页 ' + scoped.length + ' 行）；其余 ' + (rows.length - scoped.length) + ' 行未核对')
    : '';
  return sendJson(res, 200, {
    ok: true, strategy: 'selectors', url: args.url, source_url: smp.url, host,
    title: exec.title || smp.title || '', columns: cols, rows,
    selectors: selMap, row_selector: rowSel, retried, dropped: attempt.dropped || 0,
    pages: exec.pages, pages_fetched: exec.pages_fetched, note: exec.note,
    verify, memory,
    meta: { model, tokens: usage.total_tokens || 0, ai_ms: elapsed_ai, total_ms: Date.now() - t0, notes_used: !!notes },
  });
}

/* ---------- 选择器生成/校验的公共件 ---------- */
const logLine = (m) => console.log('[hwb-bridge] ' + m);

/* 从模型输出里取出合法选择器；不合法返回 null */
function readSelectors(raw) {
  const selMap = {};
  const rawSel = (raw && typeof raw.selectors === 'object' && raw.selectors) ? raw.selectors : {};
  for (const [k, v] of Object.entries(rawSel)) {
    const name = harvestClipped(k, 30), expr = harvestClipped(v, 200);
    if (name && expr && !/^(html|body)$/i.test(expr.trim())) selMap[name] = expr;
    if (Object.keys(selMap).length >= SCRAPE_MAX_FIELDS) break;
  }
  if (!Object.keys(selMap).length) return null;
  return { selectors: selMap, rowSelector: harvestClipped(raw && raw.row_selector, 200) };
}

/* 导航/页脚/登录入口那类「垃圾行」的特征值：整行只有这种值就丢掉 */
const JUNK_VALUE_RE = /^(?:javascript:|mailto:|tel:|#)|^\/{0,2}(?:download|login|logout|register|signup|passport|user|member|account|help|about|contact|privacy|terms|app|cookie)\b/i;
function isJunkRow(values) {
  const vals = values.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  if (!vals.length) return true;                       /* 整行全空 */
  return vals.every((v) => JUNK_VALUE_RE.test(v));      /* 只剩导航链接 */
}

/* 用一套选择器真抓一遍，并统计每列的非空率 */
async function runSelectorAttempt(url, mode, body, rowSel, selMap) {
  let exec;
  try {
    exec = await runScrape({
      url, selector: rowSel, mode, limit: 20,
      adaptive: true, robots: body.robots !== false, pages: body.pages, fields: selMap,
    });
  } catch (err) {
    return { error: err.message };
  }
  if (!exec || !exec.ok) return { error: (exec && exec.error) || '按生成的选择器抓取失败' };

  const cols = exec.fields || Object.keys(selMap);
  const all = (exec.items || []).map((it) => cols.map((c) => harvestClipped(it && it.fields && it.fields[c], MAX_CELL_CHARS)));
  const rows = all.filter((r) => !isJunkRow(r));       /* 丢掉导航/广告位/登录入口 */
  const fill = cols.map((c, i) => (rows.length ? rows.filter((r) => r[i]).length / rows.length : 0));
  const dropped = all.length - rows.length;
  return {
    exec, cols, rows, fill, rowSel, selMap, dropped,
    dropRatio: all.length ? dropped / all.length : 0,
  };
}

/* 要不要让模型重来一版：整列为空、或丢掉的垃圾行占比过高 */
function needSelectorRetry(a) {
  if (a.error) return false;
  if (!a.rows.length) return true;
  if (a.cols.some((c, i) => a.fill[i] === 0)) return true;
  return a.dropRatio >= 0.4;
}

/* 评分：先看「最差列的非空率」，再看有效行数 —— 用来比较两次尝试谁更好 */
function scoreOf(a) {
  if (a.error) return -1;
  const worst = Math.min.apply(null, a.fill.concat([1]));
  return worst * 1000 + Math.min(a.rows.length, 500);
}

/* 这一版选择器到底哪里不行 */
function selectorProblems(a) {
  const out = [];
  if (!a.rows.length) out.push('丢掉垃圾行后一行有效内容都没剩下');
  const empty = a.cols.filter((c, i) => a.fill[i] === 0);
  if (empty.length) out.push(empty.map((c) => '「' + c + '」整列都是空的').join('、'));
  if (a.dropRatio >= 0.4) {
    out.push('抓到的 ' + (a.rows.length + a.dropped) + ' 行里有 ' + a.dropped + ' 行是导航/广告位那类垃圾行（占 '
      + Math.round(a.dropRatio * 100) + '%）');
  }
  return out.length ? out : ['整体质量不理想'];
}

/* 把问题写成给模型的反馈 */
function selectorFeedback(notes, smp, want, fixedKeys, attempt, problems) {
  const stat = attempt.cols.map((c, i) => {
    const filled = attempt.rows.filter((r) => r[i]).length;
    return '- 「' + c + '」用的选择器 ' + JSON.stringify(attempt.selMap[c] || '(未给)')
      + '：' + attempt.rows.length + ' 行里只有 ' + filled + ' 行取到值';
  }).join('\n');
  return (notes ? notes + '\n' : '')
    + '我按你上一版选择器抓了一遍，结果不理想：\n'
    + '- 记录选择器 ' + JSON.stringify(attempt.rowSel || '(空)') + ' 匹配到 ' + (attempt.exec.total || 0) + ' 条，'
    + '其中 ' + attempt.rows.length + ' 行有内容'
    + (attempt.dropped ? '（另有 ' + attempt.dropped + ' 行是导航/广告位，已丢弃）' : '') + '\n'
    + stat + '\n'
    + '问题：' + problems.join('；') + '\n'
    + '请修正后重新输出选择器。要点：\n'
    + '- 记录选择器要限定在内容区域，别匹配到导航 / 页脚 / 广告位 / 登录入口（多用带父级限定的写法）\n'
    + '- 字段选择器必须能在记录元素内部真正匹配到内容（可以用「父级 + 子元素」的组合）\n'
    + (fixedKeys.length ? '- 这些列不用你管：' + fixedKeys.join('、') + '\n' : '')
    + '\nHTML 样本：\n' + harvestClipped(smp.sample, SAMPLE_FOR_AI_CHARS);
}

/* ---------- C：数据后处理（确定性清洗 + 可选 AI 深处理） ---------- */
/* 全角 ASCII（ＦＦ０１-ＦＦ５Ｅ）与表意空格 -> 半角；中文标点保留 */
function toHalfWidth(s) {
  return String(s == null ? '' : s).replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '');
}
const cleanCell = (s) => toHalfWidth(s).replace(/\s+/g, ' ').trim().slice(0, MAX_CELL_CHARS);

const AI_CLEAN_SYSTEM = [
  '你在做采集结果的数据清洗。只输出 JSON，不要联网。',
  '输出结构：{"drop":[行号],"tags":{"行号":["标签"]},"issues":[{"row":行号,"col":"字段名","reason":"问题"}]}',
  '行号从 1 开始（对应输入数组顺序）。规则：',
  '- drop：与其它行指同一条数据、只是写法不同的重复行',
  '- tags：给行打 1-2 个简短中文标签（≤6 字），例如「招聘」「二手房」「公告」',
  '- issues：明显有问题的单元格（该有却为空、单位/量纲不对、与其它行差一个数量级、疑似串列）',
  '- 没问题的行不要出现在 drop/tags/issues 里；宁少勿多',
  '- 只输出 JSON',
].join('\n');

function cleanDeterministic(columns, rows) {
  const notes = [];
  const norm = rows.map((r) => columns.map((_, i) => cleanCell(r[i])));
  /* 精确去重（归一化后整行相同） */
  const seen = new Map();
  const keep = [], dropped = [];
  norm.forEach((r, i) => {
    const key = r.join('\u0001');
    if (r.every((c) => !c)) { dropped.push({ row: i, reason: '整行为空' }); return; }
    if (seen.has(key)) { dropped.push({ row: i, reason: '与第 ' + (seen.get(key) + 1) + ' 行完全相同' }); return; }
    seen.set(key, i);
    keep.push(i);
  });
  if (dropped.length) notes.push('确定性去重：删除 ' + dropped.length + ' 行（完全重复或空行）');

  /* 列级检查：空值率、数值列离群 */
  const colStat = columns.map((col, ci) => {
    const empties = keep.filter((i) => !norm[i][ci]).length;
    const nums = keep.map((i) => {
      const d = digitsOf(norm[i][ci]);
      return d ? Number(d) : null;
    }).filter((n) => n != null && isFinite(n));
    const stat = { field: col, empty: empties, filled: keep.length - empties };
    if (keep.length && empties / keep.length >= 0.5) {
      stat.warn = '超过半数行为空，可能选择器抓错了';
      notes.push('列「' + col + '」有 ' + empties + '/' + keep.length + ' 行为空，建议检查选择器');
    }
    if (nums.length >= 3) {
      const sorted = nums.slice().sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)];
      if (mid > 0) {
        const outliers = keep.filter((i) => {
          const d = digitsOf(norm[i][ci]);
          const n = d ? Number(d) : null;
          return n != null && (n >= mid * 10 || n <= mid / 10);
        });
        if (outliers.length) {
          stat.outliers = outliers.map((i) => ({ row: i, value: norm[i][ci] }));
          notes.push('列「' + col + '」有 ' + outliers.length + ' 行与中位数(' + mid + ') 差一个数量级，可能是解析错位');
        }
      }
    }
    return stat;
  });

  return { rows: keep.map((i) => norm[i]), keepIdx: keep, dropped, notes, columns: colStat };
}

async function handleClean(req, res) {
  let body;
  try { body = await readJsonBody(req, 131072); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  const columns = (Array.isArray(body.columns) ? body.columns : []).map((c) => harvestClipped(c, 30)).filter(Boolean).slice(0, SCRAPE_MAX_FIELDS);
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 500)
    .map((r) => (Array.isArray(r) ? r.slice(0, columns.length) : []));
  if (!columns.length || !rows.length) return sendJson(res, 400, { error: '缺少 columns / rows' });

  const det = cleanDeterministic(columns, rows);
  const result = {
    ok: true, url: harvestClipped(body.url, 500), columns,
    rows: det.rows, source_rows: rows.length,
    dropped: det.dropped, notes: det.notes, column_stat: det.columns,
    tags: {}, issues: [],
  };
  if (!body.deep || !API_KEY) return sendJson(res, 200, result);

  /* AI 深处理：语义去重 / 打标签 / 异常 */
  const payload = det.rows.slice(0, 60).map((r, i) => {
    const o = { _row: i + 1 };
    columns.forEach((c, ci) => { o[c] = r[ci]; });
    return o;
  });
  try {
    const r = await aiJson(AI_CLEAN_SYSTEM, '表头：' + columns.join('、') + '\n数据：\n' + JSON.stringify(payload), 1200, 'clean');
    const out = r.raw || {};
    const validRow = (n) => Number.isInteger(n) && n >= 1 && n <= det.rows.length;
    const drop = (Array.isArray(out.drop) ? out.drop : []).filter(validRow);
    const dropSet = new Set(drop);
    if (drop.length) {
      drop.forEach((n) => result.dropped.push({ row: det.keepIdx[n - 1], reason: 'AI 判定为重复行' }));
      result.rows = det.rows.filter((_, i) => !dropSet.has(i + 1));
      result.notes.push('AI 语义去重：再删 ' + drop.length + ' 行');
    }
    /* 模型给的行号是「去重前」的，这里换算成返回数组里的下标，避免前端标错行 */
    const kept = det.rows.map((_, i) => i + 1).filter((n) => !dropSet.has(n));
    const posOf = new Map(kept.map((n, idx) => [n, idx]));
    if (out.tags && typeof out.tags === 'object') {
      for (const [k, v] of Object.entries(out.tags)) {
        const n = Number(k);
        if (!validRow(n) || !posOf.has(n)) continue;
        const list = (Array.isArray(v) ? v : [v]).map((x) => harvestClipped(x, 12)).filter(Boolean).slice(0, 2);
        if (list.length) result.tags[posOf.get(n)] = list;
      }
    }
    if (Array.isArray(out.issues)) {
      result.issues = out.issues.map((it) => {
        const n = Number(it && it.row);
        return {
          row: posOf.has(n) ? posOf.get(n) : -1,     /* -1 = 该行已被去重删掉 */
          col: harvestClipped(it && it.col, 30),
          reason: harvestClipped(it && it.reason, 100),
        };
      }).filter((it) => it.reason).slice(0, 40);
    }
    result.ai = { model: r.model, tokens: r.usage.total_tokens || 0, ai_ms: r.elapsed_ms, used: true };
  } catch (err) {
    result.ai = { used: false, reason: err.message };
    result.notes.push('AI 深处理未生效（' + err.message + '），已只做确定性清洗');
  }
  return sendJson(res, 200, result);
}

/* ---------- D：失败自愈（读错误 + 页面结构，给出重试方案） ---------- */
const AI_HEAL_SYSTEM = [
  '你是网页采集器的排障助手。只输出 JSON，不要联网、不要自己抓取。',
  '本次抓取失败了，请判断原因并给出一个重试方案。',
  '输出结构：',
  '{"action":"retry","args":{"selector":"","mode":"fast","pages":1,"fields":{}},"reason":"为什么这么改","lesson":"一句话经验"}',
  '或 {"action":"giveup","reason":"放弃原因"}',
  '可用的手段：',
  '- mode：fast(静态直取) / stealth(无头浏览器，可绕反爬、能跑 JS) / dynamic(无头浏览器，适合滚动加载)',
  '- selector / fields：改选择器或字段映射',
  '- pages：不要把页数改得比原来大',
  '如果失败像是「需要登录」「需要验证码」「站点已下线」，直接 giveup 并说明。只输出 JSON。',
].join('\n');

async function handleHeal(req, res) {
  let body;
  try { body = await readJsonBody(req, 16384); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  if (!API_KEY) return sendJson(res, 200, { ok: false, reason: '网关凭证未配置' });

  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: '缺少合法 url' });
  const host = siteHostOf(url);
  const cur = {
    url, selector: harvestClipped(body.selector, 120), mode: harnessMode(body.mode) || 'fast',
    pages: clampPages(body.pages), fields: sanitizeFields(body.fields),
  };
  const err = harvestClipped(body.error, 300);
  let sample = '';
  if (body.withSample !== false) {
    try {
      const smp = await runScrape({ url, mode: cur.mode, sample: true, limit: 1, adaptive: true, robots: body.robots !== false });
      if (smp && smp.ok) sample = harvestClipped(smp.sample, 9000);
      else if (smp && smp.error) return sendJson(res, 200, { ok: false, reason: '连取样都失败：' + smp.error });
    } catch (_) { /* 取样失败就算了，靠错误信息判断 */ }
  }

  let r;
  try {
    r = await aiJson(AI_HEAL_SYSTEM,
      siteNotePrompt(host) + '\n现有参数：' + JSON.stringify(cur) + '\n失败信息：' + (err || '(无)')
      + '\n\n页面样本：\n' + (sample || '(取样失败，没有样本)'), 700, 'heal');
  } catch (e2) {
    return sendJson(res, 200, { ok: false, reason: e2.message });
  }
  const out = r.raw || {};
  const action = String(out.action || '').toLowerCase();
  const reason = harvestClipped(out.reason, 200);
  if (action !== 'retry') {
    siteNoteRecord(host, { fail: err || '抓取失败' });
    return sendJson(res, 200, { ok: true, action: 'giveup', reason, tokens: r.usage.total_tokens || 0 });
  }
  const a = (out.args && typeof out.args === 'object') ? out.args : {};
  const plan = {
    url,
    selector: harvestClipped(a.selector, 120),
    mode: harnessMode(a.mode) || cur.mode,
    pages: Math.min(clampPages(a.pages), cur.pages || 1),
    fields: sanitizeFields(a.fields),
  };
  const lesson = harvestClipped(out.lesson, 200);
  if (lesson) siteNoteRecord(host, { lesson, mode: plan.mode, selector: plan.selector });
  /* 自我进化：把这条规避经验同时写进共享的 MEMORY.md，让别的员工也学会 */
  const memory = lesson
    ? memoryLearn(host, lesson + (plan.selector ? '（可用选择器 ' + plan.selector + '）' : ''))
    : { written: false, reason: '本次没有可沉淀的经验' };
  return sendJson(res, 200, {
    ok: true, action: 'retry', plan, reason,
    changed: { mode: plan.mode !== cur.mode, selector: plan.selector !== cur.selector, fields: JSON.stringify(plan.fields) !== JSON.stringify(cur.fields) },
    lesson, memory, tokens: r.usage.total_tokens || 0, ai_ms: r.elapsed_ms,
  });
}

/* 站点经验库查询（页面展示 / 排查用） */
function siteNotesPayload(limit) {
  const all = siteNotesLoad();
  const items = Object.entries(all).map(([host, v]) => Object.assign({ host }, v))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return {
    items: items.slice(0, limit), total: items.length, file: SITE_NOTES_FILE,
    memory: {
      file: MEMORY_FILE || '(已关闭)',
      enabled: !!MEMORY_FILE,
      entries: memoryEntries().map((b) => harvestClipped(b, 300)),
      max_entries: MEMORY_MAX_ENTRIES,
    },
  };
}

/* ---------- 拾贝 · 网页抓取（调用 scripts/scrape.py，SSRF 防护在脚本内） ---------- */
const PY = process.env.SCRAPE_PY || 'python3';
const SCRAPE_TIMEOUT_MS = 70000;
let _scrapeRunning = 0;
const SCRAPE_MAX_CONCURRENCY = 2;
const _scrapeLast = new Map();      /* ip -> 上次抓取时间戳 */
const SCRAPE_MIN_INTERVAL_MS = 1500;

function runScrape(payload) {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, 'scripts', 'scrape.py');
    const child = spawn(PY, [script], { stdio: ['pipe', 'pipe', 'pipe'], timeout: SCRAPE_TIMEOUT_MS });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => reject(new Error('无法启动抓取执行器: ' + e.message)));
    child.on('close', (code, signal) => {
      const lines = out.trim().split('\n').filter(Boolean);
      const line = lines[lines.length - 1];
      if (!line) {
        return reject(new Error(signal === 'SIGTERM'
          ? '抓取超时（>' + (SCRAPE_TIMEOUT_MS / 1000) + 's），已终止'
          : '抓取执行器无输出' + (err ? ': ' + err.trim().split('\n').pop() : '')));
      }
      try { resolve(JSON.parse(line)); } catch (_) { reject(new Error('返回无法解析: ' + line.slice(0, 160))); }
    });
    try { child.stdin.write(JSON.stringify(payload)); child.stdin.end(); }
    catch (e) { reject(new Error('写入请求失败: ' + e.message)); }
  });
}

/* ---------- 拾贝 · 抓取历史（落盘持久化，供「即时交互」回溯真实记录） ----------
 * 为什么放服务端：页面刷新/换浏览器后仍能看到历史；抓取本身在服务端执行，
 * 记录写在同一条链路上，不会因为用户提前关页面而丢。
 * 存储：AO_DATA_DIR（默认 /var/lib/agent-office，不在静态根目录内，不会被 HTTP 暴露）
 * 容量：最多 HARVESTER_MAX 条，超出丢弃最旧的；每条只留前 HARVESTER_KEEP_ITEMS 条内容摘要。 */
const HARVESTER_FILE = path.join(HARVESTER_DIR, 'harvester-history.json');
const HARVESTER_MAX = 200;
const HARVESTER_KEEP_ITEMS = 8;
const HARVESTER_TEXT_CHARS = 320;      /* 与页面展示的截断长度保持一致 */

let _harvestCache = null;
const harvestClipped = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function harvesterLoad() {
  if (_harvestCache) return _harvestCache;
  const d = readJsonSafe(HARVESTER_FILE);
  _harvestCache = { items: (d && Array.isArray(d.items)) ? d.items : [] };
  return _harvestCache;
}
function harvesterSave() {
  try {
    fs.mkdirSync(HARVESTER_DIR, { recursive: true });
    const tmp = HARVESTER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_harvestCache), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, HARVESTER_FILE);          /* 原子替换，避免半截文件 */
  } catch (err) {
    console.warn('[hwb-bridge] 抓取历史写入失败 ' + HARVESTER_FILE + '：' + err.message);
  }
}
function harvesterEntry(payload, result) {
  const ok = !!result.ok;
  const cols = Array.isArray(result.fields) ? result.fields.slice(0, SCRAPE_MAX_FIELDS) : [];
  const items = Array.isArray(result.items) ? result.items.slice(0, HARVESTER_KEEP_ITEMS) : [];
  return {
    ts: Math.floor(Date.now() / 1000),
    url: payload.url,
    host: harvestClipped(result.host, 120),
    selector: harvestClipped(payload.selector, 120),
    mode: result.mode || payload.mode || 'fast',
    ok,
    error: ok ? '' : harvestClipped(result.error || '抓取失败', 300),
    status: result.status || null,
    title: harvestClipped(result.title, 200),
    note: harvestClipped(result.note, 300),
    pages: result.pages_fetched || 1,
    blocked: result.blocked || '',
    field_names: cols,
    count: result.count || 0,
    total: result.total || 0,
    elapsed_ms: result.elapsed_ms || 0,
    items: items.map((it) => {
      const row = { text: harvestClipped(it && it.text, HARVESTER_TEXT_CHARS) };
      if (cols.length && it && it.fields && typeof it.fields === 'object') {
        row.values = cols.map((c) => harvestClipped(it.fields[c], 160));   /* 表格存档按列顺序 */
      }
      return row;
    }),
  };
}
function harvesterRecord(payload, result) {
  const h = harvesterLoad();
  h.items.push(harvesterEntry(payload, result));
  if (h.items.length > HARVESTER_MAX) h.items = h.items.slice(-HARVESTER_MAX);
  harvesterSave();
}
function harvesterPayload(limit) {
  const h = harvesterLoad();
  const items = h.items.slice(-limit);
  return { items, total: h.items.length, file: HARVESTER_FILE, generated_at: new Date().toISOString() };
}

/* 翻页与字段映射的入参收口（脏数据不进执行器） */
const SCRAPE_MAX_PAGES = 10;
const SCRAPE_MAX_FIELDS = 12;
function clampPages(v) {
  const n = Math.floor(Number(v) || 1);
  return Math.min(SCRAPE_MAX_PAGES, Math.max(1, n));
}
function sanitizeFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k || '').trim().slice(0, 40);
    const expr = String(v == null ? '' : v).trim().slice(0, 200);
    if (!name || !expr) continue;
    out[name] = expr;
    if (Object.keys(out).length >= SCRAPE_MAX_FIELDS) break;
  }
  return out;
}

async function handleScrape(req, res, ip) {
  const now = Date.now();
  const last = _scrapeLast.get(ip) || 0;
  if (now - last < SCRAPE_MIN_INTERVAL_MS) return sendJson(res, 429, { error: '抓取太频繁，请稍后再试' });
  if (_scrapeRunning >= SCRAPE_MAX_CONCURRENCY) return sendJson(res, 429, { error: '已有抓取任务在执行，请稍候' });

  let body;
  try { body = await readJsonBody(req, 8192); } catch (err) { return sendJson(res, 400, { error: err.message }); }

  const url = String(body.url || '').trim();
  if (!url) return sendJson(res, 400, { error: '缺少 url' });

  _scrapeLast.set(ip, now);
  _scrapeRunning += 1;
  const payload = {
    url,
    selector: String(body.selector || '').trim(),
    mode: String(body.mode || 'fast'),
    limit: body.limit,
    adaptive: body.adaptive !== false,
    robots: body.robots !== false,
    timeout: body.timeout,
    pages: clampPages(body.pages),
    fields: sanitizeFields(body.fields),
  };
  console.log('[hwb-bridge] 拾贝抓取 ip=' + ip + ' mode=' + payload.mode + ' url=' + url.slice(0, 120));
  try {
    const result = await runScrape(payload);
    harvesterRecord(payload, result || {});     /* 成功与被拒（ok:false）都留痕 */
    /* 自我进化：把跑通的「引擎+选择器+字段」记进站点经验，下次解析/自愈直接复用 */
    const host = siteHostOf(url);
    const fieldMap = (payload.fields && Object.keys(payload.fields).length) ? payload.fields : null;
    const blocked = !!(result && result.blocked);
    if (result && result.ok && !blocked) {
      siteNoteRecord(host, { ok: 1, mode: payload.mode, selector: payload.selector, fields: payload.fields });
      /* 只有真的抓到内容才算「跑通」：0 条说明这套口径没成，记进去会误导以后的解析 */
      if ((payload.selector || fieldMap) && (result.count || 0) > 0) {
        memoryLearn(host, '可用 ' + (payload.selector || '(正文)') + ' 抓取'
          + (payload.pages > 1 ? '（翻 ' + payload.pages + ' 页）' : '')
          + (fieldMap ? '，字段 ' + JSON.stringify(fieldMap) : '')
          + (result.title ? '（页面标题 ' + harvestClipped(result.title, 30) + '）' : ''));
      }
    } else if (blocked) {
      /* 登录墙/验证墙：记成失败，并说明原因，别让后续解析再往这个坑里跳 */
      siteNoteRecord(host, { fail: result.blocked_reason || '被登录/验证墙挡住' });
    } else {
      siteNoteRecord(host, { fail: (result && result.error) || '抓取失败' });
    }
    sendJson(res, 200, result);
  } catch (err) {
    console.warn('[hwb-bridge] 抓取失败 ip=' + ip + ' url=' + url.slice(0, 120) + ' -> ' + err.message);
    harvesterRecord(payload, { ok: false, error: err.message });
    siteNoteRecord(siteHostOf(url), { fail: err.message });
    sendJson(res, 500, { error: err.message });
  } finally {
    _scrapeRunning -= 1;
  }
}

/* 飞书机器人配置：面板是唯一真源，助手机上的脚本只读这一份。
   落盘而不是走环境变量 —— 脚本每次被拉起都是新进程，读文件比让人改 .env
   重启要靠谱；0600，因为里面有 webhook 地址和签名密钥（等同写入凭据）。 */
async function handleFeishuConfig(req, res) {
  let body;
  try { body = await readJsonBody(req, 8192); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  const url = String(body?.webhookUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'webhook 地址要以 http(s):// 开头' });

  const payload = {
    enabled: body?.enabled !== false,
    webhook_url: url,
    secret: String(body?.secret || ''),
    /* 应用机器人凭据目前面板自己用（审批卡回调只有应用机器人收得到），
       但既然配置源头在面板，就一并落下来 —— 免得以后某个脚本要用时
       发现这里少了一半字段，还得猜是哪一边没同步 */
    app_id: String(body?.appId || '').trim(),
    app_secret: String(body?.appSecret || ''),
    chat_id: String(body?.chatId || '').trim(),
    notify_ban: body?.notifyBan !== false,
    notify_ops: body?.notifyOps !== false,
    updated_at: new Date().toISOString(),
  };
  const dir = path.join(HERMES_HOME, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'feishu_bot.json');
  const tmp = file + '.tmp';
  /* 先写临时文件再 rename：脚本随时可能被 cron 拉起，读到半个 JSON 会当成
     "没配过"而静默不发通知 —— 一次 rename 就把这个窗口消掉 */
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return sendJson(res, 200, { path: file, savedAt: payload.updated_at, enabled: payload.enabled });
}

async function handleLocal(req, res) {
  const route = req.url.split('?')[0];
  const send = (obj, code = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    if (req.method === 'POST' && route === '/local/scrape') return handleScrape(req, res, clientIp(req));
    if (req.method === 'POST' && route === '/local/harvester/plan') return handlePlan(req, res);
    if (req.method === 'POST' && route === '/local/harvester/ai-extract') return handleAiExtract(req, res);
    if (req.method === 'POST' && route === '/local/harvester/clean') return handleClean(req, res);
    if (req.method === 'POST' && route === '/local/harvester/heal') return handleHeal(req, res);
    /* 边界守望：授权封禁（必须已登录 + 有效授权码；校验在 Python 侧） */
    if (req.method === 'POST' && route === '/local/security/approve') return handleSecurityDecision(req, res, true);
    if (req.method === 'POST' && route === '/local/security/reject') return handleSecurityDecision(req, res, false);
    /* 自动封禁总开关：写 attacks.db 的 settings，由 frp_guard.py 落库并审计 */
    if (req.method === 'POST' && route === '/local/security/auto-ban') return handleSecurityAutoBan(req, res);
    /* 手动解封：误封（尤其自动封禁误伤）之后的自救入口，删不掉就不会改状态 */
    if (req.method === 'POST' && route === '/local/security/unblock') return handleSecurityUnblock(req, res);
    /* 白名单：读 / 增删。写操作只认 IP 或 CIDR，挡住 0.0.0.0/0 这种东西 */
    if (route === '/local/security/allow') {
      if (req.method === 'GET' || req.method === 'POST') return handleSecurityAllow(req, res);
      return send({ error: 'Method Not Allowed' }, 405);
    }
    /* 设置页保存飞书机器人配置时把这份推过来（见 services/feishu-bot.js） */
    if (req.method === 'POST' && route === '/local/feishu-config') return handleFeishuConfig(req, res);
    if (route === '/local/harvester/sites') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      return send(siteNotesPayload(Math.min(200, Math.max(1, Number(q.get('limit')) || 50))));
    }
    if (req.method !== 'GET') return send({ error: 'Method Not Allowed' }, 405);
    if (route === '/local/usage') return send(await usagePayload());
    if (route === '/local/board') return send(await boardPayload());
    if (route === '/local/mcp') return send(await mcpPayload());
    if (route === '/local/watch') return send(await watchPayload());
    if (route === '/local/security') return send(await securityPayload());
    /* 单 IP 攻击画像：四层证据（连接 / 流量 / 用户名 / 封禁史）合一。
       走 python 的 profile --json，避免在 Node 侧重复维护服务名映射。 */
    if (route === '/local/security/profile') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const ip = String(q.get('ip') || '').trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return send({ error: 'IP 格式不正确' }, 400);
      const r2 = await runFrpGuard(['profile', '--ip', ip, '--json'], 90000);
      let data = null;
      try { data = r2.ok && r2.output ? JSON.parse(r2.output) : null; } catch (e) { data = null; }
      if (!data) return send({ error: r2.error || '画像查询失败', ip }, 502);
      return send(data);
    }
    if (route === '/local/config') return send(await configPayload());
    if (route === '/local/harvester/history') {
      const q = new URLSearchParams((req.url.split('?')[1] || ''));
      const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
      return send(harvesterPayload(limit));
    }
    if (route === '/local/skills') return send(await cached('skills', skillsPayload));
    if (route === '/local/memories') return send(await cached('memories', memoriesPayload));
    if (route === '/local/evolution') return send(await cached('evolution', evolutionPayload));
    return send({ error: 'Not Found', route }, 404);
  } catch (err) {
    return send({ error: 'local data failed: ' + err.message }, 500);
  }
}

/* ============================================================
 * 调度层：stdin 一个 JSON → 数据层 → stdout 一个 JSON
 *   stdout 只允许出现这一行 JSON，其余日志一律走 stderr
 * ============================================================ */
console.log = (...args) => console.error(...args);

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

async function invoke(input) {
  const p = String(input.path || '');
  if (p === '/__ping') {
    return {
      ok: true,
      node: process.version,
      host: os.hostname(),
      hermes_home: HERMES_HOME,
      install_dir: INSTALL_DIR,
      data_dir: HARVESTER_DIR,
      gateway: GATEWAY.origin,
      key_configured: !!API_KEY,
      key_source: CRED.from,
      scrape_script: fs.existsSync(path.join(ROOT, 'scripts', 'scrape.py')),
      pid: process.pid,
    };
  }
  if (p === '/public/agents') return officeStatusPayload();
  if (!p.startsWith('/local/')) throw new Error('不支持的路径：' + p);

  const query = input.query ? '?' + new URLSearchParams(input.query).toString() : '';
  const method = input.method || (input.body ? 'POST' : 'GET');
  const req = Readable.from(input.body ? [Buffer.from(JSON.stringify(input.body))] : []);
  req.method = method;
  req.url = p + query;
  req.headers = Object.assign({ 'content-type': 'application/json' }, input.headers || {});
  req.socket = { remoteAddress: '127.0.0.1' };

  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b == null ? '' : String(b); },
  };

  await handleLocal(req, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = null; }
  return { __status: res.statusCode, __data: parsed === null ? res.body : parsed };
}

/* 后台探针刷新模式：由 scheduleProbeRefresh() 以 detached 子进程拉起，
   同一份脚本、同一台机器，只跑 infra_watch.py 并写缓存，不读 stdin。 */
if (process.argv[2] === '--refresh-watch') {
  refreshWatchProbe()
    .then(() => {
      try { fs.unlinkSync(PROBE_LOCK); } catch (_) { /* 没有就算了 */ }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[hwb-bridge] 探针后台刷新失败:', err.message || err);
      try { fs.unlinkSync(PROBE_LOCK); } catch (_) { /* 忽略 */ }
      process.exit(1);
    });
} else {
  (async () => {
    let out;
    try {
      const raw = await readStdin();
      const input = raw.trim() ? JSON.parse(raw) : {};
      const data = await invoke(input);
      if (data && data.__status !== undefined) {
        out = { ok: data.__status < 400, status: data.__status, data: data.__data };
      } else {
        out = { ok: true, status: 200, data };
      }
    } catch (err) {
      out = { ok: false, status: 500, error: String((err && err.message) || err) };
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  })();
}
