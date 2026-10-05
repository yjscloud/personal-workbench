import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListChecks,
  MessageSquare,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tags,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '@/lib/store';
import {
  api,
  type ChecklistItem,
  type Priority,
  type Project,
  type ProjectSection,
  type Ticket,
  type TicketAttachment,
  type TicketComment,
  type TicketStatus,
} from '@/lib/api';
import { cls, daysUntil, fmtBytes, fmtDate, fmtRelative } from '@/lib/format';
import { Button, Empty, Field, Input, Meter, Segmented, Select, Skeleton, Spinner, Textarea } from '@/components/ui';
import { ProjectBoard } from '@/components/ProjectBoard';
import {
  ADVANCE_LABEL,
  REVERT_LABEL,
  STATUS_FLOW,
  isAdjacent,
  nextStatus,
  prevStatus,
} from '@/lib/workflow';
import { PRIORITY_META, PriorityBadge, STATUS_META, Tag } from '@/components/bits';

/* ── 常量 ─────────────────────────────────────────────────────────── */
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const STATUSES: TicketStatus[] = ['todo', 'doing', 'review', 'done'];
const ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const NO_PROJECT = '__none__';
/** 项目下拉里的「新建」哨兵值：选到它就切到输入态 */
const NEW_PROJECT = '__new__';
const NO_DUE = '9999';

type Scope = 'week' | 'all';
type View = 'list' | 'board';
/** 生命周期视图：进行中 / 已归档 / 回收站 */
type Bucket = 'active' | 'archived' | 'trash';
/** 看板列内的二次分组（泳道） */
type LaneBy = 'none' | 'owner' | 'priority';
type TimeFilter = 'all' | 'overdue' | 'today' | 'week';
type SortKey = 'smart' | 'due' | 'priority' | 'created';

const STATUS_COLOR: Record<TicketStatus, string> = {
  todo: 'var(--faint)',
  doing: 'var(--accent-2)',
  review: 'var(--warn)',
  done: 'var(--ok)',
};

const SORT_LABEL: Record<SortKey, string> = {
  smart: '智能排序',
  due: '按截止时间',
  priority: '按优先级',
  created: '按创建时间',
};

const TIME_LABEL: Record<Exclude<TimeFilter, 'all'>, string> = {
  overdue: '逾期',
  today: '今天',
  week: '7 天内',
};

const BUCKET_LABEL: Record<Bucket, string> = {
  active: '进行中',
  archived: '已归档',
  trash: '回收站',
};

const LANE_LABEL: Record<LaneBy, string> = {
  none: '不分组',
  owner: '按负责人',
  priority: '按优先级',
};

const lifecycleKindOf = (t: Ticket): 'active' | 'archived' | 'trash' =>
  t.deletedAt ? 'trash' : t.archivedAt ? 'archived' : 'active';

/**
 * 列表的列宽（lg 起生效）：勾选区 / 任务 / 负责人 / 优先级 / 截止 / 进度 / 菜单。
 * 表头与每个数据行共用这一份定义 —— 只要有一处各写各的，整列就会错开。
 */
const LIST_GRID = 'lg:grid-cols-[3.25rem_minmax(0,1fr)_5.5rem_4.5rem_6rem_4.5rem_2rem]';

/* ── 备注 / 评论里的内联图片 ───────────────────────────────────────────
 * 正文里只放 `![名字](att:附件ID)` 这样的引用，图片本体仍在附件表里（data URL）。
 * 不直接把 data URL 写进正文，是因为备注是 VARCHAR(1000)、评论是 TEXT —— 塞不下，
 * 所以引用 + 按 id 还原是唯一稳的做法。
 * ──────────────────────────────────────────────────────────────────── */

const IMAGE_MARKUP = /!\[([^\]]*)\]\(att:([A-Za-z0-9_-]+)\)/g;

/**
 * 列表 / 卡片上的备注摘要。`![名字](att:ID)` 是存储格式，
 * 直接塞进摘要里就成了用户看不懂的源码串 —— 压成一个「图片」标记，
 * 既保留"这里还有一张图"的信息，又不把内部格式漏出去。
 */
function noteSummary(note: string): string {
  // 图片单独计数：连续几张压成「3 张图片」，比 [图片][图片][图片] 好读
  const images = (note.match(IMAGE_MARKUP) || []).length;
  const text = note.replace(IMAGE_MARKUP, ' ').replace(/\s+/g, ' ').trim();
  const tag = images ? `${images} 张图片` : '';
  return [text, tag].filter(Boolean).join(text && tag ? ' · ' : '');
}

type RichPart = { type: 'text'; text: string } | { type: 'image'; alt: string; id: string };

function splitRichText(text: string): RichPart[] {
  const out: RichPart[] = [];
  let last = 0;
  IMAGE_MARKUP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_MARKUP.exec(text))) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'image', alt: m[1], id: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.length ? out : [{ type: 'text', text }];
}

/**
 * 渲染带内联图片的正文。图片从当前任务的附件列表里按 id 取，
 * 所以不额外发请求；附件被删掉时显示一行说明，而不是留一张裂图。
 */
function RichText({
  text,
  attachments,
  onPreview,
  className,
}: {
  text: string;
  attachments: TicketAttachment[];
  onPreview?: (url: string, name: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      {splitRichText(text).map((part, i) => {
        if (part.type === 'text') {
          return (
            <span key={i} className="whitespace-pre-wrap">
              {part.text}
            </span>
          );
        }
        const file = attachments.find((a) => a.id === part.id);
        if (!file) {
          return (
            <span key={i} className="text-faint">
              [附件已删除]
            </span>
          );
        }
        // 非图片附件（日志、配置）就显示个名字，点附件区可以下载
        if (!file.mime.startsWith('image/')) {
          return (
            <span key={i} className="font-medium text-accent">
              {part.alt || file.name}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onPreview?.(file.content, part.alt || file.name)}
            title="点击放大"
            className="my-1.5 block max-w-full cursor-zoom-in"
          >
            <img
              src={file.content}
              alt={part.alt || file.name}
              loading="lazy"
              className="max-h-72 max-w-full rounded-field border border-line object-contain"
            />
          </button>
        );
      })}
    </div>
  );
}

/* ── 编辑态：把图片引用从正文里摘出来 ─────────────────────────────────
 * 存储格式是 `![名字](att:ID)`，但那串东西不该出现在编辑框里 —— 用户粘贴一张
 * 截图后看到满屏 `![image.png](att:att_muth8bdg03w4r)` 只会困惑。
 * 所以编辑框只给「纯文字」，图片以缩略块列在下面；存取时用下面两个函数来回转。
 * 位置信息会退化（图片统一排在正文之后），换来的是编辑器永远干净。
 * ──────────────────────────────────────────────────────────────────── */

type ImageRef = { alt: string; id: string };

function splitNote(note: string): { text: string; refs: ImageRef[] } {
  const refs: ImageRef[] = [];
  const text = note.replace(IMAGE_MARKUP, (_m, alt: string, id: string) => {
    refs.push({ alt, id });
    return '';
  });
  // 引用被摘掉后会留下孤零零的空行，压掉，编辑框里才干净
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), refs };
}

function joinNote(text: string, refs: ImageRef[]): string {
  const body = text.replace(/\s+$/, '');
  const tail = refs.map((r) => `![${r.alt}](att:${r.id})`).join('\n');
  return tail ? `${body}${body ? '\n' : ''}${tail}` : body;
}

/** 往正文末尾追加图片引用 */
function appendImageRefs(note: string, adds: ImageRef[]): string {
  const { text, refs } = splitNote(note);
  return joinNote(text, [...refs, ...adds]);
}

function weekRange() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return [monday, sunday] as const;
}

const projectKeyOf = (t: Ticket) => (t.project?.trim() ? t.project.trim() : NO_PROJECT);

