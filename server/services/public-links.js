import { getLinkByToken, consumeQuota } from '../db/public-links.js';
import { addAttachment, ALLOWED_MIME, safeAttachmentName } from '../db/attachments.js';
import { createTicket } from './tickets.js';
import { notifyPanelCard, notifyPanelText, panelNotifyReady } from './feishu-bot.js';
import { isEmail, mailConfigured, ownerAddress, sendMail } from './mail.js';

/* ────────────────────────────────────────────────────────────────────────
 * 公开外链：外网用户往某个项目里投任务
 * ────────────────────────────────────────────────────────────────────────
 * 这是全站唯一一个**不需要登录**的写接口，所以每一层都要按"对面的输入
 * 全部不可信"来写：
 *   1. 令牌 32 字节随机，格式先校验再查库；
 *   2. 项目 / 分类 / 优先级由链接固定，请求体只能给标题与说明；
 *   3. 字段长度硬截断，不收 HTML；附件走 MIME 白名单，且有条数 / 单个体积 /
 *      每日总字节三重上限（html/svg/js 这类能执行脚本的类型不在白名单里）；
 *   4. 蜜罐 + 填写耗时挡脚本，单 IP 时间窗 + 单链接每日额度挡刷；
 *   5. 失败一律说"链接无效或已关闭"，不区分停用 / 过期 / 额度用完。
 * 真正的兜底是"可停用、可轮换"——链接一旦被转出去，指望它不被滥用不现实。
 * ──────────────────────────────────────────────────────────────────────── */

const TITLE_MAX = 200;
const NOTE_MAX = 5000;
const NAME_MAX = 40;
const CONTACT_MAX = 120;

/* 允许的附件类型从 db/attachments.js 复用（那边是唯一真源）：以前这里有一份
   自己的白名单、面板侧什么类型都收，两个入口对同一张表给了不同的约束。 */

/** 外链的附件比面板里更紧：最多 3 个、单个 1.5MB（与 db/attachments.js 的上限一致） */
const PUB_FILES_MAX = 3;
const PUB_FILE_BYTES = 1.5 * 1024 * 1024;

/* 附件总字节的日上限不在这里，而在 db/public-links.js 的 DAY_BYTES_CAP：
   它必须和 day_count 落在同一条 UPDATE 的 WHERE 里才挡得住并发，
   常量跟着那句 SQL 走，两边才不会对不上。 */

/** 正常填表不可能 1.2 秒内完成；低于这个值按脚本处理 */
const MIN_FILL_MS = 1200;

/** 单 IP 时间窗：10 分钟 10 条。比"每天 200"细，挡的是脚本连发；
    留出 10 条是因为同一个人一口气提几条（报修一批问题）是正常用法 */
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = 10;

/** 同一条链接的飞书通知最多每分钟一条：被刷时不能连群一起刷 */
const NOTIFY_GAP_MS = 60 * 1000;

export class PublicError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* 进程内的时间窗。重启会清零 —— 这是有意的取舍：
   外链的额度大头（每日 200 条）落在数据库里，重启不会丢；
   这里只挡短时间的连发，没必要为它再建一张表。 */
const hits = new Map();

