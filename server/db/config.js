import 'dotenv/config';

const int = (value, fallback) => {
  const n = Number(value);
  return value === undefined || value === '' || !Number.isFinite(n) ? fallback : n;
};

/** MySQL 连接参数，全部可用 .env 覆盖（见 .env.example） */
export const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: int(process.env.DB_PORT, 3306),
  user: process.env.DB_USER || 'workbench',
  // 允许显式配成空口令：只有 undefined 才回退到默认值
  password: process.env.DB_PASSWORD === undefined ? 'workbench' : process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'personal_workbench',
  poolSize: int(process.env.DB_POOL_SIZE, 10),
  connectTimeout: int(process.env.DB_CONNECT_TIMEOUT, 10000),
};

/** 打日志用的脱敏描述，不带密码 */
export const DB_LABEL = `${DB.user}@${DB.host}:${DB.port}/${DB.database}`;
