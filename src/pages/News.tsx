import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpRight, ChevronDown, ChevronRight, RefreshCw, Search, Sparkles } from 'lucide-react';
import { api, type NewsDaily, type NewsHot, type NewsItem, type NewsNeighbor, type NewsReadTurn, type NewsTopic } from '@/lib/api';
import { cls, fmtDateTime, fmtRelative } from '@/lib/format';
import {
  Button,
  Card,
  Empty,
  Input,
  Modal,
  PageHead,
  Segmented,
  Select,
  SkeletonLines,
  Spinner,
} from '@/components/ui';
import { Tag } from '@/components/bits';
import { NewsReader } from '@/components/NewsReader';
import { runNewsRead } from '@/lib/news-read';
import { useStore } from '@/lib/store';

const PAGE = 40;

/* 实体标签是长尾的（几十种），默认只铺两行左右；
   超出部分给一个展开入口，而不是直接截掉 —— 截掉的那些在界面上就等于不存在。 */
const ENTITIES_COLLAPSED = 14;

/* 后端把「分类」放在 tags 的第一位，其余是实体标签（见 services/news.js）。
   这里用**集合判定**而不是靠位置读第一个 —— 位置是隐式约定，哪天上游调整了
   写入顺序，靠位置读会静默错位；集合判定最多是"新分类暂时归到实体行去"。
   代价是上游新增分类时要同步这一行。 */
const CATEGORY_LABELS = new Set(['模型', '产品', '行业', '论文', '实践']);

/* ── 「AI 读」的本地记录 ───────────────────────────────────────────────
   按条目 id 存三样：这次读出来的对话、是否已存进知识库、以及时间戳。

   存 localStorage 而不是只放内存：读一篇要抓一次原站再加一次长文调用，
   刷新一下就全没了太可惜。但**也不写进库** —— 热点会轮换，写库只会攒下
   一堆没人再看的残留；真正值得留的那几篇走「存进知识库」。

   榜单会一轮轮换，旧条目再也不会出现，所以写入时按时间淘汰一批。 */
const READ_LOG_KEY = 'workbench.news.readlog';
const READ_LOG_MAX = 40;

/** 批量读一次读几条。上限压在 10：每条要几十秒，再多人也不会等着 */
const BATCH_CHOICES = [3, 5, 10];

type ReadRecord = { turns: NewsReadTurn[]; savedId?: string; at: number };

function loadReadLog(): Record<string, ReadRecord> {
  try {
    const raw = window.localStorage.getItem(READ_LOG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ReadRecord>;
    /* 只信形状对的那几条：这份数据是我们自己写的，但它跨版本活着，
       早先的格式（比如当初直接存数组）不该让整页崩掉 */
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => Array.isArray(v?.turns)));
  } catch {
    /* 隐私模式下 localStorage 会直接抛，读不到就当作没读过 */
    return {};
  }
}

function saveReadLog(log: Record<string, ReadRecord>) {
  try {
    const kept = Object.entries(log)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, READ_LOG_MAX);
    window.localStorage.setItem(READ_LOG_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* 写不进去只影响"下次打开还在"，不该影响这一次阅读 */
  }
}

