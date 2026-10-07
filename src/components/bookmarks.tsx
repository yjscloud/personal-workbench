import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { bookmarkIconUrl, type Bookmark } from '@/lib/api';
import { cls, faviconSources } from '@/lib/format';
import { avatarGradient, avatarHue, monogram } from '@/lib/tint';
import { Button, Field, Input, Led, Modal, Select, Spinner, Toggle } from './ui';

/* 书签相关的公共件：首页「常用网站」和「工具箱」页共用同一套，
   避免两处各写一份表单和图标回落逻辑。 */

/** 网站图标：底层永远是首字母色块，favicon 加载成功才盖上去。
   取不到就留首字母，不会出现裂图或空方块。 */
export function SiteIcon({
  bookmark,
  size = 36,
  fill = false,
}: {
  bookmark: Bookmark;
  size?: number;
  /** 满铺模式：favicon 放大到几乎占满、去掉描边与底色。
      工具箱那种密集图标墙要的是图标本身；套一层浅色方块只会得到
      "小图挤在大框里"的效果，一屏几十个看起来全是空框。 */
  fill?: boolean;
}) {
  /* 两档候选同时加载：
     · own      —— 站点自己的图标，内网面板只有这条路走得通，而且是真图标；
     · fallback —— 聚合服务，公网站点常常连不上自己的图标（GitHub 的实测 6 秒超时），靠它兜底。
     串行试是不行的，总有一类要白等一次超时。 */
  /* 用户自己上传的图标**优先于 favicon**：他传这张图就是因为不满意自动取的那张，
     再去猜一次站点的心意只会盖掉刚上传的东西。 */
  const custom = bookmark.hasIcon && bookmark.id ? bookmarkIconUrl(bookmark.id) : '';
  const { own, fallback } = useMemo(() => faviconSources(bookmark.url), [bookmark.url]);
  const ownRefs = useRef<(HTMLImageElement | null)[]>([]);
  const fbRefs = useRef<(HTMLImageElement | null)[]>([]);
  const customRef = useRef<HTMLImageElement | null>(null);
  const [ownHit, setOwnHit] = useState(-1);
  const [fbHit, setFbHit] = useState(-1);
  const [customHit, setCustomHit] = useState(-1);
  /* 优先窗口：own 通常几十毫秒就有结果，而聚合服务对内网域名不会失败，
     而是回一张通用"地球"图 —— 它要是立刻算数，就会把人家自己的真图标顶掉。
     缓 1.2 秒，给 own 一个先手。 */
  const [grace, setGrace] = useState(false);

  const inner = Math.round(size * (fill ? 0.96 : 0.56));
  /* 抓不到 favicon 时的兜底：生成一枚"应用图标"（品牌色渐变方块 + 首字母），
     而不是一个灰字母。颜色取自工具自己，所以同一面墙上每个入口都有自己的色 */
  const hue = avatarHue(bookmark);
  const glyph = monogram(bookmark.name);
  const glyphSize = Math.round(size * (fill ? 0.44 : 0.42));
  const radius = Math.round(size * 0.3);

  /* own 一旦有结果就永远优先，哪怕它比 fallback 晚到 —— 真图标值得等。
     那一次切换在实际观感里几乎看不见（内网的 own 都在百毫秒内回来）。 */
  const shown: { kind: 'custom' | 'own' | 'fb'; i: number } | null =
    customHit >= 0
      ? { kind: 'custom', i: 0 }
      : ownHit >= 0
        ? { kind: 'own', i: ownHit }
        : grace && fbHit >= 0
          ? { kind: 'fb', i: fbHit }
          : null;
  const loaded = shown !== null;

  useEffect(() => {
    setOwnHit(-1);
    setFbHit(-1);
    setCustomHit(-1);
    setGrace(false);
    const timer = window.setTimeout(() => setGrace(true), 1200);
    /* 还要主动查一遍已完成的图片：它可能在本组件挂载之前就加载好了
       （列表复用、浏览器缓存都会这样），此时 onLoad 不会再触发，
       只靠事件会永远停在首字母上 —— 实测正是这个原因导致图标"加载成功却不显示"。 */
    const oi = ownRefs.current.findIndex((el) => el !== null && el.complete && el.naturalWidth > 0);
    if (oi >= 0) setOwnHit(oi);
    const fi = fbRefs.current.findIndex((el) => el !== null && el.complete && el.naturalWidth > 0);
    if (fi >= 0) setFbHit(fi);
    return () => window.clearTimeout(timer);
  }, [bookmark.url, custom, own, fallback]);

  /** 两档共用的图片渲染：都挂上，各自记录命中 */
  const tier = (list: string[], refs: typeof ownRefs, setHit: typeof setOwnHit, kind: 'own' | 'fb') =>
    list.map((s, i) => (
      <img
        key={s}
        ref={(el) => {
          refs.current[i] = el;
        }}
        src={s}
        alt=""
        width={inner}
        height={inner}
        loading="lazy"
        // 同一档里先到的算数
        onLoad={() => setHit((v) => (v < 0 ? i : v))}
        className="absolute inset-0 m-auto transition-opacity duration-150"
        style={{ opacity: shown?.kind === kind && shown.i === i ? 1 : 0 }}
      />
    ));

  return (
    <span
      className={cls('relative grid shrink-0 place-items-center', fill ? '' : 'overflow-hidden border border-line')}
      // 满铺模式下不画底框：图标自己撑满，favicon 一到就直接落在磁贴的柔彩底上
      style={{ width: size, height: size, borderRadius: radius, background: fill ? 'transparent' : 'var(--accent-soft)' }}
    >
      {/* 生成图标：favicon 没到（或根本取不到）时它就是最终形态，
          一旦真图标加载出来就淡出 —— 两层的切换只在 opacity 上，不重排 */}
      <span
        aria-hidden
        className="absolute inset-0 grid place-items-center transition-opacity duration-200"
        style={{ borderRadius: 'inherit', opacity: loaded ? 0 : 1, ...avatarGradient(hue) }}
      >
        <span className="num font-semibold text-white" style={{ fontSize: glyphSize, letterSpacing: '0.02em' }}>
          {glyph}
        </span>
      </span>
      {/* 自定义图标不走 tier()：它只有一张，且没有"候选列表"那回事 */}
      {custom ? (
        <img
          ref={(el) => {
            customRef.current = el;
          }}
          src={custom}
          alt=""
          width={inner}
          height={inner}
          loading="lazy"
          onLoad={() => setCustomHit(0)}
          onError={() => setCustomHit(-1)}
          className="absolute inset-0 m-auto object-contain transition-opacity duration-150"
          style={{ opacity: shown?.kind === 'custom' ? 1 : 0 }}
        />
      ) : null}
      {tier(own, ownRefs, setOwnHit, 'own')}
      {tier(fallback, fbRefs, setFbHit, 'fb')}
    </span>
  );
}

