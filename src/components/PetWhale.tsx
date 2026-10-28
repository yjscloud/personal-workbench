import { cls } from '@/lib/format';

/* ── 鲸娘的立绘 ────────────────────────────────────────────────────────
   24 张，在 `assets/pet/states/NN-<姿势>.png`，文件名与下面的 Pose 一一对应。

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
     assets/pet/states/  归一后的 512×512 透明 PNG，这才是进 bundle 的

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
const modules = import.meta.glob('../assets/pet/states/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const STATES: Partial<Record<Pose, string>> = {};
for (const [path, url] of Object.entries(modules)) {
  const m = /(\d+)-([a-z]+)\.png$/.exec(path);
  if (m) STATES[m[2] as Pose] = url;
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
export function Whale({ pose = 'idle', size = 132, talk = false }: { pose?: Pose; size?: number; talk?: boolean }) {
  return (
    /* 宽度由 size 给，上限由 CSS 按屏宽收（手机上是 106px）：
       max-width 会盖过内联 width，"小屏小一点"因此不必走 JS */
    <span className="pet-figure relative block" style={{ width: size }}>
      {/* 色调层。挂在最外侧：要褪色就整幅一起褪，连同画里的道具 */}
      <span className={cls('pet-stage relative block', TONE[pose])}>
        {/* 动效层。姿势已经在画里，这一层只管"她还在动" */}
        <span className={cls('pet-pose block', `pet-pose-${pose}`)}>
          <img
            src={STATES[pose] ?? STATES.idle}
            alt=""
            aria-hidden
            draggable={false}
            className={cls('pet-art block h-auto w-full', talk && 'pet-art-talk')}
          />
        </span>
      </span>
    </span>
  );
}

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
export function WhaleFace({ size = 32 }: { size?: number }) {
  return (
    <span className="relative block overflow-hidden rounded-full" style={{ width: size, height: size }} aria-hidden>
      <img
        src={STATES.idle}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{ width: '190%', left: '-29%', top: '-26%' }}
      />
    </span>
  );
}
