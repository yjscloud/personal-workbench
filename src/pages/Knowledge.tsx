import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUp,
  Bold,
  BookMarked,
  BookOpen,
  Brackets,
  Check,
  Code,
  Copy,
  Download,
  Globe,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pencil,
  Pin,
  Network,
  Plus,
  Quote,
  Search,
  Star,
  Strikethrough,
  Table,
  Tags,
  Terminal,
  Trash2,
  Undo2,
  Wrench,
  X,
} from 'lucide-react';
import { useStore } from '@/lib/store';
import { api, type ImportedArticle, type KnowledgeItem } from '@/lib/api';
import { cls, fmtDateTime, fmtRelative } from '@/lib/format';
import { armBeforeUnload, armLeaveGuard } from '@/lib/nav-guard';
import { copyText } from '@/lib/clipboard';
import { outlineOf, type OutlineItem } from '@/lib/outline';
import { findBacklinks, normalizeTitle } from '@/lib/wiki-link';
import { Badge, Button, Card, Empty, Field, Input, Led, Modal, PageHead, Segmented, Spinner } from '@/components/ui';
import { Tag } from '@/components/bits';
import { Markdown } from '@/components/Markdown';
import { ArticleAssistant } from '@/components/ArticleAssistant';

type Scope = 'all' | KnowledgeItem['type'];
type View = 'card' | 'list';

/**
 * 三种类型的外观。
 * 用 Record<KnowledgeItem['type'], …> 而不是手写联合：
 * 以后再加第四档，这里漏一个会**编译不过**，而不是界面上少一档没人发现。
 */
const TYPE_META: Record<
  KnowledgeItem['type'],
  { label: string; tone: 'accent' | 'signal' | 'neutral'; icon: typeof BookOpen; color: string }
> = {
  sop: { label: 'SOP', tone: 'accent', icon: BookOpen, color: 'var(--accent)' },
  runbook: { label: 'Runbook', tone: 'signal', icon: Wrench, color: 'var(--accent-2)' },
  /* 摘录用中性色：它是"读来的素材"，不是待执行的流程。
     和 SOP / Runbook 抢同一种视觉重量，会让人分不清哪条要动手 */
  excerpt: { label: '摘录', tone: 'neutral', icon: BookMarked, color: 'var(--muted)' },
};

/** 列表页与编辑器都用满宽度：前者要信息密度，后者要写得开。
 *  阅读页相反，见下面的 READER_MAX。 */
const PAGE_MAX = 'max-w-[1720px]';

/* ── 置顶 / 星标 ────────────────────────────────────────────────────── */

/**
 * 置顶与星标。两个都是"我自己的看法"，和正文无关，所以放在卡片右上角随手可点。
 *
 * 分工上刻意不一样：**置顶管顺序，星标管筛选**。
 * 让两者都去改顺序的话，用户排到一半就说不清"这条为什么在这儿"了。
 */
function PinStar({ item }: { item: KnowledgeItem }) {
  const { knowledgeApi } = useStore();

  return (
    /* 卡片上整块被标题的拉伸链接盖着，所以这一组要抬到它上面才点得到 */
    <div className="relative z-10 flex shrink-0 items-center gap-0.5">
      <IconToggle
        on={Boolean(item.pinned)}
        label={item.pinned ? '取消置顶' : '置顶（排到最前）'}
        onClick={() => void knowledgeApi.patch(item.id, { pinned: !item.pinned })}
      >
        <Pin size={12} fill={item.pinned ? 'currentColor' : 'none'} aria-hidden />
      </IconToggle>
      <IconToggle
        on={Boolean(item.starred)}
        label={item.starred ? '取消星标' : '加星标'}
        onClick={() => void knowledgeApi.patch(item.id, { starred: !item.starred })}
      >
        <Star size={12} fill={item.starred ? 'currentColor' : 'none'} aria-hidden />
      </IconToggle>
    </div>
  );
}

