import http from 'node:http';
import https from 'node:https';
import { hermesConfig, hasHermesCredentials } from './hermes-config.js';
import { bridgeCall } from './hermes-local.js';

/* ────────────────────────────────────────────────────────────────────────
 * Hermes 网关客户端（直连 8642，Bearer）
 * ────────────────────────────────────────────────────────────────────────
 * 合并 agent_office 之后这里不再有登录、Cookie 会话、锁号冷却：
 *
 *   GET  /api/sessions?limit=&offset=        会话列表（用量、模型、来源都在里面）
 *   GET  /api/sessions/:id/messages          会话明细
 *   POST /api/sessions/:id/chat/stream       对话（SSE）
 *   GET  /api/jobs                           定时任务
 *   GET  /v1/models  /v1/toolsets            模型 / 工具集
 *
 * 用量、待办、配置、技能、记忆、进化、MCP、值守、边界守望走 SSH 数据桥
 * （services/hermes-local.js），不再经过任何中间网页服务。
 *
 * 凭证只从环境变量读（HERMES_API_KEY），不落库、不回显、不进备份。
 * ──────────────────────────────────────────────────────────────────────── */

export { hermesConfig, hasHermesCredentials };

/* ── 极简 HTTP 客户端 ─────────────────────────────────────────────── */

/**
 * 发出请求但不读正文，把响应流原样交出去。
 * 对话是 SSE，缓冲式读取会把流式体验抹掉；错误分支要拿状态码，所以这里只发不收。
 */
function openRaw(apiPath, { method = 'GET', body = null, timeout = 12000, accept = 'application/json', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const cfg = hermesConfig();
    let target;
    try {
      target = new URL(`${cfg.baseUrl}${apiPath}`);
    } catch {
      reject(new Error(`Hermes 地址不合法：${cfg.baseUrl}`));
      return;
    }

    const isTls = target.protocol === 'https:';
    const mod = isTls ? https : http;
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));

    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: {
          accept,
          /* 网关把「带 Origin 的请求」当浏览器跨域并 403，服务端调用不带 Origin */
          'accept-encoding': 'identity',
          'user-agent': 'personal-workbench',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
        ...(isTls && !cfg.verifyTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.statusCode = res.statusCode || 0;
        resolve(res);
      },
    );

    if (timeout > 0) {
      req.setTimeout(timeout, () => req.destroy(new Error(`Hermes 请求超时（${timeout}ms）`)));
    }
    req.on('error', (err) => reject(new Error(friendlyError(err, cfg))));
    if (payload) req.write(payload);
    req.end();
  });
}

function readText(stream, { maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    stream.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        stream.destroy(new Error(`Hermes 响应超过 ${Math.round(maxBytes / 1024)}KB`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

function friendlyError(err, cfg) {
  const code = err && err.code;
  const where = cfg ? cfg.baseUrl : 'Hermes';
  if (code === 'ECONNREFUSED') return `连不上 Hermes 网关（${where}）：端口未监听或被防火墙拦截`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `Hermes 网关不可达（${where}）`;
  if (code === 'ETIMEDOUT' || /超时/.test(String(err && err.message))) return `Hermes 网关响应超时（${where}）`;
  if (/certificate|self-signed/i.test(String(err && err.message))) return `Hermes 证书校验失败（${where}）`;
  return String((err && err.message) || err);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeFailure(status, text, cfg) {
  if (status === 401 || status === 403) return 'Hermes 拒绝了请求：API Key 未配置或不正确（.env 里的 HERMES_API_KEY）';
  if (status === 404) return `Hermes 没有这个接口（HTTP 404）：${cfg.baseUrl}`;
  const j = parseJson(text);
  const detail = j?.error?.message || j?.error || j?.detail;
  if (detail) return String(detail);
  return `Hermes 返回 HTTP ${status}`;
}

/**
 * 与服务端其它 HTTP 调用同款：返回 { status, text }，不抛 HTTP 错误
 * （401/500 由调用方决定怎么处理）。网络层错误仍然抛。
 */
export async function authedRequest(apiPath, { method = 'GET', body = null, timeout = 12000, accept } = {}) {
  const cfg = hermesConfig();
  const res = await openRaw(apiPath, { method, body, timeout, accept });
  const text = await readText(res);
  return { status: res.statusCode || 0, text, headers: res.headers };
}

/** 同 authedRequest，但把响应解析成 JSON 并在失败时抛可读错误 */
export async function hermesApi(apiPath, opts = {}) {
  const cfg = hermesConfig();
  const res = await authedRequest(apiPath, { timeout: cfg.timeout, ...opts });
  if (res.status >= 400) throw new Error(describeFailure(res.status, res.text, cfg));
  const data = parseJson(res.text);
  if (data === null) throw new Error('Hermes 返回的不是合法 JSON');
  return data;
}

/**
 * 流式接口（SSE）。返回未消费的 IncomingMessage：
 *   · 200 时由调用方按帧解析（见 office.js 的 chatStream）；
 *   · 非 200 时上游给的是普通 JSON，调用方读完再抛错。
 */
export async function openHermesStream(apiPath, { method = 'POST', body = null, timeout = 0, accept = 'text/event-stream' } = {}) {
  return openRaw(apiPath, { method, body, timeout, accept });
}

/* ── 工位 / 员工在线状态 ───────────────────────────────────────────── */

/**
 * 数据桥在 Hermes 本机做真实探活：网关健康、MCP stdio 握手、
 * scrapling 可导入、值守任务存在，再合并成 6 工位 / 4 在编 / 在线数。
 */
export async function hermesSeats({ timeout = 15000 } = {}) {
  const cfg = hermesConfig();
  let data;
  try {
    data = await bridgeCall('/public/agents', { timeout });
  } catch (err) {
    throw new Error(err.message);
  }
  if (!data) throw new Error('数据桥没有返回工位状态');

  return {
    baseUrl: cfg.baseUrl,
    gatewayVersion: data.gateway_version || null,
    seats: data.seats ?? null,
    staffed: data.staffed ?? null,
    vacant: data.vacant ?? null,
    online: data.online ?? null,
    items: Array.isArray(data.items)
      ? data.items.map((a) => ({ id: a.id, name: a.name, en: a.en || '', online: Boolean(a.online) }))
      : [],
    checkedAt: data.checked_at || null,
  };
}
