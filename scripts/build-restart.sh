#!/usr/bin/env bash
#
# ── 构建 + 重启 ─────────────────────────────────────────────────────────────
# 一条命令把当前工作区送上线：类型检查 → 构建前端 → 重启服务 → 等健康检查。
#
# 为什么需要它：手动走这四步，最容易漏的是**最后一步**。
# 前端产物（dist/）是服务直接从磁盘读的，所以 `npm run build` 一跑完界面就已经
# 是新的了；而后端的新路由要等重启才生效。于是"忘了重启"的表现是一个很费解的
# 组合：页面上是新按钮，点下去 404 —— 看起来像前端坏了，其实是后端还停在旧进程。
# 脚本把这一串绑成一步，并且**构建失败就不重启**：半个新版本（新界面 + 旧后端）
# 比整个旧版本更难排查。
#
# 用法：
#   scripts/build-restart.sh                类型检查 + 构建 + 重启
#   scripts/build-restart.sh --no-check     跳过类型检查（赶时间时；构建本身不做类型检查）
#   scripts/build-restart.sh --no-build     只重启（改过 .env / systemd unit 之后）
#   SERVICE=xxx scripts/build-restart.sh    换一个服务名（默认 personal-workbench）
#   WAIT_SECONDS=120 scripts/build-restart.sh
#
# 退出码：0 已就绪；1 中途失败（构建没过 / 重启后没起来）。
# 日志：journalctl -u personal-workbench -f

set -euo pipefail

# 从脚本自己的位置回到项目根：从任何目录调用都对，符号链接也能跟到真实位置
cd "$(dirname "$(readlink -f "$0")")/.."
ROOT="$PWD"

SERVICE="${SERVICE:-personal-workbench}"
HEALTH_PATH="/api/health"
WAIT_SECONDS="${WAIT_SECONDS:-60}"

# 颜色只在终端里用。重定向到文件时留着转义序列，日志就没法看了
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD="$(tput bold)"; CYAN="$(tput setaf 6)"; GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"; RED="$(tput setaf 1)"; RST="$(tput sgr0)"
else
  BOLD=""; CYAN=""; GREEN=""; YELLOW=""; RED=""; RST=""
fi

step() { printf '\n%s▸ %s%s\n' "$BOLD$CYAN" "$*" "$RST"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RST" "$*" >&2; }
die()  { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$RST" >&2; exit 1; }

usage() {
  # 帮助文本就是文件开头那段注释：改注释即改帮助，不必再维护第二份文案
  # （所以这里按"开头连续的 # 行"来取，而不是写死行号 —— 写死的那种，
  #   下次在注释里加两行就会漏出半句 set -euo pipefail）
  awk 'NR == 1 { next } /^#/ { sub(/^#( |$)/, ""); print; next } { exit }' "$0" \
    | sed '/./,$!d'
}

CHECK=1
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-check) CHECK=0 ;;
    --no-build) BUILD=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数：$arg（用 --help 看用法）" ;;
  esac
done

# ── 前置检查 ────────────────────────────────────────────────────────────
# 并发保护。两个构建同时写 dist/ 会互相删文件（vite 构建前会清空输出目录），
# 结果是一份谁都不认识的前端产物 —— 不如直接拒绝第二个
LOCK="${TMPDIR:-/tmp}/personal-workbench-build.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || die "建不了锁文件 $LOCK"
  flock -n 9 || die "已经有一个构建在跑了（$LOCK），等它结束再执行"
fi

[ -f package.json ] && [ -f server/index.js ] || die "这里不像项目根目录：$ROOT"
command -v npm >/dev/null 2>&1 || die "PATH 里没有 npm（node 是怎么装的？）"
[ -d node_modules ] || die "还没有依赖，先在 $ROOT 跑一次 npm install"

if [ -f node_modules/.package-lock.json ] && [ package-lock.json -nt node_modules/.package-lock.json ]; then
  warn "package-lock.json 比 node_modules 新，依赖可能没装齐（建议先 npm install）"
fi

# systemd：非 root 时补 sudo（unit 里 User=root，多数部署本来就是 root 直接跑）
SYSTEMCTL="systemctl"
[ "$(id -u)" -ne 0 ] && SYSTEMCTL="sudo systemctl"
command -v systemctl >/dev/null 2>&1 || die "这台机器上没有 systemd，这个脚本帮不上忙（手动 node server/index.js 吧）"
$SYSTEMCTL cat "$SERVICE" >/dev/null 2>&1 \
  || die "没有 $SERVICE 这个 systemd 服务。先按 README「常驻运行」装好 unit，或用 SERVICE=名字 指定"

