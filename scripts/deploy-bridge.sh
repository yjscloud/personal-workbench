#!/usr/bin/env bash
# 把工作台数据桥（hwb-bridge）与采集脚本部署到 Hermes 主机。
#
#   npm run bridge:deploy
#   HERMES_LOCAL_HOST=<助手机地址> HERMES_BRIDGE_DIR=/data/personal-workbench-bridge npm run bridge:deploy
#
# 只覆盖这两个文件，不动 Hermes 本体，也不动 /var/lib/agent-office 里的历史数据。
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

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -i "$KEY" "$USER@$HOST")

echo "→ 目标 $USER@$HOST:$DIR"
"${SSH[@]}" "mkdir -p '$DIR/scripts'"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY" \
  server/remote/hwb-bridge.cjs "$USER@$HOST:$BRIDGE_PATH"
scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY" \
  server/remote/scrape.py "$USER@$HOST:$DIR/scripts/scrape.py"

echo "→ 自检"
echo '{"path":"/__ping"}' | "${SSH[@]}" "node '$BRIDGE_PATH'"
echo
echo "完成。"
