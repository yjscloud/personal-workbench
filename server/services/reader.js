import { importFromUrl } from './importer.js';
import { aiConfigured, llmStream } from './llm.js';
import { HUMAN_STYLE } from './writing-style.js';

/* ── 让 AI 读一篇外链文章 ───────────────────────────────────────────────
   热点列表里的每一条只有标题 + 摘要 + 推荐理由。摘要通常两三行，
   而"这篇到底说了什么"往往要读正文才知道 —— 尤其中文以外的内容，
   光看标题根本判断不出值不值得点开。

   所以这个功能的实质是：**抓正文 → 用中文讲一遍**。

   抓取直接复用导入知识库那一套（services/importer.js）：同一个
   domino + turndown 的正文抽取，同一套"连不上 / 被反爬 / 没抽出正文"
   的报错措辞。没有理由再写第二份。

   两处刻意的设计：

   1. **抓不到正文不算失败**。被反爬挡掉、页面靠 JS 渲染、站点连不上，
      这些在热点链接里是常态（实测 openai.com 直接 403）。这时仍然把
      标题、摘要、推荐理由交给模型，但要求它**明确告诉用户正文缺失** ——
      比起"读不了"这个死胡同，用户至少能得到基于摘要的判断；
      而如果模型不声明这一点，它会顺着标题编出一篇看着很像的解读。

   2. **正文在服务端缓存**。一次点击要抓一次网页，而"读完接着追问"
      会连着发好几轮请求。不缓存的话每一轮都重新抓一遍原站：
      慢，而且是对别人服务器的无谓请求。 */

/** 解读用的正文上限。
 *  定 12000 而不是"尽量全塞"：**首 token 的等待时间基本与输入长度成正比**，
 *  而解读要的是"讲清讲了什么"，正文前 1.2 万字足够覆盖绝大多数文章的主干。
 *  实测塞 2 万字时这一等要 60 秒以上，用户只会以为点坏了。 */
const READ_LIMIT = 12000;
/** 全文翻译用的上限。输出长度与输入成正比，得压得更狠，
    否则一次翻译要跑好几分钟、还可能撞上输出长度上限 */
const TRANSLATE_LIMIT = 7000;

/* ── 优先读 AIHOT 的中文译文 ──────────────────────────────────────────
   AIHOT 给每条资讯都建了一个条目页，页面里装的是**已经译好的中文全文**
   （实测：一篇英文稿 1.4 万字全译，IT之家、X 这类中文源的原文也完整在）。
   译文和原文是同一页上的两个视图，用 `.prose` 那个容器区分。

   为什么优先读它，而不是去抓原文：
   1. 这一页的链接大半是英文的，而用户要的是"不用读英文也知道讲了什么"。
      抓原文再让模型翻一遍，等于**把已经做好的事再做一遍**，还慢：
      多一次外网抓取，多几万 token 的输入，首 token 要多等十几秒。
   2. 原文那侧经常根本读不到 —— 反爬（实测 openai.com 一律 403）、
      JS 渲染、Cookie 墙、x.com 直接打不开。AIHOT 那边已经洗好了。
   3. 顺带还少了 SSRF 面：AIHOT 是固定域名，而 `item.link` 是任意外链
      （那条路径仍然保留，只是降级成了兜底）。

   代价是**它依赖第三方页面的结构**，所以两件事必须做：
   · 选择器取不到就抛错、退回抓原文（见 fetchArticle 的 selector 参数）；
   · 译文短于 ZH_MIN_CHARS 也当没拿到 —— 只抽到一个标题不算"读到了"。 */
const AIHOT_ZH_SELECTOR = '.prose';
const ZH_MIN_CHARS = 200;

/** 抓成功缓存半小时；抓失败只记一分钟 —— 网络抖一下不该让人一小时都点不动 */
const OK_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
/** 最多缓存多少篇。热点一轮就上百条，不设界迟早把内存撑起来 */
const CACHE_MAX = 40;

/** 追问时带上的历史轮数。带多了只是白花钱，读文章本身已经占了绝大部分上下文 */
const HISTORY_TURNS = 8;

