import http from 'node:http';
import https from 'node:https';

/* ────────────────────────────────────────────────────────────────────────
 * Hermes Agent Office 对接
 * ────────────────────────────────────────────────────────────────────────
 * 局域网里的「智能工位」网关（nginx 反代 + 内部 agent-office 服务）。
 * 实测它只开了一个免登录口子，其余全部要 Cookie 会话：
 *
 *   GET  /public/agents   免登录。工位总数 / 在编 / 在线 + 每个 agent 的在线标记
 *   POST /auth/login      {user, password, remember} → 200 {ok, redirect} + Set-Cookie
 *   GET  /auth/session    → {ok, user}
 *   其余所有路径           未登录时统一返回 {"error":"未登录","login":"/login.html"}
 *
 * 所以这块的做法是：公开状态直接读；需要登录的接口拿一个进程内的 Cookie 会话去调，
 * 会话失效（401）自动重登一次。
 *
 * 凭证只从环境变量读（HERMES_USER / HERMES_PASSWORD），不落库、不进备份、不回显。
 *
 * ⚠️ 登录失败是会计数的：Hermes 会返回「用户名或密码错误（剩余尝试 N 次）」，
 * 试满就锁账号。所以这里失败后进入冷却期，不会拿着错口令反复撞。
 * ──────────────────────────────────────────────────────────────────────── */

/* 占位默认值：仓库公开，这里不能写真实内网地址。
   实际地址请用环境变量 HERMES_BASE_URL 配置（Hermes 没有设置页，只能走环境变量）。 */
const DEFAULT_BASE = 'http://hermes.home.local';

export function hermesConfig() {
  return {
    baseUrl: String(process.env.HERMES_BASE_URL || DEFAULT_BASE)
      .trim()
      .replace(/\/+$/, ''),
    user: String(process.env.HERMES_USER || '').trim(),
    password: String(process.env.HERMES_PASSWORD || ''),
    verifyTls: process.env.HERMES_VERIFY_TLS === 'true',
  };
}

/** 有地址就算配置过：工位状态是公开接口，不需要口令 */
export function isHermesConfigured() {
  return Boolean(hermesConfig().baseUrl);
}

/** 能调「登录后」的接口才需要口令 */
export function hasHermesCredentials() {
  const c = hermesConfig();
  return Boolean(c.user && c.password);
}

/* ── 极简 HTTP 客户端（与 ha.js 同款，但要把状态码和 Set-Cookie 交回调用方）── */
function request(cfg, apiPath, { method = 'GET', body = null, cookie = '', timeout = 6000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(`${cfg.baseUrl}${apiPath}`);
    } catch {
      reject(new Error(`Hermes 地址不合法：${cfg.baseUrl}`));
      return;
    }
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (cookie) headers.Cookie = cookie;

    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        rejectUnauthorized: cfg.verifyTls,
        headers,
        timeout,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > maxBytes) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: raw }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 网络层报错同样容易把人带偏，这里换成能直接照着修的说法 */
function friendlyError(err, cfg) {
  const text = String(err?.message || err || '').trim();
  if (/ECONNREFUSED/i.test(text)) return `Hermes 拒绝了连接（${cfg.baseUrl}），确认服务在跑、端口没写错`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return `解析不了 Hermes 的主机名（${text}）`;
  if (/EHOSTUNREACH|ENETUNREACH/i.test(text)) return `路由不通（${text}），确认本机与 ${cfg.baseUrl} 在同一网段`;
  if (/ECONNRESET/i.test(text)) return `连接被重置（${text}），可能被防火墙或反代拦了`;
  if (/ETIMEDOUT|timeout/i.test(text)) return '访问 Hermes 超时，检查地址是否可达';
  return text || '未知错误';
}

