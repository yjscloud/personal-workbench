/* ── 类型 ──────────────────────────────────────────────────────────── */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Todo = {
  id: string;
  text: string;
  done: boolean;
  priority: Priority;
  due: string;
  createdAt: string;
};

export type TicketStatus = 'todo' | 'doing' | 'review' | 'done';
/** 子任务：把一道运维任务拆成可勾选的步骤 */
export type ChecklistItem = { id: string; text: string; done: boolean };

export type Ticket = {
  id: string;
  title: string;
  priority: Priority;
  status: TicketStatus;
  project: string;
  /** 项目内的分类（「分组」）。空字符串表示没归类 */
  section: string;
  owner: string;
  due: string;
  note: string;
  tags: string[];
  checklist: ChecklistItem[];
  /** 非空表示已归档 */
  archivedAt?: string | null;
  /** 非空表示在回收站（软删除，可恢复） */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

/** 任务评论（独立表，逐行读写，不走 bootstrap） */
export type TicketComment = {
  id: string;
  ticketId: string;
  content: string;
  createdAt: string;
};

/** 任务附件：content 是 data URL，前端直接拿来预览图片或下载 */
export type TicketAttachment = {
  id: string;
  ticketId: string;
  name: string;
  mime: string;
  size: number;
  content: string;
  /** 内联图片：粘贴进备注 / 评论的图，只在正文里用，不列进附件区 */
  inline: boolean;
  createdAt: string;
};

/** 项目：任务的上一层。任务侧用 project 字段存项目名，两者靠名字关联 */
export type Project = {
  id: string;
  name: string;
  note: string;
  sort: number;
  createdAt: string;
};

/** 项目内的分类（「分组」）。任务侧用 section 存名字，只在所属项目内唯一 */
export type ProjectSection = {
  id: string;
  projectId: string;
  name: string;
  sort: number;
  createdAt: string;
};

export type Bookmark = {
  id: string;
  name: string;
  url: string;
  group: string;
  note: string;
  color?: string;
  /**
   * 自定义图标（base64 data URL）。**只用于提交**——
   * 列表接口不回本体（几十张图 base64 会把首屏顶得很难看），只给 hasIcon。
   */
  icon?: string;
  /**
   * 服务端告知「这个书签有图标可用」（自定义的或从站点抓来固化下来的），
   * 本体走 /bookmarks/:id/icon 取。
   *
   * 它在页面上只意味着一件事：**不必再现场去站点取 favicon**。图标已经固化，
   * 刷新时直接从同源缓存里出来，所以首帧就能画对，不再有"色块→图标"那一下。
   */
  hasIcon?: boolean;
  /** 这张图标是用户自己传的（决定编辑弹窗里那颗「清除」要不要出现） */
  hasCustomIcon?: boolean;
  /**
   * 图标内容的短版本号。图标一变它就变，所以图标地址可以长缓存 ——
   * 换了图标之后 URL 跟着换，不会让浏览器继续拿旧的那张。
   */
  iconV?: string;
  /** 标记为常用：会出现在首页「常用网站」里 */
  pinned?: boolean;
};

export type Group = { id: string; name: string; order: number };

/** 外链导入的结果，见 server/services/importer.js */
export type ImportedArticle = {
  url: string;
  title: string;
  summary: string;
  markdown: string;
  siteName: string;
  publishedAt: string;
  tags: string[];
  /** 抽取过程中的不确定之处。必须显示出来 —— 这个功能是启发式的，
   *  不说清楚"哪里可能不对"，用户就只能靠自己猜 */
  warnings: string[];
};

/** 文章助手对话里的一轮。task 只有预设动作（总结/分析/解释）才有值 */
export type KnowledgeAiTurn = { role: 'user' | 'ai'; text: string; task: string | null; at: string | null };

/**
 * 文章助手的对话记录。存在条目自己身上，所以**删条目就一起没了** ——
 * 不需要级联删除，也不会留下"文章没了、回答还在"的孤儿数据。
 */
export type KnowledgeAiLog = { turns: KnowledgeAiTurn[] };

export type KnowledgeItem = {
  id: string;
  /**
   * sop = 固定流程；runbook = 故障处置；excerpt = 阅读摘录（从别处读来的东西）。
   * 只是字符串，所以加第三档不需要改表；归一化在服务端
   * （services/knowledge.js 的 normalizeType）。
   */
  type: 'sop' | 'runbook' | 'excerpt';
  title: string;
  tags: string[];
  summary: string;
  /**
   * Markdown 正文。**列表接口不给它** —— 只有 `GET /knowledge/:id` 和
   * `?full=1` 才带。正文动辄上万字，跟着首屏全量下发等于打开首页
   * 就要下载整个知识库，而每个页面都为它买单。
   */
  body?: string;
  /** 正文开头一小段纯文本（服务端用 body_plain 截的），卡片预览用 */
  excerpt?: string;
  /** 只在搜索结果里出现：命中处周围的一段上下文，比开头那句更贴问题 */
  snippet?: string;
  /** 置顶：排在列表最前。它**不影响** updatedAt —— 置顶不是"更新了文章" */
  pinned: boolean;
  /** 星标：标记 + 可在列表里单独筛出来 */
  starred: boolean;
  /** 文章助手的对话记录（只属于这一篇） */
  ai: KnowledgeAiLog;
  /**
   * 软删除时间。非空即在回收站里。
   *
   * 列表接口**不过滤**它 —— 整份元信息一起下发，由页面按「知识库 / 回收站」
   * 分成两份显示（口径与任务一致，见 Week.tsx 的 Bucket）。
   * 满多少天被永久删除由服务端的留存清理决定，天数见 settings.knowledgeTrashKeepDays。
   */
  deletedAt?: string | null;
  updatedAt: string;
};

export type NewsItem = {
  id: string;
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  summary: string;
  tags: string[];
  /** AIHOT 的打分（0–100）。null 表示来源还没给这条评分，不是 0 分 */
  score?: number | null;
  /** 来源写的"为什么推荐这条"。精选条目基本都有，是最有信息量的一句话 */
  reason?: string | null;
  /** 这条在 AIHOT 上的页面。既用于溯源，也给出"看完整上下文"的去处 */
  aihotUrl?: string | null;
};

/** 邻居事件：同一故事线上的其它事件，或相关事件 */
export type NewsNeighbor = {
  publicId: string | null;
  title: string;
  /** 与该事件的关系（接口给的字符串，如"同故事线"） */
  relation: string;
  link: string | null;
};

/** 一个事件的故事线：跨源报道时间线 + 随事件演进重写的 AI 综述 */
export type NewsStory = {
  publicId: string | null;
  /** active = 仍在发展；settled = 已平息 */
  status: 'active' | 'settled';
  sourceCount: number;
  reportCount: number;
  firstReportAt: string | null;
  latestAt: string | null;
  latest: string;
  /** AI 综述。会随事件推进增量重写，并标注与早期报道矛盾之处 */
  digest: string | null;
  digestUpdatedAt: string | null;
  reports: { title: string; summary: string; source: string; publishedAt: string | null; link: string }[];
  /** 同一故事线上的其它事件。接口常常给空数组 —— 事件还没被串起来 */
  storyline: NewsNeighbor[];
  /** 相关事件 */
  related: NewsNeighbor[];
};

/** AIHOT 每日日报（每天 08:00 出一期） */
export type NewsDaily = {
  updatedAt: string | null;
  lastError: string | null;
  report: {
    date: string | null;
    generatedAt: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    /** 这一期日报在 AIHOT 上的页面 */
    link: string | null;
    lead: { title: string; paragraph: string } | null;
    sections: { label: string; items: { title: string; summary: string; source: string; link: string }[] }[];
    flashes: { title: string; source: string; publishedAt: string | null; link: string }[];
  } | null;
};

/** 热点榜上的一条事件 */
export type NewsTopic = {
  publicId: string | null;
  rank: number;
  title: string;
  /** 原文链接（榜上那条报道） */
  link: string;
  /** AIHOT 上的人类可读页面。null 表示这条榜还没有对应的事件页 */
  storyUrl: string | null;
  /** 有几家媒体报道过 */
  sourceCount: number;
  /** 采集到的信号条数 */
  signalCount: number;
  sourceNames: string[];
  latestAt: string | null;
  /** 故事线。null = 这条没抓到（事件被合并或已下线），榜单本身仍然成立 */
  story: NewsStory | null;
};

/** 多源热点榜的整份快照。榜是"某一时刻的一张榜"，所以整份替换，不做合并 */
export type NewsHot = {
  updatedAt: string | null;
  lastError: string | null;
  topics: NewsTopic[];
};

/** 温度归类，由后端的芯片名（coretemp / acpitz / nvme …）决定，不是按读数标签猜的 */
export type SensorKind = 'cpu' | 'board' | 'disk' | 'other';

export type SensorReading = { name: string; value: number; chip?: string; kind?: SensorKind };

export type PveStatus = {
  node: string;
  cpu: number;
  memory: { used: number; total: number; free: number };
  rootfs: { used: number; total: number; free: number; avail: number };
  swap: { used: number; total: number };
  loadavg: string[];
  uptime: number;
  iowait: number;
  cpuinfo: { cores: number; cpus: number; sockets: number; model: string; mhz: string };
};

export type PveDisk = {
  dev: string;
  model: string;
  type: string;
  size: number;
  used: number;
  health: string;
  wearout: number | null;
};

/** 一块盘的完整 SMART 健康数据。取自母机上的 smartctl，见 server/services/smart.js */
export type DiskHealth = {
  dev: string;
  available: boolean;
  error: string | null;
  kind: 'nvme' | 'ata' | 'unknown' | null;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  capacityBytes: number | null;
  /** 设备是否支持 SMART / 是否已启用 */
  smartSupport: boolean | null;
  smartEnabled: boolean | null;
  /** SMART 综合判定：true=通过，false=设备报告异常 */
  passed: boolean | null;
  /** 剩余寿命百分比；ATA 盘若无相应属性则为 null */
  healthPercent: number | null;
  wearPercent: number | null;
  temperature: { current: number | null; opLimit: number | null; criticalLimit: number | null; sensors: number[] | null } | null;
  powerOnHours: number | null;
  powerCycles: number | null;
  /** 异常断电次数（NVMe: unsafe_shutdowns / ATA: 属性 174） */
  unsafeShutdowns: number | null;
  readBytes: number | null;
  writeBytes: number | null;
  hostReads: number | null;
  hostWrites: number | null;
  mediaErrors: number | null;
  errorLogEntries: number | null;
  controllerBusyMinutes: number | null;
  tempWarningMinutes: number | null;
  tempCriticalMinutes: number | null;
  criticalWarning: { raw: number; flags: string[] } | null;
  spare: { available: number | null; threshold: number | null } | null;
  reallocatedSectors: number | null;
  nvmeVersion: string | null;
  namespaces: number | null;
  selfTest: string | null;
  /** smartctl 原始退出码（位掩码）；非 0 不等于采集失败 */
  smartctlExit: number | null;
  perDayWriteBytes: number | null;
  perDayReadBytes: number | null;
  /** 按当前磨损速度线性外推的剩余小时数，仅作量级参考 */
  lifeRemainingHours: number | null;
  /** 仅 ATA 盘：完整属性表 */
  attrs?: Array<{
    id: number | null;
    name: string;
    value: number | null;
    worst: number | null;
    thresh: number | null;
    raw: number | null;
    rawString: string | null;
    failed: string | null;
  }>;
  sampledAt?: number;
};

export type SeriesPoint = {
  time: number;
  cpu: number;
  iowait: number;
  loadavg: number;
  memused: number;
  maxmem: number;
  rootused: number;
  roottotal: number;
  netin: number;
  netout: number;
  diskread: number | null;
  diskwrite: number | null;
};

export type Guest = {
  vmid: number;
  name: string;
  status: string;
  cpu: number;
  maxmem: number;
  mem: number;
  uptime: number;
};

/** 功耗来源：ha=米家插座实测 / sensor=PVE 硬件传感器 / model=CPU 利用率估算 */
export type PowerSource = 'ha' | 'sensor' | 'model';

/** 服务端用电采样器状态（用电量靠实测功率积分，必须常驻采样） */
export type SamplerStatus = {
  running: boolean;
  intervalSeconds: number;
  lastSampleAt: number | null;
  lastError: string | null;
};

export type PowerReport = {
  watts: number;
  source: PowerSource;
  /**
   * 用电量口径：
   *   integrated = 对插座实测电功率按时间积分（这块设备实际走的就是这条）
   *   meter      = 各插座累计读数之和（该属性在 cuco.plug.v3 上是坏的，恢复后才会用）
   */
  costBasis: 'integrated' | 'meter';
  /** Home Assistant 侧读数与连接状态 */
  ha: {
    configured: boolean;
    online: boolean;
    /** 各插座的分项读数，页面用它展示"哪一路在耗电" */
    sockets: {
      id: string;
      name: string;
      powerEntity: string;
      watts: number | null;
      counterKwh: number | null;
      ok: boolean;
      error: string | null;
    }[];
    /** 各插座累计读数之和；只在所有插座都提供可用读数时才有值 */
    counterKwh: number | null;
    lastUpdated: string | null;
    error: string | null;
  };
  /**
   * 插座「耗电量」属性读数。
   * 这块设备（cuco.plug.v3）的该属性实测是坏的（云端恒定 0.01 kWh），
   * 所以只作诊断展示；alive 为 true 时才会切换成该口径。
   */
  meter: {
    counterKwh: number | null;
    todayKwh: number | null;
    monthKwh: number | null;
    alive: boolean;
  };
  /** 当前口径的时间覆盖：不足窗口时「近一月」其实只是「自开始记录以来」 */
  window: {
    basis: 'integrated' | 'meter' | 'entity';
    days: number;
    since: string | null;
    windowDays: number;
    hasFullWindow: boolean;
  };
  model: {
    idleW: number;
    maxW: number;
    perDiskW: number;
    extraW: number;
    cpuWatts: number | null;
    baseWatts: number | null;
    cpuRatio: number | null;
  };
  eco: {
    enabled: boolean;
    factor: number;
    /** measured = 由实测数据算出；manual = 样本不足，回退到设置里手填的系数 */
    basis: 'measured' | 'manual';
    manualFactor: number;
    /** 实测明细，basis='manual' 时为 null */
    measured: EcoMeasurement | null;
    standardWatts: number;
    savedWatts: number;
    savedPercent: number;
    /** 节能模式下累计用掉的电，节省量由 factor 从它反推 */
    ecoKwhTotal: number;
    totalSavedKwh: number;
    totalSavedCost: number;
  };
  /**
   * 月度序列，最新在前，最多 12 个月。
   * 近期月份由日明细现算，更早的月份来自归档表（日明细只留 3 个月）。
   */
  monthly: {
    month: string;
    kwh: number;
    cost: number;
    days: number;
    /** true = 来自归档，日明细已被清理 */
    archived: boolean;
    /** true = 当月未过完 */
    partial: boolean;
  }[];
  /** 当前生效的留存窗口，界面用它说明"再往前的数据已清理" */
  retention: { dailyKeepMonths: number; monthlyKeepMonths: number };
  price: { perKwh: number; currency: string };
  today: { kwh: number; cost: number; sampledKwh: number; ecoKwh: number; samples: number };
  projection: { dayKwh: number; dayCost: number; monthKwh: number; monthCost: number; yearCost: number };
  cumulative: {
    monthKwh: number;
    monthCost: number;
    sampledMonthKwh: number;
    sampledMonthCost: number;
    totalKwh: number;
    totalCost: number;
    daysTracked: number;
  };
  history: { date: string; kwh: number; cost: number }[];
  sampledAt: number;
};

/** 节能效果的实测量。只在同一负载档内比较两种模式，见后端 measureEcoFactor */
export type EcoMeasurement = {
  /** 样本不足时为 null；此时 evidence 仍会带上已积累的时长，用于显示进度 */
  factor: number | null;
  savedPercent: number | null;
  /** 参与计算的负载档明细 */
  bands: { band: string; standardWatts: number; ecoWatts: number; hours: number; savedWatts: number; ratio: number }[];
  /** 参与计算的加权总时长（小时） */
  comparedHours: number;
  minBandHours: number;
  /** 各档已积累的样本时长，用来判断结论可信度 */
  evidence: { band: string; standardHours: number; ecoHours: number }[];
};

/** 一块网卡的收发计数与速率。来自母机 /proc/net/dev，见 server/services/net.js */
export type NetInterface = {
  iface: string;
  kind: 'physical' | 'bond' | 'bridge' | 'vlan' | 'other';
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxErrs: number;
  txErrs: number;
  rxDrop: number;
  txDrop: number;
  /** 首次采样没有前值可比对，速率为 null */
  rxRate: number | null;
  txRate: number | null;
};

export type NetTraffic = {
  available: boolean;
  error: string | null;
  interfaces: NetInterface[];
  /** 合计只统计物理口与聚合口：桥与物理口流量重叠，全加会重复计 */
  total: {
    rxRate: number | null;
    txRate: number | null;
    rxBytes: number;
    txBytes: number;
    windowSec: number | null;
  } | null;
  sampledAt: number;
};

export type Overview = {
  mode: 'demo' | 'live';
  node: string;
  warning: string | null;
  status: PveStatus;
  sensors: { temperatures: SensorReading[]; power: SensorReading[] };
  disks: PveDisk[];
  /** 完整 SMART 健康数据；演示模式或采集不可用时为 null */
  diskHealth: { disks: DiskHealth[]; available: boolean; error: string | null } | null;
  /** 逐网卡流量；演示模式或采集不可用时为 null */
  net: NetTraffic | null;
  /** 被排除的模板数量（模板是克隆用的镜像，不算在运行的机器里） */
  templateCount: number;
  series: SeriesPoint[];
  ioAvailable?: boolean;
  guests: { qemu: Guest[]; lxc: Guest[] };
  timeframe: string;
  power: PowerReport;
  growth?: GrowthReport | null;
  /** 母机 CPU 调频器状态：governor 是实测值（读不到为 null），expected 是当前模式应有的值 */
  cpu?: { governor: string | null; expected: string };
};

export type GrowthReport = {
  perDayBytes: number;
  daysLeft: number | null;
  samples: number;
  available: boolean;
  usedRatio?: number;
};

/** 一个插座：只需选一个功率实体；整机功耗 = 所有启用插座功率之和 */
export type HaSocket = {
  id: string;
  name: string;
  powerEntity: string;
  /** 可选：累计电量读数；所有插座都提供且可用时才会采用这个口径 */
  counterEntity: string;
  enabled: boolean;
};

export type HaSettings = {
  url: string;
  verifyTls: boolean;
  sockets: HaSocket[];
  /** 令牌不落库、不回显：这里只表示服务端环境变量 HA_TOKEN 是否已配置 */
  hasToken?: boolean;
};

/** HA 里可选的实体（服务端按 device_class / 单位筛出来的候选） */
export type HaEntityOption = {
  entityId: string;
  name: string;
  unit: string;
  deviceClass: string;
  value: number | null;
  group: string;
};

export type HaOptions = {
  url: string;
  total: number;
  power: HaEntityOption[];
  energy: HaEntityOption[];
  /** 当前配置里已在使用的实体 ID */
  inUse: string[];
};

export type BackgroundSettings = {
  /** none = 用主题自带的 canvas 渐变 */
  kind: 'none' | 'url' | 'upload';
  url: string;
  /** 遮罩浓度 0~0.9：照片上那层纱，太低会压掉正文可读性 */
  overlay: number;
  /** 背景虚化 0~24px */
  blur: number;
  /** 派生态：磁盘上是否真有上传的图（kind='upload' 时靠它判断能不能用） */
  hasUpload?: boolean;
  /** 派生态：上传时间，兼作图片地址的版本号做缓存失效 */
  uploadedAt?: number | null;
  size?: number | null;
};

/**
 * 登录页背景：独立于主背景的一份配置。
 * canvas = 内置的柔彩波浪画布（默认），另外两种是图片链接 / 上传的图片。
 * 服务端把这个对象随 /auth/me 一起回传，因为登录页在**未登录**时就要用到它。
 */
export type LoginBackground = {
  kind: 'canvas' | 'url' | 'upload';
  url: string;
  overlay: number;
  blur: number;
  hasUpload?: boolean;
  uploadedAt?: number | null;
  size?: number | null;
};

/** 一个搜索引擎：url 里的 %s 是查询词占位符，提交时用 encodeURIComponent 填进去 */
export type SearchEngine = { id: string; name: string; url: string };

export type Settings = {
  /** 首页问候语里的称呼；为空则只显示「早上好」 */
  profile: { name: string };
  /**
   * 智能办公室。「打开完整办公室」跳去哪 —— 留空表示用服务端 .env 的
   * HERMES_BASE_URL；同一台机器在内网里可能有多个入口（IP / 主机名 / 反代域名），
   * 从哪个进由这里定。只影响那个按钮的链接，不影响服务端怎么调它的接口。
   */
  hermes: {
    officeUrl: string;
    /**
     * 智能办公室四块面板摆在哪一列、各自什么次序（存 key，不是文案）。
     * 空对象 / 缺项 = 用默认摆法。
     *
     * 之所以是"两列"而不是一个顺序数组：两列数量可以不等（默认是 3 + 1），
     * 单个顺序数组没法表达 —— 只能靠"前一半/后一半"这种硬规则，切不出 3+1。
     * 前端负责补齐缺的、丢掉不认识的：对面加减面板时旧值要还能用，
     * 所以**不要**假设这里总有四块、也没有未知 key。
     */
    officeLayout: { left: string[]; right: string[] };
  };
  /** 首页搜索框：引擎列表 + 默认项 + 是否新标签页打开 */
  search: {
    engines: SearchEngine[];
    /** 默认选中的引擎 id；为空则用列表第一个 */
    defaultEngine: string;
    newTab: boolean;
    /**
     * 联想：把输入发给所选搜索引擎，取它的候选词。
     * 缺省视为开启（老配置里没有这个字段），这是本站唯一会把输入
     * 转发给第三方的功能，所以设置页给了开关和说明。
     */
    suggest?: boolean;
  };
  background: BackgroundSettings;
  /** 登录页自己的背景图 */
  loginBackground: LoginBackground;
  /** 登录账号概览。passwordHash 永远不会出现在这里 */
  auth: { user: string; enabled: boolean; custom: boolean; envFallback: boolean };
  theme: { mode: 'dark' | 'light'; accent: 'azure' | 'copper' | 'signal' | 'violet' };
  pve: { host: string; port: number; tokenId: string; tokenSecret: string; node: string; verifyTls: boolean; hasSecret?: boolean };
  ha: HaSettings;
  power: {
    idleW: number;
    maxW: number;
    perDiskW: number;
    extraW: number;
    pricePerKwh: number;
    currency: string;
    eco: boolean;
    ecoFactor: number;
  };
  /* AI 热点只接 AIHOT 公开 API。筛选（精选 / 全量、分数门槛）只在抓取入库
     那一步生效，界面上不出现这类控件 —— 所以这些是配置项，不是筛选器状态。 */
  news: {
    autoUpdate: boolean;
    cron: string;
    aihot: {
      /** 关掉不会清空页面，只是不再更新，已抓到的内容照旧留着 */
      enabled: boolean;
      /** selected = 只要精选；all = 全量，再本地按 minScore 切一刀 */
      mode: 'selected' | 'all';
      /** 入库时的分数门槛 */
      minScore: number;
      /** 每次入库上限 */
      maxItems: number;
      /** 最多翻几页（接口单页上限 100） */
      pages: number;
    };
  };
  /** 知识库备份到腾讯云 COS。凭证存在库里，SecretKey 只以掩码回显 */
  backup: BackupSettings;
  autoBackup: boolean;
  refreshSeconds: number;
  /**
   * 回收站保留多少天（服务端 services/retention.js 的固定规则）。
   * 页面文案取自它，而不是自己写死一个 7 —— 否则改了规则，
   * 界面上那句"保留 7 天"就成了假话。
   */
  knowledgeTrashKeepDays?: number;
  updatedAt: string;
};

/**
 * 备份设置。
 *
 * last* 那一组是服务端回写的运行状态：页面要能显示"上次备份：什么时候、
 * 多大、成没成"，光有日志是不够的 —— 没人会为了确认备份有没有跑去看日志。
 */
/**
 * 一份备份里的规模。恢复前后各取一次，好说清"换掉了多少"。
 *
 * 只有这三样：这份备份的范围就是知识库与工具箱（书签 + 分组），
 * 任务、设置那些不在里面，也永远不会被它覆盖。
 */
export type BackupCounts = { knowledge: number; groups: number; bookmarks: number };

export type BackupSettings = {
  enabled: boolean;
  /** cron 表达式。服务端会校验，非法值直接拒掉（不会存一个跑不起来的计划） */
  cron: string;
  /** 对象键前缀，只允许 ASCII 字母数字与 - _ / */
  prefix: string;
  cos: {
    secretId: string;
    /** GET 时是掩码；PUT 时原样回传表示"没改过" */
    secretKey: string;
    /** 存储桶名，要带 -APPID 后缀 */
    bucket: string;
    /** 地域，如 ap-beijing */
    region: string;
    hasSecretKey?: boolean;
  };
  lastRunAt: string | null;
  lastKey: string;
  lastBytes: number;
  lastDocs: number;
  /** manual = 手动点出来的；schedule = 定时任务跑的 */
  lastTrigger: string;
  lastStatus: '' | 'ok' | 'error';
  lastError: string;
};

/**
 * Hermes Agent Office 的工位状态。
 * 网关自己给的是下划线那套字段名，后端 services/hermes.js 已经归一化过。
 */
export type HermesSeats = {
  baseUrl: string;
  gatewayVersion: string | null;
  /** 工位总数 */
  seats: number | null;
  /** 在编（已入驻的智能员工） */
  staffed: number | null;
  /** 待入驻的空位 */
  vacant: number | null;
  online: number | null;
  items: { id: string; name: string; en: string; online: boolean }[];
  /** 网关最近一次探测员工的时间 */
  checkedAt: string | null;
  /** 服务端有没有配 Hermes 口令（决定登录墙后面那些数据能不能接） */
  credentials: boolean;
};

/**
 * 智能工位里的一位员工。
 *
 * 服务端把"网关给的在线状态"和"岗位档案"合并好了。岗位职责、工位号、立绘文件名
 * 只存在于那台控制台自己的前端常量里（没有接口可取），所以由服务端照抄一份 ——
 * 见 server/services/office.js 顶部那段说明。
 */
export type OfficeEmployee = {
  id: string;
  name: string;
  en: string;
  role: string;
  /** 工位号，如 A-02 */
  seat: string;
  /** 立绘地址：已指向本服务的代理（/api/office/avatar/xxx.png），不是内网地址 */
  avatar: string;
  online: boolean;
  /** agent = 有真正的对话通道（白饭）；null = 工具集 / 守望 / 采集子系统，没有对话概念 */
  chat: 'agent' | null;
};

/** 工位状态 + 员工档案。工位那几个数与 /hermes/seats 同一套口径 */
export type OfficeRoster = Omit<HermesSeats, 'items'> & {
  items: OfficeEmployee[];
  /** 网关回里有、服务端档案没跟上的 id（正常为空；不为空说明对面加了人） */
  unknown: string[];
};

/** 全局待办工作表（那台控制台的 /local/board） */
export type OfficeBoard = {
  conversations: {
    total: number;
    /** 进行中 = 尚未结束的会话 */
    active: number;
    done: number;
    today_new: number;
    by_source: Record<string, number>;
    end_reasons: string[];
    definition: string;
  };
  jobs: {
    id: string;
    name: string;
    enabled: boolean;
    state: string;
    schedule: string;
    next_run_at: string | null;
    last_run_at: string | null;
    last_status: string;
    failure_streak: number;
    runs_completed: number;
  }[];
  runs: {
    id: string;
    job_id: string;
    job_name: string;
    status: string;
    source: string;
    started_at: string | null;
    finished_at: string | null;
    duration_s: number | null;
    error: string;
  }[];
  incidents: {
    id: string;
    job_id: string;
    job_name: string;
    state: string;
    failure_type: string;
    error: string;
    first_seen_at: string;
    last_seen_at: string;
  }[];
  generated_at: string;
};

/** 一天的 token 用量。数字来自网关的真实记账，不是估算 */
export type OfficeUsageDay = {
  day: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  total: number;
  api_calls: number;
  sessions?: number;
  sources?: Record<string, number>;
  top_sessions?: { id: string; title: string; source: string; token: number }[];
};

/** 今日 / 昨日 / 近 7 日 token 用量与预算 */
export type OfficeUsage = {
  today: OfficeUsageDay;
  yesterday: OfficeUsageDay;
  series: OfficeUsageDay[];
  budget_tokens: number;
  budget_label: string;
  models: string[];
  gateway: { version: string; pid: number; uptime_s: number };
  generated_at: string;
};

/**
 * 一次对话（会话级）。注意 started_at / last_active 是 **unix 秒**（带小数），
 * 不是 ISO 串 —— 直接交给 new Date() 会得到 1970 年。
 */
export type OfficeSession = {
  id: string;
  source: string;
  title: string;
  model: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  api_call_count: number;
  last_active: number;
  preview: string | null;
  pinned: boolean;
};

/** 对话里的一条消息。role 可能是 user / assistant / tool */
export type OfficeMessage = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_name: string | null;
  timestamp: number;
  token_count: number | null;
};

