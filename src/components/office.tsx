import type { ReactNode } from 'react';
import { Activity, AlertTriangle, CalendarClock, MessagesSquare, Star } from 'lucide-react';
import { type OfficeBoard, type OfficeEmployee, type OfficeRoster, type OfficeSession, type OfficeUsage } from '@/lib/api';
import { cls, fmtDuration, fmtRelative } from '@/lib/format';
import { gatewaySourceLabel } from '@/lib/ai-usage';
import { Badge, Card, CardHead, Empty, Led, Meter, Skeleton, useCountUp } from '@/components/ui';

/* ────────────────────────────────────────────────────────────────────────
 * 智能办公室 · 页面零件（中间工位墙 + 办公设施 + 两侧边栏里那三块）
 * ────────────────────────────────────────────────────────────────────────
 * 这一页装两件不同性质的东西：
 *   · **工位**（三列的正中间）：每位员工一个办公桌场景，点开看详情。这是"人"。
 *     它正下方还钉着一条**办公设施**（茶水间 / 健身角 / 洗手间）。
 *   · **两侧边栏**：左栏本月之星（钉在最上面）+ 对话明细，右栏今日消耗 Token
 *     + 全局待办工作表。这是"事"。
 * 两边数据来自同一个网关的不同接口，各自会失败，所以三块各自报自己的错 ——
 * 一块读不到不该把整页拖黑（工位状态是免登录的，口令没配时它照样是好的）。
 *
 * 点开工位后那个带页签的详情弹窗在 components/seat-detail.tsx ——
 * 它自带一整页页签内容，跟这里的版面零件不是一回事，分开放更好找。
 * ──────────────────────────────────────────────────────────────────────── */

/** token 以"万"为单位。网关自己也是这么显示的（16.60万 / 1000万），跟着它的口径 */
const wan = (n: number | null | undefined) => `${((Number(n) || 0) / 10000).toFixed(2)}万`;

/** 网关的时间戳是 unix 秒（可能带小数），不是毫秒也不是 ISO 串 */
const at = (sec: number | null | undefined) => (Number.isFinite(Number(sec)) ? Number(sec) * 1000 : null);

/** 会话来源的人话名。来源是网关给的标识：cli / weixin / cron / api_server */
const SOURCE_LABEL: Record<string, string> = {
  cli: '命令行',
  cron: '定时任务',
  weixin: '微信',
  api_server: '接口',
};

const sourceLabel = (s: string) => SOURCE_LABEL[s] || s || '未知';

/* ── 工位场景 ──────────────────────────────────────────────────────────
 * 一个工位长这样（照着一张参考图定的构图）：
 *
 *        ● 白饭                  ← 显示器上方悬浮的名牌（带状态点）
 *    ┌──────────────┐  ┌──────┐
 *    │   显示器背壳   │  │ 工牌  │  ← 右上角一张小卡：工位号 + 在线
 *    └──┬───────────┘  └──────┘
 *  ─────┴───────────────────────    ← 桌面（一条圆头横杆 + 显示器的浅槽）
 *    │        ┌──┐            ▟█▙   ← 办公椅；右边站着本人（立绘）
 *    │        │  │         ( 立绘 )  ● ← 桌角那颗圆钮：打开详情
 *  ──┴────────┴──┴───────────────   ← 地面柔影
 *
 * 尺寸上的一点讲究：viewBox 取 100×65 配 aspect-[3/2]，于是 1 个单位在两个
 * 方向上都换算成约 3px（300×200 的卡）—— 圆角、描边粗细不会被拉成椭圆。
 * preserveAspectRatio="none" 让坐标直接等于百分比，叠在上面的 HTML
 * （名牌、工牌、圆钮）用同一套百分比定位，对位不用换算。
 *
 * 立绘是**透明抠图**（PNG 带 alpha），所以人能真的"站"在桌边；它在最上层，
 * 压住桌子的右端 —— 和参考图里"人站在桌边、探身过来"的层次一致。
 * ──────────────────────────────────────────────────────────────────────── */

const v = (name: string, alpha = 1) => `rgb(var(--${name}-rgb) / ${alpha})`;

/**
 * 家具：桌腿、桌面、显示器、椅子。
 *
 * 描边用 office-edge 而不是 line：办公室里这些是浅色家具，界面的 line
 * 在浅色主题下几乎是白的，用它描边等于没描。
 */
