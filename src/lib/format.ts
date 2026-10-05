export function cls(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function fmtBytes(value: number | null | undefined, digits?: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let x = Math.abs(n);
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  const d = digits ?? (i <= 1 ? 0 : x >= 100 ? 1 : 2);
  return `${n < 0 ? '-' : ''}${x.toFixed(d)} ${units[i]}`;
}

export function fmtRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return '—';
  return `${fmtBytes(bytesPerSecond, 1)}/s`;
}

export function fmtPercent(value: number | null | undefined, digits = 1): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function ratioPercent(used: number, total: number, digits = 1): string {
  if (!total) return '—';
  return `${((used / total) * 100).toFixed(digits)}%`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

/**
 * 电量格式化。
 * 插座的累计计数器分辨率是 0.01 kWh，而一天的用量本来就不大，
 * 用 kWh 两位小数会把 0.01 显示成 0.00，看着像没用电。
 * 所以低于 1 kWh 时改用 Wh，超过之后再回到 kWh——两个量级都可读。
 */
export function energyParts(kwh: number | null | undefined): { value: string; unit: string } {
  const n = Number(kwh);
  if (!Number.isFinite(n)) return { value: '—', unit: '' };
  if (n === 0) return { value: '0', unit: 'Wh' };
  if (Math.abs(n) < 1) {
    const wh = n * 1000;
    return { value: Math.abs(wh) < 1 ? wh.toFixed(1) : wh.toFixed(0), unit: 'Wh' };
  }
  return { value: n.toFixed(2), unit: 'kWh' };
}

/** 同 energyParts，直接拼成 "10 Wh" / "1.23 kWh" */
export function fmtEnergy(kwh: number | null | undefined): string {
  const { value, unit } = energyParts(kwh);
  return unit ? `${value} ${unit}` : value;
}

export function fmtMoney(value: number | null | undefined, currency = 'CNY'): string {
  const n = Number(value) || 0;
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
  return `${symbol}${n.toFixed(2)}`;
}

export function fmtDateTime(input: string | number | Date | null | undefined): string {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(input: string | number | Date | null | undefined): string {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function fmtRelative(input: string | number | Date | null | undefined): string {
  if (!input) return '—';
  const t = new Date(input).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return diff > 0 ? `${mins} 分钟前` : `${mins} 分钟后`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff > 0 ? `${hours} 小时前` : `${hours} 小时后`;
  const days = Math.round(hours / 24);
  if (days < 30) return diff > 0 ? `${days} 天前` : `${days} 天后`;
  return fmtDate(input);
}

export function fmtClock(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 今天的 YYYY-MM-DD（本地时区） */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysUntil(input: string | null | undefined): number | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.setHours(23, 59, 59, 999) - Date.now();
  return Math.round(ms / 86400000);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function faviconUrl(url: string, size = 64): string {
  try {
    const host = new URL(url).host;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=${size}`;
  } catch {
    return '';
  }
}

/**
 * 站点图标的候选地址，分两档返回：
 *   · own      —— 站点自己的 /favicon.ico
 *   · fallback —— 国内可达的聚合服务
 *
 * 为什么换掉 Google 那个：它在国内根本连不上（实测 8 秒超时），
 * 结果是整页图标全变成首字母方块，跟"图标墙"完全是两回事。
 *
 * 为什么分两档而不是拼成一个有序列表：聚合服务对内网域名**不报 404**，
 * 而是回一张通用的"地球"图。它一旦算作成功，反而把站点自己的真图标盖掉了。
 * 所以要紧的是给 own 一个优先窗口 —— 具体判定见 SiteIcon。
 *
 * own 里 http 排在 https 前面：内网面板（PVE / 爱快这类）多半用自签证书，
 * 走 https 会直接因证书校验失败（实测 ERR_CERT_AUTHORITY_INVALID），
 * 而本页面自己就跑在 http 下，取 http 图标没有任何阻碍。
 */
export function faviconSources(url: string): { own: string[]; fallback: string[] } {
  try {
    const u = new URL(url);
    return {
      own: [`http://${u.host}/favicon.ico`, `${u.origin}/favicon.ico`],
      fallback: [`https://favicon.cccyun.cc/${u.host}`],
    };
  } catch {
    return { own: [], fallback: [] };
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
