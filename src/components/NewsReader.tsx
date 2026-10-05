import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, RefreshCw, Send, Sparkles, Square } from 'lucide-react';
import { api, type NewsItem, type NewsReadMeta, type NewsReadTurn } from '@/lib/api';
import { cls, fmtDateTime, fmtRelative } from '@/lib/format';
import { runNewsRead } from '@/lib/news-read';
import { useStore } from '@/lib/store';
import { Button, Modal, Segmented, Spinner } from './ui';
import { Markdown } from './Markdown';

/* ── 「AI 读」弹窗 ─────────────────────────────────────────────────────
   热点列表里点某一条的「AI 读」后打开。服务端取正文、用中文讲一遍，
   这里是它的壳：流式显示、三个预设、自由追问、看正文、存进知识库。

   正文**优先取 AIHOT 已经译好的中文全文**（读不到才退回抓原稿），
   所以这一页的措辞统一用"正文"，具体是译文还是原文由 meta.source 决定
   —— 一律写"原文"会在读译文的那些条目上说错话。

   对话**只留在浏览器里**（由 News.tsx 按条目 id 存，并折进 localStorage）。
   不落库是有意的：热点条目会轮换，今天的榜下周就换了一轮，把它写进库
   只会攒下一堆没人再看的残留 —— 真值得留的那几篇，走「存进知识库」。

   用弹窗而不是就地展开：解读动辄上千字，塞进列表行里会把整页撑变形。 */

type Turn = NewsReadTurn & { id: string; error?: boolean };

const PRESETS = [
  { task: 'read', label: '解读' },
  { task: 'analysis', label: '分析' },
  { task: 'translate', label: '全文翻译' },
] as const;

/** 原文语言的显示文案。unknown 是"没抓到正文、判不出来"，不显示 */
const LANG_LABEL: Record<NewsReadMeta['lang'], string> = {
  zh: '中文',
  en: '英文',
  other: '非中文',
  unknown: '',
};

const PLAIN = (t: Turn): NewsReadTurn => ({ role: t.role, text: t.text, task: t.task });

/** 一次原文加载的结果。missing = 缓存里没有（没读过，或已被淘汰） */
type Original = { state: 'idle' | 'loading' | 'ready' | 'missing'; text?: string };

/** 存进知识库时选的两件事：存成哪一档、存哪些内容 */
type SaveType = 'sop' | 'runbook' | 'excerpt';
type SaveWhat = 'ai' | 'original' | 'both';

