import { pool } from './connection.js';

/**
 * 破坏性操作留痕。
 *
 * 为什么不复用 store.js 的内存镜像：镜像是「整表 DELETE + 全量 INSERT」的落库
 * 方式，而日志只追加、会一直长 —— 走镜像等于每写一条都把历史重写一遍。
 * 和 assistant_messages 同一个理由，所以这张表由本模块逐行读写。
 *
 * 为什么写失败只打日志、不抛错：审计是旁路。一次已经成功的重置/解封不该因为
 * 日志写不进去而返回 500 —— 那只会多出一个更难排查的问题。
 *
 * 为什么不存请求体：备份导入动辄几 MB、批量删除可能带上百个 id，记全量只会把
 * 日志表撑爆。事后真正要回答的是「谁、什么时候、干了哪一类事、对象是什么」。
 */
export async function logOperation({ actor, ip, action, target, detail }) {
  try {
    await pool.query(
      'INSERT INTO `operation_log` (`at`, `actor`, `ip`, `action`, `target`, `detail`) VALUES (?,?,?,?,?,?)',
      [
        new Date(),
        clip(actor, 64) || '未知',
        clip(ip, 64),
        clip(action, 64),
        clip(target, 200),
        clip(detail, 500),
      ],
    );
  } catch (err) {
    console.error('[audit] 操作日志写入失败：', err.message);
  }
}

/** 最近若干条，给「操作日志」查询入口用，新在前 */
export async function listOperations(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await pool.query(
    'SELECT `seq`, `at`, `actor`, `ip`, `action`, `target`, `detail` FROM `operation_log` ORDER BY `seq` DESC LIMIT ?',
    [n],
  );
  return rows.map((r) => ({
    seq: Number(r.seq),
    at: new Date(r.at).toISOString(),
    actor: r.actor,
    ip: r.ip,
    action: r.action,
    target: r.target,
    detail: r.detail,
  }));
}

/** 日志只做留痕，不该因为某个字段里混了换行/控制字符就把写入搞脏 */
function clip(v, n) {
  return String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
}
