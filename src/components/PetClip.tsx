import { useEffect, useRef, useState } from 'react';
import { cls } from '@/lib/format';

/* ── 动态桌宠的播放层 ─────────────────────────────────────────────────
   素材来自 https://github.com/PC2005-cloud/dsh-pet ：
   代码 MIT，**动画素材与角色形象是 CC BY-NC-SA 4.0（署名 · 非商业）**。
   本工作台自用不涉及商用；对外分发前要么署名 + 保持非商业，要么换成自己的素材。
   播放层只有这一个引用点，换成自己的动画只要替换 `assets/pet/clips/*.webm`。

   ── 为什么不用逐段调参 ─────────────────────────────────────────────
   24 段素材是同一机位拍的：640×360、人物固定落在 x198..432 / y78..326，
   只有动作不同。所以整层按一个比例放大、裁进方形容器，人物就与原来的
   24 张立绘对上了位置（实测合成后 391×484、脚底 y=511，立绘 378×480、脚底 511）。

     容器宽 = W（方形容器，宽高相等）
     人物目标高 = 0.94W（立绘里主体占 94%）
     视频高 = 0.94W × 360/248 = 1.277W → 视频宽 = 2.27W
     人物脚底在视频 326/360 处 → 视频底边再低于容器底 0.119W
     人物中心在视频 315/640 处 → 视频左边 = -0.711W

   ── 为什么原样播、不转码 ───────────────────────────────────────────
   试过裁到显示尺寸再编码：体积从 441KB 涨到 533KB（放大后细节变多，而且带 alpha
   必须 `-auto-alt-ref 0`，压缩率掉一截）。原片直接播、用 CSS 缩放更划算，
   也省掉一整条 ffmpeg 处理链。 */

/** 视频层贴进方形立绘容器的固定映射（百分比都以容器宽/高为准） */
const CLIP_STAGE = {
  position: 'absolute',
  left: '-71.09%',
  bottom: '-11.9%',
  width: '227%',
  height: 'auto',
  maxWidth: 'none',
} as const;

/** 头像框：同一段画面里只取头部那一块（220px 窗口 → 32px 圆） */
const CLIP_FACE = {
  position: 'absolute',
  left: '-49.1%',
  top: '-40.9%',
  width: '291%',
  height: 'auto',
  maxWidth: 'none',
} as const;

/**
 * 这台浏览器能不能播透明 webm。
 *
 * 不能的只有一类，但很致命：**Safari / iOS**。VP9-alpha 在 WebKit 上不认
 * alpha 平面，会渲染成一块黑底（不是"没有动画"，是"多了一个黑方块"）。
 * iOS 上 Chrome / Firefox 也都是 WebKit 内核，所以按设备判断而不是按 UA 品牌。
 */
let cachedSupport: boolean | null = null;

export function clipSupported(): boolean {
  if (cachedSupport !== null) return cachedSupport;
  cachedSupport = false;
  if (typeof document === 'undefined') return cachedSupport;
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    /* iPadOS 13+ 自称 MacIntel，只能靠触点数认出来 */
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  if (iOS || safari) return cachedSupport;
  try {
    const probe = document.createElement('video');
    cachedSupport = probe.canPlayType('video/webm; codecs="vp9"') !== '';
  } catch {
    cachedSupport = false;
  }
  return cachedSupport;
}

/**
 * 一层视频。挂载即播：静音 + playsInline 才允许自动播放。
 *
 * `ready` 的判定不用 `canplay`：那只说明"解码器能继续喂数据"，硬件叠加 /
 * 首帧真正合成往往还晚一两帧。提前淡入就会看到一次"半透明空帧"——
 * 这正是偶发闪屏的来源之一。改成等 `requestVideoFrameCallback`（第一帧上屏的
 * 确切时刻）再显形；没有这个 API 就用 rAF，再退一步用 `loadeddata` + 延时。
 * 三个兜底都在，自动播放被拦、后台标签页、rVFC 不回调，都不会让她永远透明。
 */