function IconToggle({
  on,
  label,
  onClick,
  className,
  children,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cls(
        'rounded-field transition-colors',
        on ? 'text-accent hover:opacity-80' : 'text-faint hover:bg-panel-2 hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── 列表 / 卡片 ────────────────────────────────────────────────────── */

export default function Knowledge() {
  const { knowledge, knowledgeApi, ready, settings } = useStore();
  const navigate = useNavigate();
  /* 筛选与视图都放 URL 而不是组件状态：进详情页再按后退键回来，视角还在。
     写回一律 replace —— 这些是"这一页当前的看法"，不该在历史里堆十几条。 */
  const [params, setParams] = useSearchParams();
  const scope = (params.get('type') as Scope) ?? 'all';
  const tag = params.get('tag') ?? 'all';
  const query = params.get('q') ?? '';
  const onlyStar = params.get('star') === '1';
  const view: View = params.get('view') === 'list' ? 'list' : 'card';
  /* 回收站视图。仍然放 URL 里，理由同上面几条：从回收站点进一篇、
     再按后退回来，看的还是回收站，而不是被弹回知识库 */
  const bin = params.get('bin') === '1';
  /* 保留天数由服务端下发（services/retention.js 的 KNOWLEDGE_TRASH_KEEP_DAYS）。
     页面上那句"保留 N 天"必须跟着它走 —— 写死一个 7，等哪天规则改了，
     这句话就成了假的，而且是没人会去核对的那种假。 */
  const keepDays = settings?.knowledgeTrashKeepDays ?? 7;

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  /* 外链导入是"抓草稿"，不是"直接入库"：正文抽取必然有判断失误的时候，
     所以走 抓取 → 填进编辑器 → 人过一眼 → 保存 这条路。
     直接入库等于把一次猜错变成库里一条脏数据。 */
  const [importOpen, setImportOpen] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  /* 批量选择存的是 id 而不是下标：列表会因为置顶、筛选、搜索而重排，
     存下标的话选中的东西会跟着位置跑。
     待彻底删除的 id 也挂在页面上（而不是塞进每一张卡片），
     确认弹窗全世界只要一个。 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null);

  async function runImport() {
    const url = importInput.trim();
    if (!url || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const article = await api.knowledge.importUrl(url);
      setImportOpen(false);
      setImportInput('');
      navigate('/knowledge/new', { state: { imported: article } });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }

  const tags = useMemo(() => {
    const map = new Map<string, number>();
    knowledge.forEach((k) => (k.tags || []).forEach((t) => map.set(t, (map.get(t) ?? 0) + 1)));
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [knowledge]);

  /* ── 搜索 ──────────────────────────────────────────────────────────
     挪到服务端：它要打 body_plain（剥过标记的正文），而列表已经不带正文了，
     客户端手里没有可搜的东西。反过来，这份纯文本一直存着却派不上用场，
     也正因为搜索没在服务端。

     防抖 250ms：每敲一个字打一次接口太吵。 */
  const q = query.trim();
  const [hits, setHits] = useState<KnowledgeItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!q) {
      setHits(null);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      api.knowledge
        .search(q)
        .then((r) => {
          if (alive) setHits(r);
        })
        .catch(() => {
          if (alive) setHits([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  /* 回收站里的条目。列表接口**不过滤**软删除的内容，两种视图用的是同一份
     数据 —— 多一个服务端筛选参数，就多一处"前后端口径对不上"的机会 */
  const inBin = useMemo(() => knowledge.filter((k) => Boolean(k.deletedAt)), [knowledge]);

  const filtered = useMemo(() => {
    /* 有搜索词时以命中集为底；类型 / 标签 / 星标这几项筛的仍是元信息，
       留在客户端做 —— 为一个筛选条件多跑一次接口不值当 */
    const base = q ? (hits ?? []) : knowledge;
    return base.filter((k) => {
      /* 知识库 / 回收站二选一。这一步必须在最前面：搜索的命中集里
         两种条目是混在一起的，不切开会把删掉的文章搜出来 */
      if (Boolean(k.deletedAt) !== bin) return false;
      if (scope !== 'all' && k.type !== scope) return false;
      if (tag !== 'all' && !(k.tags || []).includes(tag)) return false;
      if (onlyStar && !k.starred) return false;
      return true;
    });
  }, [knowledge, hits, q, scope, tag, onlyStar, bin]);

  /* 置顶的排到最前，其余**保持后端给的顺序**（新→旧）。
     这里不用 sort：分成两段再拼，顺序完全由输入决定，
     不用担心比较函数相等时谁前谁后。 */
  const ordered = useMemo(() => {
    const pinned = filtered.filter((k) => k.pinned);
    const rest = filtered.filter((k) => !k.pinned);
    return [...pinned, ...rest];
  }, [filtered]);

  /* 一趟算完。分开 filter 三次在几百条时看不出来，但没有理由这么做。
     有搜索词时按**命中集**算 —— 否则上面显示"全部 8"、下面只列出 2 条，
     两个数字对不上，看着像坏了 */
  const counts = useMemo(() => {
    /* 同样先按知识库 / 回收站切开 —— 否则在回收站里会看到"全部 12"
       而下面只列出 2 条，两个数字对不上，看着就像坏了 */
    const base = (q ? (hits ?? []) : knowledge).filter((k) => Boolean(k.deletedAt) === bin);
    const c = { all: base.length, sop: 0, runbook: 0, excerpt: 0, starred: 0 };
    for (const k of base) {
      if (k.type === 'sop') c.sop += 1;
      else if (k.type === 'runbook') c.runbook += 1;
      else if (k.type === 'excerpt') c.excerpt += 1;
      if (k.starred) c.starred += 1;
    }
    return c;
  }, [knowledge, hits, q, bin]);

  /* ── 批量选择 ────────────────────────────────────────────────────── */
  const selectedIds = useMemo(() => ordered.filter((k) => selected.has(k.id)).map((k) => k.id), [ordered, selected]);
  const allSelected = ordered.length > 0 && selectedIds.length === ordered.length;

  /* 换筛选条件（类型、标签、星标、搜索、回收站）就把选择清空：
     选中的东西可能已经不在眼前了，留着它会让"已选 3 篇"和看得见的列表对不上，
     接着点"删除"就是一次看不清对象的操作 */
  useEffect(() => {
    setSelected(new Set());
  }, [bin, scope, tag, q, onlyStar]);

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set<string>() : new Set(ordered.map((k) => k.id)));
  }

  /* 批量动作。先把选择清掉再发请求：乐观更新会让这些条目当场从当前视图消失，
     选择条如果还挂在那儿、数字还停在"已选 5 篇"，看着就像没生效 */
  function runBulk(kind: 'trash' | 'restore') {
    const ids = selectedIds;
    setSelected(new Set());
    void knowledgeApi.bulkBin(ids, kind);
  }

  const purgeTitles = useMemo(
    () => (purgeIds ?? []).map((id) => knowledge.find((k) => k.id === id)?.title ?? '').filter(Boolean),
    [purgeIds, knowledge],
  );

  return (
    <div className={cls('mx-auto w-full space-y-4', PAGE_MAX)}>
      <PageHead
        title={bin ? '回收站' : '知识库'}
        hint={
          bin
            ? `删掉的文章先放这里，保留 ${keepDays} 天，期间随时可以恢复；到期由服务端自动永久删除`
            : `${counts.sop} 篇 SOP · ${counts.runbook} 篇 Runbook · ${counts.excerpt} 篇摘录，正文用 Markdown 写`
        }
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => navigate('/knowledge/graph')}>
              <Network size={13} />
              图谱
            </Button>
            <Button size="sm" variant="soft" onClick={() => setImportOpen(true)}>
              <Globe size={13} />
              导入网址
            </Button>
            <Button size="sm" variant="primary" onClick={() => navigate('/knowledge/new')}>
              <Plus size={13} />
              新建条目
            </Button>
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={scope}
            onChange={(v) => setParam('type', v)}
            options={[
              { value: 'all', label: `全部 ${counts.all}` },
              { value: 'sop', label: `SOP ${counts.sop}` },
              { value: 'runbook', label: `Runbook ${counts.runbook}` },
              { value: 'excerpt', label: `摘录 ${counts.excerpt}` },
            ]}
          />
          {/* 星标是"只看我真正在用的那几篇"，所以它是筛选而不是排序 */}
          <Tag active={onlyStar} onClick={() => setParam('star', onlyStar ? '' : '1')}>
            ★ 星标 {counts.starred}
          </Tag>
          {/* 回收站与知识库是同一份数据的两个面，所以用同一个筛选控件切，
              不为它单开一条路由（进了回收站仍然是"知识库"这个页面） */}
          <Tag active={bin} onClick={() => setParam('bin', bin ? '' : '1')}>
            <Trash2 size={11} aria-hidden />
            回收站 {inBin.length}
          </Tag>
          <div className="relative min-w-[12rem] flex-1">
            <Search size={13} aria-hidden className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setParam('q', e.target.value)}
              placeholder="搜索标题、说明或正文"
              className="pl-7"
              aria-label="搜索知识库"
            />
          </div>
          <Segmented
            value={view}
            onChange={(v) => setParam('view', v === 'card' ? '' : 'list')}
            options={[
              { value: 'card', label: '卡片' },
              { value: 'list', label: '列表' },
            ]}
          />
        </div>

        {tags.length ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
            <span className="text-2xs text-faint">标签</span>
            <Tag active={tag === 'all'} onClick={() => setParam('tag', 'all')}>
              全部
            </Tag>
            {tags.map(([name, count]) => (
              <Tag key={name} active={tag === name} onClick={() => setParam('tag', name)}>
                {name} {count}
              </Tag>
            ))}
            {/* 标签没有独立的表，改名/合并原本要逐篇编辑，所以给一个入口 */}
            <button
              type="button"
              onClick={() => setTagsOpen(true)}
              className="ml-auto inline-flex items-center gap-1 text-2xs text-faint transition-colors hover:text-accent"
            >
              <Tags size={11} aria-hidden />
              管理标签
            </button>
          </div>
        ) : null}
      </Card>

      {/* 选择条只在选了东西时出现：没有批量操作可做的时候，它只是一条占地方的横杠 */}
      {selectedIds.length ? (
        <BinBar
          count={selectedIds.length}
          allSelected={allSelected}
          bin={bin}
          onToggleAll={toggleSelectAll}
          onClear={() => setSelected(new Set())}
          onTrash={() => runBulk('trash')}
          onRestore={() => runBulk('restore')}
          onPurge={() => setPurgeIds(selectedIds)}
        />
      ) : null}

      {!ready ? (
        <Card>
          <p className="text-xs text-faint">正在加载知识库…</p>
        </Card>
      ) : searching && !hits ? (
        /* 搜索是服务端做的，第一次结果回来之前得说一声 ——
           否则这一段时间的空列表会被读成"没有匹配" */
        <Card>
          <p className="flex items-center gap-1.5 text-xs text-faint">
            <Spinner />
            正在搜索…
          </p>
        </Card>
      ) : ordered.length === 0 ? (
        <Card>
          <Empty
            icon={bin ? <Trash2 size={20} /> : undefined}
            title={bin ? '回收站是空的' : knowledge.length ? '没有匹配的条目' : '知识库还是空的'}
            hint={
              bin
                ? `从知识库里删掉的文章会先放到这里，保留 ${keepDays} 天，期间随时可以恢复。`
                : knowledge.length
                  ? '换个标签、取消星标筛选，或清空搜索。'
                  : '把处理过的故障写成 Runbook，把固定流程写成 SOP，下次就不用重新想。'
            }
            action={
              bin ? undefined : (
                <Button size="sm" variant="primary" onClick={() => navigate('/knowledge/new')}>
                  <Plus size={13} />
                  新建条目
                </Button>
              )
            }
          />
        </Card>
      ) : view === 'list' ? (
        /* 列表：一行一条，装在一个面板里用发丝线分。
           一屏能看十几条，适合条目多起来之后翻找 —— 卡片适合"看有什么"。 */
        <Card flush className="overflow-hidden">
          {ordered.map((item) => (
            <KnowledgeRow
              key={item.id}
              item={item}
              selected={selected.has(item.id)}
              onToggle={() => toggleSelect(item.id)}
              onPurge={() => setPurgeIds([item.id])}
            />
          ))}
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {ordered.map((item) => (
            <KnowledgeCard
              key={item.id}
              item={item}
              selected={selected.has(item.id)}
              onToggle={() => toggleSelect(item.id)}
              onPurge={() => setPurgeIds([item.id])}
            />
          ))}
        </div>
      )}

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="从网址导入"
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={importing || !importInput.trim()} onClick={() => void runImport()}>
              {importing ? '抓取中…' : '抓取'}
            </Button>
          </>
        }
      >
        <Field
          label="文章地址"
          hint="抓的是这台服务器能访问到的页面。有反爬的站点会被直接拒绝，正文靠 JS 渲染的页面可能抓不到内容 —— 这两种失败的原因会在下面说清楚。"
        >
          <Input
            value={importInput}
            onChange={(e) => setImportInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runImport();
            }}
            placeholder="https://example.com/article"
            autoFocus
          />
        </Field>
        {importError ? <p className="text-2xs leading-relaxed text-crit">{importError}</p> : null}
        <p className="text-2xs leading-relaxed text-faint">
          抓回来的是草稿：会先填进编辑器让你过一眼，确认没问题再保存。
        </p>
      </Modal>

      {/* 彻底删除是这条链上唯一不可恢复的一步，所以只有它要确认：
          移到回收站可以不问（点错了再恢复回来就行），永久删除必须问 ——
          尤其实现在列表项上也是一颗随手可点的垃圾桶图标 */}
      <Modal
        open={Boolean(purgeIds)}
        onClose={() => setPurgeIds(null)}
        title={`彻底删除 ${purgeTitles.length} 篇？`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPurgeIds(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const ids = purgeIds ?? [];
                setPurgeIds(null);
                setSelected(new Set());
                if (ids.length) void knowledgeApi.removeMany(ids);
              }}
            >
              彻底删除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {purgeTitles.length === 1
            ? `「${purgeTitles[0]}」`
            : `选中的 ${purgeTitles.length} 篇（${purgeTitles.slice(0, 3).join('、')}${purgeTitles.length > 3 ? ' 等' : ''}）`}
          会被永久删除，正文与文章助手的对话记录一起消失，无法恢复。
        </p>
      </Modal>

      <TagManager
        open={tagsOpen}
        tags={tags}
        onClose={() => setTagsOpen(false)}
        onApply={(renames, removes) => knowledgeApi.retag({ renames, removes })}
      />
    </div>
  );
}

/* ── 标签管理（改名 / 合并 / 删除）───────────────────────────────────────
   标签没有独立的表，是每个条目自己存的一份字符串数组。于是改一个名字
   原本要逐篇编辑，而 `PVE` 与 `pve`、`网络` 与 `网络配置` 就只能各成一体 ——
   这个碎法还会**放大到图谱上**：标签节点是一整类节点，碎掉之后就是一堆
   分不清的孤立小点。

   三件事在这里是同一个操作：改名、合并、删除。
   **合并就是"改成已存在的另一个名字"** —— 服务端替换后再去重，两堆自然
   合成一堆。所以不必为合并单独设计一套交互，也不必让它听起来像高级功能。 */
function TagManager({
  open,
  tags,
  onClose,
  onApply,
}: {
  open: boolean;
  tags: [string, number][];
  onClose: () => void;
  onApply: (renames: { from: string; to: string }[], removes: string[]) => Promise<boolean>;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [drops, setDrops] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  /* 每次打开都照当前标签重新起：上次没提交的改动不该留着 */
  useEffect(() => {
    if (!open) return;
    setNames(Object.fromEntries(tags.map(([name]) => [name, name])));
    setDrops([]);
  }, [open, tags]);

  /* 标为删除的不参与改名 —— 一边删一边改名是自相矛盾的输入 */
  const renames = tags
    .filter(([name]) => !drops.includes(name))
    .map(([name]) => ({ from: name, to: (names[name] ?? name).trim() }))
    .filter((r) => r.to && r.to !== r.from);
  const changed = renames.length + drops.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="管理标签"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy || !changed}
            onClick={async () => {
              setBusy(true);
              await onApply(renames, drops);
              setBusy(false);
              onClose();
            }}
          >
            {busy ? '应用…' : changed ? `应用 ${changed} 项改动` : '没有改动'}
          </Button>
        </>
      }
    >
      <p className="text-2xs leading-relaxed text-faint">
        改名会改到所有带这个标签的条目上。改成已经存在的另一个名字，就是把两堆条目并成一堆 ——
        收拾 <code className="rounded bg-bg-2 px-1">PVE</code> 与{' '}
        <code className="rounded bg-bg-2 px-1">pve</code> 这类碎标签用的就是这一格。
      </p>

      <ul className="mt-3 max-h-[22rem] space-y-1.5 overflow-y-auto pr-0.5">
        {tags.map(([name, count]) => {
          const dropped = drops.includes(name);
          return (
            <li key={name} className="flex items-center gap-2">
              <Input
                value={names[name] ?? name}
                onChange={(e) => setNames((prev) => ({ ...prev, [name]: e.target.value }))}
                disabled={dropped}
                aria-label={`把标签「${name}」改名为`}
                className={cls('flex-1', dropped && 'opacity-45 line-through')}
              />
              <span className="num w-12 shrink-0 text-right text-2xs text-faint">{count} 篇</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={dropped ? `撤销删除标签 ${name}` : `删除标签 ${name}`}
                title={dropped ? '撤销' : '从所有条目上去掉这个标签'}
                onClick={() =>
                  setDrops((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]))
                }
              >
                {dropped ? <Undo2 size={12} aria-hidden /> : <X size={12} aria-hidden />}
              </Button>
            </li>
          );
        })}
      </ul>

      {changed ? (
        <p className="mt-2.5 border-t border-line pt-2.5 text-2xs text-faint">
          {renames.length ? `改名 ${renames.length} 个` : null}
          {renames.length && drops.length ? ' · ' : null}
          {drops.length ? `删除 ${drops.length} 个` : null}
          {' · '}条目的「更新于」不会跟着变 —— 改的是分类口径，不是内容。
        </p>
      ) : null}
    </Modal>
  );
}

