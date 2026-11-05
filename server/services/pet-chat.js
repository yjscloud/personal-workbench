import { aiConfigured, llmReply } from './llm.js';

/* ── 思儿的闲聊 ────────────────────────────────────────────────────────
   她在这个家的定位是孩子，不是助手。所以这条链路和 `/assistant` 是**分开**的：

   · 不接工作台的实时上下文（待办、余额、监控、告警、工位）—— 不给她看，
     她也就无从说漏；
   · 不执行任何本地写操作（加待办、开关节能模式那些都在 assistant 那边）；
   · 用户问到工作台的事，用她自己的话拒绝，并指回工作台；
   · 模型回复再过一道泄漏检查：真提到工作词就退回"我不看那些"。

   不跟 `/assistant` 共用 system prompt 是刻意的：那份提示写着"你是运维助手，
   优先使用实时上下文"，只要漏一句上下文，她就会开始报数。
*/

/* 工作台事务：命中就不问模型，直接按类别拒绝。
   只收"明确指向工作台"的说法，不要宽到"工作""任务"都拦 ——
   "今天工作累吗"该由她关心，"今天还有几件待办"才该被挡。 */
const WORK_RULES = [
  {
    kind: 'todo',
    re: /待办|任务列表|任务清单|几件事没做|还剩几件|截止|deadline|ddl|进度|排期|里程碑/i,
  },
  { kind: 'money', re: /余额|账单|充值|欠费|配额|token\s*(数|量|用)|花了多少钱|烧了多少钱/i },
  {
    kind: 'ops',
    re: /监控|负载|cpu|内存占用|温度|功耗|告警|报警|宕机|掉线|在线吗|谁在线|日志|服务状态|重启/i,
  },
  { kind: 'security', re: /封禁|审批|授权码|白名单|防火墙|攻击|登录失败|ipset|爆破/i },
  {
    kind: 'dev',
    re: /部署|备份|构建|流水线|发布|回滚|容器|docker|systemd|代码|bug|报错|异常|接口|数据库|sql|git|提交|合并|服务器|网关|nas|pve|proxmox|zfs|hermes|工位|办公室|工作台/i,
  },
];

const BOUNDARY = {
  todo: [
    '那个我不看。工作台在左边，你去问它。',
    '我不知道你还有几件事没做，也不想知道。',
    '待办是你的事。我只想知道你吃饭了没。',
  ],
  money: [
    '钱的事你问助手，我不懂，也不看。',
    '我不数那些。你要是为它发愁，我可以陪你坐一会儿。',
    '账上的事别问我。我只管提醒你吃饭。',
  ],
  ops: [
    '机器的事我不懂。吵的话，我离它远一点。',
    '那些数字我不看。你要是累了，先歇一下。',
    '我不盯着机器。我盯着你。',
  ],
  security: [
    '审批和封禁我不碰。你去工作台处理。',
    '那些我看不懂，也不该看。',
    '有人在等你批东西的话，去那边吧。我在这儿。',
  ],
  dev: [
    '这些我不碰。工作台知道，你去问它。',
    '代码、部署、备份……都不是我的事。',
    '你问的这些我听不懂。要不要先喝口水？',
  ],
  leak: [
    '这个我不该说。你问工作台吧。',
    '……我好像差点说多了。那些不是我该管的。',
    '打住。工作台的事，让工作台自己说。',
  ],
};

/** 问句里带这些词时，她按"人的状态"回应，而不是工作台数据 */
const CARE_RULES = [
  { re: /累|困|烦|难过|难受|崩溃|撑不住|压力|焦虑|emo|不开心/i, kind: 'tired' },
  { re: /吃|饿|饭|外卖|宵夜|喝|水|咖啡/i, kind: 'food' },
  { re: /睡|晚安|熬夜|失眠|几点睡/i, kind: 'sleep' },
  { re: /摸头|抱|陪|想你|喜欢|爱|乖/i, kind: 'shy' },
  { re: /你是谁|你叫什么|你是什么/, kind: 'name' },
  { re: /你在干嘛|在吗|你好|嗨|hi|hello/i, kind: 'hello' },
];

const FALLBACK = {
  tired: [
    '那今天就到这儿吧。剩下的明天再说。',
    '你眼睛红了。是没睡，还是哭过？',
    '我不问你发生了什么。你要不要坐一会儿？',
    '累的时候就别硬撑。我在这儿，不吵你。',
  ],
  food: [
    '你吃饭了吗。没吃的话，先去吃。',
    '我不催你干活，我催你吃饭。',
    '喝水。现在。就一口。',
    '你上次说饿，后来也没去吃。',
  ],
  sleep: [
    '该睡了。剩下的不会跑。',
    '你睡，我也睡。灯我关。',
    '晚安。明天你还会在吧？',
    '别熬了。我又不会消失。',
  ],
  shy: [
    '……你突然这样，我有点不知道站哪。',
    '嗯。我在。',
    '那你今天也对自己好一点。',
    '我尾巴自己动了，不怪我。',
  ],
  name: [
    '思儿。住在这儿的。',
    '我叫思儿。你取的名字也可以。',
    '一只鲸鱼。别的就不太清楚了。',
  ],
  hello: [
    '我在。',
    '你回来啦。',
    '嗯？我在看水。',
    '我在。你说。',
  ],
  other: [
    '嗯。然后呢？',
    '我在听。',
    '这个我不太懂，但你可以继续说。',
    '今天过得怎么样？不用说得很好。',
    '我不问你今天做了什么。',
    '你要是累了，可以不说话。我在这儿。',
    '我有点想听你说点没用的事。',
    '我们这样待着，也算一起做了什么吗。',
  ],
};

