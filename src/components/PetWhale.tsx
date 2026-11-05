import { cls } from '@/lib/format';
import { PetClip, PetClipFace, clipSupported } from './PetClip';

/* ── 思儿的立绘 ────────────────────────────────────────────────────────
   24 张，在 `assets/pet/states/NN-<姿势>.webp`，文件名与下面的 Pose 一一对应。

   最早只有**一张**图，24 档差异靠 CSS 叠出来 —— 色调、动效、基准姿态
   （躺下 / 前倾 / 镜像 / 推近），外加一大堆 SVG 道具。那套的天花板很清楚：
   表情和姿势都改不了，扫一眼还是"同一张图"。

   现在 24 档是 24 张，于是**道具、色调、身形变化全都不需要了**：咖啡杯、
   枕头、围巾、笔记本、放大镜、饼干、小旗子、星星眼、爱心眼、z、月亮、气泡、
   彩带、鲸鱼 …… 都已经画在画里。再叠一层 CSS 只会得到两个杯子、两轮月亮、两个她。

   所以只剩**一层**：

     .pet-pose-*   动作（蹦、摇、抖、转圈、水里浮）

   分工是清楚的：**姿势由画决定，动作由 CSS 决定** —— 一个回答"她是
   谁、在干嘛"，一个回答"她还活着"。两层都用 transform，所以说话时
   点头和动作层是相乘的，不会互相顶掉。

   出图 → 归一是两步，别把第二步省掉：模型给的是白底、构图各异的方图，
   不归一的话换姿势时她会忽大忽小、忽左忽右 —— 单看一张没问题，动起来很明显。
   现在 `python3 scripts/pet-normalize.py` 干这件事（抠底 → 裁到主体 →
   按主体高度缩放到 94% → 脚心落在画布中线）。文件夹约定：

     .pet-src/raw/       出图的原图（30MB 级，按 .gitignore 不入库）
     assets/pet/states/  归一后的 512×512 透明 WebP，这才是进 bundle 的

   ── 重画这 24 张时要冻结的角色描述 ─────────────────────────────────────
   逐字不变地放进每一条提示词，只在开头换「【NN-姿势】姿势：…」那一段：

    画面    Q 版三头身、大头小身子、单人全身、无场景、纯白平底；
            明确写上 **不要**贴纸描边 / 不要投影 / 不要背景圆 / 不要多格分镜
    发色    深海蓝发根 #1B3A8C → 发尾明亮海蓝 #3FA9F5 + 浅青蓝 #A8E0F0；
            蓬松长卷发垂到腰下、发梢散成微卷波浪；层叠斜刘海、一根弧形呆毛
    头饰    拱起的白色蕾丝女仆发箍（层层褶边）＋ 两侧各一枚亮蓝小蝴蝶结
    耳鳍    头侧一对向外展开的鲸鱼鳍状耳朵，外深海蓝、内缘白色波浪褶边
    脸      圆脸大眼，深蓝外圈 + 亮蓝虹膜 + 多个白色/浅蓝高光，浓睫毛、
            淡粉腮红、小嘴
    尾巴    身后一条厚实深蓝鲸尾，腰后弯向侧面，末端两片圆润尾鳍
    服装    白高领褶裥衬衫 ＋ 深蓝蝴蝶结 ＋ 金边椭圆蓝宝石胸针；深蓝收腰
            短上衣、蓬袖白蕾丝；宽大白围裙绣小鲸鱼与水花；深蓝外撑短裙叠
            多层白花边，金色十字星与浅金小蝴蝶结；白花边短袜 ＋ 深蓝玛丽珍鞋

   三个踩过的坑，重画时别再踩：
   ① 发色只写 "blue" 会被画成蓝紫。要把色值写死，并**显式排除**紫 / 薰衣草 /
      紫罗兰 / 蓝紫 —— 这一处跑偏过一整轮，24 张全部重画。
   ② 不写"单人、不要多格"的时候，模型会交回一张 2×2 的角色设定图（同一批里
      真发生过，那一格缩到 132px 就是四只小米粒）；"被摸头"那张还会自己从画外
      伸一只大人的手进来，要显式排除别人的手。
   ③ 姿势码写在提示词**最前面**：并行出图落在同一秒时文件名会按提示词前缀生成，
      长提示词只差结尾就全撞在一起、后一张把前一张覆盖掉，而且不报错。 */

