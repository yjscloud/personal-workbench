import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  GripVertical,
  Layers,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useStore } from '@/lib/store';
import { api, type Project, type ProjectSection, type Ticket } from '@/lib/api';
import { cls, fmtDate } from '@/lib/format';
import { Button, Empty, Input, Select, SkeletonLines } from '@/components/ui';
import { PriorityBadge } from '@/components/bits';
import { ADVANCE_LABEL, nextStatus, prevStatus } from '@/lib/workflow';

/** 「未分类」那一组的 key。顶部「添加任务」也落在这一组，两边必须用同一个值 */
const NONE_KEY = 's-none';

/**
 * 项目视图：任务页里「选中某个项目」时主区渲染的内容。
 *
 * 刻意不做成独立页面 —— 项目是任务的一种视图，不是并列的第二个入口。
 * 结构对齐 Tower 的项目内列表：分类分组（可折叠）+ 列头 + 组内任务 + 记录总数。
 * 分类只在选中项目时才去拉，不进 store，免得首屏为每个项目各请求一次。
 */
export function ProjectBoard({
  project,
  onOpen,
  onDeleted,
}: {
  project: Project;
  onOpen: (id: string) => void;
  /** 项目删掉后通知外面把筛选退回「全部任务」，否则主区会空着 */
  onDeleted?: () => void;
}) {
  const { tickets, ticketsApi, projectsApi, refreshAll } = useStore();

  const [sections, setSections] = useState<ProjectSection[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * 已收起的分类。默认**全部展开** —— 点进项目就该直接看到任务，
   * 不然每看一次都要先把分类挨个点开，反倒更累。
   * 想先看概览时再手动收起（或点顶部的「全部收起」）。
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sectionDraft, setSectionDraft] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [sectionEdit, setSectionEdit] = useState('');
  const [sectionMenuId, setSectionMenuId] = useState<string | null>(null);
  /** 正在哪个分组里加任务（'' = 未分类，null = 不在加） */
  const [addingTaskIn, setAddingTaskIn] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState('');
  const [error, setError] = useState('');
  /** 拖拽经过哪一组：只做视觉反馈 */
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  /**
   * 把任务拖到别的分类。分类名本身就是归属（tickets.section），所以这里只改一个字段。
   * 拖回原分组时直接返回 —— 不然会白发一次请求，还多一次无意义的重渲染。
   */
  const moveToSection = async (ticketId: string, sectionName: string) => {
    const target = tickets.find((x) => x.id === ticketId);
    if (!target || (target.section?.trim() || '') === sectionName) return;
    await ticketsApi.patch(ticketId, { section: sectionName });
  };
  /* 项目自身的改名 / 删除。放在主区常显 —— 塞进左侧栏的悬停菜单等于藏起来，找不到 */
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const renameProject = async () => {
    const clean = nameDraft.trim();
    setRenaming(false);
    if (!clean || clean === project.name) {
      setNameDraft(project.name);
      return;
    }
    try {
      await projectsApi.rename(project.id, clean);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    }
  };

  const removeProject = async () => {
    setConfirmDelete(false);
    try {
      await projectsApi.remove(project.id);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除项目失败');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { sections: list } = await api.projects.sections(project.id);
      setSections(list);
      setError('');
    } catch (err) {
      setSections([]);
      setError(err instanceof Error ? err.message : '分类加载失败');
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const mine = useMemo(
    () => tickets.filter((t) => !t.deletedAt && t.project?.trim() === project.name),
    [tickets, project.name],
  );

  const bySection = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const t of mine) {
      const key = t.section?.trim() || '';
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return map;
  }, [mine]);

  /** 已建分类 + 任务里出现但还没建分类的名字（否则那些任务会没处显示） */
  const groups = useMemo(() => {
    const known = new Set(sections.map((s) => s.name));
    const orphans = [...bySection.keys()]
      .filter((key) => key && !known.has(key))
      .map((name, i) => ({ id: `ghost:${name}`, projectId: project.id, name, sort: 900 + i, createdAt: '' }));
    return [...sections, ...orphans];
  }, [sections, bySection, project.id]);

  const unassigned = bySection.get('') ?? [];

  /** 移动任务时的候选目标：'' = 未分类，其余是各分类名。
      触屏上 HTML5 拖拽根本不触发，TaskLine 里那个下拉（lg 以下才出现）
      是手机端把任务换分类的唯一入口，不能省。 */
  const moveTargets = useMemo(() => ['', ...groups.map((g) => g.name)], [groups]);

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** 全部收起 / 全部展开：分类多的时候一个个点太累 */
  const toggleAll = () => {
    const keys = [...groups.map((s) => `s-${s.id}`), NONE_KEY];
    setCollapsed((prev) => (prev.size ? new Set() : new Set(keys)));
  };

  const addSection = async () => {
    const name = sectionDraft.trim();
    setSectionDraft('');
    setAddingSection(false);
    if (!name) return;
    try {
      await api.projects.addSection(project.id, name);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建分类失败');
    }
  };

  const renameSection = async (section: ProjectSection, name: string) => {
    setEditingSectionId(null);
    const clean = name.trim();
    if (!clean || clean === section.name) return;
    try {
      await api.sections.rename(section.id, clean);
      await load();
      // 任务侧存的是分类名，改名后 store 里的任务也得跟着刷
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    }
  };

  const removeSection = async (section: ProjectSection) => {
    setSectionMenuId(null);
    if (section.id.startsWith('ghost:')) return;
    await api.sections.remove(section.id);
    await load();
    await refreshAll();
  };

  const addTask = async (sectionName: string) => {
    const title = taskDraft.trim();
    setTaskDraft('');
    setAddingTaskIn(null);
    if (!title) return;
    await ticketsApi.add({ title, status: 'todo', project: project.name, section: sectionName });
  };

  const renderGroup = (key: string, name: string, section: ProjectSection | null, tasks: Ticket[]) => {
    const isCollapsed = collapsed.has(key);
    const done = tasks.filter((t) => t.status === 'done').length;

    return (
      <section
        key={key}
        /* 整组都算放置区（连表头和底部一起）—— 空分组也得能接住拖过来的任务 */
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOverKey(key);
        }}
        onDragLeave={() => setDragOverKey((cur) => (cur === key ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverKey(null);
          const id = e.dataTransfer.getData('text/plain');
          if (id) void moveToSection(id, name);
        }}
        /* 分类菜单是向下弹出的浮层，而 .panel 默认要 overflow-hidden 才收得住
           最后一行悬停底的方角。菜单打开的这一组临时放开裁剪 ——
           否则分类任务少（或已收起）时，菜单会被自己的分组切掉。 */
        className={cls(
          'panel transition-colors',
          sectionMenuId === section?.id ? '' : 'overflow-hidden',
          dragOverKey === key && 'bg-accent-soft/40',
        )}
        aria-label={`分类 ${name || '未分类'}`}
      >
        <header className="flex items-center gap-1.5 border-b border-line px-3 py-2.5 sm:px-4">
          <button
            type="button"
            onClick={() => toggleCollapse(key)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `展开「${name || '未分类'}」` : `收起「${name || '未分类'}」`}
            className="rounded-field p-0.5 text-faint transition-colors hover:text-ink"
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>

          {section && editingSectionId === section.id ? (
            <Input
              autoFocus
              value={sectionEdit}
              onChange={(e) => setSectionEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void renameSection(section, sectionEdit);
                }
                if (e.key === 'Escape') setEditingSectionId(null);
              }}
              onBlur={() => void renameSection(section, sectionEdit)}
              aria-label="分类名"
              className="max-w-[14rem] py-1 text-2xs"
            />
          ) : (
            /* min-w-0 + truncate：分类名一长，右侧的计数、进度条和按钮组
               会被顶出分组容器（表头是一整行 flex，没有截断就会撑开） */
            <h2
              title={name ? undefined : '这些任务还没归类。拖到上面的任意分类里，这一组就会自动消失。'}
              className={cls('min-w-0 truncate text-[13px] font-medium', name ? 'text-ink' : 'text-faint')}
            >
              {name || '未分类'}
            </h2>
          )}
          <span className="num text-2xs text-faint">
            {tasks.length} 条{done ? ` · 已完成 ${done}` : ''}
          </span>
          {/* 折叠状态下也能看出这一类做到哪了，不用点开 */}
          {tasks.length ? (
            <span aria-hidden className="hidden h-1 w-16 overflow-hidden rounded-full bg-bg-2 sm:block">
              <span
                className="block h-full rounded-full bg-ok transition-[width]"
                style={{ width: `${(done / tasks.length) * 100}%` }}
              />
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setAddingTaskIn(key);
                setTaskDraft('');
              }}
              aria-label={`在「${name || '未分类'}」里添加任务`}
              className="rounded-field p-1 text-faint transition-colors hover:text-accent"
            >
              <Plus size={13} />
            </button>
            {section && !section.id.startsWith('ghost:') ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSectionMenuId((cur) => (cur === section.id ? null : section.id))}
                  aria-label={`${name} 的分类菜单`}
                  aria-expanded={sectionMenuId === section.id}
                  className="rounded-field p-1 text-faint transition-colors hover:text-ink"
                >
                  <MoreVertical size={13} />
                </button>
                {sectionMenuId === section.id ? (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-30 w-[8rem] rounded-field border border-line bg-panel py-1 shadow-pop"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSectionEdit(section.name);
                        setEditingSectionId(section.id);
                        setSectionMenuId(null);
                      }}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-2xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                    >
                      <Pencil size={11} />
                      重命名
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void removeSection(section)}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-2xs text-crit transition-colors hover:bg-panel-2"
                    >
                      <Trash2 size={11} />
                      删除分类
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>

        {isCollapsed ? null : (
          <>
            {tasks.length ? (
              <ul className="divide-y divide-[color:var(--line)]">
                {tasks.map((t) => (
                  <TaskLine
                    key={t.id}
                    ticket={t}
                    onOpen={() => onOpen(t.id)}
                    targets={moveTargets}
                    onMove={(name) => void moveToSection(t.id, name)}
                  />
                ))}
              </ul>
            ) : null}

            {addingTaskIn === key ? (
              <div className="px-4 py-2">
                <Input
                  autoFocus
                  value={taskDraft}
                  onChange={(e) => setTaskDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void addTask(name);
                    }
                    if (e.key === 'Escape') setAddingTaskIn(null);
                  }}
                  onBlur={() => void addTask(name)}
                  placeholder="任务标题，回车添加"
                  aria-label="新任务标题"
                  className="max-w-[28rem] py-1 text-2xs"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAddingTaskIn(key);
                  setTaskDraft('');
                }}
                className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-2xs text-faint transition-colors hover:text-accent"
              >
                <Plus size={12} />
                点击添加任务
              </button>
            )}

            {/* 记录总数：Tower 每个分组底部都有，用来一眼看清这个分类的体量 */}
            <p className="num border-t border-line px-4 py-1.5 text-2xs text-faint">
              记录总数 {tasks.length}
              {done ? ` · 已完成 ${done}` : ''}
            </p>
          </>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-3">
      <section className="panel flex flex-wrap items-center gap-2 px-4 py-2.5" aria-label="项目操作">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            // 顶部按钮新加的任务先落在「未分类」：它还没有归属，先记下来、之后拖进分类即可。
            // 这里必须用组真实的 key —— 之前写的是空字符串，和 renderGroup 用的 key 对不上，
            // 于是点了按钮什么都不会出现。
            setAddingTaskIn(NONE_KEY);
            setTaskDraft('');
          }}
        >
          <Plus size={13} />
          添加任务
        </Button>
        <Button size="sm" variant="soft" onClick={() => setAddingSection(true)}>
          <Layers size={12} />
          新建分类
        </Button>
        {/* 分类多了逐个点太累，给一个一键切换 */}
        <Button size="sm" variant="ghost" onClick={toggleAll}>
          <ChevronsUpDown size={12} />
          {collapsed.size ? '展开全部' : '全部收起'}
        </Button>
        {addingSection ? (
          <Input
            autoFocus
            value={sectionDraft}
            onChange={(e) => setSectionDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addSection();
              }
              if (e.key === 'Escape') {
                setSectionDraft('');
                setAddingSection(false);
              }
            }}
            onBlur={() => void addSection()}
            placeholder="分类名，回车创建"
            aria-label="新分类名称"
            className="max-w-[16rem] py-1 text-2xs"
          />
        ) : null}
        <span className="num text-2xs text-faint">
          {project.name} · {mine.length} 条任务
        </span>

        {/* 项目自身的操作常显在这里。之前藏在左侧栏的悬停菜单里，
            不悬停就完全看不见（实测 opacity 是 0），等于没有这个功能 */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {renaming ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void renameProject();
                }
                if (e.key === 'Escape') {
                  setNameDraft(project.name);
                  setRenaming(false);
                }
              }}
              onBlur={() => void renameProject()}
              aria-label="项目名"
              className="max-w-[16rem] py-1 text-2xs"
            />
          ) : (
            <Button
              size="sm"
              variant="soft"
              onClick={() => {
                setNameDraft(project.name);
                setRenaming(true);
              }}
            >
              <Pencil size={12} />
              重命名项目
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={12} />
            删除项目
          </Button>
        </div>
      </section>

      {error ? (
        <div className="panel px-4 py-2.5">
          <p className="text-2xs text-crit">{error}</p>
        </div>
      ) : null}

      {/* 列头：与下面的任务行共用一套宽度，分头写就会错位 */}
      <div className="hidden items-center gap-2 px-4 pb-1 text-2xs text-faint lg:flex" aria-hidden>
        <span className="w-[13px] shrink-0" />
        <span className="w-4 shrink-0" />
        <span className="min-w-0 flex-1">任务</span>
        <span className="w-[5rem] shrink-0">负责人</span>
        <span className="w-[5.5rem] shrink-0">截止</span>
        <span className="w-[3.5rem] shrink-0">优先级</span>
        <span className="w-[5.5rem] shrink-0">下一步</span>
      </div>

      {loading ? (
        /* 上面表头已经渲染出来了，这里只补行。
            原来是一个居中转圈 + 固定 128 高，数据到达时要跳好几百像素；
            换成五行按真实列宽排的占位，高度也就跟着真实行走了。 */
        <div className="panel p-4" role="status" aria-busy="true">
          <div className="divide-y divide-line">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 py-3.5">
                <div className="min-w-0 flex-1">
                  <SkeletonLines lines={1} />
                </div>
                <div className="w-[4.5rem] shrink-0">
                  <SkeletonLines lines={1} />
                </div>
                <div className="w-[3.5rem] shrink-0">
                  <SkeletonLines lines={1} />
                </div>
              </div>
            ))}
          </div>
          <span className="sr-only">正在加载任务…</span>
        </div>
      ) : (
        <>
          {groups.map((s) => renderGroup(`s-${s.id}`, s.name, s, bySection.get(s.name) ?? []))}
          {/* 未分类永远放最后：它是兜底，不该排在做好的分类前面。
              没有未归类任务时就不显示 —— 它不是能删的分类，只是「没有分类」的任务的落脚处。
              例外是「正在这一组里加任务」：那时必须让它出现，否则输入框无处安放。 */}
          {unassigned.length || addingTaskIn === NONE_KEY ? renderGroup(NONE_KEY, '', null, unassigned) : null}

          {groups.length === 0 && unassigned.length === 0 ? (
            <div className="panel py-14">
              <Empty
                title="这个项目还没有任务"
                hint="先建几个分类（比如「需求」「进行中」「已完成」），再往里加任务。"
                action={
                  <Button size="sm" variant="soft" onClick={() => setAddingSection(true)}>
                    <Layers size={12} />
                    新建分类
                  </Button>
                }
              />
            </div>
          ) : null}
        </>
      )}
      {/* 删项目不可逆，先问一句。文案写清任务会保留、只是失去归属 */}
      {confirmDelete ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="取消删除"
            onClick={() => setConfirmDelete(false)}
            className="scrim fixed inset-0 cursor-default"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="确认删除项目"
            className="panel relative z-10 w-full max-w-[26rem] p-5 shadow-pop animate-dialog-in"
          >
            <h2 className="text-[15px] font-semibold text-ink">删除项目「{project.name}」？</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              项目下的 {mine.length} 条任务会保留，但变成「未归类」；项目里的分类会一并删除。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                取消
              </Button>
              <Button size="sm" variant="danger" onClick={() => void removeProject()}>
                <Trash2 size={12} />
                删除项目
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* 任务行：列宽与上面的列头严格对应 */

function TaskLine({
  ticket,
  onOpen,
  targets,
  onMove,
}: {
  ticket: Ticket;
  onOpen: () => void;
  /** 可移动到的分类名（'' = 未分类） */
  targets: string[];
  onMove: (sectionName: string) => void;
}) {
  const { ticketsApi } = useStore();
  const done = ticket.status === 'done';
  const next = nextStatus(ticket.status);
  const current = ticket.section?.trim() || '';

  return (
    <li
      draggable
      onDragStart={(e) => {
        // 只带任务 id：落到哪个分类由放置方决定，不写死在拖拽数据里
        e.dataTransfer.setData('text/plain', ticket.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      title="拖到其它分类即可移动"
      className="group/row flex cursor-grab items-center gap-2 px-3 py-2 transition-colors hover:bg-panel-2/50 active:cursor-grabbing sm:px-4"
    >
      <GripVertical size={13} className="shrink-0 text-faint" aria-hidden />
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `把「${ticket.title}」退回待验证` : `把「${ticket.title}」标记为已完成`}
        onClick={() =>
          // 取消完成时退回**上一步**（待验证），而不是一步跳回待处理 ——
          // 后者等于连着跳两步，跟「顺序流转」的规则自相矛盾
          void ticketsApi.patch(ticket.id, { status: done ? prevStatus('done') ?? 'todo' : 'done' })
        }
        className={cls(
          'grid h-4 w-4 shrink-0 place-items-center rounded-xs border transition-colors',
          done ? 'border-ok bg-ok text-white' : 'border-line bg-panel-2 hover:border-accent',
        )}
      >
        {done ? <Check size={10} strokeWidth={3} /> : null}
      </button>

      <button
        type="button"
        onClick={onOpen}
        aria-label={`编辑任务 ${ticket.title}`}
        className={cls(
          'min-w-0 flex-1 truncate text-left text-[13px] transition-colors',
          done ? 'text-faint line-through' : 'text-ink hover:text-accent',
        )}
      >
        {ticket.title}
      </button>

      <span className="hidden w-[5rem] shrink-0 truncate text-2xs text-faint lg:block">{ticket.owner || '—'}</span>
      <span className="num hidden w-[5.5rem] shrink-0 text-2xs text-faint lg:block">
        {ticket.due ? fmtDate(ticket.due) : '—'}
      </span>
      <span className="w-[3.5rem] shrink-0">
        <PriorityBadge priority={ticket.priority} />
      </span>

      {/* 明确的「下一步」：点一下走一格。没有它的话，状态就只是个随便改的标签 */}
      <span className="hidden w-[5.5rem] shrink-0 lg:block">
        {next ? (
          <button
            type="button"
            onClick={() => void ticketsApi.patch(ticket.id, { status: next })}
            className="rounded-full border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent"
          >
            {ADVANCE_LABEL[next]}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-2xs text-ok">
            <Check size={11} />
            已完成
          </span>
        )}
      </span>

      {/* 触屏没有 HTML5 拖拽，上面那个 draggable 在手机上等于零。
          用原生 select 补一个「换分类」入口：原生弹层不受分组的
          overflow 裁剪，也比自绘菜单好点。lg 以上拖拽本来就好用，藏起来。 */}
      {targets.length > 1 ? (
        <Select
          value={current}
          onChange={(e) => onMove(e.target.value)}
          aria-label={`移动「${ticket.title}」到其它分类`}
          className="w-[6.5rem] shrink-0 py-1 text-2xs lg:hidden"
        >
          {targets.map((s) => (
            <option key={s || '__none'} value={s}>
              {s || '未分类'}
            </option>
          ))}
        </Select>
      ) : null}
    </li>
  );
}
