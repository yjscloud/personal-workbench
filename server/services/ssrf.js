import dns from 'node:dns/promises';
import net from 'node:net';

/* ────────────────────────────────────────────────────────────────────────
 * 出站地址白名单（防 SSRF）
 * ────────────────────────────────────────────────────────────────────────
 * 「从 URL 导入文章」是替**服务器**发请求：真正被访问的是这台机器所在的
 * 网络。不加限制的话，它就是一把内网探测与读取的钥匙 —— 指向 127.0.0.1
 * 可以读 Home Assistant，指向 169.254.169.254 可以试云厂商元数据，
 * 指向任意内网段可以拿错误差异当端口扫描器。
 *
 * 规则只有一条：目标必须是公网地址。做法分两层 ——
 *   1. 解析域名，**所有** A/AAAA 记录都必须是公网地址（只要混进一个内网
 *      地址就拒绝，否则轮询解析可以让第二次请求落到内网）；
 *   2. 调用方连的是解析出来的那个 IP，不是域名。这样 DNS 在"校验完"和
 *      "建立连接"之间再改一次答案（DNS rebinding）也换不掉目标。
 *
 * 重定向由 http.js 的 guard 逐跳重新走这两步，不存在"首跳是公网、
 * 第二跳跳到 127.0.0.1"的口子。
 * ──────────────────────────────────────────────────────────────────────── */

/** 非公网 IPv4 段。最后两条是组播与保留段 */
const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // 链路本地，含 169.254.169.254 元数据地址
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  /* 198.18.0.0/15 不封：它虽然是保留段，但 Clash / sing-box 这类代理的
     fake-ip 模式会把它分配给**所有**公网域名（本机实测 example.com →
     198.18.1.78）。封了它等于把整个导入功能关掉，而它本身不指向任何
     内网服务，放行不会让 127/8、10/8、172.16/12 变得可达。 */
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留 + 广播
];

/**
 * 「允许内网」模式下仍然封的段。
 *
 * 书签图标 / 取色打的是用户自己的内网面板（10/172.16/192.168 都要放行），
 * 但下面这些不属于「内网面板」，而属于「本机与元数据面」：
 *   · 127/8        本机的 MySQL、Agent 网关、别的本机服务，打了就等于送端口扫描器
 *   · 169.254/16  链路本地，含 169.254.169.254 云元数据 —— 能换到临时凭据
 *   · 0/8          未指定
 *   · 组播 / 保留
 * 这几条即使在宽松模式下也不放行。
 */
const V4_BLOCKS_LAN = [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.88.99.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);

const inV4Block = (ip, base, bits) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};

function ipv4Blocked(ip, allowPrivate = false) {
  const blocks = allowPrivate ? V4_BLOCKS_LAN : V4_BLOCKS;
  return blocks.some(([base, bits]) => inV4Block(ip, base, bits));
}

function ipv6Blocked(ip, allowPrivate = false) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;

  /* ::ffff:127.0.0.1 这种"v4 映射地址"要按 v4 判：只做字符串前缀匹配会漏 */
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return ipv4Blocked(mapped[1], allowPrivate);

  /* fc00::/7 是 v6 内网（ULA）。宽松模式下放行 —— 和放行 10/8 是同一个理由 */
  if (allowPrivate && /^f[cd][0-9a-f]{2}:/.test(lower)) return false;

  /* 其余只放行全球单播 2000::/3。fe80::/10（链路本地）、ff00::/8（组播）、
     64:ff9b::/96（NAT64，能把 v6 转回 v4 内网）都在外面 */
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return true;
  /* 文档示例段，不该出现在真实访问里 */
  if (/^2001:0?db8:/.test(lower)) return true;
  return false;
}

/**
 * @param {string} address
 * @param {{allowPrivate?: boolean}} [opts]
 *   allowPrivate=true 只放行 RFC1918 / ULA，回环与元数据仍然拒绝。
 *   默认 false = 只允许公网（导入文章那条路必须用默认值）。
 */
export function isBlockedAddress(address, { allowPrivate = false } = {}) {
  const ip = String(address || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return ipv4Blocked(ip, allowPrivate);
  if (net.isIPv6(ip)) return ipv6Blocked(ip, allowPrivate);
  // 认不出来的地址一律拒绝，别让"没判到"变成放行
  return true;
}

/** 带 code 的错误：路由层据此把"被策略拒绝"与"对方连不上"分开 */
export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
  }
}

/**
 * 校验并解析目标，返回**要连的那个 IP**。
 * 调用方拿到 address 之后直接连它，域名只用于 Host 头与 TLS SNI。
 *
 * @param {URL} parsed
 * @param {{allowPrivate?: boolean}} [opts]
 *   allowPrivate=true 用于「书签图标 / 取色」这类要打用户内网面板的场景：
 *   放行 10/172.16/192.168/ULA，但仍拒绝回环、链路本地（云元数据）、组播。
 */
export async function resolvePublicTarget(parsed, { allowPrivate = false } = {}) {
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new SsrfError('只支持 http / https 地址');
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError('地址里不要带账号密码');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new SsrfError('地址里没有主机名');

  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname, { allowPrivate })) {
      throw new SsrfError(allowPrivate
        ? '这个地址指向本机或云元数据，不能从这里抓取'
        : '这个地址指向内网，不能从这里抓取');
    }
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }

  let list;
  try {
    list = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`找不到「${hostname}」这个域名`);
  }
  if (!list.length) throw new SsrfError(`找不到「${hostname}」这个域名`);
  /* 全部记录都要过：只要有任意一条是禁的，就整条拒绝 —— 否则轮询解析
     可以让第二次请求落到那个被禁的地址上 */
  if (list.some((entry) => isBlockedAddress(entry.address, { allowPrivate }))) {
    throw new SsrfError(allowPrivate
      ? `「${hostname}」指向本机或云元数据，不能从这里抓取`
      : `「${hostname}」指向内网地址，不能从这里抓取`);
  }

  return { address: list[0].address, family: list[0].family };
}
