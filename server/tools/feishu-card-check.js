import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { pool } from '../db/connection.js';
import { decryptSecret } from '../services/secrets.js';

/* ────────────────────────────────────────────────────────────────────────
 * 回读群里的卡片，检查"匿名提交的东西有没有被解析成富文本"
 *
 * 为什么要这个工具：外链提交卡片里的每一个字都来自匿名提交者，我们对
 * 提交者唯一的要求就是"别让它们变成 Markdown"。发送侧已经全改成
 * plain_text，但"我以为我发的是纯文本"和"飞书真的当纯文本渲染"是两件事 ——
 * 只有从服务端把消息读回来才算证据。
 *
 * 判据来自飞书回读格式（不是我们发出去的那份）：
 *   · 提及被解析 → 文本里出现 `@_user_1` 这类占位，或结构里出现 tag=at；
 *     没被解析 → 原始串 `<at id=all></at>` 原样留在文本里。
 *   · 链接被解析 → 结构里出现 href / tag=a；
 *     没被解析 → `[文案](https://…)` 原样留着。
 * 所以"字面串还在"才是通过，"占位符出现"才是漏。
 *
 *   node server/tools/feishu-card-check.js          看最近 10 条
 *   node server/tools/feishu-card-check.js -n 30    看更多
 *   node server/tools/feishu-card-check.js -t 标题   只核验标题匹配的卡片
 *
 * 退出码：0 = 没发现被解析的痕迹；1 = 有卡片出现了真实提及/链接（漏了）。
 * ──────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Math.min(50, Math.max(1, Number(argOf('-n', 10)) || 10));
const FOCUS = argOf('-t', '新的外部任务提交');

/** 递归捞出所有文本节点：回读结构是 {title, elements:[[{tag,text}]]}，别写死层级 */
function collectText(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'text' && typeof value === 'string') out.push(value);
      else collectText(value, out);
    }
  }
  return out;
}

function audit(texts) {
  const joined = texts.join('\n');
  return {
    parsedAt: /@_user_\d+/.test(joined) || /"tag"\s*:\s*"at"/.test(joined),
    literalAt: /<at\b/i.test(joined),
    parsedLink: /"href"|"tag"\s*:\s*"a"/.test(joined),
    literalLink: /\]\(https?:/i.test(joined),
  };
}

async function main() {
  const [rows] = await pool.query('select payload from app_settings limit 1');
  const bot = rows?.[0]?.payload?.feishuBot || {};
  if (!bot.appId || !bot.appSecret || !bot.chatId) {
    throw new Error('应用机器人没配全：设置页需要 App ID / App Secret / 群 chat_id');
  }

  const client = new lark.Client({ appId: bot.appId, appSecret: decryptSecret(bot.appSecret) });
  const res = await client.im.v1.message.list({
    params: {
      container_id_type: 'chat',
      container_id: bot.chatId,
      sort_type: 'ByCreateTimeDesc',
      page_size: LIMIT,
    },
  });

  const items = res?.data?.items || [];
  let failed = 0;
  let focused = 0;

  console.log('');
  console.log(`  最近 ${items.length} 条消息（群 ${bot.chatId}）`);
  for (const item of items) {
    if (item.msg_type !== 'interactive') continue;
    let card;
    try {
      card = JSON.parse(String(item.body?.content || '{}'));
    } catch {
      continue;
    }
    const texts = collectText(card);
    const title = String(card.title || texts.find((t) => t && t.length < 40) || '（无标题）');
    const time = new Date(Number(item.create_time)).toLocaleString('zh-CN');
    const a = audit(texts);
    const isFocus = title.includes(FOCUS);
    if (isFocus) focused += 1;

    const flags = [];
    if (a.parsedAt) flags.push('真实提及');
    if (a.parsedLink) flags.push('真实链接');
    if (a.literalAt) flags.push('字面 <at>');
    if (a.literalLink) flags.push('字面链接语法');
    if (!isFocus) continue;

    if (a.parsedAt || a.parsedLink) failed += 1;
    console.log(`  ${a.parsedAt || a.parsedLink ? '×' : '√'} ${time}  ${title.slice(0, 24)}`);
    console.log(`      ${flags.length ? flags.join(' / ') : '纯文本，无探针痕迹'}`);
  }

  if (!focused) {
    console.log('');
    console.log(`  没找到标题含「${FOCUS}」的卡片：先发一条外链提交，或用 -t 换标题再核验`);
  }

  console.log('');
  if (failed) {
    console.log(`  结论：${failed} 张卡片里的文字被飞书解析成了提及/链接 —— plain_text 漏了`);
    process.exitCode = 1;
  } else {
    console.log('  结论：没有发现被解析的痕迹，匿名内容仍以纯文本呈现');
  }
  console.log('');
}

try {
  await main();
} catch (err) {
  console.error(`[card-check] 失败：${err.message}`);
  if (/230027|permission/i.test(err.message)) {
    console.error('[card-check] 需要开放平台的 im:message.group_msg 权限，并把应用发版生效');
  }
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
