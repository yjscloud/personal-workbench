import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import cron from 'node-cron';

import { db, flush, replaceScoped, update } from '../store.js';

/* ────────────────────────────────────────────────────────────────────────
 * 知识库备份到腾讯云 COS
 *
 * 备份内容是**知识库与工具箱两块**（见 backupSnapshot），不是整份数据。
 * 这份备份每天自动跑，要保的是"写下来的东西"：知识库文档，以及工具箱里的
 * 收藏与它们的分类。任务、设置、AI 热点、用电统计这些**不在里面** ——
 * 它们要么每天在变、要么本来就在别处有痕迹，塞进这份每日快照只会让
 * 文件变大、恢复时的顾虑变多。
 *
 * 全量的那份仍然在设置页的「导出备份 / 导入备份」那里（exportAll/replaceAll），
 * 两者承担的事不一样：那边是"搬家与灾备"，这边是"每天把写过的东西存一份"。
 *
 * 为什么手写签名而不用官方 SDK：
 * 这个仓库对第三方依赖一直很克制（PVE 客户端就是手写的 node:https），
 * 而这里要的能力只有"PUT 一个对象"，签名算法是公开的固定几步 HMAC-SHA1。
 * 为它引一个带传递依赖的 SDK，比多这六十行更不划算。
 *
 * 签名实现依据官方《请求签名》文档：
 *   SignKey      = HMAC-SHA1(SecretKey, KeyTime)
 *   HttpString   = Method\nUriPath\nHttpParameters\nHttpHeaders\n
 *   StringToSign = "sha1"\nKeyTime\nSHA1(HttpString)\n
 *   Signature    = HMAC-SHA1(SignKey, StringToSign)
 * 中间每一步都能用文档里那份示例对出来（见 tools/cos-sign-check.js）。
 * ──────────────────────────────────────────────────────────────────────── */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** 默认计划：每天 03:30。避开 04:20 的留存清理与 06:00 的热点抓取，
 *  也不撞采样器的整点那一轮 —— 几件事挤在同一分钟只会徒增抖动 */
export const DEFAULT_BACKUP_CRON = '30 3 * * *';

/** 单次上传的超时。备份是几 MB 量级的整份快照，给足但别挂死 */
const COS_TIMEOUT_MS = 60_000;

/* ── 配置 ────────────────────────────────────────────────────────────── */

/** 设置项 → 环境变量的兜底名。凭证优先用设置页里填的（和 PVE 令牌同一套做法） */
const COS_ENV = {
  secretId: 'COS_SECRET_ID',
  secretKey: 'COS_SECRET_KEY',
  bucket: 'COS_BUCKET',
  region: 'COS_REGION',
};

export function cosConfig(settings) {
  const cos = settings?.backup?.cos || {};
  const pick = (name) => {
    const fromSettings = String(cos[name] ?? '').trim();
    return fromSettings || String(process.env[COS_ENV[name]] ?? '').trim();
  };
  return {
    secretId: pick('secretId'),
    secretKey: pick('secretKey'),
    bucket: pick('bucket'),
    region: pick('region'),
    prefix: String(settings?.backup?.prefix ?? '').trim(),
    /* 临时密钥才需要（用永久密钥时为空）。只从环境变量读：
       它是"这一次会话的凭证"，不该长期躺在库里 */
    sessionToken: String(process.env.COS_SESSION_TOKEN ?? '').trim(),
  };
}

/**
 * 缺哪一项就报哪一项，而不是笼统说"没配置"——
 * 这个页面上一共四个输入框，报错必须能指出是哪一个没填。
 */
export function cosMissing(cfg) {
  const missing = [];
  if (!cfg.secretId) missing.push('SecretId');
  if (!cfg.secretKey) missing.push('SecretKey');
  if (!cfg.bucket) missing.push('存储桶');
  if (!cfg.region) missing.push('地域');
  return missing;
}

