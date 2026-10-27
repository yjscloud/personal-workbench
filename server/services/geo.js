import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ────────────────────────────────────────────────────────────────────────
 * IP 归属地：让飞书消息里的 IP 带上地区
 * ────────────────────────────────────────────────────────────────────────
 * 群里来一条「159.65.3.206 爆破 SSH 2576 次」，光看 IP 判断不了轻重：
 * 荷兰机房的段扫描和同城家宽的偶发连接，处理方式不该一样。所以凡是
 * 要发到飞书的消息，只要正文里出现 IP，就在后面补上「国家 城市」。
 *
 * 数据源用 ipwho.is：它支持 HTTPS（ip-api 免费版只有明文 http，
 * 服务器出网常常只放行 443），免费额度也够。查不到就留着原样 ——
 * 补一句「未知地区」只会更吵。
 *
 * 缓存写在 server/data/.ip-geo-cache.json：归属地短期内不会变，
 * 没必要每发一条通知都去撞接口。
 * ──────────────────────────────────────────────────────────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* 缓存放在 server/data（与 .settings-key 同目录），不是 server/services/data ——
   __dirname 是 services/，直接拼 data 会多出一层没意义的目录 */
const CACHE_FILE = path.join(__dirname, '..', 'data', '.ip-geo-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 查失败的缓存只留十分钟：接口抽风时不该每条消息都去撞一次，
    但也不能把一次网络抖动记成"这个 IP 查不到"，那样要等一周才重试 */
const FAIL_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    /* 缓存写不进去只影响下次多查一次，不该让发通知失败 */
  }
}