/* ── 自定义图标上传 ────────────────────────────────────────────────── */

/** 与服务端 routes.js 的 ICON_MAX 一致 —— 两边各写一个数，迟早有一边先被突破 */
const ICON_MAX = 256 * 1024;
const ICON_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif';

/** data URL 里的实际字节数（base64 约占 4/3） */
function base64Bytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Math.floor((dataUrl.length - i - 1) * 0.75);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('这张图读不出来，换一张试试'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这张图解不开，换 PNG 或 JPG 试试'));
    img.src = src;
  });
}

/**
 * 读成 data URL；超过上限先缩到 128px 再导出。
 *
 * 不缩图不行：用户从桌面随手挑一张截图动辄两三 MB，原样塞进去既撑大写请求，
 * 也让这一条记录很快就变得不合理 —— 而图标真正需要的分辨率只有几十像素。
 */
async function fileToIcon(file: File): Promise<string> {
  const raw = await readAsDataUrl(file);
  if (base64Bytes(raw) <= ICON_MAX) return raw;
  const img = await loadImage(raw);
  const side = 128;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('这个浏览器不支持缩图，请换一张小一点的图片');
  ctx.drawImage(img, 0, 0, side, side);
  const out = canvas.toDataURL('image/png');
  const bytes = base64Bytes(out);
  if (bytes > ICON_MAX) throw new Error(`缩到 128×128 仍有 ${Math.ceil(bytes / 1024)}KB，超过 ${ICON_MAX / 1024}KB`);
  return out;
}