/**
 * 与员工对话的流式事件。
 *
 * 服务端已经把网关那套私有帧名（assistant.delta / tool.started / run.completed …）
 * 翻成这套口径，所以这里跟工作台助手是同一个写法，前端不必知道上游长什么样。
 */
export type OfficeChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; usage: { total: number; input: number; output: number } | null; model: string | null }
  | { type: 'error'; message: string };

/* ── 工位详情（点开工位后那个弹窗）─────────────────────────────────── */

/**
 * 抬头那一排小标签。每个岗位的口径不同（本体看网关记账、司册看 MCP 进程、
 * 拾贝看它自己的模型消耗、值守看定时任务），所以图标与文案都由服务端给，
 * 前端只负责画 —— 口径是上游定的，抄到前端就会分叉。
 */
export type OfficeSeatChip = {
  key: string;
  icon: 'seat' | 'token' | 'clock' | 'target';
  label: string;
  /** 直接显示的文案（工位号、不适用、空闲待命…） */
  value?: string;
  /** 有时长时给秒数，由前端用同一套格式化（服务端不重复实现一份） */
  seconds?: number;
  /** 悬停说明 */
  tip?: string;
};

/** 页签名。与上游控制台一致 */
export type OfficeSeatTabKey = 'config' | 'skills' | 'evo' | 'memory' | 'chat';

