import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeSlug from 'rehype-slug';
import { Check, Copy } from 'lucide-react';
import { useStore } from '@/lib/store';
import { copyText } from '@/lib/clipboard';
import { normalizeTitle, remarkWikiLinks } from '@/lib/wiki-link';

/* ── Markdown 渲染器（重的那一份）─────────────────────────────────────
   这个文件会 import react-markdown + remark 那一整套，所以**只由
   components/Markdown.tsx 通过懒加载引用**，不要直接 import 它 ——
   直接引会把整包拉进首屏 chunk。 */

/**
 * 代码块 + 复制按钮。
 *
 * 复制的内容在执行时从 DOM 里读（textContent），而不是从 props 里拼 ——
 * 代码块内容是一串嵌套的 React 节点，从 props 还原文本要自己走一遍树，
 * 很容易出现"复制出来的和看到的差一个换行"。
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');

  const onCopy = async () => {
    const ok = await copyText(preRef.current?.textContent ?? '');
    setState(ok ? 'done' : 'fail');
    window.setTimeout(() => setState('idle'), 1600);
  };

  return (
    <div className="group/code relative">
      <pre ref={preRef}>{children}</pre>
      {/* 触屏没有 hover：小屏常显，桌面端悬浮或键盘聚焦才出现 ——
          和工具箱磁贴上的操作条是同一套约定 */}
      <button
        type="button"
        onClick={() => void onCopy()}
        aria-label={state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : '复制代码块'}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-field px-1.5 py-1 text-2xs text-[color:var(--code-ink)] opacity-70 transition-opacity hover:opacity-100 sm:pointer-events-none sm:opacity-0 sm:group-hover/code:pointer-events-auto sm:group-hover/code:opacity-100 sm:focus-visible:pointer-events-auto sm:focus-visible:opacity-100"
        style={{ background: 'rgba(255, 255, 255, 0.12)' }}
      >
        {state === 'done' ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
        {state === 'done' ? '已复制' : state === 'fail' ? '失败' : '复制'}
      </button>
    </div>
  );
}

export default function MarkdownBody({ children }: { children: string }) {
  /* `[[标题]]` 要跳转就得知道标题对应哪一篇，而知识库全量数据本来就在 store 里，
     不必从外面一层层透传下来 */
  const { knowledge } = useStore();
  const byTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const k of knowledge) {
      /* 回收站里的不参与解析：`[[某篇]]` 指到一篇已经删掉的文章上，
         点进去看到的会是"这篇在回收站里" —— 那还不如就当它不存在，
         链接退化成纯文本。恢复之后链接自己就回来了 */
      if (k.deletedAt) continue;
      map.set(normalizeTitle(k.title), k.id);
    }
    return map;
  }, [knowledge]);

  return (
    <ReactMarkdown
      /* remark-gfm：表格 / 任务清单 / 自动链接 —— Runbook 里的「服务-端口对照」
         和「检查清单」正好用得上。
         remark-breaks：把单个换行也当换行。知识库正文是 Markdown，但 AI 助手的
         回答是普通文本拼出来的（`·` 项目符号、一行一条），不加这个，
         那些换行会被 Markdown 合并成一整段。
         remarkWikiLinks：`[[标题]]` → 站内链接。 */
      remarkPlugins={[remarkGfm, remarkBreaks, remarkWikiLinks]}
      /* rehype-slug：给每个标题加 id。没有它整篇没有任何锚点，
         长文（尤其是导入的手册）只能一路滚 —— 目录和"跳到某一节"全靠这个 id。
         id 由 github-slugger 生成，阅读页的目录用的是同一个库
         （见 lib/outline.ts），所以两边算出来必然一致。 */
      rehypePlugins={[rehypeSlug]}
      components={{
        a: ({ node: _node, href, children: label, ...props }) => {
          if (href?.startsWith('kb:')) {
            const id = byTitle.get(normalizeTitle(decodeURIComponent(href.slice(3))));
            /* 链上了就跳过去；没链上渲染成"断链"而不是死链 ——
               标题被改过、或者有重名，都会落到这里，让人看得见比悄悄失效强 */
            return id ? (
              <Link to={`/knowledge/${id}`} className="kb-wikilink">
                {label}
              </Link>
            ) : (
              <span className="kb-wikilink-missing" title="知识库里没有同名的文章">
                {label}
              </span>
            );
          }
          /* 外链一律新开页 + noopener，和站内其它链接的约定一致 */
          return (
            <a {...props} href={href} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          );
        },
        pre: ({ children: code }) => <CodeBlock>{code}</CodeBlock>,
        /* 表格外包一层横向滚动容器：Runbook 里的对照表常有 5~7 列，
           375px 下表格的 min-content 宽度必然超过卡片，
           没有这一层就会把整个卡片撑出横向滚动条（.prose-kb 上只有
           overflow-wrap，管不了表格）。代码块 pre 自带 overflow-x，不用包。 */
        table: ({ children: rows }) => (
          <div className="overflow-x-auto">
            <table>{rows}</table>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
