/* ── 本地 Markdown 文档导入 ───────────────────────────────────────────
   把一个 .md / .txt 文件读成"一条知识库条目"所要的字段。

   和「导入网址」是两条不同的路：那边（services/importer.js）要把 HTML 猜出
   正文，猜错是常态，所以必须过一眼编辑器；这边拿到的是文档原文，**照搬即可**，
   解析只做三件不含判断的事：

     1. 摘掉 front matter —— 它是元数据，不是正文的一部分；
     2. 定一个标题：front matter 的 title → 正文第一个一级标题 → 文件名；
     3. 把 front matter 里的 tags 收成标签。

   刻意**不做**的事（每一条都能少写一段代码，也少一种猜错）：

   - 不猜类型（SOP / Runbook / 摘录）。文件里读不出"这篇要不要动手"，
     所以交给导入弹窗上的类型选择，用户瞄一眼就知道该选哪个。
   - 不往正文里塞一行"来源：xxx.md"。导入就是照搬原文，加注释等于改内容；
     而且文件名也不是地址 —— 那条规则是给「原文在某个网址」用的。
   - 不从正文里剥一份纯文本出来当摘要（服务端的 markdownToPlain 就是干这个的）。
     同一件事写两遍，早晚会给出两个不一样的摘要。
   - 不认识 front matter 里的 type：知识库的类型是这套系统自己的分类，
     不是文档作者的元数据，不该被文件悄悄改掉。

   这个模块不碰网络、不碰 store，纯粹是"文本进、字段出" ——
   于是它可以在浏览器里同步跑完，选完文件立刻就能看到预览。 */

import { fmtBytes } from '@/lib/format';
import { normalizeTitle } from '@/lib/wiki-link';
import type { MarkdownImportDoc } from '@/lib/api';

/** 解析结果 + 界面要用的两样东西（来源文件名、警告） */
export type DraftDoc = {
  /** 来源文件名。入库不用它，只让预览能分清"这段正文是哪个文件" */
  name: string;
  title: string;
  /** 逗号分隔的标签文本，直接绑在输入框上 */
  tags: string;
  /** front matter 里写了才有；留空不影响阅读页，卡片预览由服务端从正文截 */
  summary: string;
  body: string;
  /** 解析里"我没把握"的地方。这套规则是启发式的，不说清楚用户只能自己猜 */
  warnings: string[];
};

export const MARKDOWN_ACCEPT = '.md,.markdown,.mdx,.txt,text/markdown,text/plain';

/** 认得的扩展名。`.txt` 也算：很多笔记导出就是纯文本，而纯文本本身就是合法 Markdown */
const MARKDOWN_EXT = /\.(md|markdown|mdx|txt)$/i;

/**
 * 体积上限。请求体上限是 4MB（server/index.js 的 express.json），
 * 这里留出余量 —— 中文进 JSON 会逐字膨胀成三倍字节，转义再占一份。
 *
 * 超限**不静默截断**：截一半的文档比没导入更糟，用户以为进去了，其实内容缺后半。
 * 所以直接退回去，让他自己决定是拆分还是改写。
 */
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 2_500_000;

/** 正文上限，与服务端 BODY_MAX（services/knowledge.js）同一个数。
 *  这里只用来提前警告：真正截断的是服务端 */
const BODY_MAX = 200_000;

/** front matter 不会很长。找不到收尾行时干脆当它不存在 ——
 *  把整篇正文当 front matter 解析掉的后果，比多留一段元数据严重得多 */
const FRONT_MAX = 8_000;

const FRONT_OPEN = /^---[ \t]*\n/;
const FRONT_CLOSE = /^---[ \t]*(?:\n|$)/;
/** 一级标题行：`# 标题`。行尾那串 `#` 是可选的装饰 */
const H1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/;

type FrontValue = string | string[];

const unquote = (value: string): string => {
  const text = value.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  return quoted ? quoted[2].replace(/\\(["'])/g, '$1') : text;
};

/**
 * 切出 front matter。
 * @returns front —— null 表示没有 front matter（或没找到收尾行）；body 是剩下的正文。
 */
function splitFrontMatter(text: string): { front: string | null; body: string; closed: boolean } {
  if (!FRONT_OPEN.test(text)) return { front: null, body: text, closed: true };

  const rest = text.slice(text.indexOf('\n') + 1);
  // 空 front matter：`---` 下面紧跟着收尾的 `---`
  if (FRONT_CLOSE.test(rest)) return { front: '', body: rest.replace(FRONT_CLOSE, ''), closed: true };

  const close = /\n---[ \t]*(?:\n|$)/.exec(rest);
  if (!close || close.index > FRONT_MAX) return { front: null, body: text, closed: false };
  return { front: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length), closed: true };
}

/**
 * 一小撮 YAML：`key: value`、`key: [a, b]`、`key:` + 若干 `- item`。
 *
 * 刻意不引 YAML 解析器：为几个标签引一个几十 KB 的依赖不划算，而且
 * **认不出来的写法一律跳过**（嵌套、多行、锚点）—— 少一个标签没人会受伤，
 * 猜错一个值却是白白改了用户的文档。
 */
function parseFrontMatter(front: string): Record<string, FrontValue> {
  const out: Record<string, FrontValue> = {};
  let listKey: string | null = null;

  for (const line of front.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = out[listKey];
      if (Array.isArray(list)) list.push(unquote(item[1]));
      continue;
    }

    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    const inline = /^\[(.*)\]$/.exec(value);

    if (!value) {
      /* `key:` 后面空着 —— 可能跟着一串 `- item`。不过也可能是多行字符串
         （`description: |` 那种）：那样这里会存下一个空数组，后面的值全丢。
         这是可接受的取舍，因为被丢掉的只是标签/摘要，正文一字不动。 */
      out[key] = [];
      listKey = key;
    } else if (inline) {
      out[key] = inline[1]
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean);
      listKey = null;
    } else {
      out[key] = unquote(value);
      listKey = null;
    }
  }
  return out;
}

