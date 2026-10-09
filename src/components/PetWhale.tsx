import { cls } from '@/lib/format';

/* ── 鲸娘的立绘 ────────────────────────────────────────────────────────
   24 张，在 `assets/pet/states/NN-<姿势>.png`，文件名与下面的 Pose 一一对应。

   上一版只有**一张**图（白饭本人那张：一手举起打招呼、一手托着小鲸鱼），
   24 档差异靠 CSS 叠出来 —— 色调、动效、基准姿态（躺下 / 前倾 / 镜像 / 推近），
   外加一大堆 SVG 道具。那套的天花板很清楚：表情和姿势都改不了，
   扫一眼还是"同一张图"，跟参考项目里 24 格各有各的动作不是一回事。

   这一版把 24 档画成了 24 张，于是**道具、色调、身形变化全都不需要了**：
   咖啡杯、睡帽、被子、围巾、笔记本、放大镜、饼干、奖杯、星星眼、爱心眼、
   z、月亮、雪、气泡、彩带 …… 都已经画在画里。再叠一层 CSS 只会得到
   两个杯子、两轮月亮、两个她。

   所以现在只剩**一层**：

     .pet-pose-*   动作（蹦、摇、抖、转圈、水里浮）

   分工是清楚的：**姿势由画决定，动作由 CSS 决定** —— 一个回答"她是
   谁、在干嘛"，一个回答"她还活着"。两层都用 transform，所以说话时
   点头和动作层是相乘的，不会互相顶掉。

   换图时统一规格过一版（抠底 → 裁到主体 → 按主体尺寸缩放到同一比例 →
   脚落在同一条底线上）。不归一的话换姿势时她会忽大忽小：单看一张没问题，
   动起来很明显。

   ── 重画这 24 张时要冻结的角色描述 ─────────────────────────────────────
   逐字不变地放进每一条提示词，只换最后那句姿势（22 号那一档另加一条鲸鱼）：

     画面    chibi anime illustration，Q 版约两头身，单人、无场景、纯白平底；
             明确写上 **不要**贴纸描边 / 不要投影 / 不要背景圆 —— 这三样都会
             在抠底时留下一圈灰边
     发色    青调天蓝，基准 hex #75A3CA = rgb(117,163,202)，色相约 208°；
             发梢褪到淡薄荷 hex #B9E5EA
     头饰    白色扇贝边蕾丝女仆头箍（是白的，不是蓝的、不是一个蝴蝶结）
             ＋ 侧边一枚浅蓝小蝴蝶结
     脸      大而亮的宝蓝眼、四角星高光、浓睫毛、腮红、小张嘴
     发型    长卷发、低双马尾垂在肩前、一根呆毛竖起；头两侧是深藏青鲸鳍状
             耳鳍、浅蓝薄膜
     服装    藏青女仆裙 ＋ 白色水手领 ＋ 浅蓝领结；白围裙（绣一只小鲸鱼）；
             藏青褶裙、细金边、白色荷叶裙摆；白袜 ＋ 深藏青玛丽珍鞋；身后一条鲸尾

   两个踩过的坑，重画时别再踩：
   ① 发色只写 "blue" 会被画成蓝紫。要把色值写死，并**显式排除**紫 / 薰衣草 /
      紫罗兰 / 蓝紫 —— 这一处跑偏过一整轮，24 张全部重画。
   ② 批量出图**一次一个目录**：并行调用落在同一秒时文件名会撞车、后一张把前一张
      覆盖掉，而且不报错。出完记得对一遍 md5。 */

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
 * 取的是 `idle` 那张。脸的位置是**量出来的**，不是目测：在 512 画布上把肤色
 * 打成连通块（R>G>B、够亮、饱和度不高），最大那块就是脸，外接框中心落在
 * (50.4%, 41.1%)。用外接框中心而不是质心：质心会被下巴和脖子往下拽，
 * 景别取到嘴那一带，眼睛就顶到圆边上了。
 *
 * 两个百分比的分母**不是同一个**：left 按容器的宽、top 按容器的高算。
 * 图放成 180%，把脸心推到圆心：
 *   left = 50% − 1.8 × 50.4% ≈ −41%
 *   top  = 50% − 1.8 × 41.1% ≈ −24%
 *
 * 这组数跟着立绘的裁切走：立绘一旦重新归一化（主体尺寸/SIZE 变了），
 * 脸心就会平移，这两个值必须跟着重量一次。
 */
export function WhaleFace({ size = 32 }: { size?: number }) {
  return (
    <span className="relative block overflow-hidden rounded-full" style={{ width: size, height: size }} aria-hidden>
      <img
        src={STATES.idle}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{ width: '180%', left: '-41%', top: '-24%' }}
      />
    </span>
  );
}