export function NewsReader({
  item,
  initialTurns,
  savedId,
  knownBad,
  onDone,
  onSaved,
  onClose,
}: {
  item: NewsItem;
  /** 这次打开之前已经读出来的对话 */
  initialTurns: NewsReadTurn[];
  /** 已经存进知识库的条目 id。有值就把按钮换成「已存入」 */
  savedId?: string;
  /** 这个站点上次读不了时的原因。有值就提前提示，并给「仍然抓一次」 */
  knownBad?: string;
  /** 一次回答收尾时把整段对话交回去。中途关掉也调用 —— 流出多少算多少 */
  onDone: (turns: NewsReadTurn[]) => void;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const { knowledgeApi, notify } = useStore();
  const [turns, setTurns] = useState<Turn[]>(() => initialTurns.map((t, i) => ({ ...t, id: `h-${i}` })));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  /* 阶段提示只有一句，后一条覆盖前一条 —— 它的职责是"告诉你现在在等什么" */
  const [stage, setStage] = useState<string | null>(null);
  /* 备注是累积的：「没抓到正文」那句在回答出来之后也必须看得见，
     所以它不能和进度提示抢同一个位置 */
  const [notes, setNotes] = useState<string[]>([]);
  /* 模型"想"的时候一个字都不往外吐，界面上就只剩一句静止的提示 ——
     实测这一等能到一分钟，和卡死在观感上完全一样。所以补两个会动的数。 */
  const [thinkChars, setThinkChars] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [meta, setMeta] = useState<NewsReadMeta | null>(null);

  const [view, setView] = useState<'ai' | 'original'>('ai');
  const [original, setOriginal] = useState<Original>({ state: 'idle' });
  const [saveType, setSaveType] = useState<SaveType>('excerpt');
  const [saveWhat, setSaveWhat] = useState<SaveWhat>('ai');

  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const started = useRef(false);
  /** 组件还活着。卸载后回来的响应直接丢掉，不去写一个已经没了的组件 */
  const aliveRef = useRef(true);
  /** 正文请求只允许一份在飞，页签来回切不会连发 */
  const loadingOriginal = useRef(false);
  /* 正文的取回地址。读 AIHOT 译好的中文版时它是 AIHOT 的地址，不是 item.link ——
     服务端缓存是按"实际抓的那个地址"存的，拿原文地址去查必然 404。
     放 ref 而不是 state：onMeta 回调里读不到刚 set 进去的 state。 */
  const bodyUrlRef = useRef<string | null>(null);
  /* 同一份数据两处：state 供渲染，ref 供流式回调读最新值 —— 回调里读不到本帧的 state */
  const turnsRef = useRef<Turn[]>(turns);
  const followRef = useRef(true);

  const commit = (next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
  };
  const update = (updater: (prev: Turn[]) => Turn[]) => commit(updater(turnsRef.current));

  useEffect(
    () => () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    },
    [],
  );

  /* 只跟到底部 —— 用户往上翻看前文时不该被每来一个 token 就拽回去。
     判断放在 onScroll 里（那时滚动区还没长高），effect 里那个高度已经是
     增长之后的，用它算永远是"不在底部"。 */
  useEffect(() => {
    const el = listRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, stage]);

  /* 秒表只在忙的时候走 */
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  /**
   * 取缓存里的那份**正文**。取的是服务端**刚才为 AI 读抓下来的**，没有重新抓原站 ——
   * 原站往往正是最难受的去处（反爬、Cookie 墙、广告），而这份已经洗干净的文字
   * 就躺在缓存里。读 AIHOT 译文时，这份就是译文。
   *
   * **必须等第一次读的 meta 回来之后才能取**：缓存是被那次抓取填上的，
   * 早于它请求只会拿到 404（第一版挂在组件挂载时取，就是这个错）。
   */
  const loadOriginal = useCallback(() => {
    if (loadingOriginal.current) return;
    loadingOriginal.current = true;
    setOriginal({ state: 'loading' });
    void api.news
      .body(bodyUrlRef.current || item.link)
      .then((r) => {
        if (aliveRef.current) setOriginal({ state: 'ready', text: r.markdown });
      })
      .catch(() => {
        if (aliveRef.current) setOriginal({ state: 'missing' });
      })
      .finally(() => {
        loadingOriginal.current = false;
      });
  }, [item.link]);

  async function ask(task?: (typeof PRESETS)[number]['task'], question?: string, opts?: { force?: boolean }) {
    if (busy) return;
    const label = task ? PRESETS.find((p) => p.task === task)!.label : String(question || '').trim();
    if (!label) return;

    const n = ++seq.current;
    const aiId = `ai-${n}`;
    /* 历史要在把这一轮推进去之前取，否则刚问的这句话会重复出现两次 */
    const history = turnsRef.current.map((t) => ({ role: t.role, text: t.text }));

    setInput('');
    setNotes([]);
    setThinkChars(0);
    update((prev) => [
      ...prev,
      { id: `u-${n}`, role: 'user', text: label, task: task ?? null },
      { id: aiId, role: 'ai', text: '', task: task ?? null },
    ]);
    setBusy(true);
    setStage('正在准备…');

    const controller = new AbortController();
    abortRef.current = controller;
    const patchTurn = (fn: (t: Turn) => Turn) => update((prev) => prev.map((t) => (t.id === aiId ? fn(t) : t)));

    try {
      await runNewsRead(
        {
          url: item.link,
          /* AIHOT 条目页里有译好的中文全文，服务端会优先读它；
             读不到（页面结构变了、老条目没这个字段）它自己会退回抓原文，
             所以这里只管把地址递过去，不必在前端判断语言。 */
          zhUrl: item.aihotUrl ?? null,
          item: {
            title: item.title,
            source: item.source,
            summary: item.summary,
            reason: item.reason ?? null,
            publishedAt: item.publishedAt,
          },
          task,
          question,
          history,
          force: opts?.force,
        },
        {
          onStage: setStage,
          onMeta: (m) => {
            setMeta(m);
            /* 取回地址以服务端说的为准：读译文时缓存键是 AIHOT 的地址 */
            bodyUrlRef.current = m.bodyUrl;
            /* 抓到正文了 —— 此刻服务端缓存里才真的有这一份，可以去取了 */
            if (m.fetched) loadOriginal();
          },
          onNote: (text) => setNotes((prev) => (prev.includes(text) ? prev : [...prev, text])),
          onText: (full) => patchTurn((t) => ({ ...t, text: full })),
          onThink: (chars) => {
            setThinkChars(chars);
            if (chars) setStage('正在推理');
          },
          /* 已经流出半截再报错时保留已流出的内容，只在下面标注原因 ——
             把半截答案抹掉换成一句报错，用户反而更看不懂刚才发生了什么 */
          onError: (message) => patchTurn((t) => ({ ...t, error: true, text: t.text || message })),
        },
        controller.signal,
      );
    } catch (err) {
      if (!/abort/i.test(String(err))) {
        patchTurn((t) => ({ ...t, error: true, text: t.text || (err instanceof Error ? err.message : '请求失败') }));
      }
    } finally {
      setBusy(false);
      setStage(null);
      abortRef.current = null;
      onDone(turnsRef.current.map(PLAIN));
    }
  }

  /* 打开即读。已经读过这一段就直接显示，不重复问一遍 ——
     每次打开都重跑一次，等于每次都重新抓一遍原站、再花一次模型的钱。
     站点已知读不了也照跑：服务端会跳过抓取、按摘要讲，反而最快。 */
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!initialTurns.length) void ask('read');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = turns
    .filter((t) => t.role === 'ai' && t.text.trim())
    .map((t) => t.text)
    .join('\n\n---\n\n');
  const canSave = Boolean(answer) && !savedId && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      /* 要存正文时先确保手上有 —— 缓存里有就取，没有就退回只存解读，
         并**明说**退回了：悄悄少存一半，用户下次翻到才发现。 */
      let md = original.state === 'ready' ? (original.text ?? '') : '';
      if (saveWhat !== 'ai' && !md) {
        try {
          const r = await api.news.body(bodyUrlRef.current || item.link);
          md = r.markdown;
          setOriginal({ state: 'ready', text: md });
        } catch {
          setOriginal({ state: 'missing' });
        }
      }
      const wantOriginal = saveWhat !== 'ai';
      const includeOriginal = wantOriginal && Boolean(md);
      if (wantOriginal && !includeOriginal) {
        notify(`缓存里没有${bodyLabel}，这次只存了 AI 解读`, 'warn');
      }

      const body = [
        `> 原文：[${item.title}](${item.link})`,
        `> 来源：${item.source}${item.publishedAt ? ` · ${fmtDateTime(item.publishedAt)}` : ''}`,
        saveWhat !== 'original' ? '> 正文由「AI 读」生成，可能有误，关键结论请回原文核对。' : '',
        '',
        saveWhat !== 'original' && answer ? answer : '',
        includeOriginal ? `## ${bodyLabel}\n\n` + md : '',
      ]
        .filter((s) => s !== '')
        .join('\n');

      const created = await knowledgeApi.add({
        type: saveType,
        title: item.title,
        tags: [...(item.tags || []), 'AI 读'].slice(0, 8),
        summary: item.summary,
        body,
      });
      if (created) onSaved(created.id);
    } finally {
      setSaving(false);
    }
  }

  const langText = meta ? LANG_LABEL[meta.lang] : '';
  const sizeText = meta && meta.chars ? `${meta.chars} 字` : '';
  /* 这一趟读到的正文是哪一份。界面上的措辞全跟着它走 ——
     读的是 AIHOT 译好的中文版时还写"原文"，那是把话说错了。 */
  const bodyLabel = meta?.source === 'aihot-zh' ? 'AIHOT 译文' : '原文';

  return (
    <Modal
      open
      onClose={onClose}
      title="AI 读"
      /* 这一版特意放大：正文 + 追问 + 存库选项三块叠在一起，
         2xl 宽在长段落上会频繁折行，代码块更容易被挤断 */
      width="max-w-4xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-2">
          <span className="text-2xs text-faint">存进知识库</span>
          <Segmented
            size="sm"
            value={saveType}
            onChange={setSaveType}
            options={[
              { value: 'excerpt', label: '摘录' },
              { value: 'sop', label: 'SOP' },
              { value: 'runbook', label: 'Runbook' },
            ]}
          />
          <Segmented
            size="sm"
            value={saveWhat}
            onChange={setSaveWhat}
            options={[
              { value: 'ai', label: '解读' },
              { value: 'original', label: bodyLabel },
              { value: 'both', label: '两者' },
            ]}
          />
          <span className="ml-auto flex items-center gap-2">
            {busy && view === 'ai' ? (
              <Button variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                <Square size={11} aria-hidden />
                停止
              </Button>
            ) : null}
            <Button
              variant="soft"
              size="sm"
              onClick={() => void save()}
              disabled={!canSave}
              title={savedId ? '已经存进知识库了' : answer ? '按左边的选择存入知识库' : '等读完再存'}
            >
              <BookOpen size={13} aria-hidden />
              {savedId ? '已存入知识库' : saving ? '保存中…' : '存入'}
            </Button>
            <Button variant="soft" size="sm" onClick={onClose}>
              关闭
            </Button>
          </span>
        </div>
      }
    >
      <div>
        <p className="text-[13px] font-medium leading-snug text-ink">{item.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-faint">
          <span className="num">{fmtRelative(item.publishedAt)}</span>
          <span className="truncate">{item.source}</span>
          {/* 原文语言是这页唯一"需要解释"的信息：翻译是悄悄发生的，
              不标一句，用户无法确认模型是在翻译还是在复述自己的摘要 */}
          {langText ? (
            <span className={cls('rounded-full px-1.5 py-0.5', meta?.lang === 'zh' ? 'bg-bg-2' : 'bg-accent-soft text-accent')}>
              {bodyLabel}：{langText}
            </span>
          ) : null}
          {sizeText ? <span className="num">{sizeText}</span> : null}
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
          >
            去原站
          </a>
        </p>
      </div>

      <Segmented
        size="sm"
        value={view}
        onChange={(v) => {
          setView(v);
          /* 切过去时还没拿到就再试一次：可能刚才那轮没抓到，
             而后面的某轮补上了，缓存里于是有了 */
          if (v === 'original' && original.state !== 'ready') loadOriginal();
        }}
        options={[
          { value: 'ai', label: 'AI 解读' },
          { value: 'original', label: bodyLabel },
        ]}
      />

      {view === 'original' ? (
        <OriginalPane state={original} onRetry={loadOriginal} />
      ) : (
        <>
          {/* 抓不到正文是常态（被反爬挡、页面靠 JS 渲染、站点连不上），
              那句话必须留着 —— 否则一条基于摘要编出来的解读会被当成读过正文的结论 */}
          {notes.length ? (
            <div className="rounded-field border border-warn/35 px-3 py-2">
              {notes.map((n) => (
                <p key={n} className="text-2xs leading-relaxed text-warn">
                  · {n}
                </p>
              ))}
              {knownBad !== undefined && meta?.skipped ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void ask('read', undefined, { force: true })}
                  className="mt-1.5 inline-flex items-center gap-1 text-2xs font-medium text-accent transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  <RefreshCw size={11} aria-hidden />
                  仍然抓一次
                </button>
              ) : null}
            </div>
          ) : knownBad && !meta ? (
            <p className="rounded-field border border-warn/35 px-3 py-2 text-2xs leading-relaxed text-warn">
              · 这个站点上次读不了（{knownBad}），这次会直接跳过抓取、按摘要讲。
            </p>
          ) : null}

          <div
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="max-h-[58vh] min-h-[12rem] space-y-3.5 overflow-y-auto overscroll-contain rounded-field bg-bg-2 px-4 py-3.5"
          >
            {turns.map((turn) =>
              turn.role === 'user' ? (
                <p key={turn.id} className="text-right text-2xs text-muted">
                  {turn.text}
                </p>
              ) : (
                <div key={turn.id} className="text-[13px] leading-relaxed">
                  {turn.text ? <Markdown className="prose-kb-compact">{turn.text}</Markdown> : null}
                  {turn.error ? (
                    <p className="mt-1.5 text-2xs text-warn">· {turn.text ? '回答中断' : '出错了'}</p>
                  ) : null}
                </div>
              ),
            )}

            {/* 忙的时候就一直挂着这一行，包括正文已经开始流的时候 ——
                没有它，模型"想"的那一分钟里界面上没有任何东西在动 */}
            {busy ? (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-faint" role="status">
                <Spinner />
                <span>{stage ?? '正在输出'}</span>
                {thinkChars ? <span className="num">· 已推理 {thinkChars} 字</span> : null}
                {elapsed >= 5 ? <span className="num">· 已等 {elapsed} 秒</span> : null}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.task}
                type="button"
                disabled={busy}
                onClick={() => void ask(p.task)}
                className="rounded-full bg-bg-2 px-2.5 py-1 text-2xs text-muted transition-colors hover:bg-accent-soft hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
              >
                {p.label}
              </button>
            ))}
            <span className="self-center text-2xs text-faint">
              正文优先取 AIHOT 已译好的中文版，取不到才去抓原文；术语、命令、版本号保留原样。
              首次读一篇要等模型把全文过一遍，通常十几秒到一分钟 —— 期间可以先写追问
            </span>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(undefined, input);
                }
              }}
              rows={2}
              /* 读一篇要几十秒，这期间**不禁用输入框** —— 等待时既没有进度
                 又敲不进字，只能用"坏了"来理解它。让他先把想问的写下来。 */
              placeholder="追问，例如「第 2 条那个参数是什么意思」"
              aria-label="就这篇追问"
              className="field resize-none text-xs leading-relaxed"
            />
            <Button
              variant="primary"
              size="icon"
              disabled={busy || !input.trim()}
              title={busy ? '读完这一轮再发' : '发送'}
              onClick={() => void ask(undefined, input)}
              aria-label="发送"
            >
              <Send size={13} aria-hidden />
            </Button>
          </div>

          <p className="flex items-center gap-1.5 text-2xs text-faint">
            <Sparkles size={11} aria-hidden className="shrink-0 text-accent" />
            回答由大模型读原文后生成，可能有误，关键决定请回原文核对。
          </p>
        </>
      )}
    </Modal>
  );
}

