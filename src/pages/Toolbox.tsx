import { useMemo, useState, type CSSProperties } from 'react';
import { FolderPlus, Palette, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react';
import { useStore } from '@/lib/store';
import { type Bookmark, type Group } from '@/lib/api';
import { cls, hostOf } from '@/lib/format';
import { brandTint, paletteTint } from '@/lib/tint';
import { Button, Empty, Input, PageHead, Segmented, Skeleton, Spinner } from '@/components/ui';
import { BookmarkModal, SiteIcon } from '@/components/bookmarks';

/**
 * 工具箱：把「常用网站」从首页那张小卡片升级成一个完整的页面。
 * 数据与首页共用同一份书签（bookmark_groups + bookmarks），
 * 所以在这里加一个入口，首页的常用网站也会同步出现。
 *
 * 版式照参考图走「柔彩画布 + 一排排糖果色磁贴」：这个页面的用途是"找入口"，
 * 一屏能扫到越多越好。所以用色块本身当分区信号 —— 比边框和留白快得多，
 * 一张磁贴只放图标和名字，host 和备注收进 title。
 *
 * 磁贴的颜色默认跟随站点自己的品牌色（见 lib/tint.ts 与后端
 * services/sitecolor.js）：能取到就按它染色，取不到才退回糖纸色板。
 */

/** 这一页的画布：柔彩波浪底（样式见 index.css 的 .tb-canvas）。
    用 fixed 铺满主区（lg 起跳过 228px 的左轨），页面再长也不会断在半路。 */
function PageCanvas() {
  return <span aria-hidden className="tb-canvas pointer-events-none fixed inset-0 -z-10 lg:left-[228px]" />;
}

export default function Toolbox() {
  const { bookmarks, groups, bookmarksApi, ready, notify } = useStore();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string>('all');
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [creating, setCreating] = useState(false);
  const [groupMgr, setGroupMgr] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const [syncing, setSyncing] = useState(false);

  /**
   * 让磁贴去问各家站点"你是什么颜色"。
   *
   * 传 ids 是新增工具后的静默补色，成与不成都不出声 —— 用户刚点完"保存"，
   * 再弹一条"取色失败"只会让人以为保存也出了问题。
   * 不传 ids 是手动点"同步配色"，这时要把结果说清楚：取到几个、几个没取到。
   */
  async function syncColors(ids?: string[]) {
    setSyncing(true);
    try {
      const res = await bookmarksApi.syncColors(ids ? { ids } : undefined);
      if (ids) return;
      notify(
        res.failed.length
          ? `已更新 ${res.updated} 个配色，${res.failed.length} 个没取到（纯灰图标或打不开的站点）`
          : `已更新 ${res.updated} 个配色`,
        res.failed.length ? 'warn' : 'ok',
      );
    } catch (err) {
      if (!ids) notify(err instanceof Error ? err.message : '同步配色失败', 'crit');
    } finally {
      setSyncing(false);
    }
  }

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bookmarks.filter((b) => {
      if (active !== 'all' && b.group !== active) return false;
      if (q && !`${b.name} ${b.url} ${b.note}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [bookmarks, active, query]);

  /* 按分类聚合；没有命中的分类整块不渲染，避免空区块 */
  const grouped = useMemo(
    () =>
      groups
        .map((group) => ({ group, items: matched.filter((b) => b.group === group.id) }))
        .filter(({ items }) => items.length > 0),
    [groups, matched],
  );

  const countOf = (id: string) => bookmarks.filter((b) => b.group === id).length;

  if (!ready) {
    return (
      <div className="relative">
        <PageCanvas />
        <div className="mx-auto w-full max-w-[1600px]" role="status" aria-busy="true">
          <PageHead title="工具箱" hint="内网面板、开发工具与文档入口，按用途分类。" />
          {/* 磁贴骨架用真实那一套网格与尺寸（见下面 <ul> 的 grid-cols 与磁贴的
              h-[54px]），数据到位时才不会重排 */}
          {[0, 1].map((g) => (
            <div key={g} className="mb-8">
              <Skeleton className="mb-4 h-4 w-24 rounded-field" />
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <Skeleton key={i} className="h-[54px] rounded-xl2" />
                ))}
              </div>
            </div>
          ))}
          <span className="sr-only">正在读取工具列表…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <PageCanvas />

      <div className="mx-auto w-full max-w-[1600px]">
        <PageHead
          title="工具箱"
          hint={`日常要用的内网面板、开发工具与文档入口都收在这里，按用途分成 ${groups.length} 类，共 ${bookmarks.length} 个。点图标直接在新标签页打开，点星标可设为常用（会出现在首页的「常用网站」）。磁贴颜色默认跟随站点自己的品牌色，取不到的退回糖纸色板。`}
          actions={
            <>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索名称、网址或备注"
                  className="w-[13rem] pl-8"
                  aria-label="搜索工具"
                />
              </div>
              <Button
                variant="soft"
                size="sm"
                disabled={syncing}
                onClick={() => void syncColors()}
                title="去各站点读它们的主题色 / 图标主色，给磁贴换成本站的颜色"
              >
                {syncing ? <Spinner /> : <Palette size={13} />}
                {syncing ? '取色中…' : '同步站点配色'}
              </Button>
              <Button variant="soft" size="sm" onClick={() => setGroupMgr(true)}>
                <FolderPlus size={13} />
                管理分类
              </Button>
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus size={13} />
                添加工具
              </Button>
            </>
          }
        />

        <Segmented
          className="mb-8"
          value={active}
          onChange={setActive}
          options={[
            { value: 'all', label: `全部 ${bookmarks.length}` },
            ...groups.map((g) => ({ value: g.id, label: `${g.name} ${countOf(g.id)}` })),
          ]}
        />

        {grouped.length === 0 ? (
          <Empty
            title={query.trim() ? '没有匹配的工具' : '这个分类还是空的'}
            hint={query.trim() ? '换个关键词，或者清空搜索看全部。' : '点右上角「添加工具」把地址存进来。'}
            action={
              query.trim() ? (
                <Button size="sm" onClick={() => setQuery('')}>
                  清空搜索
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                  <Plus size={13} />
                  添加工具
                </Button>
              )
            }
          />
        ) : (
          /* 分类之间只靠留白分开：画布本身已经是整片柔彩，再给每类套一层
             白面板等于在画上又贴一张纸，色块的分区信号会被压掉 */
          <div className="space-y-9">
            {grouped.map(({ group, items }) => (
              <section key={group.id} aria-label={group.name}>
                {/* 分类名可以带上自己的 emoji（在「管理分类」里改），这里原样显示。
                    不再在这行右端放条目数：数字被 flex-1 顶到页面最右边，
                    离标题隔着半屏，看着像是别的区块的东西。 */}
                <h2 className="mb-3.5 min-w-0 truncate text-[15.5px] font-semibold text-ink">{group.name}</h2>

                {/* 磁贴墙：小屏两列，宽屏最多八列 —— 和参考图一样，一行扫过去
                    就是一组入口，不用横向折行去找。
                    列数按"一张磁贴约 200px"定：栅格宽了还只放五六个，
                    磁贴会被拉成一条长胶囊，看着像表单行而不是入口块 */}
                <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
                  {items.map((bm) => (
                    <ToolTile
                      key={bm.id}
                      bookmark={bm}
                      onEdit={() => setEditing(bm)}
                      onDelete={() => {
                        void bookmarksApi.remove(bm.id);
                        notify(`已删除「${bm.name}」`);
                      }}
                      onTogglePin={() => void bookmarksApi.patch(bm.id, { pinned: !bm.pinned })}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <BookmarkModal
          open={creating || Boolean(editing)}
          bookmark={editing}
          groups={groups}
          defaultGroup={active === 'all' ? groups[0]?.id : active}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (payload) => {
            if (editing) {
              await bookmarksApi.patch(editing.id, payload);
            } else {
              const added = await bookmarksApi.add(payload as { name: string; url: string });
              // 新增的入口顺手问一次它自己的颜色。放到后台跑，不挡弹窗关闭；
              // 颜色晚一瞬到位，用户不用为此再点一次「同步站点配色」。
              if (added) void syncColors([added.id]);
            }
            setCreating(false);
            setEditing(null);
          }}
        />

        <GroupManager
          open={groupMgr}
          groups={groups}
          countOf={countOf}
          newName={newGroup}
          onNewNameChange={setNewGroup}
          onClose={() => setGroupMgr(false)}
          onCreate={(name) => {
            void bookmarksApi.createGroup(name);
            setNewGroup('');
          }}
          onRename={(id, name) => void bookmarksApi.renameGroup(id, name)}
        />
      </div>
    </div>
  );
}

/**
 * 单个工具磁贴：一颗糖果色方块，左边图标、右边名称（和参考图同构）。
 * 名称左对齐而不是居中 —— 一行里图标都对齐在同一条竖线上，名字自然向左读，
 * 居中反而每格都要重新找起点。
 *
 * 颜色优先跟随站点品牌色：有品牌色就带 data-brand 并只传色相 / 饱和度，
 * 明度交给 CSS 按主题决定（见 index.css 的 .tb-card[data-brand]）；
 * 颜色太灰、太亮太暗或压根没探测过的，退回按 id 散列出来的糖纸色。
 *
 * 三个操作按钮在 hover 时从右侧浮出来，刻意不压在图标上：
 * favicon 是这一格唯一的图形信息，盖住就只剩色块了。
 * 地址和备注收进 title，需要时 hover 就能看到，不占版面。
 */
function ToolTile({
  bookmark,
  onEdit,
  onDelete,
  onTogglePin,
}: {
  bookmark: Bookmark;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const pinned = Boolean(bookmark.pinned);
  const brand = brandTint(bookmark.color);

  return (
    <li className="group/tile relative">
      <a
        href={bookmark.url}
        target="_blank"
        rel="noreferrer noopener"
        title={bookmark.note ? `${bookmark.name} · ${bookmark.note}` : `${bookmark.name} · ${hostOf(bookmark.url)}`}
        data-brand={brand ? '' : undefined}
        style={brand ? ({ '--tb-h': brand.h, '--tb-s': `${brand.s}%` } as CSSProperties) : undefined}
        className={cls(
          /* 小屏右内边距多留一点：常显的星标角标压在磁贴右上角，
             不留白就会被名字的末字穿过（见下面那颗角标） */
          'tb-card flex h-[54px] items-center gap-2.5 rounded-xl2 pl-2 pr-6 sm:pr-2.5',
          brand ? '' : `tb-tint-${paletteTint(bookmark.id || bookmark.name)}`,
        )}
      >
        <span className="tb-icon grid h-9 w-9 shrink-0 place-items-center">
          <SiteIcon bookmark={bookmark} size={28} fill />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-ink">{bookmark.name}</span>
      </a>

      {/* 已标星的角标：常显，否则不知道哪些已经标过了。
          hover 时交还给下面的操作条 —— 那颗星本来就在操作条里 */}
      {pinned ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-2 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-panel/90 text-accent shadow-soft ring-1 ring-white/70 transition-opacity duration-150 group-hover/tile:opacity-0 group-focus-within/tile:opacity-0"
        >
          <Star size={9} fill="currentColor" />
        </span>
      ) : null}

      {/* 操作条。触屏没有 hover，所以小屏常显 —— 但不能像原来那样
          「绝对定位浮在磁贴上」：375px 两列时每格只有 ~166px，
          三个图标连成一条 ~66px 的横条会把名字盖掉大半。
          小屏让它落到磁贴下面一行（正常流），从 sm 起才回到悬浮覆盖层。
          桌面端收起时连点击一起关掉，否则它会挡住磁贴本身的链接。 */}
      <div className="mt-1 flex items-center justify-end gap-px rounded-field px-0.5 transition-opacity duration-150 sm:absolute sm:right-1.5 sm:top-1/2 sm:mt-0 sm:-translate-y-1/2 sm:bg-panel/85 sm:shadow-soft sm:backdrop-blur-sm sm:pointer-events-none sm:opacity-0 sm:group-hover/tile:pointer-events-auto sm:group-hover/tile:opacity-100 sm:group-focus-within/tile:pointer-events-auto sm:group-focus-within/tile:opacity-100">
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={pinned ? `取消常用「${bookmark.name}」` : `设为常用「${bookmark.name}」`}
          title={pinned ? '取消常用' : '设为常用（会出现在首页「常用网站」）'}
          className={cls(
            'rounded-field p-1.5 transition-colors hover:bg-bg-3 sm:p-1',
            pinned ? 'text-accent' : 'text-faint hover:text-ink',
          )}
        >
          <Star size={12} fill={pinned ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`编辑 ${bookmark.name}`}
          title="编辑"
          className="rounded-field p-1.5 text-faint transition-colors hover:bg-bg-3 hover:text-ink sm:p-1"
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除 ${bookmark.name}`}
          title="删除"
          className="rounded-field p-1.5 text-faint transition-colors hover:bg-crit-soft hover:text-crit sm:p-1"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  );
}

/**
 * 分类管理：改名与新增。
 *
 * 书签里存的是分组 id 而不是名字，所以改名不必回头改任何一条书签 ——
 * 这正是当初用 id 关联的意义。
 *
 * 改名做成「输入框失焦即提交」而不是每行配一个保存按钮：
 * 分类一多，那列按钮会把弹窗挤成一根竖条，而且逐行点保存很烦。
 * 用 defaultValue（非受控）是因为分组列表会被外部改写（新增/改名后重渲染），
 * 受控值反而会把用户正在输入的内容顶掉。
 */
function GroupManager({
  open,
  groups,
  countOf,
  newName,
  onNewNameChange,
  onClose,
  onCreate,
  onRename,
}: {
  open: boolean;
  groups: Group[];
  countOf: (id: string) => number;
  newName: string;
  onNewNameChange: (v: string) => void;
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="关闭分类管理" onClick={onClose} className="scrim fixed inset-0 cursor-default" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="管理分类"
        className="panel relative z-10 w-full max-w-[24rem] p-5 shadow-pop animate-dialog-in"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">管理分类</h2>
            <p className="mt-1 text-2xs text-faint">
              改名后该类下的工具会自动跟着变，不用重新归类。名字里可以带 emoji。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-field p-1 text-faint transition-colors hover:bg-bg-2 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <ul className="mt-3.5 max-h-[15rem] space-y-2 overflow-y-auto overscroll-contain pr-0.5">
          {groups.map((g) => (
            <li key={g.id} className="flex items-center gap-2">
              <Input
                defaultValue={g.name}
                aria-label={`分类名称 ${g.name}`}
                className="min-w-0 flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (!next || next === g.name) return;
                  onRename(g.id, next);
                }}
              />
              <span className="num shrink-0 text-2xs text-faint">{countOf(g.id)}</span>
            </li>
          ))}
        </ul>

        <form
          className="mt-4 flex items-center gap-2 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            onCreate(name);
          }}
        >
          <Input
            value={newName}
            onChange={(e) => onNewNameChange(e.target.value)}
            placeholder="新分类名称"
            aria-label="新分类名称"
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="soft" disabled={!newName.trim()}>
            <Plus size={13} />
            新增
          </Button>
        </form>
      </div>
    </div>
  );
}