# 健康检查的端口：从 .env 读，和程序自己读到的是同一个值。
# **不 source .env** —— 里面是数据库口令、HA token、各家 API key，
# 而这个脚本只需要一个端口号，没必要把它们全放进环境变量里
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1
}
# 端口只可能是一串数字，于是直接把数字抠出来：省得为引号、行尾空格、CRLF
# 各写一条 sed（.env 存成 CRLF 时这条也照样对）
PORT="${PORT:-$(env_value PORT | grep -oE '[0-9]+' | head -n 1 || true)}"
PORT="${PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}${HEALTH_PATH}"

echo "${BOLD}个人工作台 · 构建并重启${RST}"
echo "  目录    $ROOT"
echo "  服务    $SERVICE（$([ "$BUILD" = 1 ] && echo '构建后重启' || echo '仅重启')）"
echo "  探活    $HEALTH_URL"

# ── 1. 类型检查 ─────────────────────────────────────────────────────────
# 放在构建之前：vite build 只转译、不做类型检查，一份类型不通过的代码能顺利
# 打成包并上线，然后在运行时以最难看的方式报错
if [ "$CHECK" = 1 ]; then
  step "类型检查（tsc --noEmit）"
  if ! npm run --silent typecheck; then
    die "类型检查没通过，已中止：当前跑着的还是上一版，什么都没变"
  fi
  ok "通过"
fi

# ── 2. 构建前端 ─────────────────────────────────────────────────────────
if [ "$BUILD" = 1 ]; then
  step "构建前端（vite build → dist/）"
  # 构建期间线上服务仍在跑，而它每次都从磁盘读 dist/ —— 所以这几秒里前端
  # 可能处于"新旧掺半"的状态（vite 会先清空输出目录）。单机自用的面板上
  # 这个窗口可以接受；真要零抖动，得改成先停服务再构建（用 --no-build 手控）
  if ! npm run --silent build; then
    die "构建失败，已中止：dist/ 还是上一次成功的那份，后端也没动"
  fi
  ok "构建完成"
fi

# ── 3. 重启服务 ─────────────────────────────────────────────────────────
step "重启 $SERVICE"
$SYSTEMCTL restart "$SERVICE" || die "重启命令失败，看看：journalctl -u $SERVICE -n 50"

# ── 4. 等它就绪 ─────────────────────────────────────────────────────────
# 注意：**不能只探到 200 就收工**。旧进程同样在同一个端口上应答健康检查，
# 万一它没被换掉（或重启其实被跳过了），探活会立刻成功，而线上跑的还是旧代码。
# 所以再对一次 uptime：刚起来的进程不可能是几百秒。
step "等健康检查（最长 ${WAIT_SECONDS}s）"
deadline=$((SECONDS + WAIT_SECONDS))
until curl -fsS -o /dev/null --max-time 2 "$HEALTH_URL" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo >&2
    warn "等超时了。服务状态与最后的日志："
    { $SYSTEMCTL --no-pager -l status "$SERVICE" || true; } 2>&1 | tail -n 12 >&2
    echo >&2
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    die "$HEALTH_URL 一直没就绪"
  fi
  printf '.'
  sleep 1
done
echo
ok "已就绪"

uptime_s="$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"uptime":\([0-9]*\).*/\1/p')"
if [ -n "$uptime_s" ] && [ "$uptime_s" -gt 120 ]; then
  warn "探活通了，但这个进程已经跑了 ${uptime_s}s —— 重启像是没生效（旧进程还在应答）"
  warn "查一下：$SYSTEMCTL status $SERVICE / journalctl -u $SERVICE -n 50"
fi

# 报一下这次上线的到底是哪个版本：有未提交改动时，跑着的和 HEAD 不是一回事
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  rev="$(git rev-parse --short HEAD)"
  if [ -n "$(git status --porcelain)" ]; then
    echo "  版本    ${rev}${YELLOW}（工作区有未提交改动）${RST}"
  else
    echo "  版本    $rev"
  fi
fi

echo
ok "上线完成 · $HEALTH_URL · $(date '+%F %T')"
echo "  日志    journalctl -u $SERVICE -f"
