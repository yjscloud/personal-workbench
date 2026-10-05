import { Suspense, lazy } from 'react';
import { cls } from '@/lib/format';

/* react-markdown 那一套（含 remark / micromark）体积不小，而它只有两个用处：
   知识库正文与 AI 助手气泡。这里用 lazy 把它切出去，首屏不为它买单
   （vite.config.ts 里另有 manualChunks 把依赖单独成块，日常发版不会让它失效）。

   挂起时的兜底就是**把原文按 pre-wrap 铺出来** —— 和渲染前的观感一致，
   不会先白一下再跳到排版好的样子。

   排版类 .prose-kb 挂在外面这一层：兜底态和渲染态共用同一个容器，
   所以两态之间不会出现"字突然变大/行距突然变松"的跳动。 */
const Body = lazy(() => import('./MarkdownBody'));

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cls('prose-kb', className)}>
      <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
        <Body>{children}</Body>
      </Suspense>
    </div>
  );
}
