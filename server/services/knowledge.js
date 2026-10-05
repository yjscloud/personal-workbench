/* ── 知识库正文：Markdown + 一份派生的纯文本 ───────────────────────────
   正文存 Markdown（body），同时存一份剥掉标记的纯文本（body_plain）。

   为什么要多存一份纯文本：搜索和 AI 检索都是在正文上做子串匹配的。
   直接拿 Markdown 源去匹配，用户搜「表」会命中表格分隔行 `|---|---|`、
   搜「号」会命中列表里的 `1.` —— 噪声比命中还多。剥一遍就干净了。

   body_plain 是**派生数据**，任何写 body 的地方都必须一起更新它，
   所以统一收在 withKnowledgeBody() 里，不要在别处手搓。

   这个模块不依赖任何东西（不碰数据库、不碰 store），
   因为 db/repository.js 与 store.js 都要 import 它。 */

/** 正文上限。MEDIUMTEXT 装得下，但接口层仍要有个明确的天花板 */
export const BODY_MAX = 200_000;

/**
 * 知识库的三种条目类型。数组顺序就是界面上的顺序。
 *   sop     —— 固定流程
 *   runbook —— 故障处置
 *   excerpt —— 阅读摘录：从别处读来的东西（原文或 AI 的解读）
 *
 * 归一化必须只有一份实现：以前写的是 `type === 'runbook' ? 'runbook' : 'sop'`，
 * 加第三档之后那种写法会把 excerpt **静默压回 sop**。存储层和接口层各写一遍，
 * 漏掉一处就是一次不报错的数据损坏。
 */
export const KNOWLEDGE_TYPES = ['sop', 'runbook', 'excerpt'];

export const normalizeType = (t) => (KNOWLEDGE_TYPES.includes(t) ? t : 'sop');

/**
 * 旧结构 steps[] → Markdown 的有序列表。
 * 「一行一步」正好就是有序列表，不需要额外的包装。
 * 单步里若带换行，会被压成空格 —— 否则一行多步会把整个列表拆散。
 */
export function stepsToMarkdown(steps) {
  const list = (Array.isArray(steps) ? steps : [])
    .map((s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  if (!list.length) return '';
  return `${list.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
}

/**
 * Markdown → 纯文本。
 *
 * 目标是「不把标记当内容」，不是写一个渲染器的逆运算：剥得干净利落即可，
 * 宁可多留一个没剥掉的符号，也不要把正文吃掉。
 *
 * 唯一刻意保留的是**代码块的内容**（只去掉围栏行）—— Runbook 里命令本身
 * 恰恰是最该被搜到的东西。
 */
export function markdownToPlain(markdown) {
  return String(markdown ?? '')
    .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, ' ') // 围栏行（内容保留）
    .replace(/`([^`\n]*)`/g, '$1') // 行内代码
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1') // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1') // 链接 → 文字
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ' ') // 标题
    .replace(/^[ \t]{0,3}>[ \t]?/gm, ' ') // 引用
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, ' ') // 列表符
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, ' ') // 分隔线
    .replace(/\|/g, ' ') // 表格竖线
    .replace(/(\*\*|__)([^\n]+?)\1/g, '$2') // 粗体
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2') // 斜体 *
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2') // 斜体 _
    .replace(/~~([^\n]+?)~~/g, '$1') // 删除线
    .replace(/<[^>]+>/g, ' ') // 残留的 HTML 标签
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一条条目规范成 { body, body_plain }。幂等：
 * body 已有内容就原样用它，只有旧结构（steps）才做一次转换。
 */
export function withKnowledgeBody(item) {
  if (!item || typeof item !== 'object') return item;
  const existing = typeof item.body === 'string' ? item.body : '';
  const body = (existing.trim() ? existing : stepsToMarkdown(item.steps)).slice(0, BODY_MAX);
  return { ...item, body, body_plain: markdownToPlain(body) };
}

/* ── 文章助手的对话记录 ───────────────────────────────────────────────
   存在条目自己的 ai 列里（JSON），而不是单独一张表。
   这样做是有意的：**删文章时对话跟着一起走** —— 不用写级联删除，
   也不存在"文章没了、助手回答还留在库里"这种中间态。

   记录要限长：对话是只增不减的，不限长早晚会有一条几十万字的。 */

export const AI_LOG_MAX_TURNS = 40;
const AI_TURN_MAX = 20000;

/** 规范助手对话。形状不对的一律丢掉，不让脏数据进库 */
export function sanitizeAiLog(input) {
  const turns = Array.isArray(input?.turns) ? input.turns : [];
  return {
    turns: turns
      .slice(-AI_LOG_MAX_TURNS)
      .map((t) => ({
        role: t?.role === 'user' ? 'user' : 'ai',
        text: String(t?.text ?? '').slice(0, AI_TURN_MAX),
        // task 只对预设动作有值；自由追问是 null
        task: t?.task ? String(t.task).slice(0, 16) : null,
        at: t?.at ? String(t.at).slice(0, 32) : null,
      }))
      .filter((t) => t.text.trim()),
  };
}

/**
 * 就地规范整个数据集的 knowledge，返回「有没有条目变化」。
 *
 * 首次启动把老库的 steps 搬成 body 时靠它判断要不要回写一次；
 * 导入旧备份（replaceAll）与写种子数据也会走这里，于是
 * 「老库 / 旧文件 / 种子」三条路的转换口径是同一个。
 */
export function normalizeKnowledge(data) {
  if (!Array.isArray(data?.knowledge)) return false;
  let changed = false;
  data.knowledge = data.knowledge.map((k) => {
    const next = withKnowledgeBody(k);
    if (next.body !== k.body || next.body_plain !== k.body_plain) changed = true;
    return next;
  });
  return changed;
}
