import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../store.js';

/* ── 登录会话 ────────────────────────────────────────────────────────
   账号密码放在 .env 里（AUTH_USER / AUTH_PASSWORD），不落库：
   .env 本来就是 600、密钥全在里面，再存一份进数据库只是多一个泄漏面，
   也让"导出备份"变成一次密码外泄。

   会话不是内存里的一张表，而是一张签名的 cookie：
   payload（用户名 + 过期时间）+ HMAC-SHA256。好处是重启服务不掉线
   （内存表一重启就全员重新登录），也不必为此建表。

   一条刻意的设计：**AUTH_PASSWORD 为空时整个登录关卡关闭**。
   自托管面板最常见的事故就是"设过登录、后来忘了，进不去也没法自救"。
   留一个明确的后门（清空 .env 里那一行、重启）比给用户一把打不开的锁好。

   另一件必须做的事：登录失败限速。这张面板挂在局域网、可能还有公网端口映射，
   没有限速的话一个脚本就能把密码试到底。 */

const COOKIE = 'wb_session';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 失败几次、锁多久。按 IP 计，成功一次就清零 */
const MAX_FAILURES = 8;
const BLOCK_MS = 5 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.resolve(__dirname, '..', 'data', '.auth-secret');

let cachedSecret = null;

/**
 * 会话签名密钥。优先 .env 里的 AUTH_SECRET；
 * 没配就生成一串落在 server/data/.auth-secret（0600）——
 * 不能每次重启随机一个，否则所有人每天都要重登一次。
 */
function secret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = (process.env.AUTH_SECRET || '').trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  try {
    const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (saved) {
      cachedSecret = saved;
      return cachedSecret;
    }
  } catch {
    /* 还没有这个文件，下面生成 */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    console.log('[auth] 已生成会话密钥 server/data/.auth-secret');
  } catch (err) {
    console.warn(`[auth] 会话密钥无法落盘（${err.message}），本次运行内有效，重启后需要重新登录`);
  }
  cachedSecret = generated;
  return cachedSecret;
}

/* ── 口令从哪来 ──────────────────────────────────────────────────────
   两级，先后顺序是刻意的：

     ① 设置页里改过的口令：加盐 scrypt 哈希存在 settings.auth.passwordHash，
        可在界面上随时改，不用碰服务器文件；
     ② .env 里的 AUTH_PASSWORD：**只当引导口令**。首次部署不必先去数据库里
        埋一个哈希，填进 .env 就能登录；一旦在设置页改过，就以哈希为准
        （.env 那行留着不动也不再被读）。

   两个都没有 = 登录关卡关闭，接口全部开放（和加登录之前的行为一致）。
   这同时就是"我把密码忘了"的救援通道：清掉设置页的密码没法做，
   但清空 .env 那一行重启一定进得去 —— 前提是没在设置页改过。 */
function credentials() {
  let stored = null;
  try {
    stored = db().settings?.auth ?? null;
  } catch {
    // 数据层还没初始化（比如启动期），退回到只认 .env
  }
  const envUser = (process.env.AUTH_USER || '').trim();
  const envPass = process.env.AUTH_PASSWORD || '';
  const user = String(stored?.user || '').trim() || envUser || 'admin';

  if (stored?.passwordHash) return { user, hash: stored.passwordHash, plain: '', custom: true, enabled: true };
  if (envPass) return { user, hash: '', plain: envPass, custom: false, enabled: true };
  return { user, hash: '', plain: '', custom: false, enabled: false };
}

/** 给设置页看的账号概览。永远不带出哈希本身 */
export function authConfig() {
  const c = credentials();
  return {
    user: c.user,
    enabled: c.enabled,
    /** true = 口令是设置页里设的（不再读 .env），false = 来自 .env 的引导口令 */
    custom: c.custom,
    /** .env 里是否还留着 AUTH_PASSWORD（留着也不生效，但值得告诉用户） */
    envFallback: Boolean((process.env.AUTH_PASSWORD || '').trim()),
  };
}