/** 内网、保留段、组播 —— 查了也没意义 */
function isPublicIp(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/** 「美国 Ashburn」「新加坡」这样；查不到返回空串 */
function formatPlace(data) {
  if (!data || data.status === 'fail' || data.success === false) return '';
  /* 国家名一律走国家码 → 中文：不同数据源给的国名有简有繁、
     还有英文（"Australia" / "澳大利亞" / "澳大利亚"），统一成我们自己这份表 */
  const code = String(data.countryCode || data.country_code || '').toUpperCase();
  const country = COUNTRY_ZH[code] || String(data.country || '').trim();
  const city = String(data.city || '').trim();
  /* city 与 country 相同时（例如新加坡）就只留国家名，
     硬凑成「新加坡 新加坡」反而更费解 */
  const parts = [country];
  if (city && city !== country) parts.push(city);
  return [...new Set(parts)].join(' ').slice(0, 40);
}

/**
 * 查归属地。首选 ip-api：它支持 lang=zh-CN，与助手机 frp_guard 是同一口径，
 * 卡片上不会出现中英混排；它不通时回退 ipwho.is（英文地名）。
 */
async function fetchPlace(addr) {
  try {
    const res = await fetch(
      'http://ip-api.com/json/' + encodeURIComponent(addr)
        + '?lang=zh-CN&fields=status,country,countryCode,regionName,city,isp,as',
      { headers: { 'User-Agent': 'personal-workbench/geo' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const json = await res.json().catch(() => null);
    const place = formatPlace(json);
    if (place) return place;
  } catch {
    /* 换下一个源 */
  }
  try {
    const res = await fetch('https://ipwho.is/' + encodeURIComponent(addr), {
      headers: { 'User-Agent': 'personal-workbench/geo' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    return formatCountryOnly(json);
  } catch {
    return '';
  }
}

/** 回退源 ipwho.is 给的是英文国家名，这里按国家码翻成中文，
    免得同一条消息里中英混排（"美国 Ashburn" 与 "澳大利亞" 并排很难看） */
const COUNTRY_ZH = {
  CN: '中国', TW: '中国台湾', HK: '中国香港', MO: '中国澳门', US: '美国', SG: '新加坡',
  AU: '澳大利亚', JP: '日本', KR: '韩国', IN: '印度', ID: '印度尼西亚', VN: '越南',
  TH: '泰国', MY: '马来西亚', PH: '菲律宾', DE: '德国', FR: '法国', GB: '英国',
  NL: '荷兰', RU: '俄罗斯', CA: '加拿大', BR: '巴西', IT: '意大利', ES: '西班牙',
  SE: '瑞典', NO: '挪威', FI: '芬兰', DK: '丹麦', PL: '波兰', UA: '乌克兰',
  TR: '土耳其', IR: '伊朗', SA: '沙特阿拉伯', AE: '阿联酋', IL: '以色列',
  NZ: '新西兰', AR: '阿根廷', CL: '智利', ZA: '南非', EG: '埃及', NG: '尼日利亚',
  KE: '肯尼亚', PK: '巴基斯坦', BD: '孟加拉国', MX: '墨西哥', AT: '奥地利',
  CH: '瑞士', BE: '比利时', CZ: '捷克', RO: '罗马尼亚', HU: '匈牙利',
  PT: '葡萄牙', GR: '希腊', IE: '爱尔兰', KZ: '哈萨克斯坦', BY: '白俄罗斯',
  LT: '立陶宛', LV: '拉脱维亚', EE: '爱沙尼亚', IS: '冰岛', LU: '卢森堡',
  AL: '阿尔巴尼亚', RS: '塞尔维亚', BG: '保加利亚', HR: '克罗地亚', SI: '斯洛文尼亚',
  SK: '斯洛伐克', GE: '格鲁吉亚', AM: '亚美尼亚', AZ: '阿塞拜疆', UZ: '乌兹别克斯坦',
  OM: '阿曼', QA: '卡塔尔', KW: '科威特', JO: '约旦', LB: '黎巴嫩', IQ: '伊拉克',
  CL2: '', TW2: '', MM: '缅甸', KH: '柬埔寨', LA: '老挝', MN: '蒙古', NP: '尼泊尔',
  LK: '斯里兰卡', UZ2: '', TJ: '塔吉克斯坦', KG: '吉尔吉斯斯坦', TM: '土库曼斯坦',
};

/** 回退源只给国家（英文城市名留着反而更费解） */
function formatCountryOnly(data) {
  if (!data || data.success === false) return '';
  const code = String(data.country_code || '').toUpperCase();
  const country = COUNTRY_ZH[code] || String(data.country || '').trim();
  return country.slice(0, 40);
}

/** 查一个公网 IP 的归属地，查不到返回空串 */
export async function ipToPlace(ip) {
  const addr = String(ip || '').trim();
  if (!isPublicIp(addr)) return '';
  const c = loadCache();
  const hit = c[addr];
  if (hit) {
    const age = Date.now() - Number(hit.at || 0);
    const ttl = hit.place ? CACHE_TTL_MS : FAIL_TTL_MS;
    if (age < ttl) return String(hit.place || '');
  }
  const place = await fetchPlace(addr);
  c[addr] = { place, at: Date.now() };
  saveCache();
  return place;
}

const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * 把正文里的 IP 补上地区：「1.2.3.4 爆破」→「1.2.3.4（荷兰 阿姆斯特丹） 爆破」。
 * 只补查得到的；查不到原样留着。
 */
export async function enrichIps(text) {
  const src = String(text || '');
  if (!src) return src;
  IP_RE.lastIndex = 0;
  const found = src.match(IP_RE);
  if (!found || !found.length) return src;
  const ips = [...new Set(found)].filter(isPublicIp);
  if (!ips.length) return src;
  const places = await Promise.all(ips.map((ip) => ipToPlace(ip)));
  const map = new Map(ips.map((ip, i) => [ip, places[i]]));
  IP_RE.lastIndex = 0;
  return src.replace(IP_RE, (ip, offset) => {
    const place = map.get(ip);
    if (!place) return ip;
    /* 已经带过地区的（后面紧跟右括号）不重复加 */
    const after = src[offset + ip.length];
    if (after === '）' || after === ')') return ip;
    return ip + '（' + place + '）';
  });
}

/**
 * 卡片里正文有两种放法：div.text.lark_md 与 fields[].text.lark_md。
 * 两种都过一遍；标题与 note 不动（那里不该出现 IP）。
 */
export async function enrichCardIps(card) {
  const elements = Array.isArray(card?.elements) ? card.elements : [];
  for (const el of elements) {
    if (el?.tag === 'div' && el.text?.tag === 'lark_md' && el.text.content) {
      el.text.content = await enrichIps(el.text.content);
    }
    if (Array.isArray(el?.fields)) {
      for (const f of el.fields) {
        if (f?.text?.tag === 'lark_md' && f.text.content) {
          f.text.content = await enrichIps(f.text.content);
        }
      }
    }
  }
  return card;
}