/** 取站点名，用来对上服务端那份"读不了的站点"名单 */
function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export default function News() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [hot, setHot] = useState<NewsHot | null>(null);
  const [daily, setDaily] = useState<NewsDaily | null>(null);
  /* 最近一次抓取里被分数门槛挡掉多少条。为 0 时不显示 ——
     精选模式下接口自己的下限就是 60，硬说一句"已筛掉 0 条"只是噪音 */
  const [dropped, setDropped] = useState(0);
  /* 点开看故事线的事件。用弹窗而不是就地展开：综述动辄上千字，
     还有最多十条报道时间线，塞进右栏会把整页撑变形 */
  const [openTopic, setOpenTopic] = useState<NewsTopic | null>(null);
  /* 「AI 读」：正在读哪一条，以及读过的记录（按条目 id 存）。
     记录存在这一层而不是弹窗内部，是为了关掉再打开还能看到上次的结果 ——
     否则每次点开都要重新抓一遍原站，再花一次模型的钱。 */
  const [reader, setReader] = useState<NewsItem | null>(null);
  const [readLog, setReadLog] = useState<Record<string, ReadRecord>>(() => loadReadLog());
  /* 读不了的站点。进页面取一次就够 —— 它是"最近失败过"的集合，不是实时状态 */
  const [badHosts, setBadHosts] = useState<Record<string, string>>({});
  /* 批量读：读几条、以及跑到哪了。batch 为 null = 没在跑 */
  const [batchN, setBatchN] = useState(5);
  const [batch, setBatch] = useState<{ done: number; total: number; title: string; stage: string | null } | null>(null);
  const batchAbort = useRef<AbortController | null>(null);
  const { notify } = useStore();
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(true);
  /* 实体标签有几十种，默认只铺两行；展开态是"这一页当前的视角"的一部分，
     但不进 URL —— 它跟筛选无关，发链接给别人时对方从收起态看起更合适 */
  const [allEntities, setAllEntities] = useState(false);

  /* 筛选条件放在 URL 而不是组件状态里：刷新不丢，也能把某个筛选结果发给别人。
     写回一律用 replace —— 筛选是"这一页当前的视角"，不该在浏览器历史里堆
     十几条，否则按后退键要按十几下才离得开这一页。 */
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') ?? 'all';
  const source = params.get('source') ?? 'all';
  const query = params.get('q') ?? '';
  const order: 'time' | 'score' = params.get('order') === 'score' ? 'score' : 'time';
  /* 「只看未读」进 URL，和别的筛选一致：刷新不丢，也能把"我还没读的"发给别人。
     这里读的是 AI 读的记录；读过不等于点开原文看过 —— 那个没有记录。 */
  const unread = params.get('unread') === '1';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  /* 换筛选条件就把"加载更多"归位：否则上一次翻到第 80 条，换个分类
     一看只有 3 条却还挂着旧进度，很莫名 */
  useEffect(() => {
    setLimit(PAGE);
  }, [tag, source, query, order, unread]);
  const [refreshing, setRefreshing] = useState(false);

  /* 读不了的站点名单。只在进页面和关掉「AI 读」之后取 ——
     读一次会更新这份名单（可能新增一个站点），而它平时不变，
     没必要跟着每次筛选、每次同步都重取一遍。 */
  async function loadBadHosts() {
    try {
      const res = await api.news.unreadable();
      setBadHosts(Object.fromEntries(res.hosts.map((h) => [h.host, h.error])));
    } catch {
      /* 拿不到就当没有这份名单：它只是个提前提示，不影响读 */
      setBadHosts({});
    }
  }

  /**
   * 一键读当前筛选下未读的前 N 条。
   *
   * **串行，不并行**：对面是同一个模型端点，同时压 N 个长上下文请求只会
   * 互相拖慢；而每条本身就要几十秒，用户要的是"过一会儿全好了"，
   * 不是"更早看到第一条"。
   *
   * 结果写进 readLog —— 和点开读走的是同一份记录。所以读完可以逐条翻看，
   * 中途停下来也不会丢掉已经读好的那几条。读的是 `ordered`（当前筛选与排序），
   * 于是"只看未读 + 按分数排"之后再批量读，读的正是最该读的那几条。
   */
  async function readBatch() {
    if (batch) return;
    const targets = ordered.filter((i) => !readLog[i.id] && i.link).slice(0, batchN);
    if (!targets.length) return;

    const controller = new AbortController();
    batchAbort.current = controller;
    setBatch({ done: 0, total: targets.length, title: targets[0].title, stage: null });

    let ok = 0;
    for (let i = 0; i < targets.length; i += 1) {
      if (controller.signal.aborted) break;
      const item = targets[i];
      setBatch({ done: i, total: targets.length, title: item.title, stage: null });

      let answer = '';
      try {
        answer = await runNewsRead(
          {
            url: item.link,
            /* 批量读也一样：优先让服务端去读 AIHOT 译好的中文全文 */
            zhUrl: item.aihotUrl ?? null,
            item: {
              title: item.title,
              source: item.source,
              summary: item.summary,
              reason: item.reason ?? null,
              publishedAt: item.publishedAt,
            },
            task: 'read',
          },
          {
            /* 批量读不在界面上逐字显示正文，只更新一行进度 ——
               所以这里除了 stage 之外都收下不用 */
            onStage: (s) => setBatch((b) => (b ? { ...b, stage: s } : b)),
            onMeta: () => {},
            onNote: () => {},
            onText: (t) => {
              answer = t;
            },
            onThink: () => {},
            onError: () => {},
          },
          controller.signal,
        );
        ok += 1;
      } catch (err) {
        if (/abort/i.test(String(err))) break;
        /* 单条失败不中断整批：读十条里有一条站点抓不动是常态，
           为它把其余九条也停下，等于让一条烂链接决定整批的命运 */
        answer = `读这篇时出错了：${err instanceof Error ? err.message : '未知原因'}`;
      }

      setReadLog((prev) => ({
        ...prev,
        [item.id]: {
          turns: [
            { role: 'user', text: '解读', task: 'read' },
            { role: 'ai', text: answer || '（没有返回内容）', task: 'read' },
          ],
          at: Date.now(),
        },
      }));
      setBatch((b) => (b ? { ...b, done: i + 1 } : b));
    }

    batchAbort.current = null;
    setBatch(null);
    if (ok) notify(`读完 ${ok} 条，点「已读」可以逐条回看`, 'ok');
  }

  async function load() {
    try {
      const res = await api.news.list();
      setItems(res.items);
      setHot(res.hot ?? null);
      setDaily(res.daily ?? null);
      setDropped(res.dropped ?? 0);
      setUpdatedAt(res.updatedAt);
      setLastError(res.lastError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    void loadBadHosts();
  }, []);

  /* 记录只在一次回答收尾时才写（不是每个 token），所以这里合并写入是安全的 */
  useEffect(() => {
    saveReadLog(readLog);
  }, [readLog]);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await api.news.refresh();
      setLastError(res.errors?.length ? res.errors.join('；') : null);
      await load();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  const sources = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((i) => map.set(i.source, (map.get(i.source) ?? 0) + 1));
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  /* 分类和实体标签分成两行：分类回答"这是什么"（就五六种，值得当主筛选），
     实体回答"涉及谁"（几十种，适合用标签墙而不是下拉）。 */
  const { categories, entities } = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((i) => (i.tags || []).forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    const all = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return {
      categories: all.filter(([t]) => CATEGORY_LABELS.has(t)),
      entities: all.filter(([t]) => !CATEGORY_LABELS.has(t)),
    };
  }, [items]);

  /** 没读过 AI 读的条数。一屏上百条时，"还剩多少没读"比"总共多少条"更有用 */
  const unreadCount = useMemo(() => items.filter((i) => !readLog[i.id]).length, [items, readLog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (source !== 'all' && i.source !== source) return false;
      if (tag !== 'all' && !(i.tags || []).includes(tag)) return false;
      if (unread && readLog[i.id]) return false;
      /* 标签也进搜索：实体标签本来就能点击筛选，但"想找某个词"时顺手敲进搜索框
         是更自然的动作，只搜正文会让它落空 */
      if (q) {
        const hay = `${i.title} ${i.summary} ${i.reason ?? ''} ${i.source} ${(i.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, source, tag, query, unread, readLog]);

  /* 按分数排时不做按天分组：日期会变得乱序，再按天切开反而更难读。
     score 为 null（上游还没评分）的条目排在后面，不是当 0 分。 */
  const ordered = useMemo(
    () => (order === 'score' ? [...filtered].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : filtered),
    [filtered, order],
  );
  const visible = ordered.slice(0, limit);

  /* 按天分组只在时间序下有意义 */
  const groups = useMemo(() => {
    if (order === 'score') return [{ key: 'score', label: '按分数排列', items: visible }];
    const map = new Map<string, NewsItem[]>();
    for (const it of visible) {
      const key = localDay(it.publishedAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(it);
      else map.set(key, [it]);
    }
    return [...map.entries()].map(([key, list]) => ({ key, label: dayLabel(key), items: list }));
  }, [visible, order]);

  const scopeLabel = items.length ? `${items.length} 条 · ${sources.length} 个来源` : '暂无数据';

  return (
    <div className="mx-auto w-full max-w-[1720px] space-y-4">
      <PageHead
        title="AI 热点"
        hint={
          updatedAt
            ? `数据来自 AIHOT，已按来源的模型评分筛过 · 上次同步 ${fmtRelative(updatedAt)} · ${scopeLabel}`
            : '还没有同步过，点右侧按钮立刻拉取一次'
        }
        actions={
          <Button variant="soft" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RefreshCw size={13} />}
            {refreshing ? '同步中' : '立即同步'}
          </Button>
        }
      />

      {/* 工具条刻意不装进卡片：这一页的主体是一条长列表，工具条再包一层白卡
          会把它抬到和内容同级，反而看不出"这些控件是管下面这张表的"。 */}
      <div className="space-y-2.5 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[13rem] flex-1">
            <Search size={13} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setParam('q', e.target.value)}
              placeholder="搜索标题、摘要、推荐理由或标签"
              aria-label="搜索热点"
              className="pl-8"
            />
          </div>
          <Segmented
            value={order}
            onChange={(v) => setParam('order', v)}
            size="sm"
            options={[
              { value: 'time', label: '按时间' },
              { value: 'score', label: '按分数' },
            ]}
          />
          <Select
            value={source}
            onChange={(e) => setParam('source', e.target.value)}
            aria-label="按来源筛选"
            className="w-auto text-2xs"
          >
            <option value="all">全部来源（{sources.length}）</option>
            {sources.map(([name, count]) => (
              <option key={name} value={name}>
                {name}（{count}）
              </option>
            ))}
          </Select>
          {/* 一屏上百条时，真正要想的是"哪些我还没读"。
              这里算的是「还没让 AI 读过」—— 不等于没点开过原文，后者没有记录 */}
          <Tag active={unread} onClick={() => setParam('unread', unread ? '' : '1')}>
            未读 {unreadCount}
          </Tag>
          {/* 批量读：一屏上百条时，一条条点开是不现实的。
              条数单独一个下拉，免得把 N 写死在按钮文案里 */}
          <Select
            value={String(batchN)}
            onChange={(e) => setBatchN(Number(e.target.value))}
            aria-label="批量读几条"
            className="w-auto text-2xs"
          >
            {BATCH_CHOICES.map((n) => (
              <option key={n} value={n}>
                前 {n} 条
              </option>
            ))}
          </Select>
          {batch ? (
            <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
              <Spinner />
              <span className="num shrink-0">
                {batch.done}/{batch.total}
              </span>
              <span className="max-w-[18rem] truncate" title={batch.title}>
                {batch.stage ?? batch.title}
              </span>
              <button
                type="button"
                onClick={() => batchAbort.current?.abort()}
                className="shrink-0 font-medium text-accent transition-opacity hover:opacity-80"
              >
                停止
              </button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={!unreadCount}
              onClick={() => void readBatch()}
              /* 成本按实测写：读一篇要把正文塞进 prompt，一次约 5 万 tokens ——
                 比一次普通助手问答（约 1.5 万）贵三倍多。这个数不写清楚，
                 批量读就是在替用户花钱。 */
              title={`串行读 ${batchN} 条未读：每条约 30~60 秒（合计约 ${Math.ceil(batchN / 2)}~${batchN} 分钟）、约 5 万 tokens。中途可以停。`}
            >
              <Sparkles size={13} aria-hidden />
              批量解读
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-2xs text-faint">分类</span>
          <Tag active={tag === 'all'} onClick={() => setParam('tag', 'all')}>
            全部 {filtered.length === items.length ? items.length : `${filtered.length}/${items.length}`}
          </Tag>
          {categories.map(([name, count]) => (
            <Tag key={name} active={tag === name} onClick={() => setParam('tag', name)}>
              {name} {count}
            </Tag>
          ))}
        </div>

        {entities.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-2xs text-faint">涉及</span>
            {(allEntities ? entities : entities.slice(0, ENTITIES_COLLAPSED)).map(([name, count]) => (
              <Tag key={name} active={tag === name} onClick={() => setParam('tag', name)}>
                {name} {count}
              </Tag>
            ))}
            {entities.length > ENTITIES_COLLAPSED ? (
              <button
                type="button"
                onClick={() => setAllEntities((v) => !v)}
                className="inline-flex items-center gap-1 text-2xs font-medium text-muted transition-colors hover:text-ink"
              >
                {allEntities ? '收起' : `还有 ${entities.length - ENTITIES_COLLAPSED} 个`}
                <ChevronDown size={12} aria-hidden className={cls('transition-transform', allEntities && 'rotate-180')} />
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 分数是这一页唯一"算出来的数"，必须在某处说明它是什么 ——
            否则左列那一排数字对读者就是一堆不明所以的编号。
            被门槛筛掉多少条只在真的筛掉时才说：精选模式下接口自己
            的下限就是 60，这个数通常是 0，硬显示一句"筛掉 0 条"是噪音。 */}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-faint">
          <span className="rounded-full bg-bg-2 px-1.5 py-0.5">左列分数</span>
          <span>来源侧的模型评分（0–100），越高越值得看</span>
          {dropped > 0 ? <span className="text-muted">· 另有 {dropped} 条因低于门槛未入库</span> : null}
        </p>

        {lastError ? (
          <p className="rounded-field border border-warn/35 px-2.5 py-1.5 text-2xs leading-relaxed text-warn">
            上次抓取没成功：{lastError}。下面仍是上一批已抓到的内容，不会因为一次失败就清空。
          </p>
        ) : null}
      </div>

      {/* 日报是"今天到底发生了什么"的归好类的版本，和条目流互补。
          整幅宽放在最上面，默认折叠：它一展开就是好几屏，
          撑开的话条目流就被推到看不见的地方了。 */}
      <DailyReport daily={daily} loading={loading} />

      {/* 宽屏：左栏条目流、右栏热点榜。窄屏塌成一列时热点榜落在条目流下面 ——
          DOM 顺序把它放在主内容之后，堆叠时才不会把主内容顶下去。 */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <div className="min-w-0">
          {loading ? (
            /* 骨架照真实行摆：一行一条，形状对得上，数据到位时高度不跳 */
            <Card flush role="status" aria-busy="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="border-b border-line px-5 py-4 last:border-b-0">
                  <SkeletonLines lines={2} />
                </div>
              ))}
              <span className="sr-only">正在加载热点…</span>
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <Empty
                title={items.length ? '没有匹配的条目' : '还没有热点数据'}
                hint={
                  items.length
                    ? '换个分类、来源，或清空搜索。'
                    : '点「立即同步」抓取一次；抓取失败或断网时会保留上一批缓存内容。'
                }
                action={
                  <Button variant="primary" size="sm" onClick={() => void refresh()}>
                    <RefreshCw size={13} />
                    立即同步
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              {/* 整条列表装在一个面板里，行之间用发丝线分 —— 一屏十几条各自一张白卡的话，
                  卡片之间的空隙会把"这是一条流"这件事切碎 */}
              <Card flush className="overflow-hidden">
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    <div className="flex items-baseline gap-2.5 border-b border-line bg-bg-2/70 px-5 py-2">
                      <span className="num text-2xs font-medium text-ink">{group.label}</span>
                      <span className="num text-2xs text-faint">{group.items.length} 条</span>
                    </div>
                    {group.items.map((item) => (
                      <NewsRow
                        key={item.id}
                        item={item}
                        read={Boolean(readLog[item.id])}
                        saved={Boolean(readLog[item.id]?.savedId)}
                        badHost={badHosts[hostOf(item.link)]}
                        onRead={() => setReader(item)}
                      />
                    ))}
                  </Fragment>
                ))}
              </Card>

              {filtered.length > visible.length ? (
                <div className="flex justify-center">
                  <Button variant="soft" size="sm" onClick={() => setLimit((v) => v + PAGE)}>
                    加载更多（还有 {filtered.length - visible.length} 条）
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <HotBoard hot={hot} onPick={setOpenTopic} />
      </div>

      <StoryModal topic={openTopic} onClose={() => setOpenTopic(null)} />

      {/* 条件渲染而不是给弹窗一个 open 属性：读一篇是要花钱的（抓原站 + 调模型），
          组件一旦挂着就会自动开读，不能让它留在 DOM 里等 */}
      {reader ? (
        <NewsReader
          key={reader.id}
          item={reader}
          initialTurns={readLog[reader.id]?.turns ?? []}
          savedId={readLog[reader.id]?.savedId}
          knownBad={badHosts[hostOf(reader.link)]}
          onDone={(turns) => setReadLog((prev) => ({ ...prev, [reader.id]: { ...prev[reader.id], turns, at: Date.now() } }))}
          onSaved={(id) =>
            setReadLog((prev) => ({ ...prev, [reader.id]: { ...prev[reader.id], savedId: id, at: Date.now() } }))
          }
          onClose={() => {
            setReader(null);
            /* 关掉时刷新一次名单：刚才那一次读可能又标出了一个读不了的站点 */
            void loadBadHosts();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 一条热点。布局是一行"读数 + 正文"：
 * 左边固定一列放分数，右边是标题、摘要、推荐理由、元信息。
 * 分数用等宽数字并排成一列，扫读时能像看仪表那样竖着比，
 * 而它是这一页唯一"算出来的数"，也是来源侧筛过一遍的证据。
 */
function NewsRow({
  item,
  read,
  saved,
  badHost,
  onRead,
}: {
  item: NewsItem;
  read: boolean;
  /** 已经存进知识库。它必然也读过，所以下面那个词优先显示"已存" */
  saved: boolean;
  /** 这个站点上次读不了时的原因。有值就在按钮上提前说明 */
  badHost?: string;
  onRead: () => void;
}) {
  const tags = item.tags || [];
  const category = tags.find((t) => CATEGORY_LABELS.has(t));
  const entities = tags.filter((t) => !CATEGORY_LABELS.has(t)).slice(0, 3);
  const score = item.score ?? null;

  /* 三种状态用三个词，别让用户去猜配色：
     已存（读过了，而且留下来了）/ 已读（读过了）/ AI 读（还没读）。
     站点已知读不了时先标黄，省掉一次注定失败、还要白等十几秒的点击。 */
  const pill = read
    ? 'bg-accent-soft text-accent'
    : badHost
      ? 'bg-bg-2 text-warn hover:bg-accent-soft hover:text-accent'
      : 'bg-bg-2 text-muted hover:bg-accent-soft hover:text-accent';
  const hint = saved
    ? '已存进知识库；点开可以接着追问'
    : badHost
      ? `这个站点上次读不了：${badHost}。会跳过抓取，直接按摘要讲`
      : '让 AI 抓取原文并用中文讲一遍；原文不是中文会一并翻译';

  return (
    <div
      /* 两列栅格：左列固定放分数，右列是正文。
         窄屏塌成一列时 DOM 顺序直接生效 —— 所以分数写在最前面，
         于是手机上读起来是"79 → 标题 → 摘要"，仍然通顺；
         若把分数写在标题之后，窄屏上它会插到标题和摘要中间。

         整行不再包成 <a>：行内还要放一条指向 AIHOT 页面的链接，
         而 <a> 里不能再嵌 <a>。改由标题的链接"拉伸"覆盖整行（见下）。 */
      className="group relative grid gap-x-5 gap-y-1.5 border-b border-line px-5 py-4 transition-colors last:border-b-0 hover:bg-panel-2 sm:grid-cols-[3.25rem_minmax(0,1fr)]"
    >
      {/* 分数：等宽数字 + 一条 3px 刻度。只有数字的话得逐个读才能比出高低，
          刻度让"79 和 65 差多少"在同一列里一眼看出来。
          跨两行（row-span-2）并带一条右边线：于是每行那一小段线会连成
          贯通整页的一条竖线，左列就读成仪表的"读数槽"而不是几行数字。
          行与行之间本来就有横线，竖线穿过它们，整块看着像一张表。 */}
      <div className="flex items-center gap-2.5 sm:col-start-1 sm:row-span-2 sm:row-start-1 sm:flex-col sm:items-start sm:gap-1.5 sm:border-r sm:border-line">
        <span className="num text-[15px] font-semibold leading-none text-ink">
          {/* 光秃秃一个"79"读屏听不出是什么，补一句标签 */}
          <span className="sr-only">评分 </span>
          {score == null ? '—' : score}
        </span>
        {score == null ? null : (
          <span aria-hidden className="block h-[3px] w-10 overflow-hidden rounded-full bg-bg-3">
            <span className="block h-full rounded-full bg-accent/70" style={{ width: `${score}%` }} />
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5 sm:col-start-2 sm:row-start-1">
        {category ? (
          <span className="shrink-0 rounded-full bg-bg-2 px-2 py-0.5 text-2xs text-muted">{category}</span>
        ) : null}
        <h2 className="min-w-0 text-[14.5px] font-semibold leading-snug tracking-tight">
          {/* "拉伸链接"：伪元素铺满整行，于是点哪儿都进原文，
              但 <a> 只包住文字，行内还能再放别的链接。
              after:content-[''] 必须写 —— 伪元素不设 content 根本不渲染。 */}
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer noopener"
            className="after:absolute after:inset-0 after:content-[''] group-hover:text-accent"
          >
            {item.title}
          </a>
        </h2>
      </div>

      <div className="sm:col-start-2 sm:row-start-2">
        {item.summary ? (
          <p className="line-clamp-2 text-xs leading-relaxed text-muted">{item.summary}</p>
        ) : null}

        {/* 推荐理由：来源写的"为什么值得看"，是这一页信息量最大的一句。
            刻意压成一档更小更淡的字，并限两行 —— 129 条都带这句，
            给它和摘要同等的视觉重量，整页就没有主次了。 */}
        {item.reason ? (
          <p className="mt-1.5 line-clamp-2 text-2xs leading-relaxed text-faint">
            <span className="text-muted">推荐理由　</span>
            {item.reason}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-faint">
          {/* 发表时间一律给"年月日 + 时刻"。按分数排时分组头是"按分数排列"，
              本来就只能靠这里看日期；按时间排时分组头已写了日期，行里再跟一遍
              确有重复 —— 但"一眼读到"比"少写几个字"更值，两种排法统一。 */}
          <span className="num">{fmtFullDateTime(item.publishedAt)}</span>
          <span aria-hidden className="text-line-strong/40">·</span>
          <span className="truncate">{item.source}</span>
          {entities.map((t) => (
            <span key={t} className="rounded-full bg-bg-2 px-1.5 py-0.5">
              {t}
            </span>
          ))}
          {/* 来源侧那一页。既标明出处（数据来自第三方），
              也给出"看完整上下文"的去处。要压在拉伸链接之上，否则点不到。 */}
          {item.aihotUrl ? (
            <a
              href={item.aihotUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="relative z-10 underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
            >
              AIHOT
            </a>
          ) : null}
          {/* 右下角这一组。整行被标题的拉伸链接盖着，所以里面的可点元素
              都要自己抬到它上面（relative z-10），否则点不到 */}
          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            {/* 上游偶尔不给 link，那时没有原文可抓，按钮就不该出现 —— 
                点了只会得到一句"没有可读的原文地址" */}
            {item.link ? (
              <button
                type="button"
                onClick={onRead}
                aria-label={`AI 读：${item.title}`}
                title={hint}
                className={cls(
                  'relative z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium transition-colors',
                  pill,
                )}
              >
                <Sparkles size={11} aria-hidden />
                {read ? (saved ? '已存' : '已读') : 'AI 读'}
              </button>
            ) : null}
            <ArrowUpRight size={12} aria-hidden className="text-faint transition-colors group-hover:text-accent" />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── 日期 ──────────────────────────────────────────────────────────────
   自己拼 YYYY-MM-DD，不用 toLocaleDateString 的某个区域格式：
   后者依赖运行环境的区域数据，格式一旦不同，分组键就会悄悄错开。 */

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/* 行内的发表时间：年月日 + 时刻。
   用相对时间（"1 天前"）不行 —— 分组头已经交代了是哪一天，行里真正需要的是
   "几点几分"，相对时间反而说不出这个。手拼日期而不是 toLocaleString，
   理由同分组键：不依赖运行环境的区域格式，位数不会随 locale 变。 */
function fmtFullDateTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function localDay(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayLabel(day: string) {
  const today = localDay(new Date().toISOString());
  const yesterday = localDay(new Date(Date.now() - 86_400_000).toISOString());
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00`).getDay()];
  if (day === today) return `今天 · ${weekday}`;
  if (day === yesterday) return `昨天 · ${weekday}`;
  return `${day} · ${weekday}`;
}