/** 登录关卡是否开启。关闭时所有接口照旧开放（与登录功能之前的行为一致） */
export const authEnabled = () => credentials().enabled;

/* ── 口令哈希 ──────────────────────────────────────────────────────── */

/** 加盐 scrypt。存进库里的字符串自带盐与参数，将来换参数也能共存 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyHash(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/**
 * 会话签名用的密钥。
 * 刻意把"当前凭据的指纹"拌进去：改过密码之后，之前发出去的 cookie 立刻验不过。
 * 改密码的常见动机就是"怀疑被人看到了"，这时让旧会话继续有效等于白改。
 * 正在改密码的那台机器会在同一个响应里换发一张新 cookie，不会把自己踢下线。
 */
function tokenKey() {
  const c = credentials();
  const fingerprint = crypto.createHash('sha256').update(`${c.user}:${c.hash || c.plain}`).digest('hex');
  return crypto.createHmac('sha256', secret()).update(fingerprint).digest();
}

const sign = (data) => crypto.createHmac('sha256', tokenKey()).update(data).digest();

/** 用户名 → 签名 token */
export function issueToken(user) {
  const payload = b64(JSON.stringify({ u: user, exp: Date.now() + TTL_MS }));
  return `${payload}.${b64(sign(payload))}`;
}

/** token → 用户名；签名不对或过期都返回 null */
export function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  let expected;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  const given = Buffer.from(mac, 'base64url');
  // 长度不等时 timingSafeEqual 会抛，先挡掉；长度本身不是秘密
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.u || !data?.exp || data.exp < Date.now()) return null;
    return data.u;
  } catch {
    return null;
  }
}

/** 定时比较，避免用字符串 === 泄漏"前几位对不对" */
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ── 限速 ──────────────────────────────────────────────────────────── */

const failures = new Map();

export function blockedFor(ip) {
  const rec = failures.get(ip);
  if (!rec) return 0;
  const left = rec.until - Date.now();
  if (left <= 0) {
    failures.delete(ip);
    return 0;
  }
  return Math.ceil(left / 1000);
}

export function noteFailure(ip) {
  const rec = failures.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.until = Date.now() + BLOCK_MS;
    rec.count = 0;
    console.warn(`[auth] ${ip} 连续登录失败 ${MAX_FAILURES} 次，已锁定 ${BLOCK_MS / 60000} 分钟`);
  }
  failures.set(ip, rec);
}

export const clearFailures = (ip) => failures.delete(ip);

/** 账号密码对不对 */
function verify(c, username, password) {
  const okUser = sameSecret(username || '', c.user);
  const okPass = c.hash ? verifyHash(password || '', c.hash) : sameSecret(password || '', c.plain);
  // 两个都要算过再判断：短路会让"用户名对不对"从耗时上被猜出来
  return okUser && okPass;
}

/** 校验账号密码：对了返回用户名，错了返回 null（失败会计数） */
export function checkCredentials(ip, username, password) {
  if (blockedFor(ip)) return 'blocked';
  const c = credentials();
  if (verify(c, username, password)) {
    clearFailures(ip);
    return c.user;
  }
  noteFailure(ip);
  return null;
}

/** 核对当前口令（改密码时用）。不计失败次数：能调到这里的都是已登录的会话 */
export const verifyCurrent = (username, password) => verify(credentials(), username, password);

/* ── Cookie ────────────────────────────────────────────────────────── */

/** 会话 cookie。HttpOnly：脚本拿不到；SameSite=Lax：挡掉跨站发起的写操作。
    Secure 只在 https 下加 —— 这张面板默认走局域网 http，
    硬加 Secure 会让 cookie 根本存不下来，登录永远进不去。 */
export function sessionCookie(token, secure) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(TTL_MS / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function expiredCookie(secure) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 从请求头里取会话用户名 */
export function currentUser(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').find((c) => c.trim().startsWith(`${COOKIE}=`));
  if (!hit) return null;
  return readToken(hit.trim().slice(COOKIE.length + 1));
}
