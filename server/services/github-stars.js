import { db, flush, update } from '../store.js';
import { notifyPanelNotice, panelNotifyReady } from './feishu-bot.js';

/* ── GitHub star 卡片 ─────────────────────────────────────────────────
   监控页上唯一一个"外部世界的数"：某个仓库有多少 star、最近涨得怎么样。
   盯哪个仓库、涨了发不发飞书，都在设置页里改（settings.stars），不写死在代码里。

   为什么要存在库里而不是每次现取：
   1. 未认证的 GitHub API 只有 60 次/小时（按出口 IP 算），这个面板刷新一次
      就会打好几次 —— 直接透传等于拿监控页当探针；
   2. 卡片要回答的是"最近涨了多少"，那就必须有历史点。单看一眼当前值，
      画不出任何趋势，也判断不出"这个数是不是刚变的"。

   采集节奏是 6 小时（见 index.js 的 STAR_CRON）。这不是 GitHub 的限制，
   而是 star 的增长本来就是"天"的量级：采得再勤，也只是把同一批数字重复
   记进历史，曲线不会更准，反而让 JSON 长得更快。

   通知口径：每次采集算一次增量，**大于 0 才发飞书**。增量不是"跟昨天比"，
   而是"跟上一次成功采集比" —— 所以服务停了一天再起来，那个增量是累积的，
   这比"只看最近 6 小时"更接近用户想知道的"我不在的时候涨了几个"。

   通知失败不丢：pending 会把没发出去的增量攒着，下次采集合并成一条再发。
   飞书抽风的那 6 小时里进来的 star，不该就这么没人知道。 */

/** 没配仓库时盯这个（也就是这个面板自己的仓库） */
export const DEFAULT_REPO = 'yjscloud/ProxCenter';

const TIMEOUT_MS = 15000;

/** 6 小时一个点，留 480 个 ≈ 120 天。再多就该上明细表了，JSON 里不合适 */
const HISTORY_MAX = 480;

/** 超过这个间隔就该补采一次（启动时用，见 ensureStarsFresh） */
const STALE_MS = 6 * 60 * 60 * 1000;

/**
 * 把用户填的东西收成 `owner/repo`。
 *
 * 直接粘整条 GitHub 地址是常态（从地址栏复制比手敲 owner/repo 顺手），
 * 所以两种都认；末尾的 .git、查询串、多余斜杠一并削掉。
 * @returns 合法时返回 `owner/repo`；空输入返回 DEFAULT_REPO；格式不对返回 null
 */