function cookieFrom(headers) {
  const raw = headers['set-cookie'];
  if (!Array.isArray(raw)) return '';
  // 只取 name=value 部分，后面的 Path / HttpOnly / Expires 回传时不需要
  return raw
    .map((c) => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function describeFailure(res, cfg) {
  const data = parseJson(res.text);
  // Hermes 自己的中文报错最有用（比如登录失败时那句「剩余尝试 N 次」），原样透出
  if (data?.error) return String(data.error);
  if (res.status === 401) return `Hermes 返回 401：这个路径需要登录（${cfg.baseUrl}）`;
  if (res.status === 404) return `Hermes 上没有这个接口（HTTP 404）：${cfg.baseUrl}`;
  return `Hermes 返回 HTTP ${res.status}`;
}

/* ── 会话：进程内一份 Cookie，失效自动重登 ─────────────────────────── */
const session = { cookie: '', user: null, at: 0, lastError: null, cooldownUntil: 0 };
/** 会话寿命：Hermes 没给过期时间，保守取 20 分钟主动重登一次 */
const SESSION_TTL = 20 * 60 * 1000;
/** 登录失败后的冷却期，避免把账号试到锁定 */
const LOGIN_COOLDOWN = 5 * 60 * 1000;

export function hermesSessionStatus() {
  return {
    loggedIn: Boolean(session.cookie),
    user: session.user,
    at: session.at ? new Date(session.at).toISOString() : null,
    lastError: session.lastError,
    cooldownUntil: session.cooldownUntil ? new Date(session.cooldownUntil).toISOString() : null,
  };
}

async function login(cfg) {
  if (!cfg.user || !cfg.password) {
    throw new Error('服务端没有配置 HERMES_USER / HERMES_PASSWORD，请在 .env 里补上并重启服务');
  }
  if (Date.now() < session.cooldownUntil) {
    const wait = Math.max(1, Math.ceil((session.cooldownUntil - Date.now()) / 60000));
    throw new Error(`上次登录失败，已暂停重试 ${wait} 分钟（Hermes 会锁账号）；核对凭证后重启服务即可立刻重试`);
  }

  let res;
  try {
    res = await request(cfg, '/auth/login', {
      method: 'POST',
      body: { user: cfg.user, password: cfg.password, remember: true },
      timeout: 8000,
    });
  } catch (err) {
    throw new Error(friendlyError(err, cfg));
  }

  const data = parseJson(res.text) || {};
  if (res.status !== 200 || !data.ok) {
    const msg = describeFailure(res, cfg);
    session.cookie = '';
    session.user = null;
    session.at = 0;
    session.lastError = msg;
    session.cooldownUntil = Date.now() + LOGIN_COOLDOWN;
    throw new Error(msg);
  }

  const cookie = cookieFrom(res.headers);
  if (!cookie) throw new Error('Hermes 登录返回成功，但没拿到会话 Cookie，认证方式可能变了');

  session.cookie = cookie;
  session.user = data.user || cfg.user;
  session.at = Date.now();
  session.lastError = null;
  session.cooldownUntil = 0;
  return { user: session.user, redirect: data.redirect || '/' };
}

/**
 * 调用「需要登录」的 Hermes 接口，返回原始响应 {status, headers, text}。
 * 探测脚本要靠状态码判断接口在不在，所以这一步不做 >=400 抛错。
 */
export async function authedRequest(apiPath, { method = 'GET', body = null, timeout = 8000 } = {}) {
  const cfg = hermesConfig();
  if (session.cookie && Date.now() - session.at > SESSION_TTL) {
    session.cookie = '';
    session.at = 0;
  }
  if (!session.cookie) await login(cfg);

  try {
    let res = await request(cfg, apiPath, { method, body, cookie: session.cookie, timeout });
    if (res.status === 401) {
      // 会话被顶掉或过期：重登一次再试，只有一次，避免把错误口令反复往外送
      session.cookie = '';
      session.at = 0;
      await login(cfg);
      res = await request(cfg, apiPath, { method, body, cookie: session.cookie, timeout });
    }
    return res;
  } catch (err) {
    throw new Error(friendlyError(err, cfg));
  }
}

/**
 * 同 authedRequest，但把响应解析成 JSON 并在失败时抛可读错误。
 * 正常业务调用用这个，路径照着 Hermes 的接口填，例如 hermesApi('/api/xxx')。
 */
export async function hermesApi(apiPath, opts = {}) {
  const cfg = hermesConfig();
  const res = await authedRequest(apiPath, opts);
  if (res.status >= 400) throw new Error(describeFailure(res, cfg));
  const data = parseJson(res.text);
  if (data === null) throw new Error('Hermes 返回的不是合法 JSON');
  return data;
}

/* ── 公开接口：工位 / 员工在线状态 ─────────────────────────────────── */

/**
 * 读工位状态。免登录，所以哪怕没配凭证也能用。
 * 注意这里是「连不上就抛异常」，由调用方决定是整页报错还是静默降级。
 */
export async function hermesSeats({ timeout = 6000 } = {}) {
  const cfg = hermesConfig();
  let res;
  try {
    res = await request(cfg, '/public/agents', { timeout });
  } catch (err) {
    throw new Error(friendlyError(err, cfg));
  }
  const data = parseJson(res.text);
  if (res.status >= 400 || !data) throw new Error(describeFailure(res, cfg));

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

/**
 * 「测试连接」：先探公开状态，再（配了口令的话）试着登录一次。
 * 两层结果分开给，界面才能分辨「地址不对」和「凭证不对」。
 */
export async function testHermes() {
  const cfg = hermesConfig();
  const result = {
    ok: false,
    baseUrl: cfg.baseUrl,
    error: null,
    public: { ok: false, error: null, gatewayVersion: null, seats: null, staffed: null, online: null, items: [] },
    auth: { configured: Boolean(cfg.user && cfg.password), attempted: false, ok: false, user: cfg.user || null, error: null },
    session: hermesSessionStatus(),
  };

  try {
    const seats = await hermesSeats();
    result.public = {
      ok: true,
      error: null,
      gatewayVersion: seats.gatewayVersion,
      seats: seats.seats,
      staffed: seats.staffed,
      online: seats.online,
      items: seats.items,
    };
    result.ok = true;
  } catch (err) {
    result.public.error = err.message;
    result.error = err.message;
    return result;
  }

  if (!result.auth.configured) {
    result.auth.error = '未配置 HERMES_USER / HERMES_PASSWORD：公开工位状态可用，登录后的业务接口不可用';
    return result;
  }

  result.auth.attempted = true;
  try {
    const r = await login(cfg);
    result.auth.ok = true;
    result.auth.user = r.user;
  } catch (err) {
    result.auth.error = err.message;
    result.error = err.message;
    result.ok = false;
  }
  result.session = hermesSessionStatus();
  return result;
}
