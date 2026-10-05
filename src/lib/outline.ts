import GithubSlugger from 'github-slugger';

/* ── 从 Markdown 里摘标题 ──────────────────────────────────────────────
   长文（尤其是从网址导入的手册）没有锚点就只能一路滚。目录需要两样东西：
   标题的层级与文字，以及**和渲染端完全一致**的 id —— 否则点目录跳不过去。

   id 由 github-slugger 算，和 rehype-slug 用的是同一个库，规则自然一致。
   但有一处很容易错：rehype-slug 对**整篇所有标题**共用一个 slugger，
   重名才依次得到 -1、-2。所以下面即使不打算把某一级列进目录，
   也要把它喂给 slugger —— 漏喂一个，后面所有重名标题的 id 就整体错位。 */

export type OutlineItem = { level: number; text: string; id: string };

/** 代码块围栏。围栏里的 `# 注释` 不是标题 */
const FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * 摘出标题。
 *
 * @param min/max 要收进目录的层级。默认只收 `##` 与 `###`：
 *   `h1` 通常是文章标题本身（目录里放它等于重复一遍页头），
 *   更深的两级在目录里缩进到看不清层级了。
 */
export function outlineOf(markdown: string, min = 2, max = 3): OutlineItem[] {
  const slugger = new GithubSlugger();
  const out: OutlineItem[] = [];
  let inFence = false;

  for (const line of String(markdown || '').split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;

    const level = m[1].length;
    const text = plainOf(m[2]);
    /* 不管要不要列进目录，id 都得先占掉 —— 见文件头那条说明 */
    const id = slugger.slug(text);
    if (!text || level < min || level > max) continue;
    out.push({ level, text, id });
  }
  return out;
}

/**
 * 标题文字里的 Markdown 记号剥掉。
 *
 * 和正文那份 markdownToPlain 不是一回事：这里只在意"目录里这一行看着干净"，
 * 剥不干净顶多难看，剥过头才会让人认不出是哪一节。所以只处理最常见的几种，
 * 并且保留链接的**文字**（`[名字](url)` 在目录里应该显示"名字"）。
 */
function plainOf(raw: string): string {
  return String(raw)
    .replace(/\s+#+\s*$/, '') // 闭合式 ATX 结尾的 #
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1') // 链接 → 文字
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1') // 图片 → alt
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/(\*\*|__)([^\n]+?)\1/g, '$2') // 粗体
    .replace(/(\*|_)([^\n]+?)\1/g, '$2') // 斜体
    .replace(/~~([^\n]+?)~~/g, '$1') // 删除线
    .trim();
}