export type OfficeSeatDetail = {
  profile: OfficeEmployee;
  chips: OfficeSeatChip[];
  /** 这个岗位有哪些页签，由服务端给（判断逻辑在上游） */
  tabs: OfficeSeatTabKey[];
};

/** 配置文档：上游在浏览器里拼 Markdown，我们让服务端拼好，前端只管渲染与复制 */
export type OfficeTabDoc = { kind: 'doc'; source: string; markdown: string };

export type OfficeTabSkillItem = { name: string; description: string; meta: string; tags: string[] };
export type OfficeTabSkills = {
  kind: 'skills';
  total: number;
  groups: { label: string; count: number }[];
  items: OfficeTabSkillItem[];
};

export type OfficeTabEvo = {
  kind: 'evo';
  source: string;
  stats: { label: string; value: string }[];
  timeline: { at: string; kind: string; title: string; text: string; right: string }[];
};

export type OfficeTabMemory = {
  kind: 'memory';
  records: { at: string; text: string }[];
  memories: { tag: string; text: string }[];
  note?: string;
};

export type OfficeSeatTab = OfficeTabDoc | OfficeTabSkills | OfficeTabEvo | OfficeTabMemory;

/** 拾贝的一条历史抓取记录（按它当时的卡片样子回放） */
export type OfficeHarvestItem = {
  ts: number;
  url: string;
  host: string;
  selector: string;
  mode: string;
  ok: boolean;
  error: string;
  status: number;
  title: string;
  note: string;
  pages: number;
  blocked: string;
  field_names: string[];
  count: number;
  total: number;
  elapsed_ms: number;
  items: { text: string; values: string[] }[];
};

