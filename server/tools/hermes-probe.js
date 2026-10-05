import 'dotenv/config';
import { hermesSeats, authedRequest, hermesConfig } from '../services/hermes.js';

/* ────────────────────────────────────────────────────────────────────────
 * Hermes 接口清单探测器
 *
 *   填好 .env 里的 HERMES_USER / HERMES_PASSWORD 后执行：
 *     npm run hermes:probe
 *   也可以指定路径（会覆盖内置的候选列表）：
 *     npm run hermes:probe -- /api/foo /api/bar
 *
 * 作用：Hermes 在未登录状态下对所有路径统一返回 401，探测不到任何接口；
 * 登录后用一组候选路径去试，把返回 200 的路径与字段列出来，
 * 这就是把 Hermes 接进 AI 助手的「接口清单」。
 *
 * 只发 GET，不改动任何数据。
 * ──────────────────────────────────────────────────────────────────────── */

const CANDIDATES = [
  '/auth/session',
  '/api/agents',
  '/api/seats',
  '/api/office',
  '/api/overview',
  '/api/status',
  '/api/gateway',
  '/api/gateway/status',
  '/api/tasks',
  '/api/events',
  '/api/logs',
  '/api/conversations',
  '/api/messages',
  '/api/tools',
  '/api/mcp',
  '/api/mcp/servers',
  '/api/skills',
  '/api/models',
  '/api/config',
  '/api/settings',
  '/api/user',
  '/api/version',
  '/v1/models',
  '/openapi.json',
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

/** 只看字段结构，不把整份业务数据刷出来 */
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
  const extra = process.argv.slice(2);
  const targets = extra.length ? extra : CANDIDATES;

  console.log(`目标 ${cfg.baseUrl}｜凭证 ${cfg.user ? `已配置 ${cfg.user}` : '未配置'}`);

  try {
    const seats = await hermesSeats();
    console.log(`公开接口 /public/agents：通，网关 v${seats.gatewayVersion || '?'}，${seats.seats} 工位 / ${seats.staffed} 在编 / ${seats.online} 在线`);
  } catch (err) {
    console.log(`公开接口 /public/agents：失败 — ${err.message}`);
    return;
  }

  if (!cfg.user || !cfg.password) {
    console.log('\n没有 HERMES_USER / HERMES_PASSWORD，登录后的接口无法枚举。\n把它填进 .env（重启服务不是必需的，本脚本自己读 .env）再跑一次。');
    return;
  }

  let res;
  try {
    res = await authedRequest('/auth/session', { timeout: 8000 });
  } catch (err) {
    console.log(`\n登录失败：${err.message}\n注意 Hermes 会限制连续失败次数，确认口令正确后再试。`);
    return;
  }
  const data = toJson(res.text);
  if (!data?.ok) {
    console.log(`\n登录没成（HTTP ${res.status}）：${sample(res.text)}`);
    return;
  }
  console.log(`\n已登录 user=${data.user || cfg.user}，开始枚举候选路径：\n`);

  for (const path of targets) {
    let r;
    try {
      r = await authedRequest(path, { timeout: 6000 });
    } catch (err) {
      console.log(`  ERR  GET ${path} — ${err.message}`);
      continue;
    }
    console.log(r.status === 200 ? `  ${String(r.status).padEnd(4)}GET ${path}  ${shape(r.text)}` : `  ${String(r.status).padEnd(4)}GET ${path}`);
  }

  console.log('\n把返回 200 的路径和字段贴出来，就可以据此把它们接进 assistant.js 了。');
  console.log('没列到的路径也可以追加，例如：npm run hermes:probe -- /api/xxx /api/yyy');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
