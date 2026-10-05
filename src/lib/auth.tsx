import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, type LoginBackground } from './api';

/* ────────────────────────────────────────────────────────────────────────
 * 登录状态
 *
 * 三件事都在这里解决，页面本身不需要知道登录的存在：
 *   · 启动时问一次 /api/auth/me：要不要登录、我登了没；
 *   · 任何接口收到 401（会话过期 / 服务端重启换了密钥）→ 广播 auth:expired
 *     被这里接住，直接退回登录页 —— 否则页面会停在"看着正常、点什么都报错"；
 *   · 关掉登录（服务端没设 AUTH_PASSWORD）时整条链路透明，页面照常直接进。
 *
 * 状态只有一份、放在最外层：AppProvider（业务数据）挂在它下面，
 * 这样未登录时一个业务接口都不会发出去 —— 少一次必然 401 的往返，
 * 也不会在登录页上弹一排红色的失败提示。
 * ──────────────────────────────────────────────────────────────────────── */

type AuthValue = {
  /** 首次询问服务端是否结束 */
  ready: boolean;
  /** 服务端是否开启了登录 */
  enabled: boolean;
  /** 当前登录的用户名，null = 未登录 */
  user: string | null;
  /** 登录页自己的背景配置。随 /auth/me 一起回来，所以登录页不会先闪一下默认底色 */
  loginBackground: LoginBackground | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [loginBackground, setLoginBackground] = useState<LoginBackground | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .auth.me()
      .then((me) => {
        if (!alive) return;
        setEnabled(me.enabled);
        setUser(me.user);
        setLoginBackground(me.loginBackground ?? null);
      })
      .catch(() => {
        /* 问不到（服务没起来 / 反代挂了）就先当作开放：真正的拦截在服务端，
           前端硬拦只会把"服务不可用"显示成"请登录"，反而更难排查 */
        if (alive) setEnabled(false);
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.auth.login(username, password);
    setEnabled(true);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      // 请求失败也要退出去：本地不退，页面会停在"已是未登录但还显示着数据"的怪状态
      setUser(null);
      // 顺手把登录页的配置再问一遍：刚在设置里换过登录页背景的话，
      // 退出后看到的就是新的那张，不必再刷一次页面
      void api.auth
        .me()
        .then((me) => setLoginBackground(me.loginBackground ?? null))
        .catch(() => {});
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ ready, enabled, user, loginBackground, login, logout }),
    [ready, enabled, user, loginBackground, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
