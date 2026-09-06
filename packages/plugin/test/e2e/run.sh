#!/usr/bin/env bash
# M2 验收：真实 dsh（源码 + tsx）以 --patch 挂载插件，产生会话后验证云端出现密文对象。
# 用法：bash packages/plugin/test/e2e/run.sh
set -u

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
DSH="${DSH:-$HOME/github-project/deepseek-harness}"
PORT=8871
TOKEN=e2e-token
WORK="$(mktemp -d /tmp/dcs-e2e.XXXXXX)"
KEEP=${KEEP_WORK:-0}
trap 'kill $(jobs -p) 2>/dev/null; if [ "$KEEP" = 1 ]; then echo "WORK preserved: $WORK"; else rm -rf "$WORK"; fi' EXIT

# 1. 起参考服务端
DATA_DIR="$WORK/server-data" DSH_SYNC_TOKEN=$TOKEN PORT=$PORT \
  node --import tsx "$ROOT/packages/server/src/index.ts" > "$WORK/server.log" 2>&1 &
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/v1/healthz" > /dev/null && break
  sleep 0.3
done

# 2. 起真实 dsh（源码），挂 patch
# 必须 cd 到 dsh 仓库根：tsx 依赖其 tsconfig paths 把 @deepseek-ai/cordis 映射到 vendor 源码
DSH_HOME="$WORK/dsh-home" \
E2E_SERVER_URL="http://127.0.0.1:$PORT" E2E_TOKEN=$TOKEN E2E_DEVICE=e2e-device E2E_CWD=/tmp \
  bash -c 'cd "$0" && exec node --import tsx/esm apps/cli/src/bin.ts --profile web --patch "$1"' \
  "$DSH" "$ROOT/packages/plugin/test/e2e/patch.yml" \
  > "$WORK/dsh.log" 2>&1 &

# 3. 等 driver 退出（PASS/FAIL）或超时
for i in $(seq 1 90); do
  if grep -q "E2E-PASS" "$WORK/dsh.log" 2>/dev/null; then
    grep "E2E-PASS" "$WORK/dsh.log"
    echo "--- server log ---"; cat "$WORK/server.log"
    exit 0
  fi
  if grep -q "E2E-FAIL" "$WORK/dsh.log" 2>/dev/null; then
    grep "E2E-FAIL" "$WORK/dsh.log"
    tail -40 "$WORK/dsh.log"
    exit 1
  fi
  sleep 1
done
echo "E2E-TIMEOUT"
tail -40 "$WORK/dsh.log"
exit 1