const asText = (value?: FrontValue): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).trim();

/** 标签：接受 `tags: [a, b]`、`tags: a, b` 和一串 `- a`。顺手去掉习惯写法里的 `#` */
function asTags(value?: FrontValue): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  const out: string[] = [];
  for (const item of raw) {
    const tag = String(item ?? '')
      .replace(/^#+/, '')
      .trim()
      .slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 8);
}

/** 解析一个文件（内容已读成文本）。失败不抛错：解析不出东西时，正文照样要导进去 */
export function parseDraft(name: string, raw: string): DraftDoc {
  const warnings: string[] = [];

  /* BOM 必须去掉：它留着会顶在第一个字符上，于是 `^---` 和 `^#` 全都匹配不上，
     front matter 和一级标题就一起失效了 —— 而症状只是"标题变成了文件名" */
  const text = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  const { front, body: afterFront, closed } = splitFrontMatter(text);
  if (!closed) warnings.push('开头是 --- 但找不到结束的那一行，已整篇当正文处理');

  const meta = front === null ? {} : parseFrontMatter(front);
  const lines = afterFront.replace(/^\n+/, '').replace(/[ \t\n]+$/, '').split('\n');

  /* 只认**第一个非空行**上的一级标题。往下找不行：正文第一位是段落、
     第二位是 `# 某章` 是常态，那样会把一个小节的名字提成整篇的标题 */
  let head = 0;
  while (head < lines.length && !lines[head].trim()) head += 1;
  const heading = head < lines.length ? H1.exec(lines[head].trim()) : null;

  const fromFile = name.replace(/\.[^.]+$/, '') || name;
  let title = asText(meta.title) || (heading ? heading[1].trim() : '');
  if (!title) {
    title = fromFile;
    warnings.push('文件里没有标题（front matter 的 title 和 # 一级标题都没有），用文件名顶上，存之前看一眼');
  }

  /* 一级标题和标题字段是同一句话时，把正文里那行摘掉 ——
     不摘的话阅读页会连着出现两遍 */
  if (heading && normalizeTitle(heading[1]) === normalizeTitle(title)) {
    lines.splice(head, 1);
  }

  const body = lines.join('\n').trim();
  if (!body) warnings.push('这个文件里没有正文，导入进去会是一篇空条目');
  else if (body.length > BODY_MAX) {
    warnings.push(`正文约 ${Math.round(body.length / 1000)} 千字，超过 ${BODY_MAX / 1000} 千字上限，保存时会被截断`);
  }

  return {
    name,
    title: title.slice(0, 160),
    tags: asTags(meta.tags).join(', '),
    summary: (asText(meta.summary) || asText(meta.description)).slice(0, 400),
    body,
    warnings,
  };
}

export function isMarkdownFile(file: File): boolean {
  return MARKDOWN_EXT.test(file.name) || /^(text\/markdown|text\/plain)$/i.test(file.type);
}

/**
 * 读一批文件。
 *
 * 读的是**浏览器拿到的那个文件**，服务端不参与 —— 这也就解释了为什么这条路
 * 不需要上传接口：本来就要把正文写进库里，读的人就是写的人。
 *
 * 挑不中的文件不抛错，而是**逐条说明为什么没带上**：一次拖进来十个文件，
 * 其中三个被拒绝时，用户需要知道是哪三个、以及该怎么办。
 */
export async function readDrafts(files: File[]): Promise<{ drafts: DraftDoc[]; skipped: string[] }> {
  const drafts: DraftDoc[] = [];
  const skipped: string[] = [];
  let used = 0;

  for (const file of files) {
    if (!isMarkdownFile(file)) {
      skipped.push(`${file.name}：不是 Markdown / 文本文件`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push(`${file.name}：${fmtBytes(file.size)}，超过单文件 ${fmtBytes(MAX_FILE_BYTES)} 上限`);
      continue;
    }
    if (used + file.size > MAX_TOTAL_BYTES) {
      skipped.push(`${file.name}：这一批已经带了 ${fmtBytes(used)}，再加就超过服务端能收的大小了`);
      continue;
    }

    try {
      const text = await file.text();
      used += file.size;
      drafts.push(parseDraft(file.name, text));
    } catch {
      skipped.push(`${file.name}：读不出来`);
    }
  }

  return { drafts, skipped };
}

/** 界面上的载荷：把预览里改过的标题 / 标签 / 类型定下来交给服务端 */
export function toPayload(docs: DraftDoc[], type: MarkdownImportDoc['type']): MarkdownImportDoc[] {
  return docs.map((doc) => ({
    name: doc.name,
    /* 标题被清空时退回文件名，而不是拦着不让导 —— 空标题服务端会直接拒掉，
       结果是"整批都导不进去"，代价远大于一条标题不够好看 */
    title: doc.title.trim() || doc.name.replace(/\.[^.]+$/, ''),
    type,
    tags: doc.tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8),
    summary: doc.summary,
    body: doc.body,
  }));
}