export function normalizeRepo(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_REPO;

  /* 地址形态：从 `https://github.com/owner/repo` 里切出那两段，末尾的
     .git / 斜杠 / 子路径 / 查询串一律不管。**不能**对整串做无差别的
     replace(/[/?#].*$/) —— 那会把 https:// 的斜杠一起吃掉。 */
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+?)(?:\.git)?(?:\/.*)?(?:[?#].*)?$/i.exec(raw);
  if (url) return `${url[1]}/${url[2]}`;

  /* 简写形态：owner/repo，末尾多一个斜杠或 .git 也认 */
  const pair = raw.replace(/\/+$/, '').replace(/\.git$/i, '');
  /* GitHub 的用户名/仓库名允许字母数字和 - _ .，且不能以点开头 */
  return /^[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9-_.]+$/.test(pair) ? pair : null;
}

/** 当前生效的配置：设置页优先，.env 只作兜底（老部署继续能用） */
function configOf() {
  const s = db()?.settings?.stars || {};
  const repo = normalizeRepo(s.repo) || DEFAULT_REPO;
  return { repo };
}

/* 卡片上要说明"没配通知地址所以只记数"，而不是让人以为通知发过了。
   出口统一在 services/feishu-bot.js（应用机器人优先、webhook 回落）——
   外部任务提交复用同一条 */
export { feishuConfigured } from './feishu.js';

/**
 * 当前仓库的采样状态。
 *
 * **换了仓库就当没采过**：旧星数和旧曲线属于另一个仓库，拿它们填这张新卡片
 * 比空着更糟 —— 用户会以为新仓库已经有 128 个 star、而且一路涨上来的。
 * 这里不做"顺手清库"的写入，只在使用方读到不匹配时返回空状态；真正的重置
 * 发生在下一次采集（它会用新仓库写一份完整状态）。
 */
function stateOf() {
  const s = db()?.githubStars;
  if (!s || typeof s !== 'object') return {};
  const { repo } = configOf();
  if (s.repo && s.repo !== repo) return {};
  return s;
}

/* ── GitHub ────────────────────────────────────────────────────────── */

/**
 * 取一次仓库信息。
 *
 * 只用一个字段：stargazers_count。forks / issues 顺手带上，卡片上能多一句
 * 上下文，但不参与增量判断。
 */
async function fetchRepo(repo) {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      /* GitHub 强制要求 UA，不带直接 403。这里写死一个够用的值 */
      'User-Agent': 'personal-workbench',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    const code = err?.cause?.errors?.[0]?.code || err?.cause?.code || err?.message || err;
    throw new Error(`连不上 GitHub API：${code}`);
  });

  if (res.status === 404) throw new Error(`仓库不存在或已改名：${repo}`);
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const until = Number.isFinite(reset) && reset > 0 ? `，额度重置于 ${new Date(reset * 1000).toLocaleString('zh-CN')}` : '';
    throw new Error(`GitHub 限流（${res.status}）${until}${token ? '' : '；配一个 GITHUB_TOKEN 可提到 5000 次/小时'}`);
  }
  if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);

  const json = await res.json().catch(() => null);
  const stars = Number(json?.stargazers_count);
  if (!Number.isFinite(stars)) throw new Error('GitHub API 没有返回 stargazers_count');

  return {
    stars,
    forks: Number(json?.forks_count) || 0,
    issues: Number(json?.open_issues_count) || 0,
    description: String(json?.description || ''),
    htmlUrl: String(json?.html_url || `https://github.com/${repo}`),
  };
}

/* ── 飞书 ──────────────────────────────────────────────────────────── */

/**
 * 发一条测试消息。
 *
 * 存在的理由：webhook 地址填错、机器人被移出群、开了签名校验却没给 secret ——
 * 这三种错都要等到"下一个 star 出现"才会暴露，而那可能是好几天以后。
 * 一个按钮就能当场确认这条通道通不通。
 */
export async function sendTestNotification() {
  await notifyPanelNotice({
    title: '飞书通知已连通',
    body: '面板的通知（到期提醒、外链提交、star 增量）都会以这个格式发到这个群。',
    tone: 'success',
    source: '个人工作台 · 连通性测试',
  });
}

/* ── 采集 ──────────────────────────────────────────────────────────── */

/**
 * 采一次：取数 → 算增量 → 落库 → 有增量就发通知。
 * 失败时把原因写进状态再抛出去，让 cron 的日志和卡片的提示都能说清为什么。
 */