/** 正文面板：渲染的是服务端缓存里那份洗干净的文字，不是原站的页面。
 *  措辞用中性的"正文" —— 它可能是 AIHOT 的译文，也可能是原稿。 */
function OriginalPane({ state, onRetry }: { state: Original; onRetry: () => void }) {
  /* idle 也当"还没回来"：初始那一帧请求还没发出去，不该先说"不在缓存里" */
  if (state.state === 'loading' || state.state === 'idle') {
    return (
      <p className="flex items-center gap-1.5 rounded-field bg-bg-2 px-4 py-3 text-2xs text-faint">
        <Spinner />
        正在取正文…
      </p>
    );
  }
  if (state.state !== 'ready' || !state.text) {
    return (
      <div className="rounded-field bg-bg-2 px-4 py-3">
        <p className="text-2xs leading-relaxed text-faint">
          缓存里没有这一份：它只在"读过这一条"之后才有，而且服务器重启会清空。
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 inline-flex items-center gap-1 text-2xs font-medium text-accent transition-opacity hover:opacity-80"
        >
          <RefreshCw size={11} aria-hidden />
          再取一次
        </button>
      </div>
    );
  }
  return (
    <div className="max-h-[58vh] min-h-[12rem] overflow-y-auto overscroll-contain rounded-field bg-bg-2 px-4 py-3.5">
      <p className="mb-2 text-2xs leading-relaxed text-faint">
        这是为 AI 读而抓下来的正文（已去掉导航与广告）。图片仍是外链，原站防盗链或删图时会失效。
      </p>
      <Markdown className="prose-kb-compact">{state.text}</Markdown>
    </div>
  );
}
