/* ────────────────────────────────────────────────────────────────────────
 * 每日一句励志语
 *
 * 关键在于「确定性挑选」：这里绝不能每次渲染都 Math.random()。
 * 顶栏那个秒级时钟会让整个外壳每秒重渲染一次，随机的话同一句会不停闪，
 * 而且刷新一次换一句，也就谈不上"每日"了。所以用日期做种子，
 * 同一天永远得到同一句，跨零点自然翻篇。
 * ──────────────────────────────────────────────────────────────────────── */

export type Quote = { text: string; from: string };

export const QUOTES: Quote[] = [
  { text: '千里之行，始于足下。', from: '《老子》' },
  { text: '不积跬步，无以至千里；不积小流，无以成江海。', from: '《荀子·劝学》' },
  { text: '锲而舍之，朽木不折；锲而不舍，金石可镂。', from: '《荀子·劝学》' },
  { text: '天行健，君子以自强不息。', from: '《周易》' },
  { text: '苟日新，日日新，又日新。', from: '《礼记·大学》' },
  { text: '工欲善其事，必先利其器。', from: '《论语·卫灵公》' },
  { text: '行百里者半九十。', from: '《战国策》' },
  { text: '博观而约取，厚积而薄发。', from: '苏轼' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', from: '陆游' },
  { text: '路漫漫其修远兮，吾将上下而求索。', from: '屈原《离骚》' },
  { text: '业精于勤，荒于嬉；行成于思，毁于随。', from: '韩愈《进学解》' },
  { text: '天下难事，必作于易；天下大事，必作于细。', from: '《老子》' },
  { text: '博学之，审问之，慎思之，明辨之，笃行之。', from: '《礼记·中庸》' },
  { text: '士不可以不弘毅，任重而道远。', from: '《论语·泰伯》' },
  { text: '种一棵树最好的时间是十年前，其次是现在。', from: '谚语' },
  { text: '慢慢来，比较快。', from: '' },
];

/** 把日期摊成一个稳定的整数。FNV-1a，和后端演示数据同一套，不追求密码学强度。 */
function seedOf(at: Date): number {
  const key = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 算出某一天用的是第几句。
 *
 * 为什么必须从锚点逐日推进、而不是只算当天：
 * 要保证"今天不与昨天重样"，就得知道昨天**实际**用的是哪一句；
 * 而昨天那句又受前天约束……这是一个链，不能各自独立地 hash 一下了事
 * （踩过：用 `hash(昨天) % n` 当"昨天那句"，结果序列里照样出现 5,5 —— 
 *   因为昨天实际显示的并不是这个值，它自己被前一天改写过了）。
 *
 * 锚点取当年元旦，所以最多走 365 步，每步几次取模，成本可以忽略。
 * 代价是跨年时元旦那句可能和 12-31 重样，一年一次，接受。
 */
function indexOfDay(at: Date): number {
  const n = QUOTES.length;
  const target = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const cursor = new Date(at.getFullYear(), 0, 1);

  let idx = seedOf(cursor) % n;
  while (cursor < target) {
    cursor.setDate(cursor.getDate() + 1);
    const avoid = idx;
    // 从剩下的 n-1 句里取，再映射回完整序号（跳过昨天那句），分布保持均匀
    const pick = seedOf(cursor) % (n - 1);
    idx = pick >= avoid ? pick + 1 : pick;
  }
  return idx;
}

/** 同一天恒定返回同一句；跨零点自然换下一句，且保证不跟昨天重样。 */
export function dailyQuote(at: Date = new Date()): Quote {
  return QUOTES[indexOfDay(at)];
}
