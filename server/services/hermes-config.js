/* ────────────────────────────────────────────────────────────────────────
 * Hermes 连接配置（网关 + 本机数据桥）
 * ────────────────────────────────────────────────────────────────────────
 * 合并 agent_office 之后，工作台对 Hermes 只有两条通道，都从环境变量来：
 *
 *   1. 网关 HTTP（直连，Bearer）
 *        HERMES_API_BASE_URL   例：http://172.16.149.100:8642
 *        HERMES_API_KEY        ~/.hermes/.env 里的 API_SERVER_KEY
 *      提供：会话列表 / 会话明细 / 对话 SSE / 模型 / 工具集
 *
 *   2. 本机数据桥（SSH，只读）
 *        HERMES_LOCAL_HOST     例：172.16.149.100
 *        HERMES_LOCAL_USER     SSH 用户，默认 root
 *        HERMES_LOCAL_KEY      SSH 私钥，默认 /root/.ssh/id_rsa
 *        HERMES_BRIDGE_PATH    远端桥脚本，默认 /data/personal-workbench-bridge/hwb-bridge.cjs
 *      提供：用量 / 待办 / 配置 / 技能 / 记忆 / 进化 / MCP / 值守 / 边界守望 / 拾贝
 *
 * 不再有 agent_office 的登录口令：HERMES_USER / HERMES_PASSWORD 已废弃。
 * ──────────────────────────────────────────────────────────────────────── */

const trimBase = (v) => String(v || '').trim().replace(/\/+$/, '');

export function hermesConfig() {
  return {
    /* 仓库公开，默认值只能是占位地址；真实地址走 .env */
    baseUrl: trimBase(process.env.HERMES_API_BASE_URL || 'http://hermes.home.local:8642'),
    apiKey: String(process.env.HERMES_API_KEY || '').trim(),
    verifyTls: process.env.HERMES_VERIFY_TLS === 'true',
    timeout: Number(process.env.HERMES_TIMEOUT_MS || 12000),
  };
}

export function localConfig() {
  return {
    host: String(process.env.HERMES_LOCAL_HOST || '').trim(),
    user: String(process.env.HERMES_LOCAL_USER || 'root').trim(),
    key: String(process.env.HERMES_LOCAL_KEY || '/root/.ssh/id_rsa').trim(),
    bridgePath: String(process.env.HERMES_BRIDGE_PATH || '/data/personal-workbench-bridge/hwb-bridge.cjs').trim(),
    /* 只读数据默认缓存 20s：页面轮询不会每次都 ssh 过去开一个进程 */
    cacheTtl: Number(process.env.HERMES_LOCAL_CACHE_MS || 20000),
    timeout: Number(process.env.HERMES_LOCAL_TIMEOUT_MS || 30000),
  };
}

/** 兼容旧调用方：现在「凭证」就是网关 Key */
export function hasHermesCredentials() {
  return Boolean(hermesConfig().apiKey);
}

export function isLocalConfigured() {
  return Boolean(localConfig().host);
}
