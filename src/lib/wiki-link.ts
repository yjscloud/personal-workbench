/* ── `[[文章标题]]` 双链 ──────────────────────────────────────────────
   知识图谱的一半边就来自这里（另一半是共用标签）。

   为什么用标题而不是 id：写的时候没人记得住 kb_03 是什么。
   代价是**标题得唯一** —— 重名时只有第一篇能被链上，另一篇会显示成
   "没有找到同名文章"。这是刻意的取舍：宁可明着告诉你没链上，
   也不要偷偷链到错的那一篇。 */

/** 标题归一化：只留字母、数字、中日韩文字，用来比较"这两个标题是不是同一个"。
 *  和 server/services/importer.js 里判断标题重复用的是同一套口径。 */
export function normalizeTitle(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

/** 把一段文本按 `[[标题]]` 切成 text / link 节点 */
function splitText(value: string): MdNode[] {
  const out: MdNode[] = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    const title = m[1].trim();
    out.push({
      type: 'link',
      url: `kb:${encodeURIComponent(title)}`,
      children: [{ type: 'text', value: title }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

/**
 * 递归替换文本节点。
 * 只处理 `text` 节点 —— 代码块（`code`）和行内代码（`inlineCode`）没有 children，
 * 于是 `[[x]]` 写在代码里会原样保留，这正是想要的。
 */
function walk(node: MdNode) {
  if (!Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value && child.value.includes('[[')) {
      next.push(...splitText(child.value));
    } else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

/** remark 插件：把 `[[标题]]` 变成 url 为 `kb:<标题>` 的链接节点 */
export function remarkWikiLinks() {
  return (tree: MdNode) => {
    walk(tree);
  };
}

/** 一段正文里出现的所有双链目标（标题原文，未归一化） */
export function wikiTargets(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(body || '')))) out.push(m[1].trim());
  return out;
}

export type Backlink<T> = { item: T; snippet: string };

/**
 * 反向链接：哪些条目在正文里链到了这一篇。
 *
 * 按**标题**比，和正向双链、图谱完全同一套口径（都是 normalizeTitle）——
 * 三处口径一旦不一致，就会出现"图上连着、列表里说没有"这种自相矛盾。
 *
 * 这里直接扫纯文本，不走 Markdown AST：图谱就是这么扫的。代价是写在
 * 代码块里的 `[[x]]` 也会算一条边（渲染时它是字面量）；宁可和图谱一致，
 * 也不要两处对"什么算一条链"给出不同答案。
 */
export function findBacklinks<T extends { id: string; title: string; body?: string | null }>(
  items: T[],
  target: { id: string; title: string },
): Backlink<T>[] {
  const want = normalizeTitle(target.title);
  if (!want) return [];

  const out: Backlink<T>[] = [];
  for (const it of items) {
    if (it.id === target.id) continue; // 链自己不算，是笔误
    const body = String(it.body || '');
    const line = body.split('\n').find((l) => wikiTargets(l).some((t) => normalizeTitle(t) === want));
    if (line === undefined) continue;
    out.push({
      item: it,
      /* 摘出链过去的那一句，好让人判断"我什么时候会需要它"。
         顺手剥掉行首的 Markdown 记号（#、>、-、缩进），
         留着的话这段小字看起来像乱码 */
      snippet: line
        .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
        .replace(/^[\s>#*+-]+/, '')
        .trim()
        .slice(0, 120),
    });
  }
  return out;
}