function Furniture({ occupied }: { occupied: boolean }) {
  return (
    <svg viewBox="0 0 100 65" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
      {/* 桌腿（先画，一头被桌面压住） */}
      <rect x="13" y="29.5" width="3.2" height="28.5" rx="1.6" style={{ fill: v('office-furniture-2') }} />
      <rect x="45.4" y="29.5" width="3.2" height="28.5" rx="1.6" style={{ fill: v('office-furniture-2') }} />

      {/* 桌面：一条圆头横杆 + 显示器正下方那道浅槽 */}
      <rect
        x="6.5"
        y="25.4"
        width="87"
        height="4.3"
        rx="2.15"
        style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.4 }}
      />
      <rect x="37" y="26.3" width="24" height="2.5" rx="1.25" style={{ fill: v('office-furniture-2', 0.85) }} />
      {/* 桌沿下的一道浅影：没有它，桌子会像贴上去的一条白杠 */}
      <rect x="9" y="29.7" width="82" height="1.1" rx="0.55" style={{ fill: v('office-furniture-2', 0.55) }} />

      {/* 显示器：立柱 + 底座 + 屏体（背面对着我们） */}
      <rect x="48.4" y="25.6" width="3.2" height="3.9" style={{ fill: v('office-furniture-2') }} />
      <rect x="41.5" y="29" width="17" height="1.7" rx="0.85" style={{ fill: v('office-furniture-2') }} />
      {/* 屏体：顶端定在 9.2 而不是 7.4，是给上面那块名牌留位子。
          名牌是 HTML（高度写死 17px，不随卡片缩放），屏幕顶端却跟着卡片等比
          缩放 —— 卡片一窄（三列时约 200~260px），两者就会叠在一起。往下让出
          1.8 个单位之后，从 200px 到 400px 宽的卡片都不再重叠。 */}
      <rect
        x="31.5"
        y="9.2"
        width="37"
        height="16.8"
        rx="2"
        /* 没人的工位把屏幕压成一块灰玻璃：一眼能看出"这台没开" */
        style={{ fill: occupied ? v('office-screen') : v('office-screen-dim') }}
      />
      {/* 屏体上的一点反光，免得背壳是一整块死色 */}
      <rect x="33.4" y="10.9" width="33.2" height="13.4" rx="1.2" style={{ fill: 'rgb(255 255 255 / 0.06)' }} />

      {/* 椅子：头枕 + 靠背 + 立柱 + 五星脚 */}
      <rect
        x="45.8"
        y="30.3"
        width="10.6"
        height="3.8"
        rx="1.8"
        style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.4 }}
      />
      <rect
        x="40.8"
        y="34.1"
        width="20.6"
        height="19"
        rx="3.4"
        style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.4 }}
      />
      <rect x="49.8" y="53" width="2.6" height="4.6" style={{ fill: v('office-furniture-2') }} />
      <rect x="43.4" y="57.4" width="15.4" height="1.6" rx="0.8" style={{ fill: v('office-furniture-2') }} />
      <circle cx="45" cy="59.6" r="1.15" style={{ fill: v('office-furniture-2') }} />
      <circle cx="57.2" cy="59.6" r="1.15" style={{ fill: v('office-furniture-2') }} />
    </svg>
  );
}

/** 场景外壳。children 叠在家具之上（立绘与名牌放这儿） */
function OfficeScene({ occupied, online, children }: { occupied: boolean; online: boolean; children?: ReactNode }) {
  return (
    <span className="office-scene block aspect-[3/2] w-full">
      <span className="office-shadow" aria-hidden />
      {/* 光晕只给开着的屏幕：没人的工位不该发光（位置跟着上面那块的屏体走） */}
      {occupied && online ? (
        <span className="office-glow" style={{ left: '30%', top: '10%', width: '40%', height: '22%' }} aria-hidden />
      ) : null}
      <Furniture occupied={occupied} />
      {children}
    </span>
  );
}

/* ── 工位（有人 / 空位） ───────────────────────────────────────────── */

/**
 * 一位员工的工位。
 *
 * 整张卡是一个按钮，不是"卡里放一个按钮"：这一格唯一的动作就是打开详情，
 * 而在按钮里再套一个按钮是无效的 HTML。点击区是整张卡 —— 手指不用去瞄
 * 信息区那行小字；那行「详情」只是把这件事说明白。
 */
export function EmployeeDesk({ employee, onOpen }: { employee: OfficeEmployee; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      /* w-full / h-full 都不能省：`<button>` 即使 display:flex 也**不会**填满父级 ——
         宽度按内容收缩（fit-content），高度也是内容高。于是同一行里卡片宽窄、
         高矮都不一致（实测 li 271px 时卡片是 252 / 271 / 271），右侧还各留一截空白。
         网格列与行都是等分的，是里面的按钮没撑开。 */
      className="panel panel-hover group/seat flex h-full w-full flex-col overflow-hidden text-left"
      aria-label={`打开 ${employee.name}（${employee.en}）的工位详情`}
    >
      <OfficeScene occupied online={employee.online}>
        {/* 名牌：状态点 + 名字 + 在线/离线。点与文字并存 ——
            状态不能只靠一个颜色点告诉人（色觉障碍、黑白打印都读不出来）。
            头顶只留"这是谁、在不在"；工位号不在这儿也不在下面（不再显示）。

            贴到 1%、内边距压到 2px：名牌是固定 px 高，屏幕是等比缩放的，
            卡片窄到 200px 上下时，3% + 3px 那一版会压住屏幕上沿。 */}
        <span className="absolute left-1/2 top-[1%] flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-panel/95 px-2.5 py-[2px] text-[11px] leading-none text-ink shadow-[0_2px_8px_-4px_rgba(20,40,80,.35)]">
          <span className={cls('h-1.5 w-1.5 rounded-full', employee.online ? 'bg-ok' : 'bg-faint')} aria-hidden />
          <span className="font-medium">{employee.name}</span>
          <span className={employee.online ? 'text-ok' : 'text-faint'}>{employee.online ? '在线' : '离线'}</span>
        </span>

        {/* 人：站在桌子右侧，压住桌沿 */}
        <img
          src={employee.avatar}
          alt={`${employee.name}的立绘`}
          loading="lazy"
          className="absolute bottom-[3%] right-[4%] h-[58%] w-auto max-w-none object-contain object-bottom transition-transform duration-300 group-hover/seat:scale-[1.03]"
        />

      </OfficeScene>

      <span className="flex flex-1 flex-col px-3.5 pb-3.5 pt-3">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-medium text-ink">{employee.name}</span>
          <span className="truncate text-2xs text-faint">{employee.en}</span>
        </span>
        <span className="mt-1 line-clamp-2 text-2xs leading-relaxed text-muted">{employee.role}</span>
        {/* 这一行只剩「详情」：工位号（A-01）已经撤掉 —— 卡片是"人"，工位是
            屋里的事，工位相关的信息在详情弹窗里，不该占着卡片底部那一行 */}
        <span className="mt-auto flex items-center justify-end gap-2 pt-2.5 text-2xs">
          <span className="flex items-center gap-1 text-accent">
            <MessagesSquare size={12} aria-hidden />
            详情
          </span>
        </span>
      </span>
    </button>
  );
}