/* ── 批量操作条 ───────────────────────────────────────────────────────── */

/**
 * 选中若干篇之后浮在列表上方的一条。
 *
 * 排版和文案沿用任务页那条（"已选 N 条 / 全选当前列表 / 取消选择"），
 * 两处别长成两个样子。回收站与非回收站里能做的事不同：前者是恢复与彻底删除，
 * 后者是移入回收站 —— 不做成"都摆出来再禁掉"，禁用的按钮只会让人猜为什么点不动。
 */
function BinBar({
  count,
  allSelected,
  bin,
  onToggleAll,
  onClear,
  onTrash,
  onRestore,
  onPurge,
}: {
  count: number;
  allSelected: boolean;
  bin: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <section
      aria-label="批量操作"
      className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 animate-fade-rise"
    >
      <span className="flex items-center gap-2 text-[13px] text-ink">
        <span className="grid h-5 w-5 place-items-center rounded-field bg-accent-soft text-accent">
          <Check size={12} />
        </span>
        已选 <span className="num font-semibold">{count}</span> 篇
      </span>

      <button type="button" onClick={onToggleAll} className="text-2xs text-accent transition-opacity hover:opacity-80">
        {allSelected ? '取消全选' : '全选当前列表'}
      </button>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        {bin ? (
          <>
            <Button size="sm" variant="soft" onClick={onRestore}>
              <Undo2 size={12} />
              恢复
            </Button>
            <Button size="sm" variant="danger" onClick={onPurge}>
              <Trash2 size={12} />
              彻底删除
            </Button>
          </>
        ) : (
          <Button size="sm" variant="soft" onClick={onTrash}>
            <Trash2 size={12} />
            移入回收站
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClear}>
          <X size={12} />
          取消选择
        </Button>
      </div>
    </section>
  );
}

/**
 * 批量选择的勾选。卡片与列表共用。
 *
 * 用 role=checkbox 的按钮而不是 input[type=checkbox]：和任务页那颗一致
 * （见 Week.tsx 行首的勾选），而且样式完全跟着主题走 —— 原生勾选框在深色
 * 主题下用的是浏览器自己那套颜色，跟不过来。
 */
function SelectBox({
  checked,
  onToggle,
  label,
  className,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? `取消选择「${label}」` : `选择「${label}」`}
      onClick={onToggle}
      className={cls(
        /* relative z-10：卡片整块被标题的拉伸链接盖着，不抬起来点不到 */
        'relative z-10 grid h-[17px] w-[17px] shrink-0 place-items-center rounded-xs border transition-colors',
        checked ? 'border-accent bg-accent text-white' : 'border-line bg-panel-2 hover:border-accent',
        className,
      )}
    >
      {checked ? <Check size={11} strokeWidth={3} /> : null}
    </button>
  );
}

/**
 * 卡片 / 一行右侧的动作组，两个视图共用。
 *
 * 知识库里是「置顶 / 星标 + 移入回收站」，回收站里换成「恢复 / 彻底删除」——
 * 位置与克制程度不变，换的是语义。给回收站里的条目还留着置顶星标，
 * 只会让人以为那两颗按钮在这儿也有用。
 */
