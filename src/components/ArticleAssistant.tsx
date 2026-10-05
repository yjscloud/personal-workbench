import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Eraser, Maximize2, Minimize2, Send, Sparkles, Square } from 'lucide-react';
import { api, type ArticleAiEvent, type KnowledgeAiTurn } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Button, Spinner } from './ui';
import { Markdown } from './Markdown';
import { cls } from '@/lib/format';

/* ── 文章助手 ─────────────────────────────────────────────────────────
   和左上角那个全局助手不是一回事：全局助手看的是工作台的实时状态
   （监控、待办、热点、工位），这一个**只认当前这一篇**。

   三个预设按钮是同一套机制的三段提示词，"读"对应的是「解释」，
   之后可以自由追问 —— 读完一段总结最自然的下一步就是"那第 3 点什么意思"。

   对话**存在条目自己身上**（knowledge_items.ai），所以：
   · 换文章看不到别篇的回答；删条目时它随行一起消失，不需要级联删除；
   · 还没保存的新条目没有 id，这时回答只留在内存里，保存后才会带上。 */

type Turn = KnowledgeAiTurn & {
  id: string;
  /**
   * 推理阶段的正文（只留尾巴）。
   *
   * 它**不是答案**，但必须留着渲染：模型答一道复杂题要 29~64 秒
   * （见 server/services/knowledge-ai.js），这段时间里答案一个字都还没有 ——
   * 面板上如果只剩一个转圈，用户看到的就是一片空白。
   * 推理片段是"它确实在往外吐东西"最直接的证据。
   */
  think?: string;
  error?: boolean;
};

/** 从库里读回来的历史轮次没有 id，补一个只用于 React key */
const withIds = (list: KnowledgeAiTurn[], prefix: string): Turn[] => list.map((t, i) => ({ ...t, id: `${prefix}-${i}` }));

const PRESETS = [
  { task: 'summary', label: '总结' },
  { task: 'analysis', label: '分析' },
  { task: 'explain', label: '解释' },
] as const;

/** 回传的历史轮数。跟服务端的 HISTORY_TURNS 对齐 —— 这里只是少发点，
 *  真正的截断在服务端，不靠前端自觉 */
const HISTORY_TURNS = 8;