/**
 * 空工位：同样的桌椅，只是没人坐、屏幕是暗的 —— "几个工位在编"要一眼看得见。
 *
 * h-full 同样不能省：它里面少了一行"岗位职责"，内容天然比有人的卡矮一截
 * （实测 226 vs 271），不撑满就会在同一行里矮下去、看着像另一种卡片。
 */
export function VacantDesk({ index }: { index: number }) {
  return (
    <div className="panel flex h-full flex-col overflow-hidden" aria-hidden>
      <OfficeScene occupied={false} online={false}>
        {/* 与有人的工位同名牌位置（见 EmployeeDesk 的说明） */}
        <span className="absolute left-1/2 top-[1%] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-dashed border-line bg-panel/90 px-2.5 py-[2px] text-[11px] leading-none text-faint">
          空工位 {index + 1}
        </span>
      </OfficeScene>
      <div className="flex flex-1 flex-col px-3.5 pb-3.5 pt-3">
        <p className="text-[13px] text-muted">空工位</p>
        <p className="mt-1 text-2xs leading-relaxed text-faint">还没有员工入驻</p>
      </div>
    </div>
  );
}

/* ── 办公设施（钉在工位墙正下方那一条）────────────────────────────────
 *
 * 茶水间 / 健身角 / 洗手间 —— 上游控制台那一排里的三件"设施"。
 * （那一排里还有一张「本月之星」，它不是设施而是人，所以单拎出去成了
 * 自己的面板，见下面的 StarPanel。）
 *
 * ── 三格的数据都是推出来的，不是抄的 ──────────────────────────────────
 * 上游那几格写的是演示值（"今日出杯 12"），本服务从头就不搬演示数据
 * （见 services/office.js 的说明）。所以这里每一格都用这一页**已经取到的**
 * 真数据折算：
 *   · 出杯 —— 今日 API 调用次数（/local/usage 的真实记账，与 TokenPanel 同一份）
 *   · 打卡 —— 今天真跑过的定时任务数（/local/board 的 jobs.last_run_at）
 *   · 保洁 —— 最近一次**完成**的执行的时刻（board.runs）
 * 推不出来就显示"—"，并把"这一格等的是哪份数据"写在悬停说明里。
 * 比喻可以有，数不能编。
 *
 * ── 画法 ──────────────────────────────────────────────────────────────
 * 三件设施各是一张线稿（SVG），与工位场景同一套路子：颜色全部走
 * --office-* 这组"插画自己的配色"（见 index.css），形状写在组件里。
 * viewBox 取 100×60 配 aspect-[5/3] —— 两者同比例，preserveAspectRatio="none"
 * 不会把圆角与描边拉歪，于是 1 个单位在 300px 宽的格子里就是 3px。
 * ──────────────────────────────────────────────────────────────────── */

/**
 * 台面 + 两条腿。茶水间那张线稿用它。
 *
 * 腿与花盆这类"浅色家具"必须描一圈 office-edge：格子的底是很淡的蓝白，
 * office-furniture-2 压在上面几乎看不见（工位场景里能省，是因为那边
 * 家具更大、底更亮）。
 */
function Counter() {
  const leg = { fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.4 } as const;
  return (
    <>
      <rect x="7" y="42" width="86" height="3.6" rx="1.8" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="13" y="45.6" width="3" height="11" rx="1.5" style={leg} />
      <rect x="84" y="45.6" width="3" height="11" rx="1.5" style={leg} />
    </>
  );
}

