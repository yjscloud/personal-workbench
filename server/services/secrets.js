import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, '.settings-key');

/* ────────────────────────────────────────────────────────────────────────
 * 设置里那些第三方凭据的落库加密
 * ────────────────────────────────────────────────────────────────────────
 * 背景：PVE Token、COS 密钥对、SMTP 授权码、飞书 webhook、管理员口令哈希
 * 原先都以明文存在 app_settings.payload 这一行 JSON 里。接口层做了掩码，
 * 但那只挡住"看页面的人"——任何拿到数据库读权限的人（弱口令、备份文件、
 * 一次 SQL 注入）可以一次性取走全部凭据，且其中 PVE 那个是 root 级。
 *
 * 做法：AES-256-GCM 逐字段加密，密文形如 enc:v1:<base64(iv|tag|ct)>。
 * 密钥不落库：优先读 SETTINGS_KEY 环境变量（十六进制 64 位或 base64），
 * 没配就在 server/data/.settings-key 生成一份 0600 的随机密钥（首次启动）。
 *
 * 这把密钥能挡住什么、挡不住什么，得说清楚：
 *   · 挡住：只拿到数据库的场景 —— 转储、从库、备份文件、SQL 注入。
 *     密文离开这把密钥就是一堆字节。
 *   · 挡不住：同时拿到主机文件系统的攻击者。文件就在同一台机器上，
 *     这不是 KMS。真正的强隔离要把 SETTINGS_KEY 放进密钥托管/启动注入，
 *     让数据库和密钥落在两个不同的信任域里；代码这边留好了这个口子。
 *
 * 兼容：没有前缀的值按明文读入（老库、旧备份），下一次落库自动变成密文。
 * 于是升级不需要迁移脚本，也不会因为"读到不认识的东西"而丢配置。
 * ──────────────────────────────────────────────────────────────────────── */

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/** 需要加密的字段路径。加一个字段就在这里加一行，读写两侧共用这一份清单 */
export const SECRET_PATHS = [
  ['auth', 'passwordHash'],
  ['pve', 'tokenSecret'],
  ['backup', 'cos', 'secretId'],
  ['backup', 'cos', 'secretKey'],
  ['mail', 'pass'],
  ['stars', 'feishuUrl'],
  ['stars', 'feishuSecret'],
];

let cachedKey = null;
let keySource = '';

function parseKey(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const buf = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (buf.length !== 32) {
    throw new Error('SETTINGS_KEY 必须是 32 字节：64 位十六进制或 44 位 base64（openssl rand -hex 32）');
  }
  return buf;
}

/**
 * 取密钥。环境变量优先，其次读数据目录里的密钥文件，都没有就生成一份。
 * 生成而不是"拒绝启动"，是因为自建部署里多数人不会先去配一个环境变量；
 * 直接失败会让升级变成一个需要读源码才能解开的死局，而生成文件至少是安全的默认值。
 */
function key() {
  if (cachedKey) return cachedKey;

  const fromEnv = parseKey(process.env.SETTINGS_KEY);
  if (fromEnv) {
    cachedKey = fromEnv;
    keySource = 'env:SETTINGS_KEY';
    return cachedKey;
  }

  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8');
    const parsed = parseKey(raw);
    if (!parsed) throw new Error('密钥文件是空的');
    cachedKey = parsed;
    keySource = `file:${KEY_FILE}`;
    return cachedKey;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 文件在但读不出来：宁可报错，也不要悄悄换一把新钥匙 ——
      // 换钥匙等于把所有密文变成不可解，用户看到的是"配置全没了"。
      throw new Error(`读取 ${KEY_FILE} 失败：${err.message}`);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, fresh.toString('hex'), { mode: 0o600 });
  cachedKey = fresh;
  keySource = `file:${KEY_FILE}（新生成）`;
  return cachedKey;
}

/** 给启动日志用：只说密钥从哪来，不打印密钥本身 */
export function keyOrigin() {
  key();
  return keySource;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** 加密一个标量。空值原样返回 —— 空字符串加密后反而会变成"已配置"的假象 */
export function encryptSecret(plain) {
  const value = String(plain ?? '');
  if (!value || isEncrypted(value)) return value;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

let warnedDecrypt = false;

/**
 * 解密一个标量。不是密文就原样返回（老数据）。
 * 解不开（换过密钥、密文被改）时返回空串并告警：让这一项变成"未配置"，
 * 而不是让整个服务起不来 —— 起得来才有页面去把它重新填上。
 */
export function decryptSecret(stored) {
  const value = String(stored ?? '');
  if (!isEncrypted(value)) return value;

  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
    const body = raw.subarray(IV_BYTES + 16);
    const decipher = crypto.createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (err) {
    if (!warnedDecrypt) {
      warnedDecrypt = true;
      console.error(
        `[secrets] 有凭据解不开（${err.message}）。通常是 SETTINGS_KEY 换了或密钥文件丢了：` +
          '相关配置会以空值呈现，请在设置页重新填写；换回原密钥即可恢复。',
      );
    }
    return '';
  }
}

function clone(settings) {
  return settings && typeof settings === 'object' ? structuredClone(settings) : {};
}

/** 按 SECRET_PATHS 走一遍，只动存在的字符串叶子 */
function mapSecrets(settings, fn) {
  const next = clone(settings);
  for (const trail of SECRET_PATHS) {
    let node = next;
    for (const step of trail.slice(0, -1)) {
      if (!node?.[step] || typeof node[step] !== 'object') {
        node = null;
        break;
      }
      node = node[step];
    }
    if (!node) continue;
    const leaf = trail[trail.length - 1];
    if (typeof node[leaf] === 'string' && node[leaf]) node[leaf] = fn(node[leaf]);
  }
  return next;
}

/** 落库前：内存里是明文，写进 app_settings 的必须是密文 */
export function encryptSettings(settings) {
  return mapSecrets(settings, encryptSecret);
}

/**
 * 读库 / 导入备份后：把密文换回明文。
 * plaintext 表示"这批数据里还有没加密的旧值"，调用方据此安排一次回写；
 * 不靠比对整份 JSON，旧库里本来就有大量无关字段的差异。
 */
export function decryptSettings(settings) {
  let plaintext = false;
  let encrypted = false;

  const next = mapSecrets(settings, (value) => {
    if (isEncrypted(value)) {
      encrypted = true;
      return decryptSecret(value);
    }
    plaintext = true;
    return value;
  });

  return { settings: next, plaintext, encrypted };
}
