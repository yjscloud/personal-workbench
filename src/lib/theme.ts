export type ThemeMode = 'dark' | 'light';
/** azure = 科技蓝（浅色科技风的默认强调色） */
export type AccentName = 'azure' | 'signal' | 'copper' | 'violet';

const KEY = 'workbench:theme';

type Stored = { mode: ThemeMode; accent: AccentName };

export function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (parsed?.mode && parsed?.accent) return parsed;
  } catch {
    /* 忽略损坏的本地存储 */
  }
  return null;
}

export function applyTheme(mode: ThemeMode, accent: AccentName) {
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.setAttribute('data-accent', accent);
  root.style.colorScheme = mode;
  try {
    localStorage.setItem(KEY, JSON.stringify({ mode, accent }));
  } catch {
    /* 隐私模式下可能不可写 */
  }
}

export function initialTheme(): Stored {
  const stored = readStored();
  if (stored) return stored;
  // 默认浅色科技风；用户若手动切换过则以本地存储为准
  return { mode: 'light', accent: 'azure' };
}

/** 主题切换：在根节点上做一次 180ms 的淡变，避免突兀闪变 */
export function switchTheme(mode: ThemeMode, accent: AccentName) {
  const root = document.documentElement;
  root.style.transition = 'background-color 180ms ease, color 180ms ease';
  applyTheme(mode, accent);
  window.setTimeout(() => {
    root.style.transition = '';
  }, 200);
}
