/**
 * 官方用量校正。
 *
 * 为什么需要它：网关 state.db 只有「会话×模型×任务」的累计行，没有按天的账本。
 * 桥虽然从 10-27 起改成"每次采样做差、增量记当天"，但**已经过去的日子**（以及
 * 首次部署那天的底数）只能按轮次分摊 —— 长上下文会话会被系统性低估
 * （实测官网 10.76M vs 分摊 4.22M，差 2.55 倍）。分摊值改不回去，而
 * DeepSeek 平台账单是精确的。
 *
 * 所以这里允许"以官方为准"：把某一天的官方金额/token 记进
 * server/data/usage-overrides.json，展示时
 *
 *     当天数值 = 官方值 + (桥当前值 − 校正时的桥值)
 *
 * 后半段是校正之后新产生的用量，继续按采样累加，不会被这次覆盖吃掉。
 * 校正只影响展示，桥和 state.db 一个字节都不动，删掉这个文件就回到原样。
 *
 * 注意 token：DeepSeek 用量页的悬浮框只给**费用**，不给 token 拆分。
 * 只给金额时，token 会按"当天现有结构"等比放大到金额匹配，卡片上标
 * 「人工校正」，不要把它当成官网的 token 明细。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = path.join(ROOT, 'server/data/usage-overrides.json');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function loadOverrides() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveOverrides(map) {
  writeFileSync(FILE, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
}

/** 增量：校正之后桥又长了多少。桥的行被压缩重建时可能为负，按 0 处理 */
const grow = (cur, base) => Math.max(0, n(cur) - n(base));

/**
 * 把校正应用到一份 /local/usage 的返回上。
 * 不修改入参（那份可能被缓存复用），返回新对象。
 */
export function applyUsageOverrides(usage) {
  if (!usage || !Array.isArray(usage.series)) return usage;
  const ov = loadOverrides();
  const days = Object.keys(ov);
  if (!days.length) return usage;

  const series = usage.series.map((d) => {
    const o = ov[d?.day];
    if (!o) return d;
    const off = o.official || {};
    const base = o.baseline || {};

    const input = n(off.input) + grow(d.input, base.input);
    const cache_read = n(off.cache_read) + grow(d.cache_read, base.cache_read);
    const cache_write = n(off.cache_write) + grow(d.cache_write, base.cache_write);
    const output = n(off.output) + grow(d.output, base.output);
    const reasoning = n(off.reasoning) + grow(d.reasoning, base.reasoning);
    const api_calls = n(off.api_calls) + grow(d.api_calls, base.api_calls);
    const cost_cny = n(off.cost_cny) + grow(d.cost_cny, base.cost_cny);

    return {
      ...d,
      input,
      cache_read,
      cache_write,
      output,
      reasoning,
      api_calls,
      cost_cny: Math.round(cost_cny * 100) / 100,
      total: input + cache_read + output + reasoning,
      billed: input + output + reasoning,
      /** 这一天的数字里含官方校正 */
      manual: true,
      /** 校正依据（金额来源 / token 是否推算），界面上要能说清 */
      manual_note: o.note || '',
      manual_token_estimated: Boolean(o.token_estimated),
    };
  });

  /* 桥里 today 就是 series 的末位、yesterday 是倒数第二位，这里保持一致，
     否则同一张卡片上下两处会打架 */
  const today = series[series.length - 1] || usage.today;
  const yesterday = series[series.length - 2] || usage.yesterday;
  return { ...usage, series, today, yesterday, manual_days: days };
}
