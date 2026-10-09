-- 个人工作台 · 表结构
-- 服务启动时会自动执行（全部是 CREATE TABLE IF NOT EXISTS，可重复运行）。
-- 这里只建表，不建库：库与账号由 bootstrap.sql 负责。
-- 约定：
--   · 应用里的驼峰字段在库里用下划线命名；
--   · 时间统一以 UTC 存入 DATETIME(3)，读出时转回 ISO 字符串；
--   · 数组/对象（标签、步骤、设置）用 JSON 列存，读写时由应用层序列化；
--   · 明细表都带 sort_order，用于原样还原列表顺序（应用按 unshift/push 维护顺序）。

CREATE TABLE IF NOT EXISTS `todos` (
  `id`         VARCHAR(48)  NOT NULL COMMENT '待办 ID',
  `text`       VARCHAR(300) NOT NULL COMMENT '待办内容',
  `done`       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否完成',
  `priority`   VARCHAR(4)   NOT NULL DEFAULT 'P2' COMMENT 'P0~P3',
  `due`        VARCHAR(40)  NOT NULL DEFAULT '' COMMENT '截止日期，兼容 yyyy-mm-dd 与 ISO 两种写法',
  `created_at` DATETIME(3)  NULL COMMENT '创建时间（UTC）',
  `sort_order` INT          NOT NULL DEFAULT 0 COMMENT '列表顺序',
  PRIMARY KEY (`id`),
  KEY `idx_todos_sort` (`sort_order`),
  KEY `idx_todos_done` (`done`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='今日待办';

CREATE TABLE IF NOT EXISTS `tickets` (
  `id`          VARCHAR(48)   NOT NULL COMMENT '任务编号，如 WO-1042',
  `title`       VARCHAR(200)  NOT NULL COMMENT '标题',
  `priority`    VARCHAR(4)    NOT NULL DEFAULT 'P2' COMMENT 'P0~P3',
  `status`      VARCHAR(16)   NOT NULL DEFAULT 'todo' COMMENT 'todo/doing/review/done',
  `project`     VARCHAR(80)   NOT NULL DEFAULT '' COMMENT '所属项目',
  -- 分类名，取值来自 project_sections.name（同一个项目内唯一）。
  -- 这一列曾经只在老的建表语句里、且没登记进 schema.js 的 ADDITIVE_COLUMNS，
  -- 于是**全新初始化的库**首次播种写任务表时直接报 Unknown column 'section'。
  `section`     VARCHAR(120)  NOT NULL DEFAULT '' COMMENT '项目分类名',
  `owner`       VARCHAR(80)   NOT NULL DEFAULT '' COMMENT '负责人',
  `due`         VARCHAR(40)   NOT NULL DEFAULT '' COMMENT '截止时间',
  `note`        TEXT          NULL COMMENT '备注：纯文本，可内嵌 ![名字](att:ID) 图片引用',
  `tags`        JSON          NULL COMMENT '标签数组',
  `checklist`   JSON          NULL COMMENT '子任务数组 [{id,text,done}]',
  `archived_at` DATETIME(3)   NULL COMMENT '归档时间（UTC），非空即已归档',
  `deleted_at`  DATETIME(3)   NULL COMMENT '软删除时间（UTC），非空即在回收站',
  `created_at`  DATETIME(3)   NULL,
  `updated_at`  DATETIME(3)   NULL,
  `sort_order`  INT           NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_tickets_status` (`status`),
  KEY `idx_tickets_sort` (`sort_order`),
  KEY `idx_tickets_deleted` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务';

-- 任务的评论 / 动态流。
--
-- 与 assistant_messages 同理：只追加、持续增长的数据不能走内存镜像
-- （镜像是整表 DELETE + 全量 INSERT + 整表指纹判重），所以由 db/comments.js
-- 逐行读写。代价同样是不进备份导出。
CREATE TABLE IF NOT EXISTS `ticket_comments` (
  `seq`        BIGINT      NOT NULL AUTO_INCREMENT COMMENT '单调递增序号，只用于排序',
  `id`         VARCHAR(48) NOT NULL COMMENT '评论 ID',
  `ticket_id`  VARCHAR(48) NOT NULL COMMENT '所属任务',
  `content`    TEXT        NOT NULL COMMENT '正文',
  `created_at` DATETIME(3) NOT NULL COMMENT '创建时间（UTC）',
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_comment_id` (`id`),
  KEY `idx_comment_ticket` (`ticket_id`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务评论 / 动态';

-- 任务附件。文件本体以 data URL 存进 MEDIUMTEXT：不引入 multipart 依赖，
-- 也不用管磁盘文件的清理与备份。代价是单个要小（1.5MB 上限）、每条任务最多 5 个。
-- 项目：Tower 式的「项目 → 任务」两层。
-- 任务仍然用 tickets.project 存项目名（名字即外键），这样现有数据不用迁移，
-- 改名时后端同步刷一遍任务的 project 字段即可。
CREATE TABLE IF NOT EXISTS `projects` (
  `id`         VARCHAR(48)  NOT NULL COMMENT '项目 ID',
  `name`       VARCHAR(120) NOT NULL COMMENT '项目名，与 tickets.project 一一对应',
  `note`       TEXT         NULL COMMENT '项目说明',
  `sort`       INT          NOT NULL DEFAULT 0 COMMENT '自定义排序（越小越前）',
  `created_at` DATETIME(3)  NOT NULL COMMENT '创建时间（UTC）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_project_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目';

-- 项目内的分类：Tower 的项目详情里每个项目下可以再分若干「分组」。
-- 与项目同理，任务侧用 tickets.section 存分类名（落在同一个项目内才唯一）。
CREATE TABLE IF NOT EXISTS `project_sections` (
  `id`         VARCHAR(48)  NOT NULL COMMENT '分类 ID',
  `project_id` VARCHAR(48)  NOT NULL COMMENT '所属项目',
  `name`       VARCHAR(120) NOT NULL COMMENT '分类名',
  `sort`       INT          NOT NULL DEFAULT 0 COMMENT '排序（越小越前）',
  `created_at` DATETIME(3)  NOT NULL COMMENT '创建时间（UTC）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_section_name` (`project_id`, `name`),
  KEY `idx_section_project` (`project_id`, `sort`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目分类';

-- 同样走独立表逐行读写（只追加、不随机型，理由见 db/attachments.js）。
CREATE TABLE IF NOT EXISTS `ticket_attachments` (
  `seq`        BIGINT       NOT NULL AUTO_INCREMENT COMMENT '单调递增序号',
  `id`         VARCHAR(48)  NOT NULL COMMENT '附件 ID',
  `ticket_id`  VARCHAR(48)  NOT NULL COMMENT '所属任务',
  `name`       VARCHAR(200) NOT NULL COMMENT '原始文件名',
  `mime`       VARCHAR(120) NOT NULL DEFAULT '' COMMENT 'MIME 类型',
  `size`       INT          NOT NULL DEFAULT 0 COMMENT '字节数',
  `content`    MEDIUMTEXT   NOT NULL COMMENT 'data URL 形式的内容',
  `inline`     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1=粘贴进正文的内联图片，不出现在附件区',
  `created_at` DATETIME(3)  NOT NULL COMMENT '上传时间（UTC）',
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_attachment_id` (`id`),
  KEY `idx_attachment_ticket` (`ticket_id`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务附件';

CREATE TABLE IF NOT EXISTS `bookmark_groups` (
  `id`         VARCHAR(48) NOT NULL COMMENT '分组 ID',
  `name`       VARCHAR(40) NOT NULL COMMENT '分组名',
  `sort_order` INT         NOT NULL DEFAULT 0 COMMENT '排序',
  PRIMARY KEY (`id`),
  KEY `idx_groups_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='常用网站分组';

CREATE TABLE IF NOT EXISTS `bookmarks` (
  `id`         VARCHAR(48)   NOT NULL COMMENT '书签 ID',
  `name`       VARCHAR(60)   NOT NULL COMMENT '名称',
  `url`        VARCHAR(1000) NOT NULL COMMENT '网址',
  `group_id`   VARCHAR(48)   NOT NULL DEFAULT '' COMMENT '所属分组，对应 bookmark_groups.id',
  `note`       VARCHAR(120)  NOT NULL DEFAULT '' COMMENT '备注',
  `color`      VARCHAR(16)   NOT NULL DEFAULT '' COMMENT '品牌色',
  `icon`       MEDIUMTEXT   NULL COMMENT '自定义图标（base64 data URL）',
  `pinned`     TINYINT       NOT NULL DEFAULT 0 COMMENT '标星：常用网站（首页与工具箱共用）',
  `sort_order` INT           NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_bookmarks_group` (`group_id`),
  KEY `idx_bookmarks_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='常用网站';

CREATE TABLE IF NOT EXISTS `knowledge_items` (
  `id`         VARCHAR(48)  NOT NULL COMMENT '条目 ID',
  `type`       VARCHAR(16)  NOT NULL DEFAULT 'sop' COMMENT 'sop / runbook / excerpt（阅读摘录）',
  `title`      VARCHAR(160) NOT NULL COMMENT '标题',
  `tags`       JSON         NULL COMMENT '标签数组',
  `summary`    VARCHAR(400) NOT NULL DEFAULT '' COMMENT '摘要',
  `steps`      JSON         NULL COMMENT '步骤数组（旧结构，已并入 body，只读保留）',
  `body`       MEDIUMTEXT   NULL COMMENT 'Markdown 正文',
  `body_plain` MEDIUMTEXT   NULL COMMENT '正文剥掉标记后的纯文本，供搜索与 AI 检索',
  `pinned`     TINYINT      NOT NULL DEFAULT 0 COMMENT '置顶：排到列表最前',
  `starred`    TINYINT      NOT NULL DEFAULT 0 COMMENT '星标：标记 + 可单独筛选',
  `ai`         JSON         NULL COMMENT '文章助手的对话记录，随条目一起删',
  `deleted_at` DATETIME(3)  NULL COMMENT '软删除时间（UTC），非空即在回收站',

  `updated_at` DATETIME(3)  NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_kb_type` (`type`),
  KEY `idx_kb_sort` (`sort_order`),
  KEY `idx_kb_deleted` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识库（SOP / Runbook）';

CREATE TABLE IF NOT EXISTS `news_items` (
  `id`           VARCHAR(64)  NOT NULL COMMENT '条目 ID',
  `title`        TEXT         NOT NULL COMMENT '标题',
  `link`         TEXT         NULL COMMENT '原文链接',
  `source`       VARCHAR(80)  NOT NULL DEFAULT '' COMMENT '来源源名',
  `published_at` DATETIME(3)  NULL COMMENT '发布时间（UTC）',
  `summary`      TEXT         NULL COMMENT '摘要',
  `tags`         JSON         NULL COMMENT '标签数组',
  `score`        INT          NULL COMMENT 'AIHOT 打分 0-100',
  `reason`       TEXT         NULL COMMENT '推荐理由',
  `sort_order`   INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_news_published` (`published_at`),
  KEY `idx_news_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 热点条目';

CREATE TABLE IF NOT EXISTS `news_state` (
  `id`         TINYINT       NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `updated_at` DATETIME(3)   NULL COMMENT '最近一次抓取成功时间',
  `last_error` VARCHAR(1000) NULL COMMENT '最近一次抓取错误',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 热点抓取状态';

/* 多源热点榜 + 事件故事线。整份快照而不是逐条存：
   榜单是"某一时刻的一张榜"，位次会变、事件会被合并，
   按条目那样做增量管理反而对不上。写是整行替换。 */
CREATE TABLE IF NOT EXISTS `news_hot` (
  `id`         TINYINT     NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `payload`    JSON        NULL COMMENT '热点榜与故事线的整份快照',
  `updated_at` DATETIME(3) NULL COMMENT '最近一次抓取成功时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 热点榜快照';

/* 每日日报。和榜单一样是整份快照：日报"只编辑一次"，但撤回的引用会从
   后续响应里移除，所以每次要带 If-None-Match 重新校验，变了才替换。 */
CREATE TABLE IF NOT EXISTS `news_daily` (
  `id`         TINYINT     NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `payload`    JSON        NULL COMMENT '最新一期日报的整份快照',
  `updated_at` DATETIME(3) NULL COMMENT '最近一次抓取成功时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 每日日报快照';

CREATE TABLE IF NOT EXISTS `app_settings` (
  `id`         TINYINT     NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `payload`    JSON        NOT NULL COMMENT '主题 / PVE 连接 / 功耗模型 / 订阅源',
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='全局设置（单行）';

CREATE TABLE IF NOT EXISTS `ai_usage` (
  `id`         TINYINT     NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `payload`    JSON        NULL COMMENT '全站大模型 token 用量：总量 / 按天 / 按用途',
  `updated_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='大模型 token 用量（单行）';

/* 桌宠盯着的 DeepSeek 余额快照。
   余额接口只回答"此刻还剩多少"，说不清"今天花掉多少" —— 那是存量，
   能拿来判断该不该收着点的是消耗。所以按天记下读数，用相邻两天的差值
   反推当日消耗（与 meter_daily 用累计值推导当日电量是同一个思路）。
   单行 + JSON：它就是一份按天的读数表，不值得为它展开成一张明细表。 */
CREATE TABLE IF NOT EXISTS `pet_balance` (
  `id`         TINYINT     NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `payload`    JSON        NULL COMMENT 'DeepSeek 余额的按天快照（首末读数）',
  `updated_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DeepSeek 余额快照（单行）';

CREATE TABLE IF NOT EXISTS `energy_state` (
  `id`            TINYINT NOT NULL DEFAULT 1 COMMENT '固定为 1',
  `last_ts`       BIGINT  NULL COMMENT '上次采样时间戳（毫秒）',
  `last_watts`    DOUBLE  NOT NULL DEFAULT 0,
  `total_kwh`     DOUBLE  NOT NULL DEFAULT 0 COMMENT '累计电量',
  `total_cost`    DOUBLE  NOT NULL DEFAULT 0 COMMENT '累计电费',
  `eco_saved_kwh` DOUBLE  NOT NULL DEFAULT 0 COMMENT '节能累计节省电量',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='电量累计汇总（单行）';

CREATE TABLE IF NOT EXISTS `energy_daily` (
  `day`     DATE   NOT NULL COMMENT '自然日',
  `kwh`     DOUBLE NOT NULL DEFAULT 0,
  `cost`    DOUBLE NOT NULL DEFAULT 0,
  `eco_kwh` DOUBLE NOT NULL DEFAULT 0,
  `samples` INT    NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每日电量与电费';

-- 插座累计电量计数器的每日快照。
-- 智能插座只上报一个单调递增的累计值，没有"今日/本月"分项，
-- 所以由工作台在每个自然日记录首末两次读数，用它推导当日与滚动窗口的用量。
-- 用累计值推导而不是对瞬时功率做积分，服务停机也不会漏计。
CREATE TABLE IF NOT EXISTS `meter_daily` (
  `day`         DATE   NOT NULL COMMENT '自然日',
  `counter_in`  DOUBLE NOT NULL DEFAULT 0 COMMENT '当日首次读到的累计电量(kWh)',
  `counter_out` DOUBLE NOT NULL DEFAULT 0 COMMENT '当日最后读到的累计电量(kWh)',
  PRIMARY KEY (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='插座累计电量每日快照';

-- 运行模式的实测对照：每个「模式 × CPU 负载档」一行，2×4 封顶 8 行。
-- 用来回答"节能模式到底省多少电"——这个数不能靠配置写死，只能量出来。
--
-- 为什么必须按负载档分桶：governor 对功耗的影响和负载强相关。
-- performance 空载也锁高频，差距最大；满载时两者都跑高频、几乎趋同。
-- 不对齐负载直接比两段时间的平均功率，比出来的差值里混的是"那阵子在忙什么"。
--
-- 为什么存 hours 而不是样本计数：accumulate 被前端 5 秒轮询和服务端 60 秒
-- 采样器共用，按次数计权会让"页面开着"的时候权重被灌成 12:1。按时间累积，
-- 两种调用方式得到同一结果。
-- 月度电量归档。是「日明细」被清理前的存档：
-- 日明细只留 3 个月，再往前的逐日数据删掉，但每月汇总保留 1 年，
-- 这样"历史每月电费"这条线不断，而明细不会无限膨胀。
-- days 记该月已归档的天数，用来判断这个月是不是被完整agg过。
CREATE TABLE IF NOT EXISTS `energy_monthly` (
  `month`   CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  `kwh`     DOUBLE NOT NULL DEFAULT 0,
  `cost`    DOUBLE NOT NULL DEFAULT 0,
  `eco_kwh` DOUBLE NOT NULL DEFAULT 0,
  `days`    INT    NOT NULL DEFAULT 0 COMMENT '该月已归档天数',
  PRIMARY KEY (`month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='月度电量归档';

CREATE TABLE IF NOT EXISTS `mode_samples` (
  `mode`  VARCHAR(8) NOT NULL COMMENT 'standard / eco',
  `band`  VARCHAR(8) NOT NULL COMMENT 'CPU 负载档 idle/light/mid/busy/unknown',
  `hours` DOUBLE NOT NULL DEFAULT 0 COMMENT '累计时长（小时）',
  `kwh`   DOUBLE NOT NULL DEFAULT 0 COMMENT '累计电量；除以 hours 即该档的平均功率',
  PRIMARY KEY (`mode`, `band`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='运行模式实测对照';

-- AI 助手的对话历史。
--
-- 为什么单独建表、而且不挂进 store.js 的内存镜像：
-- 镜像那套是按表「整表 DELETE + 全量 INSERT」落库、并按整表 JSON 指纹判重的。
-- 对话是只追加、持续增长的数据，走镜像等于每发一条消息都要重写全部历史，
-- 越用越慢，事务也越滚越大。所以这张表由 db/messages.js 逐行读写。
--
-- 代价：它不在内存镜像里，所以「备份导出」不包含对话历史（导出的是镜像快照）。
CREATE TABLE IF NOT EXISTS `assistant_messages` (
  `seq`        BIGINT       NOT NULL AUTO_INCREMENT COMMENT '单调递增序号，只用于排序与裁剪',
  `id`         VARCHAR(48)  NOT NULL COMMENT '消息 ID',
  `role`       VARCHAR(16)  NOT NULL COMMENT 'user / assistant',
  `content`    MEDIUMTEXT   NOT NULL COMMENT '消息正文',
  `engine`     VARCHAR(16)  NULL COMMENT 'rule / llm / local，仅助手消息有',
  `warning`    VARCHAR(500) NULL COMMENT '回退或中断说明，仅助手消息有',
  `created_at` DATETIME(3)  NOT NULL COMMENT '创建时间（UTC）',
  PRIMARY KEY (`seq`),
  UNIQUE KEY `uk_msg_id` (`id`),
  KEY `idx_msg_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 助手对话历史';
