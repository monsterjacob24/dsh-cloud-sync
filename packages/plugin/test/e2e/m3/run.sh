#!/usr/bin/env bash
# M3 验收环境：参考服务端（含种子数据）+ 真实 dsh web profile（挂 cloud-sync 源码 + driver）。
# 起来后保持存活，由 Playwright 驱动浏览器验证设置卡。Ctrl-C 或 kill 退出。
# 用法：bash packages/plugin/test/e2e/m3/run.sh   （E2E_WORK=/path 可固定工作目录）
set -u

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
DSH=/Users/monsterjacob/github-project/deepseek-harness
PORT=8871
TOKEN=e2e-token
WORK="${E2E_WORK:-$(mktemp -d /tmp/dcs-m3.XXXXXX)}"
mkdir -p "$WORK"
trap 'kill $(jobs -p) 2>/dev/null' EXIT

# 1. 参考服务端
DATA_DIR="$WORK/server-data" DSH_SYNC_TOKEN=$TOKEN PORT=$PORT \
  node --import tsx "$ROOT/packages/server/src/index.ts" > "$WORK/server.log" 2>&1 &
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/v1/healthz" > /dev/null && break
  sleep 0.3
done

# 2. 种子：口令 seed-pass 上传一个会话（验证口令不匹配 / 已连接 N 个会话）
E2E_SERVER_URL="http://127.0.0.1:$PORT" E2E_TOKEN=$TOKEN E2E_DEVICE=e2e-device \
  node --import tsx "$(dirname "$0")/seed-cloud.mts" || { echo "SEED FAILED"; exit 1; }

# 3. 真实 dsh web（源码 + tsx；必须 cwd 在 dsh 仓库根，tsconfig paths 依赖）
DSH_HOME="$WORK/dsh-home" E2E_WORK="$WORK" \
  bash -c 'cd "$0" && exec node --import tsx/esm apps/cli/src/bin.ts --profile web --patch "$1"' \
  "$DSH" "$(cd "$(dirname "$0")" && pwd)/patch.yml" \
  > "$WORK/dsh.log" 2>&1 &

# 4. 等 web UI 起来
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:3080" > /dev/null 2>&1 && break
  sleep 1
done

echo "M3-READY WORK=$WORK UI=http://127.0.0.1:3080 CLOUD=http://127.0.0.1:$PORT"
wait