/**
 * 每日日报：来源每天 08:00 出一期，已经把当天发生的事分好类。
 * 它和条目流互补 —— 流适合翻，日报适合回答"今天到底发生了什么"。
 *
 * 默认折叠：一期展开就是好几屏，撑开的话下面的条目流会被推到看不见的地方。
 * 折叠时露出头条标题和条数，让人能判断值不值得展开。
 */
/* 折叠状态与"看过的期号"存本地 —— 想要的是"昨天拉开看过，今天回来还是拉开的"，
   而"今天出了新一期"只需要提示一次。都走 localStorage；隐私模式下它可能直接抛，
   所以读写都兜一层：读不到就退回默认（折叠 / 不标新），不因为存储不可用而崩。 */
const DAILY_OPEN_KEY = 'workbench.news.daily.open';
const DAILY_SEEN_KEY = 'workbench.news.daily.seen';

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 记不住偏好不影响阅读，忽略 */
  }
}

/* 来源每天 08:00 出一期，所以手上这份只要超过一天多就多半是"新一期没抓到"。
   定 26 小时而不是 24：给定时抓取与 08:00 之间留出余量，
   否则每天 08:00 前后会反复闪这句提示，反而成了噪音。 */
const DAILY_STALE_MS = 26 * 3600 * 1000;

