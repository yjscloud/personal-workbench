#!/usr/bin/env node
/**
 * 用 DeepSeek 平台的官方账单校正某一天的用量/花费。
 *
 * 背景：网关 state.db 没有按天的账本，过去的日子只能按轮次分摊，长上下文会话
 * 会被低估（实测官网 10.76M vs 分摊 4.22M）。桥从 10-27 起改成快照差分，往后
 * 是准的；往前和首次部署那天的底数，只能拿官网数字覆盖。
 *
 * 用法：
 *   node scripts/calibrate-usage.mjs --list
 *   node scripts/calibrate-usage.mjs --day 2026-10-27 --cost 0.91
 *   node scripts/calibrate-usage.mjs --day 2026-10-27 --cost 0.91 \
 *        --input 415501 --cache 10293888 --output 50082 --reasoning 0 --calls 74 \
 *        --note "官网 10-27 14:05"
 *
 * 不给 token 明细时（官网悬浮框只显示金额），token 按当天现有结构等比缩放到
 * 金额匹配，并在卡片上标「token 为推算」。
 */
import 'dotenv/config';
import { bridgeCall } from '../server/services/hermes-local.js';
import { loadOverrides, saveOverrides, applyUsageOverrides } from '../server/services/usage-overrides.js';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const numArg = (name) => {
  const v = arg(name);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} 不是数字：${v}`);
  return n;
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

if (has('list')) {
  const ov = loadOverrides();
  const days = Object.keys(ov).sort();
  if (!days.length) console.log('（还没有任何校正）');
  for (const d of days) {
    const o = ov[d];
    console.log(`${d}  官方 ¥${o.official?.cost_cny}  input=${o.official?.input} cache=${o.official?.cache_read} output=${o.official?.output}  ${o.token_estimated ? '[token 推算]' : '[token 官方]'}  ${o.note || ''}`);
  }
  process.exit(0);
}

const day = arg('day', today());
const cost = numArg('cost');
if (cost === null) {
  console.error('缺少 --cost（官方当天花费，人民币）。其它参数见文件头注释。');
  process.exit(1);
}

const usage = await bridgeCall('/local/usage', { cacheTtl: 0, timeout: 25000 });
const row = (usage?.series || []).find((d) => d.day === day);
if (!row) {
  console.error(`网关的 14 天序列里没有 ${day}（只有 ${(usage?.series || []).map((d) => d.day).join(', ')}）`);
  process.exit(1);
}

const baseline = {
  input: Number(row.input) || 0,
  cache_read: Number(row.cache_read) || 0,
  cache_write: Number(row.cache_write) || 0,
  output: Number(row.output) || 0,
  reasoning: Number(row.reasoning) || 0,
  api_calls: Number(row.api_calls) || 0,
  cost_cny: Number(row.cost_cny) || 0,
};

const given = {
  input: numArg('input'),
  cache_read: numArg('cache'),
  cache_write: numArg('write'),
  output: numArg('output'),
  reasoning: numArg('reasoning'),
  api_calls: numArg('calls'),
};
const withTokens = ['input', 'cache_read', 'output'].every((k) => given[k] !== null);

/* 没有 token 明细：按金额比例放大/缩小当天的 token，使金额正好等于官方值。
   只是让"金额 → token"自洽，不能当官网的 token 明细用 */
const k = baseline.cost_cny > 0 ? cost / baseline.cost_cny : 1;
const official = {
  cost_cny: cost,
  input: given.input ?? Math.round(baseline.input * k),
  cache_read: given.cache_read ?? Math.round(baseline.cache_read * k),
  cache_write: given.cache_write ?? Math.round(baseline.cache_write * k),
  output: given.output ?? Math.round(baseline.output * k),
  reasoning: given.reasoning ?? Math.round(baseline.reasoning * k),
  api_calls: given.api_calls ?? baseline.api_calls,
};

const overrides = loadOverrides();
overrides[day] = {
  at: new Date().toISOString(),
  note: arg('note', `官方 ¥${cost}`),
  official,
  baseline,
  token_estimated: !withTokens,
};
saveOverrides(overrides);

const after = applyUsageOverrides(usage).series.find((d) => d.day === day);
console.log(`已校正 ${day}`);
console.log(`  官方：¥${official.cost_cny}  input=${official.input} cache=${official.cache_read} output=${official.output}${withTokens ? '' : '（token 为等比推算）'}`);
console.log(`  校正前：¥${baseline.cost_cny} total=${row.total} billed=${row.billed}`);
console.log(`  展示中：¥${after.cost_cny} total=${after.total} billed=${after.billed}`);
console.log('之后新产生的用量会继续累加在这条基线上。删除 server/data/usage-overrides.json 即可全部还原。');
process.exit(0);
