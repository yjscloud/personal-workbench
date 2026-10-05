import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronsRight } from 'lucide-react';
import { cls } from '@/lib/format';

/* ────────────────────────────────────────────────────────────────────────
 * 拖动滑块验证（样式照参考图：左侧方块滑块 + 轨道中间一行提示）
 *
 * 必须说清楚的定位：**这是个人机"减速带"，不是安全措施。**
 * 判断完全在浏览器里跑，脚本绕过它只需要一行代码；真正的门是服务端的
 * 账号密码 + 登录失败限速。它的价值是挡住无脑提交、并且让登录这一步
 * 有明确的"人来了"的交互确认。
 *
 * 三个实现要点：
 *   · 三种输入方式都要能用：鼠标、触摸（touch-none 防止拖动时页面跟着滚）、
 *     以及键盘 —— 只支持拖动会挡住只能键盘操作的人
 *     （WCAG 2.5.7：凡是拖动完成的操作，都要有非拖动的等价方式，
 *      这里是方向键 / Home / End / 回车直接完成）。
 *   · 到位判定留 2px 容差：手指拖到底时常常差一两个像素，
 *     卡在 99% 上会让人反复来回拖。
 *   · 位移只用 transform 推进，不碰 left/width：拖动这条路径不能触发布局，
 *     否则手感会明显发黏。
 * ──────────────────────────────────────────────────────────────────────── */

const THUMB = 44; // 滑块边长，同时也是最小触摸目标
const STEP = 24; // 键盘一次挪多远
const SLACK = 2; // 到位容差

export function DragVerify({ onVerified, className }: { onVerified: () => void; className?: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(0); // 与 x 同步的即时值：pointerup 里读 state 会拿到上一帧
  const startRef = useRef(0);
  const originRef = useRef(0);

  const [width, setWidth] = useState(0);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);

  const max = Math.max(0, width - THUMB);
  const pct = max ? Math.round((x / max) * 100) : 0;

  /* 轨道宽度变化（窗口缩放、侧栏折叠）要重新量，否则"拖到头"的位置会错 */
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const move = useCallback((next: number) => {
    posRef.current = next;
    setX(next);
  }, []);

  const finish = useCallback(() => {
    setDone((prev) => {
      if (prev) return prev;
      onVerified();
      return true;
    });
    posRef.current = 1e6; // 由 done 接管渲染位置
  }, [onVerified]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (done) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = e.clientX;
    originRef.current = posRef.current;
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || done) return;
    move(Math.max(0, Math.min(max, originRef.current + (e.clientX - startRef.current))));
  };

  const onPointerUp = () => {
    if (!dragging || done) return;
    setDragging(false);
    if (max && posRef.current >= max - SLACK) finish();
    else move(0); // 没拖到底就弹回去，不给"半路松手也算过"的口子
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (done) return;
    const cur = posRef.current;
    const jump = (next: number) => {
      e.preventDefault();
      move(next);
      if (max && next >= max) finish();
    };
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') jump(Math.min(max, cur + STEP));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') jump(Math.max(0, cur - STEP));
    else if (e.key === 'Home') jump(0);
    else if (e.key === 'End') jump(max);
    // 非拖动的等价操作：聚焦滑块后按回车/空格直接完成验证
    else if (e.key === 'Enter' || e.key === ' ') jump(max);
  };

  return (
    <div
      ref={trackRef}
      className={cls(
        'relative h-11 select-none overflow-hidden rounded-field border transition-colors duration-200',
        done ? 'border-ok/40 bg-ok-soft' : 'border-line bg-bg-2',
        className,
      )}
    >
      <span
        aria-hidden
        className={cls(
          'pointer-events-none absolute inset-0 grid place-items-center text-[13px] font-medium transition-opacity duration-200',
          done ? 'text-ok' : 'text-muted',
          dragging ? 'opacity-0' : 'opacity-100',
        )}
      >
        {done ? '验证完成' : '请拖动滑块完成验证'}
      </span>

      <div
        role="slider"
        aria-label="拖动滑块完成验证"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={done ? 100 : pct}
        aria-valuetext={done ? '已验证' : '未验证'}
        aria-disabled={done}
        tabIndex={done ? -1 : 0}
        title={done ? '已验证' : '按住拖动到最右侧；也可以聚焦后用方向键或回车完成'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        style={{ transform: `translateX(${done ? max : x}px)` }}
        className={cls(
          'absolute left-0 top-0 grid h-11 w-11 touch-none place-items-center rounded-field border',
          dragging ? 'transition-none' : 'transition-transform duration-300 ease-smooth',
          done
            ? 'cursor-default border-ok/40 bg-ok text-white'
            : 'cursor-grab border-line bg-panel text-faint hover:text-accent active:cursor-grabbing',
        )}
      >
        {done ? <Check size={17} /> : <ChevronsRight size={17} />}
      </div>
    </div>
  );
}