/** 排序规则集中在一处，列表与看板共用 */
function compareTickets(a: Ticket, b: Ticket, sort: SortKey): number {
  if (sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
  if (sort === 'priority') return ORDER[a.priority] - ORDER[b.priority] || (a.due || NO_DUE).localeCompare(b.due || NO_DUE);
  if (sort === 'due') return (a.due || NO_DUE).localeCompare(b.due || NO_DUE);
  const doneDiff = Number(a.status === 'done') - Number(b.status === 'done');
  if (doneDiff !== 0) return doneDiff;
  const pDiff = ORDER[a.priority] - ORDER[b.priority];
  if (pDiff !== 0) return pDiff;
  return (a.due || NO_DUE).localeCompare(b.due || NO_DUE);
}

function matchTime(t: Ticket, filter: TimeFilter): boolean {
  if (filter === 'all') return true;
  const days = daysUntil(t.due);
  if (filter === 'overdue') return t.status !== 'done' && days !== null && days < 0;
  if (filter === 'today') return t.status !== 'done' && days === 0;
  return days !== null && days >= 0 && days <= 7;
}

/* ══════════════════════════════════════════════════════════════════
   页面
   ══════════════════════════════════════════════════════════════════ */
export default function Week() {
  const { tickets, ticketsApi, projects, projectsApi, ready } = useStore();

  // 页面既然叫「任务」，默认就不该只盯着本周 —— 想回到只看本周，右上角一切即可
  const [scope, setScope] = useState<Scope>('all');
  const [view, setView] = useState<View>('list');
  const [bucket, setBucket] = useState<Bucket>('active');
  const [laneBy, setLaneBy] = useState<LaneBy>('none');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('smart');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<TicketStatus, boolean>>({ todo: false, doing: false, review: false, done: false });
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * ?open=<id> 是一次性入口：进来后立刻把它从地址栏摘掉。
   * 留着的话，之后任何一次 store 更新（改项目名会连带刷任务、删项目会清归属）
   * 都会让 effect 重跑，把用户已经关掉的任务弹窗又弹出来。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (!ready) return;
    const target = searchParams.get('open');
    if (!target) return;
    setSearchParams({}, { replace: true });
    if (tickets.some((t) => t.id === target)) setOpenId(target);
  }, [ready, searchParams, setSearchParams, tickets]);
  const [creating, setCreating] = useState<TicketStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 彻底删除前的确认。不可恢复的操作不能一点就走 */
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [undo, setUndo] = useState<{ id: string; prev: TicketStatus; title: string } | null>(null);

  const [mon, sun] = weekRange();

  /* 生命周期：进行中 / 已归档 / 回收站。
     归档与回收站里不再套「本周」范围 —— 否则刚归档的任务会因为截止时间不在
     本周而"消失"，看着像归档没生效。 */
  const bucketed = useMemo(() => {
    if (bucket === 'archived') return tickets.filter((t) => !t.deletedAt && t.archivedAt);
    if (bucket === 'trash') return tickets.filter((t) => t.deletedAt);
    return tickets.filter((t) => !t.deletedAt && !t.archivedAt);
  }, [tickets, bucket]);

  /* 范围：本周只看本周相关的（无截止的未完成也算在内，避免漏事） */
  const scoped = useMemo(() => {
    if (scope === 'all' || bucket !== 'active') return bucketed;
    return bucketed.filter((t) => {
      if (!t.due) return t.status !== 'done';
      const d = new Date(t.due);
      return d >= mon && d <= sun;
    });
  }, [bucketed, scope, bucket, mon, sun]);

  /* 项目统计：项目实体本身来自 store（可新建 / 改名 / 删除），这里只算每条有多少任务。
     与实体分开是必要的 —— 空项目在"从任务聚合"的清单里根本不会出现，
     而 Tower 式的用法恰恰是先建项目、再往里放任务。 */
  const projectStats = useMemo(() => {
    const map = new Map<string, { total: number; open: number }>();
    for (const t of scoped) {
      const key = projectKeyOf(t);
      const entry = map.get(key) ?? { total: 0, open: 0 };
      entry.total += 1;
      if (t.status !== 'done') entry.open += 1;
      map.set(key, entry);
    }
    return map;
  }, [scoped]);

  const owners = useMemo(() => [...new Set(scoped.map((t) => t.owner?.trim()).filter(Boolean) as string[])].sort(), [scoped]);

  /** 标签候选从全部任务里收集：只按当前范围收集的话，筛掉一批就找不到别的标签了 */
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of tickets) for (const tag of t.tags || []) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [tickets]);

  /* 顶部计数：都基于当前范围，不受时间/优先级筛选影响 */
  const counts = useMemo(() => {
    const open = scoped.filter((t) => t.status !== 'done');
    return {
      overdue: open.filter((t) => {
        const d = daysUntil(t.due);
        return d !== null && d < 0;
      }).length,
      today: open.filter((t) => daysUntil(t.due) === 0).length,
      urgent: open.filter((t) => t.priority === 'P0' || t.priority === 'P1').length,
      done: scoped.filter((t) => t.status === 'done').length,
      total: scoped.length,
      open: open.length,
    };
  }, [scoped]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scoped
      .filter((t) => {
        if (projectFilter !== 'all' && projectKeyOf(t) !== projectFilter) return false;
        if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
        if (ownerFilter !== 'all' && (t.owner?.trim() || '') !== ownerFilter) return false;
        if (tagFilter !== 'all' && !(t.tags || []).includes(tagFilter)) return false;
        if (!matchTime(t, timeFilter)) return false;
        if (q && !`${t.id} ${t.title} ${t.project} ${t.owner} ${t.note} ${(t.tags || []).join(' ')}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => compareTickets(a, b, sort));
  }, [scoped, projectFilter, priorityFilter, ownerFilter, tagFilter, timeFilter, query, sort]);

  const grouped = useMemo(() => STATUSES.map((status) => ({ status, items: visible.filter((t) => t.status === status) })), [visible]);

  /* 看板拖拽落点只拿到 id，用这张表反查任务 */
  const byId = useMemo(() => new Map(visible.map((t) => [t.id, t])), [visible]);

  const filtersActive =
    projectFilter !== 'all' ||
    priorityFilter !== 'all' ||
    ownerFilter !== 'all' ||
    tagFilter !== 'all' ||
    timeFilter !== 'all' ||
    Boolean(query.trim());

  /* 完成度 */
  const progress = counts.total ? counts.done / counts.total : 0;

  /* 完成任务后给一个 6 秒的撤销窗口 */
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  /**
   * 历史项目补建：早期版本里「项目」只是任务上的一个文本字段，实体表里没有记录。
   * 不补的话，用户早就分好的项目会在左侧栏里凭空消失 —— 任务还在，入口却没了。
   * 建完 projects 就包含这些名字了，所以这个 effect 不会反复创建。
   */
  useEffect(() => {
    if (!ready) return;
    const known = new Set(projects.map((p) => p.name));
    const names = new Set(tickets.map((t) => t.project?.trim()).filter((v): v is string => Boolean(v)));
    for (const name of names) {
      if (!known.has(name)) void projectsApi.create(name);
    }
  }, [ready, projects, tickets, projectsApi]);

  function toggleDone(ticket: Ticket) {
    const next: TicketStatus = ticket.status === 'done' ? 'todo' : 'done';
    ticketsApi.patch(ticket.id, { status: next });
    setUndo(next === 'done' ? { id: ticket.id, prev: ticket.status, title: ticket.title } : null);
  }

  function clearFilters() {
    setProjectFilter('all');
    setPriorityFilter('all');
    setOwnerFilter('all');
    setTagFilter('all');
    setTimeFilter('all');
    setQuery('');
  }

  /* ── 批量选择 ──────────────────────────────────────────────────────
     只认还在当前可见列表里的选中项：筛选条件一改，被筛掉的任务就不该继续
     被批量改到 —— 那是这类功能最容易"改错东西"的地方。 */
  /** 当前选中的项目实体（左侧栏筛的是项目名，这里换回实体好拿到 id） */
  const activeProject = useMemo(
    () =>
      projectFilter !== 'all' && projectFilter !== NO_PROJECT
        ? projects.find((p) => p.name === projectFilter) ?? null
        : null,
    [projects, projectFilter],
  );

  const selectedIds = useMemo(() => visible.filter((t) => selected.has(t.id)).map((t) => t.id), [visible, selected]);
  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((t) => t.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /** 批量改字段：交给 store 做乐观更新 + 整批回滚 */
  async function batchPatch(patch: Partial<Ticket>) {
    if (!selectedIds.length) return;
    await ticketsApi.patchMany(selectedIds, patch);
    clearSelection();
  }

  /** 批量归档 / 回收站 / 恢复 */
  async function batchLifecycle(kind: 'archive' | 'trash' | 'restore') {
    if (!selectedIds.length) return;
    await ticketsApi.bulkLifecycle(selectedIds, kind);
    clearSelection();
  }

  /**
   * 批量彻底删除（回收站）。这是整条流程里唯一不可逆的动作，所以先弹确认再执行。
   * 结果提示（含失败回滚）交给 store 的 notify 统一播报，免得两处各弹一个 toast。
   */
  async function purgeSelected() {
    const ids = selectedIds;
    setPurgeOpen(false);
    if (!ids.length) return;
    await ticketsApi.removeMany(ids);
    clearSelection();
  }

  /**
   * 任务写了某个还不存在的项目名时，顺手把项目建出来。
   * 否则那条任务会挂在一个"看不见的项目"下：数据还在，但左侧栏里没有入口，
   * 只能靠任务详情里的输入框才找得回来。
   */
  function ensureProject(name?: string) {
    const clean = String(name ?? '').trim();
    if (!clean || projects.some((p) => p.name === clean)) return;
    void projectsApi.create(clean);
  }

  /** 单条归档 / 回收站 / 恢复；动了生命周期就把抽屉关掉（任务可能已经不在当前视图里） */
  function lifecycle(id: string, kind: 'archive' | 'trash' | 'restore') {
    if (kind === 'archive') void ticketsApi.archive(id, true);
    else if (kind === 'trash') void ticketsApi.trash(id);
    else void ticketsApi.restore(id);
    setOpenId(null);
  }

  const editing = openId ? tickets.find((t) => t.id === openId) ?? null : null;

  if (!ready) {
    /* 真实布局是"左侧清单栏 + 右侧任务表"，骨架照这个形状摆。
        原来只渲染一张细条卡，数据一到整页重排一次。 */
    return (
      <div className="mx-auto flex w-full max-w-[1720px] items-start gap-4" role="status" aria-busy="true">
        <Skeleton className="hidden h-[70vh] w-[13rem] shrink-0 lg:block" />
        <div className="min-w-0 flex-1 space-y-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-[68vh]" />
        </div>
        <span className="sr-only">正在加载任务…</span>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1720px] items-start gap-4">
      {/* 清单栏：Tower 的左侧"清单"维度，用项目字段聚合 */}
      <ProjectRail
        projects={projects}
        stats={projectStats}
        unassigned={projectStats.get(NO_PROJECT)?.open ?? 0}
        total={counts.total}
        active={projectFilter}
        onPick={(key) => {
          setProjectFilter(key);
          setOpenId(null);
        }}
        onCreate={(name) => projectsApi.create(name)}
        onRename={(id, name) => void projectsApi.rename(id, name)}
        onRemove={(id) => {
          // 被删的项目如果正筛着，筛选要退回「全部」，否则列表会空成一片，看着像项目连带把任务删了
          const target = projects.find((p) => p.id === id);
          if (target && projectFilter === target.name) setProjectFilter('all');
          void projectsApi.remove(id);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Toolbar
          view={view}
          onView={setView}
          scope={scope}
          onScope={setScope}
          counts={counts}
          progress={progress}
          sort={sort}
          onSort={setSort}
          timeFilter={timeFilter}
          onTimeFilter={setTimeFilter}
          priorityFilter={priorityFilter}
          onPriorityFilter={setPriorityFilter}
          ownerFilter={ownerFilter}
          onOwnerFilter={setOwnerFilter}
          owners={owners}
          tags={allTags}
          tagFilter={tagFilter}
          onTagFilter={setTagFilter}
          query={query}
          onQuery={setQuery}
          filtersActive={filtersActive}
          onClearFilters={clearFilters}
          onCreate={() => setCreating('todo')}
          bucket={bucket}
          onBucket={setBucket}
        />

        {/* 批量操作栏：有选中时才出现，紧贴工具条下方 */}
        {selectedIds.length ? (
          <BatchBar
            count={selectedIds.length}
            allSelected={allVisibleSelected}
            onToggleAll={toggleSelectAll}
            onClear={clearSelection}
            onPatch={(patch) => void batchPatch(patch)}
            onLifecycle={(kind) => void batchLifecycle(kind)}
            onPurge={() => setPurgeOpen(true)}
            owners={owners}
            bucket={bucket}
          />
        ) : null}

        {/* 移动端项目：横向 chips，替代左侧栏 */}
        <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 lg:hidden">
          <Tag active={projectFilter === 'all'} onClick={() => setProjectFilter('all')} className="shrink-0 whitespace-nowrap">
            全部 <span className="num ml-1 text-faint">{counts.total}</span>
          </Tag>
          {projects.map((p) => (
            <Tag
              key={p.id}
              active={projectFilter === p.name}
              onClick={() => setProjectFilter(p.name)}
              className="shrink-0 whitespace-nowrap"
            >
              {p.name} <span className="num ml-1 text-faint">{projectStats.get(p.name)?.open ?? 0}</span>
            </Tag>
          ))}
        </div>

        {/* 选中某个项目时主区切成「项目视图」：分类分组 + 组内任务。
            项目不做独立页面 —— 它是任务页里的一种视图，不是并列的第二个入口。 */}
        {bucket === 'active' && activeProject ? (
          <ProjectBoard project={activeProject} onOpen={setOpenId} onDeleted={() => setProjectFilter('all')} />
        ) : visible.length === 0 ? (
          <div className="panel p-4 sm:p-5">
            <Empty
              title={scoped.length ? '当前筛选条件下没有任务' : '这几周还没有任务'}
              hint={scoped.length ? '换个筛选条件，或清空筛选看全部。' : '把要做的事拆成任务，带上优先级和截止时间，就不会漏。'}
              action={
                scoped.length && filtersActive ? (
                  <Button size="sm" onClick={clearFilters}>
                    清空筛选
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => setCreating('todo')}>
                    <Plus size={13} />
                    新建任务
                  </Button>
                )
              }
            />
          </div>
        ) : view === 'list' ? (
          <ListView
            grouped={grouped}
            collapsed={collapsed}
            onToggleGroup={(status) => setCollapsed((prev) => ({ ...prev, [status]: !prev[status] }))}
            onToggleDone={toggleDone}
            onOpen={setOpenId}
            onPatch={(id, patch) => void ticketsApi.patch(id, patch)}
            onDelete={(id) => void ticketsApi.remove(id)}
            onAddInline={(status) => setCreating(status)}
            onQuickAdd={(status, title) => void ticketsApi.add({ title, status })}
            activeId={openId}
            selected={selected}
            onToggleSelect={toggleSelect}
            bucket={bucket}
            onLifecycle={lifecycle}
          />
        ) : (
          <BoardView
            grouped={grouped}
            byId={byId}
            onPatch={(ticket, patch) => {
              if (patch.status && patch.status !== ticket.status) {
                ticketsApi.patch(ticket.id, patch);
                if (patch.status === 'done') setUndo({ id: ticket.id, prev: ticket.status, title: ticket.title });
                return;
              }
              ticketsApi.patch(ticket.id, patch);
            }}
            onOpen={setOpenId}
            onDelete={(id) => void ticketsApi.remove(id)}
            onAddInline={(status) => setCreating(status)}
            activeId={openId}
            selected={selected}
            onToggleSelect={toggleSelect}
            laneBy={laneBy}
            onLaneBy={setLaneBy}
            bucket={bucket}
            onLifecycle={lifecycle}
          />
        )}
      </div>

      <TaskDrawer
        ticket={editing}
        createStatus={creating}
        createProject={projectFilter !== 'all' && projectFilter !== NO_PROJECT ? projectFilter : ''}
        projects={projects}
        allTags={allTags}
        onClose={() => {
          setOpenId(null);
          setCreating(null);
        }}
        onPatch={(id, patch) => {
          ensureProject(patch.project);
          void ticketsApi.patch(id, patch);
        }}
        onDelete={(id) => void ticketsApi.remove(id)}
        onCreate={(payload) => {
          ensureProject(payload.project);
          return ticketsApi.add(payload);
        }}
        onLifecycle={lifecycle}
      />

      {/* 彻底删除的确认。文案把「不可恢复」和波及范围（动态 / 附件）写清楚，
          比只丢一句「确定删除吗」有用得多 —— 这是整条流程里唯一撤不回来的动作 */}
      {purgeOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="取消删除"
            onClick={() => setPurgeOpen(false)}
            className="scrim fixed inset-0 cursor-default"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="确认彻底删除"
            className="panel relative z-10 w-full max-w-[26rem] p-4 shadow-pop animate-dialog-in sm:p-5"
          >
            <h2 className="text-[15px] font-semibold text-ink">
              彻底删除 <span className="num">{selectedIds.length}</span> 条任务？
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              删除后无法恢复，这些任务下的动态与附件会一并清除。它们本来就在回收站里，确认不再需要再删。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPurgeOpen(false)}>
                取消
              </Button>
              <Button size="sm" variant="danger" onClick={() => void purgeSelected()}>
                <Trash2 size={12} />
                彻底删除
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {undo ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 lg:bottom-6">
          <div
            role="status"
            className="pointer-events-auto flex max-w-full items-center gap-3 rounded-field bg-panel px-3 py-2 shadow-pop animate-fade-rise"
          >
            <span className="flex items-center gap-2 text-xs text-muted">
              <Check size={14} className="text-ok" />
              <span className="max-w-[16rem] truncate text-ink">{undo.title}</span>
              已完成
            </span>
            <Button
              size="sm"
              variant="soft"
              onClick={() => {
                ticketsApi.patch(undo.id, { status: undo.prev });
                setUndo(null);
              }}
            >
              <Undo2 size={12} />
              撤销
            </Button>
            <button
              type="button"
              onClick={() => setUndo(null)}
              aria-label="关闭提示"
              className="rounded-field p-1 text-faint transition-colors hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── 左侧项目栏 ───────────────────────────────────────────────────── */

/**
 * Tower 式的左侧栏：项目是独立实体（可新建 / 改名 / 删除），不再是任务字段的聚合结果。
 * 计数仍然来自任务，所以两样都要传进来：实体回答"有哪些项目"，
 * 统计回答"各有多少条" —— 空项目也得能出现在这里，否则没法先建项目再往里放任务。
 */
function ProjectRail({
  projects,
  stats,
  unassigned,
  total,
  active,
  onPick,
  onCreate,
  onRename,
  onRemove,
}: {
  projects: Project[];
  stats: Map<string, { total: number; open: number }>;
  unassigned: number;
  total: number;
  active: string;
  onPick: (key: string) => void;
  onCreate: (name: string) => void | Promise<unknown>;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);

  const submitNew = async () => {
    const name = draft.trim();
    setDraft('');
    setAdding(false);
    if (name) await onCreate(name);
  };

  return (
    <aside className="panel sticky top-3 hidden w-[13rem] shrink-0 p-2 lg:block" aria-label="项目">
      {/* 「全部任务」不属于任何项目，所以单独放在项目列表**上方** ——
          和真项目并排时，它会因为"看起来也是一项"而被当成一个项目 */}
      <ul className="space-y-0.5 pb-1">
        <li>
          <RailItem active={active === 'all'} label="全部任务" count={total} onClick={() => onPick('all')} />
        </li>
      </ul>

      <div className="flex items-center justify-between border-t border-line px-2 pb-1.5 pt-2">
        <p className="text-2xs font-medium uppercase tracking-wider text-faint">项目</p>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          aria-label="新建项目"
          aria-expanded={adding}
          className="rounded-field p-0.5 text-faint transition-colors hover:text-accent"
        >
          <Plus size={13} />
        </button>
      </div>

      {adding ? (
        <div className="px-1 pb-1.5">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitNew();
              }
              if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => void submitNew()}
            placeholder="项目名，回车创建"
            aria-label="新项目名称"
            className="py-1 text-2xs"
          />
        </div>
      ) : null}

      <ul className="space-y-0.5">
        {projects.map((p) => (
          <li key={p.id} className="group/rail relative">
            {editingId === p.id ? (
              <Input
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onRename(p.id, editDraft);
                    setEditingId(null);
                  }
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={() => {
                  onRename(p.id, editDraft);
                  setEditingId(null);
                }}
                aria-label="项目名"
                className="py-1 text-2xs"
              />
            ) : (
              <>
                <RailItem
                  active={active === p.name}
                  label={p.name}
                  count={stats.get(p.name)?.open ?? 0}
                  onClick={() => onPick(p.name)}
                />
                <button
                  type="button"
                  onClick={() => setMenuId((cur) => (cur === p.id ? null : p.id))}
                  aria-label={`${p.name} 的项目菜单`}
                  aria-expanded={menuId === p.id}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-field p-0.5 text-faint opacity-40 transition-opacity hover:text-ink group-hover/rail:opacity-100 focus-visible:opacity-100"
                >
                  <MoreVertical size={12} />
                </button>
                {menuId === p.id ? (
                  <div
                    role="menu"
                    className="absolute right-1 top-full z-30 w-[7.5rem] rounded-field border border-line bg-panel py-1 shadow-pop"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditDraft(p.name);
                        setEditingId(p.id);
                        setMenuId(null);
                      }}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-2xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                    >
                      <Pencil size={11} />
                      重命名
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuId(null);
                        onRemove(p.id);
                      }}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-2xs text-crit transition-colors hover:bg-panel-2"
                    >
                      <Trash2 size={11} />
                      删除项目
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}

        {unassigned ? (
          <li>
            <RailItem
              active={active === NO_PROJECT}
              label="未归类"
              count={unassigned}
              muted
              onClick={() => onPick(NO_PROJECT)}
            />
          </li>
        ) : null}
      </ul>

      {projects.length === 0 && !adding ? (
        <p className="px-2 py-3 text-2xs text-faint">还没有项目。点上面的 + 建一个，之后可以在项目下建任务。</p>
      ) : null}
    </aside>
  );
}

function RailItem({
  active,
  label,
  count,
  muted,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cls(
        'flex w-full items-center gap-2 rounded-xl2 px-2 py-1.5 text-left text-[13px] transition-colors',
        active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-panel-2 hover:text-ink',
      )}
    >
      <span className={cls('min-w-0 flex-1 truncate', muted && !active && 'text-faint')}>{label}</span>
      <span className="num shrink-0 text-2xs text-faint">{count}</span>
    </button>
  );
}

/* ── 工具条 ───────────────────────────────────────────────────────── */
function Toolbar({
  view,
  onView,
  scope,
  onScope,
  counts,
  progress,
  sort,
  onSort,
  timeFilter,
  onTimeFilter,
  priorityFilter,
  onPriorityFilter,
  ownerFilter,
  onOwnerFilter,
  owners,
  tags,
  tagFilter,
  onTagFilter,
  query,
  onQuery,
  filtersActive,
  onClearFilters,
  onCreate,
  bucket,
  onBucket,
}: {
  view: View;
  onView: (v: View) => void;
  scope: Scope;
  onScope: (s: Scope) => void;
  counts: { overdue: number; today: number; urgent: number; done: number; total: number; open: number };
  progress: number;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  timeFilter: TimeFilter;
  onTimeFilter: (t: TimeFilter) => void;
  priorityFilter: Priority | 'all';
  onPriorityFilter: (p: Priority | 'all') => void;
  ownerFilter: string;
  onOwnerFilter: (o: string) => void;
  owners: string[];
  tags: string[];
  tagFilter: string;
  onTagFilter: (t: string) => void;
  query: string;
  onQuery: (q: string) => void;
  filtersActive: boolean;
  onClearFilters: () => void;
  onCreate: () => void;
  bucket: Bucket;
  onBucket: (b: Bucket) => void;
}) {
  return (
    <section className="panel overflow-hidden" aria-label="任务工具条">
      {/* 标题行：完成度 + 视图切换 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3.5 py-3 sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-[15px] font-semibold tracking-tight">
            任务
            <span className="num text-2xs font-normal text-muted">
              {counts.open} 未完成 / {counts.total}
            </span>
          </h2>
        </div>

        <div className="hidden min-w-[10rem] flex-1 items-center gap-2.5 sm:flex">
          <Meter ratio={progress} tone="signal" className="flex-1" />
          <span className="num shrink-0 text-2xs text-muted">
            完成 {counts.done} · {Math.round(progress * 100)}%
          </span>
        </div>

        {/* shrink-0 的整组在这里是三个控件（两个 Segmented + 新建）。
            窄屏放不下时它自己也要能折行、并整体靠右 ——
            没有 flex-wrap 会把左侧的「任务 N 未完成」直接顶出容器。 */}
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Segmented
            size="sm"
            value={view}
            onChange={onView}
            options={[
              { value: 'list', label: '列表' },
              { value: 'board', label: '看板' },
            ]}
          />
          <Segmented
            size="sm"
            value={scope}
            onChange={onScope}
            options={[
              { value: 'week', label: '本周' },
              { value: 'all', label: '全部' },
            ]}
          />
          <Button size="sm" variant="primary" onClick={onCreate}>
            <Plus size={13} />
            新建任务
          </Button>
        </div>
      </div>

      {/* 筛选行：搜索定宽（原来 flex-1 会吃满剩余宽度，把后面几组挤下去），
          组与组之间插一道细线 —— 六组筛选平铺在一起时，没有分隔读不出边界，
          整条看起来就是"一堆按钮" */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 bg-panel p-3 sm:p-4">
        <div className="relative w-full shrink-0 sm:w-[15rem]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜索任务号、标题、项目、备注、标签"
            className="pl-7"
            aria-label="搜索任务"
          />
        </div>

        <span aria-hidden className="hidden h-4 w-px shrink-0 bg-line sm:block" />

        {/* 生命周期：进行中 / 已归档 / 回收站 */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="生命周期">
          {(['active', 'archived', 'trash'] as const).map((key) => (
            <Tag key={key} active={bucket === key} onClick={() => onBucket(key)}>
              {BUCKET_LABEL[key]}
            </Tag>
          ))}
        </div>

        <span aria-hidden className="hidden h-4 w-px shrink-0 bg-line sm:block" />

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="时间范围">
          <Tag active={timeFilter === 'all'} onClick={() => onTimeFilter('all')}>
            全部
          </Tag>
          {(['overdue', 'today', 'week'] as const).map((key) => {
            const n = key === 'overdue' ? counts.overdue : key === 'today' ? counts.today : 0;
            return (
              <Tag key={key} active={timeFilter === key} onClick={() => onTimeFilter(key)}>
                {TIME_LABEL[key]}
                {key !== 'week' ? <span className="num ml-1 text-faint">{n}</span> : null}
              </Tag>
            );
          })}
        </div>

        <span aria-hidden className="hidden h-4 w-px shrink-0 bg-line sm:block" />

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="优先级">
          <Tag active={priorityFilter === 'all'} onClick={() => onPriorityFilter('all')}>
            全优先级
          </Tag>
          {PRIORITIES.map((p) => (
            <Tag key={p} active={priorityFilter === p} onClick={() => onPriorityFilter(p)}>
              <span className="num">{PRIORITY_META[p].label}</span>
            </Tag>
          ))}
        </div>

        {tags.length ? (
          <label className="flex items-center gap-1.5 text-2xs text-faint">
            <span className="sr-only">标签筛选</span>
            <Select
              value={tagFilter}
              onChange={(e) => onTagFilter(e.target.value)}
              className="w-[7rem] py-1 text-2xs"
              aria-label="按标签筛选"
            >
              <option value="all">全部标签</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        <label className="flex items-center gap-1.5 text-2xs text-faint">
          <span className="sr-only">负责人筛选</span>
          <Select
            value={ownerFilter}
            onChange={(e) => onOwnerFilter(e.target.value)}
            className="w-[7rem] py-1 text-2xs"
            aria-label="按负责人筛选"
          >
            <option value="all">全部负责人</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-2xs text-faint">
          <span className="sr-only">排序方式</span>
          <Select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} className="w-[8rem] py-1 text-2xs" aria-label="排序方式">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </Select>
        </label>

        {filtersActive ? (
          <button type="button" onClick={onClearFilters} className="text-2xs text-accent transition-opacity hover:opacity-80">
            清空筛选
          </button>
        ) : null}
      </div>
    </section>
  );
}

/* ── 批量操作栏 ───────────────────────────────────────────────────── */

/**
 * 选中任务后出现的操作条：字段类改动（状态/优先级/负责人/截止）走下拉一次改，
 * 生命周期（归档/回收站/恢复）单独放右侧 —— 它们可逆性不同，别混在一排按钮里。
 */
function BatchBar({
  count,
  allSelected,
  onToggleAll,
  onClear,
  onPatch,
  onLifecycle,
  onPurge,
  owners,
  bucket,
}: {
  count: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onPatch: (patch: Partial<Ticket>) => void;
  onLifecycle: (kind: 'archive' | 'trash' | 'restore') => void;
  /** 回收站专用：彻底删除。不可恢复，所以调用方必须先弹确认 */
  onPurge: () => void;
  owners: string[];
  bucket: Bucket;
}) {
  const CLEAR = '__clear__';

  return (
    <section aria-label="批量操作" className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 animate-fade-rise">
      <span className="flex items-center gap-2 text-[13px] text-ink">
        <span className="grid h-5 w-5 place-items-center rounded-field bg-accent-soft text-accent">
          <Check size={12} />
        </span>
        已选 <span className="num font-semibold">{count}</span> 条
      </span>

      <button type="button" onClick={onToggleAll} className="text-2xs text-accent transition-opacity hover:opacity-80">
        {allSelected ? '取消全选' : '全选当前列表'}
      </button>

      {bucket === 'active' ? (
        <>
          <span aria-hidden className="hidden h-4 w-px bg-line sm:block" />

          <Select
            value=""
            onChange={(e) => e.target.value && onPatch({ status: e.target.value as TicketStatus })}
            className="w-[7.5rem] py-1 text-2xs"
            aria-label="批量改状态"
          >
            <option value="">改状态…</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </Select>

          <Select
            value=""
            onChange={(e) => e.target.value && onPatch({ priority: e.target.value as Priority })}
            className="w-[7.5rem] py-1 text-2xs"
            aria-label="批量改优先级"
          >
            <option value="">改优先级…</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_META[p].label}
              </option>
            ))}
          </Select>

          <Select
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              onPatch({ owner: v === CLEAR ? '' : v });
            }}
            className="w-[8rem] py-1 text-2xs"
            aria-label="批量改负责人"
          >
            <option value="">改负责人…</option>
            <option value={CLEAR}>（清空负责人）</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        {bucket === 'active' ? (
          <>
            <Button size="sm" variant="soft" onClick={() => onLifecycle('archive')}>
              <Archive size={12} />
              归档
            </Button>
            <Button size="sm" variant="soft" onClick={() => onLifecycle('trash')}>
              <Trash2 size={12} />
              移入回收站
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="soft" onClick={() => onLifecycle('restore')}>
              <RotateCcw size={12} />
              恢复
            </Button>
            {/* 彻底删除只出现在回收站：归档区的东西还有用，不该在这里被一把清掉 */}
            {bucket === 'trash' ? (
              <Button size="sm" variant="danger" onClick={onPurge}>
                <Trash2 size={12} />
                彻底删除
              </Button>
            ) : null}
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X size={12} />
          取消选择
        </Button>
      </div>
    </section>
  );
}

/* ── 列表视图：按状态分组 ─────────────────────────────────────────── */
function ListView({
  grouped,
  collapsed,
  onToggleGroup,
  onToggleDone,
  onOpen,
  onPatch,
  onDelete,
  onAddInline,
  onQuickAdd,
  activeId,
  selected,
  onToggleSelect,
  bucket,
  onLifecycle,
}: {
  grouped: { status: TicketStatus; items: Ticket[] }[];
  collapsed: Record<TicketStatus, boolean>;
  onToggleGroup: (s: TicketStatus) => void;
  onToggleDone: (t: Ticket) => void;
  onOpen: (id: string) => void;
  onPatch: (id: string, patch: Partial<Ticket>) => void;
  onDelete: (id: string) => void;
  onAddInline: (s: TicketStatus) => void;
  onQuickAdd: (s: TicketStatus, title: string) => void;
  activeId: string | null;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  bucket: Bucket;
  onLifecycle: (id: string, kind: 'archive' | 'trash' | 'restore') => void;
}) {
  /* 勾选对三个视图都有意义：进行中要批量改字段 / 归档，归档与回收站要批量恢复，
     回收站还要批量彻底删除。
     原先是 `bucket === 'active'`，结果回收站里一个选择框都不渲染 ——
     没有勾选就没有批量条，「批量删除」也就永远点不到。 */
  const selectable = true;
  /** 哪个空分组点了「＋」：空分组平时只占一行，展开后才露出输入框 */
  const [addingIn, setAddingIn] = useState<TicketStatus | null>(null);

  return (
    <div className="flex flex-col gap-2.5">
      {/* 列头：给字段列一个名字。列宽与数据行共用 LIST_GRID —— 分头写就会错位 */}
      <div
        className={cls(
          'hidden items-center gap-x-2.5 px-3 pb-1 pt-1 text-2xs tracking-wide text-muted sm:px-4 lg:grid',
          LIST_GRID,
        )}
      >
        <span aria-hidden />
        <span>任务</span>
        <span>负责人</span>
        <span>优先级</span>
        <span>截止</span>
        <span>子任务</span>
        <span aria-hidden />
      </div>

      {grouped.map(({ status, items }) => {
        const isCollapsed = collapsed[status];
        const isEmpty = items.length === 0;
        const adding = addingIn === status;
        return (
          <section key={status} className="panel overflow-hidden" aria-label={`${STATUS_META[status].label}（${items.length}）`}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggleGroup(status)}
                aria-expanded={!isCollapsed}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-panel-2/60 sm:px-4"
              >
                {isCollapsed ? <ChevronRight size={14} className="text-faint" /> : <ChevronDown size={14} className="text-faint" />}
                <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] }} />
                <span className="text-[13px] font-medium">{STATUS_META[status].label}</span>
                <span className="num text-2xs text-faint">{items.length}</span>
              </button>

              {/* 空分组收成一行。四个分组里通常三个是空的，
                  原来每个都铺一整块「添加任务 + 更多字段」，大半屏都在显示"这里没东西"。 */}
              {isEmpty && !isCollapsed && !adding && bucket === 'active' ? (
                <button
                  type="button"
                  onClick={() => setAddingIn(status)}
                  className="mr-3 shrink-0 rounded-full border border-line px-2.5 py-1 text-2xs text-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent sm:mr-4"
                >
                  ＋ 添加
                </button>
              ) : null}
            </div>

            {isCollapsed ? null : (
              <>
                {isEmpty ? null : (
                  <ul className="divide-y divide-[color:var(--line)] border-t border-line">
                    {items.map((ticket) => (
                      <TaskRow
                        key={ticket.id}
                        ticket={ticket}
                        active={activeId === ticket.id}
                        onToggleDone={() => onToggleDone(ticket)}
                        onOpen={() => onOpen(ticket.id)}
                        onPatch={(patch) => onPatch(ticket.id, patch)}
                        onDelete={() => onDelete(ticket.id)}
                        selected={selected.has(ticket.id)}
                        selectable={selectable}
                        onToggleSelect={() => onToggleSelect(ticket.id)}
                        bucket={bucket}
                        onLifecycle={onLifecycle}
                      />
                    ))}
                  </ul>
                )}
                {/* 归档与回收站里不给「快速新建」：往一个已经归档的状态里加任务没有意义。
                    这里判 bucket 而不是 selectable —— 后者现在是「能不能勾选」 */}
                {bucket === 'active' && (adding || !isEmpty) ? (
                  <InlineAdd
                    status={status}
                    defaultEditing={adding}
                    onCreate={(title) => {
                      setAddingIn(null);
                      onQuickAdd(status, title);
                    }}
                    onOpenDetail={() => {
                      setAddingIn(null);
                      onAddInline(status);
                    }}
                  />
                ) : null}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 组内快速添加：回车即建、可连续录入；需要填更多字段时走右侧详情 */
function InlineAdd({
  status,
  onCreate,
  onOpenDetail,
  defaultEditing = false,
}: {
  status: TicketStatus;
  onCreate: (title: string) => void;
  onOpenDetail: () => void;
  /** 从空分组的「＋」点进来时直接展开输入框，不再让用户多点一次 */
  defaultEditing?: boolean;
}) {
  const [editing, setEditing] = useState(defaultEditing);
  const [value, setValue] = useState('');
  const label = STATUS_META[status].label;

  if (!editing) {
    return (
      <div className="flex items-center border-t border-line">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex flex-1 items-center gap-1.5 px-3 py-2 text-2xs text-faint transition-colors hover:text-accent sm:px-4"
        >
          <Plus size={12} />
          添加任务到「{label}」
        </button>
        <button
          type="button"
          onClick={onOpenDetail}
          className="px-3 py-2 text-2xs text-faint transition-colors hover:text-accent sm:px-4"
          aria-label={`打开新建任务面板（默认状态：${label}）`}
        >
          更多字段…
        </button>
      </div>
    );
  }

  const commit = () => {
    const title = value.trim();
    if (!title) return;
    onCreate(title);
    setValue('');
  };

  return (
    <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 sm:px-4">
      <Plus size={13} className="shrink-0 text-accent" />
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setEditing(false);
            setValue('');
          }
        }}
        onBlur={() => {
          // 输入了内容就当作"我就填这一条"，对着输入框点走即创建
          commit();
          if (!value.trim()) setEditing(false);
        }}
        placeholder={`添加任务到「${label}」，回车创建，Esc 取消`}
        aria-label={`在「${label}」中添加任务`}
        className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-faint"
      />
    </div>
  );
}

/* ── 列表行 ───────────────────────────────────────────────────────── */
function TaskRow({
  ticket,
  active,
  onToggleDone,
  onOpen,
  onPatch,
  onDelete,
  selected,
  selectable,
  onToggleSelect,
  bucket,
  onLifecycle,
}: {
  ticket: Ticket;
  active: boolean;
  onToggleDone: () => void;
  onOpen: () => void;
  onPatch: (patch: Partial<Ticket>) => void;
  onDelete: () => void;
  selected: boolean;
  selectable: boolean;
  onToggleSelect: () => void;
  bucket: Bucket;
  onLifecycle: (id: string, kind: 'archive' | 'trash' | 'restore') => void;
}) {
  const done = ticket.status === 'done';
  const days = daysUntil(ticket.due);
  const overdue = !done && days !== null && days < 0;
  const soon = !done && days !== null && days >= 0 && days <= 1;
  const checklist = ticket.checklist || [];
  const checklistDone = checklist.filter((c) => c.done).length;
  const tags = ticket.tags || [];

  return (
    <li className={cls('group relative transition-colors', active || selected ? 'bg-accent-soft/40' : 'hover:bg-panel-2/50')}>
      {/* lg 起字段成列（对齐列头），小屏退回「标题 + 元信息」的堆叠形态 */}
      <div
        className={cls(
          'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 px-3 py-2 sm:px-4',
          'lg:grid',
          LIST_GRID,
        )}
      >
        <div className="flex w-[3.25rem] items-center gap-2 lg:w-auto">
          {selectable ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={selected ? `取消选择「${ticket.title}」` : `选择「${ticket.title}」`}
              onClick={onToggleSelect}
              className={cls(
                'grid h-[17px] w-[17px] shrink-0 place-items-center rounded-xs border transition-colors',
                selected ? 'border-accent bg-accent text-white' : 'border-line bg-panel-2 hover:border-accent',
              )}
            >
              {selected ? <Check size={11} strokeWidth={3} /> : null}
            </button>
          ) : null}

          {/* 归档与回收站里不显示「完成」勾选：这两个视图里完成与否没有意义 */}
          {bucket === 'active' ? <CompletionCheck checked={done} onToggle={onToggleDone} label={ticket.title} /> : null}
        </div>

        <button type="button" onClick={onOpen} className="min-w-0 text-left" aria-label={`打开任务 ${ticket.id} 详情`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="num text-2xs text-faint">{ticket.id}</span>
            <span className={cls('text-[13.5px] leading-snug', done ? 'text-faint line-through' : 'font-medium')}>{ticket.title}</span>
            {tags.map((tag) => (
              <span key={tag} className="rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px] text-muted">
                {tag}
              </span>
            ))}
          </div>
        </button>

        {/* 这四列只在 lg 起出现，小屏由下面的元信息行接管 */}
        <span className="hidden truncate text-2xs text-muted lg:block" title={ticket.owner?.trim() || undefined}>
          {ticket.owner?.trim() || '—'}
        </span>
        <span className="hidden lg:block">
          <PriorityBadge priority={ticket.priority} />
        </span>
        <span className={cls('num hidden text-2xs lg:block', overdue ? 'text-crit' : soon ? 'text-warn' : 'text-muted')}>
          {ticket.due ? fmtDate(ticket.due) : '—'}
        </span>
        <span className="num hidden text-2xs lg:block">
          {checklist.length ? (
            <span className={cls('inline-flex items-center gap-1', checklistDone === checklist.length ? 'text-ok' : 'text-muted')}>
              <ListChecks size={11} />
              {checklistDone}/{checklist.length}
            </span>
          ) : (
            <span className="text-faint">—</span>
          )}
        </span>

        {/* 状态与优先级不放在行内做下拉（分组已经表达状态），统一走菜单，拖拽之外也有键盘可达的入口 */}
        <RowMenu ticket={ticket} onPatch={onPatch} onOpen={onOpen} onDelete={onDelete} bucket={bucket} onLifecycle={onLifecycle} />

        <div className="col-span-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint lg:hidden">
          {/* truncate 在 flex-wrap 里必须自带宽度上限，否则 flex item 按内容撑开、
              截断永远不生效（长项目名会把整行推得很宽） */}
          <span className="max-w-[9rem] truncate">{ticket.project?.trim() || '未归类'}</span>
          <PriorityBadge priority={ticket.priority} />
          {ticket.owner?.trim() ? <span>负责人 · {ticket.owner}</span> : null}
          {checklist.length ? (
            <span className={cls('num inline-flex items-center gap-1', checklistDone === checklist.length ? 'text-ok' : '')}>
              <ListChecks size={11} />
              {checklistDone}/{checklist.length}
            </span>
          ) : null}
          {ticket.due ? (
            <span className={cls('num inline-flex items-center gap-1', overdue ? 'text-crit' : soon ? 'text-warn' : '')}>
              <CalendarDays size={11} />
              {fmtDate(ticket.due)}
              {overdue
                ? ` · 逾期 ${Math.abs(days!)} 天`
                : days === 0
                  ? ' · 今天'
                  : days === 1
                    ? ' · 明天'
                    : days !== null && days > 1
                      ? ` · ${days} 天后`
                      : ''}
            </span>
          ) : (
            <span>未设截止</span>
          )}
          {ticket.note?.trim() ? (
            <span className="truncate max-w-[16rem]">备注 · {noteSummary(ticket.note)}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** 复选框：符合 Tower 的"一点即完成"，同时是标准的 role=checkbox */
function CompletionCheck({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? `将「${label}」标记为未完成` : `完成「${label}」`}
      onClick={onToggle}
      className="mt-px grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors hover:bg-accent-soft"
    >
      <span
        aria-hidden
        className={cls(
          'grid h-[17px] w-[17px] place-items-center rounded-xs border transition-colors',
          checked ? 'border-ok bg-ok text-white' : 'border-line bg-panel-2 hover:border-accent',
        )}
      >
        {checked ? <Check size={11} strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

/** 行/卡片菜单：移动到、优先级、编辑、删除 —— 拖拽的等价操作入口 */
function RowMenu({
  ticket,
  onPatch,
  onOpen,
  onDelete,
  bucket,
  onLifecycle,
}: {
  ticket: Ticket;
  onPatch: (patch: Partial<Ticket>) => void;
  onOpen: () => void;
  onDelete: () => void;
  bucket: Bucket;
  onLifecycle: (id: string, kind: 'archive' | 'trash' | 'restore') => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 菜单挂在 body 上，所以位置得自己算 */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /**
   * 菜单必须渲染到 body 去：任务按状态分组，每组是 .panel（overflow: hidden + 1rem 圆角），
   * 分组里靠下的行把菜单往下弹时会被容器裁掉，只剩残缺的一块 —— 而 panel 的圆角
   * 又让"直接去掉 overflow"不可行（行 hover 的底色会溢出圆角）。
   * 挂到 body 上就彻底不受容器裁切影响，代价是位置要自己算：
   * 右边缘对齐按钮、下方放不下就翻到上方、并夹在视口内。
   * 用 useLayoutEffect 是为了在绘制前就定位好，否则菜单会先闪一下再跳到正确位置。
   */
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth || 176; // w-[11rem]
      const height = menuRef.current?.offsetHeight || 280;
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      const below = r.bottom + 4;
      setPos({
        top: below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 4) : below,
        left,
      });
    };
    place();

    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // 菜单已经脱离文档流，滚动或改窗口大小时没人替它重定位，得手动跟住按钮
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${ticket.id} 的操作菜单`}
        className="rounded-field p-1.5 text-faint transition-colors hover:bg-panel-2 hover:text-ink"
      >
        <MoreVertical size={15} />
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              className="fixed z-50 w-[11rem] overflow-hidden rounded-field bg-panel py-1 shadow-pop animate-fade-rise"
            >
          <p className="px-2.5 py-1 text-2xs text-faint">移动到</p>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={ticket.status === s}
              onClick={() => {
                onPatch({ status: s });
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              <span aria-hidden className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              <span className="flex-1">{STATUS_META[s].label}</span>
              {ticket.status === s ? <Check size={12} className="text-accent" /> : null}
            </button>
          ))}

          <p className="mt-1 border-t border-line px-2.5 pb-1 pt-2 text-2xs text-faint">优先级</p>
          <div role="group" aria-label="优先级" className="flex gap-1 px-2.5 py-1">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={ticket.priority === p}
                onClick={() => {
                  onPatch({ priority: p });
                  setOpen(false);
                }}
                className={cls(
                  'num inline-flex items-center rounded-full border px-2 py-0.5 text-2xs transition-colors',
                  ticket.priority === p ? 'border-accent/50 bg-accent-soft text-accent' : 'border-line bg-panel-2 text-muted hover:text-ink',
                )}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="mt-1 border-t border-line pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onOpen();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              <Pencil size={12} />
              打开详情
            </button>

            {/* 生命周期：进行中的给「归档 / 回收站」，归档与回收站里的给「恢复」 */}
            {bucket === 'active' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onLifecycle(ticket.id, 'archive');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  <Archive size={12} />
                  归档
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onLifecycle(ticket.id, 'trash');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-crit transition-colors hover:bg-panel-2"
                >
                  <Trash2 size={12} />
                  移入回收站
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onLifecycle(ticket.id, 'restore');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  <RotateCcw size={12} />
                  恢复
                </button>
                {bucket === 'trash' ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onDelete();
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-crit transition-colors hover:bg-panel-2"
                  >
                    <Trash2 size={12} />
                    彻底删除
                  </button>
                ) : null}
              </>
            )}
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/* ── 看板视图 ─────────────────────────────────────────────────────── */
function BoardView({
  grouped,
  byId,
  onPatch,
  onOpen,
  onDelete,
  onAddInline,
  activeId,
  selected,
  onToggleSelect,
  laneBy,
  onLaneBy,
  bucket,
  onLifecycle,
}: {
  grouped: { status: TicketStatus; items: Ticket[] }[];
  byId: Map<string, Ticket>;
  onPatch: (t: Ticket, patch: Partial<Ticket>) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onAddInline: (s: TicketStatus) => void;
  activeId: string | null;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  laneBy: LaneBy;
  onLaneBy: (l: LaneBy) => void;
  bucket: Bucket;
  onLifecycle: (id: string, kind: 'archive' | 'trash' | 'restore') => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TicketStatus | null>(null);

  /** 泳道：把一列里的任务再按负责人 / 优先级切一层（Tower 看板的标志性做法） */
  const lanesOf = (items: Ticket[]) => {
    if (laneBy === 'none') return [{ key: '', label: '', items }];
    const map = new Map<string, Ticket[]>();
    for (const t of items) {
      const key = laneBy === 'owner' ? t.owner?.trim() || '未指派' : t.priority;
      const list = map.get(key);
      if (list) list.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()]
      .sort((a, b) =>
        laneBy === 'priority' ? ORDER[a[0] as Priority] - ORDER[b[0] as Priority] : a[0].localeCompare(b[0], 'zh'),
      )
      .map(([key, list]) => ({ key, label: key, items: list }));
  };

  return (
    <>
      {/* 泳道切换只在看板里有意义，所以放在这里而不是工具条 */}
      <div className="flex items-center justify-end gap-2">
        <span className="text-2xs text-faint">泳道</span>
        <Segmented
          size="sm"
          value={laneBy}
          onChange={onLaneBy}
          options={[
            { value: 'none', label: LANE_LABEL.none },
            { value: 'owner', label: LANE_LABEL.owner },
            { value: 'priority', label: LANE_LABEL.priority },
          ]}
        />
      </div>

      <div className="scrollbar-none -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
      {grouped.map(({ status, items }) => {
        const isOver = overStatus === status;
        return (
          <section
            key={status}
            aria-label={`${STATUS_META[status].label}（${items.length}）`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overStatus !== status) setOverStatus(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStatus((s) => (s === status ? null : s));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              const ticket = byId.get(id);
              setOverStatus(null);
              setDragId(null);
              if (ticket) onPatch(ticket, { status });
            }}
            className={cls(
              'flex w-[17.5rem] shrink-0 snap-start flex-col overflow-hidden rounded-xl2 border bg-panel-2/40 transition-colors lg:w-auto',
              isOver ? 'border-accent/60 bg-accent-soft/40' : 'border-line',
            )}
          >
            <header className="flex items-center gap-2 px-3 py-2.5">
              <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] }} />
              <span className="text-[13px] font-medium">{STATUS_META[status].label}</span>
              <span className="num text-2xs text-faint">{items.length}</span>
              <button
                type="button"
                onClick={() => onAddInline(status)}
                aria-label={`在「${STATUS_META[status].label}」新建任务`}
                className="ml-auto rounded-field p-1 text-faint transition-colors hover:bg-panel hover:text-accent"
              >
                <Plus size={13} />
              </button>
            </header>

            <ul className="flex min-h-[4rem] flex-1 flex-col gap-2 px-2.5 pb-2.5">
              {lanesOf(items).map((lane) => (
                <Fragment key={lane.key || 'all'}>
                  {lane.label ? (
                    <li className="flex items-center gap-1.5 px-1 pt-1 text-2xs text-faint">
                      {laneBy === 'priority' ? <PriorityBadge priority={lane.key as Priority} /> : <span>{lane.label}</span>}
                      <span className="num">{lane.items.length}</span>
                    </li>
                  ) : null}
                  {lane.items.map((ticket) => (
                    <TaskCard
                      key={ticket.id}
                      ticket={ticket}
                      active={activeId === ticket.id}
                      dragging={dragId === ticket.id}
                      onDragStart={() => setDragId(ticket.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverStatus(null);
                      }}
                      onOpen={() => onOpen(ticket.id)}
                      onPatch={(patch) => onPatch(ticket, patch)}
                      onDelete={() => onDelete(ticket.id)}
                      selected={selected.has(ticket.id)}
                      selectable
                      onToggleSelect={() => onToggleSelect(ticket.id)}
                      bucket={bucket}
                      onLifecycle={onLifecycle}
                    />
                  ))}
                </Fragment>
              ))}
              {items.length === 0 ? <li className="rounded-xl2 border border-dashed border-line px-3 py-4 text-center text-2xs text-faint">拖任务到这里</li> : null}
            </ul>
          </section>
        );
      })}
      </div>
    </>
  );
}

