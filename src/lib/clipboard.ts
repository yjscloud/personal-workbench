/**
 * 复制文本。
 *
 * 不能用 navigator.clipboard 了事：它要求**安全上下文**，而这块面板默认就跑在
 * 局域网 http 上（见 README 的部署说明），那里 navigator.clipboard 直接是
 * undefined —— 只用它的话「复制」按钮等于摆设。所以留一条 execCommand 兜底，
 * 那条在这种环境里反而是能用的。
 *
 * 放在 lib 里而不是组件内部：MarkdownBody（懒加载的重块）和知识库阅读页
 * 都要用它，写在其中一个里面就会把那一整块拖进首屏 chunk。
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 权限被拒就往下走兜底 */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