/** 给拾贝下指令的结果：要么它回一句话（不是抓取指令），要么一条真的抓取结果 */
export type OfficeHarvestRun =
  | { kind: 'reply'; reply: string; usage?: { tokens?: number; elapsed_ms?: number; cached?: boolean } }
  | {
      kind: 'scrape';
      usage?: { tokens?: number; elapsed_ms?: number; cached?: boolean };
      result: Partial<OfficeHarvestItem> & { columns?: string[]; rows?: string[][]; markdown?: string };
    };

export type Bootstrap = {
  todos: Todo[];
  tickets: Ticket[];
  projects: Project[];
  sections: ProjectSection[];
  bookmarks: Bookmark[];
  groups: Group[];
  knowledge: KnowledgeItem[];
  news: { updatedAt: string | null; lastError: string | null; count: number };
  settings: Settings;
};

export type AssistantReply = {
  reply: string;
  actions: { type: string; to?: string }[];
  engine?: 'rule' | 'llm' | 'local';
  warning?: string;
};

/**
 * 流式问答的事件：thinking 是模型推理（只表示"有进展"），delta 是答案片段，
 * done 收尾——其中 reply 为 null 表示"保留已经流出去的内容"，不要覆盖。
 */
export type AssistantStreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; reply: string | null; actions: { type: string; to?: string }[]; engine?: 'rule' | 'llm' | 'local'; warning?: string };

