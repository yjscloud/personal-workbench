import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Link2Off, Paperclip, Send, X } from 'lucide-react';
import { api, type PublicLinkMeta } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { Button, Card, Field, Input, Spinner, Textarea } from '@/components/ui';

/**
 * 公开提交页（/s/:token）
 *
 * 全站唯一一个**不需要登录**的页面，所以刻意不套 AppShell、不碰 store：
 * 它只依赖两个公开接口（读元信息、提交），拿不到任何面板数据。
 *
 * 页面上不出现令牌、不出现内部任务号、也不加载任何第三方资源 ——
 * token 就在地址栏里，任何外链请求都会把它带进 Referer。
 */

/* ── 附件 ───────────────────────────────────────────────────────────
   与后端白名单一一对应。这里先挡一道只是为了省一次往返，
   真正的把关在 services/public-links.js 的 cleanAttachments。 */
const MAX_FILES = 3;
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip';

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/zip',
]);

/** 有些系统给 .docx 的 type 是空串，按扩展名补一个 */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  zip: 'application/zip',
};

type Picked = { name: string; mime: string; size: number; content: string };

function mimeOf(file: File) {
  if (file.type && ALLOWED_MIME.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return EXT_MIME[ext] || file.type || '';
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 压一下再传。
 *
 * 手机直出的照片动辄 3~5MB，而外链的上限是单个 1.5MB —— 如果不在这里压，
 * 「拍一张图提交」就会变成「先自己找工具缩图」，这是移动端最容易劝退的一步。
 * 长边超过 2000px 或体积超过 1.2MB 的图片统一缩到 2000px、转 webp，
 * 再逐档降质量直到塞进上限。GIF 不动（会丢动画）。
 */
async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  if (file.size <= MAX_FILE_BYTES * 0.8) return file;

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let quality = 0.9;
    let blob: Blob | null = null;
    while (quality >= 0.5) {
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
      if (blob && blob.size <= MAX_FILE_BYTES * 0.92) break;
      quality -= 0.1;
    }
    if (!blob) return file;
    /* 压完反而更大（小图常见）就别换了 */
    if (blob.size >= file.size && scale === 1) return file;

    const type = blob.type || 'image/webp';
    const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : 'webp';
    const base = file.name.replace(/\.[^.]+$/, '') || '图片';
    return new File([blob], `${base}.${ext}`, { type });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 记住上次填的称呼和联系方式。
 *
 * 存在浏览器本地、按 token 分开：一条链接对应一个项目，互不串味；
 * 换链接（token 变了）就当作新的人，重新填一次。
 * 只记这两个字段 —— 标题和正文每次都该重写，记住反而添乱。
 */
function identityKey(token: string) {
  return `wb.pub-identity.${token}`;
}

function loadIdentity(token: string): { submitter: string; contact: string } {
  try {
    const raw = localStorage.getItem(identityKey(token));
    if (!raw) return { submitter: '', contact: '' };
    const data = JSON.parse(raw) as { submitter?: unknown; contact?: unknown };
    return {
      submitter: typeof data.submitter === 'string' ? data.submitter.slice(0, 40) : '',
      contact: typeof data.contact === 'string' ? data.contact.slice(0, 120) : '',
    };
  } catch {
    return { submitter: '', contact: '' };
  }
}

function saveIdentity(token: string, submitter: string, contact: string) {
  try {
    if (!submitter && !contact) localStorage.removeItem(identityKey(token));
    else localStorage.setItem(identityKey(token), JSON.stringify({ submitter, contact }));
  } catch {
    /* 隐私模式下 localStorage 会直接抛错：记不住就算了，不能因此挡住提交 */
  }
}

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

export default function PublicSubmit() {
  const { token = '' } = useParams();
  const [meta, setMeta] = useState<PublicLinkMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState<string | null>(null);

  const [identity] = useState(() => loadIdentity(token));
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [submitter, setSubmitter] = useState(identity.submitter);
  const [contact, setContact] = useState(identity.contact);
  const [due, setDue] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  /** 超过大小上限、还没被替换掉的文件。挡着提交，直到用户重新选或明确放弃 */
  const [fileIssues, setFileIssues] = useState<{ name: string; size: number }[]>([]);
  /** 类型不对、数量超了这类一次性提示：不需要用户"修好再传"，换一个文件就行 */
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  /** 拖拽悬停高亮。移动端用不到，桌面端拖文件进来时要给点反馈 */
  const [dragging, setDragging] = useState(false);
  /** 这份浏览器里是否存着上次的身份，only 用来决定要不要显示"已记住"那一行 */
  const [remembered, setRemembered] = useState(Boolean(identity.submitter || identity.contact));
  /** 蜜罐：正常用户看不见也摸不到，脚本会顺手填上 */
  const [website, setWebsite] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /* 从打开页面到点提交的毫秒数。服务端拿它挡"1 秒内填完"的脚本；
     刷新页面或「再提交一条」时重置 */
  const openedAt = useRef(Date.now());

  /* 日期框的最小值：今天。后端不校验过去，这里挡一下是免得选了才发现 */
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.publicSubmit
      .meta(token)
      .then((data) => {
        if (!alive) return;
        setMeta(data);
        setGone(null);
        document.title = `提交任务 · ${data.label || data.project}`;
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setGone(err instanceof Error ? err.message : '链接无效或已关闭');
        document.title = '链接已关闭';
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  function reset() {
    /* 称呼和联系方式**不清**：同一个人接下来多半还要再提一条 */
    setTitle('');
    setNote('');
    setDue('');
    setFiles([]);
    setFileIssues([]);
    setFileNotice(null);
    setWebsite('');
    setError(null);
    setDone(false);
    openedAt.current = Date.now();
  }

  function forget() {
    saveIdentity(token, '', '');
    setSubmitter('');
    setContact('');
    setRemembered(false);
  }

  /** 选文件、粘贴、拖拽三条路都汇到这里：校验 → 压缩 → 读成 data URL */
  async function addFiles(picked: File[]) {
    if (!picked.length) return;

    setFileNotice(null);
    const room = MAX_FILES - files.length;
    if (room <= 0) {
      setFileNotice(`最多 ${MAX_FILES} 个附件，先删一个再加`);
      return;
    }

    const accepted: Picked[] = [];
    /* 超过上限的单独记下来：它们不是"提示一下就算了"，而是要用户去压缩重传 */
    const oversized: { name: string; size: number }[] = [];
    let problem: string | null = null;
    for (const raw of picked.slice(0, room)) {
      const file = await compressImage(raw);
      const mime = mimeOf(file);
      if (!ALLOWED_MIME.has(mime)) {
        problem = `「${raw.name}」的类型不接受；只收图片、Word / Excel / PPT、PDF、txt、zip`;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        oversized.push({ name: raw.name, size: file.size });
        continue;
      }
      try {
        accepted.push({ name: file.name, mime, size: file.size, content: await readDataUrl(file) });
      } catch {
        problem = `「${raw.name}」读取失败`;
      }
    }
    if (picked.length > room) problem = `最多 ${MAX_FILES} 个附件，多出来的没有加进去`;
    setFileNotice(problem);
    setFileIssues(oversized);
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
  }

  async function pickFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files || []);
    /* 清空 value：同一个文件删掉后再选一次，change 才会再触发 */
    event.target.value = '';
    await addFiles(picked);
  }

  /**
   * 直接 Ctrl/Cmd+V 粘截图。
   *
   * 只有剪贴板里真的带文件时才接管，纯文字粘贴仍然交给输入框自己处理 ——
   * 否则用户想把一段文字粘进「说明」会发现粘不进去。
   */
  function handlePaste(event: React.ClipboardEvent) {
    const items = Array.from(event.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer?.files || []);
    if (dropped.length) void addFiles(dropped);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('先写一句标题');
      return;
    }
    if (!contact.trim()) {
      setError('请填写联系方式 —— 推荐填邮箱，任务完成时会收到邮件通知');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const who = submitter.trim();
      const how = contact.trim();
      await api.publicSubmit.submit(token, {
        title: cleanTitle,
        note: note.trim(),
        submitter: who,
        contact: how,
        due: due || undefined,
        attachments: files.map((f) => ({ name: f.name, mime: f.mime, content: f.content })),
        website,
        elapsedMs: Date.now() - openedAt.current,
      });
      saveIdentity(token, who, how);
      setRemembered(Boolean(who || how));
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg px-3 py-6 sm:px-4 sm:py-16">
      {/* 手机上左右各 12px 就够：再宽一点表单就只剩一条缝；
          桌面端放宽到 max-w-2xl，说明框能写开 */}
      <div className="mx-auto w-full max-w-lg sm:max-w-2xl">
        <header className="mb-4 sm:mb-5">
          <p className="text-2xs tracking-wide text-faint">个人工作台</p>
          <h1 className="mt-1 text-xl font-semibold tracking-display">提交任务</h1>
          {meta ? (
            <p className="mt-2 text-sm text-muted">
              提交后直接进入「{meta.label || meta.project}」的任务看板
              {meta.section ? ` · ${meta.section}` : ''}
            </p>
          ) : null}
        </header>

        <Card>
          {loading ? (
            <div className="grid place-items-center py-16">
              <Spinner className="h-5 w-5 text-faint" />
            </div>
          ) : gone ? (
            <div className="py-12 text-center">
              <Link2Off size={22} className="mx-auto text-faint" aria-hidden />
              <p className="mt-3 text-sm font-medium">链接无效或已关闭</p>
              <p className="mt-1.5 text-2xs leading-relaxed text-faint">
                这条提交入口已经停用、过期或收满了，请联系发链接给你的人重新获取。
              </p>
            </div>
          ) : done ? (
            <div className="py-10 text-center">
              <CheckCircle2 size={26} className="mx-auto text-ok" aria-hidden />
              <p className="mt-3 text-sm font-medium">已收到</p>
              <p className="mt-1.5 text-2xs leading-relaxed text-faint">
                任务已经进入「{meta?.label || meta?.project}」，不需要再发一遍。
                <br />
                这条链接可以继续用；刚才填的称呼和联系方式已经记住，下次不用再填。
                {isEmail(contact) ? (
                  <>
                    <br />
                    任务完成时会发一封邮件到 {contact.trim()}。
                  </>
                ) : null}
              </p>
              <Button variant="soft" size="sm" className="mt-4" onClick={reset}>
                再提交一条
              </Button>
            </div>
          ) : (
            <form
              onSubmit={submit}
              noValidate
              /* 粘贴和拖拽都挂在表单上：焦点在标题 / 说明 / 页面空白处都能收到图 */
              onPaste={handlePaste}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`rounded-field transition-shadow ${dragging ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''}`}
            >
              <div className="space-y-4">
                <Field label="标题" hint="一句话说清要做什么">
                  <Input
                    /* text-base：移动端输入框字号 <16px 时，iOS 会在聚焦瞬间放大整页 */
                    className="text-base sm:text-sm"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    placeholder="例如：三楼会议室的投影仪连不上"
                    autoFocus
                  />
                </Field>

                <Field label="说明" hint="背景、期望结果都可以写在这里；截图可以直接 Ctrl / Cmd+V 粘进来">
                  <Textarea
                    className="min-h-[180px] text-base sm:min-h-[260px] sm:text-sm"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={5000}
                    rows={8}
                    placeholder="越具体越好，但不必写成公文"
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="怎么称呼你">
                    <Input
                      className="text-base sm:text-sm"
                      name="name"
                      autoComplete="name"
                      value={submitter}
                      onChange={(e) => setSubmitter(e.target.value)}
                      maxLength={40}
                      placeholder="选填"
                    />
                  </Field>
                  <Field label="期望完成时间" hint="不填就是不设截止">
                    <Input
                      className="text-base sm:text-sm"
                      type="date"
                      min={today}
                      value={due}
                      onChange={(e) => setDue(e.target.value)}
                    />
                  </Field>
                </div>

                <Field label="联系方式（必填）" hint="推荐填邮箱：任务完成时会发一封邮件通知你">
                  <Input
                    className="text-base sm:text-sm"
                    name="contact"
                    autoComplete="email"
                    required
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    maxLength={120}
                    placeholder="例如：you@example.com"
                  />
                </Field>

                {remembered ? (
                  <p className="text-2xs text-faint">
                    已记住上次填的称呼和联系方式，下次不用再填。
                    <button type="button" onClick={forget} className="ml-1 underline underline-offset-2 hover:text-ink">
                      清除
                    </button>
                  </p>
                ) : null}

                {/* 附件：先选进本地列表，提交时随表单一次性发走（data URL） */}
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted">附件</p>
                      <p className="mt-1 text-2xs leading-relaxed text-faint">
                        截图可以直接粘（Ctrl / Cmd+V）或拖进来；也支持图片、Word / Excel / PPT、PDF、txt、zip。
                        最多 {MAX_FILES} 个，单个 1.5MB，大图会自动压缩。
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="soft"
                      className="h-10 shrink-0 sm:h-8"
                      onClick={() => fileRef.current?.click()}
                      disabled={files.length >= MAX_FILES}
                    >
                      <Paperclip size={14} aria-hidden />
                      添加
                    </Button>
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept={ACCEPT}
                    className="hidden"
                    onChange={(e) => void pickFiles(e)}
                  />

                  {files.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {files.map((file, index) => (
                        <li
                          key={`${file.name}-${index}`}
                          className="flex items-center gap-2 rounded-field border border-line bg-panel-2 px-2 py-2 sm:py-1.5"
                        >
                          {file.mime.startsWith('image/') ? (
                            <img
                              src={file.content}
                              alt=""
                              className="h-10 w-10 shrink-0 rounded-xs object-cover sm:h-8 sm:w-8"
                            />
                          ) : (
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xs bg-bg-3 text-2xs text-faint sm:h-8 sm:w-8">
                              {file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-2xs text-ink">{file.name}</span>
                          <span className="num shrink-0 text-2xs text-faint">{fmtBytes(file.size)}</span>
                          <button
                            type="button"
                            aria-label={`移除 ${file.name}`}
                            onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                            /* 44px 是拇指能稳稳点中的下限，桌面端再收回 28px */
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-xs text-faint hover:bg-bg-3 hover:text-ink sm:h-7 sm:w-7"
                          >
                            <X size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {fileIssues.length ? (
                    <div className="mt-2 rounded-field bg-warn-soft px-3 py-2">
                      {fileIssues.map((issue) => (
                        <p key={`${issue.name}-${issue.size}`} className="text-2xs leading-relaxed text-warn">
                          「{issue.name}」{fmtBytes(issue.size)}，超过 1.5MB 上限，请压缩后重新上传。
                        </p>
                      ))}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" variant="soft" onClick={() => fileRef.current?.click()}>
                          重新选择
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setFileIssues([])}>
                          先不传这个文件
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {fileNotice ? <p className="mt-1.5 text-2xs text-warn">{fileNotice}</p> : null}
                </div>

                {/* 蜜罐。用绝对定位挪出视口而不是 display:none —— 有些脚本会跳过隐藏元素 */}
                <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
                  <label>
                    网站
                    <input
                      name="website"
                      tabIndex={-1}
                      autoComplete="off"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                    />
                  </label>
                </div>
              </div>

              {error ? (
                <p className="mt-4 rounded-field bg-crit-soft px-3 py-2 text-2xs leading-relaxed text-crit">{error}</p>
              ) : null}

              <div className="mt-5 flex flex-col gap-2.5 border-t border-line pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                {/* 手机上整行按下去最稳，桌面端保持普通宽度 */}
                <Button
                  type="submit"
                  variant="primary"
                  className="h-11 w-full sm:h-10 sm:w-auto"
                  disabled={busy || !title.trim() || !contact.trim() || fileIssues.length > 0}
                >
                  {busy ? <Spinner className="h-3.5 w-3.5" /> : <Send size={14} aria-hidden />}
                  提交任务
                </Button>
                <p className="text-2xs leading-relaxed text-faint">
                  {fileIssues.length ? '有附件超过大小上限，处理好之后才能提交。' : '提交后不需要登录，也看不到其他人的提交。'}
                </p>
              </div>
            </form>
          )}
        </Card>

        <p className="mt-4 text-2xs leading-relaxed text-faint">
          这个页面不需要账号。链接本身就是凭据，请只在需要收任务的范围内转发。
        </p>
      </div>
    </div>
  );
}