function TaskCard({
  ticket,
  active,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onPatch,
  onDelete,
  selected,
  selectable,
  onToggleSelect,
  bucket,
  onLifecycle,
}: {
  ticket: Ticket;
  active: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onPatch: (patch: Partial<Ticket>) => void;
  onDelete: () => void;
  selected: boolean;
  selectable: boolean;
  onToggleSelect: () => void;
  bucket: Bucket;
  onLifecycle: (id: string, kind: 'archive' | 'trash' | 'restore') => void;
}) {
  const done = ticket.status === 'done';
  const days = daysUntil(ticket.due);
  const overdue = !done && days !== null && days < 0;
  const soon = !done && days !== null && days >= 0 && days <= 1;
  const checklist = ticket.checklist || [];
  const checklistDone = checklist.filter((c) => c.done).length;
  const tags = ticket.tags || [];

  return (
    <li
      draggable
      onDragStart={(e) => {
        // 卡片内的按钮/输入不触发拖拽，避免误拖
        if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('text/plain', ticket.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cls(
        'group rounded-xl2 border bg-panel px-2.5 py-2.5 shadow-panel transition-[border-color,box-shadow,opacity]',
        active ? 'border-accent/60' : 'border-line hover:border-faint',
        dragging ? 'opacity-40' : '',
      )}
    >
      <div className="flex items-start gap-1.5">
        <GripVertical size={13} className="mt-0.5 shrink-0 cursor-grab text-faint" aria-hidden />
        {selectable ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={selected ? `取消选择「${ticket.title}」` : `选择「${ticket.title}」`}
            onClick={onToggleSelect}
            className={cls(
              'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-xs border transition-colors',
              selected ? 'border-accent bg-accent text-white' : 'border-line bg-panel-2 hover:border-accent',
            )}
          >
            {selected ? <Check size={10} strokeWidth={3} /> : null}
          </button>
        ) : null}
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" aria-label={`打开任务 ${ticket.id} 详情`}>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="num text-2xs text-faint">{ticket.id}</span>
            <PriorityBadge priority={ticket.priority} />
            {tags.map((tag) => (
              <span key={tag} className="rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px] text-muted">
                {tag}
              </span>
            ))}
          </div>
          <p className={cls('mt-1 text-[13px] leading-snug', done ? 'text-faint line-through' : 'font-medium')}>{ticket.title}</p>
        </button>
        <RowMenu ticket={ticket} onPatch={onPatch} onOpen={onOpen} onDelete={onDelete} bucket={bucket} onLifecycle={onLifecycle} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-faint">
        <span className="truncate max-w-[8rem]">{ticket.project?.trim() || '未归类'}</span>
        {checklist.length ? (
          <span className={cls('num inline-flex items-center gap-0.5', checklistDone === checklist.length ? 'text-ok' : '')}>
            <ListChecks size={11} />
            {checklistDone}/{checklist.length}
          </span>
        ) : null}
        {ticket.due ? (
          <span className={cls('num inline-flex items-center gap-1', overdue ? 'text-crit' : soon ? 'text-warn' : '')}>
            <CalendarDays size={11} />
            {fmtDate(ticket.due)}
          </span>
        ) : (
          <span>未设截止</span>
        )}
        {ticket.owner?.trim() ? <span className="truncate max-w-[6rem]">{ticket.owner}</span> : null}
        {ticket.note?.trim() ? (
          <span className="inline-flex items-center gap-0.5" title={ticket.note}>
            <MessageSquare size={11} aria-hidden />
            <span className="sr-only">有备注</span>
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* ── 任务详情抽屉 ─────────────────────────────────────────────────── */
function TaskDrawer({
  ticket,
  createStatus,
  createProject,
  projects,
  allTags,
  onClose,
  onPatch,
  onDelete,
  onCreate,
  onLifecycle,
}: {
  ticket: Ticket | null;
  createStatus: TicketStatus | null;
  /** 新建任务时预填的项目：正筛着某个项目，新建的就该落进它 */
  createProject?: string;
  /** 已有项目，给「项目」字段做候选 */
  projects: Project[];
  /** 已有标签：给标签输入做候选，省得手打时造出「监控」「监控 」这种同义标签 */
  allTags: string[];
  onClose: () => void;
  onPatch: (id: string, patch: Partial<Ticket>) => void;
  onDelete: (id: string) => void;
  onCreate: (payload: Partial<Ticket> & { title: string }) => Promise<void>;
  onLifecycle: (id: string, kind: 'archive' | 'trash' | 'restore') => void;
}) {
  const open = Boolean(ticket) || createStatus !== null;
  const [form, setForm] = useState({
    title: '',
    priority: 'P2' as Priority,
    status: 'todo' as TicketStatus,
    project: '',
    /** 分类：项目内部的「分组」，只属于所属项目；空字符串表示没归类 */
    section: '',
    owner: '',
    due: '',
    note: '',
    tags: [] as string[],
    checklist: [] as ChecklistItem[],
  });
  const [tagDraft, setTagDraft] = useState('');
  /** 项目字段切到「新建」输入态：只有在下拉里选了「＋ 新建项目…」才会置 true */
  const [newProject, setNewProject] = useState(false);
  const [stepDraft, setStepDraft] = useState('');
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [uploadError, setUploadError] = useState('');
  /** 放大查看的图片（备注内联图、评论图、附件缩略图都走它） */
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncKey, setSyncKey] = useState<string | null>(null);
  // key 只跟"打开的是哪一条"绑定：抽屉里改状态/优先级时不能把正在编辑的文本冲掉
  const key = open ? `${ticket?.id ?? 'new'}:${ticket ? '' : (createStatus ?? '')}` : null;

  if (open && syncKey !== key) {
    setSyncKey(key);
    setForm({
      title: ticket?.title ?? '',
      priority: ticket?.priority ?? 'P2',
      status: ticket?.status ?? createStatus ?? 'todo',
      project: ticket?.project ?? createProject ?? '',
      section: ticket?.section ?? '',
      owner: ticket?.owner ?? '',
      due: ticket?.due ? String(ticket.due).slice(0, 10) : '',
      note: ticket?.note ?? '',
      tags: ticket?.tags ?? [],
      checklist: ticket?.checklist ?? [],
    });
    setTagDraft('');
    setStepDraft('');
    setCommentDraft('');
    setNewProject(false);
  }
  if (!open && syncKey !== null) setSyncKey(null);

  /* 评论与附件都不在首屏数据里，打开哪条就拉哪条的 ——
     附件本体是 data URL，全塞进 bootstrap 会让首屏变得很重 */
  useEffect(() => {
    if (!ticket) {
      setComments([]);
      setAttachments([]);
      return;
    }
    let alive = true;
    api.tickets.comments
      .list(ticket.id)
      .then(({ comments: list }) => {
        if (alive) setComments(list);
      })
      .catch(() => {
        if (alive) setComments([]);
      });
    api.tickets.attachments
      .list(ticket.id)
      .then(({ attachments: list }) => {
        if (alive) setAttachments(list);
      })
      .catch(() => {
        if (alive) setAttachments([]);
      });
    return () => {
      alive = false;
    };
  }, [ticket?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /**
   * 备注 / 评论的正文与图片分开取。必须放在所有 early return 之前 ——
   * hooks 数量得恒定，否则「先不渲染、后来才渲染」时 React 会直接报 #310。
   */
  const noteParts = useMemo(() => splitNote(form.note), [form.note]);
  const commentParts = useMemo(() => splitNote(commentDraft), [commentDraft]);
  /** 附件区只列真正的文件。粘贴进正文的内联图片在备注 / 评论里显示，不占这里的位置 */
  const fileAttachments = useMemo(() => attachments.filter((a) => !a.inline), [attachments]);

  /** 表单当前选中的项目实体：分类属于项目，得先定位到它，才能列出它下面的分类 */
  const formProject = useMemo(
    () => projects.find((p) => p.name === form.project.trim()) ?? null,
    [projects, form.project],
  );
  /**
   * 该项目的分类。只在选中项目时才去拉 —— 放进 store 会让首屏为每个项目各请求一次，
   * 而实际用到的始终只有当前这一个。
   */
  const [formSections, setFormSections] = useState<ProjectSection[]>([]);
  useEffect(() => {
    if (!open || !formProject) {
      setFormSections([]);
      return;
    }
    let alive = true;
    api.projects
      .sections(formProject.id)
      .then(({ sections: list }) => {
        if (alive) setFormSections(list);
      })
      .catch(() => {
        if (alive) setFormSections([]);
      });
    return () => {
      alive = false;
    };
  }, [open, formProject]);

  if (!open) return null;

  const patch = (next: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...next }));

  const save = async () => {
    const title = form.title.trim();
    if (!title) return;
    setBusy(true);
    const payload = {
      ...form,
      title,
      due: form.due ? new Date(`${form.due}T18:00:00`).toISOString() : '',
    };
    if (ticket) onPatch(ticket.id, payload);
    else await onCreate(payload);
    setBusy(false);
    onClose();
  };

  /* 子任务与标签都先改本地草稿，点保存才落库（和标题、备注一致） */
  const addStep = () => {
    const text = stepDraft.trim();
    if (!text) return;
    patch({ checklist: [...form.checklist, { id: `ck_${Date.now().toString(36)}`, text, done: false }] });
    setStepDraft('');
  };

  /** 当前状态在流转链上的前后一步：详情里直接给成按钮，而不是让人自己对着下拉想 */
  const flowPrev = prevStatus(form.status);
  const flowNext = nextStatus(form.status);
  const moveStatus = (s: TicketStatus) => {
    patch({ status: s });
    if (ticket) onPatch(ticket.id, { status: s });
  };

  const addTag = (raw?: string) => {
    const typed = (raw ?? tagDraft).trim();
    setTagDraft('');
    if (!typed) return;
    // 已有同名标签（忽略大小写）就复用那一个，避免手打时造出只差大小写的近义标签
    const existing = allTags.find((t) => t.toLowerCase() === typed.toLowerCase());
    const tag = existing ?? typed;
    if (form.tags.includes(tag)) return;
    patch({ tags: [...form.tags, tag] });
  };

  const addComment = async () => {
    const content = commentDraft.trim();
    if (!content || !ticket) return;
    try {
      const saved = await api.tickets.comments.add(ticket.id, content);
      setComments((prev) => [...prev, saved]);
      setCommentDraft('');
    } catch {
      // 失败时保留草稿，用户可以直接再点一次
    }
  };

  const removeComment = async (id: string) => {
    const prev = comments;
    setComments((cur) => cur.filter((c) => c.id !== id));
    try {
      await api.tickets.comments.remove(id);
    } catch {
      setComments(prev);
    }
  };

  /**
   * 把文件读成 data URL 传上去。附件的选择框、备注区的粘贴与拖拽都走这一个入口，
   * 免得三处各写一套 FileReader。
   */
  const uploadFile = async (file: File, inline = false): Promise<TicketAttachment | null> => {
    if (!ticket) return null;
    setUploadError('');
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      setUploadError('读取文件失败');
      return null;
    }
    try {
      const saved = await api.tickets.attachments.add(ticket.id, {
        // 截图粘贴过来通常没有文件名，按 MIME 推一个，列表里才看得懂
        name: file.name || `粘贴的图片.${file.type.split('/')[1] || 'png'}`,
        mime: file.type,
        size: file.size,
        content: dataUrl,
        // 粘贴进正文的图标成 inline：它只在备注/评论里显示，不列进附件区
        inline,
      });
      setAttachments((prev) => [...prev, saved]);
      return saved;
    } catch (err) {
      setUploadError(err instanceof Error && err.message ? err.message : '上传失败');
      return null;
    }
  };

  /**
   * 粘贴 / 拖进来的文件：存成附件，再把图片挂到正文上。
   * 注意正文本身不含引用源码（见 splitNote），图片以缩略块显示在编辑框下方 ——
   * 用户既能看到图，又不会被 `![image.png](att:...)` 刷屏。
   */
  const uploadInto = async (files: File[], target: 'note' | 'comment') => {
    const adds: ImageRef[] = [];
    for (const file of files) {
      // inline=true：这些图属于正文，不列进附件区
      const saved = await uploadFile(file, true);
      if (saved) adds.push({ alt: saved.name, id: saved.id });
    }
    if (!adds.length) return;
    if (target === 'note') patch({ note: appendImageRefs(form.note, adds) });
    else setCommentDraft((cur) => appendImageRefs(cur, adds));
  };

  /** 从备注里移除一张图（只摘引用，附件本体仍留在附件区，可再次引用） */
  const removeNoteImage = (index: number) => {
    patch({ note: joinNote(noteParts.text, noteParts.refs.filter((_, i) => i !== index)) });
  };
  const removeCommentImage = (index: number) => {
    setCommentDraft(joinNote(commentParts.text, commentParts.refs.filter((_, i) => i !== index)));
  };

  /** 编辑框里显示的图片缩略块：点开可放大，右上角可摘掉 */
  const renderImageStrip = (refs: ImageRef[], onRemove: (index: number) => void) =>
    refs.length ? (
      <div className="mt-2 flex flex-wrap gap-2">
        {refs.map((ref, i) => {
          const file = attachments.find((a) => a.id === ref.id);
          return (
            <figure key={`${ref.id}-${i}`} className="group/img relative">
              {file && file.mime.startsWith('image/') ? (
                <button
                  type="button"
                  onClick={() => setPreview({ url: file.content, name: ref.alt || file.name })}
                  title="点击放大"
                  className="block cursor-zoom-in"
                >
                  <img
                    src={file.content}
                    alt={ref.alt}
                    className="h-20 w-20 rounded-field border border-line object-cover transition-opacity group-hover/img:opacity-90"
                  />
                </button>
              ) : (
                <span className="grid h-20 w-20 place-items-center rounded-field border border-line bg-panel-2 px-1 text-center text-[10px] leading-tight text-faint">
                  {ref.alt || '附件'}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={`移除图片 ${ref.alt}`}
                /* 触屏没有 hover：小屏常显这一颗，桌面端再退回"悬浮才出现"。
                   否则手机上插入的图片根本删不掉。 */
                className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-line bg-panel text-faint opacity-100 shadow-pop transition-opacity hover:text-crit focus-visible:opacity-100 sm:opacity-0 sm:group-hover/img:opacity-100"
              >
                <X size={11} />
              </button>
            </figure>
          );
        })}
      </div>
    ) : null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto overscroll-contain p-3 sm:p-6">
      <button type="button" aria-label="关闭详情" onClick={onClose} className="scrim fixed inset-0 cursor-default" />
      {/* 居中大弹窗：宽度比原来的右侧抽屉翻了一倍，高度卡在视口内。
          任务编辑要填的东西不少，27rem 的窄条塞不下。
          宽高都吃到视口为止 —— 上限（50rem / 58rem）会在高分辨率屏上留下
          一大圈背景，看起来像"窗口没打开"，而不是"窗口很大"。 */}
      <section
        role="dialog"
        aria-modal="true"
        aria-label={ticket ? `任务 ${ticket.id}` : '新建任务'}
        className="panel relative z-10 flex max-h-[calc(100dvh-2.5rem)] w-full max-w-[68rem] flex-col overflow-hidden shadow-pop animate-dialog-in"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-6 sm:py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-2xs text-faint">{ticket ? '任务详情' : '新建任务'}</p>
            <p className="num truncate text-[13px] font-medium">{ticket ? ticket.id : '未保存'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-field p-1.5 text-faint transition-colors hover:bg-panel-2 hover:text-ink"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-7 sm:py-5">
          {/* 标题是这张单子的主角：大字号、无边框，hover / 聚焦才显底 */}
          <label className="block">
            <span className="sr-only">任务标题</span>
            <textarea
              rows={2}
              value={form.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="要解决的问题，一句话说清"
              autoFocus
              className="w-full resize-none rounded-field bg-transparent px-1 py-0.5 text-[21px] font-semibold leading-snug tracking-tight text-ink outline-none transition-colors placeholder:text-faint hover:bg-panel-2/60 focus:bg-panel-2"
            />
          </label>

          {/* 属性按「字段名 → 值」排成一张工作单：比一堆各自独立的大区块省一半高度，
              这也正是 Tower 详情页字段区的做法。
              sm 起一行放两组（状态｜优先级），把加宽后的横向空间真正用起来 ——
              单列且限宽时右半边全是空的，弹窗一宽反而更显空。 */}
          <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-field bg-panel-2/50 px-3.5 py-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_3.5rem_minmax(0,1fr)]">
            <dt className="text-2xs text-faint">状态</dt>
            <dd>
              <Select
                value={form.status}
                onChange={(e) => {
                  const s = e.target.value as TicketStatus;
                  // 跳步（不相邻）先问一句 —— 最容易被误点成「已完成」的就是这个下拉
                  if (ticket && !isAdjacent(form.status, s)) {
                    const ok = window.confirm(
                      `从「${STATUS_META[form.status].label}」直接跳到「${STATUS_META[s].label}」？\n\n` +
                        `正常顺序是 ${STATUS_FLOW.map((x) => STATUS_META[x].label).join(' → ')}。`,
                    );
                    if (!ok) return;
                  }
                  patch({ status: s });
                  if (ticket) onPatch(ticket.id, { status: s });
                }}
                className="w-full py-1 text-2xs"
                aria-label="状态"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </Select>
            </dd>

            <dt className="self-center text-2xs text-faint">流转</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {flowPrev ? (
                <button
                  type="button"
                  onClick={() => moveStatus(flowPrev)}
                  className="rounded-full border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  ← {REVERT_LABEL[flowPrev]}
                </button>
              ) : (
                <span className="text-2xs text-faint">已是第一步</span>
              )}
              {flowNext ? (
                <button
                  type="button"
                  onClick={() => moveStatus(flowNext)}
                  className="rounded-full border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  {ADVANCE_LABEL[flowNext]} →
                </button>
              ) : (
                <span className="text-2xs text-ok">已是最后一步</span>
              )}
            </dd>

            <dt className="text-2xs text-faint">优先级</dt>
            <dd className="sm:col-span-3">
              <Select
                value={form.priority}
                onChange={(e) => {
                  const p = e.target.value as Priority;
                  patch({ priority: p });
                  if (ticket) onPatch(ticket.id, { priority: p });
                }}
                className="w-full py-1 text-2xs"
                aria-label="优先级"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_META[p].label}
                  </option>
                ))}
              </Select>
            </dd>

            {/* 项目和分类各占整行，并且都从第一列开始：
                它们是父子两级，并排两列或左右错开都看不出从属关系，
                而分类的候选本来就取决于上面选了哪个项目 */}
            <dt className="text-2xs text-faint sm:col-start-1">项目</dt>
            <dd className="sm:col-span-3">
              {/* 已经有项目就下拉挑；要新建时再切到输入态 ——
                  比 datalist 明确，也省得每建一条任务都手打一遍项目名 */}
              {newProject ? (
                <Input
                  autoFocus
                  value={form.project}
                  // 换项目就顺手清掉分类：分类只属于它原来那个项目，
                  // 留着会被挂到新项目里，成了一条谁也找不到的归属
                  onChange={(e) => patch({ project: e.target.value, section: '' })}
                  onBlur={() => setNewProject(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') setNewProject(false);
                  }}
                  placeholder="新项目名，回车确认"
                  className="py-1 text-2xs"
                  aria-label="新项目名"
                />
              ) : (
                <Select
                  value={form.project}
                  onChange={(e) => {
                    if (e.target.value === NEW_PROJECT) {
                      setNewProject(true);
                      patch({ project: '', section: '' });
                      return;
                    }
                    patch({ project: e.target.value, section: '' });
                  }}
                  className="w-full py-1 text-2xs"
                  aria-label="项目"
                >
                  <option value="">未归类</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                  <option value={NEW_PROJECT}>＋ 新建项目…</option>
                </Select>
              )}
            </dd>

            {/* col-start-1 是必需的：光靠自动流，分类会被摆到「项目」那一行的第三个格子里，
                看着像并排而不是从属 */}
            <dt className="text-2xs text-faint sm:col-start-1">分类</dt>
            <dd className="sm:col-span-3">
              {formProject ? (
                <Select
                  value={form.section}
                  onChange={(e) => patch({ section: e.target.value })}
                  className="w-full py-1 text-2xs"
                  aria-label="分类"
                >
                  <option value="">未分类</option>
                  {formSections.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                  {/* 历史值可能已经不在列表里（分类被改名或删掉了），补一条免得上拉显示成空白 */}
                  {form.section && !formSections.some((s) => s.name === form.section) ? (
                    <option value={form.section}>{form.section}</option>
                  ) : null}
                </Select>
              ) : (
                <span className="text-2xs text-faint">先选项目，才能挑它下面的分类</span>
              )}
            </dd>

            <dt className="text-2xs text-faint">负责人</dt>
            <dd>
              <Input
                value={form.owner}
                onChange={(e) => patch({ owner: e.target.value })}
                placeholder="未指派"
                className="py-1 text-2xs"
                aria-label="负责人"
              />
            </dd>

            <dt className="text-2xs text-faint">截止</dt>
            <dd>
              <Input
                type="date"
                value={form.due}
                onChange={(e) => patch({ due: e.target.value })}
                className="py-1 text-2xs"
                aria-label="截止日期"
              />
            </dd>

            <dt className="self-start pt-1 text-2xs text-faint">标签</dt>
            <dd className="flex flex-wrap items-center gap-1.5 py-0.5">
              {form.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-panel px-2 py-0.5 text-2xs text-muted">
                  {tag}
                  <button
                    type="button"
                    aria-label={`移除标签 ${tag}`}
                    onClick={() => patch({ tags: form.tags.filter((x) => x !== tag) })}
                    className="rounded-full text-faint transition-colors hover:text-crit"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <Input
                list="tag-options"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={() => addTag()}
                placeholder="加标签"
                className="w-[6.5rem] py-1 text-2xs"
                aria-label="添加标签"
              />
              <datalist id="tag-options">
                {allTags.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              {/* 用过的标签直接列出来，点一下就加。datalist 要敲字才弹，算不上"能选" */}
              {allTags.filter((t) => !form.tags.includes(t)).length ? (
                <div className="mt-1 flex w-full flex-wrap items-center gap-1">
                  <span className="text-2xs text-faint">已有：</span>
                  {allTags
                    .filter((t) => !form.tags.includes(t))
                    .slice(0, 12)
                    .map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addTag(t)}
                        className="rounded-full border border-line px-1.5 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
                      >
                        {t}
                      </button>
                    ))}
                </div>
              ) : null}
            </dd>
          </dl>

          {/* 子任务：Tower 的标志性模块 —— 标题旁挂计数与进度条，已完成的可以一键清掉。
              列表行与看板卡上也会显示 2/5 的进度。 */}
          <section aria-label="子任务" className="rounded-field border border-line px-3 py-2.5">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-medium text-ink">子任务</h3>
              {form.checklist.length ? (
                <>
                  <span className="num text-2xs text-faint">
                    {form.checklist.filter((c) => c.done).length}/{form.checklist.length}
                  </span>
                  <span aria-hidden className="h-1 w-14 overflow-hidden rounded-full bg-bg-2">
                    <span
                      className="block h-full rounded-full bg-ok transition-[width] duration-200"
                      style={{ width: `${(form.checklist.filter((c) => c.done).length / form.checklist.length) * 100}%` }}
                    />
                  </span>
                </>
              ) : null}
              {form.checklist.some((c) => c.done) ? (
                <button
                  type="button"
                  onClick={() => patch({ checklist: form.checklist.filter((c) => !c.done) })}
                  className="ml-auto text-2xs text-faint transition-colors hover:text-crit"
                >
                  清除已完成
                </button>
              ) : null}
            </div>

            <div className="mt-2 space-y-1">
              {form.checklist.map((step) => (
                <div key={step.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={step.done}
                    aria-label={step.done ? `取消完成「${step.text}」` : `完成「${step.text}」`}
                    onClick={() =>
                      patch({ checklist: form.checklist.map((c) => (c.id === step.id ? { ...c, done: !c.done } : c)) })
                    }
                    className={cls(
                      'grid h-[15px] w-[15px] shrink-0 place-items-center rounded-xs border transition-colors',
                      step.done ? 'border-ok bg-ok text-white' : 'border-line bg-panel-2 hover:border-accent',
                    )}
                  >
                    {step.done ? <Check size={10} strokeWidth={3} /> : null}
                  </button>
                  <span className={cls('min-w-0 flex-1 truncate text-[13px]', step.done ? 'text-faint line-through' : 'text-ink')}>
                    {step.text}
                  </span>
                  <button
                    type="button"
                    aria-label={`删除子任务「${step.text}」`}
                    onClick={() => patch({ checklist: form.checklist.filter((c) => c.id !== step.id) })}
                    className="shrink-0 rounded-field p-1 text-faint transition-colors hover:text-crit"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <Input
                value={stepDraft}
                onChange={(e) => setStepDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addStep();
                  }
                }}
                placeholder="回车添加一步"
                className="py-1 text-2xs"
                aria-label="添加子任务"
              />
            </div>
          </section>

          <Field label="备注 / 处理思路">
            <Textarea
              rows={5}
              value={noteParts.text}
              onChange={(e) => patch({ note: joinNote(e.target.value, noteParts.refs) })}
              placeholder="回滚点、影响面、排查线索…截图直接粘进来，图会显示在下面"
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files || []);
                if (!files.length) return;
                // 剪贴板里带文件（截图最常见）：别让浏览器把文件名插进正文，改成存附件 + 图片块
                e.preventDefault();
                void uploadInto(files, 'note');
              }}
              onDrop={(e) => {
                const files = Array.from(e.dataTransfer?.files || []);
                if (!files.length) return;
                e.preventDefault();
                void uploadInto(files, 'note');
              }}
            />
            {/* 图片以缩略块列出，正文里不出现 `![...](att:...)` 那串源码 */}
            {renderImageStrip(noteParts.refs, removeNoteImage)}
            {ticket ? (
              <p className="mt-1.5 text-2xs text-faint">
                截图粘贴或拖进来就会显示在下面；鼠标移到图上可移除，点图放大
              </p>
            ) : null}
          </Field>

          {/* 动态：独立小表逐行读写（见 server/db/comments.js），不进首屏数据 */}
          {ticket ? (
            <Field label={`动态（${comments.length}）`}>
              <div className="space-y-2">
                {comments.map((c) => (
                  <div key={c.id} className="group/cmt flex items-start gap-2 rounded-field bg-panel-2 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <RichText
                        text={c.content}
                        attachments={attachments}
                        onPreview={(url, name) => setPreview({ url, name })}
                        className="text-[12.5px] leading-relaxed text-ink"
                      />
                      <p className="num mt-1 text-2xs text-faint">{fmtRelative(c.createdAt)}</p>
                    </div>
                    <button
                      type="button"
                      aria-label="删除这条动态"
                      onClick={() => void removeComment(c.id)}
                      /* 同上：触屏看不到 hover，小屏常显删除键 */
                      className="shrink-0 rounded-field p-1.5 text-faint opacity-100 transition-opacity hover:text-crit focus-visible:opacity-100 sm:opacity-0 sm:group-hover/cmt:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Textarea
                      rows={2}
                      value={commentParts.text}
                      onChange={(e) => setCommentDraft(joinNote(e.target.value, commentParts.refs))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void addComment();
                        }
                      }}
                      placeholder="记一笔处置过程，截图可直接粘贴（⌘/Ctrl + Enter 提交）"
                      className="w-full text-2xs"
                      aria-label="新增动态"
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData?.files || []);
                        if (!files.length) return;
                        e.preventDefault();
                        void uploadInto(files, 'comment');
                      }}
                    />
                    {/* 评论里贴的图同样只显示图，不显示引用源码 */}
                    {renderImageStrip(commentParts.refs, removeCommentImage)}
                  </div>
                  <Button size="sm" variant="soft" disabled={!commentDraft.trim()} onClick={() => void addComment()}>
                    记录
                  </Button>
                </div>
              </div>
            </Field>
          ) : null}

          {/* 附件：本体是 data URL 存库、不落磁盘，上限见 server/db/attachments.js */}
          {ticket ? (
            <section aria-label="附件" className="rounded-field border border-line px-3 py-2.5">
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-medium text-ink">附件</h3>
                {fileAttachments.length ? <span className="num text-2xs text-faint">{fileAttachments.length}</span> : null}
                <label className="ml-auto cursor-pointer text-2xs text-accent transition-opacity hover:opacity-80">
                  添加文件
                  <input
                    type="file"
                    className="sr-only"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = ''; // 清空 value：同一个文件连着选两次也要能触发
                      for (const file of files) void uploadFile(file);
                    }}
                  />
                </label>
              </div>

              {uploadError ? <p className="mt-1.5 text-2xs text-crit">{uploadError}</p> : null}

              {fileAttachments.length ? (
                <ul className="mt-2 space-y-1.5">
                  {fileAttachments.map((file) => (
                    <li key={file.id} className="flex items-center gap-2.5 rounded-field bg-panel-2 px-2.5 py-2">
                      {file.mime.startsWith('image/') ? (
                        <button
                          type="button"
                          onClick={() => setPreview({ url: file.content, name: file.name })}
                          title="点击放大"
                          className="shrink-0 cursor-zoom-in"
                        >
                          <img src={file.content} alt={file.name} className="h-10 w-10 rounded-field object-cover" />
                        </button>
                      ) : (
                        <span className="num grid h-10 w-10 shrink-0 place-items-center rounded-field bg-panel text-[9px] uppercase text-faint">
                          {(file.name.split('.').pop() || 'file').slice(0, 4)}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        {/* 图片点了就放大看；其它类型仍是下载 */}
                        {file.mime.startsWith('image/') ? (
                          <button
                            type="button"
                            onClick={() => setPreview({ url: file.content, name: file.name })}
                            className="block max-w-full truncate text-left text-[12.5px] text-ink transition-colors hover:text-accent"
                          >
                            {file.name}
                          </button>
                        ) : (
                          <a
                            href={file.content}
                            download={file.name}
                            className="block truncate text-[12.5px] text-ink transition-colors hover:text-accent"
                          >
                            {file.name}
                          </a>
                        )}
                        <p className="num text-2xs text-faint">{fmtBytes(file.size)}</p>
                      </div>
                      <button
                        type="button"
                        aria-label={`删除附件 ${file.name}`}
                        onClick={() => {
                          // 删除失败不额外回滚：下次打开抽屉会重新拉取，界面自己就纠正了
                          setAttachments((cur) => cur.filter((f) => f.id !== file.id));
                          void api.tickets.attachments.remove(file.id);
                        }}
                        className="shrink-0 rounded-field p-1 text-faint transition-colors hover:text-crit"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-2xs text-faint">还没有附件。日志、截图、配置文件都可以，单个 ≤1.5MB、最多 10 个。</p>
              )}
            </section>
          ) : null}

          {ticket ? (
            <p className="num text-2xs leading-relaxed text-faint">
              创建于 {fmtRelative(ticket.createdAt)}
              {ticket.updatedAt ? ` · 更新于 ${fmtRelative(ticket.updatedAt)}` : ''}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          {ticket ? (
            <>
              {ticket.deletedAt || ticket.archivedAt ? (
                <Button variant="soft" onClick={() => onLifecycle(ticket.id, 'restore')}>
                  <RotateCcw size={13} />
                  恢复
                </Button>
              ) : (
                <>
                  <Button variant="soft" onClick={() => onLifecycle(ticket.id, 'archive')}>
                    <Archive size={13} />
                    归档
                  </Button>
                  <Button variant="danger" onClick={() => onLifecycle(ticket.id, 'trash')}>
                    <Trash2 size={13} />
                    移入回收站
                  </Button>
                </>
              )}
              {ticket.deletedAt ? (
                <Button
                  variant="danger"
                  onClick={() => {
                    onDelete(ticket.id);
                    onClose();
                  }}
                >
                  <Trash2 size={13} />
                  彻底删除
                </Button>
              ) : null}
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={busy || !form.title.trim()} onClick={save}>
              {busy ? <Spinner /> : null}
              {ticket ? '保存' : '创建任务'}
            </Button>
          </div>
        </footer>
      </section>

      {/* 图片放大：备注内联图、评论图、附件缩略图都点得开，不必先下载到本地 */}
      {preview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`查看图片 ${preview.name}`}
          onClick={() => setPreview(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 sm:p-8"
        >
          <img src={preview.url} alt={preview.name} className="max-h-full max-w-full rounded-field object-contain shadow-pop" />
          <button
            type="button"
            onClick={() => setPreview(null)}
            aria-label="关闭预览"
            className="absolute right-4 top-4 rounded-field bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
