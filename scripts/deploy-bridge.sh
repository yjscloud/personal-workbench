#!/usr/bin/env bash
# 把工作台数据桥（hwb-bridge）、采集脚本与飞书通知脚本部署到 Hermes 主机。
#
#   npm run bridge:deploy
#   HERMES_LOCAL_HOST=<助手机地址> HERMES_BRIDGE_DIR=/data/personal-workbench-bridge npm run bridge:deploy
#
# 只覆盖这几个文件，不动 Hermes 本体，也不动 /var/lib/agent-office 里的历史数据。
#
# 飞书那三个脚本以前是手工 scp 的，仓库里没有 → 助手机上改过一轮就与代码漂移：
# 重构 feishu_ban_card 时删掉了 send_card，ops 卡片那边还在 import，
# 正式发卡链路整条断掉（cron 里连挂两天）。现在它们跟着部署走，仓库才是真源。
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
[ -f .env ] && . ./.env
set +a

HOST="${HERMES_LOCAL_HOST:?未配置 HERMES_LOCAL_HOST}"
USER="${HERMES_LOCAL_USER:-root}"
KEY="${HERMES_LOCAL_KEY:-/root/.ssh/id_rsa}"
BRIDGE_PATH="${HERMES_BRIDGE_PATH:-/data/personal-workbench-bridge/hwb-bridge.cjs}"
DIR="$(dirname "$BRIDGE_PATH")"
HERMES_SCRIPTS="${HERMES_SCRIPTS_DIR:-/root/.hermes/scripts}"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -i "$KEY" "$USER@$HOST")

echo "→ 目标 $USER@$HOST:$DIR"
"${SSH[@]}" "mkdir -p '$DIR/scripts' '$HERMES_SCRIPTS'"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY" \
  server/remote/hwb-bridge.cjs "$USER@$HOST:$BRIDGE_PATH"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY" \
  server/remote/scrape.py "$USER@$HOST:$DIR/scripts/scrape.py"

echo "→ 飞书通知脚本 → $HERMES_SCRIPTS"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY" \
  server/remote/hermes-scripts/feishu_notify.py \
  server/remote/hermes-scripts/feishu_ban_card.py \
  server/remote/hermes-scripts/feishu_ops_card.py \
  "$USER@$HOST:$HERMES_SCRIPTS/"
# 源码换了就让旧字节码失效，免得跑起来还是上一版（cron 用的 python 版本不固定）
"${SSH[@]}" "chmod 755 '$HERMES_SCRIPTS'/feishu_*.py; rm -f '$HERMES_SCRIPTS'/__pycache__/feishu_*.pyc"

echo "→ 自检"
echo '{"path":"/__ping"}' | "${SSH[@]}" "node '$BRIDGE_PATH'"
"${SSH[@]}" "cd '$HERMES_SCRIPTS' && python3 -c 'import feishu_notify, feishu_ban_card, feishu_ops_card; print(\"feishu 脚本可导入：\", feishu_notify.__name__, feishu_ban_card.__name__, feishu_ops_card.__name__)'"
echo
echo "完成。"
