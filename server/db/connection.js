import mysql from 'mysql2/promise';
import { DB } from './config.js';

/**
 * 全局连接池。
 * timezone: 'Z' —— 库里统一按 UTC 存 DATETIME，读写时由驱动完成 Date 转换，
 * 避免服务器时区不同导致时间漂移。
 */
export const pool = mysql.createPool({
  host: DB.host,
  port: DB.port,
  user: DB.user,
  password: DB.password,
  database: DB.database,
  charset: 'utf8mb4',
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: DB.poolSize,
  queueLimit: 0,
  connectTimeout: DB.connectTimeout,
  supportBigNumbers: true,
  multipleStatements: false,
  namedPlaceholders: false,
});

/** 连接探测：启动时快速失败，并给出可操作的提示 */
export async function assertConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}

export async function closePool() {
  await pool.end();
}