function DailyReport({ daily, loading }: { daily: NewsDaily | null; loading: boolean }) {
  const [open, setOpen] = useState(() => readStore(DAILY_OPEN_KEY) === '1');
  const [seen, setSeen] = useState<string | null>(() => readStore(DAILY_SEEN_KEY));
  const r = daily?.report;

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      writeStore(DAILY_OPEN_KEY, next ? '1' : '0');
      /* 展开就算"看过这一期"。新标记的职责是提示一次，不是常驻角标 */
      if (next && r?.date) {
        writeStore(DAILY_SEEN_KEY, r.date);
        setSeen(r.date);
      }
      return next;
    });
  };

  /* 首屏 daily 是异步来的：先摆一条等高的骨架，
     否则整页会在数据到达时往下跳一下（日报整幅宽，跳得很明显） */
  if (loading) {
    return (
      <Card flush role="status" aria-busy="true">
        <div className="px-5 py-3.5">
          <SkeletonLines lines={1} />
          <span className="sr-only">正在加载日报…</span>
        </div>
      </Card>
    );
  }

  /* 一期都没有：抓失败过就必须说出来，否则这块看起来像"功能不存在"；
     没失败过（例如当天还没到 08:00）则整块不渲染 */
  if (!r) {
    if (!daily?.lastError) return null;
    return (
      <Card flush className="overflow-hidden">
        <p className="px-5 py-3 text-2xs leading-relaxed text-warn">日报还没抓到：{daily.lastError}</p>
      </Card>
    );
  }

  const bodyCount = r.sections.reduce((n, s) => n + s.items.length, 0);
  /* 上游偶尔会发一期"今天没事"的空日报（有 lead，但 0 分区 0 快讯）。
     这时写"0 条正文 · 0 条快讯"和抓挂了是一个样子，看的人只会以为坏了 ——
     明明没失败就必须说清楚是"上游这期没收录"，不是我们没抓到 */
  const emptyIssue = bodyCount === 0 && r.flashes.length === 0 && !daily?.lastError;
  const isNew = Boolean(r.date && seen !== r.date);
  const syncedAt = daily?.updatedAt ? fmtRelative(daily.updatedAt) : null;
  /* 判"过期"要看**期号自己的出刊时间**，不是我们的同步时间：
     上游迟迟不发新一期时，我们照样每轮都能成功同步（内容一模一样），
     同步时间永远是新的 —— 拿它当依据，这个提示在最需要它的时候反而不响。
     generatedAt 缺失（老快照）才退回同步时间。 */
  const issuedAt = r.generatedAt ?? daily?.updatedAt ?? null;
  const stale = issuedAt ? Date.now() - new Date(issuedAt).getTime() > DAILY_STALE_MS : false;

  return (
    <Card flush className="overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? 'daily-report-body' : undefined}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-panel-2"
      >
        <span className="num shrink-0 text-2xs text-faint">{r.date ?? '—'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{r.lead?.title ?? '今日日报'}</span>
            {isNew ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-2xs font-medium text-accent">
                新
              </span>
            ) : null}
          </span>
          {/* 折叠态也要能判断"这份是不是今早那期"：期号之外再给同步时间，
              超过一天多没换新就直说，别让人把旧一期当成今天的 */}
          <span className="num mt-0.5 block text-2xs text-faint">
            {emptyIssue ? '这一期上游没有收录任何条目' : `${bodyCount} 条正文 · ${r.flashes.length} 条快讯`}
            {syncedAt ? ` · 同步于${syncedAt}` : ''}
            {stale ? <span className="text-warn"> · 可能已过期，新一期未抓到</span> : null}
          </span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className={cls('shrink-0 text-faint transition-transform', open && 'rotate-180')}
        />
      </button>

      {/* 手上有旧一期、新一轮又抓挂了：折叠态也要看得见，不然旧内容会被当成最新的 */}
      {daily?.lastError ? (
        <p className="border-t border-line px-5 py-2 text-2xs leading-relaxed text-warn">
          最近一次抓取日报失败：{daily.lastError}
        </p>
      ) : null}

      {open ? (
        <div id="daily-report-body" className="border-t border-line px-5 py-4">
          {/* 一期日报覆盖的是一段时间，不是"此刻"。写出来才解释得通
              下面快讯为什么会跨天，也才对得上它每天 08:00 出刊的节奏 */}
          {r.windowStart && r.windowEnd ? (
            <p className="mb-3 text-2xs text-faint">
              覆盖 {fmtDateTime(r.windowStart)} → {fmtDateTime(r.windowEnd)}
              {r.generatedAt ? ` · 生成于 ${fmtDateTime(r.generatedAt)}` : ''}
            </p>
          ) : null}

          {r.lead ? (
            <div className="mb-4">
              <p className="text-[14.5px] font-semibold leading-snug text-ink">{r.lead.title}</p>
              {r.lead.paragraph ? <p className="mt-1.5 text-xs leading-relaxed text-muted">{r.lead.paragraph}</p> : null}
            </div>
          ) : null}

          {r.sections.map((s) => (
            <div key={s.label} className="mb-4">
              <p className="mb-1.5 text-2xs font-medium text-muted">{s.label}</p>
              <ul className="divide-y divide-line">
                {s.items.map((it, i) => (
                  <li key={`${it.link}-${i}`} className="py-2">
                    {it.link ? (
                      <a
                        href={it.link}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[13px] font-medium leading-snug text-ink hover:text-accent"
                      >
                        {it.title}
                      </a>
                    ) : (
                      <p className="text-[13px] font-medium leading-snug text-ink">{it.title}</p>
                    )}
                    {it.summary ? <p className="mt-1 text-xs leading-relaxed text-muted">{it.summary}</p> : null}
                    <p className="num mt-1 text-2xs text-faint">{it.source}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {r.flashes.length ? (
            <div className="mb-4">
              <p className="mb-1.5 text-2xs font-medium text-muted">快讯</p>
              <ul className="space-y-1.5">
                {r.flashes.map((f, i) => (
                  <li key={`${f.link}-${i}`} className="flex gap-2 text-2xs">
                    {/* 快讯跨好几天，只给时刻会说不清是哪天，所以这里用相对时间 */}
                    <span className="num shrink-0 text-faint">{fmtRelative(f.publishedAt)}</span>
                    <span className="min-w-0 flex-1 text-muted">{f.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {r.link ? (
            <a
              href={r.link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-2xs text-accent hover:opacity-80"
            >
              在 AIHOT 上看这一期
              <ArrowUpRight size={12} aria-hidden />
            </a>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * 多源热点榜。视角和左边那条流不是一回事 ——
 * 流回答"最近有什么"，榜回答"现在哪些事最热"（按报道家数与信号数排）。
 */
function HotBoard({ hot, onPick }: { hot: NewsHot | null; onPick: (topic: NewsTopic) => void }) {
  const topics = hot?.topics ?? [];

  return (
    <Card flush className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[13px] font-semibold">多源热点榜</p>
        <p className="mt-1 text-2xs leading-relaxed text-faint">
          {hot?.updatedAt ? `按报道家数与信号数排 · 同步于 ${fmtRelative(hot.updatedAt)}` : '还没抓过榜，点「立即同步」拿一次'}
        </p>
      </div>

      {topics.length === 0 ? (
        <p className="px-4 py-5 text-2xs leading-relaxed text-faint">
          {hot?.lastError ? `榜没抓到：${hot.lastError}` : '暂时没有榜。'}
        </p>
      ) : (
        <ol>
          {topics.map((t) => (
            <li key={t.publicId ?? String(t.rank)} className="border-b border-line last:border-b-0">
              {/* 就算这条没有事件线也让它点得动 —— 弹窗里会给出原文链接。
                 一个"点了没反应"的按钮比什么都没有更让人困惑 */}
              <button
                type="button"
                onClick={() => onPick(t)}
                className="group flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-panel-2"
              >
                <span className="num mt-px w-4 shrink-0 text-2xs font-medium text-faint">
                  {String(t.rank).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-snug text-ink group-hover:text-accent">{t.title}</span>
                  <span className="num mt-1 block text-2xs text-faint">
                    {t.sourceCount} 家 · {t.signalCount} 信号{t.story ? ` · ${t.story.reports.length} 条报道` : ''}
                    {/* 家数是个抽象的数，最新报道的时间才是"这事还在动"的凭据 */}
                    {t.latestAt ? ` · 最新报道 ${fmtRelative(t.latestAt)}` : ''}
                  </span>
                  {/* 来源名是"多源"这个说法唯一的证据 —— 只报家数等于让人相信一个数字。
                      窄栏里铺不下全部，截三家 + "等 N 家"，完整名单放 title */}
                  {t.sourceNames.length ? (
                    <span className="mt-0.5 block truncate text-2xs text-faint" title={t.sourceNames.join('、')}>
                      {t.sourceNames.slice(0, 3).join('、')}
                      {t.sourceNames.length > 3 ? ` 等 ${t.sourceNames.length} 家` : ''}
                    </span>
                  ) : null}
                </span>
                <ChevronRight
                  size={13}
                  aria-hidden
                  className="mt-px shrink-0 text-line-strong/50 transition-colors group-hover:text-accent"
                />
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** 邻居事件列表：同一故事线上的其它事件 / 相关事件 */
function NeighborList({ label, items }: { label: string; items: NewsNeighbor[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 text-2xs font-medium text-muted">{label}</p>
      <ul className="divide-y divide-line">
        {items.map((n, i) => (
          <li key={`${n.publicId ?? n.title}-${i}`} className="flex items-baseline gap-2 py-1.5 text-2xs">
            <span className="shrink-0 text-faint">{n.relation || '关联'}</span>
            {n.link ? (
              <a
                href={n.link}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 text-ink hover:text-accent"
              >
                {n.title}
              </a>
            ) : (
              <span className="min-w-0 flex-1 text-ink">{n.title}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 事件详情：AI 综述 + 跨源报道时间线。
 *
 * 综述是**随事件推进增量重写**的（并把与早期报道矛盾之处写出来），
 * 所以必须标出"更新于" —— 不标的话读者会以为它是某一刻的定论。
 */
function StoryModal({ topic, onClose }: { topic: NewsTopic | null; onClose: () => void }) {
  const story = topic?.story ?? null;

  return (
    <Modal
      open={Boolean(topic)}
      onClose={onClose}
      title={topic?.title ?? ''}
      width="max-w-2xl"
      footer={
        topic && (topic.storyUrl || topic.link) ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* 事件页与原文是两种去处：前者是 AIHOT 把这件事串起来的整个事件，
                后者只是榜上那一条报道。有事件页就先给它 */}
            {topic.storyUrl ? (
              <a
                href={topic.storyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-2xs text-accent hover:opacity-80"
              >
                在 AIHOT 看该事件
                <ArrowUpRight size={12} aria-hidden />
              </a>
            ) : null}
            {topic.link ? (
              <a
                href={topic.link}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-2xs text-accent hover:opacity-80"
              >
                查看报道原文
                <ArrowUpRight size={12} aria-hidden />
              </a>
            ) : null}
          </div>
        ) : null
      }
    >
      {!topic ? null : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
            {story ? (
              <>
                <span className="num">
                  {story.sourceCount} 家报道 · {story.reportCount} 条
                </span>
                <span className="rounded-full bg-bg-2 px-1.5 py-0.5">
                  {story.status === 'settled' ? '已平息' : '仍在发展'}
                </span>
                {story.firstReportAt ? <span className="num">首报 {fmtRelative(story.firstReportAt)}</span> : null}
              </>
            ) : (
              <span className="num">
                {topic.sourceCount} 家 · {topic.signalCount} 信号
              </span>
            )}
          </div>

          {/* 最新进展：综述是隔一阵重写一次的，这一行是最近一次采集到的状态，
              比综述更新鲜，所以排在它前面 */}
          {story?.latest ? (
            <div className="rounded-field bg-bg-2 px-3 py-2.5">
              <p className="mb-1 text-2xs font-medium text-muted">最新进展</p>
              <p className="text-[13px] leading-relaxed text-ink">{story.latest}</p>
            </div>
          ) : null}

          {story?.digest ? (
            <div>
              <p className="mb-1.5 text-2xs font-medium text-muted">事件综述</p>
              <p className="text-[13px] leading-relaxed text-ink">{story.digest}</p>
              {story.digestUpdatedAt ? (
                <p className="num mt-1.5 text-2xs text-faint">
                  更新于 {fmtRelative(story.digestUpdatedAt)}；会随事件推进重写，并标注与早期报道矛盾之处
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-2xs leading-relaxed text-faint">这条榜暂时没有事件线。可以看左下角那条原文。</p>
          )}

          {story && story.reports.length ? (
            <div>
              <p className="mb-1 text-2xs font-medium text-muted">报道时间线（{story.reports.length}）</p>
              <ol className="divide-y divide-line">
                {story.reports.map((r, i) => (
                  <li key={`${r.link}-${i}`} className="py-2.5">
                    <div className="flex items-baseline gap-2 text-2xs text-faint">
                      <span className="num">{r.publishedAt ? fmtRelative(r.publishedAt) : '—'}</span>
                      <span aria-hidden>·</span>
                      <span className="truncate">{r.source}</span>
                    </div>
                    {r.link ? (
                      <a
                        href={r.link}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-1 block text-[13px] font-medium leading-snug text-ink hover:text-accent"
                      >
                        {r.title}
                      </a>
                    ) : (
                      <p className="mt-1 text-[13px] font-medium leading-snug text-ink">{r.title}</p>
                    )}
                    {r.summary ? <p className="mt-1 text-xs leading-relaxed text-muted">{r.summary}</p> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {/* 同故事线 / 相关事件。接口常常给空数组（事件还没被串起来），
              有就显示 —— 这让弹窗从"一个事件的综述"变成"这条线索的前后文"。
              实测 10 条榜单里通常有 1 条带得上。 */}
          {story && (story.storyline.length || story.related.length) ? (
            <div className="space-y-3">
              <NeighborList label="同故事线" items={story.storyline} />
              <NeighborList label="相关事件" items={story.related} />
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
