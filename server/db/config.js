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
  /* 不再有默认口令。以前这里回退成 'workbench'，于是"忘了配 .env"的表现
     不是启动失败，而是一个用户名即口令的账号安静地跑在 3306 上。
     允许显式配空串（本机 socket 免密场景），但绝不替用户编一个。 */
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME || 'personal_workbench',
  poolSize: int(process.env.DB_POOL_SIZE, 10),
  connectTimeout: int(process.env.DB_CONNECT_TIMEOUT, 10000),
};

/** 打日志用的脱敏描述，不带密码 */
export const DB_LABEL = `${DB.user}@${DB.host}:${DB.port}/${DB.database}`;
