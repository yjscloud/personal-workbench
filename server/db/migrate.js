/**
 * 独立建表 / 初始化脚本。
 *
 * 服务启动时也会自动跑同样的流程，这个脚本适用于：
 *   · 部署阶段先建好表，不启动 Web 服务；
 *   · 排障时确认连接参数、库结构与各表行数。
 *
 * 用法：npm run db:migrate
 */
import { initStore, closeStore, dbInfo, dbStats } from '../store.js';

const info = dbInfo();
console.log(`[db] 目标 ${info.label}`);

try {
  const result = await initStore();
  const stats = await dbStats();

  if (result.seeded) {
    console.log(`[db] 建表完成，已写入${result.source === 'legacy-json' ? '旧 db.json 迁移数据' : '示例数据'}`);
    if (result.source === 'legacy-json' && info.legacyFile) console.log(`[db] 迁移来源 ${info.legacyFile}`);
  } else {
    console.log('[db] 建表完成，库里已有数据，跳过初始化');
  }
  console.log(`[db] 各表行数 ${Object.entries(stats).map(([t, n]) => `${t}=${n}`).join(' ')}`);
} catch (err) {
  console.error(`[db] 失败：${err.message}`);
  process.exitCode = 1;
} finally {
  await closeStore();
}