/**
 * 文章助手的事件。和工作台助手同构，区别是它没有 actions（不会去动工作台），
 * 失败统一走 error —— 文章助手没有"回退本地规则"这一说，规则引擎读不了整篇文章。
 */
export type ArticleAiEvent =
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; reply: string }
  | { type: 'error'; message: string };

/**
 * 一次或一组调用的 token 用量。
 * 数字来自上游返回的 usage，不是估算 —— 拿不到的那一笔不记，也不编一个数出来。
 */
export type AiUsageCounter = { prompt: number; completion: number; calls: number };

/** 全站 token 用量（顶栏那个统计） */
export type AiUsage = {
  total: AiUsageCounter;
  /** 今天。按天看才有信息量：总量只增不减，看久了等于没看 */
  today: AiUsageCounter;
  /** 昨天。给"较昨日"用 —— 日期由服务端算，前端不自己推 */
  yesterday: AiUsageCounter;
  /** 按用途：assistant / article / news / other */
  sources: Record<string, AiUsageCounter>;
  days: Record<string, AiUsageCounter>;
  /** 最近 14 天，按日期升序、缺的天已补零。日期由服务端算，前端不自己推 */
  series: (AiUsageCounter & { key: string })[];
  /** 用途键 → 中文名，由服务端给，前端不维护第二份 */
  labels: Record<string, string>;
  /**
   * Hermes 网关的记账（含智能办公室里的员工）。
   *
   * 为什么要有它：面板自己只记得到"我调了几次模型"，而办公室那几位
   * （定时任务、巡检、采集）的用量全在网关那边，面板看不见 ——
   * 不并进来，顶栏那个数就漏掉了大部分消耗。
   *
   * 注意它**已经包含面板自己的调用**（面板走的就是网关的 /v1 接口，在
   * 它的记账里归到 api_server 那一档），所以两个数不能相加，只能用它替代。
   * null = 还没取到（首次读、或没配口令、或网关不通），此时退回本地记账。
   */
  gateway: AiGatewayUsage | null;
};

/** 网关侧的今日用量摘要 */
export type AiGatewayUsage = {
  today: {
    total: number;
    input: number;
    output: number;
    cache_read: number;
    api_calls: number;
    /** 按来源的 token 数：cron（员工定时任务）/ api_server（接口调用）… */
    sources: Record<string, number>;
  };
  yesterday: { total: number; api_calls: number };
  models: string[];
  budget_tokens: number;
  budget_label: string;
  /** 这一份是什么时候取的（服务端缓存，最多一分钟旧） */
  at: string;
  /** 上次取失败的原因。有值时说明这份是旧的 */
  error?: string;
};

/** AI 读的一条对话。**不落库** —— 热点条目会轮换，留着反而是垃圾数据 */
export type NewsReadTurn = { role: 'user' | 'ai'; text: string; task: string | null };

/**
 * 「AI 读」的事件。比文章助手多两种：
 * stage 是"正在做什么"（后一条覆盖前一条），note 是"这次要额外说明的事"（保留下来）。
 * 分开是因为「没抓到正文」那句提醒必须在回答出来之后仍然看得见，
 * 不能和"正在读…"抢同一个位置、被下一句进度提示顶掉。
 */
export type NewsReadEvent =
  | { type: 'stage'; text: string }
  /** 这次抓取的结果：正文多长、什么语言、读的哪一份。给界面上的标注用 */
  | {
      type: 'meta';
      lang: 'zh' | 'en' | 'other' | 'unknown';
      chars: number;
      fetched: boolean;
      /** true = 命中"这个站点读不了"的名单，压根没抓 */
      skipped: boolean;
      /** aihot-zh = 读的是 AIHOT 译好的中文版；original = 抓的原稿 */
      source: 'aihot-zh' | 'original';
      /** 正文的取回地址。读译文时是 AIHOT 的地址，不是原文地址 */
      bodyUrl: string;
    }
  | { type: 'note'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; reply: string }
  | { type: 'error'; message: string };

/** AI 读一次抓取的元信息。前端的语言标注、字数都来自它 */
export type NewsReadMeta = Extract<NewsReadEvent, { type: 'meta' }>;

/** 一条落库的对话记录（对话历史单独读写，不进首屏 bootstrap） */
export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  engine?: 'rule' | 'llm' | 'local' | null;
  warning?: string | null;
  createdAt: string;
};

/* ── 请求封装 ──────────────────────────────────────────────────────── */
const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  const text = await res.text();
  // 504 一般不是后端发的，而是反代先掐了连接（nginx 的 proxy_read_timeout 默认 60 秒）。
  // 不特判的话会被下面的 JSON 解析兜住，只剩一句"非 JSON 内容"，看不出该改哪里。
  if (res.status === 504) {
    throw new Error('上游响应超时：若通过 nginx 反代访问，请把 proxy_read_timeout 调到大于 AI_TIMEOUT_MS');
  }
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`接口返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (!res.ok || payload?.ok === false) {
    /* 401 一律当成"会话没了"广播一次，由 AuthProvider 接住并弹回登录页。
       集中在这里处理，省得每个调用点各写一遍判断 —— 漏一处就是
       "页面看着还在、其实什么数据都点不动"。
       登录接口自己的 401 是"密码错误"，不算会话过期。 */
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('auth:expired'));
    }
    throw new Error(payload?.error || `请求失败（HTTP ${res.status}）`);
  }
  return payload.data as T;
}

/**
 * 书签图标的地址。列表里只给 hasIcon，本体走这个接口取。
 *
 * `v` 是服务端按图标内容算出来的短版本号：图标一换它就变，于是这个 URL
 * 可以放心地长缓存（nginx 那边对这个路径专门开了 immutable）——
 * 刷新时图标直接从浏览器缓存里出来，不再有"先画色块再等图标"那一下。
 * 不带 v（比如编辑弹窗里的即时预览）就退回可协商缓存。
 */
export const bookmarkIconUrl = (id: string, v?: string) =>
  `${BASE}/bookmarks/${encodeURIComponent(id)}/icon${v ? `?v=${encodeURIComponent(v)}` : ''}`;

const send = (method: string, body?: unknown) => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

/**
 * 流式 POST：逐帧回调 SSE 事件，Promise 在流结束时 resolve。
 * 不能用 EventSource —— 它只支持 GET，带不了请求体。
 *
 * 工作台助手（/assistant/stream）和文章助手（/knowledge/ai）共用这一份：
 * 这里的坑（504 要单独说、心跳帧没有 data: 要跳过、坏帧不能打断整段）
 * 复制两份迟早会分叉。
 */
async function streamSse<T>(
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  // 拿不到流时，后端（或反代）发的是普通文本，按非流式的口径报错
  if (!res.ok || !res.body) {
    if (res.status === 504) {
      throw new Error('上游响应超时：若通过 nginx 反代访问，请把 proxy_read_timeout 调到大于 AI_STREAM_TIMEOUT_MS');
    }
    const text = await res.text().catch(() => '');
    throw new Error(text || `请求失败（HTTP ${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 用空行分隔事件；`:` 开头的心跳是注释行，整帧没有 data: 就会落到下面的 continue
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as T);
      } catch {
        // 坏帧丢掉：一帧解析失败不该打断整段回答
      }
    }
  }
}

