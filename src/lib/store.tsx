import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Bookmark,
  type Group,
  type KnowledgeItem,
  type Priority,
  type Project,
  type Settings,
  type Ticket,
  type Todo,
} from './api';

type Toast = { id: number; text: string; tone: 'ok' | 'warn' | 'crit' };

type StoreValue = {
  ready: boolean;
  error: string | null;
  todos: Todo[];
  tickets: Ticket[];
  bookmarks: Bookmark[];
  groups: Group[];
  knowledge: KnowledgeItem[];
  settings: Settings | null;
  newsMeta: { updatedAt: string | null; lastError: string | null; count: number };
  toasts: Toast[];
  notify: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  refreshAll: () => Promise<void>;
  todosApi: {
    add: (text: string, priority?: Priority) => Promise<void>;
    toggle: (todo: Todo) => Promise<void>;
    patch: (id: string, patch: Partial<Todo>) => Promise<void>;
    remove: (id: string) => Promise<void>;
    clearDone: () => Promise<void>;
  };
  projects: Project[];
  projectsApi: {
    create: (name: string, note?: string) => Promise<Project | null>;
    rename: (id: string, name: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
  ticketsApi: {
    add: (body: Partial<Ticket> & { title: string }) => Promise<void>;
    patch: (id: string, patch: Partial<Ticket>) => Promise<void>;
    /** 批量改：整批乐观更新，失败整批回滚 */
    patchMany: (ids: string[], patch: Partial<Ticket>) => Promise<void>;
    /** 归档 / 取消归档 */
    archive: (id: string, archived?: boolean) => Promise<void>;
    /** 移入回收站（软删除，可恢复） */
    trash: (id: string) => Promise<void>;
    /** 从归档 / 回收站恢复 */
    restore: (id: string) => Promise<void>;
    /** 批量归档 / 回收站 / 恢复 */
    bulkLifecycle: (ids: string[], kind: 'archive' | 'trash' | 'restore') => Promise<void>;
    /** 彻底删除，只在回收站里用 */
    remove: (id: string) => Promise<void>;
    /** 批量彻底删除（回收站）。整批乐观移除，失败整批回滚 */
    removeMany: (ids: string[]) => Promise<void>;
  };
  bookmarksApi: {
    /** 返回新建的书签（拿 id 去补品牌色），失败返回 null */
    add: (body: Partial<Bookmark> & { name: string; url: string }) => Promise<Bookmark | null>;
    patch: (id: string, patch: Partial<Bookmark>) => Promise<void>;
    remove: (id: string) => Promise<void>;
    /** 探测站点品牌色并写回。返回汇总，交给页面报"几个取到、几个没取到" */
    syncColors: (opts?: { force?: boolean; ids?: string[] }) => Promise<{
      total: number;
      updated: number;
      failed: { id: string; name: string; error: string }[];
    }>;
    /** 新建分类 */
    createGroup: (name: string) => Promise<void>;
    /** 改分类名。重名会被后端拒绝，这里整批回滚并报错 */
    renameGroup: (id: string, name: string) => Promise<void>;
    /**
     * 重排分类顺序：传拖动或「按名称排序」之后的完整 id 顺序。
     * 成功返回 true —— 调用方据此决定要不要报「已按名称排序」，
     * 失败时这里已经回滚并弹过错误了。
     */
    reorderGroups: (ids: string[]) => Promise<boolean>;
  };
  knowledgeApi: {
    /** 成功时返回落库后的条目（编辑器要拿它的 id 跳转到阅读页） */
    add: (body: Partial<KnowledgeItem> & { title: string }) => Promise<KnowledgeItem | null>;
    patch: (id: string, patch: Partial<KnowledgeItem>) => Promise<void>;
    /** 标签批量改名 / 合并 / 删除。改名到已存在的名字 = 合并 */
    retag: (body: { renames?: { from: string; to: string }[]; removes?: string[] }) => Promise<boolean>;
    /** 移入回收站（软删除，可恢复） */
    trash: (id: string) => Promise<void>;
    /** 从回收站拿回来。恢复不动 updatedAt，所以排回原位 */
    restore: (id: string) => Promise<void>;
    /** 批量移入回收站 / 恢复。整批乐观更新，失败整批回滚，只提示一次 */
    bulkBin: (ids: string[], kind: 'trash' | 'restore') => Promise<void>;
    /** 彻底删除。只在回收站里用，服务端会拒掉还没进回收站的 id */
    remove: (id: string) => Promise<void>;
    /** 批量彻底删除（回收站） */
    removeMany: (ids: string[]) => Promise<void>;
  };
  /**
   * 保存设置。成功返回落库后的那一份，失败返回 null。
   *
   * **失败不抛、也不返回 true/false 之外的东西**，是因为调用方常常还要做收尾：
   * 典型的是清空刚填进去的密钥输入框 —— 存失败还照清，用户刚敲的密钥就没了。
   */
  saveSettings: (patch: Record<string, unknown>) => Promise<Settings | null>;
};

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 AppProvider 内使用');
  return ctx;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [newsMeta, setNewsMeta] = useState<{ updatedAt: string | null; lastError: string | null; count: number }>({
    updatedAt: null,
    lastError: null,
    count: 0,
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (text: string, tone: Toast['tone'] = 'ok') => {
      toastSeq.current += 1;
      const id = toastSeq.current;
      setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
      window.setTimeout(() => dismissToast(id), 3600);
    },
    [dismissToast],
  );

  const refreshAll = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setTodos(data.todos);
      setTickets(data.tickets);
      setProjects(data.projects ?? []);
      setBookmarks(data.bookmarks);
      setGroups(data.groups);
      setKnowledge(data.knowledge);
      setSettings(data.settings);
      setNewsMeta(data.news);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  /* ── 待办 ───────────────────────────────────────────────────────── */
  const todosApi = useMemo(
    () => ({
      async add(text: string, priority: Priority = 'P2') {
        try {
          const todo = await api.todos.create({ text, priority });
          setTodos((prev) => [todo, ...prev]);
        } catch (err) {
          notify(err instanceof Error ? err.message : '添加失败', 'crit');
        }
      },
      async toggle(todo: Todo) {
        setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)));
        try {
          await api.todos.update(todo.id, { done: !todo.done });
        } catch (err) {
          setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, done: todo.done } : t)));
          notify(err instanceof Error ? err.message : '更新失败', 'crit');
        }
      },
      async patch(id: string, patch: Partial<Todo>) {
        setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
        try {
          await api.todos.update(id, patch);
        } catch (err) {
          notify(err instanceof Error ? err.message : '更新失败', 'crit');
        }
      },
      async remove(id: string) {
        const prev = todos;
        setTodos((cur) => cur.filter((t) => t.id !== id));
        try {
          await api.todos.remove(id);
        } catch (err) {
          setTodos(prev);
          notify(err instanceof Error ? err.message : '删除失败', 'crit');
        }
      },
      async clearDone() {
        try {
          const { removed } = await api.todos.clearDone();
          setTodos((prev) => prev.filter((t) => !t.done));
          if (removed) notify(`已清理 ${removed} 条已完成待办`);
        } catch (err) {
          notify(err instanceof Error ? err.message : '清理失败', 'crit');
        }
      },
    }),
    [todos, notify],
  );

  /* ── 任务 ───────────────────────────────────────────────────────── */
  const ticketsApi = useMemo(
    () => ({
      async add(body: Partial<Ticket> & { title: string }) {
        try {
          const ticket = await api.tickets.create(body);
          setTickets((prev) => [ticket, ...prev]);
          notify(`已创建任务 ${ticket.id}`);
        } catch (err) {
          notify(err instanceof Error ? err.message : '创建失败', 'crit');
        }
      },
      async patch(id: string, patch: Partial<Ticket>) {
        const prev = tickets;
        setTickets((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)));
        try {
          await api.tickets.update(id, patch);
        } catch (err) {
          // 以前这里只提示不回滚：界面显示改好了、库里其实没改，是典型的假成功
          setTickets(prev);
          notify(err instanceof Error ? err.message : '更新失败', 'crit');
        }
      },
      /** 批量改：整批乐观更新，失败整批回滚 */
      async patchMany(ids: string[], patch: Partial<Ticket>) {
        if (!ids.length) return;
        const prev = tickets;
        const target = new Set(ids);
        setTickets((cur) => cur.map((t) => (target.has(t.id) ? { ...t, ...patch } : t)));
        try {
          await api.tickets.updateMany(ids, patch);
          notify(`已更新 ${ids.length} 条任务`);
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '批量更新失败', 'crit');
        }
      },
      /** 归档 / 取消归档 */
      async archive(id: string, archived = true) {
        const prev = tickets;
        setTickets((cur) =>
          cur.map((t) => (t.id === id ? { ...t, archivedAt: archived ? new Date().toISOString() : null } : t)),
        );
        try {
          await api.tickets.archive(id, archived);
          notify(archived ? '已归档' : '已取消归档');
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '归档失败', 'crit');
        }
      },
      /** 移入回收站（软删除，可恢复） */
      async trash(id: string) {
        const prev = tickets;
        setTickets((cur) => cur.map((t) => (t.id === id ? { ...t, deletedAt: new Date().toISOString() } : t)));
        try {
          await api.tickets.trash(id);
          notify('已移入回收站');
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '移入回收站失败', 'crit');
        }
      },
      /** 从归档 / 回收站恢复 */
      async restore(id: string) {
        const prev = tickets;
        setTickets((cur) => cur.map((t) => (t.id === id ? { ...t, archivedAt: null, deletedAt: null } : t)));
        try {
          await api.tickets.restore(id);
          notify('已恢复');
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '恢复失败', 'crit');
        }
      },
      /** 批量归档 / 回收站 / 恢复：逐条走，最后只提示一次（否则 10 条会弹 10 个 toast） */
      async bulkLifecycle(ids: string[], kind: 'archive' | 'trash' | 'restore') {
        if (!ids.length) return;
        const prev = tickets;
        const target = new Set(ids);
        const stamp = new Date().toISOString();
        setTickets((cur) =>
          cur.map((t) => {
            if (!target.has(t.id)) return t;
            if (kind === 'archive') return { ...t, archivedAt: stamp };
            if (kind === 'trash') return { ...t, deletedAt: stamp };
            return { ...t, archivedAt: null, deletedAt: null };
          }),
        );
        try {
          await Promise.all(
            ids.map((id) =>
              kind === 'archive'
                ? api.tickets.archive(id)
                : kind === 'trash'
                  ? api.tickets.trash(id)
                  : api.tickets.restore(id),
            ),
          );
          notify(
            kind === 'archive'
              ? `已归档 ${ids.length} 条`
              : kind === 'trash'
                ? `已移入回收站 ${ids.length} 条`
                : `已恢复 ${ids.length} 条`,
          );
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '批量操作失败', 'crit');
        }
      },
      /** 彻底删除：丢数据，只在回收站里用 */
      async remove(id: string) {
        const prev = tickets;
        setTickets((cur) => cur.filter((t) => t.id !== id));
        try {
          await api.tickets.remove(id);
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '删除失败', 'crit');
        }
      },
      /** 批量彻底删除（回收站）：整批乐观移除，失败整批回滚 —— 只提示一次 */
      async removeMany(ids: string[]) {
        if (!ids.length) return;
        const prev = tickets;
        const target = new Set(ids);
        setTickets((cur) => cur.filter((t) => !target.has(t.id)));
        try {
          const { removed } = await api.tickets.removeMany(ids);
          notify(`已彻底删除 ${removed} 条任务`);
        } catch (err) {
          setTickets(prev);
          notify(err instanceof Error ? err.message : '批量删除失败', 'crit');
        }
      },
    }),
    [tickets, notify],
  );

  /* ── 项目 ───────────────────────────────────────────────────────── */
  const projectsApi = useMemo(
    () => ({
      async create(name: string, note = '') {
        const clean = name.trim();
        if (!clean) return null;
        try {
          const project = await api.projects.create({ name: clean, note });
          setProjects((prev) => [...prev, project]);
          notify(`已创建项目「${project.name}」`);
          return project;
        } catch (err) {
          notify(err instanceof Error ? err.message : '创建项目失败', 'crit');
          return null;
        }
      },
      /**
       * 改名。任务侧存的是项目名，所以两边都得动：本地先乐观改，
       * 服务端返回后按最终名字对齐；失败则双双回滚。
       */
      async rename(id: string, name: string) {
        const clean = name.trim();
        const target = projects.find((p) => p.id === id);
        if (!clean || !target || clean === target.name) return;
        const prev = projects;
        setProjects((cur) => cur.map((p) => (p.id === id ? { ...p, name: clean } : p)));
        setTickets((cur) => cur.map((t) => (t.project === target.name ? { ...t, project: clean } : t)));
        try {
          const { project } = await api.projects.update(id, { name: clean });
          setProjects((cur) => cur.map((p) => (p.id === id ? project : p)));
          setTickets((cur) => cur.map((t) => (t.project === clean ? { ...t, project: project.name } : t)));
          notify(`项目已改名为「${project.name}」`);
        } catch (err) {
          setProjects(prev);
          setTickets((cur) => cur.map((t) => (t.project === clean ? { ...t, project: target.name } : t)));
          notify(err instanceof Error ? err.message : '改名失败', 'crit');
        }
      },
      async remove(id: string) {
        const target = projects.find((p) => p.id === id);
        if (!target) return;
        try {
          const { clearedTasks } = await api.projects.remove(id);
          setProjects((cur) => cur.filter((p) => p.id !== id));
          // 任务不跟着删，只是失去归属 —— 删个项目不该把任务一起删掉
          setTickets((cur) => cur.map((t) => (t.project === target.name ? { ...t, project: '', section: '' } : t)));
          notify(clearedTasks ? `已删除项目，${clearedTasks} 条任务变为「未归类」` : '已删除项目');
        } catch (err) {
          notify(err instanceof Error ? err.message : '删除项目失败', 'crit');
        }
      },
    }),
    [projects, notify],
  );

  /* ── 书签 ───────────────────────────────────────────────────────── */
  const bookmarksApi = useMemo(
    () => ({
      async add(body: Partial<Bookmark> & { name: string; url: string }) {
        try {
          const bm = await api.bookmarks.create(body);
          setBookmarks((prev) => [...prev, bm]);
          notify(`已添加「${bm.name}」`);
          return bm;
        } catch (err) {
          notify(err instanceof Error ? err.message : '添加失败', 'crit');
          return null;
        }
      },
      async syncColors(opts = {}) {
        const res = await api.bookmarks.refreshColors(opts);
        if (res.colors.length) {
          const byId = new Map(res.colors.map((c) => [c.id, c.color]));
          setBookmarks((prev) => prev.map((b) => (byId.has(b.id) ? { ...b, color: byId.get(b.id) } : b)));
        }
        return { total: res.total, updated: res.updated, failed: res.failed };
      },
      async patch(id: string, patch: Partial<Bookmark>) {
        setBookmarks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
        try {
          await api.bookmarks.update(id, patch);
        } catch (err) {
          notify(err instanceof Error ? err.message : '更新失败', 'crit');
        }
      },
      async remove(id: string) {
        const prev = bookmarks;
        setBookmarks((cur) => cur.filter((b) => b.id !== id));
        try {
          await api.bookmarks.remove(id);
        } catch (err) {
          setBookmarks(prev);
          notify(err instanceof Error ? err.message : '删除失败', 'crit');
        }
      },
      async createGroup(name: string) {
        try {
          const g = await api.bookmarks.createGroup(name);
          setGroups((prev) => [...prev, g]);
          notify(`已新增分类「${g.name}」`);
        } catch (err) {
          notify(err instanceof Error ? err.message : '新增分类失败', 'crit');
        }
      },
      async renameGroup(id: string, name: string) {
        const prev = groups;
        setGroups((cur) => cur.map((g) => (g.id === id ? { ...g, name } : g)));
        try {
          const g = await api.bookmarks.renameGroup(id, name);
          setGroups((cur) => cur.map((x) => (x.id === id ? g : x)));
        } catch (err) {
          setGroups(prev);
          notify(err instanceof Error ? err.message : '改名失败', 'crit');
        }
      },
      /* 拖动排序是高频动作（一次拖拽只有一次调用，松手即提交），
         所以成功不弹 toast —— 顺序变了本身就在眼前。失败才回滚并报错。 */
      async reorderGroups(ids: string[]) {
        const prev = groups;
        const byId = new Map(groups.map((g) => [g.id, g]));
        const seen = new Set(ids);
        const next = [
          ...ids.filter((id) => byId.has(id)).map((id) => byId.get(id) as Group),
          ...groups.filter((g) => !seen.has(g.id)),
        ].map((g, i) => ({ ...g, order: i }));
        setGroups(next);
        try {
          const res = await api.bookmarks.reorderGroups(ids);
          setGroups(res.groups);
          return true;
        } catch (err) {
          setGroups(prev);
          notify(err instanceof Error ? err.message : '排序失败', 'crit');
          return false;
        }
      },
    }),
    [bookmarks, groups, notify],
  );

  /* ── 知识库 ─────────────────────────────────────────────────────── */
  const knowledgeApi = useMemo(
    () => ({
      /* 返回新建的条目：编辑器保存后要跳到它的阅读页，
         拿不到 id 就只能退回列表，白让用户再点一次 */
      async add(body: Partial<KnowledgeItem> & { title: string }) {
        try {
          const item = await api.knowledge.create(body);
          setKnowledge((prev) => [item, ...prev]);
          notify('已保存到知识库');
          return item;
        } catch (err) {
          notify(err instanceof Error ? err.message : '保存失败', 'crit');
          return null;
        }
      },
      async patch(id: string, patch: Partial<KnowledgeItem>) {
        const prev = knowledge;
        // 乐观更新：置顶、星标这类要立刻生效
        setKnowledge((cur) => cur.map((k) => (k.id === id ? { ...k, ...patch } : k)));
        try {
          /* 服务端回的是元信息形态，excerpt 按新正文重算过 ——
             用它盖掉乐观那份：改过正文的话卡片上的预览要跟着变，
             而刚提交的 body 不该留在这一份里（列表本来就不带正文） */
          const next = await api.knowledge.update(id, patch);
          setKnowledge((cur) => cur.map((k) => (k.id === id ? next : k)));
        } catch (err) {
          setKnowledge(prev);
          notify(err instanceof Error ? err.message : '更新失败', 'crit');
        }
      },
      /** 标签批量改名 / 合并 / 删除。服务端改完直接回整份列表，省一次往返 */
      async retag(body: { renames?: { from: string; to: string }[]; removes?: string[] }) {
        try {
          const res = await api.knowledge.retag(body);
          setKnowledge(res.list);
          notify(`已更新 ${res.changed} 篇的标签`);
          return true;
        } catch (err) {
          notify(err instanceof Error ? err.message : '改标签失败', 'crit');
          return false;
        }
      },
      /* ── 回收站 ─────────────────────────────────────────────────────
         软删除 / 恢复 / 彻底删除。前两个都不动 updatedAt（服务端也没动），
         所以恢复之后条目会排回它原来的位置，而不是"刚更新过"跳到最前。

         乐观更新照旧：点下去立刻生效，失败整批回滚。批量时**只提示一次** ——
         选 10 篇删，弹 10 个 toast 比不提示还烦。 */
      async trash(id: string) {
        const prev = knowledge;
        const at = new Date().toISOString();
        setKnowledge((cur) => cur.map((k) => (k.id === id ? { ...k, deletedAt: at } : k)));
        try {
          await api.knowledge.trash(id);
          notify('已移入回收站');
        } catch (err) {
          setKnowledge(prev);
          notify(err instanceof Error ? err.message : '移入回收站失败', 'crit');
        }
      },
      async restore(id: string) {
        const prev = knowledge;
        setKnowledge((cur) => cur.map((k) => (k.id === id ? { ...k, deletedAt: null } : k)));
        try {
          await api.knowledge.restore(id);
          notify('已恢复');
        } catch (err) {
          setKnowledge(prev);
          notify(err instanceof Error ? err.message : '恢复失败', 'crit');
        }
      },
      async bulkBin(ids: string[], kind: 'trash' | 'restore') {
        if (!ids.length) return;
        const prev = knowledge;
        const target = new Set(ids);
        const at = new Date().toISOString();
        setKnowledge((cur) =>
          cur.map((k) => (target.has(k.id) ? { ...k, deletedAt: kind === 'trash' ? at : null } : k)),
        );
        try {
          /* 移入回收站走批量接口：它是破坏性动作，服务端那一条
             "只处理还没进回收站的" 规则值得一次就卡住整批。
             恢复不破坏什么，逐条打过去就行（和任务那边的 bulkLifecycle 一样），
             也就不必为它再开一个 batch-restore。 */
          if (kind === 'trash') await api.knowledge.trashMany(ids);
          else await Promise.all(ids.map((id) => api.knowledge.restore(id)));
          notify(kind === 'trash' ? `已把 ${ids.length} 篇移入回收站` : `已恢复 ${ids.length} 篇`);
        } catch (err) {
          setKnowledge(prev);
          notify(err instanceof Error ? err.message : '批量操作失败', 'crit');
        }
      },
      async remove(id: string) {
        const prev = knowledge;
        setKnowledge((cur) => cur.filter((k) => k.id !== id));
        try {
          await api.knowledge.remove(id);
        } catch (err) {
          setKnowledge(prev);
          notify(err instanceof Error ? err.message : '删除失败', 'crit');
        }
      },
      async removeMany(ids: string[]) {
        if (!ids.length) return;
        const prev = knowledge;
        const target = new Set(ids);
        setKnowledge((cur) => cur.filter((k) => !target.has(k.id)));
        try {
          const { removed } = await api.knowledge.removeMany(ids);
          notify(`已彻底删除 ${removed} 篇`);
        } catch (err) {
          setKnowledge(prev);
          notify(err instanceof Error ? err.message : '批量删除失败', 'crit');
        }
      },
    }),
    [knowledge, notify],
  );

  const saveSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        const next = await api.settings.save(patch as never);
        setSettings(next);
        notify('设置已保存');
        /* 把落库后的那一份交回去。这里以前什么都不返回，于是调用方无法分辨
           "存成功了"和"存失败了" —— 想清空密钥输入框就只能瞎猜，猜错的代价是
           把用户刚敲进去的密钥抹掉。返回 null 而不是抛异常：绝大多数调用方
           （主题切换、背景滑块那些）压根不关心结果，让它变成 rejection
           只是在它们的 void 里多一个没人处理的未捕获异常。 */
        return next;
      } catch (err) {
        notify(err instanceof Error ? err.message : '保存失败', 'crit');
        return null;
      }
    },
    [notify],
  );

  const value: StoreValue = {
    ready,
    error,
    todos,
    tickets,
    bookmarks,
    groups,
    knowledge,
    settings,
    newsMeta,
    toasts,
    notify,
    dismissToast,
    refreshAll,
    todosApi,
    ticketsApi,
    projects,
    projectsApi,
    bookmarksApi,
    knowledgeApi,
    saveSettings,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
