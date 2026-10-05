import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, TriangleAlert, User } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { type LoginBackground } from '@/lib/api';
import { Spinner } from '@/components/ui';
import { DragVerify } from '@/components/DragVerify';

/* ────────────────────────────────────────────────────────────────────────
 * 登录页
 *
 * 版式照参考图：一张居中的悬浮卡片，留白给足 —— 上下各 3rem 的空白、
 * 卡片内 40px 内边距、字段之间 20px。登录页是唯一一个"没有信息量"的页面，
 * 挤在屏幕中央一小块会显得廉价，撑开之后那点内容反而立得住。
 *
 * 两处刻意的选择：
 *   · 底色直接复用工具箱那层柔彩画布（.tb-canvas）。用户设了背景照片时
 *     它会自动让位给照片，所以这里不必为登录页单独判断主题。
 *   · 登录失败只报"账号或密码不正确"，并且清空密码 + 重置滑块 ——
 *     滑块重置是必须的，否则"验证通过"的绿条会留在那儿，
 *     让人以为重试不用再过一遍。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 登录页背景。默认是内置的柔彩波浪画布；在设置里换成图片后，就按图片走。
 *
 * 遮罩用的是 --bg-scrim-rgb（浅色是白纱、深色是深蓝纱），
 * 所以同一套参数在两套主题下都压得住正文 —— 不需要在 JS 里判断当前主题。
 * blur 先放大再虚化（scale 1.06）：blur 会把边缘一起糊掉、四周露出底色。
 */
function LoginBackdrop({ bg }: { bg: LoginBackground | null }) {
  const canvas = <span aria-hidden className="tb-canvas pointer-events-none fixed inset-0 -z-10" />;
  if (!bg || bg.kind === 'canvas') return canvas;
  // 配置指向"上传的图"、磁盘上却没有（换机器、手工删过文件）时必须退回画布：
  // 否则这一页只剩一层白纱，看着像坏了
  if (bg.kind === 'upload' && !bg.hasUpload) return canvas;

  const src = bg.kind === 'url' ? bg.url.trim() : `/api/login-background?v=${bg.uploadedAt ?? 0}`;
  if (!src) return canvas;

  const scrim = `rgb(var(--bg-scrim-rgb) / ${bg.overlay})`;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center bg-no-repeat"
      style={{
        backgroundImage: `linear-gradient(${scrim}, ${scrim}), url("${src}")`,
        filter: bg.blur ? `blur(${bg.blur}px)` : undefined,
        transform: bg.blur ? 'scale(1.06)' : undefined,
      }}
    />
  );
}

export default function Login() {
  const { login, loginBackground } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [verified, setVerified] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = '登录 · 个人工作台';
  }, []);

  const canSubmit = Boolean(username.trim()) && Boolean(password) && verified && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
      setPassword('');
      setVerified(false);
      setAttempt((n) => n + 1);
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-8 sm:py-16">
      <LoginBackdrop bg={loginBackground} />

      <div className="w-full max-w-[26rem]">
        {/* 登录卡是这一页唯一的一张，让它比别人高一档。
            以前写的是 shadow-[var(--shadow-lift)]，Tailwind 把这种 var() 判成
            颜色而不是阴影，所以这句一直没生效（详见 tailwind.config 的 lift 档） */}
        <div className="panel animate-fade-rise px-5 py-7 shadow-lift sm:px-9 sm:py-10">
          <h1 className="text-[26px] font-semibold leading-tight tracking-display text-ink">登录控制台</h1>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted">请输入面板账号以继续</p>

          <form className="mt-8 space-y-5" onSubmit={submit}>
            <div>
              <label htmlFor="login-user" className="mb-2 block text-[13px] font-medium text-ink">
                用户名 <span aria-hidden className="text-crit">*</span>
              </label>
              <div className="relative">
                <User size={16} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  id="login-user"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="field h-11 pl-10 text-sm"
                />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <label htmlFor="login-pass" className="text-[13px] font-medium text-ink">
                  密码 <span aria-hidden className="text-crit">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setHint((v) => !v)}
                  aria-expanded={hint}
                  /* -my-1 py-1：把纯文字的点击区垫到 24px 以上，
                     不然手机上这一小行「忘记密码?」很难点中 */
                  className="-my-1 rounded py-1 text-2xs font-medium text-accent transition-colors hover:underline"
                >
                  忘记密码?
                </button>
              </div>
              <div className="relative">
                <KeyRound size={16} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  id="login-pass"
                  name="password"
                  type={showPass ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="field h-11 pl-10 pr-14 text-sm"
                />
                {/* 眼睛按钮与输入框之间压一条竖线：它在图上是一个独立区段，
                    不是输入框里的一个小图标 */}
                <span className="absolute right-0 top-0 grid h-11 w-11 place-items-center border-l border-line/80">
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    aria-label={showPass ? '隐藏密码' : '显示密码'}
                    aria-pressed={showPass}
                    title={showPass ? '隐藏密码' : '显示密码'}
                    className="grid h-full w-full place-items-center text-faint transition-colors hover:text-ink"
                  >
                    {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </div>
              {hint ? (
                <p className="mt-2 text-2xs leading-relaxed text-muted">
                  账号密码在服务器的 <code className="num">.env</code> 里（AUTH_USER / AUTH_PASSWORD），改完重启服务即可，不需要在这里找回。
                </p>
              ) : null}
            </div>

            {/* 失败一次就换 key 重建：滑块的"验证完成"必须重新过一遍 */}
            <DragVerify key={attempt} onVerified={() => setVerified(true)} />

            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-field border border-crit/25 bg-crit-soft px-3 py-2.5 text-2xs leading-relaxed text-crit"
              >
                <TriangleAlert size={14} aria-hidden className="mt-px shrink-0" />
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-primary h-11 w-full rounded-field border text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? <Spinner /> : null}
              登录
            </button>
          </form>
        </div>

        {/* 这里原有一行「个人工作台 · HOME LAB CONSOLE」：
            页面标题已经写着「登录控制台」，浏览器标签也写着「个人工作台」，
            这行只是把名字又摆了一遍，顺手删掉。 */}
      </div>
    </div>
  );
}
