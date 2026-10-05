import 'dotenv/config';
import { initStore, db, update, flush, closeStore } from '../store.js';
import { authConfig, hashPassword } from '../services/auth.js';

/* ────────────────────────────────────────────────────────────────────────
 * 面板口令的救援工具
 *
 * 用途只有一个：**万一被自己锁在门外**。登录口令存在 settings.auth 里，
 * 界面上改密码需要先登录，所以一旦那串哈希出了问题（或者纯粹是忘了），
 * 从网页上没有任何入口能把门打开 —— 这个脚本就是那个入口。
 *
 *   node server/tools/auth-reset.js            看当前状态，不动任何东西
 *   node server/tools/auth-reset.js --reset    清掉库里的口令，回到 .env 的引导口令
 *   node server/tools/auth-reset.js --set 新密码  直接设置一个新口令
 *
 * 用法要点（脚本会再提醒一遍）：先停服务再执行、执行完再启动。
 * 服务在跑的时候它把设置缓存在内存里，脚本直接改库的话，
 * 服务下一次落库会用内存里的旧快照把改动盖回去 —— 看起来就是"改了没用"。
 * ──────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const reset = argv.includes('--reset');
const setIndex = argv.indexOf('--set');
const newPassword = setIndex >= 0 ? argv[setIndex + 1] : null;

async function main() {
  await initStore();

  const cfg = authConfig();
  const stored = db().settings?.auth || {};
  const hasHash = Boolean(stored.passwordHash);

  console.log('');
  console.log('  面板登录状态');
  console.log(`    登录关卡    ${cfg.enabled ? '已开启' : '未开启（接口全部开放）'}`);
  console.log(`    账号        ${cfg.user}`);
  console.log(`    口令来源    ${hasHash ? '设置页里设过的口令（库中哈希）' : cfg.envFallback ? '.env 的 AUTH_PASSWORD（引导口令）' : '无'}`);
  if (hasHash) console.log(`    最近修改    ${stored.updatedAt || '未知'}`);

  if (!reset && !newPassword) {
    console.log('');
    console.log('  只查看，未做任何改动。要改口令：');
    console.log('    node server/tools/auth-reset.js --reset        # 回到 .env 的引导口令');
    console.log('    node server/tools/auth-reset.js --set 新密码    # 直接设一个新口令');
    console.log('');
    return;
  }

  if (newPassword !== null && newPassword.length < 6) {
    console.error('');
    console.error('  ✗ 新密码至少 6 位');
    console.error('');
    process.exitCode = 1;
    return;
  }

  update((d) => {
    d.settings.auth = newPassword
      ? { user: cfg.user, passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() }
      : { user: '', passwordHash: '', updatedAt: '' };
    d.settings.updatedAt = new Date().toISOString();
  });
  await flush();

  console.log('');
  if (newPassword) {
    console.log(`  ✓ 已设置新口令（账号 ${cfg.user}），登录后可在设置页继续修改`);
  } else if (cfg.envFallback) {
    console.log('  ✓ 已清除库中口令，现在使用 .env 里的 AUTH_PASSWORD 登录');
  } else {
    console.log('  ✓ 已清除库中口令。注意 .env 里也没有 AUTH_PASSWORD，登录关卡现在是关闭的');
  }
  console.log('');
  console.log('  别忘了重启服务让改动生效：');
  console.log('    systemctl restart personal-workbench');
  console.log('');
}

main()
  .catch((err) => {
    console.error('');
    console.error(`  ✗ 执行失败：${err.message}`);
    console.error('    若提示数据库连不上，先确认 MySQL 已启动、.env 里的 DB_* 正确');
    console.error('');
    process.exitCode = 1;
  })
  .finally(() => closeStore().catch(() => {}));
