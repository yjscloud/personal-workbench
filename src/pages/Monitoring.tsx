import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, CircuitBoard, Cpu, HardDrive, Info, Leaf, MemoryStick, Network, Server, Settings2, Thermometer, Zap } from 'lucide-react';
import { api, type DiskHealth, type PowerSource } from '@/lib/api';
import { useMonitor } from '@/lib/monitor';
import { useChartColors, timeLabel, GRID_DASH } from '@/lib/useChartColors';
import { fmtTokens, useAiUsage, usedTokens } from '@/lib/ai-usage';
import { cls, energyParts, fmtBytes, fmtDuration, fmtEnergy, fmtMoney, fmtRate } from '@/lib/format';
import { Badge, Button, Card, CardHead, Empty, LiveDot, Meter, PageHead, Section, Segmented, Select, Skeleton, Spinner, toneByRatio } from '@/components/ui';
import { RatioStat, Stat, ToneLed } from '@/components/bits';

const TIMEFRAMES = [
  { value: 'hour', label: '1 小时' },
  { value: 'day', label: '1 天' },
  { value: 'week', label: '1 周' },
  { value: 'month', label: '1 月' },
];

/* 功耗读数从哪来：空调面板上必须说清楚，否则看不出是实测还是估算 */
const SOURCE_LABEL: Record<PowerSource, string> = {
  ha: '读数来自米家智能插座实测',
  sensor: '读数来自硬件传感器',
  model: '按 CPU 利用率模型估算',
};

