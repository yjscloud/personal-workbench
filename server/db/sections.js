import { pool } from './connection.js';

/* ────────────────────────────────────────────────────────────────────────
 * 项目分类（项目详情里的「分组」）
 * ────────────────────────────────────────────────────────────────────────
 * 一个项目下可以再分若干段，任务归属到段。
 * 任务侧用 tickets.section 存分类名 —— 和项目一样是「名字即外键」，
 * 区别只在于这个名字只要在所属项目内唯一。
 * 改名时要连带刷该段下的任务，那一步在 routes.js 里做（要动内存镜像）。
 * ──────────────────────────────────────────────────────────────────────── */

let counter = 0;
function uid() {
  counter = (counter + 1) % 10000;
  return `sec_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

const toIso = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const COLS = '`id`, `project_id`, `name`, `sort`, `created_at`';

function fromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sort: Number(row.sort) || 0,
    createdAt: toIso(row.created_at),
  };
}

/** 某个项目的分类 */
export async function listSections(projectId) {
  const [rows] = await pool.query(
    `SELECT ${COLS} FROM \`project_sections\` WHERE \`project_id\` = ? ORDER BY \`sort\` ASC, \`created_at\` ASC`,
    [String(projectId)],
  );
  return rows.map(fromRow);
}

/** 全部分类：首屏一次取完，省得每个项目各请求一次 */
export async function listAllSections() {
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`project_sections\` ORDER BY \`sort\` ASC, \`created_at\` ASC`);
  return rows.map(fromRow);
}

export async function getSection(id) {
  const [rows] = await pool.query(`SELECT ${COLS} FROM \`project_sections\` WHERE \`id\` = ? LIMIT 1`, [String(id)]);
  return rows.length ? fromRow(rows[0]) : null;
}

/** 新建分类。同一个项目内重名要拒绝，否则两批任务会被塞进同一个名字里 */
export async function addSection(projectId, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw new Error('分类名不能为空');

  const [dup] = await pool.query('SELECT `id` FROM `project_sections` WHERE `project_id` = ? AND `name` = ? LIMIT 1', [
    String(projectId),
    clean,
  ]);
  if (dup.length) throw new Error(`这个项目里已经有「${clean}」了`);

  const [max] = await pool.query('SELECT COALESCE(MAX(`sort`), 0) AS `m` FROM `project_sections` WHERE `project_id` = ?', [
    String(projectId),
  ]);
  const row = {
    id: uid(),
    projectId: String(projectId),
    name: clean,
    sort: Number(max?.[0]?.m || 0) + 1,
    createdAt: new Date(),
  };
  await pool.query(
    'INSERT INTO `project_sections` (`id`, `project_id`, `name`, `sort`, `created_at`) VALUES (?, ?, ?, ?, ?)',
    [row.id, row.projectId, row.name, row.sort, row.createdAt],
  );
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** 改名。返回 { before, after }：调用方要拿 before.name 去刷该段下的任务 */
export async function patchSection(id, patch) {
  const before = await getSection(id);
  if (!before) return null;

  if (patch.name === undefined) return { before, after: before };

  const clean = String(patch.name).trim().slice(0, 120);
  if (!clean) throw new Error('分类名不能为空');

  const [dup] = await pool.query(
    'SELECT `id` FROM `project_sections` WHERE `project_id` = ? AND `name` = ? AND `id` <> ? LIMIT 1',
    [before.projectId, clean, String(id)],
  );
  if (dup.length) throw new Error(`这个项目里已经有「${clean}」了`);

  await pool.query('UPDATE `project_sections` SET `name` = ? WHERE `id` = ?', [clean, String(id)]);
  return { before, after: await getSection(id) };
}

/** 只删分类本身，段里的任务不删、只是失去归属 */
export async function removeSection(id) {
  const [result] = await pool.query('DELETE FROM `project_sections` WHERE `id` = ?', [String(id)]);
  return result.affectedRows || 0;
}

/** 供健康检查的「表行数」用 */
export async function countSections() {
  const [rows] = await pool.query('SELECT COUNT(*) AS `n` FROM `project_sections`');
  return Number(rows?.[0]?.n || 0);
}
