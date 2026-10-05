import { api, type NewsReadEvent, type NewsReadMeta } from '@/lib/api';

/* ── 跑一次「AI 读」───────────────────────────────────────────────────
   有两个入口：弹窗里点一次，以及批量读未读时连着跑 N 条。

   两边对事件流的处理**必须一致**：stage 覆盖、note 累积、delta 累加、
   error 保留已经流出的半截。收在这一个函数里，是因为这类"翻译协议"的
   代码写两遍，迟早有一份修了另一份没修 —— 而症状会是"批量读的结果和
   点开看的不一样"，最难查的那种。

   UI 的进度显示仍然由调用方决定（那是各入口自己的事），这里只负责
   把协议翻成几个明确的回调。 */

export type ReadRequest = {
  url: string;
  /** AIHOT 条目页（含译好的中文全文）。服务端优先读它，读不到才抓 url */
  zhUrl?: string | null;
  item: { title: string; source: string; summary: string; reason?: string | null; publishedAt?: string };
  task?: 'read' | 'analysis' | 'translate';
  question?: string;
  history?: { role: 'user' | 'ai'; text: string }[];
  force?: boolean;
};

export type ReadHooks = {
  /** 当前在等什么。null = 正文已经开始流了，进度由正文自己体现 */
  onStage: (text: string | null) => void;
  /** 这次抓取的结果：原文多长、什么语言 */
  onMeta: (meta: NewsReadMeta) => void;
  /** 要一直留着给用户看的说明（抓不到正文之类） */
  onNote: (text: string) => void;
  /** **累积后的全文**，不是增量 —— 免得每个调用方各写一遍字符串拼接 */
  onText: (full: string) => void;
  /** 模型已推理多少字，用来证明"它还活着" */
  onThink: (chars: number) => void;
  /** 出错了。已经流出的内容由调用方自己决定留不留 */
  onError: (message: string) => void;
};

/**
 * @returns 完整答复（可能与 onText 收到的最后一次相同）
 */
export async function runNewsRead(req: ReadRequest, hooks: ReadHooks, signal: AbortSignal): Promise<string> {
  let answer = '';
  let think = 0;

  await api.news.read(
    req,
    (event: NewsReadEvent) => {
      if (event.type === 'stage') {
        hooks.onStage(event.text);
        return;
      }
      if (event.type === 'meta') {
        hooks.onMeta(event);
        return;
      }
      if (event.type === 'note') {
        hooks.onNote(event.text);
        return;
      }
      if (event.type === 'thinking') {
        hooks.onStage('正在推理');
        think += event.text.length;
        hooks.onThink(think);
        return;
      }
      if (event.type === 'delta') {
        hooks.onStage(null);
        think = 0;
        hooks.onThink(0);
        answer += event.text;
        hooks.onText(answer);
        return;
      }
      if (event.type === 'error') {
        hooks.onError(event.message);
        return;
      }
      // done：以它为准（它才是拼好的完整答复）
      if (event.reply) {
        answer = event.reply;
        hooks.onText(answer);
      }
    },
    signal,
  );

  return answer;
}
