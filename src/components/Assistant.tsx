import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Sparkles, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Badge, Button, Spinner } from './ui';
import { Markdown } from './Markdown';
import { cls } from '@/lib/format';

type Message = { id: string; role: 'user' | 'assistant'; text: string; warning?: string; thinkingChars?: number };

const GREETING = [
  '我是工作台里的运维助手，可以直接读本地数据。',
  '试试问我：现在功耗多少、开启节能模式、ZFS 池满了怎么处理。',
].join('\n');

const SUGGESTIONS = ['现在功耗和温度怎么样？', '开启节能模式', '今天还有哪些待办？', 'ZFS 池满了怎么处理', '本周高优先级任务', '今天的 AI 热点'];

export function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([{ id: 'greeting', role: 'assistant', text: GREETING }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<'rule' | 'llm' | 'local' | null>(null);
  const seq = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 历史只拉一次：之后开合面板直接用内存里的这份 */
  const loadedRef = useRef(false);

  const { refreshAll, notify } = useStore();
  const navigate = useNavigate();

  /* 打开面板时载入历史：有记录就接着上次聊，没有则保留开场白 */
  useEffect(() => {
    if (!open || loadedRef.current) return;
    let alive = true;
    api.assistant.messages
      .list(100)
      .then(({ messages: history }) => {
        loadedRef.current = true;
        if (!alive || !history.length) return;
        setMessages(history.map((m) => ({ id: m.id, role: m.role, text: m.content, warning: m.warning || undefined })));
      })
      .catch(() => {
        loadedRef.current = true; // 历史读不到不影响新对话，静默即可
      });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // 弹窗期间锁住背景滚动，否则滚轮会连带把背后的页面滚走
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    seq.current += 1;
    const userId = `local-u-${seq.current}`;
    const botId = `local-a-${seq.current}`;
    // 提问和空气泡一起放进去，流式内容随后往这个气泡里追加；用 id 定位，不重建整个列表
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text: content },
      { id: botId, role: 'assistant', text: '' },
    ]);
    setInput('');
    setBusy(true);
    // 提问先落库：哪怕这一轮失败，用户问过什么也该留下来
    void api.assistant.messages.save({ role: 'user', content }).catch(() => {});

    const patch = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === botId ? fn(m) : m)));

    // 流式片段本地也攒一份：done 事件里 reply 可能是 null（中途断开时用它表示"保留已流出的内容"），
    // 而 state 更新是异步的，回调里读不到最新文本，所以不能只依赖 state。
    let streamed = '';

    try {
      await api.assistant.askStream(content, (event) => {
        if (event.type === 'thinking') {
          // 推理只当"有进展"的信号：Hermes 的思考是英文的，铺进气泡反而干扰阅读
          patch((m) => ({ ...m, thinkingChars: (m.thinkingChars || 0) + event.text.length }));
          return;
        }
        if (event.type === 'delta') {
          streamed += event.text;
          patch((m) => ({ ...m, text: m.text + event.text }));
          return;
        }
        // done
        const finalText = event.reply ?? streamed;
        patch((m) => ({ ...m, text: finalText, warning: event.warning, thinkingChars: 0 }));
        if (event.engine) setEngine(event.engine);
        for (const action of event.actions || []) {
          if (action.type === 'refresh') void refreshAll();
          if (action.type === 'navigate' && action.to) navigate(action.to);
        }
        // 空回答（模型没返回内容）不落库，免得历史里堆一串空气泡
        if (finalText.trim()) {
          void api.assistant.messages
            .save({ role: 'assistant', content: finalText, engine: event.engine, warning: event.warning })
            .catch(() => {});
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : '助手暂时不可用。';
      patch((m) => ({ ...m, text: m.text || reason, warning: '请求失败', thinkingChars: 0 }));
      // 已经流出去的部分也算这轮的产出，落库时带上失败说明
      void api.assistant.messages
        .save({ role: 'assistant', content: streamed || reason, warning: '请求失败' })
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  /** 清空历史：库里删干净，界面上退回开场白 */
  async function clearHistory() {
    if (!window.confirm('清空全部对话历史？')) return;
    try {
      const { removed } = await api.assistant.messages.clear();
      seq.current = 1;
      setEngine(null);
      setMessages([{ id: 'greeting', role: 'assistant', text: GREETING }]);
      notify(`已清空 ${removed} 条对话记录`);
    } catch (err) {
      notify(err instanceof Error ? err.message : '清空失败', 'crit');
    }
  }

  if (!open) return null;

  // 只有正在流式的那条气泡才显示阶段提示：否则「模型返回空内容」会永远挂着一个转圈
  const streamingId = busy ? (messages[messages.length - 1]?.id ?? null) : null;

  return (
    /* 居中弹窗：flex 居中 + 限高，窄屏靠 max-h 收缩，永远不会顶出视口 */
    <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-4">
      <div className="scrim absolute inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="AI 助手"
        tabIndex={-1}
        className="panel relative z-10 flex h-[min(52rem,calc(100dvh-3rem))] w-full max-w-[68rem] animate-dialog-in flex-col overflow-hidden shadow-pop outline-none"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-field bg-accent-soft text-accent">
              <Sparkles size={14} />
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight">AI 助手</p>
              <p className="text-2xs text-faint">
                {engine === 'llm'
                  ? '接入大模型 · 已注入实时上下文'
                  : engine === 'local'
                    ? '本地执行 · 未调用大模型'
                    : engine === 'rule'
                      ? '本地规则引擎'
                      : '可读待办 / 任务 / 监控 / 知识文库'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void clearHistory()}
              aria-label="清空对话历史"
              title="清空对话历史"
            >
              <Trash2 size={15} />
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭助手">
              <X size={15} />
            </Button>
          </div>
        </header>

        {/* overscroll-contain：消息滚到底部时不要再把滚动接力给背后的页面 */}
        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4">
          {messages.map((m) => (
            <div key={m.id} className={cls('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cls(
                  'max-w-[88%] rounded-xl2 border px-3 py-2 text-[13px] leading-relaxed',
                  m.role === 'user' ? 'border-accent/35 bg-accent-soft text-ink' : 'border-line bg-panel-2 text-ink',
                )}
              >
                {/* 助手的回答按 Markdown 渲染：规则引擎现在直接把知识库正文
                    （本身就是 Markdown）搬进来，大模型的输出本来也带标记。
                    用户自己的提问保持纯文本 —— 那是输入，不该被"渲染"。
                    气泡里的排版走 .prose-kb-compact：容器只有 88% 宽的一小块，
                    用正文那档 19px 的标题会把气泡顶破。 */}
                {m.text ? (
                  m.role === 'user' ? (
                    <p className="whitespace-pre-wrap">{m.text}</p>
                  ) : (
                    <Markdown className="prose-kb-compact">{m.text}</Markdown>
                  )
                ) : null}
                {!m.text && m.id === streamingId ? (
                  <span className="flex items-center gap-1.5 text-faint">
                    <Spinner />
                    {m.thinkingChars ? `正在推理 · 已 ${m.thinkingChars} 字` : '正在思考…'}
                  </span>
                ) : null}
                {m.warning ? <p className="mt-1.5 text-2xs text-warn">{m.warning}</p> : null}
              </div>
            </div>
          ))}
          {busy ? (
            <div className="flex items-center gap-2 px-1 text-xs text-faint">
              <Spinner /> 正在生成回答…
            </div>
          ) : null}
        </div>

        <div className="border-t border-line px-4 py-3">
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                className="rounded-full bg-bg-2 px-2.5 py-1 text-2xs text-muted transition-colors hover:bg-accent-soft hover:text-accent"
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="问点什么，或者让我关掉节能模式…"
              className="field max-h-28 min-h-[2.25rem] flex-1 resize-none py-2 text-[13px]"
            />
            <Button variant="primary" size="icon" className="h-9 w-9" onClick={() => void send(input)} disabled={busy || !input.trim()} aria-label="发送">
              <CornerDownLeft size={15} />
            </Button>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-2xs text-faint">
            <Badge tone="neutral">Enter 发送 · Shift+Enter 换行</Badge>
          </p>
        </div>
      </div>
    </div>
  );
}