/* ── 读不到的站点 ─────────────────────────────────────────────────────
   反爬是按站点生效的（实测 openai.com 一律 403），所以这条记在 host 上。

   **但必须两个不同的地址都失败才算数。** 只失败一次就下结论太急：
   那一页可能只是没抽出正文、或者刚才网络抖了一下。而一旦误判，代价是
   这个站点下面所有正常的文章都会被跳过抓取 —— 用一份摘要糊弄过去，
   比多等一次糟得多。宁可保守。

   它只做两件事：在列表上提前标出来、跳过注定失败的那次抓取。
   **不做永久封禁** —— 12 小时过期，而且界面上留了「仍然抓一次」：
   站点随时可能改，把人锁在"永远读不了"里比让他白等一次更糟。 */
const BAD_TTL_MS = 12 * 60 * 60 * 1000;
/** 同一个站点累计几个**不同地址**失败，才算这个站点读不了 */
const BAD_URLS = 2;
const badHosts = new Map();

/** 站点名。取不到（地址不合法）就返回空串，调用方按"不记名"处理 */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 已经攒够失败证据的站点 */
const isBad = (host, now) => {
  const rec = badHosts.get(host);
  return rec && rec.urls.size >= BAD_URLS && now - rec.at < BAD_TTL_MS ? rec : null;
};

/** 当前判为读不了的站点。前端在热点列表上用它标出哪些条目大概率读不动 */
export function unreadableHosts() {
  const now = Date.now();
  const out = [];
  for (const [host, rec] of badHosts) {
    if (now - rec.at > BAD_TTL_MS) {
      badHosts.delete(host);
      continue;
    }
    // 只失败过一次的不报：那还不足以说"这个站点读不了"
    if (rec.urls.size < BAD_URLS) continue;
    out.push({ host, error: rec.error, at: new Date(rec.at).toISOString() });
  }
  return out;
}

const cache = new Map();

/* ── 原文语言 ─────────────────────────────────────────────────────────
   只分「中文 / 英文 / 其他」三档，靠**主导文字系统**判断。

   刻意不去猜具体语种：法语、德语、西班牙语都以拉丁字母为主，靠字符范围
   根本分不开，硬报一个"法语"就是在编。三档里每一档都是能指着字符说清的。

   日文要单独防一手：它汉字与假名混排，只看汉字占比会被误判成中文。 */
function detectLang(text) {
  const s = String(text || '').slice(0, 4000);
  let cjk = 0;
  let latin = 0;
  let kana = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk += 1;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) kana += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin += 1;
    else if (c > 0x2e80) other += 1;
  }
  const words = cjk + latin + kana + other;
  if (!words) return 'unknown';
  // 假名/谚文占比一高就不是中文了，哪怕汉字也不少
  if (kana / words >= 0.15) return 'other';
  if (cjk / words >= 0.3) return 'zh';
  if (latin / words >= 0.5) return 'en';
  return 'other';
}

/**
 * 抓一篇并缓存。返回值一律是 `{ ok, ... }` 形状，**不抛异常** ——
 * 调用方要的是一条能显示给用户的失败原因，不是中断整段流程。
 *
 * `selector` 用来指到页面里已知的正文容器（AIHOT 条目页用得上）。
 * 缓存键仍然是 url 本身：AIHOT 页与原稿是两个不同的地址，不会撞，
 * 而调用方要靠地址取回缓存，键里塞别的就没法查了。
 */
async function fetchArticle(url, force = false, selector = '') {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) return hit;

  const host = hostOf(url);

  /* 这个站点已经攒够失败证据：直接按"读不到"处理，省掉一次注定失败、
     还要白等十几秒的抓取。界面上那个「仍然抓一次」就是带着 force 走这条路。 */
  if (!force && host) {
    const bad = isBad(host, Date.now());
    if (bad) return { ok: false, at: Date.now(), error: `上次这个站点读不了（${bad.error}）`, skipped: true };
  }

  let entry;
  try {
    const page = await importFromUrl(url, selector ? { selector } : undefined);
    entry = { ok: true, at: Date.now(), markdown: page.markdown };
    // 一旦这个站点有任何一个地址抓成功，之前的失败证据就作废
    if (host) badHosts.delete(host);
  } catch (err) {
    entry = { ok: false, at: Date.now(), error: err.message };
    if (host) {
      const rec = badHosts.get(host);
      if (rec && Date.now() - rec.at < BAD_TTL_MS) {
        rec.at = entry.at;
        rec.error = entry.error;
        rec.urls.add(url);
      } else {
        badHosts.set(host, { at: entry.at, error: entry.error, urls: new Set([url]) });
      }
    }
  }

  /* 先删再插：Map 保持插入顺序，这样淘汰的总是最久没被碰过的那条 */
  cache.delete(url);
  cache.set(url, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry;
}