const assistantStream = (message: string, onEvent: (event: AssistantStreamEvent) => void, signal?: AbortSignal) =>
  streamSse<AssistantStreamEvent>('/assistant/stream', { message }, onEvent, signal);

/* ── 接口 ──────────────────────────────────────────────────────────── */
export const api = {
  /* 登录：账号在服务端的 .env 里（AUTH_USER / AUTH_PASSWORD）。
     enabled=false 表示服务端没开登录，页面直接放行。 */
  auth: {
    me: () =>
      req<{ enabled: boolean; user: string | null; loginBackground: LoginBackground }>('/auth/me'),
    login: (username: string, password: string) =>
      req<{ user: string }>('/auth/login', send('POST', { username, password })),
    logout: () => req<{ ok: boolean }>('/auth/logout', send('POST', {})),
    /** 改密码。服务端会在同一个响应里换发新会话 cookie（旧会话全部失效） */
    changePassword: (current: string, next: string) =>
      req<{ user: string }>('/auth/password', send('POST', { current, next })),
  },

  /* 登录页背景：GET 不需要登录（登录页自己要用），上传与删除需要 */
  loginBackground: {
    upload: (dataUrl: string) =>
      req<{ hasUpload: boolean; uploadedAt: number; size: number; ext: string }>(
        '/login-background',
        send('POST', { data: dataUrl }),
      ),
    remove: () => req<{ hasUpload: boolean }>('/login-background', send('DELETE')),
  },
  health: () =>
    req<{
      status: string;
      uptime: number;
      db: { label?: string; reachable?: boolean };
      pveConfigured: boolean;
      haConfigured: boolean;
      sampler?: SamplerStatus;
      assistantEngine: string;
    }>('/health'),
  /** 前端产物版本：页面靠它判断自己是不是旧的（dev 模式下为 null） */
  version: () => req<{ version: string | null }>('/version'),
  bootstrap: () => req<Bootstrap>('/bootstrap'),

  /* 背景图：上传走 data URL，避免为一张壁纸引入 multipart 依赖 */
  background: {
    upload: (dataUrl: string) =>
      req<{ hasUpload: boolean; uploadedAt: number; size: number; ext: string }>(
        '/background',
        send('POST', { data: dataUrl }),
      ),
    remove: () => req<{ hasUpload: boolean }>('/background', send('DELETE')),
  },

  todos: {
    list: () => req<Todo[]>('/todos'),
    create: (body: { text: string; priority?: Priority; due?: string }) => req<Todo>('/todos', send('POST', body)),
    update: (id: string, patch: Partial<Todo>) => req<Todo>(`/todos/${id}`, send('PATCH', patch)),
    remove: (id: string) => req<{ removed: number }>(`/todos/${id}`, send('DELETE')),
    clearDone: () => req<{ removed: number }>('/todos/clear-done', send('POST')),
  },

  tickets: {
    list: () => req<Ticket[]>('/tickets'),
    create: (body: Partial<Ticket> & { title: string }) => req<Ticket>('/tickets', send('POST', body)),
    update: (id: string, patch: Partial<Ticket>) => req<Ticket>(`/tickets/${id}`, send('PATCH', patch)),
    /** 批量改：多条任务共用一份 patch，一次往返搞定 */
    updateMany: (ids: string[], patch: Partial<Ticket>) =>
      req<{ updated: number; tickets: Ticket[] }>('/tickets/batch', send('PATCH', { ids, patch })),
    archive: (id: string, archived = true) => req<Ticket>(`/tickets/${id}/archive`, send('POST', { archived })),
    /** 移入回收站（软删除，可恢复） */
    trash: (id: string) => req<Ticket>(`/tickets/${id}/trash`, send('POST', {})),
    /** 从归档或回收站恢复 */
    restore: (id: string) => req<Ticket>(`/tickets/${id}/restore`, send('POST', {})),
    /** 彻底删除，只在回收站里用 */
    remove: (id: string) => req<{ removed: number; removedComments: number }>(`/tickets/${id}`, send('DELETE')),
    /** 批量彻底删除。服务端只接受回收站里的 id，进行中的任务传过去也会被挡下 */
    removeMany: (ids: string[]) =>
      req<{ removed: number; removedComments: number; removedAttachments: number }>(
        '/tickets/batch-delete',
        send('POST', { ids }),
      ),
    comments: {
      list: (id: string) => req<{ comments: TicketComment[] }>(`/tickets/${id}/comments`),
      add: (id: string, content: string) => req<TicketComment>(`/tickets/${id}/comments`, send('POST', { content })),
      remove: (commentId: string) => req<{ removed: number }>(`/tickets/comments/${commentId}`, send('DELETE')),
    },
    attachments: {
      list: (id: string) => req<{ attachments: TicketAttachment[] }>(`/tickets/${id}/attachments`),
      add: (id: string, body: { name: string; mime: string; size: number; content: string; inline?: boolean }) =>
        req<TicketAttachment>(`/tickets/${id}/attachments`, send('POST', body)),
      remove: (attachmentId: string) =>
        req<{ removed: number }>(`/tickets/attachments/${attachmentId}`, send('DELETE')),
    },
  },

  projects: {
    list: () => req<{ projects: Project[] }>('/projects'),
    create: (body: { name: string; note?: string }) => req<Project>('/projects', send('POST', body)),
    /** 改名会连带刷新该项目的任务，返回值里带了是否发生了改名 */
    update: (id: string, patch: Partial<Pick<Project, 'name' | 'note'>>) =>
      req<{ project: Project; renamedTasks: boolean }>(`/projects/${id}`, send('PATCH', patch)),
    /** 删项目不删任务：任务保留、归属清空 */
    remove: (id: string) => req<{ removed: number; clearedTasks: number }>(`/projects/${id}`, send('DELETE')),
    /** 项目下的分类 */
    sections: (id: string) => req<{ sections: ProjectSection[] }>(`/projects/${id}/sections`),
    addSection: (id: string, name: string) => req<ProjectSection>(`/projects/${id}/sections`, send('POST', { name })),
  },

  sections: {
    /** 改名会连带刷新该段下的任务，返回值里带了是否发生了改名 */
    rename: (id: string, name: string) =>
      req<{ section: ProjectSection; renamedTasks: boolean }>(`/sections/${id}`, send('PATCH', { name })),
    /** 删分类不删任务：段里的任务保留、只是失去归属 */
    remove: (id: string) => req<{ removed: number; clearedTasks: number }>(`/sections/${id}`, send('DELETE')),
  },

  bookmarks: {
    list: () => req<{ bookmarks: Bookmark[]; groups: Group[] }>('/bookmarks'),
    create: (body: Partial<Bookmark> & { name: string; url: string }) => req<Bookmark>('/bookmarks', send('POST', body)),
    update: (id: string, patch: Partial<Bookmark>) => req<Bookmark>(`/bookmarks/${id}`, send('PATCH', patch)),
    remove: (id: string) => req<{ removed: number }>(`/bookmarks/${id}`, send('DELETE')),
    /**
     * 探测各站点自己的品牌色（theme-color → favicon 主色）并写回书签的 color。
     * 默认只补还没有颜色的，`force` 才会连已有的一起重探 —— 一次刷新真的会
     * 去访问那十几个站点，不该在每次打开页面时都跑。
     */
    refreshColors: (body: { force?: boolean; ids?: string[] } = {}) =>
      req<{
        total: number;
        updated: number;
        colors: { id: string; name: string; color: string; source: 'theme-color' | 'icon' }[];
        failed: { id: string; name: string; error: string }[];
      }>('/bookmarks/refresh-colors', send('POST', body)),
    /**
     * 重排磁贴顺序：传整份 id 顺序（工具箱那面墙的顺序），服务端按下标写回。
     * `moved` 只在跨分类拖动时才带 —— 被拖到别的分类邻居之间的那张，
     * 顺带把分类一起改掉，两件事在服务端是同一次写入。
     */
    reorder: (ids: string[], moved: { id: string; group: string }[] = []) =>
      req<{ bookmarks: Bookmark[] }>('/bookmarks/reorder', send('POST', { ids, moved })),
    /**
     * 抓取并固化单个书签的站点图标，返回更新后的书签。
     * 新增工具之后顺手调一次；站点取不到图标时也返回 200（原样返回），
     * 页面退回首字色块，不把它当错误。
     */
    fetchIcon: (id: string) => req<Bookmark>(`/bookmarks/${id}/icon/fetch`, send('POST', {})),
    /**
     * 批量固化站点图标。默认只补还没有图标的，`force` 才会连已有的一起重抓。
     * 抓一遍要逐个访问站点，属于"做一次就够"的动作（结果落库）。
     */
    refreshIcons: (body: { force?: boolean; ids?: string[] } = {}) =>
      req<{
        total: number;
        updated: number;
        icons: { id: string; name: string }[];
        failed: { id: string; name: string; error: string }[];
      }>('/bookmarks/refresh-icons', send('POST', body)),
    createGroup: (name: string) => req<Group>('/groups', send('POST', { name })),
    /** 改分类名。书签按 id 关联分组，所以改名不会动到任何书签 */
    renameGroup: (id: string, name: string) => req<Group>(`/groups/${id}`, send('PATCH', { name })),
    /** 重排分类顺序：传拖动（或按名称排序）之后的完整 id 顺序，服务端按下标写回 */
    reorderGroups: (ids: string[]) => req<{ groups: Group[] }>('/groups/reorder', send('POST', { ids })),
  },

  knowledge: {
    /**
     * 列表：**元信息 + 摘要，不带正文**。首屏（/bootstrap）也是这一份。
     * 正文按需取 —— 见下面的 get / listFull。
     */
    list: () => req<KnowledgeItem[]>('/knowledge'),
    /** 全量（含正文）。只有图谱用：它要把所有正文扫一遍找 [[双链]] */
    listFull: () => req<KnowledgeItem[]>('/knowledge?full=1'),
    /**
     * 服务端搜索。必须走服务端：打在 body_plain 上，而正文已经不下发了。
     * 命中在正文里时，结果里会带一段上下文（snippet）。
     */
    search: (q: string) => req<KnowledgeItem[]>(`/knowledge?q=${encodeURIComponent(q)}`),
    /** 单篇（含正文）：阅读页与编辑器按需取 */
    get: (id: string) => req<KnowledgeItem>(`/knowledge/${id}`),
    create: (body: Partial<KnowledgeItem> & { title: string }) => req<KnowledgeItem>('/knowledge', send('POST', body)),
    update: (id: string, patch: Partial<KnowledgeItem>) => req<KnowledgeItem>(`/knowledge/${id}`, send('PATCH', patch)),
    /** 移入回收站（软删除，可恢复） */
    trash: (id: string) => req<KnowledgeItem>(`/knowledge/${id}/trash`, send('POST', {})),
    /** 从回收站恢复。恢复不动 updatedAt，所以排回原位 */
    restore: (id: string) => req<KnowledgeItem>(`/knowledge/${id}/restore`, send('POST', {})),
    /**
     * 彻底删除。**只在回收站里用** —— 服务端会拒掉还没进回收站的 id，
     * 避免"删除"被一次误调用变成不可恢复的丢数据。
     */
    remove: (id: string) => req<{ removed: number }>(`/knowledge/${id}`, send('DELETE')),
    /** 批量移入回收站。服务端逐条判重，已经在回收站里的会被跳过 */
    trashMany: (ids: string[]) => req<{ trashed: number }>('/knowledge/batch-trash', send('POST', { ids })),
    /** 批量彻底删除。同样只接受回收站里的 id */
    removeMany: (ids: string[]) => req<{ removed: number }>('/knowledge/batch-delete', send('POST', { ids })),
    /**
     * 标签批量改名 / 合并 / 删除（服务端直接改所有条目）。
     * 改名到已存在的名字就是合并。返回改完之后的整份列表，省一次往返。
     */
    retag: (body: { renames?: { from: string; to: string }[]; removes?: string[] }) =>
      req<{ list: KnowledgeItem[]; changed: number }>('/knowledge/tags', send('POST', body)),
    /** 抓一个外链文章转成 Markdown。只返回结果、不写库 —— 由编辑器预览后再保存 */
    importUrl: (url: string) => req<ImportedArticle>('/knowledge/import', send('POST', { url })),
    /**
     * 文章助手（SSE）。正文由**前端传出去**，不从库里读 ——
     * 编辑器里刚写、还没保存的那段也应该能拿来问。
     *
     * history 是**这次提问之前**的轮次（不含本轮），服务端只取最近几条，
     * 用它来让「那第 3 条具体怎么做」这类追问有指代对象。
     */
    askAi: (
      body: {
        task?: 'summary' | 'analysis' | 'explain';
        question?: string;
        article: { title: string; tags: string[]; summary: string; body: string };
        history?: { role: 'user' | 'ai'; text: string }[];
      },
      onEvent: (event: ArticleAiEvent) => void,
      signal?: AbortSignal,
    ) => streamSse<ArticleAiEvent>('/knowledge/ai', body, onEvent, signal),
  },

  news: {
    list: () =>
      req<{
        items: NewsItem[];
        updatedAt: string | null;
        lastError: string | null;
        /** 最近一次抓取被分数门槛挡掉多少条。0 表示门槛没起作用 */
        dropped: number;
        hot: NewsHot | null;
        daily: NewsDaily | null;
      }>('/news'),
    refresh: () => req<{ ok: boolean; count: number; errors: string[]; updatedAt: string | null }>('/news/refresh', send('POST')),
    /**
     * AI 读一篇热点文章（SSE）。
     *
     * `zhUrl` 是这一条在 AIHOT 上的页面 —— 里面有**已经译好的中文全文**。
     * 服务端会优先读它，读不到才退回去抓 `url`（原稿）。所以两个都可能传：
     * 老条目没有 aihotUrl 时只传 url，行为与从前一致。
     */
    read: (
      body: {
        url: string;
        /** AIHOT 条目页（含中文译文）。没有就留空，服务端会直接抓原文 */
        zhUrl?: string | null;
        item: { title: string; source: string; summary: string; reason?: string | null; publishedAt?: string };
        task?: 'read' | 'analysis' | 'translate';
        question?: string;
        history?: { role: 'user' | 'ai'; text: string }[];
        /** true = 无视"这个站点读不了"的名单，硬抓一次 */
        force?: boolean;
      },
      onEvent: (event: NewsReadEvent) => void,
      signal?: AbortSignal,
    ) => streamSse<NewsReadEvent>('/news/read', body, onEvent, signal),
    /**
     * 取刚才为 AI 读抓下来的那份**正文**。**服务端只读缓存、不重新抓取**，
     * 所以没读过、或缓存已淘汰时是 404 —— 调用方据此退回"去原站看"。
     *
     * 传的地址要用 meta 给的 `bodyUrl`：读译文时缓存键是 AIHOT 的地址，
     * 不是原文地址。
     */
    body: (url: string) =>
      req<{ markdown: string; at: string }>(`/news/read/body?url=${encodeURIComponent(url)}`),
    /** 当前判为读不了的站点。列表页提前标出来，省掉一次注定失败的白等 */
    unreadable: () => req<{ hosts: { host: string; error: string; at: string }[] }>('/news/read/unreadable'),
  },

  ai: {
    /** 全站 token 用量。顶栏那个统计用 —— 服务端只读内存，很便宜 */
    usage: () => req<AiUsage>('/ai/usage'),
  },

  settings: {
    get: () => req<Settings>('/settings'),
    save: (patch: DeepPartial<Settings>) => req<Settings>('/settings', send('PUT', patch)),
  },

  /**
   * Hermes 智能工位（局域网那台 Agent Office 网关）。
   * 只有工位状态是免登录的。
   */
  hermes: {
    seats: () => req<HermesSeats>('/hermes/seats'),
  },

  /**
   * 智能工位里"登录墙后面"的那部分。
   *
   * 浏览器不直接连那台网关（跨域 + 混合内容 + 不该把会话交给前端），
   * 全部经服务端自己的会话代理，所以没配口令时这些接口是 503 而不是超时。
   */
  office: {
    /** 员工档案 + 工位在线状态（立绘也在登录墙后面，没口令时图片取不到） */
    roster: () => req<OfficeRoster>('/office/roster'),
    /** 全局待办工作表：会话统计 + 定时任务 + 最近执行 + 异常 */
    board: () => req<OfficeBoard>('/office/board'),
    /** 今日与近 7 日 token 用量 */
    usage: () => req<OfficeUsage>('/office/usage'),
    /** 对话回溯列表 */
    sessions: (limit = 20, offset = 0) =>
      req<{ data: OfficeSession[]; has_more: boolean }>(`/office/sessions?limit=${limit}&offset=${offset}`),
    /** 某次对话的逐条明细 */
    messages: (id: string, limit = 30) =>
      req<{ data: OfficeMessage[]; session_id: string }>(
        `/office/sessions/${encodeURIComponent(id)}/messages?limit=${limit}`,
      ),
    /** 对话用那条会话的历史（就是控制台自己的网页端会话，两边看到的是同一份） */
    chatHistory: (limit = 30) =>
      req<{ data: OfficeMessage[]; session_id: string }>(`/office/chat/history?limit=${limit}`),
    /** 发一条消息（SSE）。seat 决定"这条是问谁" */
    chat: (seat: string, message: string, onEvent: (event: OfficeChatEvent) => void, signal?: AbortSignal) =>
      streamSse<OfficeChatEvent>('/office/chat', { seat, message }, onEvent, signal),

    /* ── 工位详情 ── */
    /** 档案 + 抬头标签 + 该岗位的页签集合 */
    seat: (id: string) => req<OfficeSeatDetail>(`/office/seat/${encodeURIComponent(id)}`),
    /** 某个页签的内容（服务端已归一化，前端按 kind 画） */
    seatTab: (id: string, tab: OfficeSeatTabKey) =>
      req<OfficeSeatTab>(`/office/seat/${encodeURIComponent(id)}/tab/${tab}`),
    /** 拾贝：历史抓取记录 */
    harvestHistory: (limit = 200) =>
      req<{ items: OfficeHarvestItem[]; total: number; file: string }>(`/office/harvest/history?limit=${limit}`),
    /**
     * 拾贝：下一条抓取指令。**这会真的去抓网页**（模型解析 → 本机采集器执行），
     * 所以是 POST，且只有「即时交互」页签里那个发送按钮会调它。
     */
    harvest: (text: string) => req<OfficeHarvestRun>('/office/harvest', send('POST', { text })),
  },

  search: {
    /**
     * 外部搜索建议（首页大搜索框的联想词）。由服务端代取 ——
     * 这几家都不给 CORS 头，浏览器直连读不到响应。
     *
     * `supported: false` 表示当前引擎在服务端的映射表里认不出来
     * （自建搜索引擎、GitHub 这类），页面就不必再问了；
     * `enabled: false` 表示用户在设置里把联想关了，服务端也不会去取。
     */
    suggest: (engine: string, q: string) =>
      req<{ items: string[]; source: string | null; label?: string; supported: boolean; enabled: boolean }>(
        `/search/suggest?engine=${encodeURIComponent(engine)}&q=${encodeURIComponent(q)}`,
      ),
  },

  backup: {
    exportUrl: '/api/backup',
    restore: (payload: unknown) => req<{ restored: boolean }>('/backup/restore', send('POST', payload)),
    reset: () => req<{ reset: boolean }>('/backup/reset', send('POST')),
    save: () => req<{ savedAt: string }>('/backup/save', send('POST')),
    /**
     * 立即备份一次到 COS。走的是和定时任务**同一条**路
     * （services/backup.js 的 runBackup），所以不会出现"手动能成、定时不成"。
     * 失败原因由服务端原样带回（缺凭证 / 桶名错 / 签名没过，处置完全不同）。
     */
    cosRun: () =>
      req<{
        lastRunAt: string;
        lastKey: string;
        lastBytes: number;
        lastDocs: number;
        lastTrigger: string;
        rawBytes: number;
      }>('/backup/cos/run', send('POST')),
    /** 连通性自检：会往桶里写一个几十字节的探针对象（备份要的就是写权限） */
    cosTest: () => req<{ key: string; bytes: number; bucket: string; region: string }>('/backup/cos/test', send('POST')),
    /**
     * 云上有哪些备份。
     *
     * mode 说明这份清单是怎么来的：`list` 是列桶（看得见桶里全部对象），
     * `probe` 是服务端按日期探测出来的（密钥没有 ListBucket 权限时的退路），
     * 后者只看得到最近 days 天、且只认按日期命名的那些。
     */
    cosList: () =>
      req<{
        mode: 'list' | 'probe';
        days: number;
        items: { key: string; size: number; lastModified: string }[];
      }>('/backup/cos/list'),
    /**
     * 从云上的一份备份恢复。**只覆盖知识库与工具箱**，任务、设置等一律不动。
     *
     * 服务端在覆盖前会先自动把当前的知识库与工具箱另存一份（safetyKey），
     * 这一步是尽力而为：没存上去时 safetyError 里有原因，页面要如实说出来 ——
     * "以为有后悔药、实际没有"比"明确知道没有"危险得多。
     */
    cosRestore: (key: string) =>
      req<{
        restored: boolean;
        key: string;
        /** 快照自己的范围标记；空串表示是早期的整份快照（只取其中两块） */
        scope: string;
        safetyKey: string;
        safetyError: string;
        before: BackupCounts;
        after: BackupCounts;
      }>('/backup/cos/restore', send('POST', { key })),
  },

  pve: {
    nodes: () => req<{ nodes: any[]; configured: boolean }>('/pve/nodes'),
    overview: (params: { node?: string; timeframe?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.node) qs.set('node', params.node);
      if (params.timeframe) qs.set('timeframe', params.timeframe);
      const q = qs.toString();
      return req<Overview>(`/pve/overview${q ? `?${q}` : ''}`);
    },
    setEco: (enabled: boolean) =>
      req<{
        enabled: boolean;
        link: {
          webhook: string;
          command: string;
          errors: string[];
          /** CPU 调频下发结果：ok=false 时看 error / skipped，界面要把它显示出来 */
          governor:
            | { ok: true; host: string; from: string | null; to: string; changed: boolean }
            | { ok: false; skipped?: boolean; error: string; host?: string; target?: string }
            | null;
        };
      }>('/pve/eco', send('POST', { enabled })),
    testConfig: (body: Partial<Settings['pve']>) => req<{ nodes: any[]; count: number }>('/pve/config/test', send('POST', body)),
  },

  /* Home Assistant：米家智能插座实测功耗与用电 */
  ha: {
    /** 从 HA 拉可选的功率 / 电量实体，供设置页做下拉选择 */
    options: () => req<HaOptions>('/ha/options'),
    test: (body: Partial<HaSettings> = {}) =>
      req<{
        ok: boolean;
        watts: number | null;
        sockets: { id: string; name: string; watts: number | null; ok: boolean; error: string | null }[];
        counterKwh: number | null;
        lastUpdated: string | null;
        error: string | null;
        config: { url: string; sockets: HaSocket[] };
      }>('/ha/test', send('POST', body)),
    /** 手动采一次样：读功率 → 积分进当日电量 → 落库 */
    sample: () =>
      req<{ ok: boolean; watts: number | null; counterKwh: number | null; sampler: SamplerStatus }>(
        '/ha/sample',
        send('POST', {}),
      ),
  },

  assistant: {
    ask: (message: string) => req<AssistantReply>('/assistant', send('POST', { message })),
    askStream: assistantStream,
    /** 对话历史：独立读写，不走 bootstrap / refreshAll —— 每发一条消息都刷全局太重 */
    messages: {
      list: (limit = 100) => req<{ messages: AssistantMessage[] }>(`/assistant/messages?limit=${limit}`),
      save: (body: { role: 'user' | 'assistant'; content: string; engine?: string; warning?: string }) =>
        req<AssistantMessage>('/assistant/messages', send('POST', body)),
      clear: () => req<{ removed: number }>('/assistant/messages', send('DELETE')),
    },
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