/** 茶水间：咖啡机（豆仓 / 深色面板 / 接水盘）+ 两只杯子 + 一盆绿植 */
function CoffeeScene() {
  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
      <Counter />
      {/* 咖啡机 */}
      <rect x="63" y="20" width="25" height="22" rx="2.4" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="67" y="14.4" width="17" height="6" rx="1.6" style={{ fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.4 }} />
      <rect x="67" y="24.6" width="17" height="8" rx="1.2" style={{ fill: v('office-screen') }} />
      <circle cx="80.4" cy="28.6" r="1.1" style={{ fill: v('office-furniture-2') }} />
      <rect x="70" y="35.2" width="11" height="2.4" rx="1.2" style={{ fill: v('office-furniture-2') }} />
      {/* 两只杯子（后面那只小一号） */}
      <rect x="40" y="35.6" width="6.4" height="6.2" rx="1.6" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="39.2" y="34.8" width="8" height="1.4" rx="0.7" style={{ fill: v('office-furniture-2') }} />
      <rect x="49.6" y="37" width="5.6" height="4.8" rx="1.4" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      {/* 绿植：叶子用 ok 色的低透明度，浅色/深色主题下都是一盆绿 */}
      <rect x="17" y="35.6" width="11" height="6.4" rx="1.8" style={{ fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <ellipse cx="19.6" cy="30.6" rx="4.6" ry="2.6" transform="rotate(-30 19.6 30.6)" style={{ fill: 'rgb(var(--ok-rgb) / 0.38)' }} />
      <ellipse cx="25.8" cy="30.2" rx="4.6" ry="2.6" transform="rotate(14 25.8 30.2)" style={{ fill: 'rgb(var(--ok-rgb) / 0.38)' }} />
      <ellipse cx="22.6" cy="27.2" rx="3.4" ry="2.4" style={{ fill: 'rgb(var(--ok-rgb) / 0.55)' }} />
    </svg>
  );
}

/** 健身角：跑步机（跑台 + 滚筒 + 略斜的立柱 + 深色仪表）+ 卷起来的地垫 */
function GymScene() {
  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
      {/* 跑台 */}
      <rect x="14" y="43" width="72" height="5" rx="2.5" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <circle cx="20" cy="45.5" r="2.1" style={{ fill: v('office-furniture-2') }} />
      <circle cx="80" cy="45.5" r="2.1" style={{ fill: v('office-furniture-2') }} />
      <rect x="17" y="42.2" width="66" height="1.6" rx="0.8" style={{ fill: v('office-furniture-2', 0.9) }} />
      {/* 立柱（顶端往左斜）与仪表盘 */}
      <rect x="74.4" y="22" width="2.6" height="22.4" rx="1.3" transform="rotate(-13 75.7 44)" style={{ fill: v('office-furniture-2') }} />
      <rect x="68.4" y="13" width="15" height="9.4" rx="2" transform="rotate(-13 76 22)" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="70.4" y="15.2" width="11" height="5" rx="1.2" transform="rotate(-13 76 22)" style={{ fill: v('office-screen') }} />
      {/* 卷起来的地垫 */}
      <rect x="9" y="33.4" width="23" height="5.4" rx="2.7" style={{ fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <circle cx="10.4" cy="36.1" r="2.7" style={{ fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
    </svg>
  );
}

/**
 * 洗手间：隔断 + 马桶（正面：水箱 / 椭圆便池 / 底座）+ 洗手盆与圆镜。
 *
 * 马桶得画"正面"：侧面那套（水箱 + 竖着的膛）在这么小的格里会被读成一个
 * 方框加一个圆 —— 椭圆便池才是那个一眼认得出的轮廓。
 */
function RestroomScene() {
  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
      <rect x="61" y="10" width="1.6" height="40" rx="0.8" style={{ fill: v('office-furniture-2') }} />
      {/* 马桶：水箱 + 冲水钮 + 便池 + 底座 */}
      <rect x="30" y="16.5" width="18" height="9.5" rx="1.6" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="37.2" y="18.6" width="3.6" height="1.6" rx="0.8" style={{ fill: v('office-furniture-2') }} />
      <ellipse cx="39" cy="33.5" rx="10.6" ry="8.6" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <ellipse cx="39" cy="33.5" rx="6.2" ry="4.8" style={{ fill: v('office-furniture-2', 0.75) }} />
      <rect x="35" y="41.6" width="8" height="6.4" rx="1.6" style={{ fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.4 }} />
      {/* 洗手盆与圆镜 */}
      <circle cx="78" cy="21.6" r="7" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="76.7" y="28.8" width="2.2" height="4" rx="1.1" style={{ fill: v('office-furniture-2') }} />
      <rect x="70" y="32.8" width="18" height="4.4" rx="2.2" style={{ fill: v('office-furniture'), stroke: v('office-edge'), strokeWidth: 0.5 }} />
      <rect x="73.6" y="37.2" width="10.8" height="8" rx="1.8" style={{ fill: v('office-furniture-2'), stroke: v('office-edge'), strokeWidth: 0.4 }} />
    </svg>
  );
}

/**
 * 一格设施。形状是"上面一张线稿 + 下面名字与状态"，与工位卡同一套版式
 * （scene 铺在上、信息压在下），摆在一排里才像同一个房间里的几件东西。
 */
function FacilityTile({
  name,
  en,
  tone,
  text,
  tip,
  children,
}: {
  name: string;
  en: string;
  /** 状态点：ok = 一切正常 / warn = 该看一眼 / neutral = 还没接上数据 */
  tone: string;
  text: string;
  /** 悬停说明：这一格的数是从哪张表推出来的 */
  tip: string;
  children: ReactNode;
}) {
  return (
    <li className="panel overflow-hidden">
      {/* 场景是纯装饰（信息都在下面那两行字里），读屏不必念 */}
      <span className="office-scene block aspect-[5/3] w-full" aria-hidden>
        <span className="office-shadow" />
        {children}
      </span>
      <div className="px-3.5 pb-3.5 pt-3">
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[13px] font-medium text-ink">{name}</span>
          <span className="text-3xs tracking-[0.14em] text-faint">{en}</span>
        </p>
        {/* 状态点 + 文字：点只是给"一眼扫过"，含义仍然写在字里（色觉障碍、
            黑白打印都要读得出来），所以这个点不承担信息 */}
        <p className="mt-1.5 flex items-start gap-1.5 text-2xs leading-snug text-muted" title={tip}>
          {/* 点与**首行**齐平：给它一个与行高等高的盒子，再把点居中。
              用一个 mt-[5px] 的魔数去猜"点该往下挪多少"，改字号或行高就错位了
              （leading-snug 就是 1.375 倍行高，所以盒子取 1.375em；文字换行时
              这个盒子也不会跟着变高，点仍然只对首行） */}
          <span className="flex h-[1.375em] shrink-0 items-center">
            <Led tone={tone} />
          </span>
          <span className="min-w-0">{text}</span>
        </p>
      </div>
    </li>
  );
}

/**
 * 办公设施那一条。
 *
 * 数据全部来自调用方已经取到的四路（roster / board / usage），所以这里
 * **不发任何请求**：它出现的位置就在工位墙下面，跟工位墙一起刷新。
 */
export function FacilitiesPanel({
  roster,
  board,
  usage,
  error,
  className,
}: {
  roster: OfficeRoster | null;
  board: OfficeBoard | null;
  usage: OfficeUsage | null;
  /** 待办或用量那一路的错：四格里有三格靠它们，读不到就说清楚是哪一路 */
  error: string;
  className?: string;
}) {
  /* 今天的分界交给本地时区：网关那边的时间戳是 UTC，直接字符串比较会错一天 */
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  const ms = (iso?: string | null) => {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };

  const cups = usage?.today?.api_calls ?? null;
  /* 打卡：今天真跑过的任务。last_run_at 是"最后一次跑"，昨天跑过、今天没跑的
     不该算今天来健身了 */
  const checked = board ? board.jobs.filter((j) => { const t = ms(j.last_run_at); return t != null && t >= since; }).length : null;
  /* 保洁：最近一次**完成**的执行。failed 的不算 —— 没干完的不叫打扫干净 */
  const cleaned =
    board?.runs
      .filter((r) => r.status === 'completed')
      .map((r) => ms(r.started_at))
      .filter((t): t is number => t != null)
      .sort((a, b) => b - a)[0] ?? null;

  /** 一个时刻的"几点几分"；不是今天的补上月日 —— 否则"保洁完成 · 09:00"会被读成今早 */
  const clock = (t: number) => {
    const d = new Date(t);
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return t >= since ? hm : `${d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${hm}`;
  };
  const cleanedText =
    cleaned != null
      ? `保洁完成 · ${clock(cleaned)}`
      : board
        ? '还没扫过 · 等一次执行完成'
        : '还没接到执行记录';

  const head = (
    <CardHead
      level={2}
      /* 与格子里那几个英文标签同一套写法：中英并排，英文放小、拉开字距 */
      title={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>办公设施</span>
          <span className="text-3xs font-normal tracking-[0.18em] text-faint">FACILITIES</span>
        </span>
      }
      hint="办公室里的日常：茶水间、健身角、洗手间"
      /* 这一格讲的是"现在楼里有谁在用这些设施"，所以给在线数，不给在编数 */
      right={
        roster ? (
          <Badge tone={roster.online ? 'ok' : 'neutral'} dot>
            {roster.online ?? 0} / {roster.staffed ?? 0} 在线
          </Badge>
        ) : undefined
      }
    />
  );

  /* 两路都没接上：给骨架或错误，而不是一排"—"（那看起来像是数据本来就是空的） */
  if (!board && !usage) {
    return (
      <Card className={className}>
        {head}
        {error ? <PanelError text={error} /> : <Skeleton className="h-40" />}
      </Card>
    );
  }

  return (
    <Card className={cls('flex flex-col', className)}>
      {head}
      {error ? <PanelError text={error} /> : null}

      {/* my-auto：这一列要靠它收口，余量**上下各摊一半** —— 与其在卡底留一块白，
          不如把三格放得"居中一点"，看着是这张卡比较松 */}
      <ul className={cls('grid grid-cols-1 gap-3 sm:grid-cols-3', error ? 'mt-3.5' : 'my-auto')}>
        <FacilityTile
          name="茶水间"
          en="COFFEE BAR"
          tone={cups == null ? 'neutral' : cups > 0 ? 'ok' : 'neutral'}
          text={cups == null ? '咖啡机待机 · 等网关记账' : `咖啡机运行中 · 今日出杯 ${cups}`}
          tip="出杯 = 今日 API 调用次数（网关 /local/usage 的真实记账，与右边那格「今日消耗 Token」同一份数）。"
        >
          <CoffeeScene />
        </FacilityTile>

        <FacilityTile
          name="健身角"
          en="FITNESS"
          tone={checked == null ? 'neutral' : checked > 0 ? 'ok' : 'warn'}
          text={checked == null ? '打卡机离线 · 等网关的待办表' : `今日已有 ${checked} 项任务打卡`}
          tip="打卡 = 今天真跑过的定时任务数（/local/board 的 jobs.last_run_at 落在今天以内）。今天还没人打卡时会亮黄灯。"
        >
          <GymScene />
        </FacilityTile>

        <FacilityTile
          name="洗手间"
          en="RESTROOM"
          /* 今天扫过给绿灯；最近一次还是昨天以前的，说明今天还没人来扫，给黄灯 */
          tone={cleaned == null ? 'neutral' : cleaned >= since ? 'ok' : 'warn'}
          text={cleanedText}
          tip="保洁 = 最近一次成功完成的定时任务时刻（/local/board 的 runs，失败的不算）。今天还没扫过时会亮黄灯。"
        >
          <RestroomScene />
        </FacilityTile>
      </ul>
    </Card>
  );
}

/* ── 本月之星（左栏最上面那一张）────────────────────────────────────── */

/**
 * 本月之星。
 *
 * 它原来跟那三件设施挤在同一张卡里，现在单拎出来、钉在左栏最上面 ——
 * 它是个"人"（网关本体，带着自己的立绘），而设施是"物"，两者不该同框。
 *
 * 「星」是谁是**定死的**，不是算出来的：这一页的会话、用量与定时任务都挂在
 * 网关本体头上（另外三位是工具集 / 守望 / 采集子系统，没有可比的交付口径）。
 * 能算的是**评级**：未闭环异常每多一条少一颗，最低一颗。副标题也只放真数
 * （今日新增会话数 + 未闭环异常数），不编"连续 N 周零差评"。
 *
 * 版式是竖着居中的（跟上游那一格一致）：它落在 300px 宽的左栏里，
 * 横排排不下；窄屏时整栏是整幅页面宽，居中也不难看。
 */
export function StarPanel({
  roster,
  board,
  className,
}: {
  roster: OfficeRoster | null;
  board: OfficeBoard | null;
  className?: string;
}) {
  const star = roster?.items.find((e) => e.id === 'hermes') ?? null;
  const bad = board ? board.incidents.filter((i) => i.state !== 'resolved').length : null;
  const rating = bad == null ? null : Math.max(1, 5 - bad);
  const fresh = board?.conversations.today_new ?? null;
  const text =
    bad == null
      ? '等待办工作表那一份数据'
      : bad === 0
        ? `今日新增 ${fresh ?? 0} 次会话 · 没有未闭环异常`
        : `今日新增 ${fresh ?? 0} 次会话 · ${bad} 个异常未闭环`;

  return (
    <Card className={cls('border border-accent/45 bg-accent-soft', className)}>
      {star?.avatar ? (
        <img
          src={star.avatar}
          alt={`${star.name}的立绘`}
          loading="lazy"
          className="mx-auto h-28 w-auto max-w-[70%] object-contain"
        />
      ) : null}
      <p className="mt-3 text-center text-3xs font-medium tracking-[0.2em] text-accent">★ 本月之星 STAR</p>
      <p className="mt-1.5 flex flex-wrap items-baseline justify-center gap-x-1.5">
        <span className="text-[15px] font-semibold text-ink">{star?.name ?? '—'}</span>
        {star?.en ? <span className="text-2xs text-faint">{star.en}</span> : null}
      </p>
      {/* 星星整体是一句话（"4 星"），拆成五个图标念会被读成五次 —— 所以
          给 role="img" + aria-label，图标自己全部 aria-hidden */}
      <p
        className="mt-1.5 flex items-center justify-center gap-0.5"
        role="img"
        aria-label={rating == null ? '星级还没接上数据' : `评级 ${rating} 星（满分 5 星）`}
        /* 评级规则只在这一个悬停说明里交代：卡面上不再写"口径"那一段 */
        title="星级按未闭环异常算：没有就是五颗，每多一条少一颗。本月之星固定是网关本体。"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <Star key={i} size={13} aria-hidden className={rating != null && i < rating ? 'fill-current text-warn' : 'text-faint'} />
        ))}
      </p>
      <p className="mt-2 flex items-start justify-center gap-1.5 text-2xs leading-snug text-muted">
        {/* 与设施那三格同一个写法：点对着首行的中线（见 FacilityTile） */}
        <span className="flex h-[1.375em] shrink-0 items-center">
          <Led tone={bad == null ? 'neutral' : bad === 0 ? 'ok' : 'warn'} />
        </span>
        <span className="min-w-0">{text}</span>
      </p>
    </Card>
  );
}

