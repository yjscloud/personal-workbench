import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CloudUpload, Database, Download, HardDriveDownload, History, ImageIcon, KeyRound, Leaf, Palette, Plug, Plus, RefreshCcw, Save, Search, Sun, Moon, Trash2, Upload, User, Zap } from 'lucide-react';
import {
  api,
  type HaEntityOption,
  type HaOptions,
  type HaSocket,
  type LoginBackground,
  type SearchEngine,
  type Settings as SettingsShape,
} from '@/lib/api';
import { useStore } from '@/lib/store';
import { switchTheme, type AccentName, type ThemeMode } from '@/lib/theme';
import { cls, fmtBytes, fmtEnergy, fmtRelative } from '@/lib/format';
import { applyBackground } from '@/lib/background';
import { Badge, Button, buttonClass, Card, CardHead, Field, Input, Led, PageHead, Segmented, Select, SkeletonCard, Spinner, Toggle } from '@/components/ui';
import { DragHandle, DropMarker, MoveButtons, orderById, useRowReorder, type RowReorder } from '@/components/reorder';

/* swatch 用主题感知的令牌，浅色/深色下都显示该强调色在当前主题的实际取值 */
const ACCENTS: { value: AccentName; label: string; swatch: string }[] = [
  { value: 'azure', label: '科技蓝', swatch: 'var(--accent-azure)' },
  { value: 'signal', label: '冷青', swatch: 'var(--accent-signal)' },
  { value: 'copper', label: '铜琥珀', swatch: 'var(--accent-copper)' },
  { value: 'violet', label: '紫罗兰', swatch: 'var(--accent-violet)' },
];

/**
 * 备份对象键 → 人看的时间。两种命名都要认：
 *   knowledge-2026-10-05.json.gz             每天一份的
 *   pre-restore-2026-10-05T03-30-12.json.gz  恢复前自动留的
 * 优先用键名里的时间而不是服务端的 lastModified：探测模式下拿不到后者，
 * 而键名里本来就写着（那也是它按日期命名的原因之一）。
 */
function keyStamp(key: string) {
  const m = /(\d{4}-\d{2}-\d{2})(?:T(\d{2})-(\d{2}))?/.exec(key);
  if (!m) return key;
  return m[2] ? `${m[1]} ${m[2]}:${m[3]}` : m[1];
}

/* 新建搜索引擎行的 id（保存时服务端原样留着，之后就是它的稳定引用）。
   带一个自增序号：同一毫秒里连点两次「添加引擎」也不会撞 key。 */
let engineSeq = 0;
const newEngineId = () => `se_new_${Date.now().toString(36)}_${(engineSeq += 1)}`;

