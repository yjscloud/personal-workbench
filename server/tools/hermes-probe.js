import 'dotenv/config';
import { hermesApi, hermesConfig } from '../services/hermes.js';
import { testLocalBridge, bridgeCall } from '../services/hermes-local.js';
import { localConfig } from '../services/hermes-config.js';

/* ────────────────────────────────────────────────────────────────────────
 * Hermes 连接探测器
 *
 *   npm run hermes:probe            探两条通道 + 内置接口清单
 *   npm run hermes:probe -- /api/xxx  额外探指定的网关 GET 路径
 *
 * 只发 GET / 只读数据桥，不改动任何数据。
 * ──────────────────────────────────────────────────────────────────────── */

const CANDIDATES = [
  '/v1/models',
  '/v1/toolsets',
  '/api/sessions?limit=1',
  '/api/jobs',
];

const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
const sample = (s) => {
  const t = flat(s);
  return t.length > 160 ? `${t.slice(0, 160)}…` : t || '(空)';
};
const toJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

function shape(text) {
  const d = toJson(text);
  if (Array.isArray(d)) {
    if (!d.length) return '[空数组]';
    const first = typeof d[0] === 'object' && d[0] ? `，首项字段 ${Object.keys(d[0]).slice(0, 10).join(',')}` : '';
    return `[数组 ${d.length} 项${first}]`;
  }
  if (d && typeof d === 'object') return `字段 ${Object.keys(d).slice(0, 14).join(',')}`;
  return sample(text);
}

async function main() {
  const cfg = hermesConfig();
  const local = localConfig();
  const extra = process.argv.slice(2);

  console.log(`网关 ${cfg.baseUrl}｜API Key ${cfg.apiKey ? '已配置' : '未配置'}`);
  console.log(`数据桥 ${local.host || '(未配置)'}｜${local.bridgePath}｜缓存 ${local.cacheTtl}ms\n`);

  let gatewayOk = false;
  try {
    const models = await hermesApi('/v1/models', { timeout: 8000 });
    const ids = (models?.data || []).map((m) => m.id).filter(Boolean);
    console.log(`网关：通，模型 ${ids.join('、') || '(无)'}`);
    gatewayOk = true;
  } catch (err) {
    console.log(`网关：失败 — ${err.message}`);
  }

  if (gatewayOk) {
    const targets = [...new Set([...CANDIDATES, ...extra])];
    for (const path of targets) {
      try {
        const r = await hermesApi(path, { timeout: 12000 });
        console.log(`  200  GET ${path}  ${shape(JSON.stringify(r))}`);
      } catch (err) {
        console.log(`  ERR  GET ${path}  ${err.message}`);
      }
    }
  }

  const ping = await testLocalBridge();
  if (!ping.ok) {
    console.log(`\n数据桥：失败 — ${ping.error}`);
    return;
  }
  console.log(`\n数据桥：通（Node ${ping.node}，${ping.elapsedMs}ms）`);
  console.log(`  Hermes 安装 ${ping.install_dir}`);
  console.log(`  HERMES_HOME ${ping.hermes_home}`);
  console.log(`  数据目录 ${ping.data_dir}`);
  console.log(`  网关凭证 ${ping.key_configured ? `已读取（${ping.key_source}）` : '未找到'}`);
  console.log(`  抓取脚本 ${ping.scrape_script ? '在位' : '缺失'}`);

  try {
    const agents = await bridgeCall('/public/agents', { timeout: 20000, cacheTtl: 0 });
    console.log(`  工位 ${agents.seats} / 在编 ${agents.staffed} / 在线 ${agents.online}`);
    for (const a of agents.items || []) console.log(`    ${a.online ? '●' : '○'} ${a.name}（${a.id}）`);
  } catch (err) {
    console.log(`  工位状态：失败 — ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
