/* ── 空闲动作轮换的参数 ──────────────────────────────────────────────
   桌宠不做事的时候不该一直循环同一段动画。这里定义三样东西：

     1. 可随机挑选的动作池（`ROAM_GROUPS`，对应 `assets/pet/extra/` 的文件名）；
     2. 每段怎么播（`ROAM_ITEMS`：播多少秒 / 循环几遍，不写就是自然播完）；
     3. 两次切换之间隔多久（`ROAM_GAPS`，按"安静 / 正常 / 活跃"三档）。

   为什么要"自然播完"作默认：素材都是 10 秒一个完整动作（有起势、有收势），
   在中间掐断再接下一段，看起来就是一次抽搐。真要缩短（比如手机省电），
   给 `seconds`，并且它带来的接缝由播放层的 300ms 交叉淡入盖掉。

   池子里没有 `idle`：待机姿势是业务状态（打盹 / 工作 / 时段待机），
   不该占一个轮换名额，也不该被当成"兜底动作"凑数。
   轮换按"一轮"走：洗牌后依次播，一轮之内不重复，全部放完才重排。
   见 `shuffleRoam` 与 Pet.tsx 里的 roamQueue。
*/

/**
 * 一组动作。分组的唯一目的是**设置面板好找**：七十多段平铺在一起，
 * 想找"涮火锅"要滚半天。
 */
export type RoamGroup = { title: string; items: Record<string, string> };

/**
 * key 必须和 `src/assets/pet/extra/<key>.webm` 的文件名一致（全小写字母），
 * 加素材只要往目录里丢文件再在这里登记；`scripts/pet-clips.py` 负责
 * 从上游拉片、校验规格、生成首帧。
 *
 * **别把状态动画的小动作版塞进来。** 上游有一批文件和 `clips/` 里那 24 段
 * 一帧不差（night=nap、sleep=sleeploop、wave=wavecheer、shy=shysurprise、
 * pat=tickle、plush=joyhop、gift=gift、winter=snowman…共 17 段）。
 * 它们放进待机池的后果是：轮换到它时画面跟当前姿势一模一样，看着就像
 * "根本没换"。这批已经剔掉了，`scripts/pet-clips.py` 里也标了原因。
 *
 * 唯一的例外是 `brush`（刷牙）：它和 `clips/morning` 内容相同，但 `morning`
 * 已经不作为早间待机姿势了，所以刷牙退回成普通动作，一轮只出现一次。
 *
 * 顺序 = 面板里渲染的顺序，不是字母序。
 */
export const ROAM_GROUPS: readonly RoamGroup[] = [
  {
    title: '日常',
    items: {
      look: '东张西望',
      cat: '撸猫',
      code: '写代码',
      cube: '玩魔方',
      gomoku: '下五子棋',
      juggle: '三球抛接',
      top: '抽陀螺',
      shuttle: '踢毽子',
      swing: '荡秋千',
      hobby: '骑木马',
      crab: '螃蟹走路',
      taptable: '敲桌子',
      jumpgrab: '跳起来抓',
      toycar: '玩小汽车',
      run: '原地奔跑',
      tailslap: '尾巴拍地',
      whattoeat: '「吃什么」',
    },
  },
  {
    title: '才艺',
    items: {
      hum: '哼歌',
      dance: '宅舞',
      sway: '摇摆舞',
      violin: '小提琴',
      flute: '吹笛子',
      magic: '扑克魔术',
      balloon: '吹气球',
      butterfly: '蝴蝶环绕',
      bubbles: '吐泡泡',
      maidance: '女仆舞',
      needle: '穿针乞巧',
    },
  },
  {
    title: '吃喝',
    items: {
      snack: '偷吃零食',
      icecream: '吃冰淇淋',
      rice: '吃白饭',
      hotpot: '涮火锅',
      munch: '大口吃',
      lunch: '吃午餐',
      breakfast: '吃早餐',
      dinner: '吃晚餐',
      tangyuan: '吃汤圆',
      zongzi: '吃粽子',
      niangao: '吃年糕',
      candied: '吃糖葫芦',
      congee: '吃腊八粥',
      watermelon: '吃西瓜',
      chongyang: '吃重阳糕',
      noodles: '吃长寿面',
      qingtuan: '吃青团',
      dumpling: '吃饺子',
      crabmeal: '吃大闸蟹',
    },
  },
  {
    title: '休整',
    items: {
      brush: '晨间刷牙',
      doze: '打瞌睡',
      yawn: '哈欠连天',
      stretch: '伸懒腰',
      mirror: '照镜子',
      fan: '摇扇',
      sleepstart: '准备睡',
      sleepwake: '睡醒',
    },
  },
  {
    title: '玩乐',
    items: {
      kite: '放风筝',
      watergun: '玩水枪',
      redpacket: '收红包',
      outfit: '换装试色',
      xmas: '装点圣诞树',
      pumpkin: '讨糖南瓜灯',
      leaves: '被落叶淹没',
      startled: '被吓一跳',
      ghost: '小幽灵',
      bigwhale: '蓝鲸现世',
      animals: '动物环绕',
      rage: '玩游戏急了',
      tsundere: '傲娇生气',
    },
  },
  {
    title: '节日',
    items: {
      riverlantern: '放河灯',
      fireworks: '放烟花',
      mooncake: '赏月吃月饼',
      fuzi: '写福字',
      chrysanth: '赏菊插茱萸',
    },
  },
  {
    title: '碎碎念',
    items: {
      deepthink: '深度思考',
      dazedbuzz: '发呆念叨',
      screenbuzz: '对着屏幕念',
      wipebuzz: '擦桌念叨',
      noting: '记点什么',
    },
  },
];