export default function Settings() {
  const { settings, saveSettings, notify, refreshAll } = useStore();
  const [draft, setDraft] = useState<SettingsShape | null>(null);
  const [health, setHealth] = useState<{
    db: { label?: string; host?: string; database?: string; reachable?: boolean };
    pveConfigured: boolean;
    haConfigured: boolean;
    assistantEngine: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [haTesting, setHaTesting] = useState(false);
  const [haTestResult, setHaTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  // HA 里的候选实体：用来把「手填实体 ID」换成「下拉选一选」
  const [haOptions, setHaOptions] = useState<HaOptions | null>(null);
  const [haOptionsLoading, setHaOptionsLoading] = useState(false);
  const [haOptionsError, setHaOptionsError] = useState<string | null>(null);
  // 正在保存的分区名，用来只给那一个按钮转圈
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [bgUploading, setBgUploading] = useState(false);
  const [loginBgUploading, setLoginBgUploading] = useState(false);
  /* 两处密钥（PVE 令牌 / COS SecretKey）：空 = 不改动。见各自的保存函数 */
  const [newPveSecret, setNewPveSecret] = useState('');
  const [newSecretKey, setNewSecretKey] = useState('');
  const [backupBusy, setBackupBusy] = useState<'run' | 'test' | 'list' | 'restore' | null>(null);
  const [backupResult, setBackupResult] = useState<{ ok: boolean; text: string } | null>(null);
  /* 云上那份清单。不自动拉：打开这一页多数时候只是看看状态，
     而列一次桶要打一趟网络（还可能因为没有 ListBucket 权限而回落探测） */
  const [backups, setBackups] = useState<{
    mode: 'list' | 'probe';
    days: number;
    items: { key: string; size: number; lastModified: string }[];
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);
  const loginBgFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (settings) setDraft((prev) => prev ?? structuredClone(settings));
  }, [settings]);

  // 拿到草稿后自动拉一次候选实体，省得用户还要先点一下
  useEffect(() => {
    if (settings?.ha?.hasToken) void loadHaOptions();
    // 只在"令牌是否可用"这个状态变化时拉，输入过程中不该反复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.ha?.hasToken]);

  /* 搜索引擎的排序交互：和工具箱的分组排序共用 components/reorder.tsx 那一份。
     hook 必须声明在 early return 之前（下面那个"草稿还没到"的分支），
     那一帧根本不渲染列表，所以传空数组占位不影响任何东西 ——
     真正要排序时 prev 一定已经在了。 */
  const engineSort = useRowReorder(
    (draft?.search?.engines ?? []).map((e) => e.id),
    (ids) =>
      setDraft((prev) =>
        prev ? { ...prev, search: { ...prev.search, engines: orderById(prev.search.engines, ids) } } : prev,
      ),
  );

  if (!draft) {
    /* 这一页是"每块一张卡"的长表单，骨架也照着摞几块。
        原来只渲染一张细条卡，数据一到整页几乎全部重排。 */
    return (
      <div className="mx-auto w-full max-w-[1080px] space-y-4" role="status" aria-busy="true">
        <PageHead title="系统设置" hint="外观、连接、功耗与备份，改动会同步保存到服务端。" />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={5} />
        <span className="sr-only">正在读取设置…</span>
      </div>
    );
  }

  const patch = (next: Partial<SettingsShape>) => setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  const patchPower = (next: Partial<SettingsShape['power']>) => setDraft((prev) => (prev ? { ...prev, power: { ...prev.power, ...next } } : prev));
  const patchPve = (next: Partial<SettingsShape['pve']>) => setDraft((prev) => (prev ? { ...prev, pve: { ...prev.pve, ...next } } : prev));
  const patchHa = (next: Partial<SettingsShape['ha']>) => setDraft((prev) => (prev ? { ...prev, ha: { ...prev.ha, ...next } } : prev));
  const patchAihot = (next: Partial<SettingsShape['news']['aihot']>) =>
    setDraft((prev) => (prev ? { ...prev, news: { ...prev.news, aihot: { ...prev.news.aihot, ...next } } } : prev));
  const patchProfile = (next: Partial<SettingsShape['profile']>) =>
    setDraft((prev) => (prev ? { ...prev, profile: { ...prev.profile, ...next } } : prev));
  const patchSearch = (next: Partial<SettingsShape['search']>) =>
    setDraft((prev) => (prev ? { ...prev, search: { ...prev.search, ...next } } : prev));
  const patchBackup = (next: Partial<SettingsShape['backup']>) =>
    setDraft((prev) => (prev ? { ...prev, backup: { ...prev.backup, ...next } } : prev));
  const patchCos = (next: Partial<SettingsShape['backup']['cos']>) =>
    setDraft((prev) => (prev ? { ...prev, backup: { ...prev.backup, cos: { ...prev.backup.cos, ...next } } } : prev));

  /* ── 插座列表：换插座、加插座都只动这里 ─────────────────────────── */
  const patchSocket = (index: number, next: Partial<HaSocket>) =>
    setDraft((prev) =>
      prev
        ? { ...prev, ha: { ...prev.ha, sockets: prev.ha.sockets.map((s, i) => (i === index ? { ...s, ...next } : s)) } }
        : prev,
    );

  function addSocket() {
    setDraft((prev) => {
      if (!prev) return prev;
      // 绝不替用户猜实体：猜错（比如指到已经在用的那一路）会让合计凭空翻倍。
      // 只有当确实存在"还没被占用"的候选时才顺手带上，省一步操作。
      const used = new Set(prev.ha.sockets.map((s) => s.powerEntity));
      const free = (haOptions?.power ?? []).find((o) => !used.has(o.entityId))?.entityId ?? '';
      const n = prev.ha.sockets.length + 1;
      return {
        ...prev,
        ha: {
          ...prev.ha,
          sockets: [
            ...prev.ha.sockets,
            { id: `socket_${Date.now().toString(36)}`, name: `插座 ${n}`, powerEntity: free, counterEntity: '', enabled: true },
          ],
        },
      };
    });
  }

  const removeSocket = (index: number) =>
    setDraft((prev) => (prev ? { ...prev, ha: { ...prev.ha, sockets: prev.ha.sockets.filter((_, i) => i !== index) } } : prev));

  /* ── 搜索引擎列表：和插座列表同一套做法，只动这里 ───────────────────
     新建的行在这里就先拿到 id（而不是留空等服务端补）：React 拿它当 key，
     列表里同时加两行时没有 id 就会撞 key。 */
  const patchEngine = (index: number, next: Partial<SearchEngine>) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            search: {
              ...prev.search,
              engines: prev.search.engines.map((e, i) => (i === index ? { ...e, ...next } : e)),
            },
          }
        : prev,
    );

  function addEngine() {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            search: {
              ...prev.search,
              // 名称和地址都留空：地址模板不猜 —— 猜一个域名出去，用户还得先删掉它
              // 再填自己的，不如让占位提示把 %s 该放哪儿说清楚
              engines: [...prev.search.engines, { id: newEngineId(), name: '', url: '' }],
            },
          }
        : prev,
    );
  }

  const removeEngine = (index: number) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const removed = prev.search.engines[index];
      const engines = prev.search.engines.filter((_, i) => i !== index);
      /* 删掉的可能正是默认项：顺手把默认挪到剩下的第一个，
         否则下拉里会留一个已经不存在的 id，选中项显示成空白 */
      const defaultEngine =
        prev.search.defaultEngine === removed?.id ? engines[0]?.id ?? '' : prev.search.defaultEngine;
      return { ...prev, search: { ...prev.search, engines, defaultEngine } };
    });

  async function loadHaOptions() {
    setHaOptionsLoading(true);
    setHaOptionsError(null);
    try {
      setHaOptions(await api.ha.options());
    } catch (err) {
      setHaOptionsError(err instanceof Error ? err.message : '读取 HA 实体列表失败');
    } finally {
      setHaOptionsLoading(false);
    }
  }

  /** 已确认非空，供下面的事件处理函数使用（避免闭包内的类型收窄丢失） */
  const current = draft;

  function pickTheme(mode: ThemeMode, accent: AccentName) {
    patch({ theme: { mode, accent } });
    switchTheme(mode, accent);
    void saveSettings({ theme: { mode, accent } });
  }

  /* ── 分区保存 ─────────────────────────────────────────────────────
     每个功能区只提交自己那几个字段，并在自己的动作行里就地给出状态。
     脏检测靠对比 draft 与服务端副本：没有改动时按钮禁用并显示「已保存」，
     所以界面上不会出现一排永远可点的保存按钮。 */
  const dirtyOf = (key: keyof SettingsShape) =>
    JSON.stringify(draft?.[key] ?? null) !== JSON.stringify(settings?.[key] ?? null);

  /** 没选功率实体的插座：直接拦住保存，而不是筛掉后假装成功 */
  const badSocketIds = (draft?.ha.sockets ?? []).filter((s) => !s.powerEntity.trim()).map((s) => s.id);

  /* ── 搜索源的两类毛病，同样在本地先拦一道 ───────────────────────────
     服务端也会校验（那边是最后一道闸），但跑到网络那头再弹错，
     用户得先自己找到是哪一行出的问题；这里能直接说出是哪一个。
     `?.` 是给"后端进程比这版页面旧、返回值里没有 search"那种情况兜底用的
     （同下面备份卡的守卫），否则整页会在这里抛。 */
  const searchEngines: SearchEngine[] = current.search?.engines ?? [];
  const blankEngines = searchEngines.filter((e) => !e.name.trim() || !e.url.trim());
  /** 地址里没有 %s 的引擎：少了它，点搜索永远只打开同一个固定页面 */
  const noPlaceholderEngine = searchEngines.find((e) => e.url.trim() && !e.url.includes('%s'));

  /** 保存一个分区。返回落库后的设置；失败时返回 null（错误已经提示过） */
  async function saveSection(key: string, patch: Partial<SettingsShape>) {
    setSavingSection(key);
    const next = await saveSettings(patch as never);
    setSavingSection(null);
    return next;
  }

  /* ── PVE 令牌 ───────────────────────────────────────────────────────
     和下面备份那一栏同一套做法：密钥单独一个状态，不绑草稿。
     草稿里那位是服务端回的掩码，而服务端把"空串"理解成"清空" ——
     直接绑草稿的话，把输入框清空再保存，令牌就没了（改节点、改端口时
     顺手点一下就会发生），而提示里写的偏偏是"留空表示不修改"。 */
  const pveDirty = dirtyOf('pve') || Boolean(newPveSecret);

  async function savePve() {
    setSavingSection('pve');
    const next = await saveSection('pve', { pve: { ...current.pve, ...(newPveSecret ? { tokenSecret: newPveSecret } : {}) } });
    /* 只有确认存进去了才清空输入框 —— 存失败还清，用户刚敲的密钥就得重新贴一遍 */
    if (!next) return;
    setNewPveSecret('');
    /* 把服务端回写的那两位同步进草稿：tokenSecret（掩码）与 hasSecret。
       草稿只在 settings 第一次到达时克隆一次，之后不再重同步，而脏检测比的是
       整段 JSON —— 少了这一步，刚存完令牌，提示还停在"形如 xxxx…"，
       而整段又因为草稿里那位旧掩码和新的对不上，永远显示「未保存」。
       只动这一段，别处还没保存的编辑不碰。 */
    setDraft((prev) =>
      prev ? { ...prev, pve: { ...prev.pve, tokenSecret: next.pve.tokenSecret, hasSecret: next.pve.hasSecret } } : prev,
    );
  }

  /* ── 知识库备份 ─────────────────────────────────────────────────────
     SecretKey 单独一个字段管，不塞进草稿：草稿里那一位永远是服务端回的掩码，
     而服务端把"空串"理解成"清空"。若让输入框直接绑草稿，就会出现
     "想改备份频率，顺手把密钥抹掉了"这种事故 —— 这里空着就是不改动，
     改它必须真的在这一栏敲东西。 */
  const backupDirty = dirtyOf('backup') || Boolean(newSecretKey);

  async function saveBackup() {
    setSavingSection('backup');
    const next = await saveSection('backup', {
      backup: {
        ...current.backup,
        cos: { ...current.backup.cos, ...(newSecretKey ? { secretKey: newSecretKey } : {}) },
      },
    });
    if (!next) return;
    setNewSecretKey('');
    /* 同 PVE 那一栏：掩码与 hasSecretKey 都要跟着服务端走，
       否则提示停在"还没配"、脏标记停在「未保存」 */
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            backup: {
              ...prev.backup,
              cos: {
                ...prev.backup.cos,
                secretKey: next.backup.cos.secretKey,
                hasSecretKey: next.backup.cos.hasSecretKey,
              },
            },
          }
        : prev,
    );
  }

  async function runBackupNow() {
    setBackupBusy('run');
    setBackupResult(null);
    try {
      const r = await api.backup.cosRun();
      setBackupResult({
        ok: true,
        text: `已上传 ${r.lastKey}（${fmtBytes(r.lastBytes)}，压缩前 ${fmtBytes(r.rawBytes)}，含 ${r.lastDocs} 篇文档）`,
      });
      /* 重新拉一次设置，让下面「上次备份」那一行跟着变 ——
         last* 是服务端写的，本地那份不会自己更新 */
      await refreshAll();
    } catch (err) {
      setBackupResult({ ok: false, text: err instanceof Error ? err.message : '备份失败' });
    } finally {
      setBackupBusy(null);
    }
  }

  async function loadBackups() {
    setBackupBusy('list');
    setBackupResult(null);
    try {
      setBackups(await api.backup.cosList());
    } catch (err) {
      setBackups(null);
      setBackupResult({ ok: false, text: err instanceof Error ? err.message : '读取备份清单失败' });
    } finally {
      setBackupBusy(null);
    }
  }

  /**
   * 用云上的某一份覆盖当前数据。
   *
   * 这是整页唯一一个"会动到你全部数据"的按钮，所以必须手点一次确认 ——
   * 用 window.confirm 而不是弹窗组件：同一张卡里的「重置为示例数据」就是这么
   * 问的，两处别长得不一样。
   */
  async function restoreFrom(key: string, size: number) {
    const ok = window.confirm(
      '用云上的这份备份覆盖知识库与工具箱？\n\n' +
        `备份：${key}\n` +
        `时间：${keyStamp(key)}${size ? `（${fmtBytes(size)}）` : ''}\n\n` +
        '只影响知识库与工具箱（收藏、分组）—— 任务、设置、AI 热点等都不会动。\n' +
        '覆盖之前会先把现在的这两块另存一份到云上（名字带 pre-restore），恢复错了还能换回来。',
    );
    if (!ok) return;

    setBackupResult(null);
    setBackupBusy('restore');
    try {
      const r = await api.backup.cosRestore(key);
      const fmt = (c: { knowledge: number; bookmarks: number; groups: number }) =>
        `知识库 ${c.knowledge} 篇 / 收藏 ${c.bookmarks} 个（${c.groups} 个分组）`;
      setBackupResult({
        ok: true,
        text:
          `已从 ${r.key} 恢复：${fmt(r.before)} → ${fmt(r.after)}。` +
          /* 早期的整份快照里还有任务、设置那些，这里只取了其中两块 —— 说清楚，
             免得用户以为"连设置也一起回来了" */
          (r.scope ? '' : '（这是一份早期的整份备份，只取其中的知识库与工具箱。）') +
          /* 存档没存上去时必须说出来：这时候没有后悔药，而用户正以为有 */
          (r.safetyKey ? `恢复前的状态另存在 ${r.safetyKey}` : `恢复前那份没能存上去：${r.safetyError}`),
      });
      setBackups(null); // 清单里的大小/时间都变了，收起来重新读一次
      await refreshAll(); // 知识库与工具箱整体换了，这两个页面都得重新拉
    } catch (err) {
      setBackupResult({ ok: false, text: err instanceof Error ? err.message : '恢复失败' });
    } finally {
      setBackupBusy(null);
    }
  }

  async function testCosNow() {
    setBackupBusy('test');
    setBackupResult(null);
    try {
      const r = await api.backup.cosTest();
      setBackupResult({ ok: true, text: `连通：已往 ${r.bucket}（${r.region}）写入探针对象 ${r.key}` });
    } catch (err) {
      setBackupResult({ ok: false, text: err instanceof Error ? err.message : '自检失败' });
    } finally {
      setBackupBusy(null);
    }
  }
  // 刷新间隔就摆在「功耗与电费」卡里，跟着这张卡一起提交
  const dirtyPower = dirtyOf('power') || dirtyOf('refreshSeconds');
  const savePower = () => void saveSection('power', { power: current.power, refreshSeconds: current.refreshSeconds });
  const saveNews = () => void saveSection('news', { news: current.news });
  const saveMisc = () => void saveSection('misc', { autoBackup: current.autoBackup });
  const saveProfile = () => void saveSection('profile', { profile: current.profile });

  /* 搜索源：三类拒绝都要点明是哪一个，不然用户只能一行行回找。
     服务端有一模一样的校验，这里只是把错误提前到点保存的那一刻。 */
  const saveSearch = () => {
    if (!current.search.engines.length) return notify('至少保留一个搜索引擎', 'crit');
    if (blankEngines.length) return notify(`有 ${blankEngines.length} 个引擎还没填名称或搜索地址`, 'crit');
    if (noPlaceholderEngine) {
      return notify(`「${noPlaceholderEngine.name || '未命名'}」的搜索地址里缺少 %s 占位符`, 'crit');
    }
    void saveSection('search', { search: current.search });
  };

  /* ── 背景 ─────────────────────────────────────────────────────────
     和「外观」卡一样是即时生效 + 即时落库：背景是眼睛能直接看到的东西，
     改完还要再点一次保存没有意义。滑块比较特殊——拖动会连发几十个事件，
     每个都打一次 PUT 不合适，所以拖动过程只做本地预览（applyBackground），
     松手（pointerup / keyup）才落库。 */
  async function applyBg(next: Partial<SettingsShape['background']>, persist = true) {
    if (!current) return;
    const merged = { ...current.background, ...next };
    setDraft((prev) => (prev ? { ...prev, background: merged } : prev));
    applyBackground(merged);
    if (persist) await saveSettings({ background: merged });
  }

  async function uploadBg(file?: File) {
    if (!file || !current) return;
    setBgUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
      const up = await api.background.upload(dataUrl);
      // 上传接口回的 hasUpload / uploadedAt / size 是派生态，得手动并回草稿
      // ——草稿只在首次拿到 settings 时初始化一次，不会自己跟着刷新
      await applyBg({ kind: 'upload', hasUpload: true, uploadedAt: up.uploadedAt, size: up.size });
    } catch (err) {
      notify(err instanceof Error ? err.message : '上传失败', 'crit');
    } finally {
      setBgUploading(false);
      if (bgFileRef.current) bgFileRef.current.value = '';
    }
  }

  async function removeBg() {
    try {
      const r = await api.background.remove();
      await applyBg({ kind: 'none', hasUpload: r.hasUpload, uploadedAt: null, size: null });
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'crit');
    }
  }

  /* ── 登录页背景 ───────────────────────────────────────────────────
     和主背景同一套做法，但**不做即时预览到页面上**：登录页此刻看不到
     （已经登进来了）。所以这里在卡片里放一个小预览框，
     否则遮罩和虚化这两个滑块就成了盲调。 */
  async function applyLoginBg(next: Partial<LoginBackground>, persist = true) {
    if (!current) return;
    // 必须提交合并后的完整对象：服务端那一侧是整块替换（和主背景一致），
    // 只发 { overlay } 会把 url / kind 一起冲掉
    const merged = { ...current.loginBackground, ...next };
    setDraft((prev) => (prev ? { ...prev, loginBackground: merged } : prev));
    if (persist) await saveSettings({ loginBackground: merged });
  }

  async function uploadLoginBg(file?: File) {
    if (!file) return;
    setLoginBgUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
      const up = await api.loginBackground.upload(dataUrl);
      await applyLoginBg({ kind: 'upload', hasUpload: true, uploadedAt: up.uploadedAt, size: up.size });
    } catch (err) {
      notify(err instanceof Error ? err.message : '上传失败', 'crit');
    } finally {
      setLoginBgUploading(false);
      if (loginBgFileRef.current) loginBgFileRef.current.value = '';
    }
  }

  async function removeLoginBg() {
    try {
      const r = await api.loginBackground.remove();
      await applyLoginBg({ kind: 'canvas', hasUpload: r.hasUpload, uploadedAt: null, size: null });
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'crit');
    }
  }

  async function saveHa() {
    if (badSocketIds.length) {
      notify('有插座还没选功率实体，先补上再保存', 'crit');
      return;
    }
    await saveSection('ha', { ha: { ...current.ha } });
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.pve.testConfig(current.pve);
      setTestResult(`连接成功，发现 ${res.count} 个节点：${res.nodes.map((n) => n.node).join('、')}`);
    } catch (err) {
      setTestResult(`连接失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setTesting(false);
    }
  }

  async function testHa() {
    setHaTesting(true);
    setHaTestResult(null);
    try {
      const res = await api.ha.test(current.ha);
      const detail = res.sockets.map((s) => `${s.name} ${s.watts == null ? '无读数' : `${s.watts} W`}`).join('，');
      setHaTestResult({
        ok: true,
        text: `连接成功：合计 ${res.watts ?? '—'} W${detail ? `（${detail}）` : ''}`,
      });
    } catch (err) {
      setHaTestResult({ ok: false, text: `连接失败：${err instanceof Error ? err.message : '未知错误'}` });
    } finally {
      setHaTesting(false);
    }
  }

  async function importBackup(file: File) {
    setImporting(true);
    try {
      const text = await file.text();
      await api.backup.restore(JSON.parse(text));
      await refreshAll();
      notify('备份已恢复');
    } catch (err) {
      notify(err instanceof Error ? err.message : '导入失败', 'crit');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-4">
      {/* 这一页原先整页没有 h1 —— 第一个标题就是卡片头渲染出来的 h3，
          文档大纲从 h3 起跳。补上页面名，卡片头降一级成 h2
          （见下面各处的 level={2}） */}
      <PageHead title="系统设置" hint="外观、连接、功耗与备份，改动会同步保存到服务端。" />

      {/* 个人 */}
      <Card>
        <CardHead level={2} title="个人" hint="设置称呼后，首页问候会带上你的名字" right={<User size={15} className="text-accent" />} />
        <Field label="称呼" hint="留空则只显示「早上好」，不带名字">
          <Input
            value={draft.profile.name}
            onChange={(e) => patchProfile({ name: e.target.value })}
            placeholder="例如：老王"
            autoComplete="off"
          />
        </Field>
        <div className="mt-3.5 flex items-center border-t border-line pt-3.5">
          <SaveAction className="ml-auto" dirty={dirtyOf('profile')} busy={savingSection === 'profile'} onSave={saveProfile} />
        </div>
      </Card>

      {/* 首页搜索。和下面「知识库备份」同一个守卫：后端进程比这版页面旧时，
          返回值里根本没有 search 这一段，这时不摆一堆"填了也存不进去"的输入框 */}
      {settings?.search ? (
        <Card>
          <CardHead
            level={2}
            title="搜索"
            hint="首页搜索框的引擎列表。地址里用 %s 表示查询词，提交时会替换成你输入的内容"
            right={<Search size={15} className="text-accent" />}
          />

          <div className="space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">搜索引擎</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-faint">
                  拖动左侧抓手或用箭头上下移动即可改顺序 —— 首页那一行标签就是这个顺序；
                  标了「首页默认」的那个，是打开首页时预先选中的
                </p>
              </div>
              <Button
                size="sm"
                variant="soft"
                onClick={addEngine}
                disabled={current.search.engines.length >= 12}
                title={current.search.engines.length >= 12 ? '最多 12 个' : undefined}
              >
                <Plus size={13} aria-hidden />
                添加引擎
              </Button>
            </div>

            {current.search.engines.length === 0 ? (
              <p className="rounded-field border border-dashed border-line px-4 py-5 text-center text-2xs text-faint">
                一个引擎都没有，首页的搜索框就没得选了 —— 点「添加引擎」补一个再保存。
              </p>
            ) : (
              <ul className="space-y-2">
                {current.search.engines.map((e, i) => (
                  <EngineRow
                    key={e.id}
                    engine={e}
                    index={i}
                    count={current.search.engines.length}
                    sortable={engineSort}
                    isDefault={e.id === current.search.defaultEngine}
                    invalid={!e.name.trim() || !e.url.trim()}
                    onPatch={(next) => patchEngine(i, next)}
                    onRemove={() => removeEngine(i)}
                    onMakeDefault={() => patchSearch({ defaultEngine: e.id })}
                  />
                ))}
              </ul>
            )}

            <div className="flex items-center justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
              <div>
                <p className="text-[13px]">新标签页打开</p>
                {/* 关掉就是当前页跳走，工作台本身会被搜索结果替换掉，说清楚 */}
                <p className="text-2xs text-faint">关闭后搜索结果在当前页打开，会离开工作台</p>
              </div>
              <Toggle
                checked={current.search.newTab}
                onChange={(v) => patchSearch({ newTab: v })}
                label="在新标签页打开搜索结果"
              />
            </div>

            {/* 这是整站唯一会把用户输入发给第三方的功能，所以开关旁边必须把
                后果写清楚，而不是只写"联想"两个字 —— 用户有权知道谁看到了什么。
                缺省（老配置里没有这个字段）按开启算，与前端一致。 */}
            <div className="flex items-start justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
              <div>
                <p className="text-[13px]">搜索联想</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-faint">
                  输入时把关键词发给所选搜索引擎（百度 / Google / Bing / 360），取它自己的候选词。
                  用其它引擎时不外发，只列本站的工具与知识库文章。关闭后一个词也不会发出去。
                </p>
              </div>
              <Toggle
                checked={current.search.suggest !== false}
                onChange={(v) => patchSearch({ suggest: v })}
                label="开启搜索联想（会把关键词发给搜索引擎）"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2 border-t border-line pt-3.5">
            <SaveAction
              className="ml-auto"
              dirty={dirtyOf('search')}
              busy={savingSection === 'search'}
              onSave={saveSearch}
            />
          </div>
        </Card>
      ) : (
        <Card>
          <CardHead
            level={2}
            title="搜索"
            hint="当前服务端还不认识这一段配置"
            right={<Search size={15} className="text-signal" />}
          />
          <p className="rounded-field bg-warn-soft px-3 py-2.5 text-2xs leading-relaxed text-warn">
            后端是在这版页面之前启动的进程，它返回的设置里没有搜索这一段，所以这里暂时什么都不显示。
            在服务器上重启一次（<code className="num">systemctl restart personal-workbench</code>）之后刷新页面，
            这一块就会连同首页的搜索框一起出现。
          </p>
        </Card>
      )}

      {/* 外观 */}
      <Card>
        <CardHead level={2} title="外观" hint="主题与强调色会立即生效，并同步保存到服务端" right={<Palette size={15} className="text-accent" />} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">主题</p>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { mode: 'dark' as ThemeMode, label: '深色', hint: '夜间值守', icon: Moon },
                  { mode: 'light' as ThemeMode, label: '浅色', hint: '白天办公', icon: Sun },
                ]
              ).map((opt) => (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => pickTheme(opt.mode, draft.theme.accent)}
                  className={cls(
                    'flex flex-col items-start gap-1 rounded-xl2 border px-3 py-2.5 text-left transition-colors',
                    draft.theme.mode === opt.mode ? 'border-accent/60 bg-accent-soft' : 'border-line bg-panel-2 hover:border-faint',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    <opt.icon size={13} />
                    {opt.label}
                    {draft.theme.mode === opt.mode ? <CheckCircle2 size={12} className="text-accent" /> : null}
                  </span>
                  <span className="text-2xs text-faint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">强调色</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ACCENTS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => pickTheme(draft.theme.mode, a.value)}
                  className={cls(
                    'flex items-center gap-2 rounded-xl2 border px-2.5 py-2.5 text-left transition-colors',
                    draft.theme.accent === a.value ? 'border-accent/60 bg-accent-soft' : 'border-line bg-panel-2 hover:border-faint',
                  )}
                >
                  <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: a.swatch }} />
                  <span className="text-2xs">{a.label}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-faint">
              科技蓝是浅色科技风的默认强调色；冷青偏链路与数据，铜琥珀对应机房热量与功耗，紫罗兰偏监控大屏。
            </p>
          </div>
        </div>
      </Card>

      {/* 背景 */}
      <Card>
        <CardHead level={2}
          title="背景"
          hint="铺在卡片之下的页面底图。磨砂侧栏和顶栏会把它糊成雾面，卡片本身不透明，正文不受影响"
          right={<ImageIcon size={15} className="text-accent" />}
        />

        <Field label="来源" hint="链接适合外部图床；上传的图存在服务端 server/data/background/ 下">
          <Segmented
            value={draft.background.kind}
            onChange={(kind) => void applyBg({ kind })}
            options={[
              { value: 'none', label: '主题渐变' },
              { value: 'url', label: '图片链接' },
              { value: 'upload', label: '上传图片' },
            ]}
          />
        </Field>

        {draft.background.kind === 'url' ? (
          <Field label="图片地址" hint="直链地址，形如 https://…/wallpaper.jpg">
            <Input
              value={draft.background.url}
              onChange={(e) => void applyBg({ url: e.target.value, kind: 'url' }, false)}
              onBlur={() => void applyBg({}, true)}
              placeholder="https://…"
              autoComplete="off"
            />
          </Field>
        ) : null}

        {draft.background.kind === 'upload' ? (
          <Field
            label="图片文件"
            hint={
              draft.background.hasUpload
                ? `已上传 ${fmtBytes(draft.background.size ?? 0)}，重新选择会直接覆盖`
                : 'JPEG / PNG / WebP / GIF，不超过 3MB'
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={bgFileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                disabled={bgUploading}
                onChange={(e) => void uploadBg(e.target.files?.[0])}
                className="block min-w-0 flex-1 text-2xs text-muted file:mr-3 file:rounded-field file:border-0 file:bg-bg-2 file:px-3 file:py-1.5 file:text-2xs file:text-ink hover:file:bg-bg-3"
              />
              {bgUploading ? (
                <span className="flex items-center gap-1.5 text-2xs text-muted">
                  <Spinner className="h-3 w-3" /> 上传中…
                </span>
              ) : null}
              {draft.background.hasUpload ? (
                <Button size="sm" variant="ghost" onClick={() => void removeBg()}>
                  <Trash2 size={12} />
                  删除
                </Button>
              ) : null}
            </div>
          </Field>
        ) : null}

        {draft.background.kind !== 'none' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {/* 这两个不是装饰：照片千差万别，没有遮罩和虚化，
                卡片之间的空隙会直接把正文压得读不了 */}
            <Field label={`遮罩 ${draft.background.overlay.toFixed(2)}`} hint="越高正文越清楚、照片越淡">
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={draft.background.overlay}
                onChange={(e) => void applyBg({ overlay: Number(e.target.value) }, false)}
                onPointerUp={() => void applyBg({}, true)}
                onKeyUp={() => void applyBg({}, true)}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-3 accent-[color:var(--accent)]"
              />
            </Field>
            <Field label={`虚化 ${draft.background.blur}px`} hint="弱化照片细节，免得抢注意力">
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                value={draft.background.blur}
                onChange={(e) => void applyBg({ blur: Number(e.target.value) }, false)}
                onPointerUp={() => void applyBg({}, true)}
                onKeyUp={() => void applyBg({}, true)}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-3 accent-[color:var(--accent)]"
              />
            </Field>
          </div>
        ) : null}
      </Card>

      {/* 登录 */}
      <Card>
        <CardHead level={2}
          title="登录"
          hint="面板账号。密码直接在这里改，不必去服务器上编辑 .env 再重启服务"
          right={<KeyRound size={15} className="text-accent" />}
        />

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl2 border border-line bg-panel-2 px-3.5 py-2.5">
            <User size={15} className="shrink-0 text-faint" />
            <span className="text-xs text-muted">
              账号 <span className="num font-medium text-ink">{draft.auth.user}</span>
            </span>
            <Badge tone={draft.auth.enabled ? 'ok' : 'warn'} dot>
              {draft.auth.enabled ? '已开启登录' : '未开启登录'}
            </Badge>
            <span className="text-2xs leading-relaxed text-faint">
              {draft.auth.custom
                ? '密码已在设置页改过，.env 里的 AUTH_PASSWORD 不再生效'
                : draft.auth.envFallback
                  ? '当前口令来自 .env 的 AUTH_PASSWORD；改一次密码之后即以这里为准'
                  : ''}
            </span>
          </div>

          <PasswordForm enabled={draft.auth.enabled} />

          <div className="border-t border-line pt-4">
            <Field label="登录页背景" hint="登录页独立的一份底图：与主页背景互不影响，且未登录时就能看到">
              <Segmented
                value={draft.loginBackground.kind}
                onChange={(kind) => void applyLoginBg({ kind })}
                options={[
                  { value: 'canvas', label: '柔彩画布' },
                  { value: 'url', label: '图片链接' },
                  { value: 'upload', label: '上传图片' },
                ]}
              />
            </Field>

            {draft.loginBackground.kind === 'url' ? (
              <Field label="图片地址" className="mt-4" hint="直链地址，形如 https://…/login.jpg">
                <Input
                  value={draft.loginBackground.url}
                  onChange={(e) => void applyLoginBg({ url: e.target.value, kind: 'url' }, false)}
                  onBlur={() => void applyLoginBg({}, true)}
                  placeholder="https://…"
                  autoComplete="off"
                />
              </Field>
            ) : null}

            {draft.loginBackground.kind === 'upload' ? (
              <Field
                label="图片文件"
                className="mt-4"
                hint={
                  draft.loginBackground.hasUpload
                    ? `已上传 ${fmtBytes(draft.loginBackground.size ?? 0)}，重新选择会直接覆盖`
                    : 'JPEG / PNG / WebP / GIF，不超过 3MB'
                }
              >
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={loginBgFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => void uploadLoginBg(e.target.files?.[0])}
                  />
                  <Button size="sm" variant="soft" onClick={() => loginBgFileRef.current?.click()} disabled={loginBgUploading}>
                    {loginBgUploading ? <Spinner /> : <Upload size={13} />}
                    选择图片
                  </Button>
                  {draft.loginBackground.hasUpload ? (
                    <Button size="sm" variant="ghost" onClick={() => void removeLoginBg()}>
                      <Trash2 size={12} />
                      删除
                    </Button>
                  ) : null}
                </div>
              </Field>
            ) : null}

            {draft.loginBackground.kind !== 'canvas' ? (
              <>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field label={`遮罩 ${draft.loginBackground.overlay.toFixed(2)}`} hint="越高表单越清楚、图片越淡">
                    <input
                      type="range"
                      min={0}
                      max={0.9}
                      step={0.05}
                      value={draft.loginBackground.overlay}
                      onChange={(e) => void applyLoginBg({ overlay: Number(e.target.value) }, false)}
                      onPointerUp={() => void applyLoginBg({}, true)}
                      onKeyUp={() => void applyLoginBg({}, true)}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-3 accent-[color:var(--accent)]"
                    />
                  </Field>
                  <Field label={`虚化 ${draft.loginBackground.blur}px`} hint="弱化图片细节，把注意力留给表单">
                    <input
                      type="range"
                      min={0}
                      max={24}
                      step={1}
                      value={draft.loginBackground.blur}
                      onChange={(e) => void applyLoginBg({ blur: Number(e.target.value) }, false)}
                      onPointerUp={() => void applyLoginBg({}, true)}
                      onKeyUp={() => void applyLoginBg({}, true)}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-3 accent-[color:var(--accent)]"
                    />
                  </Field>
                </div>
                <LoginBgPreview bg={draft.loginBackground} />
              </>
            ) : null}
          </div>
        </div>
      </Card>

      {/* Proxmox 连接 */}
      <Card>
        <CardHead level={2}
          title="Proxmox 连接"
          hint="留空则使用演示数据。建议在 PVE 上创建权限最小化的 API Token"
          right={
            health ? (
              <Badge tone={health.pveConfigured ? 'ok' : 'warn'} dot>
                {health.pveConfigured ? '已连接' : '未配置'}
              </Badge>
            ) : null
          }
        />

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="PVE 地址">
            <Input value={draft.pve.host} onChange={(e) => patchPve({ host: e.target.value })} placeholder="pve.home.local" />
          </Field>
          <Field label="端口">
            <Input type="number" value={draft.pve.port} onChange={(e) => patchPve({ port: Number(e.target.value) })} placeholder="8006" />
          </Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="API Token ID">
            <Input value={draft.pve.tokenId} onChange={(e) => patchPve({ tokenId: e.target.value })} placeholder="root@pam!workbench" />
          </Field>
          <Field label="API Token 密钥" hint={draft.pve.hasSecret ? '已保存，留空表示不修改' : '形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}>
            <Input
              type="password"
              value={newPveSecret}
              onChange={(e) => setNewPveSecret(e.target.value)}
              placeholder={draft.pve.hasSecret ? '••••••••' : '粘贴密钥'}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="默认节点" hint="留空则取第一个可用节点">
            <Input value={draft.pve.node} onChange={(e) => patchPve({ node: e.target.value })} placeholder="pve" />
          </Field>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2.5 text-xs text-muted">
              <Toggle checked={!draft.pve.verifyTls} onChange={(v) => patchPve({ verifyTls: !v })} label="信任自签证书" />
              信任自签名证书（内网通常需要）
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <Button size="sm" variant="soft" onClick={() => void testConnection()} disabled={testing}>
            {testing ? <Spinner /> : <Plug size={13} aria-hidden />}
            测试连接
          </Button>
          {testResult ? (
            <span className={cls('flex items-center gap-1.5 text-2xs', testResult.startsWith('连接成功') ? 'text-ok' : 'text-crit')}>
              <Led tone={testResult.startsWith('连接成功') ? 'ok' : 'crit'} />
              {testResult}
            </span>
          ) : (
            <span className="text-2xs text-faint">测试用的是当前填写的值，不必先保存</span>
          )}
          <SaveAction className="ml-auto" dirty={pveDirty} busy={savingSection === 'pve'} onSave={() => void savePve()} />
        </div>
      </Card>

      {/* Home Assistant：米家插座实测 */}
      <Card>
        <CardHead level={2}
          title="整机功耗数据源"
          hint="接入米家智能插座后，整机功耗与用电量都取自插座，电费按近一月用电折算；不配则回退到 CPU 利用率估算模型"
          right={
            <>
              {health ? (
                <Badge tone={health.haConfigured ? 'ok' : 'warn'} dot>
                  {health.haConfigured ? '已连接' : '未配置'}
                </Badge>
              ) : null}
              {/* 卡内主操作放 CardHead 右侧，全站统一（同知识库「新建条目」） */}
              <Button size="sm" variant="primary" onClick={addSocket}>
                <Plus size={13} aria-hidden />
                添加插座
              </Button>
            </>
          }
        />

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Home Assistant 地址" hint="工作台与 HA 同机时用 127.0.0.1 即可">
            <Input value={draft.ha.url} onChange={(e) => patchHa({ url: e.target.value })} placeholder="http://127.0.0.1:8123" />
          </Field>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2.5 text-xs text-muted">
              <Toggle checked={!draft.ha.verifyTls} onChange={(v) => patchHa({ verifyTls: !v })} label="信任自签证书" />
              信任自签名证书
            </label>
          </div>
        </div>

        <div className="rounded-field border border-line bg-panel-2 px-4 py-3">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted">
            <Led tone={draft.ha.hasToken ? 'ok' : 'crit'} />
            长期访问令牌
            <span className={cls('text-2xs font-normal', draft.ha.hasToken ? 'text-ok' : 'text-crit')}>
              {draft.ha.hasToken ? '已从环境变量 HA_TOKEN 读取' : '未配置'}
            </span>
          </p>
          <p className="mt-1.5 text-2xs leading-relaxed text-faint">
            令牌只从服务端环境变量读取，不写入数据库，备份、导出与接口回显里都不会出现它。在项目根目录{' '}
            <span className="num text-ink">.env</span> 里设置 <span className="num text-ink">HA_TOKEN=你的令牌</span>
            ，重启服务后生效。令牌可在 HA → 左下角头像 → 安全 → 长期访问令牌 生成。
          </p>
        </div>

        {/* 插座列表：换插座、加插座都只改这里，统计口径自动跟随 */}
        <div className="space-y-2.5">
          {/* 区块标题只留文字，动作交给 CardHead；刷新是低频操作，收成图标按钮不抢视线 */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink">插座列表</p>
              <p className="mt-0.5 text-2xs leading-relaxed text-faint">
                多路会一路路加起来：加一路，总功耗与电费都会跟着变；不想计入就关掉它
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => void loadHaOptions()}
              disabled={haOptionsLoading}
              className="shrink-0"
              aria-label="从 Home Assistant 重新读取实体列表"
              title="从 Home Assistant 重新读取实体列表"
            >
              {haOptionsLoading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCcw size={15} aria-hidden />}
            </Button>
          </div>

          {draft.ha.sockets.length === 0 ? (
            <p className="rounded-field border border-dashed border-line px-4 py-5 text-center text-2xs text-faint">
              还没有插座。点「添加插座」选一个功率实体即可，整机功耗与用电量会自动跟上。
            </p>
          ) : (
            <ul className="space-y-2">
              {draft.ha.sockets.map((s, i) => (
                <SocketRow
                  key={s.id}
                  socket={s}
                  options={haOptions}
                  invalid={badSocketIds.includes(s.id)}
                  onPatch={(next) => patchSocket(i, next)}
                  onRemove={() => removeSocket(i)}
                />
              ))}
            </ul>
          )}

          {haOptionsError ? (
            <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-crit">
              <Led tone="crit" />
              读不到 HA 实体列表：{haOptionsError}
            </p>
          ) : haOptions ? (
            <p className="mt-2.5 text-2xs leading-relaxed text-faint">
              已从 HA 读到 {haOptions.total} 个实体，其中可作功率用的 {haOptions.power.length} 个、累计电量{' '}
              {haOptions.energy.length} 个——下拉里直接选，不用手填实体 ID。
            </p>
          ) : null}
        </div>

        <p className="mt-2 text-2xs leading-relaxed text-faint">
          用电量由工作台对插座实测电功率做时间积分得到，服务端常驻每分钟采样一次，「近一月」取滚动的 30 天。
          某个插座长期读不到数，把它「停用」即可，其余部分照常统计。
        </p>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <Button size="sm" variant="soft" onClick={() => void testHa()} disabled={haTesting}>
            {haTesting ? <Spinner /> : <Plug size={13} aria-hidden />}
            测试读数
          </Button>
          {haTestResult ? (
            <span className={cls('flex items-center gap-1.5 text-2xs', haTestResult.ok ? 'text-ok' : 'text-crit')}>
              <Led tone={haTestResult.ok ? 'ok' : 'crit'} />
              {haTestResult.text}
            </span>
          ) : (
            <span className="text-2xs text-faint">先用「测试读数」确认能取到值，再保存</span>
          )}
          <SaveAction className="ml-auto" dirty={dirtyOf('ha')} busy={savingSection === 'ha'} onSave={() => void saveHa()} />
        </div>
      </Card>

      {/* 功耗与电费 */}
      <Card>
        <CardHead level={2}
          title="功耗与电费"
          hint="只在走 CPU 估算模型时生效；接上米家插座实测后，这些参数仅在 HA 不可用时兜底"
          right={<Leaf size={15} className="text-ok" />}
        />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="空闲功耗" hint="CPU 接近 0% 时的 CPU 部分">
            <Input type="number" value={draft.power.idleW} onChange={(e) => patchPower({ idleW: Number(e.target.value) })} />
          </Field>
          <Field label="满载功耗" hint="CPU 100% 时的 CPU 部分">
            <Input type="number" value={draft.power.maxW} onChange={(e) => patchPower({ maxW: Number(e.target.value) })} />
          </Field>
          <Field label="每块硬盘" hint="按磁盘数量累加">
            <Input type="number" value={draft.power.perDiskW} onChange={(e) => patchPower({ perDiskW: Number(e.target.value) })} />
          </Field>
          <Field label="其它固定功耗" hint="主板、网卡、风扇等">
            <Input type="number" value={draft.power.extraW} onChange={(e) => patchPower({ extraW: Number(e.target.value) })} />
          </Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="电价（元 / kWh）">
            <Input type="number" step="0.01" value={draft.power.pricePerKwh} onChange={(e) => patchPower({ pricePerKwh: Number(e.target.value) })} />
          </Field>
          <Field label="节能折算系数" hint="0.85 表示功耗上限按 85% 计">
            <Input type="number" step="0.01" value={draft.power.ecoFactor} onChange={(e) => patchPower({ ecoFactor: Number(e.target.value) })} />
          </Field>
          <Field label="刷新间隔（秒）">
            <Input type="number" value={draft.refreshSeconds} onChange={(e) => patch({ refreshSeconds: Number(e.target.value) })} />
          </Field>
        </div>

        <p className="flex items-start gap-2 rounded-field bg-bg-2 px-3 py-2 text-2xs leading-relaxed text-faint">
          <Zap size={12} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          节能模式在服务器侧会更新功耗模型；如果配置了 ECO_WEBHOOK_URL 或 PVE_ECO_COMMAND，还会同步触发外部联动（例如切换 CPU governor）。
        </p>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <span className="text-2xs text-faint">只影响电量估算与页面刷新节奏</span>
          <SaveAction className="ml-auto" dirty={dirtyPower} busy={savingSection === 'power'} onSave={savePower} />
        </div>
      </Card>

      {/* AI 热点 */}
      <Card>
        <CardHead
          level={2}
          title="AI 热点来源"
          hint="接入 AIHOT 公开 API：数据在来源侧已经用模型筛过、每条带 0–100 分与推荐理由，抓来即用；抓取失败或断网时保留上一批缓存"
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
            <div>
              <p className="text-[13px]">启用 AIHOT 来源</p>
              {/* 关掉来源和"清空页面"是两件事，说清楚，免得不敢关 */}
              <p className="text-2xs text-faint">关掉不会清空「AI 热点」页，只是不再更新</p>
            </div>
            <Toggle checked={draft.news.aihot.enabled} onChange={(v) => patchAihot({ enabled: v })} label="启用 AIHOT" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
            <div>
              <p className="text-[13px]">每日自动更新</p>
              <p className="text-2xs text-faint">关闭后只能手动刷新</p>
            </div>
            <Toggle checked={draft.news.autoUpdate} onChange={(v) => patch({ news: { ...draft.news, autoUpdate: v } })} label="自动更新" />
          </div>
        </div>

        {/* 这四个字段原本是卡片的直接子元素，彼此**完全贴在一起**（实测 0px）——
            上一段的提示文字正好压在下一段的标签上。收进一个 space-y-3 之后，
            间距和上面那两条开关一致了 */}
        <div className="mt-3 space-y-3">
          <Field
            label="抓取时间（cron）"
            hint="默认 0 */2 * * *，每 2 小时一次（12 趟/天）。想更实时就改成 0 * * * *（每小时）；接口的 s-maxage 是 60 秒，比这更密没有意义，超过约 60 请求/分钟还会 429"
          >
            <Input value={draft.news.cron} onChange={(e) => patch({ news: { ...draft.news, cron: e.target.value } })} className="num" />
          </Field>

          <Field
            label="取数范围"
            hint="「精选」是来源已经筛过的一档（实测分数落在 60–87）；「全量」会混进大量低分条目，靠下面这道门槛再切一次"
          >
            <Segmented
              value={draft.news.aihot.mode}
              onChange={(v) => patchAihot({ mode: v })}
              options={[
                { value: 'selected', label: '只要精选' },
                { value: 'all', label: '全量' },
              ]}
            />
          </Field>

          <Field
            label={`分数门槛 ${draft.news.aihot.minScore}`}
            hint="抓取入库时低于这个分数的条目直接丢掉。筛选只发生在入库那一步 —— 界面上不会出现按分数过滤的控件"
          >
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={draft.news.aihot.minScore}
              onChange={(e) => patchAihot({ minScore: Number(e.target.value) })}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-bg-3 accent-[color:var(--accent)]"
            />
          </Field>

          <Field label="每次拉取页数" hint="接口单页上限 100 条，翻页之间会停顿一下；2 页即最多入库 200 条">
            <Select value={String(draft.news.aihot.pages)} onChange={(e) => patchAihot({ pages: Number(e.target.value) })}>
              <option value="1">1 页（最多 100 条）</option>
              <option value="2">2 页（最多 200 条）</option>
              <option value="3">3 页（最多 300 条）</option>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3.5">
          <span className="text-2xs text-faint">改完需要保存，下一次抓取才会用新设置</span>
          {/* 数据来自第三方，把出处摆出来。纯内网自用没问题，
              但若这一页将来对外部署，要先看它的公开使用规则 */}
          <a
            href="https://aihot.news"
            target="_blank"
            rel="noreferrer noopener"
            className="num text-2xs text-accent underline decoration-dotted underline-offset-2 hover:opacity-80"
          >
            数据来自 aihot.news
          </a>
          <SaveAction className="ml-auto" dirty={dirtyOf('news')} busy={savingSection === 'news'} onSave={saveNews} />
        </div>
      </Card>

      {/* 数据与备份 */}
      <Card>
        <CardHead level={2}
          title="数据与备份"
          hint={health ? `数据库：${health.db?.label ?? health.db?.database ?? '—'}` : '所有内容都存在 MySQL 里'}
          right={<Database size={15} className="text-signal" />}
        />

        <div className="flex flex-wrap items-center gap-2">
          {/* 下载链接必须是 <a>（要交给浏览器下载，不能用 button），
              所以外观照着 Button 取类 —— 同一行里三个按钮一个矮 4px，
              那种"挤"其实是不齐 */}
          <a href={api.backup.exportUrl} className={buttonClass('soft', 'md')}>
            <Download size={14} />
            导出备份
          </a>
          <Button variant="soft" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? <Spinner /> : <Upload size={14} />}
            导入备份
          </Button>
          <Button variant="soft" onClick={() => void api.backup.save().then(() => notify('已写入数据文件'))}>
            <HardDriveDownload size={14} />
            立即落盘
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              if (!window.confirm('这会清空当前数据并恢复为初始示例内容，确定继续？')) return;
              await api.backup.reset();
              await refreshAll();
              notify('已恢复为示例数据', 'warn');
            }}
          >
            <RefreshCcw size={14} />
            重置为示例数据
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importBackup(file);
            }}
          />
        </div>

        {/* 两套备份的范围不一样，边界必须写在各自旁边 ——
            否则"导入备份"和"从云备份恢复"很容易被当成同一件事 */}
        <p className="mt-2.5 text-2xs leading-relaxed text-faint">
          这里的导出 / 导入是整份数据（任务、书签、知识库、设置全在内，适合搬家）；下面「知识库备份」每天传上云的是知识库与工具箱。
        </p>

        <div className="mt-3 flex items-center justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
          <div>
            <p className="text-[13px]">启动时自动落盘</p>
            <p className="text-2xs text-faint">每次改动都会写入 db.json，这里只是额外确保一次</p>
          </div>
          <Toggle checked={draft.autoBackup} onChange={(v) => patch({ autoBackup: v })} label="自动落盘" />
        </div>

        <div className="flex items-center gap-2 border-t border-line pt-3.5">
          <SaveAction className="ml-auto" dirty={dirtyOf('autoBackup')} busy={savingSection === 'misc'} onSave={saveMisc} />
        </div>
      </Card>

      {/* 知识库备份（腾讯云 COS）
          draft.backup 可能是 undefined —— 服务端是"改动之前启动的那个进程"时，
          它返回的设置里根本没有这一段。而直接读 draft.backup.enabled 会把
          **整个设置页**打成一屏白：一个 undefined 换整页不可用，这是这里最不
          该付出的代价（页面和接口由同一个服务发，所以版本本来该是一致的，
          差就差在"改了后端但还没重启进程"这段窗口里）。
          所以缺了就不渲染这张卡、换成一段说明，其余各块照常能用。 */}
      {draft.backup ? (
        <Card>
          <CardHead
            level={2}
            title="知识库备份"
            hint="只备份知识库文档与工具箱收藏（含分组），按时传到腾讯云 COS；任务、设置、AI 热点不在其中"
            right={<CloudUpload size={15} className="text-signal" />}
          />

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
            <div>
              <p className="text-[13px]">定时备份</p>
              <p className="text-2xs text-faint">关掉之后下面的配置都留着，只是不再按时上传</p>
            </div>
            <Toggle checked={draft.backup.enabled} onChange={(v) => patchBackup({ enabled: v })} label="定时备份到 COS" />
          </div>

          {/* 卡片内部原本**一点垂直间距都没有**（实测相邻两块之间 0px），
              于是每一条说明文字都贴在它上面那颗控件的脚下。这里定个节奏：
              功能块之间 12px（mt-3），控件下面的说明文字 8px（mt-2）。 */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="备份频率（cron）" hint="默认 30 3 * * *，即每天 03:30 一次。保存后即刻生效，不必重启服务">
              <Input value={draft.backup.cron} onChange={(e) => patchBackup({ cron: e.target.value })} className="num" />
            </Field>
            <Field label="对象键前缀" hint="留空就直接放在桶根目录；只接受字母数字与 - _ /">
              <Input
                value={draft.backup.prefix}
                onChange={(e) => patchBackup({ prefix: e.target.value })}
                className="num"
                placeholder="workbench-backup"
              />
            </Field>
            <Field label="存储桶" hint="要带 -APPID 后缀，例如 mybucket-1250000000">
              <Input
                value={draft.backup.cos.bucket}
                onChange={(e) => patchCos({ bucket: e.target.value })}
                className="num"
                placeholder="mybucket-1250000000"
              />
            </Field>
            <Field label="地域" hint="例如 ap-beijing / ap-shanghai">
              <Input
                value={draft.backup.cos.region}
                onChange={(e) => patchCos({ region: e.target.value })}
                className="num"
                placeholder="ap-beijing"
              />
            </Field>
            <Field label="SecretId">
              <Input
                value={draft.backup.cos.secretId}
                onChange={(e) => patchCos({ secretId: e.target.value })}
                className="num"
                placeholder="AKID…"
              />
            </Field>
            <Field
              label="SecretKey"
              hint={draft.backup.cos.hasSecretKey ? '已保存；不回显明文，留空表示不修改' : '只存在数据库里，接口不会把它返回给页面'}
            >
              <Input
                type="password"
                value={newSecretKey}
                onChange={(e) => setNewSecretKey(e.target.value)}
                placeholder={draft.backup.cos.hasSecretKey ? '••••••••' : '粘贴密钥'}
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
            <Button size="sm" variant="soft" onClick={() => void runBackupNow()} disabled={backupBusy !== null}>
              {backupBusy === 'run' ? <Spinner /> : <CloudUpload size={13} aria-hidden />}
              立即备份
            </Button>
            <Button size="sm" variant="soft" onClick={() => void testCosNow()} disabled={backupBusy !== null}>
              {backupBusy === 'test' ? <Spinner /> : <Plug size={13} aria-hidden />}
              测试连接
            </Button>
            <SaveAction
              className="ml-auto"
              dirty={backupDirty}
              busy={savingSection === 'backup'}
              onSave={() => void saveBackup()}
            />
          </div>
          {/* 这句原来夹在按钮与「已保存/保存」中间，把一行切成了三段，
              窄屏上还会把保存状态挤到下一行。自己占一行更稳，
              也和这一页其它说明（导出/导入那句、字段 hint）是一个读法 */}
          <p className="mt-2 text-2xs leading-relaxed text-faint">这两颗按钮用的都是已保存的配置，改完先保存再点。</p>

          {backupResult ? (
            <p
              className={cls(
                'mt-2 flex items-start gap-1.5 text-2xs leading-relaxed',
                backupResult.ok ? 'text-ok' : 'text-crit',
              )}
            >
              <Led tone={backupResult.ok ? 'ok' : 'crit'} />
              {backupResult.text}
            </p>
          ) : null}

          {/* 上次备份的结果由服务端回写。这一行是整张卡的重点：它要能直接回答
              "到底在不在备份"，而不是让人去翻服务日志 */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-field bg-bg-2 px-3 py-2.5 text-2xs">
            <span className="text-faint">上次备份</span>
            {settings?.backup?.lastRunAt ? (
              <>
                <span className="num text-muted">{fmtRelative(settings.backup.lastRunAt)}</span>
                {settings.backup.lastStatus === 'error' ? (
                  <span className="flex items-center gap-1.5 text-crit">
                    <Led tone="crit" />
                    失败
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-ok">
                    <Led tone="ok" />
                    成功
                  </span>
                )}
                {settings.backup.lastKey ? (
                  /* 对象键很长，不截断就会把这条状态栏顶成三行（窄屏上更明显）——
                     截断 + title，完整键名在下面「从云备份恢复」的清单里能逐条看到 */
                  <span className="num min-w-0 max-w-[24rem] truncate text-faint" title={settings.backup.lastKey}>
                    {settings.backup.lastKey}
                  </span>
                ) : null}
                {settings.backup.lastBytes ? <span className="num text-faint">{fmtBytes(settings.backup.lastBytes)}</span> : null}
                {settings.backup.lastDocs ? <span className="num text-faint">{settings.backup.lastDocs} 篇</span> : null}
                <span className="text-faint">{settings.backup.lastTrigger === 'manual' ? '手动触发' : '定时任务'}</span>
              </>
            ) : (
              <span className="text-faint">还没有备份过</span>
            )}
          </div>
          {settings?.backup?.lastError ? (
            <p className="mt-2 text-2xs leading-relaxed text-crit">上次失败原因：{settings.backup.lastError}</p>
          ) : null}

          {/* ── 云上的备份：列出来、挑一份恢复 ─────────────────────────────
              只能写不能读的备份等于没有备份，所以这一段和上面的上传是同一件事
              的两半。每份都是**整份快照**（不是增量），所以随便挑一份都能独立
              还原成那个时间点，不必按顺序回放一串差异包。 */}
          <div className="mt-3 rounded-field border border-line">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <p className="text-[13px]">从云备份恢复</p>
              {/* 两句都必须写出来：前一句说明"随便挑哪一份都能独立还原"，
                  后一句说明"恢复不会动到别的数据" —— 少一句都会让人不敢点 */}
              <span className="text-2xs text-faint">
                每次都是完整的一份（不是增量）；恢复只覆盖知识库与工具箱，其它数据不动
              </span>
              <Button
                size="sm"
                variant="soft"
                className="ml-auto"
                disabled={backupBusy !== null}
                onClick={() => void loadBackups()}
              >
                {backupBusy === 'list' ? <Spinner /> : <RefreshCcw size={13} aria-hidden />}
                {backups ? '重新读取' : '读取云上的备份'}
              </Button>
            </div>

            {backups ? (
              backups.items.length ? (
                <>
                  {/* 探测模式下清单是不完整的（只看得到最近 N 天、且只认按日期命名的
                      那些）—— 不说清楚的话，"怎么只有这几份"就成了疑问 */}
                  {backups.mode === 'probe' ? (
                    <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-faint">
                      这个密钥没有列出桶的权限，所以只列出了最近 {backups.days} 天里按日期命名的备份。
                      改用带 ListBucket 权限的密钥能看到全部。
                    </p>
                  ) : null}
                  <ul className="border-t border-line">
                    {backups.items.map((b) => (
                      <li
                        key={b.key}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0"
                      >
                        <span className="num text-[13px] text-ink">{keyStamp(b.key)}</span>
                        {b.key.includes('pre-restore-') ? <Badge tone="neutral">恢复前存档</Badge> : null}
                        <span className="num text-2xs text-faint">{b.size ? fmtBytes(b.size) : '—'}</span>
                        <span className="min-w-0 flex-1 truncate text-2xs text-faint" title={b.key}>
                          {b.key}
                        </span>
                        <Button
                          size="sm"
                          variant="soft"
                          disabled={backupBusy !== null}
                          onClick={() => void restoreFrom(b.key, b.size)}
                        >
                          {backupBusy === 'restore' ? <Spinner /> : <History size={13} aria-hidden />}
                          恢复
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="border-t border-line px-3 py-2.5 text-2xs text-faint">
                  桶里还没有备份。上面点一次「立即备份」就会有一份，之后每天按设置的时间自动加一份。
                </p>
              )
            ) : null}
          </div>
        </Card>
      ) : (
        <Card>
          <CardHead
            level={2}
            title="知识库备份"
            hint="当前服务端还不认识这一段配置"
            right={<CloudUpload size={15} className="text-signal" />}
          />
          <p className="rounded-field bg-warn-soft px-3 py-2.5 text-2xs leading-relaxed text-warn">
            后端是在这版页面之前启动的进程，它返回的设置里没有备份这一段，所以这里暂时什么都不显示 ——
            不摆一堆"填了也存不进去"的输入框。
            <br />
            在服务器上重启一次（<code className="num">systemctl restart personal-workbench</code> 或
            <code className="num"> node server/index.js</code>）之后刷新页面，这一块会连同定时任务一起出现。
            上面其它设置不受影响，现在就能改。
          </p>
        </Card>
      )}

      {/* 每个功能区各自保存，这里不再压一根全局保存条，只留一行环境信息 */}
      <p className="text-2xs leading-relaxed text-faint">
        每块卡片各自保存，改完哪块存哪块；主题与强调色是即时生效的。
        {health ? ` · 助手引擎：${health.assistantEngine === 'llm' ? '大模型' : '本地规则'}` : ''}
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   分区保存动作
   ══════════════════════════════════════════════════════════════════
   放在各功能区自己的动作行里。没有未保存改动时按钮禁用并显示「已保存」，
   所以一排分区里不会出现一堆永远亮着的保存按钮。 */
function SaveAction({
  dirty,
  busy,
  onSave,
  className,
}: {
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  className?: string;
}) {
  return (
    <span className={cls('flex items-center gap-2', className)}>
      {dirty ? (
        <span className="flex items-center gap-1.5 text-2xs text-warn">
          <Led tone="warn" />
          未保存
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-2xs text-faint">
          <Led tone="ok" />
          已保存
        </span>
      )}
      <Button size="sm" variant="primary" onClick={onSave} disabled={!dirty || busy}>
        {busy ? <Spinner /> : <Save size={13} aria-hidden />}
        保存
      </Button>
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════
   一行搜索源配置
   ══════════════════════════════════════════════════════════════════
   名称 + 地址两项，地址必须是带 %s 的模板。缺 %s 时行内立刻标红说明，
   而不是等按了保存才由服务端退回来 —— 那是这个配置唯一容易写错的地方。 */
function EngineRow({
  engine,
  index,
  count,
  sortable,
  isDefault,
  invalid,
  onPatch,
  onRemove,
  onMakeDefault,
}: {
  engine: SearchEngine;
  index: number;
  count: number;
  sortable: RowReorder;
  isDefault: boolean;
  invalid?: boolean;
  onPatch: (next: Partial<SearchEngine>) => void;
  onRemove: () => void;
  onMakeDefault: () => void;
}) {
  const missingPlaceholder = Boolean(engine.url.trim()) && !engine.url.includes('%s');

  return (
    <li
      {...sortable.rowProps(engine.id)}
      className={cls(
        'group relative rounded-field border bg-panel-2 p-3',
        invalid || missingPlaceholder ? 'border-crit' : 'border-line',
      )}
    >
      <DropMarker at={sortable.marker(engine.id)} />

      <div className="grid gap-2 sm:grid-cols-[1.25rem_7.5rem_minmax(0,1fr)_2.25rem] sm:items-center">
        {/* 触屏没有 HTML5 拖拽，抓手在那儿等于一个死图标 —— 小屏藏掉，
            顺序靠下面那两个箭头调，桌面端才给抓手 */}
        <DragHandle sortable={sortable} id={engine.id} className="hidden sm:block" />

        <Input
          value={engine.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="名称"
          aria-label="搜索引擎名称"
          maxLength={20}
        />
        <Input
          value={engine.url}
          onChange={(e) => onPatch({ url: e.target.value })}
          placeholder="https://www.baidu.com/s?wd=%s"
          aria-label="搜索地址模板"
          spellCheck={false}
          autoComplete="off"
          /* 地址是机器读的：等宽字体下 %s 和各个参数一眼能对上 */
          className="num text-2xs"
        />
        {/* 行内删除沿用全站约定：桌面端悬停/聚焦才显现，触屏（没有 hover）常显 */}
        <button
          type="button"
          onClick={onRemove}
          className="justify-self-center rounded-field p-2 text-faint opacity-100 transition-opacity hover:text-crit focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          aria-label={`删除搜索引擎 ${engine.name || '未命名'}`}
          title="删除该引擎"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onMakeDefault}
          disabled={isDefault}
          aria-pressed={isDefault}
          title={isDefault ? '打开首页时就用这个引擎' : '设为打开首页时默认选中的引擎'}
          className={cls(
            'rounded-full border px-2 py-0.5 text-2xs transition-colors',
            isDefault
              ? 'cursor-default border-accent/50 bg-accent-soft text-accent'
              : 'border-line text-muted hover:border-faint hover:text-ink',
          )}
        >
          {isDefault ? '首页默认' : '设为默认'}
        </button>
        {/* 上/下移推到行尾：它们和"设为默认"不是一回事，
            挤在一起会被读成一个控件组 */}
        <MoveButtons
          sortable={sortable}
          index={index}
          count={count}
          label={engine.name || '未命名'}
          className="ml-auto"
        />
        {missingPlaceholder ? (
          <span className="w-full text-2xs text-crit">地址里缺少 %s，点搜索只会打开这个固定页面</span>
        ) : null}
      </div>
    </li>
  );
}

/* ══════════════════════════════════════════════════════════════════
   一行插座配置
   ══════════════════════════════════════════════════════════════════
   常规情况只需「名称 + 功率实体」两项，实体从 HA 拉来的候选里下拉选。
   累计读数是可选的高级项，收在折叠里，不占视线。 */
function SocketRow({
  socket,
  options,
  invalid,
  onPatch,
  onRemove,
}: {
  socket: HaSocket;
  options: HaOptions | null;
  invalid?: boolean;
  onPatch: (next: Partial<HaSocket>) => void;
  onRemove: () => void;
}) {
  const list = options?.power ?? [];

  // 按设备分组，下拉里用 optgroup 呈现，同一台设备的实体聚在一起
  const groups = new Map<string, HaEntityOption[]>();
  for (const o of list) {
    const bucket = groups.get(o.group);
    if (bucket) bucket.push(o);
    else groups.set(o.group, [o]);
  }

  // 已配置但不在候选里的实体补一个选项，否则下拉会显示成空白，让人以为配置丢了
  const missingPower = Boolean(socket.powerEntity) && !list.some((o) => o.entityId === socket.powerEntity);
  const energyList = options?.energy ?? [];
  const missingCounter = Boolean(socket.counterEntity) && !energyList.some((o) => o.entityId === socket.counterEntity);

  return (
    <li className={cls('group rounded-field border bg-panel-2 p-3', invalid ? 'border-crit' : 'border-line')}>
      <div className="grid gap-2 sm:grid-cols-[8.5rem_1fr_5.5rem_2.25rem] sm:items-center">
        <Input
          value={socket.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="名称"
          aria-label="插座名称"
        />
        <Select
          value={socket.powerEntity}
          onChange={(e) => onPatch({ powerEntity: e.target.value })}
          aria-label="功率实体"
        >
          <option value="">— 选择功率实体 —</option>
          {[...groups.entries()].map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((o) => (
                <option key={o.entityId} value={o.entityId}>
                  {o.name}
                  {o.value == null ? '' : `（${o.value} ${o.unit}）`}
                </option>
              ))}
            </optgroup>
          ))}
          {missingPower ? <option value={socket.powerEntity}>{socket.powerEntity}（不在候选里）</option> : null}
        </Select>
        <span className="flex items-center justify-center gap-1.5 text-2xs text-muted">
          <Toggle
            checked={socket.enabled}
            onChange={(v) => onPatch({ enabled: v })}
            label={`${socket.name} 计入总功耗`}
          />
          <span aria-hidden>{socket.enabled ? '计入' : '不计入'}</span>
        </span>
        {/* 行内删除沿用全站约定：平时不显现，悬停或键盘聚焦时才出来，
            是图标按钮所以必须带可访问名称（WCAG 2.2 target-size ≥24px 也满足）。
            但触屏没有 hover —— 小屏必须常显，否则手机上这排插座删不掉。 */}
        <button
          type="button"
          onClick={onRemove}
          className="justify-self-center rounded-field p-2 text-faint opacity-100 transition-opacity hover:text-crit focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          aria-label={`删除插座 ${socket.name}`}
          title="删除该插座"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-2xs text-faint hover:text-muted">
          高级：累计电量读数（可选，仅当所有插座都提供时才采用）
        </summary>
        <div className="mt-2">
          <Select
            value={socket.counterEntity}
            onChange={(e) => onPatch({ counterEntity: e.target.value })}
            aria-label="累计电量实体"
          >
            <option value="">— 不配置 —</option>
            {energyList.map((o) => (
              <option key={o.entityId} value={o.entityId}>
                {o.name}
                {o.value == null ? '' : `（${fmtEnergy(o.value)}）`}
              </option>
            ))}
            {missingCounter ? <option value={socket.counterEntity}>{socket.counterEntity}（不在候选里）</option> : null}
          </Select>
        </div>
      </details>

      {invalid ? (
        <p className="mt-2 flex items-center gap-1.5 text-2xs text-crit">
          <Led tone="crit" />
          还没选功率实体，这一路不会被统计——选一个再保存。
        </p>
      ) : null}
    </li>
  );
}

/* ══════════════════════════════════════════════════════════════════
   登录：改密码
   ══════════════════════════════════════════════════════════════════ */

/**
 * 改密码。要核对当前口令 —— 解锁的电脑上有人点开设置就能改掉密码，
 * 那这道登录门就白设了。
 *
 * 改完服务端会换发一张新会话 cookie：会话签名密钥掺了凭据指纹，
 * 于是**其它设备上的登录立刻失效**，而当前这台不会把自己踢下线。
 */
function PasswordForm({ enabled }: { enabled: boolean }) {
  const { notify } = useStore();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = Boolean(confirm) && next !== confirm;
  const ready = enabled && Boolean(current) && next.length >= 6 && next === confirm && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      notify('密码已更新，其它设备上的登录已失效');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      notify(err instanceof Error ? err.message : '修改失败', 'crit');
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <p className="rounded-xl2 border border-line bg-panel-2 px-3.5 py-2.5 text-2xs leading-relaxed text-muted">
        还没有开启登录。在服务器上给 <code className="num">.env</code> 加一行
        <code className="num"> AUTH_PASSWORD=你的密码</code>，重启服务后就能登录，
        之后在这个位置改密码、不必再动 .env。
      </p>
    );
  }

  return (
    <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit}>
      <Field label="当前密码">
        <Input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="••••••••"
        />
      </Field>
      <Field label="新密码" hint="至少 6 位">
        <Input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="••••••••"
        />
      </Field>
      <Field
        label="确认新密码"
        hint={mismatch ? <span className="text-crit">两次输入不一致</span> : '改完其它设备会被登出'}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
        />
      </Field>
      <div className="sm:col-span-3">
        <Button type="submit" size="sm" variant="primary" disabled={!ready}>
          {busy ? <Spinner /> : <Save size={13} />}
          修改密码
        </Button>
      </div>
    </form>
  );
}

/**
 * 登录页背景预览。必须要有：登录页此刻看不到（人已经登进来了），
 * 没有这个框，遮罩和虚化两个滑块就是盲调。
 */
function LoginBgPreview({ bg }: { bg: LoginBackground }) {
  const src = bg.kind === 'url' ? bg.url.trim() : bg.hasUpload ? `/api/login-background?v=${bg.uploadedAt ?? 0}` : '';
  const scrim = `rgb(var(--bg-scrim-rgb) / ${bg.overlay})`;
  // 指向"上传的图"但磁盘上没有：预览回落到画布，和登录页的实际表现一致

  return (
    <div className="relative mt-4 h-28 overflow-hidden rounded-xl2 border border-line">
      {src ? (
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `linear-gradient(${scrim}, ${scrim}), url("${src}")`,
            filter: bg.blur ? `blur(${bg.blur}px)` : undefined,
            transform: bg.blur ? 'scale(1.06)' : undefined,
          }}
        />
      ) : (
        <span className="tb-canvas absolute inset-0" />
      )}
      <span className="absolute inset-x-0 bottom-0 bg-panel/75 px-2 py-1 text-center text-2xs text-muted backdrop-blur-sm">
        预览 · 登录页看到的底图
      </span>
    </div>
  );
}
