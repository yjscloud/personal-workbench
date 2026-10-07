import { useEffect, useState } from 'react';
import { api, type AiUsage, type AiUsageCounter } from '@/lib/api';

/** prompt + completion。这里到处都要用，收一个函数免得每处各写一遍加法 */
export const usedTokens = (c: AiUsageCounter) => c.prompt + c.completion;

/**
 * 网关记账里那几个来源键 → 中文。
 * 键是网关给的（cron / api_server / cli / weixin），不是我们定义的，
 * 所以遇到没见过的键要原样显示，不能吞掉。
 */
const GATEWAY_SOURCE_LABELS: Record<string, string> = {
  cron: '员工定时任务',
  api_server: '接口调用（含面板自己）',
  cli: '命令行',
  weixin: '微信',
};

export const gatewaySourceLabel = (key: string) => GATEWAY_SOURCE_LABELS[key] ?? key;

/**
 * 今日消耗的 token 数。
 *
 * **优先用网关的记账**：面板自己只记得到"我调了几次模型"，而智能办公室里
 * 那几位（定时任务、巡检、采集）的消耗全在网关那边。不并进来，这个数漏掉大头。
 *
 * 为什么不是相加：面板自己的调用走的就是网关的 /v1 接口，在它账上归到
 * api_server 那一档 —— 网关那个数是**超集**，相加会把它算两遍。
 * 所以是"有就用它、没有才退回本地记账"。
 */
export const todayTokens = (usage: AiUsage) =>
  usage.gateway ? usage.gateway.today.total : usedTokens(usage.today);

/**
 * 上万的数只留一位小数。顶栏一格和卡片一列都放不下完整数字，
 * 而精确到个位在这里没有意义 —— 要看精确值就看悬停的明细。
 *
 * 十万以上仍保留一位小数（"16.6 万"而不是"17 万"）：并进员工消耗之后
 * 这个数天天是六位数，直接取整会把"今天比昨天多了一点"这件事抹平。
 * 到百万级才收成整数。
 */
export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${Math.round(n / 10_000)} 万`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  return n.toLocaleString('zh-CN');
}

/**
 * 全站 token 用量。顶栏和监控页的卡片都用它 ——
 * 两处各自写一遍轮询，迟早有一处忘了 visibilitychange 那一手。
 *
 * 默认 30 秒拉一次而不是跟监控那样几秒一跳：这个数只有跑过 AI 才会变，
 * 而跑一次至少几十秒，更密没有意义。但**切回窗口时会立刻对一次** ——
 * 否则刚问完助手回到页面，看到的还是 30 秒前的旧数。
 */
export function useAiUsage(intervalMs = 30000): AiUsage | null {
  const [usage, setUsage] = useState<AiUsage | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void api.ai
        .usage()
        .then((u) => {
          if (alive) setUsage(u);
        })
        .catch(() => {
          /* 拿不到就先不显示：这是附加信息，不该为它弹错误或打断页面 */
        });
    };
    load();
    const timer = window.setInterval(load, intervalMs);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  return usage;
}

/** 悬停明细：顶栏/卡片都只能放一个数，而"今天多少、花在哪"才是真正要看的 */
export function usageTip(usage: AiUsage) {
  const g = usage.gateway;
  const n = (v: number) => v.toLocaleString('zh-CN');
  const local = [
    `面板自身：今天 ${usage.today.calls} 次 · ${n(usedTokens(usage.today))} tokens`,
    `累计 ${usage.total.calls} 次 · ${n(usedTokens(usage.total))} tokens`,
    ...Object.entries(usage.sources)
      .sort((a, b) => usedTokens(b[1]) - usedTokens(a[1]))
      .map(([k, v]) => `· ${usage.labels[k] ?? k}：${v.calls} 次 · ${n(usedTokens(v))}`),
  ];
  if (!g) {
    return ['今日消耗 Token（面板本地记账：网关那份还没读到）', ...local].join('\n');
  }
  const split = Object.entries(g.today.sources)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${gatewaySourceLabel(k)} ${n(v)}`)
    .join(' · ');
  const head = [
    `今日 ${n(g.today.total)} tokens · ${g.today.api_calls} 次调用`,
    '（Hermes 网关记账，含智能办公室里的员工消耗）',
    `预算 ${g.budget_label} · 昨日 ${n(g.yesterday.total)}`,
    `输入 ${n(g.today.input)} · 输出 ${n(g.today.output)} · 缓存命中 ${n(g.today.cache_read)}`,
    g.models.length ? `模型 ${g.models.join(' / ')}` : null,
    split ? `来源 ${split}` : null,
  ].filter((s): s is string => Boolean(s));
  /* 本地那份只是参考：面板走的就是网关的接口，它的用量已经算在上面那笔里了，
     单独列出来是因为"面板自己调了多少"仍然是有用的（看得出是不是它在花钱） */
  const tail = ['', '面板自身（已含在上面那笔里，不另加）：', ...local];
  if (g.error) tail.push('', `⚠️ 上一次读网关用量失败：${g.error}`);
  return [...head, ...tail].join('\n');
}