export function ArticleAssistant({
  articleId,
  title = '',
  tags = [],
  summary = '',
  body = '',
  initialTurns = [],
  expanded = false,
  onToggleExpand,
  onAppend,
  className,
}: {
  /** null = 还没保存的草稿，回答只留在内存里 */
  articleId: string | null;
  title?: string;
  tags?: string[];
  summary?: string;
  body?: string;
  initialTurns?: KnowledgeAiTurn[];
  expanded?: boolean;
  onToggleExpand?: () => void;
  /**
   * 把一条回答追加到"正在编辑的那篇"的正文末尾。
   *
   * 由父组件实现而不是在这里改文档：正文归编辑页所有，它才知道该往哪写、
   * 怎么写才不破坏撤销栈（见 Knowledge.tsx 的 appendToBody）。
   * 阅读页不传这个 prop，于是那边不出现这颗按钮 —— 那边本来也没有"正在编辑的正文"。
   */
  onAppend?: (text: string) => void;
  className?: string;
}) {
  const { knowledgeApi } = useStore();
  const [turns, setTurns] = useState<Turn[]>(() => withIds(initialTurns, 'h'));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);

  /* 同一份数据放两个地方：state 供渲染，ref 供"这次回答结束后要把什么写进库"——
     流式回调里读不到最新的 state，只能靠 ref */
  const turnsRef = useRef<Turn[]>(turns);
  const commit = (next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
  };
  const update = (updater: (prev: Turn[]) => Turn[]) => commit(updater(turnsRef.current));

  /* 卸载时掐断在飞的请求：否则关掉页面后连接还挂着，
     回调还会往一个已经卸载的组件里 setState */
  useEffect(() => () => abortRef.current?.abort(), []);

  /* ── 流式期间跟着往下滚 ──────────────────────────────────────────────
     原来只在"轮数变化 / busy 变化"时滚一次，于是答案开始逐字往外冒之后
     视图就钉住不动了：用户看到的是回答的头几行，后面新长出来的字全在
     折叠线以下 —— 一屏静止的文字，和"卡住了"没有区别。

     改成"贴着底才跟着滚"：往上翻去读旧内容的用户不会被拽回来
     （每次新内容把滚动条抢走，是最招人烦的一种"关怀"）。 */
  const stickRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  /* 输入框跟着内容长高（上限由 max-h-40 兜住）。
     不这么做，回车换出来的第二行会被"一行"的可视高度裁掉 ——
     用户是"换行成功但看不见"，和换不了没区别。 */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    /* 先归零再量：不归零的话 scrollHeight 只会越量越大，删行也缩不回去 */
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  /** 落库。草稿没有 id，落不了 —— 保存后随条目第一次写入一起带走 */
  function persist(next: Turn[]) {
    if (!articleId) return;
    const clean: KnowledgeAiTurn[] = next.map((t) => ({
      role: t.role,
      text: t.text,
      task: t.task ?? null,
      at: t.at ?? null,
    }));
    void knowledgeApi.patch(articleId, { ai: { turns: clean } });
  }

  async function ask(task?: (typeof PRESETS)[number]['task'], question?: string) {
    if (busy) return;
    const label = task ? PRESETS.find((p) => p.task === task)!.label : String(question || '').trim();
    if (!label) return;

    /* 历史要在本轮 push **之前**取：update 之后 turnsRef 里已经有本轮的问题
       和一条空的回答，一起发过去等于让模型复述我刚问的话。
       只留有内容的轮次 —— 空的回答（还没开始流）不该进上下文。 */
    const history = turnsRef.current
      .filter((t) => t.text.trim())
      .slice(-HISTORY_TURNS)
      .map((t) => ({ role: t.role, text: t.text }));

    const n = ++seq.current;
    const aiId = `ai-${n}`;
    const now = new Date().toISOString();
    setInput('');
    update((prev) => [
      ...prev,
      { id: `u-${n}`, role: 'user', text: label, task: task ?? null, at: now },
      { id: aiId, role: 'ai', text: '', task: task ?? null, at: now },
    ]);
    setBusy(true);
    /* 新问题一律贴底跟读：刚才可能在往上翻旧内容，但既然又问了,
       视线就该落在新回答上 */
    stickRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const patchTurn = (fn: (t: Turn) => Turn) =>
      update((prev) => prev.map((t) => (t.id === aiId ? fn(t) : t)));

    try {
      await api.knowledge.askAi(
        { task, question, article: { title, tags, summary, body }, history },
        (event: ArticleAiEvent) => {
          if (event.type === 'thinking') {
            /* 只留尾巴：一次复杂问题能出几千字推理，全留着既占内存也没人读，
               而面板上只显示最后两行 —— 那两行才是"还在动"的证据 */
            patchTurn((t) => ({ ...t, think: `${t.think ?? ''}${event.text}`.slice(-320) }));
            return;
          }
          if (event.type === 'delta') {
            patchTurn((t) => ({ ...t, text: t.text + event.text }));
            return;
          }
          if (event.type === 'error') {
            // 已经流出半截再报错时保留已流出的内容，只在下面标注原因 ——
            // 把半截答案抹掉换成一句报错，用户反而更看不懂刚才发生了什么
            patchTurn((t) => ({ ...t, error: true, text: t.text || event.message }));
            return;
          }
          patchTurn((t) => ({ ...t, text: event.reply || t.text, at: new Date().toISOString() }));
        },
        controller.signal,
      );
    } catch (err) {
      if (!/abort/i.test(String(err))) {
        patchTurn((t) => ({
          ...t,
          error: true,
          text: t.text || (err instanceof Error ? err.message : '请求失败'),
        }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      persist(turnsRef.current);
    }
  }

  const hasContent = Boolean(body.trim());
  /* 正在流式输出的那一条 = 列表最后一条（ask 里 push 的顺序决定）。
     用它把"半截答案"上的追加按钮收起来 —— 追加一份还在长的东西，
     落到正文里就是一段永远缺尾巴的文字 */
  const streamingId = busy ? turns[turns.length - 1]?.id : null;

  return (
    <div
      className={cls(
        'panel flex flex-col overflow-hidden',
        // 放大时收成一栏居中：满宽 92rem 的一行正文没人读得下去
        expanded && 'mx-auto w-full max-w-[56rem]',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles size={13} aria-hidden className="shrink-0 text-accent" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">文章助手</p>
        {busy ? (
          <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
            <Square size={11} aria-hidden />
            停止
          </Button>
        ) : null}
        {turns.length ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label="清空对话"
            title="清空对话"
            disabled={busy}
            onClick={() => {
              commit([]);
              persist([]);
            }}
          >
            <Eraser size={12} aria-hidden />
          </Button>
        ) : null}
        {onToggleExpand ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleExpand}
            aria-label={expanded ? '收起助手，显示正文' : '放大助手'}
            title={expanded ? '收起助手，显示正文' : '放大助手'}
          >
            {expanded ? <Minimize2 size={12} aria-hidden /> : <Maximize2 size={12} aria-hidden />}
            {expanded ? '显示正文' : '放大'}
          </Button>
        ) : null}
      </div>

      {/* 高度按视口给：写死 32rem 时一条长回答只能看到几行，得在窄栏里反复滚 */}
      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={cls(
          'flex-1 space-y-3.5 overflow-y-auto overscroll-contain px-4 py-3.5',
          expanded ? 'max-h-[calc(100vh-24rem)] min-h-[24rem]' : 'max-h-[calc(100vh-20rem)] min-h-[12rem]',
        )}
      >
        {turns.length === 0 ? (
          <p className="text-2xs leading-relaxed text-faint">
            选一个动作，或者直接问 —— 它只看这一篇。回答会随文章一起存下来，下次打开还在。
          </p>
        ) : null}
        {turns.map((turn) =>
          turn.role === 'user' ? (
            /* whitespace-pre-wrap：回车换行是允许的（见下面输入框的按键规则），
               而 <p> 默认会把换行折成一个空格 —— 多行的提问回显出来就挤成一行，
               用户刚敲的结构当场没了 */
            <p key={turn.id} className="whitespace-pre-wrap break-words text-right text-2xs text-muted">
              {turn.text}
            </p>
          ) : (
            <div key={turn.id} className="text-[13px] leading-relaxed">
              {turn.text ? (
                <Markdown className={expanded ? undefined : 'prose-kb-compact'}>{turn.text}</Markdown>
              ) : busy ? (
                <AnswerProgress think={turn.think} startedAt={turn.at} />
              ) : null}
              {turn.error ? <p className="mt-1.5 text-2xs text-warn">· {turn.text ? '回答中断' : '出错了'}</p> : null}
              {/* 追加动作只在这条回答**已经完整**时出现：
                  还在流的那半截、以及报错留下的残句，追加进正文都是垃圾。
                  另外只有编辑页传了 onAppend（阅读页不传，那边没有"正在编辑的正文"） */}
              {onAppend && turn.text.trim() && !turn.error && turn.id !== streamingId ? (
                <AppendAction text={turn.text} onAppend={onAppend} />
              ) : null}
            </div>
          ),
        )}
      </div>

      <div className="space-y-2.5 border-t border-line px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.task}
              type="button"
              disabled={busy || !hasContent}
              onClick={() => void ask(p.task)}
              className="rounded-full bg-bg-2 px-2.5 py-1 text-2xs text-muted transition-colors hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              {p.label}
            </button>
          ))}
          {!articleId ? (
            <span className="self-center text-2xs text-faint">新条目还没保存，回答暂不落库</span>
          ) : null}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;

              if (e.metaKey || e.ctrlKey) {
                /* ⌘/Ctrl + 回车 = 换行。**必须自己插**：textarea 自带的换行键是
                   Shift + 回车，把修饰键换成 Ctrl/⌘ 之后浏览器什么都不做 ——
                   不拦也不会有换行，只会静默没反应。 */
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart ?? input.length;
                const end = el.selectionEnd ?? start;
                setInput(`${input.slice(0, start)}\n${input.slice(end)}`);
                /* 光标落到刚插进去的那个换行之后。等一帧再设位置：
                   这一帧 DOM 里的 value 还是旧的，此刻设选中区会被浏览器纠正回原位 */
                requestAnimationFrame(() => {
                  el.selectionStart = start + 1;
                  el.selectionEnd = start + 1;
                });
                return;
              }

              /* Shift + 回车是浏览器自带的换行，放它过去 */
              if (e.shiftKey) return;

              e.preventDefault();
              void ask(undefined, input);
            }}
            rows={1}
            disabled={busy || !hasContent}
            placeholder={hasContent ? '追问，例如「第 3 条具体怎么做」' : '这篇文章还没有正文'}
            aria-label="问这篇内容"
            className="field max-h-40 min-h-[2.25rem] resize-none py-2 text-xs leading-relaxed disabled:opacity-60"
          />
          <Button
            variant="primary"
            size="icon"
            disabled={busy || !input.trim() || !hasContent}
            onClick={() => void ask(undefined, input)}
            aria-label="发送"
          >
            <Send size={13} aria-hidden />
          </Button>
        </div>
        <p className="text-2xs text-faint">回车发送 · Ctrl/⌘ + 回车换行</p>
      </div>
    </div>
  );
}