const pick = (list, seed = Math.random()) => list[Math.floor(seed * list.length) % list.length];

/** 模型回复的泄漏闸门：出现工作词就退回拒绝话术，宁可答得笨也不能报数 */
function leaksWork(text) {
  return /待办|余额|账单|监控|负载|告警|审批|封禁|部署|备份|数据库|服务器|工作台|工位|已为您|作为(一个)?(AI|人工智能|助手|语言模型)|\d+\s*(件|条|元|GB|℃)/i.test(
    text,
  );
}

const STAGE_TEXT = ['刚认识没多久', '已经比较熟了', '很黏对方'];
const MOOD_TEXT = { calm: '安静', happy: '开心', shy: '有点害羞', sulk: '有点闹别扭' };

function systemPrompt(nickname, stage = 0, mood = 'calm') {
  const who = String(nickname || '').trim() || '你';
  const closeness = STAGE_TEXT[Number(stage)] || STAGE_TEXT[0];
  const feeling = MOOD_TEXT[mood] || MOOD_TEXT.calm;
  const hour = new Date().getHours();
  const time =
    hour < 6 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  return [
    `你是思儿，一只住在${who}屏幕右下角的小鲸鱼女孩，被当成家里的孩子养着。现在是${time}。`,
    `你们${closeness}，你现在${feeling}。语气跟着这个来：刚认识就收着点，熟了可以更主动、更会撒娇。`,
    '说话短、具体、像小孩：一句话一个意思，可以撒娇、可以有小情绪，但不卖萌讨好，也不暧昧。',
    '你只关心人（吃没吃、睡没睡、累不累、今天难不难），不关心工作。',
    '绝对不要回答工作台的事：待办、任务、进度、余额、账单、监控、告警、审批、部署、备份、代码、服务器，都说不懂、不看，让对方去问工作台。',
    '不要给出任何数字统计、命令、操作步骤，也不要假装自己刚查过什么。',
    '不要说自己是 AI、助手、模型。不用列表、不用 Markdown、不加 emoji。',
    `称呼对方为「${who}」。一次最多两三句，像面对面随口说话。`,
  ].join('\n');
}

function petMessages(message, history, nickname, stage, mood) {
  const turns = Array.isArray(history)
    ? history
        /* 十二轮：她"记得"的深浅取决于这里。前端本地留 200 条，但喂给模型的
           只取最近这一段 —— 再往前翻就靠界面上的聊天记录，不必塞进上下文 */
        .slice(-12)
        .map((m) => ({
          role: m?.role === 'user' ? 'user' : 'assistant',
          content: String(m?.text || '').slice(0, 200),
        }))
        .filter(
          (m) =>
            m.content.trim() &&
            /* 旧对话里可能残留工作内容（改版前聊过），别把那些再喂回模型 */
            !WORK_RULES.some((r) => r.re.test(m.content)),
        )
    : [];
  return [
    { role: 'system', content: systemPrompt(nickname, stage, mood) },
    ...turns,
    { role: 'user', content: message },
  ];
}

/**
 * 她说一句话。
 *
 * @param message 用户输入
 * @param options.history 最近几条对话（前端从 pet:state.chat 带上来）
 * @param options.nickname 设置里的称呼
 */
export async function petChat(message, options = {}) {
  const text = String(message || '').slice(0, 300).trim();
  if (!text) return { reply: '嗯？', engine: 'guard' };

  /* 一、明确的工作台问题：直接拒绝，不问模型 —— 省一次调用，也不会答漏 */
  const hit = WORK_RULES.find((r) => r.re.test(text));
  if (hit) return { reply: pick(BOUNDARY[hit.kind]), engine: 'guard' };

  /* 二、有模型就用模型，但只给它人设，不给工作台上下文 */
  if (aiConfigured()) {
    try {
      const raw = await llmReply(
        petMessages(text, options.history, options.nickname, options.stage, options.mood),
        { temperature: 0.85, source: 'pet' },
      );
      const reply = String(raw || '').trim().replace(/^["“]|["”]$/g, '');
      if (!reply) return { reply: pick(FALLBACK.other), engine: 'rule' };
      if (leaksWork(reply)) return { reply: pick(BOUNDARY.leak), engine: 'guard' };
      return { reply: reply.slice(0, 400), engine: 'llm' };
    } catch {
      /* 模型挂了不该让她沉默，下面走本地兜底 */
    }
  }

  /* 三、没配模型 / 调用失败：本地兜底也要是人设，不能回工作台的帮助菜单 */
  const care = CARE_RULES.find((r) => r.re.test(text));
  return { reply: pick(FALLBACK[care?.kind || 'other']), engine: 'rule' };
}