export type Pose =
  | 'idle'
  | 'plush'
  | 'wave'
  | 'morning'
  | 'night'
  | 'winter'
  | 'work'
  | 'watch'
  | 'alert'
  | 'error'
  | 'sleep'
  | 'pat'
  | 'shy'
  | 'star'
  | 'love'
  | 'drag'
  | 'feed'
  | 'checkin'
  | 'streak'
  | 'levelup'
  | 'gift'
  | 'surprise'
  | 'swim'
  | 'celebrate';

/* ── 文件名 → 资源 URL ─────────────────────────────────────────────────
   用 glob 而不是 24 行 import：以后加一档姿势只要把图丢进目录，
   不用再回来补一行代码。

   注意 eager 的只是 **URL 字符串**（进 JS bundle 的是路径，不是图），
   图片本身仍然是谁渲染到才下谁 —— 桌宠同一时刻只显示一张。 */
const modules = import.meta.glob('../assets/pet/states/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const STATES: Partial<Record<Pose, string>> = {};
for (const [path, url] of Object.entries(modules)) {
  const m = /(\d+)-([a-z]+)\.webp$/.exec(path);
  if (m) STATES[m[2] as Pose] = url;
}

/* ── 动态素材：同样的 24 个姿势，一段 10 秒的透明动画 ─────────────────
   来源与许可见 `PetClip.tsx` 顶部。命名规则与立绘一致（`<pose>.webm`），
   所以加一段动画也是"把文件丢进目录"就完事。
   注意这里 eager 的只是 **URL 字符串**：视频本身仍然是谁出现才下谁，
   同一时刻只挂当前这一段（外加切换时 200ms 的上一段）。 */
const clipModules = import.meta.glob('../assets/pet/clips/*.webm', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const CLIPS: Partial<Record<Pose, string>> = {};
for (const [path, url] of Object.entries(clipModules)) {
  const m = /([a-z]+)\.webm$/.exec(path);
  if (m) CLIPS[m[1] as Pose] = url;
}

/* 每段动画的首帧（320×320，同一映射合成）。视频下完之前先铺它，
   否则切到冷门姿势时会空白一下 —— 20KB 换"永远有画面"。 */
const frameModules = import.meta.glob('../assets/pet/frames/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const FRAMES: Partial<Record<Pose, string>> = {};
for (const [path, url] of Object.entries(frameModules)) {
  const m = /([a-z]+)\.webp$/.exec(path);
  if (m) FRAMES[m[1] as Pose] = url;
}

/* ── 额外的小动作 ────────────────────────────────────────────────────
   业务状态只有 24 档（工作 / 告警 / 睡觉…），但"她自己在干嘛"可以更多：
   写代码、撸猫、玩魔方、偷吃零食、照镜子…… 这些**不进 Pose 类型** ——
   它们是装饰，不是状态，不该被业务逻辑引用，也不该参与 pose 的优先级判断。
   待机时由 Pet 里的调度器随机挑一段放一次（10 秒），放完回待机。 */
const extraClipModules = import.meta.glob('../assets/pet/extra/*.webm', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const extraFrameModules = import.meta.glob('../assets/pet/extra/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function byKey(mods: Record<string, string>, ext: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(mods)) {
    const m = new RegExp(`([a-z]+)\\.${ext}$`).exec(path);
    if (m) out[m[1]] = url;
  }
  return out;
}

const EXTRA_CLIPS = byKey(extraClipModules, 'webm');
const EXTRA_FRAMES = byKey(extraFrameModules, 'webp');

/** 可随机播放的小动作 id（文件名即 id） */
export const EXTRA_IDS = Object.keys(EXTRA_CLIPS);

export type ExtraArt = { id: string; src: string; frame?: string };

/** 按 id 取一段小动作；没有就返回 null（调度器据此跳过） */
export function extraArt(id: string): ExtraArt | null {
  const src = EXTRA_CLIPS[id];
  return src ? { id, src, frame: EXTRA_FRAMES[id] } : null;
}

/**
 * 任意 key → 一段可播放的动画。姿势名（`idle` / `morning`…）与小动作名
 * （`code` / `cat`…）共用同一个入口，调度器不必关心它属于哪一类。
 */
export function roamArt(key: string): ExtraArt | null {
  const pose = key as Pose;
  const src = CLIPS[pose];
  if (src) return { id: key, src, frame: FRAMES[pose] };
  return extraArt(key);
}

/** 有没有可用的动态素材（Safari 上为假，见 clipSupported 的说明） */
export const hasClips = Object.keys(CLIPS).length > 0;

/**
 * 这一档到底用动画还是立绘。
 *
 * `'auto'` 是默认值：能播就用动画，不能播（Safari / iOS）就退回立绘 ——
 * 不弹提示、不报错，用户看到的永远是一只有画面的桌宠，而不是一个黑方块。
 */
export type WhaleArt = 'auto' | 'clip' | 'pose';
const useClipArt = (art: WhaleArt) => art !== 'pose' && hasClips && clipSupported();

/**
 * 空闲时把常用动画先取进 HTTP 缓存。
 *
 * 第一次切到某个动作要下 400KB 左右的视频，网络慢时会有一次"空一下"；
 * 提前取好就没有这个空窗。只取真正高频的几段，不整包预取（12MB 没必要）。
 */
export function warmClips(keys: string[]): void {
  for (const k of keys) {
    const art = roamArt(k);
    if (!art) continue;
    void fetch(art.src, { cache: 'force-cache' }).catch(() => { /* 预取失败不影响正片 */ });
  }
}

/**
 * 还要用 CSS 再补一刀的档位。
 *
 * 只有一件：`error` 的**褪色**。画里她已经在抱头、冒汗、冒惊慌线，但"不对劲"
 * 最一眼的读法其实是整张画掉色 —— 这恰恰是画本身给不了的（画出来的就是彩色）。
 * 其余几档（深夜压暗、清晨偏暖、水里偏青、冬天偏冷）都已经画进图里，
 * 再挂 filter 就成了叠两次。
 */
const TONE: Partial<Record<Pose, string>> = {
  error: 'pet-tone-gray',
};

/** 立绘本体 + 这一档的动作 */
export function Whale({
  pose = 'idle',
  size = 132,
  talk = false,
  art = 'auto',
  extra = null,
  extraLoop = false,
  onExtraEnd,
}: {
  pose?: Pose;
  size?: number;
  talk?: boolean;
  art?: WhaleArt;
  /** 临时覆盖：待机时随机播的一段小动作（放完回原姿势） */
  extra?: ExtraArt | null;
  /** 小动作是否循环播（配了时长时用定时器切走，而不是等它自然结束） */
  extraLoop?: boolean;
  onExtraEnd?: () => void;
}) {
  const clip = useClipArt(art);
  const url = CLIPS[pose] ?? CLIPS.idle;
  const frame = FRAMES[pose] ?? FRAMES.idle;
  return (
    /* 宽度由 size 给，上限由 CSS 按屏宽收（手机上是 106px）：
       max-width 会盖过内联 width，"小屏小一点"因此不必走 JS。
       aspect-ratio 是给动画模式用的 —— 视频是绝对定位，撑不起高度。 */
    <span className="pet-figure relative block" style={{ width: size, aspectRatio: '1 / 1' }}>
      {/* 色调层。挂在最外侧：要褪色就整幅一起褪，连同画里的道具 */}
      <span className={cls('pet-stage relative block h-full w-full', TONE[pose])}>
        {clip && url ? (
          /* 动效层：人已经在画面里动了，不再叠 CSS 的蹦/摇，否则两层动作打架。
             小动作只播一遍（loop=false），放完由 onEnded 通知调度器收回。 */
          <PetClip
            src={extra?.src ?? url}
            poster={extra ? extra.frame : frame}
            loop={extra ? extraLoop : true}
            onEnded={extra && !extraLoop ? onExtraEnd : undefined}
          />
        ) : (
          /* 动效层。姿势已经在画里，这一层只管"她还在动" */
          <span className={cls('pet-pose block', `pet-pose-${pose}`)}>
            <img
              src={STATES[pose] ?? STATES.idle}
              alt=""
              aria-hidden
              draggable={false}
              className={cls('pet-art block h-auto w-full', talk && 'pet-art-talk')}
            />
          </span>
        )}
      </span>
    </span>
  );
}

/* 头像裁切参数。两套素材构图不一样，各对一套 —— 混用会出现"脸歪到一边" */
const AVATAR_POSE = { width: '190%', left: '-29%', top: '-26%' } as const;

/* 动画那套（frames/idle.webp，320 画布）：人物在画布里更靠上，脸心落点因此不同。
   按同一套网格重量，取 x 75..245 / y 55..225 的方形（170px 见方）：
     width = 320 ÷ 170 ≈ 188.2%
     left  = −75 × 1.882 ÷ 320 ≈ −44.1%
     top   = −55 × 1.882 ÷ 320 ≈ −32.4% */
const AVATAR_CLIP = { width: '188.2%', left: '-44.1%', top: '-32.4%' } as const;

/**
 * 只露一张脸的小头像。收起桌宠之后右下角那颗唤回按钮用它 ——
 * 缩到 30px 还放全身的话只剩一团蓝，认不出是谁。
 *
 * 取的是 `idle` 那张。位置是**量出来的**，不是目测：在 512 画布上铺一层
 * 5% 的网格，读两只眼睛的中点 —— 这一版刘海把脸颊切得很碎，按"最大肤色
 * 连通块"取外接框会挑到一小块腮红（旧版那套做法在这里会偏到 33%），
 * 所以改成读眼距的中点，落点 (41.5%, 43.5%)。
 *
 * 两个百分比的分母**不是同一个**：left 按容器的宽、top 按容器的高算。
 * 图放成 190%，把脸心推到圆心，纵向再往上抬一点（43.5% → 40%），
 * 免得眼睛贴着圆的上沿：
 *   left = 50% − 1.9 × 41.5% ≈ −29%
 *   top  = 50% − 1.9 × 40.0% ≈ −26%
 *
 * 这组数跟着立绘的裁切走：立绘一旦重新归一化（主体尺寸/SIZE 变了），
 * 脸心就会平移，这三个值必须跟着重量一次。
 */
export function WhaleFace({ size = 32, art = 'auto' }: { size?: number; art?: WhaleArt }) {
  /* 动画模式下头像也是动的：立绘那张是另一套角色设定，混着用一眼能看出不对 */
  const url = CLIPS.idle;
  if (useClipArt(art) && url) return <PetClipFace src={url} size={size} />;
  return (
    <span className="relative block overflow-hidden rounded-full" style={{ width: size, height: size }} aria-hidden>
      <img
        src={STATES.idle}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={AVATAR_POSE}
      />
    </span>
  );
}

/**
 * 聊天窗用的头像。
 *
 * 跟 WhaleFace 差两点：
 *   · 只取"脸和肩" —— 全身缩到 24px 只剩一团蓝，五官全糊，看着像贴错图；
 *   · **不用 video**：聊天窗一屏能挂十几枚，每枚一个自动播放的 <video> 是白烧
 *     解码；静态首帧在这个尺寸上看不出差别。
 *
 * 动画模式取 frames/idle.webp（与当前立绘同一套角色），立绘模式取 states/idle，
 * 各自用 AVATAR_CLIP / AVATAR_POSE，不混图 —— 两套画风混着用一眼能看出来。
 */
export function WhaleAvatar({ size = 24, art = 'auto' }: { size?: number; art?: WhaleArt }) {
  const clip = useClipArt(art) ? FRAMES.idle : undefined;
  return (
    <span
      /* 底色 + 一圈描边：透明 PNG 直接贴在消息气泡旁会显得"飘"，有个圆底才像个头像 */
      className="relative block shrink-0 overflow-hidden rounded-full bg-bg-3 ring-1 ring-line"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={clip || STATES.idle}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={clip ? AVATAR_CLIP : AVATAR_POSE}
      />
    </span>
  );
}
