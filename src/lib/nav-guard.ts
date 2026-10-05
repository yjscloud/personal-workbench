/* ── 未保存内容的离开拦截 ──────────────────────────────────────────────
   编辑器里写了一半的东西不该被一次误触抹掉。这个模块只做一件事：
   在"真的要把人带走"的动作发生之前问一句。

   两种离开得走两条路，因为浏览器只管得住其中一种：

   · **刷新 / 关标签 / 地址栏跳外站** —— 浏览器自己的 beforeunload。
     它只肯给我们一句通用文案，我们唯一能做的是"要不要弹"。

   · **站内跳转（侧栏、正文里的链接、面包屑）** —— App 用的是
     `<BrowserRouter>`，不是 data router，所以用不了 react-router 的
     `useBlocker`（那个要求 createBrowserRouter）。于是自己在 document 上
     捕一次 click，而且捕在**捕获阶段**并 stopPropagation：
     `<Link>` / `<NavLink>` 的 onClick 挂在 React 根容器上（冒泡阶段），
     事件在捕获阶段就被掐断，React 那边连收都收不到 ——
     比去给每一个链接加 onClick 可靠得多，也不会漏掉新增的链接。

   **拦不住的一种：浏览器后退键。** 那条路要接管 history，而 history
   归 react-router 管：它的 popstate 监听在挂载时就装好了，等我们收到
   事件时路由状态已经改完，再 pushState 回去只会让地址栏和界面**对不上**。
   要正确拦住它就得把整个 App 换成 data router —— 那不是顺手该做的事。
   所以后退这条路改由编辑器里的**草稿备份**兜底（见 pages/Knowledge.tsx），
   落到效果上一样是"写的东西不会丢"，只是形式从"拦住你"变成"找得回来"。 */

/** 返回 true = 允许离开；false = 拦下来 */
type LeaveGuard = () => boolean;

let guard: LeaveGuard | null = null;

/** 这个链接点了会离开当前页面吗 */
function navigatesAway(a: HTMLAnchorElement, e: MouseEvent): boolean {
  /* 修饰键和中键：浏览器会开新标签页，当前这一页并没有走 */
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  /* target=_blank / 下载：同上，当前页留下 */
  if (a.target && a.target !== '_self') return false;
  if (a.hasAttribute('download')) return false;

  const href = a.getAttribute('href');
  /* 空 href、页内锚点、mailto/tel 都不是"离开这个页面" */
  if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return false;

  let url: URL;
  try {
    url = new URL(a.href, window.location.href);
  } catch {
    return false;
  }
  /* 站外交给 beforeunload —— 那边判得更准："即将卸载"才问，
     而这里只是点了一个站外链接，用户完全可能点了又按 Esc */
  if (url.origin !== window.location.origin) return false;

  /* 点的是当前这个地址（比如侧栏点当前页）：根本没离开 */
  return url.pathname + url.search !== window.location.pathname + window.location.search;
}

/** 点击闸。只在有 guard 的这段时间里挂着 */
function onDocumentClick(e: MouseEvent) {
  if (!guard || e.defaultPrevented) return;
  const target = e.target as Element | null;
  const a = target?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || !navigatesAway(a, e)) return;
  /* 允许离开就什么都不做，让这次点击照常走；不允许才把事件掐断在这里 */
  if (guard()) return;
  e.preventDefault();
  e.stopPropagation();
}

/**
 * 布防。返回解除函数，直接给 `useEffect` 的返回值。
 *
 * 只认**一个** guard：同时只会有一个编辑器在编辑，多一个就是有 bug，
 * 与其默默叠加不如让后注册的顶掉前者。
 */
export function armLeaveGuard(fn: LeaveGuard): () => void {
  const first = !guard;
  guard = fn;
  if (first) document.addEventListener('click', onDocumentClick, true);

  return () => {
    // 已经被后注册的顶掉了：这里什么都不该做，否则会把别人的闸拆掉
    if (guard !== fn) return;
    guard = null;
    document.removeEventListener('click', onDocumentClick, true);
  };
}

/**
 * 刷新 / 关标签前的最后一道。文案由浏览器决定，改不了，
 * 所以调用方只在"确实有未保存内容"时才布防。
 */
export function armBeforeUnload(): () => void {
  const onUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    // 老浏览器要这个返回值才肯弹
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onUnload);
  return () => window.removeEventListener('beforeunload', onUnload);
}