/* ── 右栏之一：今日消耗 Token ──────────────────────────────────────── */

/**
 * 今日 token 用量。数来自网关的真实记账（它直读 state.db 的 session_model_usage），
 * 包含办公室里那几位员工的消耗，不是估算，所以按原样呈现，只把它换成"万"。
 *
 * 大数字用 useCountUp 走一遍：这一页是定时刷新的，直接跳数会让人以为看错了；
 * 补间动画让"又涨了一点"这件事本身可见。
 */
export function TokenPanel({
  usage,
  error,
  className,
}: {
  usage: OfficeUsage | null;
  error: string;
  /** 所在栏要用它把剩余高度吃掉（flex-1）：三列底边要齐平，最后由每栏最后一张卡收口 */
  className?: string;
}) {
  const today = usage?.today;
  const shown = useCountUp(today?.total ?? 0);
  /* 按来源拆开：cron 是员工那边（定时任务/巡检），api_server 是接口调用（含面板自己）。
     一眼能看出"今天的消耗是员工在花，还是我在花" */
  const split = today?.sources
    ? Object.entries(today.sources)
        .sort((a, b) => b[1] - a[1])
        .map(([k, val]) => `${gatewaySourceLabel(k)} ${wan(val)}`)
        .join(' · ')
    : '';

  return (
    <Card className={className}>
      <CardHead
        /* level=2：这三块是直接铺在页面上的一级区块（和「办公室」那张同级），
           它们外面没有 Section。用 h3 会让文档大纲从 h1 跳到 h3，
           读屏按标题跳读时会整级漏掉 */
        level={2}
        title="今日消耗 Token"
        hint={usage ? `网关记账，含员工消耗 · ${fmtRelative(usage.generated_at)}` : '今日与近 7 日的模型用量'}
        right={<Activity size={15} className="text-accent" />}
      />
      {/* 错误只是一行提示压在数据上面，而不是把数据换成错误：
          轮询里偶尔失手一次，不该让刚读到的用量变成一块空白 */}
      {error ? <PanelError text={error} /> : null}
      {!usage || !today ? (
        error ? null : <Skeleton className="mt-3 h-24" />
      ) : (
        <>
          <p className={cls('flex items-baseline gap-1.5', error && 'mt-3')}>
            <span className="num text-2xl font-semibold text-ink">{wan(shown)}</span>
            <span className="num text-xs text-faint">/ {usage.budget_label}</span>
          </p>
          <Meter
            className="mt-2.5"
            ratio={usage.budget_tokens ? today.total / usage.budget_tokens : 0}
            tone="accent"
            height={5}
          />
          <dl className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-2xs">
            <TokenRow label="输入" value={wan(today.input)} />
            <TokenRow label="输出" value={wan(today.output)} />
            <TokenRow label="缓存命中" value={wan(today.cache_read)} />
            <TokenRow label="API 调用" value={`${today.api_calls} 次`} />
          </dl>
          {split ? <p className="mt-2.5 border-t border-line pt-2.5 text-2xs text-muted">来源 {split}</p> : null}
          <p className="mt-2 text-2xs text-faint">
            昨日 {wan(usage.yesterday.total)} · 近 7 日共 {wan(usage.series.reduce((s, d) => s + (d.total || 0), 0))}
            {usage.models?.length ? ` · 模型 ${usage.models.join(' / ')}` : ''}
          </p>
        </>
      )}
    </Card>
  );
}

function TokenRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-faint">{label}</dt>
      <dd className="num truncate text-ink">{value}</dd>
    </div>
  );
}

/* ── 右栏之二：全局待办工作表 ──────────────────────────────────────── */

/**
 * 全局待办工作表。它答的是"整个办公室现在有多少活在手上"：
 * 会话（进行中 / 已完成 / 今日新增）、定时任务、最近执行、异常。
 *
 * 异常单独顶到最上面一行：它是这里唯一需要马上看的东西，埋在列表里等于没有。
 */
export function BoardPanel({
  board,
  error,
  className,
}: {
  board: OfficeBoard | null;
  error: string;
  /** 见 TokenPanel：这一栏的收口卡是它（下面那个 mt-auto 会把余量分摊到清单中间） */
  className?: string;
}) {
  if (error && !board) {
    return (
      <Card className={className}>
        <CardHead level={2} title="全局待办工作表" hint="会话 / 定时任务 / 最近执行 / 异常" />
        <PanelError text={error} />
      </Card>
    );
  }
  if (!board) {
    return (
      <Card className={className}>
        <CardHead level={2} title="全局待办工作表" hint="会话 / 定时任务 / 最近执行 / 异常" />
        <Skeleton className="h-40" />
      </Card>
    );
  }
  const c = board.conversations;
  const bad = board.incidents.filter((i) => i.state !== 'resolved');

  return (
    /* flex 列 + 下面那个 mt-auto：这一块会被所在列拉高，把"最近执行"推到底部，
       空白就分摊在清单中间，而不是在卡片最下面堆一大块 */
    <Card className={cls('flex flex-col', className)}>
      <CardHead
        /* level=2：这三块是直接铺在页面上的一级区块（和「办公室」那张同级），
           它们外面没有 Section。用 h3 会让文档大纲从 h1 跳到 h3，
           读屏按标题跳读时会整级漏掉 */
        level={2}
        title="全局待办工作表"
        hint={`生成于 ${fmtRelative(board.generated_at)} · ${c.definition}`}
        right={
          bad.length ? (
            <Badge tone="crit" dot>
              {bad.length} 个异常未闭环
            </Badge>
          ) : (
            <Badge tone="ok">无未闭环异常</Badge>
          )
        }
      />

      {error ? <PanelError text={error} /> : null}

      <div className={cls('grid grid-cols-3 gap-2 text-center', error && 'mt-3.5')}>
        <MiniStat label="会话总数" value={c.total} />
        <MiniStat label="进行中" value={c.active} tone="accent" />
        <MiniStat label="今日新增" value={c.today_new} />
      </div>

      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-faint">
        {Object.entries(c.by_source || {}).map(([k, val]) => (
          <span key={k}>
            {sourceLabel(k)} <b className="num font-medium text-muted">{val}</b>
          </span>
        ))}
        <span>
          已完成 <b className="num font-medium text-muted">{c.done}</b>
        </span>
      </p>

      <p className="mb-2 mt-4 flex items-center gap-1.5 border-t border-line pt-3.5 text-2xs text-faint">
        <CalendarClock size={12} aria-hidden />
        定时任务 {board.jobs.length} 个 · 最近执行 {board.runs.length} 条
      </p>
      {/* 单列：这块与用量同处右栏（360px），摊两列会把周期那行挤碎。
          两个清单都挂 flex-auto + justify-between：这一栏比中间那列矮多少，
          余量就按"两半"摊进两个清单的行距里 —— 卡底不留白，也不在两张清单
          之间留一大块（那正是"内页有留白"的来源）。条数只是上限：定时任务 7、
          最近执行 8（对面这份就是最近 8 条），数据少就用实际条数 */}
      <ul className="flex flex-auto flex-col justify-between gap-1.5">
        {board.jobs.slice(0, 7).map((j) => (
          <li key={j.id} className="flex items-center gap-2 rounded-field bg-bg-2 px-2.5 py-2">
            <Led tone={j.enabled ? 'ok' : 'neutral'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-2xs text-ink">{j.name}</span>
              {/* 这一行不截断：两列排下来每格只有 ~180px，
                  "every 30m · 上次 31 分钟前" 截掉尾巴就只剩时间没有周期了 */}
              <span className="block text-2xs leading-snug text-faint">
                {j.schedule}
                {j.last_run_at ? ` · 上次 ${fmtRelative(j.last_run_at)}` : ''}
              </span>
            </span>
            {j.failure_streak > 0 ? (
              <Badge tone="warn">连续失败 {j.failure_streak}</Badge>
            ) : (
              <span className="num shrink-0 text-2xs text-faint">{j.runs_completed} 次</span>
            )}
          </li>
        ))}
      </ul>

      {board.runs.length ? (
        <ul className="mt-3 flex flex-auto flex-col justify-between gap-1 border-t border-line pt-3">
          {board.runs.slice(0, 8).map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-2xs">
              <Led tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'crit' : 'warn'} />
              <span className="min-w-0 flex-1 truncate text-muted">{r.job_name}</span>
              <span className="shrink-0 text-faint">
                {/* 纯脚本的巡检是一两秒内跑完的（duration_s 取整后是 0），
                    写"0 分"像是没跑；这类直接说"瞬时" */}
                {r.duration_s ? fmtDuration(r.duration_s) : r.duration_s === 0 ? '瞬时' : '—'} ·{' '}
                {fmtRelative(r.started_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: 'accent' }) {
  return (
    <div className="rounded-field bg-bg-2 px-2 py-2.5">
      <p className={cls('num text-base font-semibold', tone === 'accent' ? 'text-accent' : 'text-ink')}>{value}</p>
      <p className="mt-0.5 text-2xs text-faint">{label}</p>
    </div>
  );
}

/* ── 左栏：对话明细 ────────────────────────────────────────────────── */

/**
 * 对话明细：最近这些会话（cron 的日报、运维值守、命令行、微信都算）。
 *
 * 点一条看它逐条说了什么（只读）。铺在左边的窄栏里，不另做整页：它的作用是
 * "刚才那些活干得怎么样"的抽查，一行一条铺开最快，看完视线一抬就是工位墙。
 */
export function SessionsPanel({
  sessions,
  error,
  onOpen,
  className,
}: {
  sessions: OfficeSession[] | null;
  error: string;
  onOpen: (s: OfficeSession) => void;
  /** 见 TokenPanel */
  className?: string;
}) {
  if (error && !sessions) {
    return (
      <Card className={className}>
        <CardHead level={2} title="对话明细" hint="最近这些会话聊了什么、花了多少" />
        <PanelError text={error} />
      </Card>
    );
  }
  if (!sessions) {
    return (
      <Card className={className}>
        <CardHead level={2} title="对话明细" hint="最近这些会话聊了什么、花了多少" />
        <Skeleton className="h-40" />
      </Card>
    );
  }
  if (!sessions.length) {
    return (
      <Card className={className}>
        <CardHead level={2} title="对话明细" hint="最近这些会话聊了什么、花了多少" />
        {error ? <PanelError text={error} /> : null}
        <Empty title="还没有对话记录" hint="办公室里的会话（定时任务、命令行、微信）会出现在这里" />
      </Card>
    );
  }
  return (
    /* flex 列：下面那个清单要用 flex-auto 收口（把余量摊进行距），
       卡片本身得先是弹性容器 */
    <Card className={cls('flex flex-col', className)}>
      <CardHead
        /* level=2：这三块是直接铺在页面上的一级区块（和「办公室」那张同级），
           它们外面没有 Section。用 h3 会让文档大纲从 h1 跳到 h3，
           读屏按标题跳读时会整级漏掉 */
        level={2}
        title="对话明细"
        hint="最近这些会话聊了什么、花了多少"
        right={<Badge tone="neutral">{sessions.length} 条</Badge>}
      />
      {error ? <PanelError text={error} /> : null}
      {/* 铺 10 条（取回 20 条，徽标按取回的算）。这一栏是三列里最高的一列，
          条数与行高（一条 ~61px）算下来会正好落在三列的公共高度附近；剩下的
          零头由下面那个 justify-between 摊到行距里 —— **卡底不留白**，行距
          均不均匀看余量，余量大了就是"这份清单比较松"，而不是"卡里缺一块" */}
      <ul className={cls('flex flex-auto flex-col justify-between gap-1.5', error && 'mt-3.5')}>
        {sessions.slice(0, 10).map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onOpen(s)}
              className="w-full rounded-field px-2.5 py-2 text-left transition-colors hover:bg-bg-2"
            >
              <span className="flex items-center gap-2">
                <Badge tone={s.source === 'cron' ? 'accent' : 'neutral'}>{sourceLabel(s.source)}</Badge>
                <span className="min-w-0 flex-1 truncate text-2xs text-ink">{s.title}</span>
                <span className="shrink-0 text-2xs text-faint">{fmtRelative(at(s.last_active))}</span>
              </span>
              <span className="mt-1 flex items-center gap-3 text-2xs text-faint">
                <span>{s.message_count} 条</span>
                <span className="num">{wan(s.input_tokens + s.output_tokens)}</span>
                {s.tool_call_count ? <span>工具 {s.tool_call_count} 次</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ── 共用的错误行 ────────────────────────────────────────────────────
 * 三块各自会失败（口令没配、网关不通、这一路接口 500），所以错误要落在
 * 那一块里面：把整页画成错误页会连带藏掉那些其实读到了的数据。
 */
export function PanelError({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-field bg-warn-soft px-2.5 py-2 text-2xs leading-relaxed text-warn">
      <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
