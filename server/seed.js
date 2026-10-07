/**
 * 初始数据。首次启动时写入 server/data/db.json，
 * 之后所有修改都落在该文件里，可直接备份 / 恢复。
 */

const today = () => new Date().toISOString().slice(0, 10);

function iso(dayOffset = 0, hour = 9, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

export function defaultData() {
  return {
    version: 1,
    todos: [
      { id: 'td_seed01', text: '检查 PVE-01 ZFS 池 scrub 结果', done: false, priority: 'P1', due: today(), createdAt: iso(0, 8, 30) },
      { id: 'td_seed02', text: '续签 *.lab.internal 泛域名证书', done: false, priority: 'P0', due: today(), createdAt: iso(0, 8, 40) },
      { id: 'td_seed03', text: '整理上周 Ceph OSD 抖动复盘笔记', done: false, priority: 'P2', due: today(), createdAt: iso(0, 9, 10) },
      { id: 'td_seed04', text: '给 NAS 备份任务加失败告警到企业微信', done: true, priority: 'P2', due: today(), createdAt: iso(0, 9, 20) },
      { id: 'td_seed05', text: '下单 2 条 Cat6a 跳线', done: false, priority: 'P3', due: '', createdAt: iso(0, 9, 30) },
    ],

    tickets: [
      { id: 'WO-1042', title: 'web-02 容器频繁 OOMKilled', priority: 'P0', status: 'doing', project: '业务系统', owner: '我', due: iso(1, 18, 0), note: '疑似 Java 堆未设上限，先加 memory limit', createdAt: iso(-1, 10, 0) },
      { id: 'WO-1043', title: 'PVE-01 风扇转速偏高，排查进风温度', priority: 'P1', status: 'doing', project: '基础设施', owner: '我', due: iso(2, 18, 0), note: '机柜进风 27℃，先清滤网', createdAt: iso(-1, 11, 0) },
      { id: 'WO-1044', title: '升级 Proxmox VE 到 9.0-2', priority: 'P1', status: 'todo', project: '基础设施', owner: '我', due: iso(3, 18, 0), note: '先做快照 + 备份 /etc/pve', createdAt: iso(0, 9, 0) },
      { id: 'WO-1045', title: '知识库补充「ZFS 池扩容」Runbook', priority: 'P2', status: 'todo', project: '文档', owner: '我', due: iso(4, 18, 0), note: '', createdAt: iso(0, 9, 15) },
      { id: 'WO-1046', title: '统一内网 DNS，下线旧 dnsmasq', priority: 'P2', status: 'review', project: '基础设施', owner: '我', due: iso(0, 18, 0), note: '已切 80% 客户端，观察 48h', createdAt: iso(-3, 14, 0) },
      { id: 'WO-1039', title: '修复 Grafana 面板数据源超时', priority: 'P1', status: 'done', project: '监控', owner: '我', due: iso(-2, 18, 0), note: 'Prometheus 加了 30s timeout', createdAt: iso(-4, 9, 0) },
      { id: 'WO-1040', title: '回收 3 台闲置 VM 的 IP 与存储', priority: 'P3', status: 'done', project: '基础设施', owner: '我', due: iso(-1, 18, 0), note: '', createdAt: iso(-4, 15, 0) },
      { id: 'WO-1041', title: '整理机柜走线并打标签', priority: 'P3', status: 'done', project: '现场', owner: '我', due: iso(-1, 20, 0), note: '', createdAt: iso(-5, 16, 0) },
    ],

    groups: [
      { id: 'grp_ops', name: '运维面板', order: 0 },
      { id: 'grp_dev', name: '开发与代码', order: 1 },
      { id: 'grp_docs', name: '文档与知识', order: 2 },
      { id: 'grp_ai', name: 'AI 与工具', order: 3 },
    ],

    /* 内置书签只是示例，地址一律用 .home.local 占位主机：
       仓库是公开的，写真实内网 IP 等于把「什么服务跑在哪台机器」整张图发出去。
       自己的地址在设置页或数据库里改，不受这里影响。 */
    bookmarks: [
      { id: 'bm_01', name: 'Proxmox VE', url: 'https://pve.home.local:8006', group: 'grp_ops', note: 'PVE 集群入口', color: '#E57000' },
      { id: 'bm_02', name: 'Grafana', url: 'http://grafana.home.local:3000', group: 'grp_ops', note: '监控大盘', color: '#F46800' },
      { id: 'bm_03', name: 'Prometheus', url: 'http://prometheus.home.local:9090', group: 'grp_ops', note: '指标与告警规则', color: '#E6522C' },
      { id: 'bm_04', name: 'Uptime Kuma', url: 'http://uptime.home.local:3001', group: 'grp_ops', note: '可用性探测', color: '#5CDD8B' },
      { id: 'bm_05', name: 'AdGuard Home', url: 'http://adguard.home.local:3000', group: 'grp_ops', note: '内网 DNS', color: '#66B574' },
      { id: 'bm_06', name: 'GitHub', url: 'https://github.com', group: 'grp_dev', note: '代码与 Actions', color: '#8B949E' },
      { id: 'bm_07', name: 'GitLab', url: 'http://gitlab.home.local', group: 'grp_dev', note: '内网私有仓库', color: '#FC6D26' },
      { id: 'bm_08', name: 'Portainer', url: 'https://portainer.home.local:9443', group: 'grp_dev', note: '容器管理', color: '#13BEF9' },
      { id: 'bm_09', name: 'Jenkins', url: 'http://jenkins.home.local:8080', group: 'grp_dev', note: 'CI 流水线', color: '#D33833' },
      { id: 'bm_10', name: 'Nginx Proxy Mgr', url: 'http://npm.home.local:81', group: 'grp_dev', note: '反代与证书', color: '#2691D9' },
      { id: 'bm_11', name: '腾讯文档', url: 'https://docs.qq.com', group: 'grp_docs', note: '协同文档', color: '#2B7FF5' },
      { id: 'bm_12', name: '飞书', url: 'https://feishu.cn', group: 'grp_docs', note: 'IM 与知识库', color: '#3370FF' },
      { id: 'bm_13', name: 'Notion', url: 'https://notion.so', group: 'grp_docs', note: '个人笔记', color: '#9AA0A6' },
      { id: 'bm_14', name: 'PVE Wiki', url: 'https://pve.proxmox.com/wiki', group: 'grp_docs', note: '官方文档', color: '#E57000' },
      { id: 'bm_15', name: 'ChatGPT', url: 'https://chat.openai.com', group: 'grp_ai', note: '', color: '#10A37F' },
      { id: 'bm_16', name: 'Claude', url: 'https://claude.ai', group: 'grp_ai', note: '', color: '#D97757' },
      { id: 'bm_17', name: 'Hugging Face', url: 'https://huggingface.co', group: 'grp_ai', note: '模型与数据集', color: '#FFD21E' },
      { id: 'bm_18', name: 'skills.sh', url: 'https://skills.sh', group: 'grp_ai', note: 'Agent 技能市场', color: '#58C7E0' },
    ],

    knowledge: [
      {
        id: 'kb_01',
        type: 'runbook',
        title: 'PVE 节点无响应 / 失联',
        tags: ['PVE', '应急', '网络'],
        summary: '节点 Web UI 打不开、SSH 不通时的分级处置流程。',
        steps: [
          '确认范围：只有 UI 打不开，还是 SSH / ping 全不通。仅 UI 异常通常是 pveproxy 卡死。',
          'ping 节点管理 IP，再从另一台机器 `nc -vz <ip> 8006` 验证端口。',
          'SSH 可达时：`systemctl restart pveproxy`，仍异常则 `journalctl -u pveproxy -n 200`。',
          'SSH 不可达但能 ping：物理进入 IPMI/iKVM，检查 `dmesg -T | tail`（常见 ZFS 或网卡 hang）。',
          'SSH 与 ping 都不通：通过 IPMI 执行 `ipmitool power cycle`，并在 PVE UI 确认 VM 自启。',
          '恢复后核对 `pvecm status`（若为集群）与 `zpool status`，确认没有掉盘。',
        ],
        updatedAt: iso(-6, 10, 0),
      },
      {
        id: 'kb_02',
        type: 'runbook',
        title: 'ZFS 池容量告警（>85%）',
        tags: ['ZFS', '存储', '告警'],
        summary: '池使用率过高会显著掉速，按顺序清理与扩容。',
        steps: [
          '查看占用：`zfs list -o space -r <pool>` 定位到 dataset。',
          '找出快照占用：`zfs list -t snapshot -o name,used -s used | tail -20`。',
          '先删过期快照（用 `zfs destroy <snap>` 或快照策略工具），不要直接删 dataset。',
          '检查是否有 VM 磁盘膨胀：`zfs get -H volsize <pool>/vm-*`。',
          '清理后执行 `zpool trim <pool>` 回收 SSD 空间，观察 `zpool status`。',
          '若确实不足，加盘扩容：`zpool add <pool> <dev>`（raidz 只可加同拓扑 vdev）。',
          '完成后更新监控阈值并记录到变更日志。',
        ],
        updatedAt: iso(-9, 15, 30),
      },
      {
        id: 'kb_03',
        type: 'runbook',
        title: 'VM 备份任务失败排查',
        tags: ['PVE', '备份', 'PBS'],
        summary: 'vzdump 突然失败时的通用排查路径。',
        steps: [
          '看任务日志：PVE UI → 节点 → 任务历史，筛 `vzdump`。',
          '备份存储是否写满：`pvesm status`，清理旧备份或调 retention。',
          '报 `got timeout` 多为备份目标 IO 打满，错峰或加 `--bwlimit`。',
          '报 `VM is locked` 时确认没有残留在跑的任务，必要时 `qm unlock <vmid>`。',
          '快照式备份失败可先试 `--mode snapshot`，LVM 场景用 `--mode suspend`。',
          '修好后手动跑一次验证，并把结论补进对应任务。',
        ],
        updatedAt: iso(-12, 11, 0),
      },
      {
        id: 'kb_04',
        type: 'sop',
        title: '变更操作标准流程',
        tags: ['流程', '变更'],
        summary: '任何影响线上/在跑服务的操作都必须走这个流程。',
        steps: [
          '在「任务」里新建，写清影响面、回滚点、预计耗时。',
          '变更前必须：快照 + 配置备份（`tar czf /root/pve-etc-$(date +%F).tgz /etc/pve`）。',
          '判断窗口：影响在跑业务的变更放到 22:00 后，或提前通知使用者。',
          '执行时逐步验证，不跳步、不合并多个变更。',
          '变更后 30 分钟内观察关键指标（功耗、温度、IO 延迟、错误日志）。',
          '在任务备注写结果 + 是否有遗留，再置为「待验证」。',
        ],
        updatedAt: iso(-20, 9, 30),
      },
      {
        id: 'kb_05',
        type: 'sop',
        title: 'UPS 断电与来电处置',
        tags: ['供电', '应急', '硬件'],
        summary: '市电中断时的关停顺序与恢复顺序。',
        steps: [
          '市电中断：确认 UPS 负载与剩余续航（NUT / UPS 面板读数）。',
          '预计续航 < 10 分钟时，按序关停：业务 VM → 存储节点 → PVE 节点 → 交换机（最后）。',
          '关停前先 `qm shutdown` / `pct shutdown`，不要 `stop`，避免文件系统损坏。',
          '全部下电后，UPS 保持在位，正常等来电。',
          '来电后先确认电压稳定，再按反序上电：交换机 → 存储 → PVE → 业务 VM。',
          '恢复后核对 `zpool status`、`pvecm status` 与备份任务是否补跑。',
        ],
        updatedAt: iso(-25, 20, 0),
      },
      {
        id: 'kb_06',
        type: 'sop',
        title: '新机上线检查清单',
        tags: ['上架', '硬件', '流程'],
        summary: '新节点接入前逐项确认，避免带病上线。',
        steps: [
          '固件：BIOS / BMC / 网卡固件更新到稳定版本。',
          'RAID / ZFS：按用途选型，SSD 记得留 OP 并开启 discard。',
          'IPMI：配置独立管理 IP、改默认密码、开启日志告警。',
          '网络：双口做 bond，管理口与业务口分离。',
          '温控：设置风扇策略（性能 / 节能）并记录基线转速与温度。',
          '监控：加入 Prometheus 抓取，确认 CPU / 内存 / 温度 / 风扇指标齐全。',
          '最后写入 CMDB，并补充本工作台的监控与纳管信息。',
        ],
        updatedAt: iso(-30, 14, 0),
      },
    ],

    news: {
      updatedAt: null,
      lastError: null,
      /* 最近一次抓取被分数门槛挡掉的条数（见 services/news.js） */
      dropped: 0,
      /* 多源热点榜 + 事件故事线的快照，由 services/news-hot.js 整份替换 */
      hot: null,
      /* 每日日报，由 services/news-daily.js 整份替换 */
      daily: null,
      items: [
        {
          id: 'nw_seed01',
          title: '示例：等待首次抓取，点击「立即刷新」或等待每日 06:00 自动更新',
          link: 'https://skills.sh',
          source: '本地',
          publishedAt: iso(0, 6, 0),
          summary: '在 .env 中配置 RSS 源或保持默认源即可自动拉取；离线环境会保留上一批缓存内容。',
          tags: ['说明'],
        },
      ],
    },

    settings: {
      // 首页问候语里的称呼。留空则只显示「早上好」，不带名字。
      profile: { name: '' },
      /* 首页那个搜索框。engines 是一串搜索引擎，url 里的 %s 是查询词的占位符
         （提交时用 encodeURIComponent 填进去）。在「设置 → 搜索」里增删改，
         所以这里只是初始的四个，不是白名单。 */
      search: {
        engines: [
          { id: 'se_baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
          { id: 'se_google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
          { id: 'se_duck', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
          { id: 'se_github', name: 'GitHub', url: 'https://github.com/search?q=%s' },
        ],
        // 默认选中的引擎 id。留空则用列表里的第一个。
        defaultEngine: 'se_baidu',
        /* 联想：把词发给搜索引擎取它的候选词（设置页可关）。
           只在映射表里认得出的引擎（百度 / Google / Bing / 360）才有，
           其余（DuckDuckGo、GitHub…）只是没有候选词，搜索照常。 */
        suggest: true,
        // 结果在新标签页打开。关掉就是当前页跳走——会离开工作台，默认开着。
        newTab: true,
      },
      // 背景图。none = 用主题自带的 canvas 网格渐变。
      //   url    —— 填一个外链地址
      //   upload —— 上传的图，存在 server/data/background/ 下，经 /api/background 提供
      // overlay 是遮罩浓度：照片千差万别，没有这层主题色的纱，
      // 卡片之间的空隙会直接压掉正文可读性。blur 同理，弱化照片细节免得抢内容。
      background: { kind: 'none', url: '', overlay: 0.45, blur: 0 },
      // 登录页背景：独立于主背景。canvas = 那层柔彩波浪画布（默认）。
      // 上传的图存在 server/data/background/login.<ext>，经 /api/login-background 提供 ——
      // 那个地址在登录守卫的白名单里，否则未登录时取不到自己的背景图。
      loginBackground: { kind: 'canvas', url: '', overlay: 0.2, blur: 0 },
      // 登录口令。passwordHash 为空时认 .env 的 AUTH_PASSWORD（引导口令）；
      // 一旦在设置页改过密码，这里就有加盐 scrypt 哈希，并以它为准。
      auth: { user: '', passwordHash: '', updatedAt: '' },
      theme: { mode: 'light', accent: 'azure' },
      pve: { host: '', port: 8006, tokenId: '', tokenSecret: '', node: '', verifyTls: false },
      // Home Assistant：整机功耗与用电的实测来源（米家插座 → Xiaomi Home 集成）
      ha: {
        // 注意：这里没有 token —— 长期访问令牌只从环境变量 HA_TOKEN 读，不进库
        url: 'http://127.0.0.1:8123',
        verifyTls: false,
        // 插座列表：换插座、加插座都只改这里，统计口径自动跟随
        // （整机功耗 = 各插座功率之和，用电量 = 对求和功率做积分）
        sockets: [
          {
            id: 'socket_1',
            name: 'PVE母机',
            powerEntity: 'sensor.plug_electric_power',
            // 可选：累计电量读数。这块设备该属性是坏的，填了也会被判为不可用
            counterEntity: '',
            enabled: true,
          },
        ],
      },
      power: {
        idleW: 45,
        maxW: 190,
        perDiskW: 6,
        extraW: 28,
        pricePerKwh: 0.62,
        currency: 'CNY',
        eco: false,
        ecoFactor: 0.85,
      },
      news: {
        autoUpdate: true,
        /* 每 2 小时一次，而不是每天 06:00 一次。理由见 services/news.js 顶部：
           接口窗口是 7 天、s-maxage 60 秒，密度上没有任何限制；
           而一天只抓一次的话，06:00 之后发生的事整天都看不到，
           页面上的"今天"到下午还是空的。12 趟/天离限流很远。 */
        cron: '0 */2 * * *',
        /* 只接 AIHOT 公开 API（https://aihot.news）。为什么把整份 RSS 换掉，
           见 services/news.js 顶部那段 —— 简单说：它已经用模型筛过一遍，
           每条带 0–100 分和推荐理由；而 RSS 只能按时间倒序，没有质量排序，
           一屏看下来噪声占大半。 */
        aihot: {
          /* 关掉来源**不会**清空页面，只是不再更新，已抓到的内容照旧留着 */
          enabled: true,
          /* selected = 只要精选（实测分数区间 60–87）；
             all = 全量，再本地按 minScore 切一刀（全量中位分只有 42，噪声多） */
          mode: 'selected',
          /* 入库时的分数门槛 —— 筛选只在这一步发生，界面上不再出现这类控件。
             精选的天然下限就是 60；提到 70 大约只留一半。 */
          minScore: 60,
          /* 每次入库上限，以及最多翻几页（接口单页上限 100） */
          maxItems: 200,
          pages: 2,
        },
      },
      /* 知识库备份到腾讯云 COS。凭证就存在这里（和 PVE 令牌同一套做法：
         机密字段在 GET /settings 里脱敏成掩码，PUT 时把掩码原样回传即表示
         "没改过"）；.env 里的 COS_* 是可选的兜底，两处都没有就是没配。
         last* 那一组由服务端回写，前端只读 —— 页面要能显示
         "上次备份：什么时候、多大、成没成"，光有日志是不够的。 */
      backup: {
        enabled: false,
        /* 每天 03:30。避开 04:20 的留存清理和 06:00 的热点抓取，
           也不撞采样器的整点那一轮。
           注意：这个默认值与 services/backup.js 的 DEFAULT_BACKUP_CRON 是同一个值，
           改一处记得改另一处（那边的常量只在库里的 cron 为空时兜底） */
        cron: '30 3 * * *',
        /* 对象键前缀。留空则直接放在桶根目录。
           只允许 ASCII 字母数字与 - _ / —— 非 ASCII 在"路径要不要先转义"
           这件事上各家实现有歧义（见 services/backup.js 的 signedPath），
           与其赌，不如把前缀限死在这套字符里 */
        prefix: 'workbench-backup',
        cos: { secretId: '', secretKey: '', bucket: '', region: '' },
        lastRunAt: null,
        lastKey: '',
        lastBytes: 0,
        lastDocs: 0,
        lastTrigger: '',
        lastStatus: '',
        lastError: '',
      },
      autoBackup: true,
      refreshSeconds: 60,
      updatedAt: new Date().toISOString(),
    },

    energy: {
      lastTs: null,
      lastWatts: 0,
      daily: {},
      // 插座累计电量计数器的每日快照：{ 'YYYY-MM-DD': { in, out } }
      // 用它推导"今日用电"和滚动窗口用电，避免服务停机漏计
      meterDaily: {},
      // 月度归档：{ 'YYYY-MM': { kwh, cost, ecoKwh, days } }
      // 日明细被清理前先汇总到这里，保留一年
      monthly: {},
      // 运行模式实测对照：{ standard|eco: { idle|light|mid|busy|unknown: { hours, kwh } } }
      // 节能比例由它算出来，不再由 power.ecoFactor 写死
      modeStats: {},
      totalKwh: 0,
      totalCost: 0,
      ecoSavedKwh: 0,
    },

    /* 全站大模型 token 用量（见 services/ai-usage.js）。
       这里只给空壳，累计由每次模型调用自己往上加。
       形状与 emptyUsage() 一致 —— 那个模块 import 了 store，seed 再去 import
       它会绕成一个环，所以这里的字面量是刻意重复的一份。 */
    aiUsage: { total: { prompt: 0, completion: 0, calls: 0 }, days: {}, sources: {} },
  };
}