function Layer({
  url,
  visible,
  onReady,
  loop = true,
  onEnded,
  fadeMs,
}: {
  url: string;
  visible: boolean;
  onReady?: () => void;
  loop?: boolean;
  onEnded?: () => void;
  /** 淡入 / 淡出的时长；入场比出场快，见 PetClip 里的说明 */
  fadeMs: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  /* 真的能出画面了才让它显形：新层挂载时是透明的，否则会先黑一下再跳帧 */
  const [ready, setReady] = useState(false);
  const marked = useRef(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let alive = true;
    let frameCb: number | null = null;
    let delay = 0;

    const mark = () => {
      if (!alive || marked.current) return;
      marked.current = true;
      setReady(true);
      onReadyRef.current?.();
    };

    /** 等第一帧真的上屏；rVFC 不存在时退到下一帧 */
    const afterFrame = () => {
      if (!alive) return;
      if (typeof v.requestVideoFrameCallback === 'function') {
        frameCb = v.requestVideoFrameCallback(() => mark());
      } else {
        window.requestAnimationFrame(() => mark());
      }
      /* rVFC 在后台标签页 / 省电模式下可能一直不回调：600ms 后放行 */
      delay = window.setTimeout(mark, 600);
    };

    const onPlaying = () => afterFrame();
    /* 自动播放被拦时不会有 playing：首帧已解码就先铺上去，总比一直透明强 */
    const onLoaded = () => {
      if (v.paused) delay = window.setTimeout(mark, 240);
    };

    v.addEventListener('playing', onPlaying);
    v.addEventListener('loadeddata', onLoaded);
    /* effect 挂载时可能已经开播了（ref 里就先 play 了一次） */
    if (!v.paused && v.readyState >= 3) afterFrame();
    const safety = window.setTimeout(mark, 1600);

    return () => {
      alive = false;
      window.clearTimeout(delay);
      window.clearTimeout(safety);
      if (frameCb !== null && typeof v.cancelVideoFrameCallback === 'function') {
        v.cancelVideoFrameCallback(frameCb);
      }
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('loadeddata', onLoaded);
    };
  }, []);

  /* 切到后台标签页就暂停解码：桌宠在看不见的地方继续播 10 秒视频是纯浪费，
     回到前台再续上。视频每次都从 0 开始也没关系 —— 动作本来就是循环的。 */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onVis = () => {
      if (document.hidden) v.pause();
      else void v.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return (
    <video
      onEnded={onEnded}
      loop={loop}
      ref={(el) => {
        videoRef.current = el;
        if (!el) return;
        /* React 的 muted 属性时有时无地不落到 DOM 上，不静音就不给自动播放 */
        el.muted = true;
        void el.play().catch(() => { /* 被自动播放策略拦下就停在第一帧 */ });
      }}
      src={url}
      autoPlay
      muted
      playsInline
      preload="auto"
      aria-hidden
      draggable={false}
      className={cls(
        'pointer-events-none absolute select-none transition-opacity ease-out',
        visible && ready ? 'opacity-100' : 'opacity-0',
      )}
      /* will-change：让浏览器提前把这两层提到独立合成层。alpha 视频在
         opacity 过渡时偶尔会重栅格化一次，表现就是一帧发灰 */
      style={{ ...CLIP_STAGE, transitionDuration: `${fadeMs}ms`, willChange: 'opacity' }}
    />
  );
}

/**
 * 一段动画 = 一个 `pose`。
 *
 * 切换靠"叠层 + 真交叉淡入"，各条各解决一个问题：
 *  1. **新层等第一帧上屏再显形**（`Layer` 里 `visible && ready`）。不是等
 *     `canplay` —— 那之后硬件叠加还可能晚一两帧，提前淡入就是一次半透明空帧。
 *  2. **旧层不卸载、只淡出**。它保持挂载继续播，等新层真的出画了才淡到 0 ——
 *     期间画面上始终有东西，看不出缝隙。
 *  3. **换 src 挂新层，但切回还挂着的那一层就复用它**（连点、动作放完回姿势）。
 *     新建 `<video>` 要重新加载、从第 0 帧开始；两次切换挨得近时，
 *     那一下就是"空一下再跳回来"。
 *  4. **入场比出场快**（200ms / 360ms）。两层都半透明时合成后的整体不透明度
 *     会掉到 0.75 左右，看着像暗了一拍；让新层先到位就能把这个谷填平。
 *  5. **最多两层**。连切时三层叠着 = 三份半透明，闪得更明显。
 *  6. **首图只在第一段还没解出来时铺一次**。之后切换不再拿静态图盖住旧画面。
 */
type LayerEntry = {
  id: number;
  url: string;
  /** 是否该出现在画面里。旧层在新层出画前保持 true，之后才转 false 去淡出 */
  on: boolean;
  /** 开始淡出的时刻，用来计算何时可以从 DOM 摘掉 */
  offAt: number;
};

const FADE_IN = 200;
const FADE_OUT = 360;
/** 淡出 360ms，留 60ms 余量再从 DOM 摘掉 */
const RETAIN = 420;

export function PetClip({
  src,
  poster,
  loop = true,
  onEnded,
}: {
  src: string;
  poster?: string;
  loop?: boolean;
  onEnded?: () => void;
}) {
  const seq = useRef(0);
  const curUrl = useRef(src);
  const [layers, setLayers] = useState<LayerEntry[]>(() => [{ id: 0, url: src, on: true, offAt: 0 }]);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  /* 已经出过画面的层：被重新点亮时不必再等一帧，也不会先透明一下 */
  const painted = useRef(new Set<number>());
  const [readyId, setReadyId] = useState<number | null>(null);
  /* 首帧图只是"冷启动垫片"，一次就够，之后不该再出现 */
  const [posterOn, setPosterOn] = useState(true);

  useEffect(() => {
    if (src === curUrl.current) return;
    curUrl.current = src;
    const cur = layersRef.current;
    const now = Date.now();
    const hit = cur.find((l) => l.url === src);
    if (hit) {
      /* 切回仍然挂着的那一层：把它挪到最后点亮，不再新建 <video>，
         也就不会重新走一遍加载、从第 0 帧跳回来 */
      const revivedReady = painted.current.has(hit.id);
      setLayers((ls) => [
        ...ls
          .filter((l) => l.id !== hit.id)
          /* 复用的那一层如果还没出过画，就不能先把垫片关掉 —— 否则
             会有几十毫秒画面全透明。等它 ready 再由上面那个 effect 统一切 */
          .map((l) => (revivedReady && l.on ? { ...l, on: false, offAt: now } : l))
          .slice(-4),
        { ...hit, on: true, offAt: 0 },
      ]);
      setReadyId(revivedReady ? hit.id : null);
      return;
    }
    const id = seq.current + 1;
    seq.current = id;
    /* 旧层保持 on：新层出画之前它一直顶着画面，所以连切时也不会黑一下。
       顺手丢掉"还没出过画"的 on 层（它一直是透明的，留着只是多一个解码器）；
       正在淡出的 off 层不能丢 —— 它此刻可能还有一半不透明度，摘掉就是一次硬切 */
    setLayers((ls) => [
      ...ls.filter((l) => !l.on || painted.current.has(l.id)).slice(-4),
      { id, url: src, on: true, offAt: 0 },
    ]);
    /* 新层能出画之前，旧层继续顶着画面，所以这里只重置"谁已就绪" */
    setReadyId(null);
  }, [src]);

  const curId = layers[layers.length - 1].id;
  const curReady = readyId === curId;

  /* 新层真的出画了 → 其余各层才开始淡出。之前一直保持 on，
     所以这段等待期里画面是连续的，不会出现"旧层已经走了、新层还没来" */
  useEffect(() => {
    if (!curReady) return;
    const now = Date.now();
    setLayers((ls) => ls.map((l) => (l.id === curId || !l.on ? l : { ...l, on: false, offAt: now })));
  }, [curReady, curId]);

  /* 淡出完成再从 DOM 摘掉。摘除时机按每层自己的 offAt 算，
     不按"最后一次切换"算 —— 连切时先淡的那层不该被后一次切换拖着 */
  useEffect(() => {
    const off = layers.filter((l) => !l.on);
    if (!off.length) return;
    const due = Math.min(...off.map((l) => l.offAt + RETAIN));
    const t = window.setTimeout(() => {
      const now = Date.now();
      setLayers((ls) => ls.filter((l) => l.on || now - l.offAt < RETAIN));
    }, Math.max(20, due - Date.now()));
    return () => window.clearTimeout(t);
  }, [layers]);

  return (
    /* 裁切框：视频按 227% 放大后四周都是透明像素，不裁也不会挡视线，
       但会白白多出一片合成区域 —— 裁掉最省 */
    <span className="absolute inset-0 block overflow-hidden">
      {poster && posterOn ? (
        <img
          src={poster}
          alt=""
          aria-hidden
          draggable={false}
          className={cls(
            'pointer-events-none absolute inset-0 h-full w-full select-none transition-opacity duration-300 ease-out',
            curReady ? 'opacity-0' : 'opacity-100',
          )}
        />
      ) : null}
      {layers.map((l, i) => {
        const latest = i === layers.length - 1;
        return (
          <Layer
            key={l.id}
            url={l.url}
            /* on 由切换逻辑维护：旧层一直亮着，等新层出画才转 false */
            visible={l.on}
            loop={latest ? loop : true}
            fadeMs={latest ? FADE_IN : FADE_OUT}
            /* 每一层都报"出画了"：非最新的层先报，等它被切回来时才知道
               可以直接点亮，不必再等一次首帧 */
            onReady={() => {
              painted.current.add(l.id);
              if (latest) {
                setReadyId(l.id);
                setPosterOn(false);
              }
            }}
            onEnded={latest ? onEnded : undefined}
          />
        );
      })}
    </span>
  );
}

/** 头像版本的同一段动画（唤回按钮用）。取脸那块，别把整只塞进 32px 圆 */
export function PetClipFace({ src, size }: { src: string; size: number }) {
  return (
    <span
      className="relative block overflow-hidden rounded-full"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <video
        ref={(el) => {
          if (!el) return;
          el.muted = true;
          void el.play().catch(() => {});
        }}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        draggable={false}
        className="pointer-events-none absolute select-none"
        style={CLIP_FACE}
      />
    </span>
  );
}