const hostOf = (cfg) => `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;

/* ── 签名 ────────────────────────────────────────────────────────────── */

/**
 * COS 的 UrlEncode。比 encodeURIComponent 更严一格：
 * 后者会把 !'()* 这几个字符原样放过，而 COS 的编码表要求它们也转义。
 * 签名里只要有一个字节和 COS 的算法对不上，整个请求就是 403。
 */
function cosEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 对象键 → 请求行里的路径。**逐段编码**，分隔符 `/` 必须留着 ——
 * 整串一起编码会得到 `a%2Fb`，那在 COS 眼里是另一个（不存在的）对象键。
 */
export function cosObjectPath(key) {
  return `/${String(key).replace(/^\/+/, '').split('/').map(cosEncode).join('/')}`;
}

/**
 * 对象键 → **参与签名的**路径：不转义，直接用键本身。
 *
 * 这一处是照着官方《请求签名》示例定的，它的两处写法并不一致：
 *   请求行   PUT /exampleobject(%E8%85%BE%E8%AE%AF%E4%BA%91)
 *   HttpString  put\n/exampleobject(腾讯云)\n\n…
 * 也就是说 **COS 服务端是先把请求路径解码、再拿解码后的结果参与签名**的。
 * 文档还给了一串可复算的中间值（HttpString 的 SHA1），按解码口径算才
 * 对得上 —— 见 tools/cos-sign-check.js，那里就是拿它当测试向量的。
 *
 * 实际使用中这条差异几乎无关紧要：对象键前缀在 PUT /settings 里已经被
 * 限制成 ASCII（见 routes.js），两种口径算出来的字符串一模一样。
 */
const signedPath = (key) => `/${String(key).replace(/^\/+/, '')}`;

const hmacSha1 = (secret, msg) => crypto.createHmac('sha1', secret).update(msg, 'utf8').digest('hex');
const sha1 = (msg) => crypto.createHash('sha1').update(msg, 'utf8').digest('hex');

/**
 * 生成 Authorization 头。
 *
 * 只签 `host` 与 `content-type` 两个头：官方文档明确写了"不必处理全部头部，
 * 用户可按需筛选"，而**签名里列了哪个头，就要求请求里那个头逐字节一致**。
 * 少列一个就少一处对不上的可能（content-length / date 都由 fetch 自己写，
 * 而且它们都在 fetch 的禁止改写名单里，根本轮不到我们插话）。
 */
export function cosAuthorization({
  method,
  key,
  headers,
  params,
  secretId,
  secretKey,
  sessionToken,
  now = Date.now(),
  ttlSeconds = 600,
}) {
  const start = Math.floor(now / 1000);
  const keyTime = `${start};${start + ttlSeconds}`;

  /* 头名一律小写后排序，取值 urlEncode —— 顺序错一个字符签名就废 */
  const map = new Map();
  for (const [name, value] of Object.entries(headers || {})) map.set(name.toLowerCase(), String(value));
  if (sessionToken) map.set('x-cos-security-token', sessionToken);
  const names = [...map.keys()].sort();

  const headerList = names.join(';');
  const httpHeaders = names.map((n) => `${n}=${cosEncode(map.get(n))}`).join('&');

  /* 查询参数（列桶要用 prefix）。按名排序后 urlEncode 成 `a=1&b=2`，
     同时把参名写进 q-url-param-list —— **签了哪个参数，请求里那个参数
     就必须逐字节一致**，和头是同一套规矩。
     不传参数时这里全是空串，于是 PUT 的 HttpString 仍然是
     `put\n/path\n\nhost=...\n`（中间那两个换行必须留着，少一个就过不去），
     与 tools/cos-sign-check.js 里那份官方测试向量一致。 */
  const pmap = new Map();
  for (const [name, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) pmap.set(name, String(value));
  }
  const pnames = [...pmap.keys()].sort();
  const httpParameters = pnames.map((n) => `${cosEncode(n)}=${cosEncode(pmap.get(n))}`).join('&');

  const httpString = `${method.toLowerCase()}\n${signedPath(key)}\n${httpParameters}\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(hmacSha1(secretKey, keyTime), stringToSign);

  return {
    keyTime,
    httpString,
    httpHeaders,
    httpParameters,
    headerList,
    signature,
    authorization:
      `q-sign-algorithm=sha1&q-ak=${secretId}` +
      `&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
      `&q-header-list=${headerList}&q-url-param-list=${pnames.map(cosEncode).join(';')}` +
      `&q-signature=${signature}`,
  };
}

/* ── 请求 ────────────────────────────────────────────────────────────── */

/** COS 出错时回的是 XML，把 Code/Message 抠出来给人看，比裸的 403 有用得多 */
async function cosErrorMessage(res) {
  const text = await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
  if (code || message) return [code, message].filter(Boolean).join(': ');
  return `HTTP ${res.status}`;
}

export async function cosPut(cfg, key, body, contentType = 'application/json; charset=utf-8') {
  const { authorization } = cosAuthorization({
    method: 'PUT',
    key,
    headers: { host: hostOf(cfg), 'content-type': contentType },
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    sessionToken: cfg.sessionToken,
  });

  let res;
  try {
    res = await fetch(`https://${hostOf(cfg)}${cosObjectPath(key)}`, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        Authorization: authorization,
        ...(cfg.sessionToken ? { 'x-cos-security-token': cfg.sessionToken } : {}),
      },
      body,
      signal: AbortSignal.timeout(COS_TIMEOUT_MS),
    });
  } catch (err) {
    /* 连不上就别把 Node 那串 ENOTFOUND 原样丢出去：这个页面上的人
       需要知道的是"存储桶名或地域填错了"，而不是一个 DNS 错误码 */
    throw new Error(
      err?.name === 'TimeoutError'
        ? `连接 COS 超时（超过 ${COS_TIMEOUT_MS / 1000} 秒）`
        : `连不上 ${hostOf(cfg)}：${err.message}。检查存储桶名（要带 -APPID 后缀）与地域`,
    );
  }

  if (!res.ok) throw new Error(`COS 拒绝了这次上传：${await cosErrorMessage(res)}`);
  return { key, etag: res.headers.get('etag') || '' };
}