export async function collectStars() {
  const cfg = configOf();
  const before = stateOf();
  const now = new Date().toISOString();

  let repo;
  try {
    repo = await fetchRepo(cfg.repo);
  } catch (err) {
    /* 失败也要落库：卡片上要能说"上次成功是什么时候、这次为什么没成"。
       成功时的 stars / history 一律不动 —— 一次网络抖动不该抹掉攒了几个月的历史 */
    update((d) => {
      const s = d.githubStars && typeof d.githubStars === 'object' && d.githubStars.repo === cfg.repo
        ? d.githubStars
        : (d.githubStars = { repo: cfg.repo, stars: null, history: [], pending: 0 });
      s.error = err.message;
      s.attemptedAt = now;
      s.updatedAt = now;
    });
    await flush();
    throw err;
  }

  const prev = Number.isFinite(before.stars) ? before.stars : null;
  /* star 也会掉（删号、取消）。
     change 保留符号，界面据此显示 "+3 / −1 / 持平"；
     delta 只留正增量，飞书通知与 pending 只认它 —— 掉星不需要把人叫起来。 */
  const change = prev == null ? 0 : repo.stars - prev;
  const delta = Math.max(0, change);
  const pending = Math.max(0, Number(before.pending) || 0) + delta;
  const history = [...(Array.isArray(before.history) ? before.history : []), { t: now, stars: repo.stars }].slice(-HISTORY_MAX);

  update((d) => {
    d.githubStars = {
      ...before,
      ...repo,
      repo: cfg.repo,
      prevStars: prev,
      delta,
      /* 带符号的变化量：界面用它区分"+3 / −1 / 持平"，delta 只表示"新增了几" */
      change,
      pending,
      history,
      error: null,
      checkedAt: now,
      attemptedAt: now,
      updatedAt: now,
    };
  });
  await flush();

  if (pending > 0) {
    const body = `**${cfg.repo}** 新增 ${pending} 个 star（当前 ${repo.stars}）\nhttps://github.com/${cfg.repo}`;
    try {
      await notifyPanelNotice({
        title: 'GitHub Star 增量',
        body,
        tone: 'info',
        source: `GitHub · ${cfg.repo}`,
      });
      update((d) => {
        d.githubStars = { ...d.githubStars, pending: 0, notify: { at: new Date().toISOString(), ok: true, delta: pending, error: null } };
      });
    } catch (err) {
      /* 增量留在 pending 里，下次连着新的一起发；错误也存下来，卡片上看得见 */
      update((d) => {
        d.githubStars = { ...d.githubStars, notify: { at: new Date().toISOString(), ok: false, delta: pending, error: err.message } };
      });
    }
    await flush();
  }

  return stateOf();
}

/**
 * 启动时补采。停机期间错过的采集要接上 —— 否则卡片的空窗期不是 6 小时，
 * 而是"从上次跑到下次整点"那么长。
 * @returns 补采结果；没到时间则为 null
 */
export async function ensureStarsFresh() {
  const s = stateOf();
  const at = Date.parse(s.checkedAt || '');
  if (Number.isFinite(at) && Date.now() - at < STALE_MS) return null;
  return collectStars();
}

/* ── 给接口的报告 ──────────────────────────────────────────────────── */

/**
 * 字段**恒定齐全**（没采过时是 null），前端因此不必猜"这次到底有没有这个键"。
 * 不含 webhook 地址与签名密钥 —— 它们只在服务端读，界面只需要知道配没配。
 */
export function starsReport() {
  const cfg = configOf();
  const s = stateOf();
  return {
    repo: cfg.repo,
    stars: Number.isFinite(s.stars) ? s.stars : null,
    prevStars: Number.isFinite(s.prevStars) ? s.prevStars : null,
    /* 最近一次采集的增量（6 小时窗口） */
    delta: Number.isFinite(s.delta) ? s.delta : 0,
    /* 攒着还没发出去的增量。界面不用强调它，但通知失败时要能解释 */
    pending: Number(s.pending) || 0,
    forks: Number(s.forks) || 0,
    issues: Number(s.issues) || 0,
    description: String(s.description || ''),
    htmlUrl: s.htmlUrl || `https://github.com/${cfg.repo}`,
    checkedAt: s.checkedAt || null,
    attemptedAt: s.attemptedAt || null,
    history: Array.isArray(s.history) ? s.history.slice(-HISTORY_MAX) : [],
    notify: s.notify && typeof s.notify === 'object' ? s.notify : null,
    error: s.error || null,
    /* 卡片上要说明"没配通知地址所以只记数"。这里问的是"通知能不能发"，
       所以应用机器人配全也算数 —— 只看 webhook 会把那种人误报成没配 */
    feishuConfigured: panelNotifyReady(),
  };
}