/**
 * 等回答时的占位。
 *
 * **不能只是一行转圈的小灰字。** 模型答一道复杂题要 29~64 秒
 * （见 server/services/knowledge-ai.js），这段时间里答案一个字都还没有；
 * 面板上如果只剩一片空白加一个转圈，用户读到的就是"它没在动"。
 *
 * 所以这一块给三样东西：
 * · 一句话说清现在在干什么；
 * · 已经等了多少秒 —— 等过十几秒以后，这是"它还活着"最实在的凭据；
 * · 推理片段的最后两行。它每隔一小段就变一次，是"确实在往外吐东西"
 *   的直接证据；而且明确标着是"思考"，不会和答案混起来
 *   （服务端也只把推理当进度，不当答案用）。
 */
function AnswerProgress({ think, startedAt }: { think?: string; startedAt?: string | null }) {
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    const t0 = startedAt ? new Date(startedAt).getTime() : Date.now();
    const tick = () => setSecs(Math.max(0, Math.round((Date.now() - t0) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div className="rounded-field border border-line bg-bg-2/60 px-3 py-2.5">
      <p className="flex items-center gap-2 text-xs text-muted">
        <Spinner />
        <span className="min-w-0 flex-1 truncate">{think ? '正在思考，稍后给出回答…' : '正在读这篇文章…'}</span>
        {/* 立等可取的那种回答不该让秒表跳出来打扰，所以头两秒不显示 */}
        {secs >= 2 ? <span className="num shrink-0 text-2xs text-faint">{secs}s</span> : null}
      </p>
      {think ? (
        <p className="mt-2 line-clamp-2 break-words border-t border-line/70 pt-2 text-2xs leading-relaxed text-faint">
          {think}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 一条回答下面的「追加到正文」。
 *
 * 自己拿一小段"已追加"的临时状态，而不是提到父组件里：这个确认只跟这一条
 * 回答有关，放上去要维护"哪一条刚被追加过"，还得记得清掉。卸载时也就自动没了
 * （父组件那边不需要知道谁点了）。
 *
 * 样式沿用助手里那排预设按钮（胶囊 + 悬浮转强调色）——
 * 它们是同一个位置上的同类动作，不该长得像两个体系。
 */
function AppendAction({ text, onAppend }: { text: string; onAppend: (text: string) => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  /* 连着点两次 / 点完就关面板时，别把定时器留在后面 */
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={() => {
        onAppend(text);
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1600);
      }}
      className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-bg-2 px-2.5 py-1 text-2xs text-muted transition-colors hover:bg-accent-soft hover:text-accent"
    >
      <ArrowDownToLine size={11} aria-hidden />
      {done ? '已追加到正文' : '追加到正文'}
    </button>
  );
}