/**
 * 取缓存里的正文。
 *
 * 叫 body 而不是 original：现在读到的可能是 AIHOT 译好的中文版，
 * 也可能才是原稿 —— 取决于这次抓的是哪个地址（见 askAboutNews 的 source）。
 *
 * **只读缓存，绝不发起抓取** —— 所以它没有引入任何新的 SSRF 面：
 * 能拿到的只有"刚刚为了 AI 读而抓过的那一份"。
 *
 * 有它才谈得上在弹窗里直接看正文：那个「去原站」按钮是最难受的去处
 * （反爬、Cookie 墙、广告、x.com 根本打不开），反倒是这份已经洗干净的
 * Markdown 白白躺在缓存里。
 */
export function cachedBody(url) {
  const hit = cache.get(String(url || ''));
  if (!hit || !hit.ok || !hit.markdown) return null;
  return { markdown: hit.markdown, at: new Date(hit.at).toISOString() };
}

const TASKS = {
  read: {
    label: '解读',
    ask: [
      '用中文把这篇讲给我听。要求：',
      '1. 开头两三句话讲清它到底说了什么，不要铺垫；',
      '2. 再讲几件值得知道的事。**用列表还是连着写，由内容决定** ——',
      '   真正并列的才列成表，每条写成一句人话，不要写成"名词：数值"的条目堆；',
      '3. 文中出现的数字、版本号、命令、机构名原样保留；',
      '4. 可以有一句你自己的判断（值不值得看、哪里可疑、哪里没说清），',
      '   但要让人一眼看出那是判断而不是原文明说的；',
      '5. 原文没交代的地方直说「原文没提」，不要替它圆上。',
    ].join('\n'),
  },
  /* 「解读」和「翻译」都是还原型的，没有一个回答"这跟我有什么关系"。
     这一档补的就是那个问题，并且明确交代了读者的身份（自建家庭实验室、
     跑 PVE 和一堆自建服务）—— 不说的话，模型给的"意义"是一句谁都能套的空话。 */
  analysis: {
    label: '分析',
    ask: [
      '分析这篇内容。要求：',
      '1. 它的核心主张是什么，支撑它的依据够不够硬；',
      '2. 哪些地方值得怀疑：数据来源、以偏概全、利益相关（谁在卖什么）、时效性；',
      '3. 对一个自己搭家庭实验室、跑 PVE 和一堆自建服务的工程师来说，这篇意味着什么；',
      '   值得跟进还是可以忽略，如果要动手，第一步做什么；',
      '4. 分不清事实和推测的地方明确标出来，不要替我下结论。',
    ].join('\n'),
  },
  translate: {
    label: '翻译',
    ask: [
      '把这篇原文翻译成中文。要求：',
      '1. 按原文的段落和层级（标题、列表、表格）逐段对应翻译，不要合并、不要改写；',
      '2. 代码块和命令**不要翻译**，原样保留；',
      '3. 专有名词、模型名、产品名保留原文，第一次出现时在括号里给一个中文说法；',
      '4. 只翻译，不要总结，也不要在开头写"以下是翻译"之类的话。',
      '5. 原文的语气保持原样，不要按中文的表达习惯"改顺" —— 那是改写，不是翻译。',
    ].join('\n'),
  },
};

export const READ_TASKS = Object.keys(TASKS);

/** 「翻译」档在正文**已经是中文**时改用的问法。
 *  这时让它"把下面译成中文"，下面本来就是中文 —— 模型要么原样抄一遍
 *  （等于白跑一趟、白花钱），要么按自己的理解重写（那就成了改写，不是翻译）。
 *  换成"把这份译文整理出来"，产出的正是用户要的那份干净中文全文。 */
const TRANSLATE_FROM_ZH = [
  '下面这份正文已经是中文（来源站译好的）。不要重新翻译，请只做整理：',
  '1. 按原文的段落和层级（标题、列表、表格）理成一篇干净的中文全文；',
  '2. 代码块、命令、以及表格里的数字**原样保留**，一个都不要动；',
  '3. 译文里明显别扭或前后矛盾的地方可以顺手理顺，但不要增删信息；',
  '4. 不要总结，也不要在开头写"以下是译文"之类的话。',
].join('\n');

