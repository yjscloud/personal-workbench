/**
 * COS 签名自检。
 *
 * 为什么需要它：签名错了只会得到一个 403，COS 不会告诉你哪一步算错了；
 * 而这个过程有六七个中间量，凭肉眼比对不可行。
 *
 * 好在官方《请求签名》文档里那份「上传对象」示例给出了**完整的中间值**
 * ——包括 HttpString 的全文和它的 SHA1。除了密钥本身被打码，其余每一段
 * 都能拿来当测试向量，于是编码规则、头名排序、分隔符、空参数段这些最容易
 * 写错的地方，全都能在这里被钉死。
 *
 * 跑法：node server/tools/cos-sign-check.js
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { cosAuthorization, cosObjectPath } from '../services/backup.js';

const sha1 = (msg) => crypto.createHash('sha1').update(msg, 'utf8').digest('hex');
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

/* ── 文档示例：PUT /exampleobject(腾讯云) ────────────────────────────────
   请求头（原文）：
     Date: Thu, 16 May 2019 06:45:51 GMT
     Host: examplebucket-1250000000.cos.ap-beijing.myqcloud.com
     Content-Type: text/plain
     Content-Length: 13
     Content-MD5: mQ/fVh815F3k6TAUm8m0eg==
     x-cos-acl: private
     x-cos-grant-read: uin="100000000011"
   文档给出的中间值：
     HeaderList  = content-length;content-md5;content-type;date;host;x-cos-acl;x-cos-grant-read
     HttpHeaders = content-length=13&content-md5=mQ%2FfVh815F3k6TAUm8m0eg%3D%3D&content-type=text%2Fplain&date=Thu%2C%2016%20May%202019%2006%3A45%3A51%20GMT&host=examplebucket-1250000000.cos.ap-beijing.myqcloud.com&x-cos-acl=private&x-cos-grant-read=uin%3D%22100000000011%22
     SHA1(HttpString) = 8b2751e77f43a0995d6e9eb9477f4b685cca4172
   ──────────────────────────────────────────────────────────────────────── */

const DOC_HEADERS = {
  'content-length': '13',
  'content-md5': 'mQ/fVh815F3k6TAUm8m0eg==',
  'content-type': 'text/plain',
  date: 'Thu, 16 May 2019 06:45:51 GMT',
  host: 'examplebucket-1250000000.cos.ap-beijing.myqcloud.com',
  'x-cos-acl': 'private',
  'x-cos-grant-read': 'uin="100000000011"',
};

const DOC_HEADER_LIST = 'content-length;content-md5;content-type;date;host;x-cos-acl;x-cos-grant-read';
const DOC_HTTP_HEADERS =
  'content-length=13&content-md5=mQ%2FfVh815F3k6TAUm8m0eg%3D%3D&content-type=text%2Fplain' +
  '&date=Thu%2C%2016%20May%202019%2006%3A45%3A51%20GMT' +
  '&host=examplebucket-1250000000.cos.ap-beijing.myqcloud.com&x-cos-acl=private' +
  '&x-cos-grant-read=uin%3D%22100000000011%22';
const DOC_SHA1 = '8b2751e77f43a0995d6e9eb9477f4b685cca4172';

console.log('COS 签名自检 · 对照官方《请求签名》文档示例\n');

/* 键就用文档示例里那个（**含中文**）。
   它是有意留着的：文档给的 HttpString 里路径写的是未转义的形式，
   于是"路径要不要先编码"这件事，只有拿这个键才验得出来 ——
   换成纯 ASCII 的键，两种口径结果相同，等于没测。 */
const DOC_KEY = 'exampleobject(腾讯云)';
const DOC_KEY_TIME = '1557989151;1557996351'; // 起始 + 7200 秒

const SIGNED = cosAuthorization({
  method: 'PUT',
  key: DOC_KEY,
  headers: DOC_HEADERS,
  secretId: 'AKIDEXAMPLE',
  secretKey: 'SECRETEXAMPLE',
  now: 1557989151 * 1000,
  ttlSeconds: 7200,
});

check('HeaderList 与文档一致（头名小写 + 字典序）', () => {
  assert.equal(SIGNED.headerList, DOC_HEADER_LIST);
});

check('HttpHeaders 与文档一致（取值 urlEncode）', () => {
  assert.equal(SIGNED.httpHeaders, DOC_HTTP_HEADERS);
});

check('HttpString 与文档逐字相同（含未转义的路径与空参数段的换行）', () => {
  assert.equal(SIGNED.httpString, `put\n/exampleobject(腾讯云)\n\n${DOC_HTTP_HEADERS}\n`);
});

/* 这一条是整套自检里最有分量的：只要编码规则、头名排序、分隔符、
   空参数段里少写或多写一个换行，SHA1 就对不上文档给的值 */
check('SHA1(HttpString) 等于文档给出的 8b2751e7…', () => {
  assert.equal(sha1(SIGNED.httpString), DOC_SHA1);
});

check('KeyTime 等于文档的 1557989151;1557996351', () => {
  assert.equal(SIGNED.keyTime, DOC_KEY_TIME);
});

