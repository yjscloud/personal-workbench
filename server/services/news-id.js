import { createHash } from 'node:crypto';

/**
 * 热点条目 ID：由「来源 + 链接」稳定派生，不依赖条目顺序，重复抓取得到同一个 ID。
 *
 * 历史实现是 `base64(来源:链接).slice(0, 24)`，截断后同一来源的所有条目会算出
 * 完全相同的 ID（"Hacker News · AI" 前 18 字节就把 24 个 base64 字符吃满了），
 * 表现为界面上重复 key、落库时主键冲突。这里改成定长摘要，彻底避免截断碰撞。
 */
export function newsItemId(item) {
  const key = `${item?.source ?? ''}:${item?.link || item?.title || ''}`;
  return `nw_${createHash('sha1').update(key).digest('base64url').slice(0, 22)}`;
}
