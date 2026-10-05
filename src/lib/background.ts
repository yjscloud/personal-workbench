import type { BackgroundSettings } from './api';

/* ────────────────────────────────────────────────────────────────────────
 * 背景图的落地
 *
 * 不走 React 树，而是把结果写进 :root 的 CSS 变量 / 属性——理由和主题一样：
 * 背景是整页级的，塞进组件会让每次设置变更都重渲染整棵树。
 * 关掉时直接摘掉 data-photo，CSS 里那一整条伪元素规则就不匹配，零开销。
 * ──────────────────────────────────────────────────────────────────────── */

const root = () => document.documentElement;

function photoSrc(bg?: BackgroundSettings | null): string {
  if (!bg) return '';
  if (bg.kind === 'url') return String(bg.url || '').trim();
  if (bg.kind === 'upload' && bg.hasUpload) {
    // 带 mtime 做缓存失效：换了图浏览器不会拿旧的那张
    return `/api/background?v=${bg.uploadedAt ?? 0}`;
  }
  return '';
}

export function applyBackground(bg?: BackgroundSettings | null) {
  const el = root();
  const src = photoSrc(bg);

  if (!src) {
    el.removeAttribute('data-photo');
    el.style.removeProperty('--bg-photo');
    el.style.removeProperty('--bg-scrim');
    el.style.removeProperty('--bg-blur');
    return;
  }

  const overlay = Math.min(0.9, Math.max(0, Number(bg?.overlay) || 0));
  el.setAttribute('data-photo', 'on');
  el.style.setProperty('--bg-photo', `url("${src}")`);
  el.style.setProperty('--bg-scrim', `rgb(var(--bg-scrim-rgb) / ${overlay})`);
  el.style.setProperty('--bg-blur', `${Math.min(24, Math.max(0, Number(bg?.blur) || 0))}px`);
}
