import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cls } from '@/lib/format';

/* ── 滑动高亮块 ─────────────────────────────────────────────────────────
   导航里的「当前项」不再各自画一层背景，而是共享**一块**圆角底：
   换页时它滑到新位置，并且尺寸永远等于目标项（不是写死的宽高）。

   为什么拆成「测量」和「落位」两步，而不是直接用 CSS 动画 width/height/top：
   · 动 width/height/top/left 每一帧都要重新布局，一条十几项的导航跟着一起重排，
     在手机上会明显发涩；而且这些属性不参与合成，动画只能跑在主线程上。
   · 所以这里走 FLIP：目标盒子的宽高**直接写死**成量到的尺寸（所以它和目标项
     严丝合缝），转换过程则用 `translate + scale` 还原出「上一项」的样子再切回目标 ——
     整段动画只碰 transform，交给合成器。
   ──────────────────────────────────────────────────────────────────────── */

/** 相对容器内容区的盒子。x/y 已经算进滚动偏移，所以容器滚了它也不会错位。 */
export type SlideBox = { x: number; y: number; w: number; h: number };

/**
 * 量出当前项在容器里的位置与尺寸。
 *
 * 用 `data-slide-key` 属性找目标而不是传一堆 ref：
 * 导航项是 NavLink 的渲染回调里生成的，把 ref 一条条透传下去反而更绕；
 * 属性查找与 DOM 顺序无关，加项删项都不用改这里。
 *
 * 用 useLayoutEffect 而不是 useEffect：后者在浏览器画过一帧之后才跑，
 * 那一帧里高亮块还不在位置上，会看到它"跳"一下才出现。
 */
export function useSlideBox(
  containerRef: RefObject<HTMLElement>,
  activeKey: string,
  /** 四周内缩多少像素。小屏底部导航要给圆角块留一圈呼吸，不然会顶满整格 */
  inset = 0,
): SlideBox | null {
  const [box, setBox] = useState<SlideBox | null>(null);

  useLayoutEffect(() => {
    const wrap = containerRef.current;
    if (!wrap) return;

    const measure = () => {
      const el = Array.from(wrap.querySelectorAll<HTMLElement>('[data-slide-key]')).find(
        (n) => n.getAttribute('data-slide-key') === activeKey,
      );
      if (!el) return setBox(null);
      const c = wrap.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      /* 容器被 display:none 藏起来时（左轨在手机上、底部导航在桌面上）
         量出来是 0×0。这时别落位 —— 否则会留一个零尺寸的块，
         再切回来时它得从左上角飞过去 */
      if (!r.width || !r.height) return setBox(null);
      /* clientLeft / clientTop 就是容器的左边框、上边框宽度：绝对定位的
         包含块是**内边距盒**，而 getBoundingClientRect 给的是边框盒，
         两者差这一道边框。底部导航有条 1px 的上边框，不扣掉块会低 1px */
      setBox({
        x: r.left - c.left + wrap.scrollLeft - wrap.clientLeft + inset,
        y: r.top - c.top + wrap.scrollTop - wrap.clientTop + inset,
        w: r.width - inset * 2,
        h: r.height - inset * 2,
      });
    };

    measure();
    /* 容器尺寸会变（窗口缩放、底部安全区变化）；窗口 resize 兜住
       ResizeObserver 在某些浏览器里对 display 切换不报的情形 */
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [containerRef, activeKey, inset]);

  return box;
}

/**
 * 高亮块本体。放在导航容器里（容器需 position: relative），
 * 导航项自己带 z-10 就能压在上面。
 *
 * 缓动写在 index.css 的 .slide-highlight 里：一次约 7% 的单次过冲弹簧。
 */
export function SlideHighlight({ box, className }: { box: SlideBox | null; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  /** 上一次的盒子 = 动画的起点 */
  const prev = useRef<SlideBox | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (!box) {
      /* 目标不存在（当前页不在导航里、或容器被藏起来了）。
         必须清掉 prev，否则下次出现会从上次的位置滑过来 */
      prev.current = null;
      el.style.opacity = '0';
      return;
    }

    const from = prev.current;
    prev.current = box;
    el.style.opacity = '1';
    // 宽高直接取目标项的尺寸：块和目标项始终严丝合缝，尺寸差靠 scale 补
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;

    if (!from) {
      /* 首次落位不播动画 —— 否则会从容器左上角一路飞过来 */
      el.style.transition = 'none';
      el.style.transform = `translate(${box.x}px, ${box.y}px) scale(1, 1)`;
      const id = requestAnimationFrame(() => {
        el.style.transition = '';
      });
      return () => cancelAnimationFrame(id);
    }

    /* FLIP。transform-origin 是左上角，所以「还原上一项」就是
       translate 到它的位置 + 按尺寸比例缩放，不用再补中心点偏移。 */
    el.style.transition = 'none';
    el.style.transform = `translate(${from.x}px, ${from.y}px) scale(${from.w / box.w}, ${from.h / box.h})`;
    // 结算一次布局，让浏览器把已经被倒放的那一帧认作动画起点
    void el.offsetWidth;
    el.style.transition = '';
    el.style.transform = `translate(${box.x}px, ${box.y}px) scale(1, 1)`;
    return undefined;
  }, [box]);

  return (
    <span
      ref={ref}
      aria-hidden
      className={cls('slide-highlight pointer-events-none absolute left-0 top-0 origin-top-left', className)}
    />
  );
}
