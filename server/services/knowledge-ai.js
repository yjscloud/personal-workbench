import { aiConfigured, llmStream } from './llm.js';
import { HUMAN_STYLE } from './writing-style.js';

/* ── 文章助手：读 / 分析 / 总结 ───────────────────────────────────────
   这个助手**只认当前这一篇**，和左上角那个全局助手不是一回事：
   全局助手看的是工作台的实时状态（监控、待办、热点、工位），
   文章助手看的是你正在读、或正在写的那一篇。

   三个预设任务是同一套机制的三段提示词，"读"对应的是"解释"：
     · 总结 —— 它讲了什么
     · 分析 —— 它靠不靠得住、对我们意味着什么
     · 解释 —— 假设我不懂这个领域，把它讲明白

   正文整篇塞进 system 提示。长文会吃掉不少 token，但这是"读文章"绕不开
   的代价；真要遇到超长文（比如导入的整本手册），按下面的上限截断，
   并且**明确告诉模型"后面省略了"** —— 悄悄截一半，模型会给出看着有道理
   却是错的结论。 */

/** 塞给模型的正文上限 */
const BODY_LIMIT = 24000;

/** 追问时带上的历史轮数。
 *  带多了只是白花钱 —— 整篇正文已经吃掉大部分上下文，而「那第 3 条具体怎么做」
 *  这类追问要的指代对象就在最近几轮里。 */
const HISTORY_TURNS = 8;

const TASKS = {
  summary: {
    label: '总结',
    ask: [
      '把这篇内容总结给我。要求：',
      '1. 开头两三句话讲清它到底说了什么，不要铺垫；',
      '2. 再给 3–6 条关键点：**真正并列的才列成表**，每条写成一句人话，',
      '   不要写成"名词：数值"的条目堆；',
      '3. 文中出现的具体数字、版本号、命令，原样保留 —— 那往往是这篇东西最值钱的部分；',
      '4. 只还原，不评价。',
    ].join('\n'),
  },
  analysis: {
    label: '分析',
    ask: [
      '分析这篇内容。要求：',
      '1. 它的核心主张是什么，支撑它的依据够不够硬；',
      '2. 有哪些地方值得怀疑：数据来源、以偏概全、利益相关、时效性；',
      '3. 有没有和常识、或其他常见说法冲突的地方；',
      '4. 对一个管理家庭实验室的工程师来说，这篇东西意味着什么 —— 值得跟进，还是可以忽略。',
      '',
      '分不清事实和推测的地方，明确标出来，不要替我下结论。',
    ].join('\n'),
  },
  explain: {
    label: '解释',
    ask: [
      '假设我不懂这篇内容涉及的领域，把它讲明白。要求：',
      '1. 先交代背景：这件事的来龙去脉、为什么现在被讨论；',
      '2. 术语和缩写逐个解释，第一次出现时就地说明；',
      '3. 可以用类比帮助理解，但类比之后要说清它在哪里不成立；',
      '4. 最后指出：要真正看懂它，我还需要先知道什么。',
    ].join('\n'),
  },
};

export const AI_TASKS = Object.keys(TASKS);

export function taskLabel(task) {
  return TASKS[task]?.label || String(task || '');
}

/**
 * 拼这一篇的 system 提示。
 * 文章可能来自编辑器的**未保存草稿**，所以正文由调用方传进来，
 * 这边不去读库 —— 否则"我刚写的那段还没保存"的地方就分析不到。
 */
function articleSystem(article) {
  const tags = (article.tags || []).join('、');
  const body = String(article.body || '');
  const truncated = body.length > BODY_LIMIT;

  return [
    '你是「个人工作台 · 知识库」里的阅读助手，只回答关于下面这一篇内容的问题。',
    '用户会接着上面的对话追问，回答要承接前文，不要每轮都从头把整篇讲一遍。',
    '不要编造原文里没有的信息；原文没写的就直接说"原文没提"。',
    '回答用 Markdown，简洁，不要客套话和开场白。',
    '',
    /* 和 AI 读共用同一份写作风格（见 services/writing-style.js）。
       预设任务的措辞更具体，冲突时以任务为准 —— 风格管的是**怎么写**，
       任务管的是**写什么**，两者本来就不在同一个层面上较劲。 */
    HUMAN_STYLE,
    '',
    '--- 文章元信息 ---',
    `标题：${article.title || '(无标题)'}`,
    tags ? `标签：${tags}` : '',
    article.summary ? `作者自己写的一句话说明：${article.summary}` : '',
    '',
    '--- 正文 ---',
    body.slice(0, BODY_LIMIT) || '(正文为空)',
    truncated ? `\n\n（正文过长，以上只是前 ${BODY_LIMIT} 字，其余已省略）` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 问文章助手。emit 收到 {type:'thinking'|'delta'} 与收尾的 {type:'done'|'error'}。
 *
 * 走流式是必须的：Hermes 处理复杂问题实测 29–64 秒，
 * 一把返回的话界面得冻住一分钟，用户只会以为坏了。
 */
export async function askAboutArticle(article, { task, question, history = [] }, emit) {
  if (!aiConfigured()) {
    emit({
      type: 'error',
      message: '没有配置 AI_API_KEY，文章助手用不了 —— 它需要大模型，本地规则引擎读不了整篇文章。',
    });
    return;
  }

  const userText = String(question || '').trim() || TASKS[task]?.ask;
  if (!userText) {
    emit({ type: 'error', message: '要问什么？或者直接点上面的「总结 / 分析 / 解释」。' });
    return;
  }

  /* 预设任务和自由追问要分开对待（下面两处都用得到这个判断）：
     点预设是"把这篇重新过一遍"，追问才是"接着上面聊"。 */
  const preset = Boolean(TASKS[task]) && !String(question || '').trim();

  /* 带上前面几轮。**这是这个助手之前最要命的缺口**：界面上明明在引导
     用户问「第 3 条具体怎么做」，而请求里只有"这篇文章 + 这一个问题"，
     模型看不见它自己刚写的那段 —— 那句追问没有任何指代对象，只能瞎猜。 */
  const past = (Array.isArray(history) ? history : [])
    .filter((t) => t && String(t.text || '').trim())
    .slice(-HISTORY_TURNS)
    .map((t) => ({
      role: t.role === 'ai' ? 'assistant' : 'user',
      content: String(t.text).slice(0, 4000),
    }));

  let emitted = false;
  try {
    const answer = await llmStream(
      [
        { role: 'system', content: articleSystem(article) },
        ...past,
        { role: 'user', content: userText },
      ],
      (chunk) => {
        if (chunk.type === 'delta') emitted = true;
        emit(chunk);
      },
      /* 温度分两档，不是一刀切：
         · 预设任务是"归纳"，要稳、要贴着原文 → 0.2；
         · 自由追问是"接着聊"，0.2 会让它每轮都用同一种腔调重新起头，
           上一轮说过的话接不上 → 0.5。 */
      { temperature: preset ? 0.2 : 0.5, source: 'article' },
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