export default function Monitoring() {
  const { overview, loading, error, timeframe, setTimeframe, node, setNode, refresh, lastUpdated } = useMonitor();
  const [nodes, setNodes] = useState<{ node: string; status?: string }[]>([]);

  useEffect(() => {
    api.pve
      .nodes()
      .then((res) => setNodes(res.nodes ?? []))
      .catch(() => setNodes([]));
  }, []);

  /* 错误态与加载态走同一套骨架：页头只有一个，页面名永远在同一个位置 */
  if (error && !overview) {
    return (
      <div className="mx-auto w-full max-w-[1600px]">
        <PageHead title="监控数据" hint="从 Proxmox VE 读取节点指标、传感器与功耗。" />
        <div className="border-l-[3px] border-crit bg-crit-soft px-5 py-4">
          <p className="text-[13px] font-medium text-ink">没有取到监控数据</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{error}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="primary" onClick={() => void refresh()}>
              重试
            </Button>
            <Link to="/settings" className="text-2xs text-accent underline decoration-dotted underline-offset-2">
              检查 Proxmox 连接
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!overview) {
    /* 首屏骨架：形状照着真实布局摆 —— 时间窗标签轨、功耗焦点面、
        四个环形读数、两张曲线。骨架的价值就在"高度不跳"，
        所以这里不用一条细条糊过去。 */
    return (
      <div className="mx-auto w-full max-w-[1600px]" role="status" aria-busy="true">
        <PageHead title="监控数据" hint="从 Proxmox VE 读取节点指标、传感器与功耗。" />
        <Skeleton className="mb-8 h-8 w-[19rem] rounded-field" />
        <Skeleton className="mb-8 h-[13rem]" />
        <div className="mb-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[12.5rem]" />
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-[19rem]" />
          <Skeleton className="h-[19rem]" />
        </div>
        <span className="sr-only">正在读取 PVE 指标…</span>
      </div>
    );
  }

  const status = overview.status;
  const demo = overview.mode === 'demo';

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <PageHead
        title="监控数据"
        hint={
          <>
            节点 <span className="num text-ink">{overview.node}</span>
            {demo ? '（演示数据，在设置里填入 Proxmox Token 后自动切换真实指标）' : ''}
            {lastUpdated ? (
              <>
                ，最近一次采样 <span className="num text-ink">{new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}</span>。
              </>
            ) : (
              '。'
            )}
          </>
        }
        actions={
          <>
            {nodes.length > 1 ? (
              <Select value={node || overview.node} onChange={(e) => setNode(e.target.value)} className="w-auto text-2xs">
                {nodes.map((n) => (
                  <option key={n.node} value={n.node}>
                    {n.node}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Spinner /> : null}
              刷新
            </Button>
          </>
        }
      />

      {/* 时间窗：一条标签轨，管住整页的序列长度 */}
      <Segmented className="mb-8" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES} />

      {overview.warning ? (
        <p className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-1 border-l-[3px] border-warn bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-ink">
          <Info size={15} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1">{overview.warning}</span>
          <Link to="/settings" className="shrink-0 text-accent underline decoration-dotted underline-offset-2">
            去配置
          </Link>
        </p>
      ) : null}

      {/* 主指标：整页唯一的深色焦点面 */}
      <PowerPanel />

      {/* 四个读数用「图标方块 + 右上角占比 + 大数值 + 进度条」（RatioStat）。
          中途试过换成环形读数，但那四个环挂在卡片中间，横向扫读时反而不如
          一根横条快 —— 并排比较时，长度的差异是最省力的形状。 */}
      <Section
        title="节点负载"
        hint={`CPU、内存、根分区与平均负载的当前读数，节点已运行 ${fmtDuration(status.uptime)}`}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <RatioStat
            label="CPU 使用率"
            // CPU 是比率不是字节：used 传 0–1、total 传 1，
            // 右上角占比和大数值就都落在同一个百分数上
            used={status.cpu || 0}
            total={1}
            valueText={`${((status.cpu || 0) * 100).toFixed(1)}%`}
            warn={0.7}
            crit={0.88}
            tile="cpu"
            icon={<Cpu size={15} />}
            hint={`${status.cpuinfo?.cores ?? '—'} 核 · ${status.cpuinfo?.model ?? '—'}`}
          />
          <RatioStat
            label="内存使用率"
            used={status.memory.used}
            total={status.memory.total}
            warn={0.75}
            crit={0.9}
            tile="mem"
            icon={<MemoryStick size={15} />}
            hint={`共 ${fmtBytes(status.memory.total)}`}
          />
          <RatioStat
            label="根分区使用率"
            used={status.rootfs.used}
            total={status.rootfs.total}
            warn={0.8}
            crit={0.92}
            tile="store"
            icon={<HardDrive size={15} />}
            hint={`可用 ${fmtBytes(status.rootfs.avail || status.rootfs.free)}`}
          />
          <RatioStat
            label="平均负载"
            // 负载是"排队长度"，除以核数才是可比的满载程度：右上角占比就是这个
            // 比值，大数值仍然显示原始的 1 分钟负载，不和 5/15 分那条线混淆
            used={Array.isArray(status.loadavg) ? Number(status.loadavg[0]) : 0}
            total={status.cpuinfo?.cores || 1}
            valueText={Array.isArray(status.loadavg) ? status.loadavg[0] : '—'}
            warn={0.75}
            crit={1}
            tile="ok"
            icon={<Activity size={15} />}
            hint={Array.isArray(status.loadavg) ? `${status.loadavg.join(' / ')} · 1/5/15 分` : '—'}
          />
        </div>
      </Section>

      <Section title="使用趋势" hint="CPU 与内存的走势，以及磁盘读写吞吐">
        <div className="grid gap-5 lg:grid-cols-2">
          <CpuMemChart />
          <IoChart />
        </div>
      </Section>

      {/* 容量与 Token 并排各占一半：两者都是"长期趋势"，放一起对照最自然。
          容量增长因此缩到半栏（它内部的图与指标已改成上下堆叠来适配）。
          共用一个 Section 而不是各起一个：两张卡各自都带 CardHead，
          再来两个 Section 标题就变成"容量增长 / 容量增长"式的重复。 */}
      <Section title="容量与用量" hint="左边是磁盘增长趋势，右边是全站大模型 token 花销">
        <div className="grid gap-5 lg:grid-cols-2">
          <GrowthPanel />
          <TokenPanel />
        </div>
      </Section>

      <Section title="网络" hint="节点收发速率曲线，以及逐网卡的累计流量">
        <NetTrafficCard />
      </Section>

      <Section title="温度">
        <ThermalPanel />
      </Section>

      <Section title="存储与虚拟化">
        <div className="grid gap-5 lg:grid-cols-2">
          <DiskHealthPanel />
          <GuestTable />
        </div>
      </Section>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   功耗 / 电费 / 节能模式
   ══════════════════════════════════════════════════════════════════ */
/* CPU 负载档的中文名。后端是按 CPU 利用率分的桶，见 power.js 的 loadBand */
const BAND_LABEL: Record<string, string> = {
  idle: '空载',
  light: '轻载',
  mid: '中载',
  busy: '满载',
  unknown: '未标注负载',
};

function PowerPanel() {
  const { overview, toggleEco, ecoBusy } = useMonitor();
  const colors = useChartColors();
  const power = overview?.power;
  if (!power) return null;

  const eco = power.eco.enabled;
  const history = (power.history || []).map((h) => ({ ...h, label: h.date.slice(5) }));
  const monthly = power.monthly || [];

  /* 实测节能：拿积累时长最长的那一档当代表性读数。它本来就主导了加权结果，
     用它举例最不容易误导。各档明细塞进 tooltip——数字要经得起追问。 */
  const ecoMeasured = power.eco.measured;
  const topBand = ecoMeasured?.bands?.length
    ? ecoMeasured.bands.slice().sort((a, b) => b.hours - a.hours)[0]
    : null;
  const bandDetail = (ecoMeasured?.evidence || [])
    .filter((e) => e.standardHours > 0 || e.ecoHours > 0)
    .map((e) => `${BAND_LABEL[e.band] ?? e.band}：标准 ${e.standardHours}h ／ 节能 ${e.ecoHours}h`)
    .join('\n');

  return (
    <section className="panel mb-8 overflow-hidden rounded-xl2" aria-label="功耗与电费">
      {/* 主读数 + 运行模式：一块浅蓝的焦点面（.focus-card，样式见 index.css）。
          这里原本是深色面。深色焦点面每页只放一块时是有效的，可这一块里
          塞着读数、模式按钮和一行元信息，压上去等于把整页的视觉重量全砸在
          上半屏，下半屏那些真正要看的读数反而没人看。
          换成浅蓝之后它仍然"是一块不同的面"，重量却和周围的白卡同级。
          蓝取腾讯云 #0052D9 的浅位，与下面图表的域色同源，整页只有一支蓝。
          网格底纹与上缘高光都在 .focus-card.sky 里，深浅主题各自取色。 */}
      <div className="focus-card sky relative grid gap-x-6 gap-y-6 p-4 shadow-none sm:p-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center lg:gap-x-10">

        <div className="relative z-10 min-w-0">
          {/* 接了一路以上就不是"整机"了，是若干设备的合计，标题得跟着说实话 */}
          <p className="text-2xs text-muted">
            {power.ha.sockets.length > 1 ? `监控总功耗（${power.ha.sockets.length} 路合计）` : '当前整机功耗'}
          </p>
          <p className="num mt-3 flex items-baseline gap-2 leading-none text-ink">
            <span className="text-[44px] font-semibold tracking-display">{power.watts.toFixed(1)}</span>
            <span className="text-lg font-normal text-muted">W</span>
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-2xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              {/* 浅蓝面的明度够高，用不着再为它另配一套亮色：
                  --ok / --warn 本来就是为浅底挑的，压上去照样读得出来 */}
              <LiveDot tone={eco ? 'ok' : 'neutral'} />
              {eco ? '节能模式' : '标准模式'}
            </span>
            <span>
              标准模式等效 <span className="num text-ink">{power.eco.standardWatts.toFixed(1)} W</span>
            </span>
            {/* 节省量是"节能期间用掉的电 × (1/系数 - 1)"反推的，不是独立测出来的，
                所以必须把这个数出自哪个系数、是实测还是估算，一并说清楚 */}
            <span
              title={
                power.eco.basis === 'measured'
                  ? `节能模式下累计用掉 ${power.eco.ecoKwhTotal} kWh，按实测系数 ${power.eco.factor} 反推`
                  : `样本不足，暂按设置里的系数 ${power.eco.manualFactor} 反推 —— 这是估算，不是实测`
              }
            >
              累计节省 <span className="num text-ok">{fmtEnergy(power.eco.totalSavedKwh)}</span>
              <span className="ml-1">（{fmtMoney(power.eco.totalSavedCost, power.price.currency)}）</span>
              {/* 「实测 / 估算」只差一个字，颜色是唯一的区分信号，所以这里必须上色 */}
              <span className={cls('ml-1', power.eco.basis === 'measured' ? 'text-ok' : 'text-warn')}>
                {power.eco.basis === 'measured' ? '实测' : '估算'}
              </span>
            </span>
            <span>{SOURCE_LABEL[power.source]}</span>
            {/* 接了多路插座时把分项摆出来，否则只看得到合计，排查不了是哪一路在耗电 */}
            {power.ha.sockets.length > 1 ? (
              <span>
                各插座{' '}
                <span className="num text-ink">
                  {power.ha.sockets.map((s) => `${s.name} ${s.watts ?? '—'}W`).join(' · ')}
                </span>
              </span>
            ) : null}
            {power.meter.counterKwh != null ? (
              <span
                title={
                  power.meter.alive
                    ? '插座上报的累计电量读数'
                    : '这块插座的「耗电量」属性恒定不增长，用电量已改用实测功率积分'
                }
              >
                插座累计读数 <span className="num text-ink">{fmtEnergy(power.meter.counterKwh)}</span>
                {power.meter.alive ? null : <span className="ml-1 text-faint">（该属性不增长，未采用）</span>}
              </span>
            ) : null}
            {power.ha.configured && !power.ha.online ? (
              <span className="text-warn" title={power.ha.error ?? ''}>
                Home Assistant 读数不可用，已回退到估算
              </span>
            ) : null}
          </div>
        </div>

        <div className="relative z-10 min-w-0">
          <p className="mb-2 text-2xs text-muted">运行模式</p>
          {/* 两个按钮各自成块，靠间距分开而不是 1px 线 ——
              浅蓝面上那条半透明白线等于没有，反而把两块糊成一片 */}
          <div className="grid grid-cols-2 gap-2">
            <ModeButton
              active={!eco}
              disabled={ecoBusy}
              onClick={() => void toggleEco(false)}
              icon={<Zap size={14} />}
              title="标准模式"
              hint={`功耗上限 ${power.model.maxW}W`}
            />
            <ModeButton
              active={eco}
              disabled={ecoBusy}
              onClick={() => void toggleEco(true)}
              icon={<Leaf size={14} />}
              title="节能模式"
              hint={
                power.eco.basis === 'measured'
                  ? `实测省 ${power.eco.savedPercent}%`
                  : `测量中 · 暂按 ${power.eco.savedPercent}%`
              }
              tone="ok"
            />
          </div>
          <p className="mt-3 text-2xs leading-relaxed text-muted">
            {ecoBusy ? (
              <span className="flex items-center gap-1.5">
                <Spinner className="h-3 w-3" /> 正在切换…
              </span>
            ) : !eco ? (
              '不做功耗限制，性能优先。'
            ) : topBand && ecoMeasured ? (
              <>
                实测 {BAND_LABEL[topBand.band] ?? topBand.band}：标准{' '}
                <span className="num text-ink">{topBand.standardWatts}W</span> → 节能{' '}
                <span className="num text-ink">{topBand.ecoWatts}W</span>，省{' '}
                <span className="num text-ok">{topBand.savedWatts}W</span>
                <span
                  className="ml-1 cursor-help text-faint underline decoration-dotted underline-offset-2"
                  title={`各负载档已积累的对照时长\n${bandDetail}`}
                >
                  {ecoMeasured.comparedHours}h 对照
                </span>
              </>
            ) : (
              <>
                正在实测：两种模式要在同一负载档下各跑满 {power.eco.measured?.minBandHours ?? 0.5}{' '}
                小时才算得出比例，暂用设置里的系数 {power.eco.manualFactor}。
                {bandDetail ? (
                  <span
                    className="ml-1 cursor-help text-faint underline decoration-dotted underline-offset-2"
                    title={`各负载档已积累的对照时长\n${bandDetail}`}
                  >
                    查看进度
                  </span>
                ) : null}
              </>
            )}
          </p>

          {/* CPU 调频器实况。这是「运行模式」唯一真的动了硬件的部分，
              所以必须能当场验证。三种状态分开说，不要让人以为按了没反应：
              读不到 = SSH 不通；读到了但对不上 = 下发失败。 */}
          {overview?.cpu ? (
            <p className="mt-2 flex items-start gap-1.5 text-2xs">
              <Cpu size={12} className="mt-px shrink-0 text-faint" />
              {overview.cpu.governor === null ? (
                <span className="text-faint" title="工作台到 PVE 母机的 SSH 免密登录可能没配好">
                  CPU 调频器读取失败，无法确认是否已生效
                </span>
              ) : overview.cpu.governor === overview.cpu.expected ? (
                <span className="text-muted">
                  母机 CPU 调频器 <span className="num text-ink">{overview.cpu.governor}</span>
                  <span className="ml-1 text-ok">已生效</span>
                </span>
              ) : (
                <span className="text-warn">
                  母机 CPU 调频器是 <span className="num">{overview.cpu.governor}</span>，本模式应为{' '}
                  <span className="num">{overview.cpu.expected}</span>，未对上
                </span>
              )}
            </p>
          ) : null}
          <Link
            to="/settings"
            className="mt-3 inline-flex items-center gap-1.5 text-2xs text-accent underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80"
          >
            <Settings2 size={12} />
            校准功耗参数
          </Link>
        </div>
      </div>

      {/* 电费：1px 线连成的一条数据带。
          用电量取自插座：设备没给出可用的累计读数，所以对实测电功率做时间积分。 */}
      <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
        <PowerCell
          label="今日用电"
          {...energyParts(power.today.kwh)}
          hint={
            power.costBasis === 'integrated'
              ? `插座实测功率积分 · ${power.today.samples} 次采样`
              : power.costBasis === 'meter'
                ? '插座累计读数差值'
                : 'HA 统计实体'
          }
        />
        <PowerCell
          label="近一月用电"
          {...energyParts(power.cumulative.monthKwh)}
          hint={
            power.window.hasFullWindow
              ? `滚动 ${power.window.windowDays} 天`
              : power.window.since
                ? `自 ${power.window.since} 起累计（未满 ${power.window.windowDays} 天）`
                : '暂无数据'
          }
        />
        <PowerCell
          label="今日电费"
          value={fmtMoney(power.today.cost, power.price.currency)}
          tone="accent"
          hint={`电价 ${power.price.perKwh} 元/kWh`}
        />
        <PowerCell
          label="预估日电费"
          value={fmtMoney(power.projection.dayCost, power.price.currency)}
          hint={`全天约 ${fmtEnergy(power.projection.dayKwh)}`}
        />
        <PowerCell
          label="预估月电费"
          value={fmtMoney(power.projection.monthCost, power.price.currency)}
          tone="accent"
          hint={`按插座近一月 ${fmtEnergy(power.projection.monthKwh)} 折算，全年约 ${fmtMoney(power.projection.yearCost, power.price.currency)}`}
        />
      </div>

      {/* 最近 14 天用电 */}
      <div className="border-t border-line p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-2xs text-muted">最近 14 天每日用电（kWh）</p>
          <p className="num text-2xs text-faint">
            累计 {fmtEnergy(power.cumulative.totalKwh)}，{fmtMoney(power.cumulative.totalCost, power.price.currency)}
          </p>
        </div>
        {history.length ? (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={history} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
              <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
              <Tooltip content={<ChartTip unit={(v: number) => `${v.toFixed(2)} kWh`} />} cursor={{ fill: colors.panel2 }} />
              {/* 用电量本身不是告警，所以走冷色主档，不铺琥珀：
                  一整排实心柱面积极大，用警告色填满，页面上真正的告警
                  就被这片黄淹了。琥珀仍然留给温度与阈值线。 */}
              <Bar dataKey="kwh" name="用电量" maxBarSize={28}>
                {history.map((h) => (
                  <Cell key={h.date} fill={colors.bar} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="py-6 text-center text-2xs text-faint">还没积累到整天的数据，保持工作台开着一会儿就有了。</p>
        )}
      </div>

      {/* 每月用电：最新月份在最上面。
          近期月份由日明细现算，更早的月份来自归档表——逐日明细只留 3 个月，
          再往前只剩「月汇总」这一行，所以这里其实是两段数据拼起来的，
          「已归档」标签就是用来标明某一行是哪种来源的。 */}
      {monthly.length ? (
        <div className="border-t border-line p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-2xs text-muted">每月用电与电费</p>
            <p className="text-2xs text-faint">
              逐日明细保留 {power.retention.dailyKeepMonths} 个月，更早的已并成月汇总
            </p>
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-2xs text-faint">
                <th className="px-1 pb-2 font-normal">月份</th>
                <th className="px-1 pb-2 text-right font-normal">用电量</th>
                <th className="px-1 pb-2 text-right font-normal">电费</th>
                <th className="px-1 pb-2 text-right font-normal">天数</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {monthly.map((m) => (
                <tr key={m.month}>
                  <td className="num px-1 py-2">
                    {m.month}
                    {m.partial ? <span className="ml-1.5 font-sans text-2xs text-faint">本月未完</span> : null}
                    {m.archived ? <span className="ml-1.5 font-sans text-2xs text-faint">已归档</span> : null}
                  </td>
                  <td className="num px-1 py-2 text-right">{fmtEnergy(m.kwh)}</td>
                  <td className="num px-1 py-2 text-right">{fmtMoney(m.cost, power.price.currency)}</td>
                  <td className="num px-1 py-2 text-right text-faint">{m.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** 电费数据格：深色面里的一格，靠 1px 线与其他格分开 */
function PowerCell({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: 'accent';
}) {
  return (
    <div className="bg-panel px-5 py-4">
      <p className="text-2xs text-muted">{label}</p>
      <p className={cls('num mt-2.5 text-lg font-semibold leading-none', tone === 'accent' ? 'text-accent' : 'text-ink')}>
        {value}
        {unit ? <span className="ml-1 text-2xs font-normal text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-2 text-2xs leading-relaxed text-faint">{hint}</p> : null}
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  icon,
  title,
  hint,
  tone = 'accent',
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  hint: string;
  /** 节能模式选中时用绿色：它是"在省电"这件事的颜色，和全站的 ok 同源 */
  tone?: 'accent' | 'ok';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      /* 按钮压在浅蓝焦点面上：选中的是一块实心色块，未选中的是白底灰字。
         · 未选中的底不能用半透明白 —— 在浅蓝面上那是"更浅的浅蓝"，
           两块摆在一起像都没选中，所以用实心白（bg-panel）。
         · 选中时的前景色不能写 text-white：浅色主题下强调蓝和 ok 都是深色，
           配白字没问题；深色主题下这两支都翻成浅色，白字压上去只剩 1.3~2.4:1。
           走 --on-accent / --on-ok 这对"压在实心块上的前景" token，
           两套主题各自成立（见 index.css 里那段说明）。 */
      className={cls(
        'flex flex-col items-start gap-1 rounded-field px-3.5 py-3 text-left transition-colors disabled:opacity-60',
        active
          ? tone === 'ok'
            ? 'bg-ok text-on-ok shadow-soft'
            : 'bg-accent text-on-accent shadow-soft'
          : 'bg-panel text-muted shadow-soft hover:text-ink',
      )}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-medium">
        {icon}
        {title}
      </span>
      <span className="num text-2xs opacity-80">{hint}</span>
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════
   图表
   ══════════════════════════════════════════════════════════════════ */
function ChartTip({ active, payload, label, unit, labelFmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-field bg-panel px-3 py-2 text-2xs shadow-pop">
      <p className="num mb-1 text-faint">
        {labelFmt ? labelFmt(label) : typeof label === 'number' ? new Date(label * 1000).toLocaleString('zh-CN') : label}
      </p>
      {payload.map((p: any) => (
        <p key={String(p.dataKey)} className="num flex items-center gap-1.5 text-ink">
          <span className="inline-block h-2 w-2" style={{ background: p.color || p.fill }} />
          <span className="text-muted">{p.name}</span>
          <span>{unit ? unit(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

function useChartData() {
  const { overview, timeframe } = useMonitor();
  const colors = useChartColors();
  const data = useMemo(
    () =>
      (overview?.series ?? []).map((p) => ({
        ...p,
        cpuPct: p.cpu * 100,
        memPct: p.maxmem ? (p.memused / p.maxmem) * 100 : 0,
        rootPct: p.roottotal ? (p.rootused / p.roottotal) * 100 : 0,
        rootGb: p.rootused / 1024 ** 3,
        readMb: (p.diskread ?? 0) / 1024 ** 2,
        writeMb: (p.diskwrite ?? 0) / 1024 ** 2,
        /* RRD 的 netin/netout 是每秒字节数。这台机器常态在几十 KB/s 量级，
           用 KB 才读得出起伏，按 MB 会压成一条贴着 0 的线。 */
        netinKb: (p.netin ?? 0) / 1024,
        netoutKb: (p.netout ?? 0) / 1024,
        label: timeLabel(p.time, timeframe),
      })),
    [overview?.series, timeframe],
  );
  return { data, colors, timeframe, overview };
}

function CpuMemChart() {
  const { data, colors, timeframe } = useChartData();
  return (
    <Card>
      <CardHead title="CPU 与内存" hint="使用率随时间变化（%）" />
      {data.length < 2 ? (
        <Empty title="暂无历史点" hint="等下一次采样后就会出现曲线。" />
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={data} margin={{ top: 6, right: 6, left: -24, bottom: 0 }}>
            <defs>
              {/* 颜色跟着指标域走：CPU 蓝、内存紫 —— 和上面那张环形读数卡是同一支色 */}
              <linearGradient id="gradCpu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.cpu} stopOpacity={0.34} />
                <stop offset="100%" stopColor={colors.cpu} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradMem" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.mem} stopOpacity={0.3} />
                <stop offset="100%" stopColor={colors.mem} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
            {/* 阈值线：把"多少算高"画在图上，比只写在代码里有用 */}
            <ReferenceLine y={80} stroke={colors.warn} strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '80', position: 'right', fill: colors.faint, fontSize: 9 }} />
            <ReferenceLine y={92} stroke={colors.crit} strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: '92', position: 'right', fill: colors.faint, fontSize: 9 }} />
            <XAxis dataKey="time" tickFormatter={(t) => timeLabel(t, timeframe)} tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} />
            <YAxis domain={[0, 100]} tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip cursor={{ stroke: colors.faint, strokeDasharray: '3 3' }} content={<ChartTip unit={(v: number) => `${v.toFixed(1)}%`} labelFmt={(t: number) => new Date(t * 1000).toLocaleString('zh-CN')} />} />
            <Area type="monotone" dataKey="cpuPct" name="CPU" stroke={colors.cpu} strokeWidth={1.8} fill="url(#gradCpu)" />
            <Area type="monotone" dataKey="memPct" name="内存" stroke={colors.mem} strokeWidth={1.8} fill="url(#gradMem)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function IoChart() {
  const { data, colors, timeframe, overview } = useChartData();
  const ioAvailable = overview?.ioAvailable !== false && data.some((d) => d.readMb > 0 || d.writeMb > 0);

  const latest = data[data.length - 1];

  return (
    <Card>
      <CardHead
        title="硬盘 IO"
        hint={ioAvailable ? '读写速率（MB/s）' : '该节点未上报磁盘 IO，改用 iowait 观察等待时间'}
        right={
          latest ? (
            <div className="flex items-center gap-2 text-2xs">
              <span className="num text-ink">读 {latest.readMb.toFixed(1)}</span>
              <span className="num text-ink">写 {latest.writeMb.toFixed(1)}</span>
              <span className="text-faint">MB/s</span>
            </div>
          ) : null
        }
      />
      {data.length < 2 ? (
        <Empty title="暂无历史点" hint="采样后会显示 IO 曲线。" />
      ) : ioAvailable ? (
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={data} margin={{ top: 6, right: 6, left: -24, bottom: 0 }}>
            <defs>
              {/* 读 / 写用同一个存储域色，靠明度分两档 ——
                  同一件事的两个方向，不该看起来像两件不同的事 */}
              <linearGradient id="gradRead" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.store} stopOpacity={0.32} />
                <stop offset="100%" stopColor={colors.store} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradWrite" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.ioWrite} stopOpacity={0.28} />
                <stop offset="100%" stopColor={colors.ioWrite} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
            <XAxis dataKey="time" tickFormatter={(t) => timeLabel(t, timeframe)} tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} />
            <YAxis tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip cursor={{ stroke: colors.faint, strokeDasharray: '3 3' }} content={<ChartTip unit={(v: number) => `${v.toFixed(1)} MB/s`} />} />
            <Area type="monotone" dataKey="readMb" name="读" stroke={colors.store} strokeWidth={1.8} fill="url(#gradRead)" />
            <Area type="monotone" dataKey="writeMb" name="写" stroke={colors.ioWrite} strokeWidth={1.8} fill="url(#gradWrite)" />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <LineChart data={data} margin={{ top: 6, right: 6, left: -24, bottom: 0 }}>
            <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
            <XAxis dataKey="time" tickFormatter={(t) => timeLabel(t, timeframe)} tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={28} />
            <YAxis tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip cursor={{ stroke: colors.faint, strokeDasharray: '3 3' }} content={<ChartTip unit={(v: number) => `${v.toFixed(2)}%`} />} />
            <Line type="monotone" dataKey="iowait" name="iowait" stroke={colors.warn} strokeWidth={1.8} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════
   硬盘容量上涨趋势
   ══════════════════════════════════════════════════════════════════ */
function GrowthPanel() {
  const { overview, timeframe } = useMonitor();
  const colors = useChartColors();
  const data = useMemo(
    () =>
      (overview?.series ?? []).map((p) => ({
        time: p.time,
        rootGb: p.rootused / 1024 ** 3,
        totalGb: p.roottotal / 1024 ** 3,
        rootPct: p.roottotal ? (p.rootused / p.roottotal) * 100 : 0,
        label: timeLabel(p.time, timeframe),
      })),
    [overview?.series, timeframe],
  );

  /* 优先用服务端基于 1 周序列做的回归结果；拿不到再退回当前窗口的首尾差值 */
  const growth = useMemo(() => {
    const server = overview?.growth;
    const last = data[data.length - 1];
    if (server?.available && last) {
      const perDayGb = server.perDayBytes / 1024 ** 3;
      const freeGb = last.totalGb - last.rootGb;
      return { perDayGb, totalGb: last.totalGb, freeGb, daysLeft: server.daysLeft, spanDays: 7, source: 'server' as const };
    }
    if (data.length < 4) return null;
    const first = data[0];
    const days = (last.time - first.time) / 86400;
    if (days <= 0.01) return null;
    const perDayGb = (last.rootGb - first.rootGb) / days;
    const freeGb = last.totalGb - last.rootGb;
    const daysLeft = perDayGb > 0.0005 ? freeGb / perDayGb : null;
    return { perDayGb, totalGb: last.totalGb, freeGb, daysLeft, spanDays: days, source: 'local' as const };
  }, [data, overview?.growth]);

  return (
    <Card className="flex h-full flex-col">
      <CardHead
        title="硬盘容量上涨趋势"
        hint="按根分区已用空间随时间的斜率估算；数据写入、日志、快照都会抬高这条线"
        right={
          growth ? (
            <Badge tone={growth.daysLeft !== null && growth.daysLeft < 30 ? 'crit' : growth.daysLeft !== null && growth.daysLeft < 90 ? 'warn' : 'neutral'}>
              {growth.perDayGb >= 0 ? '↑' : '↓'} {Math.abs(growth.perDayGb).toFixed(2)} GB/天
            </Badge>
          ) : null
        }
      />

      {/* 这张卡现在与 Token 卡片并排、只占半栏：内部还是"图 + 指标"两列的话，
          曲线会被挤到两百多像素。改成上下堆叠 —— 图铺满半栏，三个指标在下面横排。
          曲线本身做成弹性的（flex-1 + 100% 高）：两张卡由栅格拉成等高，
          谁的自然高度高就由谁定行高，另一个的图长高补上，底下不会留白 */}
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex min-h-[190px] flex-1">
          {data.length < 4 ? (
            <Empty title="样本还不够" hint="切换到「1 周」或「1 月」可以拿到更长的历史曲线。" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
                <defs>
                  {/* 容量属于存储域：和根分区环形、IO 曲线同色 */}
                  <linearGradient id="gradRoot" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.store} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={colors.store} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
                <XAxis dataKey="time" tickFormatter={(t) => timeLabel(t, timeframe)} tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={30} />
                <YAxis domain={['dataMin - 2', 'dataMax + 2']} tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => `${Math.round(v)}G`} />
                <Tooltip cursor={{ stroke: colors.faint, strokeDasharray: '3 3' }} content={<ChartTip unit={(v: number) => `${v.toFixed(1)} GB`} />} />
                <Area type="monotone" dataKey="rootGb" name="已用容量" stroke={colors.store} strokeWidth={1.8} fill="url(#gradRoot)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Stat
            label="增长速率"
            value={growth ? `${growth.perDayGb >= 0 ? '+' : ''}${growth.perDayGb.toFixed(2)}` : '—'}
            unit="GB/天"
            tone={growth && growth.perDayGb > 1 ? 'warn' : 'neutral'}
            hint={
              growth
                ? growth.source === 'server'
                  ? '近 7 天线性回归'
                  : `基于当前窗口的 ${growth.spanDays.toFixed(1)} 天`
                : '样本不足'
            }
          />
          <Stat
            label="预计可用"
            value={growth?.daysLeft != null ? Math.floor(growth.daysLeft) : '—'}
            unit="天"
            tone={growth?.daysLeft != null && growth.daysLeft < 30 ? 'crit' : growth?.daysLeft != null && growth.daysLeft < 90 ? 'warn' : 'ok'}
            hint={
              growth
                ? `剩余 ${growth.freeGb.toFixed(1)} GB / 共 ${growth.totalGb.toFixed(0)} GB`
                : '按当前写入速度推算'
            }
          />
          <div className="rounded-field bg-bg-2 px-4 py-3">
            <p className="text-2xs text-faint">当前占用</p>
            <p className="num mt-0.5 text-[19px] font-medium">{data.length ? data[data.length - 1].rootPct.toFixed(1) : '—'}%</p>
            <Meter
              ratio={data.length ? data[data.length - 1].rootPct / 100 : 0}
              tone={toneByRatio(data.length ? data[data.length - 1].rootPct / 100 : 0, 0.8, 0.92)}
              className="mt-2"
            />
            <p className="mt-1.5 text-2xs leading-tight text-faint">
              {growth?.daysLeft != null && growth.daysLeft < 90
                ? '建议提前清理快照或扩容，别等到写满。'
                : '按当前趋势，短期内不需要扩容。'}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Token 消耗
   ══════════════════════════════════════════════════════════════════ */

/**
 * 全站大模型 token 消耗。
 *
 * 版面借的是一张参考图：左"今日"、右"累计"，各一个大数；今日下面压一条进度条；
 * 底部一行按用途拆开的小字。改动的是两组数字的**含义**——
 *
 * 进度条的分母用「近 30 天最高的一天」，不是"预算"：预算得由人来定，
 * 而这台机器上没人定过。用历史峰值当基准不需要任何配置，回答的还是同一个
 * 问题："今天是不是异常高的一天"。只有历史上有过别的日子才可能报黄 ——
 * 库刚建起来的第一天，today 必然等于 peak，那不是异常。
 */
function TokenPanel() {
  const usage = useAiUsage();
  const colors = useChartColors();

  /* 14 天柱状图。日期由服务端给（见 usageSnapshot 的 series），
     前端只做展示映射，不自己推日期 */
  const series = useMemo(
    () => (usage?.series ?? []).map((d) => ({ label: d.key.slice(5), tokens: usedTokens(d) })),
    [usage?.series],
  );

  if (!usage) {
    return (
      <Card>
        <CardHead title="Token 消耗" hint="全站大模型调用。数字取自上游返回的 usage，不是估算" />
        <Skeleton className="h-28" />
      </Card>
    );
  }

  const today = usedTokens(usage.today);
  const total = usedTokens(usage.total);
  const yesterday = usedTokens(usage.yesterday);
  const days = Object.keys(usage.days).sort().slice(-30);
  const peak = Math.max(today, ...days.map((k) => usedTokens(usage.days[k])));
  const record = days.length >= 2 && today > 0 && today >= peak;
  const delta = yesterday > 0 ? ((today - yesterday) / yesterday) * 100 : null;
  /* 输入里绝大部分是 agent 的固定脚手架加上正文，输出只是那一小截答复。
     把两者并排摆出来，比单说"一共花了多少"更能说明钱花在哪儿 */
  const outShare = usage.today.prompt > 0 ? (usage.today.completion / usage.today.prompt) * 100 : 0;
  const sources = Object.entries(usage.sources).sort((a, b) => usedTokens(b[1]) - usedTokens(a[1]));

  return (
    /* h-full：与旁边那张一起被栅格拉成等高，不留白 */
    <Card className="flex h-full flex-col">
      <CardHead
        title="Token 消耗"
        hint="全站大模型调用。数字取自上游返回的 usage，不是估算"
        right={<Badge tone="neutral">今日 {usage.today.calls} 次调用</Badge>}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-2xs text-muted">今日消耗 Token</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
            <span className="num text-[26px] font-semibold leading-none tracking-display text-ink">{fmtTokens(today)}</span>
            <span className="num text-2xs text-faint">/ 近 30 天峰值 {fmtTokens(peak)}</span>
          </p>
          <Meter ratio={peak > 0 ? today / peak : 0} tone={record ? 'warn' : 'accent'} className="mt-3" />
        </div>

        <div>
          <p className="text-2xs text-muted">其中输出 Token</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
            <span className="num text-[26px] font-semibold leading-none tracking-display text-ink">
              {usage.today.completion.toLocaleString('zh-CN')}
            </span>
            <span className="num text-2xs text-faint">
              / 占输入 {outShare < 1 ? outShare.toFixed(2) : outShare.toFixed(1)}%
            </span>
          </p>
          <p className="mt-3 text-2xs leading-relaxed text-faint">
            {delta === null
              ? '昨天没有调用，无法比较'
              : `较昨日 ${delta >= 0 ? '+' : ''}${Math.abs(delta) < 1 ? '0' : delta.toFixed(0)}%`}
            {record ? ' · 是近 30 天最高的一天' : ''}
          </p>
        </div>
      </div>

      {/* 柱状图同时干两件事：说清"哪几天在猛用"，以及把这半栏剩下的高度填上 ——
          上一版内容比旁边的容量卡短一截，卡片底部空着一块 */}
      <div className="mt-5 flex min-h-[186px] flex-1 flex-col">
        <p className="mb-1.5 text-2xs text-faint">近 14 天用量</p>
        {/* min-h-0：弹性的 grid/柱状图容器里，子项默认 min-height:auto 会撑着不缩，
            高度算不准 */}
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={12} />
              <YAxis
                tick={{ fill: colors.faint, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={54}
                tickFormatter={(v: number) => fmtTokens(v)}
              />
              <Tooltip
                cursor={{ fill: colors.line, fillOpacity: 0.35 }}
                content={<ChartTip unit={(v: number) => `${v.toLocaleString('zh-CN')} tokens`} />}
              />
              {/* 实心柱用 colors.bar（冷色主档）而不是琥珀：柱体面积远大于一条曲线，
                  用告警色填满等于让人一直在看一片"警告" */}
              <Bar dataKey="tokens" name="用量" fill={colors.bar} radius={[3, 3, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 底部小字按用途拆开。这个端点单次调用的 prompt 里约有一万五是 agent 的
          固定脚手架，与问题长短无关 —— 所以"谁在花"比"花了多少"更说明问题 */}
      <div className="mt-4 space-y-1.5 border-t border-line pt-3.5">
        <p className="text-2xs leading-relaxed text-faint">
          累计 {fmtTokens(total)} · 共 {usage.total.calls} 次调用
          {sources.length
            ? ` · ${sources.map(([k, v]) => `${usage.labels[k] ?? k} ${fmtTokens(usedTokens(v))}`).join(' · ')}`
            : ' · 还没有调用记录'}
        </p>
      </div>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════
   温度
   ══════════════════════════════════════════════════════════════════ */
function ThermalPanel() {
  const { overview } = useMonitor();
  const temps = overview?.sensors?.temperatures ?? [];
  const powerSensors = overview?.sensors?.power ?? [];

  const cpuTemps = temps.filter((t) => t.kind === 'cpu');
  // 主板（acpitz 等）单独成组：以前它没被排除，会掉进「其它温度点」里，
  // 和网卡之类混在一起，看不出哪条才是主板。
  const boardTemps = temps.filter((t) => t.kind === 'board');
  const diskTemps = temps.filter((t) => t.kind === 'disk');
  const otherTemps = temps.filter((t) => t.kind !== 'cpu' && t.kind !== 'board' && t.kind !== 'disk');
  const hottest = temps.reduce<{ name: string; value: number } | null>((acc, t) => (!acc || t.value > acc.value ? t : acc), null);

  const tempTone = (v: number) => (v >= 80 ? 'crit' : v >= 65 ? 'warn' : 'ok');

  return (
    <Card>
      <CardHead
        title="温度"
        hint={`${temps.length} 个温度点${powerSensors.length ? ` · ${powerSensors.length} 个功率读数` : ''}`}
        right={
          hottest ? (
            <Badge tone={tempTone(hottest.value)}>
              最高 {Math.round(hottest.value)}°C · {hottest.name}
            </Badge>
          ) : null
        }
      />

      {temps.length === 0 ? (
        <Empty
          icon={<Thermometer size={20} />}
          title="没有读到温度数据"
          hint="需要在 PVE 节点上安装 lm-sensors 并执行 sensors-detect，节点才会上报温度指标。"
        />
      ) : (
        <div className={cls('grid gap-4', otherTemps.length ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
          <SensorGroup
            title="CPU 温度"
            icon={<Cpu size={13} />}
            items={cpuTemps}
            scale={100}
            unit="°C"
            tone={(v) => tempTone(v)}
          />
          <SensorGroup
            title="硬盘温度"
            icon={<HardDrive size={13} />}
            items={diskTemps}
            scale={70}
            unit="°C"
            tone={(v) => (v >= 55 ? 'crit' : v >= 45 ? 'warn' : 'ok')}
          />
          {/* 主板走单独一套阈值：ACPI 热区普遍比 CPU 低一截，
              套 CPU 的 65/80 会让它永远停在"正常"档，失去告警意义 */}
          <SensorGroup
            title="主板温度"
            icon={<CircuitBoard size={13} />}
            items={boardTemps}
            scale={100}
            unit="°C"
            tone={(v) => (v >= 75 ? 'crit' : v >= 60 ? 'warn' : 'ok')}
          />
          {otherTemps.length ? (
            <SensorGroup title="其它温度点" icon={<Thermometer size={13} />} items={otherTemps} scale={100} unit="°C" tone={(v) => tempTone(v)} />
          ) : null}
        </div>
      )}

      {powerSensors.length ? (
        <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <span className="text-2xs text-faint">传感器功率读数</span>
          {powerSensors.map((p) => (
            <Badge key={`${p.chip}-${p.name}`} tone="accent">
              {p.name} {Math.round(p.value)} W
            </Badge>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function SensorGroup({
  title,
  icon,
  items,
  scale,
  unit,
  tone,
}: {
  title: string;
  icon: ReactNode;
  items: { name: string; value: number; chip?: string }[];
  scale: number;
  unit: string;
  tone: (v: number) => 'ok' | 'warn' | 'crit' | 'signal';
}) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-2xs font-medium text-muted">
        {icon}
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-2xs text-faint">未探测到</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => (
            <li key={`${item.chip}-${item.name}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-muted" title={item.name}>
                  {item.name}
                </span>
                <span className="num shrink-0 text-[13px] font-medium">
                  {Math.round(item.value * 10) / 10}
                  <span className="ml-0.5 text-2xs text-faint">{unit}</span>
                </span>
              </div>
              <Meter ratio={item.value / scale} tone={tone(item.value)} className="mt-1.5" height={3} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── 网卡流量 ──────────────────────────────────────────────────────────
   上半曲线、下半逐网卡明细，刻意用**两个数据源**，因为单一来源做不到两件事：
     · 曲线走 PVE 的 RRD（netin/netout）——只有它带跨时间窗的历史序列，
       1 小时/1 天/1 周/1 月都画得出来；
     · 明细走母机 /proc/net/dev（server/services/net.js）——RRD 只有节点合计，
       分不到具体哪块口，也拿不到错包丢包。

   两条路口径不同：RRD 的节点合计含虚拟机流量与内部转发，自采只算物理口
   与聚合口。实测这台机器 RRD 报 ~23 KB/s、自采物理口 ~6 KB/s，差的就是
   虚拟机与内部转发的部分。所以卡上写明"两者不相等"，免得看着像对不上。
   自采速率靠前后两次采样求差，首次进来只有累计值、速率显示"—"。
   lo 与每台虚拟机的 tap/fwbr/fwln/fwpr 口已在服务端过滤掉。 */
function NetTrafficCard() {
  const { data, colors, timeframe, overview } = useChartData();
  const net = overview?.net;
  const list = net?.interfaces ?? [];
  const latest = data[data.length - 1];
  const hasHistory = data.some((d) => d.netinKb > 0 || d.netoutKb > 0);

  if (!net || !net.available) {
    return (
      <Card>
        <CardHead title="网卡流量" hint="经 SSH 读取母机 /proc/net/dev" />
        <Empty
          icon={<Network size={20} />}
          title="读不到网卡计数器"
          hint={net?.error ?? '需要配置 PVE 地址，且允许本机免密 SSH。'}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHead
        title="网卡流量"
        hint={hasHistory ? '节点收发速率（KB/s），随页面上方的时间窗变化' : '该节点暂未上报流量历史'}
        right={
          latest ? (
            <div className="flex items-center gap-2 text-2xs">
              <span className="num text-ink">收 {latest.netinKb.toFixed(1)}</span>
              <span className="num text-ink">发 {latest.netoutKb.toFixed(1)}</span>
              <span className="text-faint">KB/s</span>
            </div>
          ) : null
        }
      />
      {data.length < 2 ? (
        <Empty title="暂无历史点" hint="采样后会显示流量曲线。" />
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={data} margin={{ top: 6, right: 6, left: -24, bottom: 0 }}>
            <defs>
              {/* 收 / 发同属网络域，靠明度分两档（同 IO 那张的处理） */}
              <linearGradient id="gradNetIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.net} stopOpacity={0.32} />
                <stop offset="100%" stopColor={colors.net} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gradNetOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.netTx} stopOpacity={0.28} />
                <stop offset="100%" stopColor={colors.netTx} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={colors.line} strokeDasharray={GRID_DASH} strokeOpacity={0.55} vertical={false} />
            <XAxis
              dataKey="time"
              tickFormatter={(t) => timeLabel(t, timeframe)}
              tick={{ fill: colors.faint, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis tick={{ fill: colors.faint, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip cursor={{ stroke: colors.faint, strokeDasharray: '3 3' }} content={<ChartTip unit={(v: number) => `${v.toFixed(1)} KB/s`} />} />
            <Area type="monotone" dataKey="netinKb" name="接收" stroke={colors.net} strokeWidth={1.8} fill="url(#gradNetIn)" />
            <Area type="monotone" dataKey="netoutKb" name="发送" stroke={colors.netTx} strokeWidth={1.8} fill="url(#gradNetOut)" />
          </AreaChart>
        </ResponsiveContainer>
      )}

      <p className="mt-4 mb-2 text-2xs font-medium text-muted">逐网卡（自采计数）</p>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-xs">
          <thead>
            <tr className="text-left text-2xs text-faint">
              <th className="px-1 pb-2 font-normal">接口</th>
              <th className="px-1 pb-2 font-normal">类型</th>
              <th className="px-1 pb-2 text-right font-normal">接收速率</th>
              <th className="px-1 pb-2 text-right font-normal">发送速率</th>
              <th className="px-1 pb-2 text-right font-normal">累计接收</th>
              <th className="px-1 pb-2 text-right font-normal">累计发送</th>
              <th className="px-1 pb-2 text-right font-normal">错包 / 丢包</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--line)]">
            {list.map((n) => {
              const errors = n.rxErrs + n.txErrs;
              const drops = n.rxDrop + n.txDrop;
              return (
                <tr key={n.iface} className="align-middle">
                  <td className="num px-1 py-2">{n.iface}</td>
                  <td className="px-1 py-2">
                    <Badge>{KIND_LABEL[n.kind] ?? n.kind}</Badge>
                  </td>
                  <td className="num px-1 py-2 text-right">{fmtRate(n.rxRate)}</td>
                  <td className="num px-1 py-2 text-right">{fmtRate(n.txRate)}</td>
                  <td className="num px-1 py-2 text-right text-muted">{fmtBytes(n.rxBytes)}</td>
                  <td className="num px-1 py-2 text-right text-muted">{fmtBytes(n.txBytes)}</td>
                  <td className={cls('num px-1 py-2 text-right', errors || drops ? 'text-warn' : 'text-faint')}>
                    {errors} / {drops}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-2xs leading-relaxed text-faint">
        曲线是 PVE 给的节点合计，含虚拟机流量与内部转发；下表是自采的逐网卡计数，只算物理口与聚合口。
        两者口径不同，数值不会相等——要看"这台机器总共跑了多少流量"看曲线，要看"哪块口在跑"看下表。
      </p>
    </Card>
  );
}

const KIND_LABEL: Record<string, string> = {
  physical: '物理',
  bond: '聚合',
  bridge: '桥接',
  vlan: 'VLAN',
  other: '其他',
};

/* ── 硬盘 SMART 健康详情 ──────────────────────────────────────────────
   上面那张表只放得下型号/容量/温度。健康度、通电时长、异常断电、累计读写
   这些都在 smartctl 里，单独开一张卡铺开。
   数据来自母机上的 `smartctl -a -j`（见 server/services/smart.js）——
   PVE 自带的 disks/smart 接口并不提供这些字段。
   SSH 不通或没装 smartctl 时这里如实说明原因，不拿估算值顶上。 */
function DiskHealthPanel() {
  const { overview } = useMonitor();
  const health = overview?.diskHealth;
  const disks = health?.disks ?? [];

  if (!health || (!health.available && !disks.length)) {
    return (
      <Card>
        <CardHead title="硬盘健康（SMART）" hint="经 SSH 读取母机 smartctl" />
        <Empty
          icon={<HardDrive size={20} />}
          title="读不到 SMART 健康数据"
          hint={health?.error ?? '需要配置 PVE 地址，且母机上装有 smartctl、允许本机免密 SSH。'}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHead
        title="硬盘健康（SMART）"
        hint={`${disks.length} 块盘 · 经 SSH 读取母机 smartctl，3 小时刷新一次`}
      />
      <div className="space-y-6">
        {disks.map((d) => (
          <DiskHealthBlock key={d.dev} disk={d} />
        ))}
      </div>
    </Card>
  );
}

function DiskHealthBlock({ disk: d }: { disk: DiskHealth }) {
  if (!d.available) {
    return (
      <div className="border-t border-[color:var(--line)] pt-5 first:border-t-0 first:pt-0">
        <p className="num text-xs">{d.dev}</p>
        <p className="mt-1 text-2xs text-warn">{d.error ?? '这块盘没读到 SMART 数据'}</p>
      </div>
    );
  }

  const passed = d.passed;
  const shutdownRatio =
    d.unsafeShutdowns != null && d.powerCycles ? d.unsafeShutdowns / d.powerCycles : null;

  return (
    <div className="border-t border-[color:var(--line)] pt-5 first:border-t-0 first:pt-0">
      {/* 身份行：型号 + 序列号 + 固件，排查替换盘时靠这些定位 */}
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="num truncate text-sm font-semibold">{d.model ?? d.dev}</p>
          <p className="num mt-0.5 text-2xs text-faint">
            {d.dev}
            {d.serial ? ` · SN ${d.serial}` : ''}
            {d.firmware ? ` · FW ${d.firmware}` : ''}
            {d.capacityBytes ? ` · ${fmtSmartBytes(d.capacityBytes)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {d.kind ? <Badge>{d.kind === 'nvme' ? 'NVMe' : d.kind === 'ata' ? 'SATA/ATA' : d.kind}</Badge> : null}
          {d.nvmeVersion ? <Badge tone="neutral">NVMe {d.nvmeVersion}</Badge> : null}
          {passed != null ? (
            <Badge tone={passed ? 'ok' : 'crit'} dot>
              {passed ? 'SMART 通过' : 'SMART 告警'}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* 四个主指标：健康 / 异常断电 / 累计读写 / 通电 —— 这块盘最该被看见的数 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KeyMetric
          label="健康"
          value={d.healthPercent == null ? '—' : `${d.healthPercent}%`}
          hint={d.wearPercent != null ? `已磨损 ${d.wearPercent}%` : '该盘未提供磨损属性'}
          tone={healthTone(d.healthPercent)}
          meter={d.healthPercent == null ? null : d.healthPercent / 100}
        />
        <KeyMetric
          label="异常断电"
          value={d.unsafeShutdowns == null ? '—' : String(d.unsafeShutdowns)}
          hint={
            shutdownRatio != null
              ? `占通电次数 ${(shutdownRatio * 100).toFixed(1)}%`
              : '非正常掉电的累计次数'
          }
          tone={d.unsafeShutdowns ? 'warn' : 'ok'}
        />
        <KeyMetric
          label="累计读 / 写"
          value={`${fmtSmartBytes(d.readBytes)} / ${fmtSmartBytes(d.writeBytes)}`}
          hint={d.perDayWriteBytes ? `按通电时长折合每日写入 ${fmtSmartBytes(d.perDayWriteBytes)}` : 'SMART 记录的主机写入总量'}
        />
        <KeyMetric
          label="通电"
          value={d.powerOnHours == null ? '—' : `${d.powerOnHours} 时`}
          hint={
            d.powerOnHours
              ? `约 ${Math.floor(d.powerOnHours / 24)} 天 · 通断电 ${d.powerCycles ?? '—'} 次`
              : '累计通电时长'
          }
        />
      </div>

      {/* 其余字段铺开：能拿到的都列出来，没有的显示 — 而不是编一个 */}
      <div className="mt-4 grid gap-x-8 gap-y-0 sm:grid-cols-2">
        <Detail label="当前温度" value={fmtTemp(d.temperature?.current)} tone={tempTone(d.temperature?.current, d.temperature?.opLimit)} hint="SMART 上报温度" />
        <Detail label="温度阈值" value={tempLimitText(d.temperature)} hint="工作上限 / 临界上限" />
        {d.temperature?.sensors?.length ? (
          <Detail label="温度传感器" value={d.temperature.sensors.map((t) => `${t}°C`).join(' / ')} hint="盘上多个测温点" />
        ) : null}
        <Detail label="可用备用空间" value={d.spare?.available == null ? '—' : `${d.spare.available}%${d.spare.threshold != null ? `（阈值 ${d.spare.threshold}%）` : ''}`} hint="低于阈值会触发 critical warning" />
        <Detail label="媒体错误" value={d.mediaErrors == null ? '—' : String(d.mediaErrors)} tone={d.mediaErrors ? 'crit' : undefined} hint="不可恢复的介质错误数" />
        <Detail label="错误日志条目" value={d.errorLogEntries == null ? '—' : String(d.errorLogEntries)} hint="NVMe 错误日志里的条目数，含已恢复的" />
        <Detail label="主机读 / 写命令" value={d.hostReads == null && d.hostWrites == null ? '—' : `${fmtCount(d.hostReads)} / ${fmtCount(d.hostWrites)}`} hint="主机下发的读写命令计数" />
        <Detail label="控制器忙碌时间" value={d.controllerBusyMinutes == null ? '—' : `${d.controllerBusyMinutes} 分`} hint="控制器处于忙碌状态的累计时长" />
        <Detail label="过温时间" value={d.tempWarningMinutes == null && d.tempCriticalMinutes == null ? '—' : `${d.tempWarningMinutes ?? 0} / ${d.tempCriticalMinutes ?? 0} 分`} hint="警告温度 / 临界温度下的累计时长" />
        {d.reallocatedSectors != null ? (
          <Detail label="重映射扇区" value={String(d.reallocatedSectors)} tone={d.reallocatedSectors ? 'crit' : undefined} hint="已替换的坏扇区数，增长即盘在退化" />
        ) : null}
        {d.namespaces != null ? <Detail label="命名空间" value={String(d.namespaces)} /> : null}
        {d.selfTest ? <Detail label="自检状态" value={d.selfTest} /> : null}
        <Detail
          label="剩余寿命（按当前速度）"
          value={d.lifeRemainingHours == null ? '—' : fmtRemaining(d.lifeRemainingHours)}
          hint="按已磨损比例对通电时长线性外推，仅作量级参考——写入强度会变，新盘外推值往往大得没有意义"
        />
        <Detail label="SMART 支持 / 启用" value={`${d.smartSupport ? '是' : '否'} / ${d.smartEnabled ? '是' : '否'}`} />
      </div>

      {/* critical warning 是位掩码，逐位解码后给人话，不是一个数字摆在那 */}
      {d.criticalWarning?.flags?.length ? (
        <p className="mt-3 rounded-field bg-crit-soft px-3 py-2 text-2xs text-crit">
          设备告警：{d.criticalWarning.flags.join('、')}（原始值 {d.criticalWarning.raw}）
        </p>
      ) : null}

      {/* ATA 盘的属性表信息量大，默认收起 */}
      {d.attrs?.length ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-2xs text-faint hover:text-muted">
            SMART 属性表（{d.attrs.length} 项）
          </summary>
          <div className="mt-2 -mx-1 overflow-x-auto">
            <table className="w-full min-w-[440px] border-collapse text-2xs">
              <thead>
                <tr className="text-left text-faint">
                  <th className="px-1 pb-1 font-normal">ID</th>
                  <th className="px-1 pb-1 font-normal">名称</th>
                  <th className="px-1 pb-1 text-right font-normal">当前</th>
                  <th className="px-1 pb-1 text-right font-normal">最差</th>
                  <th className="px-1 pb-1 text-right font-normal">阈值</th>
                  <th className="px-1 pb-1 text-right font-normal">原始值</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--line)]">
                {d.attrs.map((a) => (
                  <tr key={a.id ?? a.name}>
                    <td className="num px-1 py-1">{a.id ?? '—'}</td>
                    <td className="px-1 py-1 text-muted">{a.name}</td>
                    <td className="num px-1 py-1 text-right">{a.value ?? '—'}</td>
                    <td className="num px-1 py-1 text-right">{a.worst ?? '—'}</td>
                    <td className="num px-1 py-1 text-right">{a.thresh ?? '—'}</td>
                    <td className={cls('num px-1 py-1 text-right', a.failed ? 'text-crit' : '')} title={a.rawString ?? undefined}>
                      {a.raw ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function KeyMetric({
  label,
  value,
  hint,
  tone = 'neutral',
  meter,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'crit';
  meter?: number | null;
}) {
  const valueClass = { neutral: 'text-ink', ok: 'text-ok', warn: 'text-warn', crit: 'text-crit' }[tone];
  return (
    <div className="rounded-field bg-bg-2 px-3 py-2.5">
      <p className="text-2xs text-faint">{label}</p>
      <p className={cls('num mt-0.5 text-base font-semibold leading-tight', valueClass)}>{value}</p>
      {meter != null ? (
        <Meter ratio={meter} tone={tone === 'neutral' ? 'accent' : tone} className="mt-2" height={3} />
      ) : null}
      {hint ? <p className="mt-1 text-2xs leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}

function Detail({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warn' | 'crit';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--line)] py-1.5 last:border-b-0">
      <span className="shrink-0 text-2xs text-faint" title={hint}>
        {label}
      </span>
      <span className={cls('num truncate text-2xs text-muted', tone === 'warn' && 'text-warn', tone === 'crit' && 'text-crit')}>
        {value}
      </span>
    </div>
  );
}

/**
 * SMART 的 data units 与厂商标称容量都是十进制，必须按 1000 换算。
 * 用项目里那个 1024 进制的 fmtBytes 会把 4.80 TB 显示成 4.37，
 * 与盘上标称、与 SMART 原始计数都对不上。
 */
function fmtSmartBytes(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let x = n;
  let i = 0;
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000;
    i += 1;
  }
  return `${x.toFixed(x >= 100 ? 1 : 2)} ${units[i]}`;
}

function fmtCount(v: number | null | undefined): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
}

function fmtTemp(t: number | null | undefined): string {
  return t == null ? '—' : `${t}°C`;
}

/**
 * 剩余寿命按量级挑单位。新盘的线性外推动辄几万天（这块盘外推出来是 58 年），
 * 写「21412 天」没人读得出量级，所以超过两年就改说年。
 */
function fmtRemaining(hours: number): string {
  const days = hours / 24;
  if (days >= 730) return `约 ${(days / 365).toFixed(1)} 年`;
  if (days >= 1) return `约 ${Math.floor(days)} 天`;
  return `约 ${Math.floor(hours)} 小时`;
}

function tempLimitText(t: DiskHealth['temperature']): string {
  if (!t) return '—';
  if (t.opLimit == null && t.criticalLimit == null) return '—';
  return `${t.opLimit ?? '—'}°C / ${t.criticalLimit ?? '—'}°C`;
}

function tempTone(t: number | null | undefined, limit: number | null | undefined): 'warn' | 'crit' | undefined {
  if (t == null) return undefined;
  if (limit != null && t >= limit) return 'crit';
  if (t >= 60) return 'crit';
  if (t >= 50) return 'warn';
  return undefined;
}

function healthTone(pct: number | null | undefined): 'neutral' | 'ok' | 'warn' | 'crit' {
  if (pct == null) return 'neutral';
  if (pct >= 80) return 'ok';
  if (pct >= 50) return 'warn';
  return 'crit';
}

function GuestTable() {
  const { overview, loading, lastUpdated } = useMonitor();
  const guests = useMemo(() => {
    const q = (overview?.guests?.qemu ?? []).map((g) => ({ ...g, kind: 'VM' }));
    const l = (overview?.guests?.lxc ?? []).map((g) => ({ ...g, kind: 'CT' }));
    return [...q, ...l].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.vmid - b.vmid);
  }, [overview?.guests]);

  const running = guests.filter((g) => g.status === 'running').length;
  const templates = overview?.templateCount ?? 0;

  return (
    <Card>
      <CardHead
        title="虚拟机与容器"
        hint={`运行中 ${running} / 共 ${guests.length}${templates ? ` · 已排除 ${templates} 个模板` : ''}`}
      />
      {guests.length === 0 ? (
        <Empty icon={<Server size={20} />} title="没有读到来宾列表" hint="需要 API Token 具备 VM.Audit 权限。" />
      ) : (
        <div className="-mx-1 max-h-[22rem] overflow-auto">
          <table className="w-full min-w-[420px] border-collapse text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-left text-2xs text-faint">
                <th className="px-1 pb-2 font-normal">ID</th>
                <th className="px-1 pb-2 font-normal">名称</th>
                <th className="px-1 pb-2 text-right font-normal">CPU</th>
                <th className="px-1 pb-2 text-right font-normal">内存</th>
                <th className="px-1 pb-2 text-right font-normal">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {guests.map((g) => (
                <tr key={`${g.kind}-${g.vmid}`}>
                  <td className="num px-1 py-2 text-faint">{g.vmid}</td>
                  <td className="max-w-[10rem] truncate px-1 py-2">
                    {g.name}
                    <span className="ml-1.5 text-2xs text-faint">{g.kind}</span>
                  </td>
                  <td className="num px-1 py-2 text-right">{g.status === 'running' ? `${(g.cpu * 100).toFixed(1)}%` : '—'}</td>
                  <td className="num px-1 py-2 text-right">
                    {g.status === 'running' ? `${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}` : '—'}
                  </td>
                  <td className="px-1 py-2 text-right">
                    <Badge tone={g.status === 'running' ? 'ok' : 'neutral'} dot>
                      {g.status === 'running' ? '运行' : '停止'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-2xs text-faint">
        <ToneLed tone="ok" label="运行" />
        <ToneLed tone="neutral" label="停止" />
        <span className="num ml-auto">
          {loading ? '刷新中…' : lastUpdated ? `更新于 ${new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
        </span>
      </div>
    </Card>
  );
}