/** 扁平表：key → 中文名（顺序仍按分组来） */
export const ROAM_LABELS: Record<string, string> = Object.assign(
  {} as Record<string, string>,
  ...ROAM_GROUPS.map((g) => g.items),
);

/** 动作池的固定顺序（也决定设置面板里 chips 的顺序） */
export const ROAM_POOL: readonly string[] = ROAM_GROUPS.flatMap((g) => Object.keys(g.items));

/**
 * 每段动作的播放策略。
 *
 * `seconds`  播到第几秒切走（不写 = 播完）
 * `loops`    循环几遍（不写 = 1 遍）
 *
 * 两者都不写时按视频自然结束（`ended`）触发切换，最自然。
 * 这里的表默认是空的：素材都是 10 秒一个完整动作（起势 → 收势），
 * 中途掐断一次就是一次"抽搐"，比等它放完难看得多。
 * 真要省电/求快，先调小下面的间隔，别动这里。
 */
export const ROAM_ITEMS: Record<string, { seconds?: number; loops?: number }> = {};

/**
 * 三档间隔（毫秒）：**上一段放完之后再等多久**才排下一段。
 *
 * 实际周期 = 这段间隔 + 动作本身约 10 秒，所以别按"整分钟"给数 ——
 * 18~45s 配 10s 动作就是近一分钟才换一次，看着跟没轮换一样。
 * 切换那一刻再在区间里取随机值，两段之间不会等成长短不一的机械节拍。
 */
export const ROAM_GAPS: Record<'quiet' | 'normal' | 'lively', readonly [number, number]> = {
  quiet: [30_000, 60_000],
  normal: [7_000, 18_000],
  lively: [3_000, 7_000],
};

export const ROAM_GAP_LABELS: Record<'quiet' | 'normal' | 'lively', string> = {
  quiet: '安静',
  normal: '正常',
  lively: '活跃',
};

/**
 * 把池子洗成"一轮"的播放顺序。
 *
 * 为什么不用"每次随机抽一段、排除上一段"：那样总会抽到播过的段，
 * 七八十段里想看完一轮纯靠运气，看着就是"这几段反复出现"。
 * 洗牌后一轮之内每段只出一次，**全部放完才重排**，这才叫不重样。
 *
 * `last` 是上一轮的最后一个，新一轮的开头会跟它错开，
 * 免得两轮交界处连着播同一段。
 */
export function shuffleRoam(
  pool: readonly string[],
  last: string | null,
  rand: () => number = Math.random,
): string[] {
  const out = [...pool];
  /* Fisher-Yates：从后往前换，每一步的随机范围随之收窄 */
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (last && out.length > 1 && out[0] === last) {
    const j = 1 + Math.floor(rand() * (out.length - 1));
    [out[0], out[j]] = [out[j], out[0]];
  }
  return out;
}

/** 在区间里取一个随机间隔。上下界给反了也不会出负数 */
export function pickRoamGap(range: readonly [number, number], rand: () => number = Math.random): number {
  const [min, max] = range[0] <= range[1] ? range : [range[1], range[0]];
  return Math.round(min + rand() * (max - min));
}