export function BookmarkModal({
  open,
  bookmark,
  groups,
  defaultGroup,
  onClose,
  onSave,
}: {
  open: boolean;
  bookmark: Bookmark | null;
  groups: { id: string; name: string }[];
  defaultGroup?: string;
  onClose: () => void;
  onSave: (payload: Partial<Bookmark>) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [group, setGroup] = useState(defaultGroup ?? '');
  const [note, setNote] = useState('');
  /** 品牌色：磁贴用它染色，空串表示"用色板自动配色" */
  const [color, setColor] = useState('');
  /**
   * 常用：标了才出现在首页「常用网站」。
   *
   * 它由这个弹窗负责，而不是磁贴上的星标按钮 —— 工具箱是一面几十张的入口墙，
   * 每张都挂一颗状态星，读起来像满屏通知点，而"哪些已标过"在找入口时并不需要。
   * 放进弹窗还有一个好处：首页与工具箱共用这个弹窗，两处都能改，
   * 不必要求用户先回到某一页才能标。
   */
  const [pinned, setPinned] = useState(false);
  /**
   * 自定义图标。**null = 这一项没动过** —— 与"空串 = 清除"区分开：
   * 编辑一个没上传过图标的书签时，不该顺手把它已有的图标清掉。
   */
  const [icon, setIcon] = useState<string | null>(null);
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 每次打开时同步表单初值
  const [syncKey, setSyncKey] = useState<string | null>(null);
  const key = `${open}-${bookmark?.id ?? 'new'}`;
  if (open && syncKey !== key) {
    setSyncKey(key);
    setName(bookmark?.name ?? '');
    setUrl(bookmark?.url ?? '');
    setGroup(bookmark?.group ?? defaultGroup ?? groups[0]?.id ?? '');
    setNote(bookmark?.note ?? '');
    setColor(bookmark?.color ?? '');
    setPinned(Boolean(bookmark?.pinned));
    setIcon(null);
    setIconError('');
  }
  if (!open && syncKey !== null) setSyncKey(null);

  /* 图标那一格的预览：刚选的直接看data URL，已存的走接口取，
     两者都没有就拿当前名称/网址渲染一次自动取图的样子 */
  const preview: Bookmark = { id: '', name: name || '?', url: url || '', group, note: '', color };
  const savedIcon = !icon && bookmark?.hasIcon && bookmark.id ? bookmarkIconUrl(bookmark.id) : '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bookmark ? '编辑工具' : '添加工具'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim() || !url.trim()}
            onClick={async () => {
              setBusy(true);
              await onSave({
                name: name.trim(),
                url: url.trim(),
                group,
                note: note.trim(),
                color: color.trim(),
                pinned,
                ...(icon === null ? {} : { icon }),
              });
              setBusy(false);
            }}
          >
            {busy ? <Spinner /> : null}
            保存
          </Button>
        </>
      }
    >
      <Field label="名称">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Grafana" />
      </Field>
      <Field label="网址" hint="内网地址也可以，不带协议会自动补 http://">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://grafana.home.local:3000" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="分类">
          <Select value={group} onChange={(e) => setGroup(e.target.value)}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="备注">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
        </Field>
      </div>

      {/* 常用开关。说明写在开关左边而不是塞进 label 里：
          「常用」这两个字本身看不出后果，必须紧跟着说清楚它意味着
          "会出现在首页"，否则用户不敢打开（也不知道打开有什么用）。
          这一行用的是设置页里"开关 + 说明"的同一种排布。 */}
      <div className="flex items-center justify-between gap-4 rounded-field bg-bg-2 px-3 py-2.5">
        <div>
          <p className="text-[13px]">设为常用</p>
          <p className="text-2xs text-faint">打开后会出现在首页的「常用网站」，随时可以在这里关掉</p>
        </div>
        <Toggle checked={pinned} onChange={setPinned} label={`设为常用：${name || '这个网站'}`} />
      </div>

      {/* 品牌色：工具箱的磁贴按它染色。留空就用糖纸色板，
          「同步站点配色」会自动把它填成站点自己的主题色 */}
      <Field label="品牌色" hint="留空 = 自动配色（糖纸色板）。清空即可让该工具回到自动状态。">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color || '#7c8fa6'}
            onChange={(e) => setColor(e.target.value)}
            aria-label="选择品牌色"
            className="h-9 w-11 shrink-0 cursor-pointer rounded-field border border-line bg-bg-2 p-1"
          />
          <Input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="留空 = 自动，例如 #E57000"
            className="num min-w-0 flex-1"
          />
          {color ? (
            <Button size="sm" variant="ghost" onClick={() => setColor('')} title="改回自动配色">
              清除
            </Button>
          ) : null}
        </div>
      </Field>

      {/* 自定义图标。留空 = 自动取站点 favicon，取不到就是首字母色块 */}
      <Field label="图标" hint="支持 PNG / JPG / GIF / WebP / AVIF，超过 256KB 会自动缩到 128px。不上传则自动取 favicon">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center">
            {icon || savedIcon ? (
              <img
                src={icon || savedIcon}
                alt=""
                /* 预览图不该随表单重渲染反复解码：data URL 每次都是新字符串，
                   不固化的话，选一次图会重绘好几遍 */
                className="h-9 w-9 rounded-field object-contain"
              />
            ) : (
              <SiteIcon bookmark={preview} size={36} />
            )}
          </span>

          <input
            ref={fileRef}
            type="file"
            accept={ICON_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              /* 清掉 input.value：否则连续选同一张文件时 change 不再触发 */
              e.target.value = '';
              if (!file) return;
              setIconBusy(true);
              setIconError('');
              fileToIcon(file)
                .then((data) => setIcon(data))
                .catch((err) => setIconError(err instanceof Error ? err.message : '这张图用不了'))
                .finally(() => setIconBusy(false));
            }}
          />

          <Button size="sm" variant="soft" disabled={iconBusy} onClick={() => fileRef.current?.click()}>
            {iconBusy ? <Spinner /> : <Upload size={13} aria-hidden />}
            上传图片
          </Button>
          {icon !== null || bookmark?.hasIcon ? (
            <Button size="sm" variant="ghost" onClick={() => setIcon('')} title="清除自定义图标，回到自动 favicon">
              清除
            </Button>
          ) : null}
        </div>
        {iconError ? (
          <p className="mt-2 flex items-start gap-1.5 text-2xs leading-relaxed text-crit">
            <Led tone="crit" />
            {iconError}
          </p>
        ) : null}
      </Field>
    </Modal>
  );
}