check('Authorization 七个字段顺序固定', () => {
  const keys = SIGNED.authorization.split('&').map((kv) => kv.split('=')[0]);
  assert.deepEqual(keys, [
    'q-sign-algorithm',
    'q-ak',
    'q-sign-time',
    'q-key-time',
    'q-header-list',
    'q-url-param-list',
    'q-signature',
  ]);
  assert.ok(SIGNED.authorization.startsWith('q-sign-algorithm=sha1&q-ak=AKIDEXAMPLE'));
  assert.ok(SIGNED.authorization.includes('&q-url-param-list=&'), '没有查询参数时留空，但字段不能少');
});

check('Signature 是 40 位小写十六进制', () => {
  assert.match(SIGNED.signature, /^[0-9a-f]{40}$/);
});

check('同输入必然同签名（同一时刻、同一有效期）', () => {
  const again = cosAuthorization({
    method: 'PUT',
    key: DOC_KEY,
    headers: DOC_HEADERS,
    secretId: 'AKIDEXAMPLE',
    secretKey: 'SECRETEXAMPLE',
    now: 1557989151 * 1000,
    ttlSeconds: 7200,
  });
  assert.equal(again.authorization, SIGNED.authorization);
});

check('密钥错一个字节，签名就变（说明密钥真的参与了运算）', () => {
  const other = cosAuthorization({
    method: 'PUT',
    key: DOC_KEY,
    headers: DOC_HEADERS,
    secretId: 'AKIDEXAMPLE',
    secretKey: 'SECRETEXAMPLE2',
    now: 1557989151 * 1000,
    ttlSeconds: 7200,
  });
  assert.notEqual(other.signature, SIGNED.signature);
});

check('备份对象的键在签名里保持为 / 分隔的路径', () => {
  /* 第二个断言看的是**路径那一行**：整串一起编码会得到 a%2Fb，
     那是另一个对象键，上传上去会"成功"但存到一个意料之外的位置 */
  const nested = cosAuthorization({
    method: 'PUT',
    key: 'workbench-backup/knowledge-2026-10-05.json.gz',
    headers: { host: 'x.cos.ap-beijing.myqcloud.com' },
    secretId: 'AKID',
    secretKey: 'K',
  });
  assert.equal(nested.httpString.split('\n')[1], '/workbench-backup/knowledge-2026-10-05.json.gz');
});

check('请求行里的路径逐段转义，分隔符 / 保留', () => {
  assert.equal(
    cosObjectPath('workbench-backup/knowledge-2026-10-05.json.gz'),
    '/workbench-backup/knowledge-2026-10-05.json.gz',
  );
  assert.equal(cosObjectPath('/leading/slash'), '/leading/slash');
  /* 中文按 UTF-8 逐字节转义；! ' ( ) * 这几个 encodeURIComponent 放过的
     字符，COS 的编码表要求转义 —— 少转一个就是 403 */
  assert.equal(cosObjectPath('工作台/报 表(1).csv'), '/%E5%B7%A5%E4%BD%9C%E5%8F%B0/%E6%8A%A5%20%E8%A1%A8%281%29.csv');
});

check('临时密钥会进 HeaderList，且参与签名', () => {
  const a = cosAuthorization({
    method: 'PUT',
    key: 'k',
    headers: { host: 'h' },
    secretId: 'AKID',
    secretKey: 'K',
    sessionToken: 'TOKEN',
  });
  assert.ok(a.headerList.includes('x-cos-security-token'));
  const b = cosAuthorization({ method: 'PUT', key: 'k', headers: { host: 'h' }, secretId: 'AKID', secretKey: 'K' });
  assert.notEqual(a.signature, b.signature);
});

/* ── 查询参数（列桶要用）─────────────────────────────────────────────
   HttpString 的第二段就是它：参数按名排序、取值 urlEncode，并且参名要写进
   q-url-param-list —— 和头一样，"签了哪个，请求里那个就得逐字节一致"。
   不传参数时这一段是空串，于是 PUT 那条路的口径完全不变（上面几条都在盯它）。 */
check('查询参数进 HttpParameters，参名进 q-url-param-list', () => {
  const r = cosAuthorization({
    method: 'GET',
    key: '',
    params: { prefix: 'workbench-backup/', 'max-keys': 1000 },
    headers: { host: 'demo-1250000000.cos.ap-beijing.myqcloud.com' },
    secretId: 'AKID',
    secretKey: 'K',
  });
  const lines = r.httpString.split('\n');
  assert.equal(lines[0], 'get');
  assert.equal(lines[1], '/');
  /* max-keys 排在 prefix 前面（按名排序），值里的 / 要转义 */
  assert.equal(lines[2], 'max-keys=1000&prefix=workbench-backup%2F');
  assert.match(r.authorization, /q-url-param-list=max-keys;prefix&/);
});

check('不传参数时 HttpParameters 仍是空串（PUT 的口径不许被动过）', () => {
  const r = cosAuthorization({
    method: 'PUT',
    key: 'a/b.json.gz',
    headers: { host: 'h', 'content-type': 'text/plain' },
    secretId: 'AKID',
    secretKey: 'K',
  });
  assert.equal(r.httpString.split('\n')[2], '');
  assert.match(r.authorization, /q-url-param-list=&/);
});

check('参数变了签名就变（否则等于没签）', () => {
  const base = { method: 'GET', key: '', headers: { host: 'h' }, secretId: 'AKID', secretKey: 'K' };
  const a = cosAuthorization({ ...base, params: { prefix: 'a/' } });
  const b = cosAuthorization({ ...base, params: { prefix: 'b/' } });
  assert.notEqual(a.signature, b.signature);
});

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
