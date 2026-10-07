import { useState, type DragEvent } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical } from 'lucide-react';
import { cls } from '@/lib/format';

/**
 * 列表排序的共用实现：工具箱的分类、工具箱的磁贴墙、设置里的搜索引擎都用它。
 *
 * 给两条路，因为拖拽不是人人可用：
 * · **拖抓手**（HTML5 DnD）是主路径，阔屏顺手；
 * · **上/下箭头**兜住触屏与键盘 —— 触屏压根没有 HTML5 拖拽，
 *   键盘用户也没法"拖"，只做拖拽等于把这两类人挡在门外。
 *
 * 抽出来的理由和 streamSse 那条一样：这套"拖动-落点-提交"里有几个
 * 容易写错的地方（落点要按光标落在目标行的上/下半区决定插前还是插后、
 * 拖拽中不能把落点算到自己身上、松手后必须清状态），复制两份迟早分叉。
 *
 * 数据形态刻意只认 **id 顺序**：调用方拿到新顺序后自己决定是立刻落库
 * （工具箱）还是只改草稿、等点保存（设置页）。
 *
 * `axis` 是给"横排的磁贴墙"用的：一列一列的列表按光标在行的上/下半区
 * 判断插前插后（纵向），而磁贴是一行一排在扫的，同样的判断要按
 * 左/右半区来做（横向）。两种落点方向共用一个实现，差别只有"读 clientX
 * 还是 clientY"和指示线画横还是画竖，没必要各写一套。
 */
export type RowReorder = {
  /** 少于两项就没什么可排的：抓手置灰、箭头自然都禁用 */
  canSort: boolean;
  /** 该行此刻是不是落点；是就给出"插到它前面还是后面"，其余情况为 null */
  marker: (id: string) => { after: boolean } | null;
  /** 上 / 下移一格（键盘与触屏的入口） */
  move: (index: number, delta: number) => void;
  /** 挂在行容器上：接落点 */
  rowProps: (id: string) => {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  /** 挂在抓手元素上：起拖 */
  handleProps: (id: string) => {
    draggable: boolean;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
};

/**
 * @param ids       当前顺序（同一次拖拽内要保持稳定，直接由渲染数据算出来即可）
 * @param onReorder 新顺序 + **被挪动的那一项的 id**。第二个参数不是可选的：
 *                  磁贴墙要拿它判断"这一张是不是夹到了别的分类里"，
 *                  从而决定要不要顺带改分类 —— 只看顺序本身看不出是谁动了
 * @param axis      'y' 纵向列表（默认）；'x' 横向磁贴墙
 */
export function useRowReorder(
  ids: string[],
  onReorder: (nextIds: string[], movedId: string) => void,
  axis: 'y' | 'x' = 'y',
): RowReorder {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);

  const reset = () => {
    setDragId(null);
    setDrop(null);
  };

  const commit = () => {
    const from = dragId;
    const target = drop;
    reset();
    if (!from || !target || from === target.id) return;
    const next = ids.filter((id) => id !== from);
    const at = next.indexOf(target.id);
    if (at < 0) return;
    next.splice(target.after ? at + 1 : at, 0, from);
    onReorder(next, from);
  };

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    const next = ids.slice();
    const [id] = next.splice(index, 1);
    next.splice(to, 0, id);
    onReorder(next, id);
  };

  return {
    canSort: ids.length > 1,
    // 落点不算自己：拖到自己身上不该画出任何指示线
    marker: (id) => (dragId && drop?.id === id && dragId !== id ? drop : null),
    move,
    rowProps: (id) => ({
      onDragOver: (e) => {
        if (!dragId || dragId === id) return;
        // 不 preventDefault 就不会触发 drop —— 这一句是"能放到这儿"的开关
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        setDrop({
          id,
          after: axis === 'x' ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2,
        });
      },
      onDrop: (e) => {
        e.preventDefault();
        commit();
      },
    }),
    handleProps: (id) => ({
      draggable: ids.length > 1,
      onDragStart: (e) => {
        // 只带 id：落到哪儿由放置方决定，不写死在拖拽数据里
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        setDragId(id);
      },
      onDragEnd: reset,
    }),
  };
}

/**
 * 抓手。**它应该是整行里唯一可拖的地方**：把 draggable 挂在整行上，
 * 行内的输入框就没法选词了 —— 想改个名字会先把这一行拖走。
 *
 * aria-hidden：它只是个鼠标手势的把手，读屏用户用旁边的上/下箭头，
 * 那里才有可访问名称。
 */
export function DragHandle({
  sortable,
  id,
  title = '拖动调整顺序',
  className,
}: {
  sortable: RowReorder;
  id: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      {...sortable.handleProps(id)}
      aria-hidden
      title={sortable.canSort ? title : undefined}
      className={cls(
        'shrink-0 p-0.5 text-faint transition-colors',
        sortable.canSort ? 'cursor-grab hover:text-muted active:cursor-grabbing' : 'opacity-40',
        className,
      )}
    >
      <GripVertical size={14} />
    </span>
  );
}

/**
 * 前/后移动一格。禁用态而不是隐藏：位置是固定的，按钮不该在列表里跳来跳去。
 *
 * 纵向列表里它是"上移/下移"，横向磁贴墙里同一件事叫"前移/后移" ——
 * 名字得跟着阅读方向走，对着一个横排说"上移"没人知道是往哪边。
 */
export function MoveButtons({
  sortable,
  index,
  count,
  label,
  className,
  axis = 'y',
}: {
  sortable: RowReorder;
  index: number;
  count: number;
  /** 可访问名称里的对象名，如「引擎 百度」 */
  label: string;
  className?: string;
  axis?: 'y' | 'x';
}) {
  const btn =
    'rounded-field p-1 text-faint transition-colors hover:bg-bg-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint';
  const back = axis === 'x' ? '前移' : '上移';
  const next = axis === 'x' ? '后移' : '下移';
  return (
    <span className={cls('flex shrink-0 items-center', className)}>
      <button
        type="button"
        onClick={() => sortable.move(index, -1)}
        disabled={index === 0}
        aria-label={`${back}「${label}」`}
        title={back}
        className={btn}
      >
        {axis === 'x' ? <ChevronLeft size={13} aria-hidden /> : <ChevronUp size={13} aria-hidden />}
      </button>
      <button
        type="button"
        onClick={() => sortable.move(index, 1)}
        disabled={index === count - 1}
        aria-label={`${next}「${label}」`}
        title={next}
        className={btn}
      >
        {axis === 'x' ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
      </button>
    </span>
  );
}

/**
 * 落点指示线。只标"这一项是落点"不够 —— 分不出会落在它前面还是后面，
 * 所以线贴着那一侧的边画：纵向列表画在上/下缘，横向磁贴墙画在左/右缘。
 * 容器要有 relative。
 */
export function DropMarker({ at, axis = 'y' }: { at: { after: boolean } | null; axis?: 'y' | 'x' }) {
  if (!at) return null;
  return (
    <span
      aria-hidden
      className={cls(
        'pointer-events-none absolute rounded-full bg-accent',
        axis === 'x'
          ? cls('inset-y-0 w-0.5', at.after ? 'right-0' : 'left-0')
          : cls('inset-x-0 h-0.5', at.after ? 'bottom-0' : 'top-0'),
      )}
    />
  );
}

/** 按给定的 id 顺序重排一份列表。对不上的 id 丢掉，不会凭空造出条目 */
export function orderById<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const byId = new Map(list.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)).filter((x): x is T => Boolean(x));
}