/** 一次 COS 请求的样板：签名、超时、把连不上的原始错误换成能照着查的说法 */
async function cosFetch(cfg, { method, key, params, contentType }) {
  const query = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
  const { authorization } = cosAuthorization({
    method,
    key,
    params,
    headers: { host: hostOf(cfg), ...(contentType ? { 'content-type': contentType } : {}) },
    secretId: cfg.secretId,
    secretKey: cfg.secretKey,
    sessionToken: cfg.sessionToken,
  });

  try {
    return await fetch(`https://${hostOf(cfg)}${cosObjectPath(key)}${query}`, {
      method,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        Authorization: authorization,
        ...(cfg.sessionToken ? { 'x-cos-security-token': cfg.sessionToken } : {}),
      },
      signal: AbortSignal.timeout(COS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      err?.name === 'TimeoutError'
        ? `连接 COS 超时（超过 ${COS_TIMEOUT_MS / 1000} 秒）`
        : `连不上 ${hostOf(cfg)}：${err.message}。检查存储桶名（要带 -APPID 后缀）与地域`,
    );
  }
}

/** 前缀（两侧斜杠去掉）。三处用到，抽出来免得各写一遍各漏一处 */
const prefixOf = (cfg) => String(cfg.prefix || '').trim().replace(/^\/+|\/+$/g, '');

/**
 * 取回一个对象。备份是 gzip 的 JSON，所以按二进制拿回来交给调用方。
 *
 * **备份必须能被取回**：只能写不能读的备份等于没有备份 ——
 * 真要恢复的时候，人得先去 COS 控制台下载、再解开 gzip、再走"导入备份"，
 * 而那时候往往正是着急的时候。
 */
export async function cosGet(cfg, key) {
  const res = await cosFetch(cfg, { method: 'GET', key });
  if (!res.ok) throw new Error(`COS 拒绝了这次下载：${await cosErrorMessage(res)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 列桶里的对象（一次请求给全）。
 *
 * 这里手写 XML 解析而不是引库：ListObjects 的响应是机器生成的定长结构，
 * 只要 Contents 三兄弟（Key/Size/LastModified），正则够用且没有依赖。
 */
export async function cosList(cfg, prefix) {
  const params = { prefix, 'max-keys': 1000 };
  const res = await cosFetch(cfg, { method: 'GET', key: '', params });
  if (!res.ok) throw new Error(`COS 拒绝了这次列桶：${await cosErrorMessage(res)}`);

  const xml = await res.text();
  const out = [];
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    out.push({
      key: decodeXml(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? '',
    });
  }
  return out;
}

/** COS 的 XML 里 &amp; 这类实体是转义的，键名要被解析回来才对得上 */
const decodeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** 探一个对象在不在（为只给了 PutObject+GetObject 的密钥准备的） */
export async function cosHead(cfg, key) {
  const res = await cosFetch(cfg, { method: 'HEAD', key });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`COS 拒绝了这次探测：${await cosErrorMessage(res)}`);
  return {
    key,
    size: Number(res.headers.get('content-length') || 0),
    lastModified: res.headers.get('last-modified') || '',
  };
}

/* ── 备份 ────────────────────────────────────────────────────────────── */

/** 前缀两侧的斜杠去掉再拼键：各写一遍迟早有一处漏掉，拼出 `a//b` */
const joinKey = (prefix, name) => {
  const head = String(prefix || '').trim().replace(/^\/+|\/+$/g, '');
  return `${head ? `${head}/` : ''}${name}`;
};

/**
 * 对象键：`<prefix>/knowledge-YYYY-MM-DD.json.gz`。
 *
 * 同日多次备份会覆盖同名对象 —— 有意为之：一天的备份只该有一份，
 * 否则手动多点几次就会在桶里堆出一串内容几乎相同的文件。
 * 用 UTC 日期而不是本地日期：对象键跟着服务器时区漂移更让人困惑。
 */
export function backupKey(prefix, at = new Date()) {
  return joinKey(prefix, `knowledge-${at.toISOString().slice(0, 10)}.json.gz`);
}

/**
 * 恢复前的存档名：`<prefix>/pre-restore-YYYY-MM-DDTHH-mm-ss.json.gz`。
 *
 * **不能用按日期那套命名**：用户要恢复的那一份很可能就是今天的，
 * 存档一覆盖它，等于把正要救的东西先砸了。时间戳还让它一份都不重叠，
 * 于是在桶里能看出"哪几份是恢复前自动留的"。
 */
export function safetyBackupKey(prefix, at = new Date()) {
  return joinKey(prefix, `pre-restore-${at.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json.gz`);
}

/** 把一次备份的结果写回设置（设置页要显示"上次备份：什么时间、多大、成没成"） */
async function recordRun(patch) {
  update((d) => {
    d.settings.backup = { ...d.settings.backup, ...patch };
    d.settings.updatedAt = new Date().toISOString();
  });
  await flush();
}

/** 备份范围。写进文件里，将来拿到这份 JSON 能一眼看出它是**部分**备份 */
export const BACKUP_SCOPE = 'knowledge+toolbox';

/**
 * 这一份备份的内容：**只有知识库与工具箱**。
 *
 * 工具箱就是书签与它的分组（`groups` + `bookmarks`）。两者必须一起打包：
 * 书签用 group_id 指向分组，只恢复其中一半会得到一堆悬空引用。
 *
 * `scope` 是要紧的：没有它，一份"只有 knowledge 和 bookmarks 的 JSON"
 * 看起来就像一份**缺了 todos 的坏数据** —— 而恢复时会照着这个判断
 * 该整份替换还是只替换这几张表。
 */
export function backupSnapshot() {
  const data = db();
  return {
    exportedAt: new Date().toISOString(),
    app: 'personal-workbench',
    version: 1,
    scope: BACKUP_SCOPE,
    data: {
      knowledge: data.knowledge ?? [],
      groups: data.groups ?? [],
      bookmarks: data.bookmarks ?? [],
    },
  };
}

/**
 * 打包当前状态并上传到指定键。
 *
 * 每次都是**完整**的一份（不是增量），所以随便挑一份都能独立还原，
 * 不必按顺序回放一串差异包。runBackup 与"恢复前先留一份"共用它，
 * 两处的打包口径（范围、gzip 级别、JSON 形状）才不会各写一套。
 */
async function uploadSnapshot(cfg, key) {
  const json = JSON.stringify(backupSnapshot());
  /* gzip：快照里正文是纯文本，压缩比很高（通常 5~10 倍）。
     顺带把上传体积压到几 MB 以内，PUT 一次就能上去，不必上分块上传 */
  const gz = await gzip(Buffer.from(json, 'utf8'), { level: 6 });
  await cosPut(cfg, key, gz);
  return { key, bytes: gz.byteLength, rawBytes: Buffer.byteLength(json) };
}

/** 知识库与工具箱的规模。恢复前后各取一次，页面能直接说清"换掉了多少" */
const countsOf = (data) => ({
  knowledge: Array.isArray(data?.knowledge) ? data.knowledge.length : 0,
  groups: Array.isArray(data?.groups) ? data.groups.length : 0,
  bookmarks: Array.isArray(data?.bookmarks) ? data.bookmarks.length : 0,
});

/**
 * 跑一次备份。失败会先记状态再抛出 —— 页面要看到"上次失败、原因是这个"，
 * 只在日志里留一行的话，用户下次打开页面只会看到一个不再更新的时间戳。
 */
export async function runBackup({ trigger = 'manual' } = {}) {
  const cfg = cosConfig(db().settings);
  const missing = cosMissing(cfg);
  if (missing.length) {
    const err = new Error(`备份还没配好，缺少：${missing.join('、')}`);
    await recordRun({ lastStatus: 'error', lastError: err.message, lastTrigger: trigger }).catch(() => {});
    throw err;
  }

  const at = new Date();
  const key = backupKey(cfg.prefix, at);

  try {
    const packed = await uploadSnapshot(cfg, key);

    const summary = {
      lastRunAt: at.toISOString(),
      lastKey: key,
      lastBytes: packed.bytes,
      lastDocs: countsOf(db()).knowledge,
      lastTrigger: trigger,
      lastStatus: 'ok',
      lastError: '',
    };
    await recordRun(summary);
    return { ...summary, rawBytes: packed.rawBytes };
  } catch (err) {
    await recordRun({ lastStatus: 'error', lastError: err.message, lastTrigger: trigger, lastRunAt: at.toISOString() }).catch(
      () => {},
    );
    throw err;
  }
}

/**
 * 连通性自检：往桶里写一个几十字节的探针对象。
 *
 * 用 PUT 而不是列桶/取地域来测，是因为备份真正需要的能力就是 PutObject ——
 * 只读权限能过、写权限不给的密钥，用别的方式测会"测通了但备份照样失败"。
 */
export async function testConnection() {
  const cfg = cosConfig(db().settings);
  const missing = cosMissing(cfg);
  if (missing.length) throw new Error(`还差这些没填：${missing.join('、')}`);

  const key = joinKey(cfg.prefix, '_connection-test.txt');
  const body = Buffer.from(`个人工作台 · COS 连通性测试\n${new Date().toISOString()}\n`, 'utf8');
  await cosPut(cfg, key, body, 'text/plain; charset=utf-8');
  return { key, bytes: body.byteLength, bucket: cfg.bucket, region: cfg.region };
}

/* ── 读回：列出历次备份、挑一份恢复 ──────────────────────────────────── */

const isBackupKey = (key) => /\.json\.gz$/i.test(key);

/**
 * 列出桶里的备份，新的在前。
 *
 * 返回 `{ items, mode }`：mode 说明这份清单是怎么来的 ——
 * `list` 是列桶（一次请求、看得见桶里所有对象），
 * `probe` 是按日期探测（密钥没有 ListBucket 权限时的退路）。
 * 页面上要据此说一句"只看得到最近 N 天"，不然"怎么只有这么几份"就成了疑问。
 */
export async function listBackups({ days = 14 } = {}) {
  const cfg = cosConfig(db().settings);
  const missing = cosMissing(cfg);
  if (missing.length) throw new Error(`备份还没配好，缺少：${missing.join('、')}`);

  const prefix = prefixOf(cfg);
  try {
    const objects = await cosList(cfg, prefix ? `${prefix}/` : '');
    return {
      mode: 'list',
      days,
      items: objects.filter((o) => isBackupKey(o.key)).sort(byNewest),
    };
  } catch (err) {
    /* 只给 PutObject + GetObject 的密钥列不了桶（AccessDenied）。备份键名本来
       就是按日期拼的，所以按最近 N 天一个个探过去，最小权限的密钥照样能恢复。
       其它错误（地域错、桶名错）照原样抛出去，那才是要人照着查的东西。 */
    if (!/AccessDenied|Forbidden|403/.test(err.message)) throw err;
    return { mode: 'probe', days, items: await probeBackups(cfg, days) };
  }
}

/** 同样按时间倒序：列桶给的 lastModified 更准，探测没有它就用键名兜底 */
const byNewest = (a, b) => String(b.lastModified || b.key).localeCompare(String(a.lastModified || a.key));

async function probeBackups(cfg, days) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i += 1) {
    const key = backupKey(cfg.prefix, new Date(now - i * 86400_000));
    /* 串行探：十四次几毫秒的 HEAD 不值得并发，而对着一个最小权限的密钥
       并发打十四个请求更容易被限流 */
    const found = await cosHead(cfg, key).catch(() => null);
    if (found) out.push(found);
  }
  return out;
}

/**
 * 从云上的一份备份恢复。
 *
 * **只恢复知识库与工具箱，别的一律不动。** 这份快照里本来也只有这两块；
 * 就算吃到的是早期的整份快照（那时还带 todos/tickets/settings），这里也只取
 * 它认识的那几张表 —— 拿一份"知识库备份"去覆盖任务和设置，是最不该发生的事。
 * 全量恢复仍然由设置页的「导入备份」负责（replaceAll）。
 *
 * 覆盖之前先给当前状态留一份（见 safetyBackupKey：名字带 pre-restore 与
 * 时间戳，绝不会撞上按日期命名的那份 —— 撞上就等于把用户正要救的东西砸了）。
 * 这一步是尽力而为：存不上去也照常恢复，但把原因回给页面，
 * 让人当场知道"这一次没有后悔药"，而不是事后才发现。
 */
export async function restoreFromCos(key) {
  const cfg = cosConfig(db().settings);
  const missing = cosMissing(cfg);
  if (missing.length) throw new Error(`备份还没配好，缺少：${missing.join('、')}`);
  const target = String(key || '').trim();
  if (!target) throw new Error('没说要恢复哪一份');

  const raw = await cosGet(cfg, target);
  let payload;
  try {
    payload = JSON.parse((await gunzip(raw)).toString('utf8'));
  } catch {
    throw new Error(`${target} 读不出来：它不是一份 gzip 压缩的 JSON 备份`);
  }

  /* 至少要认出一块内容 —— 两者都没有的 JSON 很可能只是同名文件，
     拿它去覆盖会把手写的东西清空 */
  const data = payload?.data ?? payload;
  const knows = Array.isArray(data?.knowledge) || Array.isArray(data?.bookmarks) || Array.isArray(data?.groups);
  if (!data || typeof data !== 'object' || !knows) {
    throw new Error(`${target} 里没有可用的数据（既没有 knowledge 也没有 bookmarks），不敢拿它覆盖当前内容`);
  }

  const before = countsOf(db());
  let safetyKey = '';
  let safetyError = '';
  try {
    safetyKey = (await uploadSnapshot(cfg, safetyBackupKey(cfg.prefix))).key;
  } catch (err) {
    safetyError = err.message;
  }

  await replaceScoped(data);
  return {
    restored: true,
    key: target,
    /* 早期那份是整份快照（没有 scope），页面据此说明"只取了其中两块" */
    scope: String(payload?.scope || ''),
    safetyKey,
    safetyError,
    before,
    after: countsOf(db()),
  };
}

/* ── 定时任务 ─────────────────────────────────────────────────────────
 *
 * 任务注册放在服务里（同 services/sampler.js 的做法），而不是 index.js：
 * 设置页改完频率要能**立刻**重新注册，routes.js 直接调 applyBackupSchedule()
 * 就行。写在 index.js 里的话，routes → index 会绕成一个循环 import。
 * ──────────────────────────────────────────────────────────────────── */

let job = null;

export const isValidCron = (expr) => cron.validate(String(expr || ''));

/** 按当前设置注册（或撤销）定时备份。幂等：先停旧的再按新的来 */
export function applyBackupSchedule() {
  if (job) {
    job.stop();
    job = null;
  }
  const backup = db().settings.backup;
  if (!backup?.enabled) {
    console.log('[backup] 自动备份已关闭');
    return;
  }
  const expr = String(backup.cron || '').trim() || DEFAULT_BACKUP_CRON;
  if (!isValidCron(expr)) {
    console.warn(`[backup] cron 表达式无效：${expr}，跳过定时任务`);
    return;
  }
  job = cron.schedule(expr, async () => {
    console.log(`[backup] 定时备份开始 ${new Date().toLocaleString('zh-CN')}`);
    try {
      const r = await runBackup({ trigger: 'schedule' });
      console.log(`[backup] 已上传 ${r.lastKey}（${r.lastBytes} 字节，${r.lastDocs} 篇文档）`);
    } catch (err) {
      console.error('[backup] 备份失败：', err.message);
    }
  });
  console.log(`[backup] 已启用自动备份，计划：${expr}`);
}

export function stopBackupSchedule() {
  if (job) {
    job.stop();
    job = null;
  }
}