function ItemActions({ item, onPurge }: { item: KnowledgeItem; onPurge: () => void }) {
  const { knowledgeApi } = useStore();

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-0.5">
      {item.deletedAt ? (
        <>
          <IconToggle on={false} label="恢复到知识库" className="p-1.5" onClick={() => void knowledgeApi.restore(item.id)}>
            <Undo2 size={12} aria-hidden />
          </IconToggle>
          {/* 和移入回收站那颗刻意长得不一样：一颗点错了能撤销，另一颗不能 */}
          <button
            type="button"
            aria-label="彻底删除（不可恢复）"
            title="彻底删除（不可恢复）"
            onClick={onPurge}
            className="rounded-field p-1.5 text-faint transition-colors hover:bg-crit-soft hover:text-crit"
          >
            <Trash2 size={12} aria-hidden />
          </button>
        </>
      ) : (
        <>
          <PinStar item={item} />
          <button
            type="button"
            aria-label="移入回收站"
            title="移入回收站"
            onClick={() => void knowledgeApi.trash(item.id)}
            className="rounded-field p-1.5 text-faint transition-colors hover:bg-crit-soft hover:text-crit"
          >
            <Trash2 size={12} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

function KnowledgeCard({
  item,
  selected,
  onToggle,
  onPurge,
}: {
  item: KnowledgeItem;
  selected: boolean;
  onToggle: () => void;
  onPurge: () => void;
}) {
  const meta = TYPE_META[item.type] ?? TYPE_META.sop;
  const Icon = meta.icon;
  /* 服务端给的摘要。搜索命中正文时 snippet 是命中处的一段上下文，
     比开头那句更贴问题 —— 卡片上优先显示它 */
  const preview = item.snippet ?? item.excerpt ?? '';

  return (
    <div className="panel panel-hover group relative flex flex-col overflow-hidden">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: meta.color }} />

      <div className="flex-1 p-4 pl-5">
        <div className="mb-1.5 flex items-start gap-2">
          <SelectBox checked={selected} onToggle={onToggle} label={item.title} className="mt-0.5" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Badge tone={meta.tone}>
              <Icon size={10} />
              {meta.label}
            </Badge>
            {item.tags?.slice(0, 4).map((t) => (
              <span key={t} className="rounded-full bg-bg-2 px-2 py-0.5 text-2xs text-faint">
                {t}
              </span>
            ))}
          </div>
          <ItemActions item={item} onPurge={onPurge} />
        </div>

        {/* 条目直接挂在页面下，是 h2 而不是 h3，否则页面大纲 h1 → h3 会跳一级。
            标题的链接用"拉伸"伪元素铺满整张卡 —— 于是点哪儿都进详情，
            但卡里还能放星标/置顶两颗按钮（<a> 里塞按钮是非法嵌套）。 */}
        <h2 className="text-[15px] font-semibold tracking-tight">
          <Link className="after:absolute after:inset-0 after:content-[''] group-hover:text-accent" to={`/knowledge/${item.id}`}>
            {item.title}
          </Link>
        </h2>
        {item.summary ? <p className="mt-1 text-xs leading-relaxed text-muted">{item.summary}</p> : null}
        {preview ? (
          <p className="mt-2 line-clamp-2 text-2xs leading-relaxed text-faint">{preview}</p>
        ) : (
          <p className="mt-2 text-2xs text-faint">还没有写正文。</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 pl-5">
        <span className="num text-2xs text-faint">更新于 {fmtRelative(item.updatedAt)}</span>
        <span className="text-2xs font-medium text-muted transition-colors group-hover:text-accent">查看全文</span>
      </div>
    </div>
  );
}

/** 列表视图的一行。信息密度优先：类型、标题、标签、时间各占一列，扫读成列 */
function KnowledgeRow({
  item,
  selected,
  onToggle,
  onPurge,
}: {
  item: KnowledgeItem;
  selected: boolean;
  onToggle: () => void;
  onPurge: () => void;
}) {
  const meta = TYPE_META[item.type] ?? TYPE_META.sop;
  const Icon = meta.icon;
  const preview = item.summary || item.snippet || item.excerpt || '';

  return (
    <div className="group relative flex items-center gap-3 border-b border-line px-3 py-2.5 transition-colors last:border-b-0 hover:bg-panel-2 sm:px-4">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: meta.color }} />

      <SelectBox checked={selected} onToggle={onToggle} label={item.title} />

      <Badge tone={meta.tone}>
        <Icon size={10} />
        {meta.label}
      </Badge>

      <div className="min-w-0 flex-1">
        <Link
          to={`/knowledge/${item.id}`}
          className="block truncate text-[13px] font-medium after:absolute after:inset-0 after:content-[''] group-hover:text-accent"
        >
          {item.title}
        </Link>
        {preview ? <span className="block truncate text-2xs text-faint">{preview}</span> : null}
      </div>

      <div className="hidden shrink-0 items-center gap-1.5 md:flex">
        {item.tags?.slice(0, 2).map((t) => (
          <span key={t} className="rounded-full bg-bg-2 px-2 py-0.5 text-2xs text-faint">
            {t}
          </span>
        ))}
      </div>

      <span className="num hidden shrink-0 text-2xs text-faint sm:inline">{fmtRelative(item.updatedAt)}</span>
      <ItemActions item={item} onPurge={onPurge} />
    </div>
  );
}

/* ── 阅读（整页）────────────────────────────────────────────────────── */

/** 正文阅读刻意收窄到 62rem 并居中：一行太长眼睛要来回扫。
 *  列表页要的是信息密度，阅读页要的是"读得下去"，两页目标不同。 */
const READER_MAX = 'max-w-[62rem]';

export function KnowledgeDoc() {
  const { id } = useParams<{ id: string }>();
  const { knowledge, knowledgeApi, ready, settings } = useStore();
  /* 与列表页同一处口径：回收站保留天数由服务端下发（services/retention.js），
     页面上不自己写死一个 7 */
  const keepDays = settings?.knowledgeTrashKeepDays ?? 7;
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState<'done' | 'fail' | null>(null);
  /* 助手放大时正文让位：回答动辄上千字，挤在 26rem 的窄栏里没法读 */
  const [aiWide, setAiWide] = useState(false);

  const item = knowledge.find((k) => k.id === id) ?? null;

  /* 正文按需取：列表（和首屏）不带 body，进到这一篇才拉。
     元信息本来就在列表里，所以页头、标签、反链立刻就能画出来，
     只有正文那一块要等一下 —— 比为整页等一次请求好。 */
  const [full, setFull] = useState<KnowledgeItem | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setFull(null);
    api.knowledge
      .get(id)
      .then((it) => {
        if (alive) setFull(it);
      })
      .catch(() => {
        if (alive) setFull(null);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  const body = full?.body ?? '';

  /* 目录。只在有 `##` 时才出现 —— 一篇没有小标题的短文挂个空目录，
     只会让人以为它坏了 */
  const outline = useMemo(() => outlineOf(body), [body]);

  /* 回到顶部。阈值取 600px：一屏之内就冒出来的话，它比碍事的多 */
  const [showTop, setShowTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 600);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /* 反链在**所有条目**的正文里找。数据本来就在内存里，不用问服务端；
     必须放在下面那些提前 return 之前 —— hook 不能进条件分支 */
  const backlinks = useMemo(() => (item ? findBacklinks(knowledge, item) : []), [knowledge, item]);

  if (!ready) {
    return (
      <div className={cls('mx-auto w-full', READER_MAX)}>
        <Card>
          <p className="text-xs text-faint">正在加载条目…</p>
        </Card>
      </div>
    );
  }

  if (!item) {
    return (
      <div className={cls('mx-auto w-full', READER_MAX)}>
        <Card>
          <Empty
            title="条目不存在"
            hint="它可能已经被删除。回列表看看还有哪些。"
            action={
              <Button size="sm" variant="soft" onClick={() => navigate('/knowledge')}>
                返回知识库
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const meta = TYPE_META[item.type] ?? TYPE_META.sop;
  const Icon = meta.icon;

  /* ── 导出 ──────────────────────────────────────────────────────────
     知识要能带走：只留在这个库里，等于换台机器就没了。
     导出的是正文 Markdown 原文 —— 标签和置顶是这个库的分类口径，
     不属于文章本身，带出去反而是噪音。 */
  const download = () => {
    /* 文件名要去掉 Windows 不允许的那几个字符，否则点下去会失败得莫名其妙 */
    const name = (item.title || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const doCopy = async () => {
    const ok = await copyText(body);
    setCopied(ok ? 'done' : 'fail');
    window.setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="mx-auto w-full max-w-[92rem] space-y-4">
      <button
        type="button"
        onClick={() => navigate('/knowledge')}
        className="inline-flex items-center gap-1.5 text-2xs font-medium text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={13} aria-hidden />
        知识库
      </button>

      <PageHead
        title={item.title}
        hint={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Badge tone={meta.tone}>
              <Icon size={10} />
              {meta.label}
            </Badge>
            {item.tags?.map((t) => (
              <span key={t} className="rounded-full bg-bg-2 px-2 py-0.5 text-2xs text-faint">
                {t}
              </span>
            ))}
            <span className="num text-2xs text-faint">更新于 {fmtRelative(item.updatedAt)}</span>
          </span>
        }
        actions={
          <>
            <span className="flex items-center gap-0.5 rounded-field bg-bg-2 px-1 py-1">
              <PinStar item={item} />
            </span>
            <Button size="sm" variant="ghost" onClick={() => setExportOpen(true)}>
              <Download size={13} />
              导出
            </Button>
            <Button size="sm" variant="soft" onClick={() => navigate(`/knowledge/${item.id}/edit`)}>
              <Pencil size={13} />
              编辑
            </Button>
            {/* 已经在回收站里的，页头这颗就换成恢复 —— 再点一次"删除"
                只会让人以为刚才那次没生效 */}
            {item.deletedAt ? (
              <Button size="sm" variant="soft" onClick={() => void knowledgeApi.restore(item.id)}>
                <Undo2 size={13} />
                恢复
              </Button>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                <Trash2 size={13} />
                删除
              </Button>
            )}
          </>
        }
      />

      <div
        className={cls(
          'grid gap-4 xl:items-start',
          /* 有目录时让出最左一列给它。正文列因此变窄 —— 那不算损失：
             62rem 的通栏本来就不适合读，收到 50rem 上下正好是舒服的行长 */
          aiWide
            ? 'grid-cols-1'
            : outline.length
              ? 'xl:grid-cols-[13rem_minmax(0,1fr)_26rem]'
              : 'xl:grid-cols-[minmax(0,1fr)_26rem]',
        )}
      >
        {/* 目录轨。只在够宽的屏上出现：窄屏再挤出一列，正文就没法读了。
            **必须 self-stretch**：上面 grid 用了 items-start，每列都缩成
            自己内容的高度 —— sticky 是在"所在列的高度"里移动的，
            列只有目录那么高，它就没有可移动的空间，等于没吸顶 */}
        {!aiWide && outline.length ? (
          <aside className="hidden xl:block xl:self-stretch">
            <div className="xl:sticky xl:top-[4.5rem]">
              <Outline items={outline} />
            </div>
          </aside>
        ) : null}

        <div className={cls('min-w-0 space-y-4', aiWide && 'hidden')}>
          {item.summary ? <p className="max-w-3xl text-[13px] leading-relaxed text-muted">{item.summary}</p> : null}

          <Card className="px-5 py-5 sm:px-7">
            {!full ? (
              /* 只有正文在等 —— 页头、标签、反链都已经就位 */
              <p className="flex items-center gap-1.5 text-xs text-faint">
                <Spinner />
                正在加载正文…
              </p>
            ) : body.trim() ? (
              <Markdown>{body}</Markdown>
            ) : (
              <Empty
                title="还没有写正文"
                hint="正文支持 Markdown：标题、列表、代码块、表格都能用。"
                action={
                  <Button size="sm" variant="primary" onClick={() => navigate(`/knowledge/${item.id}/edit`)}>
                    <Pencil size={13} />
                    去写正文
                  </Button>
                }
              />
            )}
          </Card>

          {/* ── 反向链接 ────────────────────────────────────────────────
             正向双链回答"我要去看什么"，反链回答"**我什么时候会需要它**"。
             图谱上能看出这篇被连着，但看图看不出是谁、更看不出为什么 ——
             反链把同一件事实落回到具体文章和具体那句上。
             空的时候也留着这块：不然没人知道写 `[[标题]]` 会有效果。 */}
          <Card>
            <div className="flex items-center gap-2">
              <Network size={14} aria-hidden className="text-accent" />
              <h2 className="text-[13px] font-semibold">反向链接</h2>
              {backlinks.length ? <span className="num text-2xs text-faint">{backlinks.length} 篇指向它</span> : null}
            </div>
            {backlinks.length ? (
              <ul className="mt-3 space-y-3">
                {backlinks.map(({ item: from, snippet }) => {
                  const m = TYPE_META[from.type] ?? TYPE_META.sop;
                  const FromIcon = m.icon;
                  return (
                    <li key={from.id} className="min-w-0">
                      <Link
                        to={`/knowledge/${from.id}`}
                        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline"
                      >
                        <FromIcon size={11} aria-hidden className="shrink-0" />
                        {from.title}
                      </Link>
                      {/* 链过去的那一句。没有它，这一行只等于一个标题，
                          看不出"为什么链过来" */}
                      {snippet ? <p className="mt-0.5 truncate text-2xs text-faint">{snippet}</p> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-2xs leading-relaxed text-faint">
                还没有别的条目链到这一篇。在别处写 <code className="rounded bg-bg-2 px-1">{`[[${item.title}]]`}</code>{' '}
                就会出现在这里。
              </p>
            )}
          </Card>
        </div>

        {/* 换文章时靠 key 整个重挂载，对话不会串到下一篇；
            吸顶是为了读长文时它不跟着滚走 */}
        <ArticleAssistant
          key={item.id}
          className={aiWide ? undefined : 'xl:sticky xl:top-[4.5rem]'}
          articleId={item.id}
          initialTurns={item.ai?.turns ?? []}
          expanded={aiWide}
          onToggleExpand={() => setAiWide((v) => !v)}
          title={item.title}
          tags={item.tags ?? []}
          summary={item.summary ?? ''}
          body={body}
        />
      </div>

      {/* 删除仍然给一次确认，但不再是因为"删了就没了" —— 现在是移入回收站。
          留着确认是因为这是页头上一颗常驻按钮，点下去还会把人带离这一页，
          而列表里的垃圾桶至少还得先找到它 */}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="删除这条知识？"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              取消
            </Button>
            {/* 这里刻意不用 danger：本项目的约定是**危险色只给不可恢复的动作**
                （彻底删除），移入回收站能原样拿回来，配红按钮是在虚张声势 ——
                真到了回收站里要点"彻底删除"时，那一下反而没那么醒目了 */}
            <Button
              variant="primary"
              onClick={async () => {
                setConfirming(false);
                await knowledgeApi.trash(item.id);
                navigate('/knowledge');
              }}
            >
              移入回收站
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          「{item.title}」会被移入回收站，保留 {keepDays} 天，期间随时可以恢复；到期后由服务端自动永久删除。
        </p>
      </Modal>

      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="导出这一篇"
        footer={
          <Button variant="ghost" onClick={() => setExportOpen(false)}>
            关闭
          </Button>
        }
      >
        <p className="text-2xs leading-relaxed text-faint">
          导出的是正文的 Markdown 原文（{body.length} 字）。标签、置顶与一句话说明不在里面 ——
          它们属于这个库的分类口径，不属于这篇文章。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="soft" onClick={() => void doCopy()}>
            <Copy size={12} />
            {copied === 'done' ? '已复制' : copied === 'fail' ? '复制失败' : '复制 Markdown'}
          </Button>
          <Button size="sm" variant="primary" onClick={download}>
            <Download size={12} />
            下载 .md
          </Button>
          <span className="num text-2xs text-faint">文件名：{(item.title || '未命名').slice(0, 24)}.md</span>
        </div>
      </Modal>

      {/* 回到顶部。fixed 而不放在目录里：窄屏没有目录轨，长文照样要能回顶。
          bottom-20 是为了让开移动端那条底部导航（lg 以上才收回 6） */}
      {showTop ? (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="回到顶部"
          title="回到顶部"
          className="fixed bottom-20 right-4 z-30 rounded-full border border-line bg-panel p-2.5 text-muted shadow-[0_6px_18px_-10px_rgba(20,40,80,.4)] transition-colors hover:text-accent lg:bottom-6 lg:right-6"
        >
          <ArrowUp size={14} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/* ── 目录 ──────────────────────────────────────────────────────────────
   长文没有锚点就只能一路滚。标题的 id 由 rehype-slug 生成，
   这里用的 github-slugger 是同一个库，所以点下去一定跳得到（见 lib/outline.ts）。

   只列 `##` 与 `###`：更深的两级在目录里缩进到看不清层级，
   而 `h1` 通常就是文章标题本身，再放一遍等于重复页头。 */
function Outline({ items }: { items: OutlineItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  /* ── 高亮跟着读到哪儿走 ──────────────────────────────────────────
     判定线取视口顶往下 140px：比"滚过屏幕最顶端"更符合直觉 ——
     标题刚被顶栏盖住时就该切过去了，而不是等它完全消失。

     用滚动位置算（而不是 IntersectionObserver）：IO 给的是"有没有进入视口"，
     而这里要的是"当前正在读哪一节"，那是**最后一个越过判定线的标题**。
     长文里同时有四五节在视口内，IO 分不出先后。 */
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const LINE = 140;
      let current = items[0]?.id ?? null;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - LINE <= 0) current = it.id;
      }
      /* 滚到底时高亮最后一节：末尾那几节的标题永远越不过判定线，
         不特判的话它们一次都亮不起来 */
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      if (atBottom) current = items[items.length - 1]?.id ?? current;
      setActive(current);
    };
    const onScroll = () => {
      // 一帧最多算一次：滚动事件比帧率密得多
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items]);

  /* 高亮项跑出目录可视区时把目录自己滚一下。
     **只在跑出去的时候才滚** —— 每次都居中对齐的话，
     用户想手动翻目录找另一节，手一松就被拽回去。 */
  useEffect(() => {
    const list = listRef.current;
    const el = activeRef.current;
    if (!list || !el) return;
    const r = el.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top) list.scrollTop -= lr.top - r.top + 8;
    else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom + 8;
  }, [active]);

  return (
    <nav aria-label="目录" className="panel px-3 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-2xs font-medium text-faint">
        <List size={11} aria-hidden />
        目录
      </p>
      <ul ref={listRef} className="max-h-[calc(100vh-14rem)] space-y-0.5 overflow-y-auto">
        {items.map((it) => {
          const on = active === it.id;
          return (
            <li key={it.id} className={it.level >= 3 ? 'ml-3' : ''}>
              <button
                ref={on ? activeRef : null}
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => {
                  const el = document.getElementById(it.id);
                  /* 找不到（渲染还没跟上、或 id 撞了）就只是不动，
                     比抛一个错或者跳到页首都好 */
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className={cls(
                  'block w-full truncate border-l-2 pl-2 text-left text-2xs leading-relaxed transition-colors',
                  /* 边框**始终存在**（透明也是边框）：只在选中时才画出来，
                     不然高亮那一行的文字会突然往右跳 */
                  on ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-accent',
                  !on && it.level >= 3 && 'text-faint',
                )}
              >
                {it.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ── 编辑（整页）────────────────────────────────────────────────────── */

type Draft = { type: KnowledgeItem['type']; title: string; tags: string; summary: string; body: string };

const EMPTY_DRAFT: Draft = { type: 'sop', title: '', tags: '', summary: '', body: '' };

/* ── 草稿备份 ─────────────────────────────────────────────────────────
   给"拦不住的那条路"兜底：浏览器后退键（见 lib/nav-guard 里为什么拦不住）。
   没有它，一次误按后退，刚从网址导进来的整篇长文就没了。

   存 localStorage 而不是往服务端发：这是**未保存**的东西，发上去就等于
   替用户保存了 —— 而他点「取消」的意思恰恰是不想要它。 */
type Backup = { at: number; draft: Draft };

const backupKey = (key: string) => `wb:kb-draft:${key}`;

/** 读备份。localStorage 里的东西不能信：坏了、被手改过，都当没有 */
function readBackup(key: string): Backup | null {
  try {
    const raw = localStorage.getItem(backupKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Backup;
    return parsed?.draft && typeof parsed.draft.body === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function clearBackup(key: string) {
  try {
    localStorage.removeItem(backupKey(key));
  } catch {
    /* 无痕模式下连删都可能抛。备份只是兜底，失败不该打断编辑 */
  }
}

/** 快捷键一览。放在编辑器里而不是帮助文档里 —— 写的时候才想起来"这有没有快捷键" */
const SHORTCUTS: [string, string][] = [
  /* 行内 */
  ['Ctrl + B', '加粗'],
  ['Ctrl + I', '斜体'],
  ['Ctrl + Shift + X', '删除线'],
  ['Ctrl + E', '行内代码'],
  ['Ctrl + K', '链接'],
  /* 块级 */
  ['Ctrl + Alt + 1 – 6', '一至六级标题'],
  ['Ctrl + Shift + 8', '无序列表'],
  ['Ctrl + Shift + 7', '有序列表'],
  ['Ctrl + Shift + 9', '任务清单'],
  ['Ctrl + Shift + .', '引用'],
  ['Ctrl + Alt + C', '代码块'],
  ['Ctrl + Alt + T', '表格'],
  ['Ctrl + Alt + I', '图片'],
  ['Ctrl + Shift + -', '分隔线'],
  /* 编辑手感 */
  ['Tab / Shift + Tab', '缩进 / 反缩进'],
  ['Enter', '列表里自动续行'],
  ['Ctrl + Enter / Ctrl + S', '保存'],
  ['选中文字后粘贴网址', '自动变成链接'],
  ['输入 [[', '补出另一篇的标题'],
];

/** 下拉里最多列几个标题。够翻到想要的那个，又不至于盖住半屏正文 */
const WIKI_MAX = 8;

/**
 * textarea 里第 index 个字符相对于**框左上角**的坐标。
 *
 * textarea 没有"取光标位置"的接口，只能用一个看不见的影子 div 复刻它的排版：
 * 把 index 之前的文字放进同样的盒子里，末尾那个标记 span 的位置就是光标的位置。
 *
 * 关键是**字体和盒模型要逐项照抄** —— 漏一项就会偏，而偏了的补全框
 * 比没有更难用（它指的是别处）。left 要夹住，否则靠右写时会顶出框外。
 */
function caretOffset(ta: HTMLTextAreaElement, index: number) {
  const div = document.createElement('div');
  const style = window.getComputedStyle(ta);
  for (const p of [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'tabSize',
    'textIndent',
    'textTransform',
    'wordSpacing',
  ]) {
    div.style.setProperty(p, style.getPropertyValue(p));
  }
  div.style.position = 'absolute';
  div.style.top = '0';
  div.style.left = '-9999px';
  div.style.visibility = 'hidden';
  div.style.height = 'auto';
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';

  div.textContent = ta.value.slice(0, index);
  const mark = document.createElement('span');
  /* 一个字符就够：要的是标记**开头**的位置，而那正是光标的位置。
     空 span 没有高度，量不出来 */
  mark.textContent = 'x';
  div.appendChild(mark);
  document.body.appendChild(div);
  /* 补全框定宽 16rem（256px），但窄屏上编辑区可能不到 256px。
     夹取上限要用「实际宽度」而不是写死 260，否则框会从右边顶出去。 */
  const popupW = Math.min(256, ta.clientWidth);
  const offset = {
    top: mark.offsetTop - ta.scrollTop,
    left: Math.max(0, Math.min(mark.offsetLeft - ta.scrollLeft, ta.clientWidth - popupW)),
  };
  document.body.removeChild(div);
  return offset;
}

export function KnowledgeEditor() {
  const { id } = useParams<{ id: string }>();
  const { knowledge, knowledgeApi, ready } = useStore();
  const navigate = useNavigate();

  const source = id ? (knowledge.find((k) => k.id === id) ?? null) : null;

  /* 正文按需取：列表里没有 body，编辑前先把它拉回来。
     null = 还没取到 —— 这个区分很关键：那时**不能**灌草稿，
     否则就是拿一篇空文档覆盖掉库里的正文（保存一下就没了）。 */
  const [sourceBody, setSourceBody] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setSourceBody('');
      return;
    }
    let alive = true;
    setSourceBody(null);
    api.knowledge
      .get(id)
      .then((item) => {
        if (alive) setSourceBody(item.body ?? '');
      })
      .catch(() => {
        if (alive) setSourceBody('');
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /* 进来时的样子。脏检测就是拿当前 draft 跟它比 —— 不用布尔标志位，
     那样"改了又改回来"会被算成脏的，而它其实没变 */
  const [base, setBase] = useState<string>(() => JSON.stringify(EMPTY_DRAFT));
  /* 上次离开时留下的草稿（只在后退那条路上会出现，见文件头的备份说明） */
  const [restorable, setRestorable] = useState<Backup | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [aiWide, setAiWide] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  /* 从「导入网址」进来时，草稿挂在路由 state 上而不是 URL 里：
     正文动辄上万字，塞进地址栏既不合适、也会被浏览器截断。
     代价是硬刷新会丢 —— 可以接受，那时本来也还没保存过。 */
  const location = useLocation();
  const imported = (location.state as { imported?: ImportedArticle } | null)?.imported ?? null;

  /* 草稿只在"进到某个条目"时灌一次，用 syncKey 而不是 useEffect：
     同一次渲染里同步下来，不会先画一帧空表单再填上。
     必须等 ready —— 直接刷新 /knowledge/:id/edit 时 knowledge 还是空的，
     那时灌进去的是一篇空文档，用户一保存就把正文清了。

     同理**必须等正文取回来**（sourceBody !== null）：列表里没有 body，
     少这一句就会先用空正文把草稿灌好、syncKey 也记上了，等正文到时
     已经不会再灌第二次 —— 编辑器里就是一篇空的，一保存正文没了。 */
  const key = id ?? (imported ? `import:${imported.url}` : 'new');
  const [syncKey, setSyncKey] = useState<string | null>(null);
  if (ready && sourceBody !== null && syncKey !== key) {
    setSyncKey(key);
    const next: Draft = source
      ? {
          type: source.type,
          title: source.title,
          tags: (source.tags ?? []).join(', '),
          summary: source.summary ?? '',
          body: sourceBody ?? '',
        }
      : imported
        ? {
            type: 'sop',
            title: imported.title,
            // 站点名当兜底标签：抓来的文章多半没有 article:tag，总得有点可以归类的东西
            tags: (imported.tags.length ? imported.tags : [imported.siteName]).join(', '),
            summary: imported.summary,
            /* 正文顶上留一行出处。导入的内容必须能找回原站，
               而且这行本身也参与搜索（搜站点名就能找到它） */
            body: `> 原文：[${imported.title || imported.siteName}](${imported.url})\n\n${imported.markdown}`,
          }
        : EMPTY_DRAFT;
    setDraft(next);
    /* 基线跟草稿一起定下来。不跟着 source 重算（放 useEffect 里）：
       保存之后 source 会变，那样"刚改完还没存"会被重新算成"没改" */
    setBase(JSON.stringify(next));
    /* 顺手看一眼上次是不是从"拦不住的那条路"走的 —— 是的话这里还有个备份 */
    setRestorable(readBackup(key));
  }

  const patch = (next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next }));

  /* 改了没有。比的是"进来到现在变没变"，不是"曾经改过没有" ——
     改完又原样改回去，那就是没改，不该再拦着人走 */
  const dirty = JSON.stringify(draft) !== base;

  /**
   * 允许离开吗。确认之后顺手把备份也清掉 —— 用户刚刚明确说了不要这些改动，
   * 再留一份等他下次回来"恢复"，就是拧着来。
   */
  const leaveOk = useCallback(() => {
    if (!dirty) return true;
    if (!window.confirm('这篇还有没保存的改动，离开就会丢掉。确定离开吗？')) return false;
    clearBackup(key);
    return true;
  }, [dirty, key]);

  /* ── 离开拦截 ──────────────────────────────────────────────────────
     两条路各管一半：点击闸管站内跳转（左侧导航、正文里的链接都算），
     beforeunload 管刷新和关标签。后退键这两条都不管 —— 那份东西由备份兜。 */
  useEffect(() => {
    if (!dirty) return;
    const offGuard = armLeaveGuard(leaveOk);
    const offUnload = armBeforeUnload();
    return () => {
      offGuard();
      offUnload();
    };
  }, [dirty, leaveOk]);

  /* ── 草稿备份 ──────────────────────────────────────────────────────
     延迟 500ms 再写：导入的长文序列化一次不便宜，不必每个按键都做。
     改动清零（保存掉、或撤销回原样）就把备份删掉。
     **但已经有一份等着被恢复时不能删** —— 否则进编辑器的第一帧
     就会把要恢复的东西擦掉，这种 bug 只在真的丢了东西时才会被发现。 */
  useEffect(() => {
    if (!ready || syncKey !== key) return;
    if (!dirty) {
      if (!restorable) clearBackup(key);
      return;
    }
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(backupKey(key), JSON.stringify({ at: Date.now(), draft }));
      } catch {
        /* 配额满了或被禁写。兜底手段失败不该打断编辑 */
      }
    }, 500);
    return () => window.clearTimeout(t);
  }, [ready, syncKey, key, dirty, draft, restorable]);

  /* ── 双链标题补全 ──────────────────────────────────────────────────
     光标前有一个待补全的 `[[` 时，把候选标题列在光标下面。
     为什么要它：标题得凭记忆写准，写错了不报错 —— 只渲染成一条虚线的断链，
     不点开那篇就发现不了。而所有标题本来就在手边。 */
  const [wiki, setWiki] = useState<{ from: number; query: string; index: number } | null>(null);
  const [wikiPos, setWikiPos] = useState<{ top: number; left: number } | null>(null);

  const wikiCandidates = useMemo(() => {
    if (!wiki) return [];
    /* 用 normalizeTitle 比：和渲染时解析双链、图谱算边是同一套口径，
       于是"这里列出来的"一定就是"链得上的" */
    const needle = normalizeTitle(wiki.query);
    return knowledge
      .filter((k) => k.id !== id && (!needle || normalizeTitle(k.title).includes(needle)))
      .slice(0, WIKI_MAX);
  }, [wiki, knowledge, id]);

  /** 看看光标前有没有一个待补全的 `[[`，有就定位下拉并算候选 */
  const syncWiki = () => {
    const ta = taRef.current;
    if (!ta) return;
    const upto = ta.value.slice(0, ta.selectionStart);
    const from = upto.lastIndexOf('[[');
    /* 已经写了 `]]`、或中间换行了，那就不是在补一个双链 */
    const typed = from < 0 ? '' : upto.slice(from + 2);
    if (from < 0 || /[\]\n]/.test(typed)) {
      setWiki(null);
      return;
    }
    const query = typed.trim();
    /* 上下键改的是选中项，不能被"重算一遍"冲掉 —— 只有查询真变了才归零 */
    setWiki((prev) => (prev && prev.from === from && prev.query === query ? prev : { from, query, index: 0 }));
    setWikiPos(caretOffset(ta, from));
  };

  /** 选中一个标题：把 `[[…` 补成 `[[标题]]` */
  const commitWiki = (title: string) => {
    const ta = taRef.current;
    if (!ta || !wiki) return;
    const end = ta.selectionStart;
    /* 工具按钮那条路会先插好 `[[]]` 并把光标停在中间，这时右边已有 `]]`，
       得一起吃掉 —— 否则会补出 `]]]]` */
    const tail = ta.value.slice(end, end + 2) === ']]' ? 2 : 0;
    const at = wiki.from + title.length + 4;
    editRange(wiki.from, end + tail, `[[${title}]]`, at, at);
    setWiki(null);
  };

  /** 工具按钮：有选区就包起来；没有就插一对括号并把补全打开 */
  const insertWiki = () => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const inner = value.slice(s, e);
    if (inner) {
      const at = s + inner.length + 4;
      editRange(s, e, `[[${inner}]]`, at, at);
      setWiki(null);
      return;
    }
    editRange(s, e, '[[]]', s + 2, s + 2);
    setWiki({ from: s, query: '', index: 0 });
    setWikiPos(caretOffset(ta, s));
  };

  /**
   * 改写编辑器内容，并把选区放到指定位置。
   *
   * 走 document.execCommand('insertText')，而不是直接 setState ——
   * 受控 textarea 一旦被 React 改写 value，浏览器那套**原生撤销栈就被清空**了，
   * 表现出来就是"Ctrl+Z 撤不回刚插入的加粗"。命令越多这个越刺眼。
   * insertText 走的是原生编辑流程：撤销栈、输入法组合都保持正常，
   * 改完还会派发 input 事件，React 的 onChange 照收（所以状态不会不同步）。
   * execCommand 名义上已废弃，但所有浏览器都还实现，而且没有等价替代
   * （本项目另一处也在用它做剪贴板兜底）。
   *
   * 环境不支持时退回受控赋值，功能不丢，只是那一笔进不了撤销栈。 */
  function editRange(start: number, end: number, text: string, selStart: number, selEnd: number) {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    let native = false;
    try {
      native = document.execCommand('insertText', false, text);
    } catch {
      native = false;
    }
    if (!native) {
      const value = ta.value;
      patch({ body: `${value.slice(0, start)}${text}${value.slice(end)}` });
    }
    /* 选区一律留到下一帧复位：insertText 会把光标停在插入内容之后，
       而这里想要的通常是"选中刚插进去的那段"，好让用户接着敲字替换它 */
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
    });
  }

  /**
   * 把文章助手的回答追加到**正文末尾**（助手面板上那条「追加到正文」）。
   *
   * 走 editRange 而不是直接 patch：受控 textarea 一旦被 React 改写 value，
   * 浏览器那套原生撤销栈就被清空了（理由见 editRange 上面那段）——
   * 追加一整段回答之后按 Ctrl+Z 却撤不回来，比不追加还难受。
   *
   * 预览模式下 textarea 没挂载，这时退回受控赋值：功能不丢，
   * 只是那一笔进不了撤销栈；预览区本来就在渲染 draft.body，追加完能立刻看到。
   *
   * 不切页签：正在读预览的人不该被一次追加拽回编辑态，
   * 预览里当场多出这一段，本身就是最好的确认。
   */
  function appendToBody(text: string) {
    const answer = text.trim();
    if (!answer) return;
    const ta = taRef.current;
    /* 有 textarea 就以它的值为准 —— 它才是"所见即所改"的那一份 */
    const cur = ta ? ta.value : draft.body;
    /* 段与段之间空一行才对得上 Markdown 的块语法；末尾统一补一个换行，
       下一次追加才不会和这一段黏在一起 */
    const sep = !cur.trim() ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
    const insert = `${sep}${answer}\n`;
    if (!ta) {
      patch({ body: cur + insert });
      return;
    }
    const end = cur.length + insert.length;
    editRange(cur.length, cur.length, insert, end, end);
  }

  /** 取"选区所在的行区间"。没有选区时就是光标那一行 ——
     列表符、标题、缩进都是按行生效的，不是按选区。 */
  function lineRange(ta: HTMLTextAreaElement) {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const nl = value.indexOf('\n', s);
    const lineEnd = e > s ? e : nl === -1 ? value.length : nl;
    return { s, e, value, lineStart, lineEnd };
  }

  /** 把选区用 before/after 包起来；没有选区就插一个占位词并选中它 */
  function surround(before: string, after: string, fallback = '文本') {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const inner = value.slice(s, e) || fallback;
    editRange(s, e, `${before}${inner}${after}`, s + before.length, s + before.length + inner.length);
  }

  /** 行首前缀的开关：整段都已经带了就去掉，否则加上。
   *  「再按一次取消」是这类命令必须有的行为，否则加错了只能手工删。 */
  function togglePrefix(add: (i: number) => string, test: RegExp) {
    const ta = taRef.current;
    if (!ta) return;
    const { value, lineStart, lineEnd } = lineRange(ta);
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const on = lines.every((l) => test.test(l));
    const block = lines.map((l, i) => (on ? l.replace(test, '') : `${add(i)}${l}`)).join('\n');
    editRange(lineStart, lineEnd, block, lineStart, lineStart + block.length);
  }

  const toggleBullet = () => togglePrefix(() => '- ', /^[-*+]\s+/);
  const toggleOrdered = () => togglePrefix((i) => `${i + 1}. `, /^\d+[.)]\s+/);
  /* 任务清单是 GFM 扩展（没有它就只是普通的 - 列表） */
  const toggleTask = () => togglePrefix(() => '- [ ] ', /^[-*+]\s\[[ xX]\]\s+/);
  const toggleQuote = () => togglePrefix(() => '> ', /^>\s?/);

  /** 标题级别开关，1–6 级 */
  function setHeading(level: number) {
    const ta = taRef.current;
    if (!ta) return;
    const { value, lineStart, lineEnd } = lineRange(ta);
    const block = value
      .slice(lineStart, lineEnd)
      .split('\n')
      .map((l) => {
        const hit = /^\s*(#{1,6})\s+/.exec(l);
        const text = hit ? l.replace(/^\s*#{1,6}\s+/, '') : l.replace(/^\s*/, '');
        return hit && hit[1].length === level ? text : `${'#'.repeat(level)} ${text}`;
      })
      .join('\n');
    editRange(lineStart, lineEnd, block, lineStart, lineStart + block.length);
  }

  /** Tab / Shift+Tab：缩进用两个空格而不是制表符 ——
   *  Markdown 里四个空格是代码块，两个空格是嵌套列表，用 Tab 字符会两不像。 */
  function indent(dir: 1 | -1) {
    const ta = taRef.current;
    if (!ta) return;
    const { value, lineStart, lineEnd } = lineRange(ta);
    const block = value
      .slice(lineStart, lineEnd)
      .split('\n')
      .map((l) => {
        if (dir === 1) return `  ${l}`;
        const m = /^(?: {1,2}|\t)/.exec(l);
        return m ? l.slice(m[0].length) : l;
      })
      .join('\n');
    editRange(lineStart, lineEnd, block, lineStart, lineStart + block.length);
  }

  /**
   * 块级插入：前后各补一个换行，免得插进去的内容和相邻行黏成一行
   * （`---` 黏在文字后面就不是分隔线，而是 setext 标题了）。
   * 会替换当前选区；Ctrl+Z 可撤。
   */
  function insertBlock(text: string, selOffset: number, selLen = 0) {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const lead = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
    const trail = e < value.length && value[e] !== '\n' ? '\n' : '';
    const at = s + lead.length;
    editRange(s, e, `${lead}${text}${trail}`, at + selOffset, at + selOffset + selLen);
  }

  /** 围栏代码块。Runbook 里最常用的一个动作，所以单独给一个按钮。
   *  没选区时把光标停在第一行围栏之后 —— 接下来直接敲 bash / yaml 就是语言标注。 */
  function fence() {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const inner = value.slice(s, e);
    const lead = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
    const at = s + lead.length;
    if (inner) {
      editRange(s, e, `${lead}\`\`\`\n${inner}\n\`\`\`\n`, at + 4, at + 4 + inner.length);
    } else {
      editRange(s, e, `${lead}\`\`\`\n\n\`\`\`\n`, at + 3, at + 3);
    }
  }

  /** 链接 / 图片：先把 url 选中，接着敲字就是替换 */
  function insertLink() {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const text = value.slice(s, e) || '链接文字';
    editRange(s, e, `[${text}](url)`, s + text.length + 3, s + text.length + 6);
  }

  function insertImage() {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const alt = value.slice(s, e) || '图片描述';
    editRange(s, e, `![${alt}](url)`, s + alt.length + 4, s + alt.length + 7);
  }

  /** GFM 表格骨架，插完选中第一个表头格 */
  function insertTable() {
    insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', 2, 3);
  }

  /** 在列表 / 引用里回车自动续行；空条目上再按一次回车就退出该列表。
   *  这是手写 Markdown 里最高频的两个动作，缺了它列表根本写不动。 */
  function continueList(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e2, value } = ta;
    if (s !== e2) return; // 有选区时交给浏览器默认行为（回车=替换选区）

    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(lineStart, s);
    const ordered = /^(\s*)(\d+)([.)])(\s+)(.*)$/.exec(line);
    const bullet = /^(\s*)([-*+])(\s+)(.*)$/.exec(line);
    const quote = /^(\s*)(>)(\s?)(.*)$/.exec(line);
    if (!ordered && !bullet && !quote) return;

    const indentStr = (ordered ?? bullet ?? quote)![1];
    const content = ordered ? ordered[5] : bullet ? bullet[4] : quote![4];

    e.preventDefault();
    if (!content.trim()) {
      /* 空条目上再按回车 = 退出列表：把这一行的标记整个抹掉。
         不做这个的话，"怎么从列表里出来"会一直卡着人。 */
      editRange(lineStart, s, '', lineStart, lineStart);
      return;
    }
    const marker = ordered ? `${Number(ordered![2]) + 1}${ordered![3]} ` : bullet ? `${bullet[2]} ` : '> ';
    const insert = `\n${indentStr}${marker}`;
    editRange(s, s, insert, s + insert.length, s + insert.length);
  }

  /** 选中文字后直接粘一个网址 → 变成链接。不做这一步的话，
   *  得先 Ctrl+K 再回头把 url 贴上，多绕一圈。 */
  function onPaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const ta = taRef.current;
    if (!ta) return;
    const url = e.clipboardData.getData('text/plain').trim();
    if (!/^https?:\/\/\S+$/.test(url)) return;
    const { selectionStart: s, selectionEnd: end } = ta;
    if (s === end) return; // 没选中文字就按普通粘贴
    e.preventDefault();
    const text = ta.value.slice(s, end);
    editRange(s, end, `[${text}](${url})`, s + 1, s + 1 + text.length);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const meta = e.metaKey || e.ctrlKey;
    /* 一律用 e.code 判断键位，不用 e.key：Shift+7、Shift+. 在美式键盘上
       e.key 分别是 "&" 和 ">"，拿 key 比对永远命中不了 */
    if (meta && e.key === 'Enter') {
      e.preventDefault();
      void save();
      return;
    }
    /* Ctrl+S：写东西的人手比脑子快，习惯性就按了。不拦的话浏览器会弹
       「保存网页」 —— 那一下才是真的打断，而且存下来的是个没用的 html */
    if (meta && e.code === 'KeyS') {
      e.preventDefault();
      void save();
      return;
    }

    /* 补全列表开着时，上下键 / 回车 / Tab 归它：回车在编辑器里是"续行"、
       Tab 是缩进，不抢的话一个都选不中。带 Ctrl/Cmd 的组合不受影响
       —— Ctrl+Enter 照旧是保存（上面已经拦掉了）。 */
    if (!meta && wiki && wikiCandidates.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setWiki({ ...wiki, index: (wiki.index + 1) % wikiCandidates.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setWiki({ ...wiki, index: (wiki.index - 1 + wikiCandidates.length) % wikiCandidates.length });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setWiki(null);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitWiki(wikiCandidates[wiki.index].title);
        return;
      }
    }

    /* Ctrl+Alt 这一组留给块级元素。标题没有用 Ctrl+1..6（Typora 那套）：
       浏览器把 Ctrl+数字 抢去切标签页了，抢不过；Google Docs 用的也是 Ctrl+Alt+数字。 */
    if (meta && e.altKey) {
      if (/^Digit[1-6]$/.test(e.code)) {
        e.preventDefault();
        setHeading(Number(e.code.slice(-1)));
        return;
      }
      if (e.code === 'KeyC') {
        e.preventDefault();
        fence();
        return;
      }
      if (e.code === 'KeyT') {
        e.preventDefault();
        insertTable();
        return;
      }
      if (e.code === 'KeyI') {
        e.preventDefault();
        insertImage();
        return;
      }
    }

    /* Ctrl+Shift 这一组是列表 / 引用（Ctrl+Shift+7/8 沿用 Google Docs 的习惯） */
    if (meta && e.shiftKey) {
      if (e.code === 'Digit7') {
        e.preventDefault();
        toggleOrdered();
        return;
      }
      if (e.code === 'Digit8') {
        e.preventDefault();
        toggleBullet();
        return;
      }
      if (e.code === 'Digit9') {
        e.preventDefault();
        toggleTask();
        return;
      }
      if (e.code === 'Period') {
        e.preventDefault();
        toggleQuote();
        return;
      }
      if (e.code === 'Minus') {
        e.preventDefault();
        insertBlock('---\n', 4);
        return;
      }
      if (e.code === 'KeyX') {
        e.preventDefault();
        surround('~~', '~~', '删除文字');
        return;
      }
    }

    /* Ctrl 单独一组是行内元素 */
    if (meta && !e.shiftKey && !e.altKey) {
      if (e.code === 'KeyB') {
        e.preventDefault();
        surround('**', '**', '加粗文字');
        return;
      }
      if (e.code === 'KeyI') {
        e.preventDefault();
        surround('*', '*', '斜体文字');
        return;
      }
      if (e.code === 'KeyE') {
        e.preventDefault();
        surround('`', '`', 'command');
        return;
      }
      if (e.code === 'KeyK') {
        e.preventDefault();
        insertLink();
        return;
      }
    }

    /* Tab 在 Markdown 里是有意义的（缩进 = 嵌套列表 / 代码块），
       而浏览器默认的"把焦点跳到下一个控件"会让它写不出来 —— 必须拦掉 */
    if (e.key === 'Tab') {
      e.preventDefault();
      indent(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Enter') continueList(e);
  }

  async function save() {
    const title = draft.title.trim();
    if (!title || busy) return;
    setBusy(true);
    const payload = {
      type: draft.type,
      title,
      tags: draft.tags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8),
      summary: draft.summary.trim(),
      body: draft.body,
    };
    if (id) {
      await knowledgeApi.patch(id, payload);
      /* 已经进库了，备份就没用了。不清的话下次进编辑器还会问"要不要恢复" */
      clearBackup(key);
      setBusy(false);
      navigate(`/knowledge/${id}`);
      return;
    }
    const created = await knowledgeApi.add(payload);
    setBusy(false);
    // 拿不到条目（保存失败）就留在编辑器里，别把刚写的正文弄丢
    if (created) {
      clearBackup(key);
      navigate(`/knowledge/${created.id}`);
    }
  }

  if (!ready) {
    return (
      <div className={cls('mx-auto w-full', PAGE_MAX)}>
        <Card>
          <p className="text-xs text-faint">正在加载…</p>
        </Card>
      </div>
    );
  }

  /* 页头的「取消」和左上角的「返回」都走这里，所以拦截放在这里就够 ——
     它们调的是 navigate()，不是 <a>，点击闸看不见这种跳转 */
  const back = () => {
    if (!leaveOk()) return;
    navigate(id ? `/knowledge/${id}` : '/knowledge');
  };

  const restoreBackup = () => {
    if (!restorable) return;
    setDraft(restorable.draft);
    setRestorable(null);
  };

  const discardBackup = () => {
    clearBackup(key);
    setRestorable(null);
  };

  return (
    <div className={cls('mx-auto w-full space-y-4', PAGE_MAX)}>
      <button
        type="button"
        onClick={back}
        className="inline-flex items-center gap-1.5 text-2xs font-medium text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={13} aria-hidden />
        {id ? '返回条目' : '知识库'}
      </button>

      <PageHead
        title={id ? '编辑条目' : '新建条目'}
        hint="正文用 Markdown：标题、列表、代码块、表格都可以。写 [[另一篇的标题]] 可以链过去，知识图谱就是按这些双链和标签画的。"
        actions={
          <>
            {/* 未保存标记。只在脏的时候出现 —— 这里不像设置页有一排保存按钮
                需要表明状态，干净的时候挂一个「已保存」只是噪声 */}
            {dirty ? (
              <span className="flex items-center gap-1.5 text-2xs text-warn">
                <Led tone="warn" />
                未保存
              </span>
            ) : null}
            <Button size="sm" variant="ghost" onClick={back}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !draft.title.trim()} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </>
        }
      />

      {/* 上次是从"拦不住的那条路"走的（后退键 / 强行关标签）：拦不住，
          但东西还在 —— 给一次找回来的机会 */}
      {restorable ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-field border border-warn/35 px-3 py-2 text-2xs text-warn">
          <Undo2 size={12} aria-hidden className="shrink-0" />
          <span className="min-w-0">
            上次离开时这份草稿还没保存（{fmtDateTime(restorable.at)}，正文 {restorable.draft.body.length} 字）。
          </span>
          <Button size="sm" variant="soft" onClick={restoreBackup}>
            恢复
          </Button>
          <Button size="sm" variant="ghost" onClick={discardBackup}>
            丢弃
          </Button>
        </div>
      ) : null}

      {/* 抽取是启发式的，所以"哪里可能不对"要放在最显眼的地方，而不是让用户自己去发现 */}
      {imported && !id ? (
        <div className="rounded-field border border-warn/35 px-3 py-2 text-2xs leading-relaxed text-warn">
          <p>
            已从 {imported.siteName} 抓到 {imported.markdown.length} 字，填在下面当草稿 —— 确认没问题再保存。
          </p>
          {imported.warnings.map((w) => (
            <p key={w} className="mt-1">
              · {w}
            </p>
          ))}
        </div>
      ) : null}

      <div className={cls('grid gap-4 xl:items-start', aiWide ? 'grid-cols-1' : 'xl:grid-cols-[minmax(0,1fr)_26rem]')}>
        <div className={cls('min-w-0 space-y-4', aiWide && 'hidden')}>
          <Card className="space-y-3.5">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <Field label="类型" hint="SOP = 固定流程；Runbook = 故障处置；摘录 = 读来的素材">
                <Segmented
                  value={draft.type}
                  onChange={(v) => patch({ type: v })}
                  options={[
                    { value: 'sop', label: 'SOP' },
                    { value: 'runbook', label: 'Runbook' },
                    { value: 'excerpt', label: '摘录' },
                  ]}
                />
              </Field>
              <Field label="标题">
                <Input
                  value={draft.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="例如：PVE 节点无响应处置"
                />
              </Field>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <Field label="标签" hint="逗号或空格分隔，例如：PVE, 应急, 网络">
                <Input value={draft.tags} onChange={(e) => patch({ tags: e.target.value })} placeholder="PVE, 应急, 存储" />
              </Field>
              <Field label="一句话说明">
                <Input
                  value={draft.summary}
                  onChange={(e) => patch({ summary: e.target.value })}
                  placeholder="解决什么问题，什么时候用它"
                />
              </Field>
            </div>
          </Card>

          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1">
                {/* 分组按"行内 → 列表 → 整块"排，组间一条竖线：
                    按钮一多，不分组就是一排看不出区别的图标 */}
                <ToolButton label="一级标题（Ctrl + Alt + 1）" onClick={() => setHeading(1)}>
                  <Heading1 size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="二级标题（Ctrl + Alt + 2）" onClick={() => setHeading(2)}>
                  <Heading2 size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="三级标题（Ctrl + Alt + 3）" onClick={() => setHeading(3)}>
                  <Heading3 size={13} aria-hidden />
                </ToolButton>

                <ToolDivider />

                <ToolButton label="加粗（Ctrl + B）" onClick={() => surround('**', '**', '加粗文字')}>
                  <Bold size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="斜体（Ctrl + I）" onClick={() => surround('*', '*', '斜体文字')}>
                  <Italic size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="删除线（Ctrl + Shift + X）" onClick={() => surround('~~', '~~', '删除文字')}>
                  <Strikethrough size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="行内代码（Ctrl + E）" onClick={() => surround('`', '`', 'command')}>
                  <Code size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="链接（Ctrl + K）" onClick={insertLink}>
                  <Link2 size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="图片（Ctrl + Alt + I）" onClick={insertImage}>
                  <ImageIcon size={13} aria-hidden />
                </ToolButton>
                {/* 双链是知识图谱的一半边，所以它得能被发现 —— 光靠"知道有这语法"不够。
                    按钮直接把补全打开，而不是插一个占位词让人凭记忆改 */}
                <ToolButton label="双链：链到另一篇（输入 [[ 也会弹出补全）" onClick={insertWiki}>
                  <Brackets size={13} aria-hidden />
                </ToolButton>

                <ToolDivider />

                <ToolButton label="无序列表（Ctrl + Shift + 8）" onClick={toggleBullet}>
                  <List size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="有序列表（Ctrl + Shift + 7）" onClick={toggleOrdered}>
                  <ListOrdered size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="任务清单（Ctrl + Shift + 9）" onClick={toggleTask}>
                  <ListChecks size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="引用（Ctrl + Shift + .）" onClick={toggleQuote}>
                  <Quote size={13} aria-hidden />
                </ToolButton>

                <ToolDivider />

                <ToolButton label="代码块（Ctrl + Alt + C）" onClick={fence}>
                  <Terminal size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="表格（Ctrl + Alt + T）" onClick={insertTable}>
                  <Table size={13} aria-hidden />
                </ToolButton>
                <ToolButton label="分隔线（Ctrl + Shift + -）" onClick={() => insertBlock('---\n', 4)}>
                  <Minus size={13} aria-hidden />
                </ToolButton>
              </div>
              <Segmented
                value={tab}
                onChange={setTab}
                size="sm"
                options={[
                  { value: 'write', label: '编写' },
                  { value: 'preview', label: '预览' },
                ]}
              />
            </div>

            {tab === 'write' ? (
              /* relative 是给补全下拉定位的：它要跟着光标，而 textarea 本身
                 不告诉你光标在哪（坐标靠 caretOffset 影子量出来） */
              <div className="relative">
                <textarea
                  ref={taRef}
                  value={draft.body}
                  onChange={(e) => {
                    patch({ body: e.target.value });
                    syncWiki();
                  }}
                  onKeyDown={onKeyDown}
                  onKeyUp={syncWiki}
                  onClick={syncWiki}
                  onPaste={onPaste}
                  aria-label="Markdown 正文"
                  spellCheck={false}
                  /* 高 42rem ≈ 672px：写长文时不该一屏只看得到十几行。
                     宽度交给外层容器，用户可以自己往下拉大。
                     手机上先给 24rem —— 42rem 在竖屏里比一屏还高，
                     下面那些元信息（标签/摘要）要划很久才看得到。 */
                  className="field num min-h-[24rem] w-full resize-y px-4 py-3.5 text-xs leading-relaxed sm:min-h-[42rem]"
                  placeholder={'## 适用范围\n\n节点 Web UI 打不开、SSH 不通时按下面顺序排查。\n\n```bash\nsystemctl restart pveproxy\njournalctl -u pveproxy -n 200\n```'}
                />

                {wiki && (wikiCandidates.length > 0 || Boolean(wiki.query)) ? (
                  <div
                    className="absolute z-20 w-[16rem] max-w-full overflow-hidden rounded-field border border-line bg-panel shadow-[0_8px_24px_-12px_rgba(20,40,80,.35)]"
                    style={{ top: (wikiPos?.top ?? 0) + 20, left: wikiPos?.left ?? 0 }}
                  >
                    {wikiCandidates.length ? (
                      <ul className="max-h-52 overflow-y-auto py-1" role="listbox" aria-label="双链标题候选">
                        {wikiCandidates.map((k, i) => (
                          <li key={k.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={i === wiki.index}
                              /* 用 mousedown 而不是 click：click 之前 textarea 已经失焦，
                                 选区没了就补不进去了 */
                              onMouseDown={(ev) => {
                                ev.preventDefault();
                                commitWiki(k.title);
                              }}
                              className={cls(
                                'block w-full truncate px-2.5 py-1.5 text-left text-xs transition-colors',
                                i === wiki.index ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-bg-2',
                              )}
                            >
                              {k.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-2.5 py-2 text-2xs leading-relaxed text-faint">
                        没有同名文章。硬写完会渲染成一条虚线的「断链」，链不上 —— 先去建那篇，或换个词。
                      </p>
                    )}
                    <p className="border-t border-line px-2.5 py-1 text-2xs text-faint">
                      ↑↓ 选择 · Enter 或 Tab 补上 · Esc 关掉
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              /* 预览区与编辑区给同一个最小高度，来回切换时页面不会上下跳 */
              <div className="min-h-[24rem] rounded-field bg-bg-2 px-4 py-3.5 sm:min-h-[42rem]">
                {draft.body.trim() ? (
                  <Markdown>{draft.body}</Markdown>
                ) : (
                  <p className="text-xs text-faint">还没有写内容。</p>
                )}
              </div>
            )}

            {/* 用原生 details 而不是自建折叠：这里不需要记住状态，也不需要动画 */}
            <details className="border-t border-line pt-2.5">
              <summary className="cursor-pointer text-2xs text-faint transition-colors hover:text-muted">快捷键</summary>
              <dl className="mt-2 grid gap-x-8 gap-y-1 text-2xs text-muted sm:grid-cols-2 lg:grid-cols-3">
                {SHORTCUTS.map(([keys, desc]) => (
                  <div key={keys} className="flex items-baseline justify-between gap-3">
                    <dt className="num shrink-0 text-faint">{keys}</dt>
                    <dd className="truncate">{desc}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </Card>
        </div>

        {/* 传的是**当前草稿**而不是库里的版本：刚写、还没保存的那段也应该能问。
            key 让它换文章时整个重挂载，对话不会串到下一篇 */}
        <ArticleAssistant
          key={key}
          className={aiWide ? undefined : 'xl:sticky xl:top-[4.5rem]'}
          /* 还没保存的新条目没有 id，回答只留在内存里；保存后随第一次写入带走 */
          articleId={id ?? null}
          initialTurns={source?.ai?.turns ?? []}
          expanded={aiWide}
          onToggleExpand={() => setAiWide((v) => !v)}
          title={draft.title}
          tags={draft.tags.split(/[,，\s]+/).filter(Boolean)}
          summary={draft.summary}
          body={draft.body}
          /* 助手面板上每条回答的「追加到正文」落到这里 —— 那是正在编辑的正文，
             阅读页（KnowledgeDoc）不传，所以那边不长这颗按钮 */
          onAppend={appendToBody}
        />
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-0.5 rounded-field p-1.5 text-muted transition-colors hover:bg-panel-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

/** 工具栏分组之间的竖线。纯装饰：分组的含义由相邻按钮自己说 */
function ToolDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px bg-line" />;
}
