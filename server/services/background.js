import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../store.js';

/* ────────────────────────────────────────────────────────────────────────
 * 背景图存储
 *
 * 没有引入 multer 之类的依赖：前端把文件读成 data URL 走 JSON 提交，
 * 服务端解 base64 落盘。express.json 已经限了 4mb，刚好够一张壁纸，
 * 也省掉整套 multipart 解析和它带来的边界问题。
 *
 * 文件放在 server/data/background/ 下（和旧的 db.json 同处 DATA_DIR），
 * 按槽位用固定前缀命名：bg.<ext> 是主背景，login.<ext> 是登录页背景。
 * 两个槽位各有各的文件，互不覆盖 —— 登录页那张要在**未登录**时就能取到，
 * 和主背景的可见范围不同（见 routes.js 里 /login-background 的白名单）。
 *
 * 状态缓存在内存里：maskSettings 是同步函数，接口回显需要知道
 * "有没有上传过图、什么时候传的"，不能每次都去 await 一遍磁盘。
 * ──────────────────────────────────────────────────────────────────────── */

const DIR = path.join(DATA_DIR, 'background');
/** 3MB：base64 后约 4MB，正好卡在 express.json 的 4mb 请求上限之内 */
const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 槽位 → 文件名前缀 */
export const SLOT_PREFIX = { main: 'bg', login: 'login' };

const cached = { main: null, login: null };

/** 同步读取某个槽位的背景图状态；没有图时返回 null */
export function backgroundStatus(slot = 'main') {
  return cached[slot] ?? null;
}

async function scan(prefix) {
  try {
    const files = await fs.readdir(DIR);
    const hit = files.find((f) => f.startsWith(`${prefix}.`));
    if (!hit) return null;
    const full = path.join(DIR, hit);
    const st = await fs.stat(full);
    return { path: full, ext: path.extname(hit).slice(1), size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    // 目录不存在就等同"没传过图"，不是错误
    return null;
  }
}

/** 启动时调一次，把磁盘状态灌进缓存 */
export async function refreshBackground() {
  const entries = await Promise.all(Object.entries(SLOT_PREFIX).map(async ([slot, prefix]) => [slot, await scan(prefix)]));
  for (const [slot, value] of entries) cached[slot] = value;
  return cached.main;
}

/** 清掉某个槽位已上传的图（换格式时旧文件必须一起走，否则会挑到旧的） */
export async function clearBackground(slot = 'main') {
  const prefix = SLOT_PREFIX[slot] || SLOT_PREFIX.main;
  try {
    const files = await fs.readdir(DIR);
    await Promise.all(files.filter((f) => f.startsWith(`${prefix}.`)).map((f) => fs.unlink(path.join(DIR, f))));
  } catch {
    /* 目录不存在等于本来就干净 */
  }
  cached[slot] = null;
}

/**
 * 保存一张背景图。入参是 data URL（`data:image/png;base64,...`）。
 * 只认白名单里的图片类型 —— 这是唯一会被原样写进磁盘的路径，不做宽松匹配。
 */
export async function saveBackground(dataUrl, slot = 'main') {
  const prefix = SLOT_PREFIX[slot] || SLOT_PREFIX.main;
  const m = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(String(dataUrl || '').trim());
  if (!m) throw new Error('图片格式无法识别，请重新选择文件');

  const mime = m[1].toLowerCase();
  const ext = ALLOWED[mime];
  if (!ext) throw new Error(`不支持的图片格式：${mime}。支持 JPEG / PNG / WebP / GIF`);

  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_BYTES) {
    throw new Error(`图片 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_BYTES / 1024 / 1024}MB 上限`);
  }

  await fs.mkdir(DIR, { recursive: true });
  await clearBackground(slot);
  await fs.writeFile(path.join(DIR, `${prefix}.${ext}`), buf);
  cached[slot] = await scan(prefix);
  return cached[slot];
}
