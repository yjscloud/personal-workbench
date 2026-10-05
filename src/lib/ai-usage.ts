import { useEffect, useState } from 'react';
import { api, type AiUsage, type AiUsageCounter } from '@/lib/api';

/** prompt + completion。这里到处都要用，收一个函数免得每处各写一遍加法 */
export const usedTokens = (c: AiUsageCounter) => c.prompt + c.completion;

/**
 * 上万的数只留一位小数。顶栏一格和卡片一列都放不下完整数字，
 * 而精确到个位在这里没有意义 —— 要看精确值就看悬停的明细。
 */
export function fmtTokens(n: number) {
  if (n >= 100_000) return `${Math.round(n / 10_000)} 万`;
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
  return [
    `今天 ${usage.today.calls} 次 · ${usedTokens(usage.today).toLocaleString('zh-CN')} tokens`,
    `累计 ${usage.total.calls} 次 · ${usedTokens(usage.total).toLocaleString('zh-CN')} tokens`,
    '',
    ...Object.entries(usage.sources)
      .sort((a, b) => usedTokens(b[1]) - usedTokens(a[1]))
      .map(([k, v]) => `${usage.labels[k] ?? k}：${v.calls} 次 · ${usedTokens(v).toLocaleString('zh-CN')}`),
  ].join('\n');
}
