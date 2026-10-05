import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/**
 * 把 schema.sql 拆成单条语句。
 * 约定：DDL 里不出现分号字面量，`--` 行注释单独占行，因此可以安全地按分号切分。
 */
export function schemaStatements() {
  return fs
    .readFileSync(SCHEMA_FILE, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

/* 给**已经存在**的表补新列。
   schema.sql 里的 CREATE TABLE IF NOT EXISTS 只保证"表在"，旧表它一个字都不改 ——
   所以光把新列写进 schema.sql，老库永远拿不到。这一组按"列是否已存在"判断，
   幂等，于是仍然不需要迁移版本表（沿用本文件原有的约定）。
   只做加列：改类型 / 删列这类不可逆操作不该在启动时静默发生。 */
const ADDITIVE_COLUMNS = [
  ['news_items', 'score', "INT NULL COMMENT 'AIHOT 打分 0-100' AFTER `tags`"],
  ['news_items', 'reason', "TEXT NULL COMMENT '推荐理由' AFTER `score`"],
  ['news_items', 'aihot_url', "VARCHAR(200) NULL COMMENT 'AIHOT 上的条目页' AFTER `reason`"],
  [
    'news_state',
    'dropped_count',
    "INT NOT NULL DEFAULT 0 COMMENT '最近一次被分数门槛挡掉的条数' AFTER `last_error`",
  ],
  /* 任务的项目分类。schema.sql 现在也有这一列了，但**在补上之前就建过库**
     的环境（以及那段时间里全新初始化出来的库）没有 —— 所以这里必须再登记
     一份。ADDITIVE_COLUMNS 存在的意义就是这个：建表语句只对新库生效，
     而"这一列是我后加的"这件事只有这里记得住。
     这正是本次修的缺口：它原本两边都没有，于是全新初始化的库一播种就失败。 */
  ['tickets', 'section', "VARCHAR(120) NOT NULL DEFAULT '' COMMENT '项目分类名' AFTER `project`"],
  /* 知识库正文从 steps 数组改成 Markdown：老库要补这两列，
     已有的 steps 由 store.js 启动时做一次搬迁，见 services/knowledge.js */
  ['knowledge_items', 'body', "MEDIUMTEXT NULL COMMENT 'Markdown 正文' AFTER `steps`"],
  [
    'knowledge_items',
    'body_plain',
    "MEDIUMTEXT NULL COMMENT '正文纯文本（剥掉标记），供搜索与 AI 检索' AFTER `body`",
  ],
  /* 置顶 / 星标。默认 0，于是老库里的条目自动都是"未置顶、未星标" */
  ['knowledge_items', 'pinned', "TINYINT NOT NULL DEFAULT 0 COMMENT '置顶：排到列表最前' AFTER `body_plain`"],
  ['knowledge_items', 'starred', "TINYINT NOT NULL DEFAULT 0 COMMENT '星标：标记 + 可单独筛选' AFTER `pinned`"],
  /* 文章助手的对话记录。放在条目行里而不是单开一张表：删条目时它自然一起消失 */
  ['knowledge_items', 'ai', "JSON NULL COMMENT '文章助手的对话记录' AFTER `starred`"],
  /* 回收站。口径与 tickets.deleted_at 完全一致：非空即在回收站里，
     默认列出去掉这些行；满 7 天由 services/retention.js 收走。
     老库补上这一列后所有条目都是 NULL，也就是"一篇都没删过" —— 不会被误判 */
  [
    'knowledge_items',
    'deleted_at',
    "DATETIME(3) NULL COMMENT '软删除时间（UTC），非空即在回收站' AFTER `ai`",
  ],
];

async function ensureAdditiveColumns(conn) {
  const [[row]] = await conn.query('SELECT DATABASE() AS db');
  const db = row?.db;
  if (!db) return;
  for (const [table, column, definition] of ADDITIVE_COLUMNS) {
    const [found] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [db, table, column],
    );
    if (Number(found[0]?.n) === 0) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  }
}

/** 建表（幂等）。表结构与服务一起演进，不需要独立的迁移版本表。 */
export async function ensureSchema() {
  const conn = await pool.getConnection();
  try {
    for (const stmt of schemaStatements()) await conn.query(stmt);
    await ensureAdditiveColumns(conn);
  } finally {
    conn.release();
  }
}