function tooFrequent(linkId, ip) {
  const key = `${linkId}|${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_LIMIT) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);

  /* 简单的自清理：条目多了就顺手扔掉过期的，避免长期运行把 Map 撑大 */
  if (hits.size > 5000) {
    for (const [k, list] of hits) {
      if (!list.length || now - list[list.length - 1] > IP_WINDOW_MS) hits.delete(k);
    }
  }
  return false;
}

const lastNotifyAt = new Map();

function linkClosed(link) {
  if (!link || !link.enabled) return true;
  if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return true;
  if (link.maxUses != null && link.uses >= link.maxUses) return true;
  return false;
}

const clean = (value, max) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

/** 公开页能看到的全部信息：项目名、分类、备注名。不含 id、用量、token */
export function publicMeta(link) {
  return {
    project: link.project,
    section: link.section,
    label: link.label,
    closesAt: link.expiresAt,
  };
}

/** 令牌 → 链接。停用 / 过期 / 满额一律当不存在，免得帮扫描器确认"这条是真的" */
export async function resolvePublicLink(token) {
  const link = await getLinkByToken(token);
  return linkClosed(link) ? null : link;
}

/**
 * 校验附件。返回规范化后的数组；任何一项不合格就整单拒绝 ——
 * 静默丢掉附件会让提交者以为传上去了。
 */
function cleanAttachments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new PublicError(400, '附件格式不对');
  if (input.length > PUB_FILES_MAX) throw new PublicError(400, `最多带 ${PUB_FILES_MAX} 个附件`);

  return input.map((item) => {
    const content = String(item?.content ?? '');
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(content);
    if (!match) throw new PublicError(400, '附件内容格式不对');
    const mime = match[1].toLowerCase();
    if (!ALLOWED_MIME.has(mime)) throw new PublicError(400, '这个文件类型不接受：只收图片、Word / Excel / PPT、PDF、txt、zip');
    const bytes = Math.round((content.length * 3) / 4);
    if (bytes > PUB_FILE_BYTES) {
      throw new PublicError(
        400,
        `「${safeAttachmentName(item?.name)}」${(bytes / 1024 / 1024).toFixed(1)}MB，超过 1.5MB 上限，请压缩后重新上传`,
      );
    }
    // 请求头里声明的 mime 与 data URL 自带的必须一致，否则以内容为准
    if (item?.mime && String(item.mime).toLowerCase() !== mime) {
      throw new PublicError(400, '附件类型对不上');
    }
    return { name: safeAttachmentName(item?.name), mime, size: bytes, content };
  });
}

/** 卡片里一行放不下：折行、去空、超长截断 */
function oneLine(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 外部提交的飞书卡片。
 *
 * 用蓝色表头区分「有人提了新任务」，正文先给标题，再用两列字段放
 * 项目 / 提交人 / 联系方式 / 期望完成 / 附件数 —— 比一串换行文本好扫。
 * 备注只取前 160 字：群消息是索引，不是正文。
 */
function submitCard({ link, input, ticket, due, attachmentCount, at }) {
  /* 提交人 / 标题 / 联系方式 / 备注全部来自匿名提交者，一律用 plain_text：
     lark_md 会解析 [文案](链接) 和 <at id=all></at> 之类标签，靠转义挡不干净
     （Feishu 的转义规则不受我们控制），而这张卡是往受信的通知群里发的。
     代价是标签不再加粗 —— 换来的是匿名者改不了卡片的语义。 */
  const plainField = (label, value) => ({
    is_short: true,
    text: { tag: 'plain_text', content: `${label}\n${value}` },
  });
  const fields = [
    plainField('项目', `${link.project}${link.section ? ` / ${link.section}` : ''}`),
    plainField('提交人', input.submitter || '未留名'),
  ];
  if (input.contact) fields.push(plainField('联系方式', oneLine(input.contact, 60)));
  if (due) fields.push(plainField('期望完成', due));
  if (attachmentCount) fields.push(plainField('附件', `${attachmentCount} 个`));

  const elements = [
    { tag: 'div', text: { tag: 'plain_text', content: oneLine(input.title, 120) } },
    { tag: 'div', fields },
  ];

  const excerpt = oneLine(input.note, 160);
  if (excerpt) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: excerpt } });
  }

  /* 面板地址只能从环境变量拿：服务端不知道自己的公网域名，
     没配就不放按钮，而不是塞一个点不开的链接 */
  const panel = String(process.env.PANEL_URL || '').trim();
  if (/^https?:\/\//.test(panel)) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: '在面板中查看' }, type: 'primary', url: panel }],
    });
  }

  /* 尾注统一成「来源 · 时间」：全站卡片都长这样，一眼能认出是谁发的 */
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `个人工作台 · 外链提交 · ${at} · ${ticket.id}` }] });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '新的外部任务提交' },
    },
    elements,
  };
}

/**
 * 给平台所有者发一封"来新活了"的邮件。
 *
 * 飞书是快的，但群消息会被刷过去；邮件留在收件箱里，适合第二天再处理。
 * 收件地址取设置页的「通知收件人」，留空则用发件地址自己。
 */
function notifyOwnerByMail({ link, input, ticket, due, attachmentCount, at }) {
  if (!mailConfigured()) return;
  const to = ownerAddress();
  if (!isEmail(to)) return;

  const lines = [
    '有一个新任务从外部链接提交进来了。',
    '',
    `标题：${input.title}`,
    `项目：${link.project}${link.section ? ` / ${link.section}` : ''}`,
    `提交人：${input.submitter || '未留名'}`,
    `联系方式：${input.contact}`,
    due ? `期望完成：${due}` : '期望完成：未指定',
    attachmentCount ? `附件：${attachmentCount} 个（在面板里查看）` : '',
    `提交时间：${at}`,
    `任务号：${ticket.id}`,
  ];
  if (input.note) lines.push('', '备注：', oneLine(input.note, 600));

  sendMail({
    to,
    subject: `【外部任务提交】${input.title}`.slice(0, 120),
    text: lines.filter(Boolean).join('\n'),
  })
    .then(() => console.log(`[public-links] 已发送邮件通知 ${ticket.id} → ${to}`))
    .catch((err) => console.warn(`[public-links] 邮件通知失败 ${ticket.id} → ${to}：`, err.message));
}

function buildNote(input) {
  const lines = [input.note].filter(Boolean);
  const who = [input.submitter && `提交人：${input.submitter}`, input.contact && `联系方式：${input.contact}`].filter(Boolean);
  return [...lines, ...(who.length ? ['', '—— 来自外部提交 ——', ...who] : [])].join('\n');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 提交一条任务。返回 { duplicate: boolean } —— duplicate 只是给调用方一个
 * 统一口径（蜜罐命中时也回成功，但不写库、不通知）。
 */
export async function submitToLink(link, body, { ip = '' } = {}) {
  const input = {
    title: clean(body?.title, TITLE_MAX),
    note: clean(body?.note, NOTE_MAX),
    submitter: clean(body?.submitter, NAME_MAX),
    contact: clean(body?.contact, CONTACT_MAX),
  };
  const honey = String(body?.website ?? '').trim();
  const elapsed = Number(body?.elapsedMs);

  /* 蜜罐被填 / 快得不像人：回一个成功，但什么都不做。
     报错等于告诉对方"你被识别了"，换个姿势就绕过去了 */
  if (honey || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
    return { duplicate: true };
  }

  if (!input.title) throw new PublicError(400, '标题不能为空');
  /* 联系方式必填：任务完成时要按它发邮件，事后追着问"是谁提的"没有意义 */
  if (!input.contact) throw new PublicError(400, '请填写联系方式（推荐填邮箱）');
  /* 期望完成时间只收 YYYY-MM-DD。空 = 不设截止，
     与面板里"未设截止"是同一个状态 */
  const dueRaw = clean(body?.due, 40);
  if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
    throw new PublicError(400, '期望完成时间要写成 2026-10-31 这种格式');
  }
  if (dueRaw) {
    /* new Date('2026-02-31') 会自动滚到 3 月 3 日而不是报错，
       所以要回写一遍比对：拼出来的年月日必须和输入完全一致 */
    const d = new Date(`${dueRaw}T00:00:00`);
    const back = Number.isNaN(d.getTime())
      ? ''
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (back !== dueRaw) throw new PublicError(400, '期望完成时间不是一个有效日期');
  }
  const attachments = cleanAttachments(body?.attachments);

  if (tooFrequent(link.id, ip)) throw new PublicError(429, '提交太频繁了，请过几分钟再试');

  /* 附件字节一起占额度：只限条数时，200 条 × 3 个 × 1.5MB 一天能写进近 900MB，
     而这一列是 MEDIUMTEXT —— 链接一旦被转到公开群，磁盘就是这么被填满的 */
  const attachBytes = attachments.reduce((sum, file) => sum + file.size, 0);
  const quota = await consumeQuota(link.id, todayKey(), attachBytes);
  /* 条数用完与附件总量用完共用一句话：对提交者都不用区分，
     区分了只会告诉他"换个方式还能塞" */
  if (!quota) throw new PublicError(429, '这条链接今天已经收满了（提交条数或附件总量），请联系发起人');

  const ticket = createTicket(
    {
      title: input.title,
      note: buildNote(input),
      project: link.project,
      section: link.section,
      status: 'todo',
      priority: 'P2',
      due: dueRaw,
      contact: input.contact,
    },
    { source: 'external' },
  );

  /* 附件走独立表，和面板上传的是同一段逻辑（同一套数量 / 体积上限）。
     这里失败不让整单失败：任务本身已经进看板了，丢一个附件比丢整条任务轻。 */
  for (const file of attachments) {
    try {
      await addAttachment(ticket.id, file);
    } catch (err) {
      console.warn(`[public-links] 附件写入失败（${file.name}）：`, err.message);
    }
  }

  /* 通知失败不影响提交：任务已经在看板上了，群里少一条消息不是数据问题 */
  if (link.notify) {
    const last = lastNotifyAt.get(link.id) || 0;
    if (Date.now() - last >= NOTIFY_GAP_MS) {
      lastNotifyAt.set(link.id, Date.now());
      const at = new Date().toLocaleString('zh-CN');

      /* 邮件和飞书各走各的：没配 webhook 也不该连邮件一起不发 */
      notifyOwnerByMail({ link, input, ticket, due: dueRaw, attachmentCount: attachments.length, at });

      if (panelNotifyReady()) {
        const card = submitCard({ link, input, ticket, due: dueRaw, attachmentCount: attachments.length, at });
        /* 卡片 schema 被飞书拒了不能连通知一起丢：降级成原来的纯文本再发一次 */
        notifyPanelCard(card)
          .then(() => console.log(`[public-links] 已推送飞书卡片 ${ticket.id}`))
          .catch((err) => {
            console.warn('[public-links] 卡片发送失败，降级为文本：', err.message);
            const who = [input.submitter && `提交人 ${input.submitter}`, input.contact && `联系方式 ${input.contact}`].filter(Boolean).join(' · ');
            const text = [
              `【外部任务提交】${link.project}${link.section ? ` / ${link.section}` : ''}`,
              input.title,
              who,
              dueRaw ? `期望完成 ${dueRaw}` : '',
              attachments.length ? `附件 ${attachments.length} 个（面板里查看）` : '',
              at,
              `任务号 ${ticket.id}`,
            ]
              .filter(Boolean)
              .join('\n');
            notifyPanelText(text).catch((e2) => console.warn('[public-links] 飞书通知失败：', e2.message));
          });
      }
    } else {
      console.log(`[public-links] ${link.id} 距上条通知不足 1 分钟，跳过本次通知`);
    }
  }

  return { duplicate: false };
}
