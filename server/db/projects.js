import { pool } from './connection.js';

/* ────────────────────────────────────────────────────────────────────────
 * 项目
 * ────────────────────────────────────────────────────────────────────────
 * Tower 式的两层结构：项目 → 任务。
 * 任务侧仍然用 tickets.project 存项目名，也就是「名字即外键」——
 * 好处是历史数据一行都不用迁移，代价是改名时要同步刷一遍该项目的任务
 * （那一步在 routes.js 里做，因为要动内存镜像）。
 * 与附件同理，本项目走独立表逐行读写，不进 store.js 的内存镜像。
 * ──────────────────────────────────────────────────────────────────────── */

let counter = 0;
function uid() {
  counter = (counter + 1) % 10000;
  return `prj_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const COLS = '`id`, `name`, `note`, `sort`, `created_at`';

function fromRow(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note ?? '',
    sort: Number(row.sort) || 0,
    createdAt: toIso(row.created_at),
  };
}

/** 全部项目：先按自定义排序，再按创建时间 */
export async function listProjects() {
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`projects\` ORDER BY \`sort\` ASC, \`created_at\` ASC`);
  return rows.map(fromRow);
}

export async function getProject(id) {
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`projects\` WHERE \`id\` = ? LIMIT 1`, [String(id)]);
  return rows.length ? fromRow(rows[0]) : null;
}

/**
 * 新建项目。重名直接抛错 —— 名字就是任务侧的外键，撞了会导致两批任务混在一起。
 */
export async function addProject({ name, note = '' }) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw new Error('项目名不能为空');

  const [dup] = await pool.query('SELECT `id` FROM `projects` WHERE `name` = ? LIMIT 1', [clean]);
  if (dup.length) throw new Error(`项目「${clean}」已经存在`);

  const [max] = await pool.query('SELECT COALESCE(MAX(`sort`), 0) AS `m` FROM `projects`');
  const row = {
    id: uid(),
    name: clean,
    note: String(note || '').slice(0, 2000),
    sort: Number(max?.[0]?.m || 0) + 1,
    createdAt: new Date(),
  };
  await pool.query(
    'INSERT INTO `projects` (`id`, `name`, `note`, `sort`, `created_at`) VALUES (?, ?, ?, ?, ?)',
    [row.id, row.name, row.note, row.sort, row.createdAt],
  );
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/**
 * 改项目。返回 { before, after }：改名时调用方要拿 before.name 去刷任务，
 * 拿 after.name 作为新值，所以两个都得给回去。
 */
export async function patchProject(id, patch) {
  const before = await getProject(id);
  if (!before) return null;

  const sets = [];
  const args = [];

  if (patch.name !== undefined) {
    const clean = String(patch.name).trim().slice(0, 120);
    if (!clean) throw new Error('项目名不能为空');
    const [dup] = await pool.query('SELECT `id` FROM `projects` WHERE `name` = ? AND `id` <> ? LIMIT 1', [
      clean,
      String(id),
    ]);
    if (dup.length) throw new Error(`项目「${clean}」已经存在`);
    sets.push('`name` = ?');
    args.push(clean);
  }
  if (patch.note !== undefined) {
    sets.push('`note` = ?');
    args.push(String(patch.note).slice(0, 2000));
  }

  if (!sets.length) return { before, after: before };

  args.push(String(id));
  await pool.query(`UPDATE \`projects\` SET ${sets.join(', ')} WHERE \`id\` = ?`, args);
  return { before, after: await getProject(id) };
}

/** 删项目本身。任务不跟着删，归属清空由调用方处理 */
export async function removeProject(id) {
  const [result] = await pool.query('DELETE FROM `projects` WHERE `id` = ?', [String(id)]);
  return result.affectedRows || 0;
}

/** 供健康检查的「表行数」用 */
export async function countProjects() {
  const [rows] = await pool.query('SELECT COUNT(*) AS `n` FROM `projects`');
  return Number(rows?.[0]?.n || 0);
}