/**
 * 拼 system 提示。
 *
 * 中文输出是这里的硬要求，所以写在第一条：这一页的链接八成是英文的，
 * 而用户要的是"不用读英文也知道讲了什么"。
 */
function systemPrompt({ item, article, limit, picked, source }) {
  const body = String(article?.markdown || '');
  const truncated = body.length > limit;
  const fetched = article?.ok && body.trim();

  /* 正文来自 AIHOT 的译文时，必须让模型知道这件事。
     不说的话有两个后果：它会写"原文写道……"，而手上根本不是外文稿；
     更麻烦的是「翻译」档 —— 让它"把下面这段译成中文"，可下面本来就是中文，
     模型要么原样抄一遍（等于白跑一趟），要么按自己的理解重写（那就成了改写）。 */
  const zhBody = source === 'aihot-zh';

  /* 翻译档**不加**风格要求：翻译要贴着原文走，按自己的风格"润色"就成了改写。
     解读与分析是生成性的，才适用。 */
  const style = picked === 'translate' ? '' : HUMAN_STYLE;

  return [
    '你是「个人工作台 · 今日热点」里的阅读助手：用户点开一篇外链文章，让你替他读一遍。',
    '',
    '规则：',
    '1. **一律用中文回答**。原文不是中文时，把标题译成中文（括号里附上原标题），正文内容也',
    '   译成中文；专有名词、模型名、产品名保留原文写法，第一次出现时用一句中文说清它是什么。',
    '2. 只讲原文写了的内容，不要补充原文没有的信息；自己的判断可以写，但要让人看得出那是判断。',
    '   原文没提的，就说「原文没提」。',
    '3. 数字、版本号、命令、机构名原样保留 —— 那往往是这篇里最值钱的部分。',
    '4. 用 Markdown，简洁，不要客套话和开场白。',
    '',
    style,
    '',
    /* 读的是译文时，把这件事讲在明面上：否则模型会自称在读"原文" */
    zhBody
      ? [
          '注意：下面这份正文是**别人译好的中文版**，不是外文稿。',
          '所以引用时写「文中提到」，不要写「原文写道」；译文里读着别扭或前后矛盾的地方，',
          '可以直接指出来 —— 那是翻译的问题，不是你的发挥。',
        ].join('\n')
      : '',
    '',
    '--- 文章元信息 ---',
    `标题：${item.title || '(无标题)'}`,
    item.source ? `来源：${item.source}` : '',
    item.publishedAt ? `发布时间：${item.publishedAt}` : '',
    item.summary ? `来源站写的摘要：${item.summary}` : '',
    item.reason ? `来源站的推荐理由：${item.reason}` : '',
    '',
    zhBody ? '--- 正文（AIHOT 译好的中文版）---' : '--- 正文 ---',
    fetched ? body.slice(0, limit) : '（没有取到正文）',
    truncated ? `\n\n（正文过长，以上只是前 ${limit} 字，其余已省略）` : '',
    /* 正文缺失必须由模型自己说出来。放在最后是因为它是对上面整段的限定，
       而这类"不要编"的指令离被限定的内容越近越管用。 */
    fetched
      ? ''
      : [
          '',
          `注意：这次没能取到原文正文（${article?.error || '未知原因'}）。你手上只有上面那几行元信息。`,
          '**必须在回答开头用一句话说明这一点**，然后基于摘要与推荐理由给出你的判断，',
          '并明确区分「来源站这么说的」和「你的推测」。绝不要凭标题假装读过正文。',
        ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 问一篇外链文章。emit 收到
 * `{type:'stage'|'meta'|'note'|'thinking'|'delta'|'done'|'error'}`。
 *
 * stage 是"正在做什么"（会互相覆盖），note 是"这次要额外说明的事"（保留），
 * 两者分开是因为抓取失败那句话必须在回答出来之后**仍然看得见**；
 * meta 是这次抓取的结果（原文多长、什么语言），给界面上的标注用。
 */
export async function askAboutNews({ url, zhUrl, item = {}, task, question, history = [], force = false }, emit) {
  if (!aiConfigured()) {
    emit({
      type: 'error',
      message: '没有配置 AI_API_KEY，AI 读用不了 —— 它需要大模型把整篇读下来再讲给你。',
    });
    return;
  }

  const picked = TASKS[task] ? task : 'read';
  const limit = picked === 'translate' ? TRANSLATE_LIMIT : READ_LIMIT;

  /* 先读 AIHOT 已经译好的中文全文，拿不到才退回去抓原稿。
     理由写在文件头部那段注释里 —— 一句话：这一页的链接大半是英文，
     译文已经现成，再抓一遍原文让模型翻一次是把同一件事做两遍。 */
  let article;
  let source = 'original';
  if (zhUrl) {
    emit({ type: 'stage', text: '正在取 AIHOT 的中文译文…' });
    const zh = await fetchArticle(zhUrl, Boolean(force), AIHOT_ZH_SELECTOR);
    if (zh.ok && String(zh.markdown || '').trim().length >= ZH_MIN_CHARS) {
      article = zh;
      source = 'aihot-zh';
    } else {
      /* AIHOT 这次的失败原因不往界面上搬：优先读它是我们主动加的偏好，
         不是用户点名要的东西。真正该报的是"原文也没抓到"那一条。 */
      emit({ type: 'stage', text: 'AIHOT 这边没拿到中文版，改抓原文…' });
    }
  } else {
    emit({ type: 'stage', text: '正在抓取原文…' });
  }
  if (!article) article = await fetchArticle(url, Boolean(force));

  const size = article.ok ? String(article.markdown || '').length : 0;

  /* 语言分档交给前端显示。抓不到正文时**不给判断** —— 标题与摘要常常是
     AIHOT 已经译好的中文，拿它判"正文是中文"必然判错。 */
  emit({
    type: 'meta',
    lang: article.ok ? detectLang(article.markdown) : 'unknown',
    chars: size,
    fetched: Boolean(article.ok && size),
    skipped: Boolean(article.skipped),
    /* 这一趟读的到底是哪一份。界面必须照实标出来，不能一律写"原文" */
    source,
    /* 正文的取回地址：「看正文」和「存进知识库」都按它取。
       AIHOT 那条路上缓存键是 AIHOT 的地址，不是 item.link。 */
    bodyUrl: source === 'aihot-zh' ? zhUrl : url,
  });

  /* userText 挪到抓取之后：它要看 source 才能定 —— 正文已经是中文时，
     「翻译」档得换一套问法（见 TRANSLATE_FROM_ZH） */
  const userText =
    String(question || '').trim() ||
    (picked === 'translate' && source === 'aihot-zh' ? TRANSLATE_FROM_ZH : TASKS[picked].ask);

  if (!article.ok) {
    emit({
      type: 'note',
      text: article.skipped
        ? `跳过了抓取：${article.error}。下面的回答只基于标题与摘要 —— 想再试一次点「仍然抓一次」。`
        : `没能取到原文正文（${article.error}），下面的回答只基于标题与摘要。`,
    });
  }

  /* 把"原文有多长"写进阶段提示。这一等常常几十秒，而一句静止的"正在读…"
     跟卡死在界面上是同一个样子；给出字数，用户至少知道模型正在啃多大一篇。 */
  const sizeText = !size ? '无正文' : size > limit ? `全文 ${size} 字，取前 ${limit}` : `全文 ${size} 字`;
  const verb = picked === 'translate' ? '正在翻译' : picked === 'analysis' ? '正在分析' : '正在读';
  emit({ type: 'stage', text: `${verb}（${sizeText}）…` });

  /* 带上前面几轮：不带的话"那第 3 点呢"这类追问没有任何指代对象，
     而界面上恰恰在引导用户这么问。 */
  const past = (Array.isArray(history) ? history : [])
    .slice(-HISTORY_TURNS)
    .filter((t) => t && String(t.text || '').trim())
    .map((t) => ({
      role: t.role === 'ai' ? 'assistant' : 'user',
      content: String(t.text).slice(0, 4000),
    }));

  let emitted = false;
  try {
    const answer = await llmStream(
      [
        { role: 'system', content: systemPrompt({ item, article, limit, picked, source }) },
        ...past,
        { role: 'user', content: userText },
      ],
      (chunk) => {
        if (chunk.type === 'delta') emitted = true;
        emit(chunk);
      },
      // 读文章要归纳、要对齐原文，比日常问答更该稳一点
      { temperature: 0.2, source: 'news' },
    );
    if (!answer.trim() && !emitted) {
      emit({ type: 'error', message: '模型没有返回内容。' });
      return;
    }
    emit({ type: 'done', reply: answer });
  } catch (err) {
    emit({ type: 'error', message: err.message });
  }
}
