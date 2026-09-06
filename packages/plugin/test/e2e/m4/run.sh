#!/usr/bin/env bash
# M4 恢复流程验收：自驱动、跑完即退（KEEP_WORK=1 保留现场）。
# 编排：起参考服务端 → m4 种子（两帧会话 + kdf 镜像）→ 起真实 dsh web
# （--port 0 避开 3080 占用；挂 m4/patch.yml，全量预配）→ driver 就绪后
# 依次触发 目录拉取 → 恢复执行（targetCwd=$WORK/proj-a）→ 落位发现，
# 最后 verify.mts 做断言。打印 M4-E2E-PASS 表示通过，非零退出码表示失败。
# 用法：bash packages/plugin/test/e2e/m4/run.sh
#   E2E_WORK=/path 固定工作目录；E2E_PORT=8873 换服务端端口；KEEP_WORK=1 保留现场
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../../.." && pwd)"
DSH=/Users/monsterjacob/github-project/deepseek-harness
PORT="${E2E_PORT:-8872}"
TOKEN=e2e-token
DEVICE=e2e-device
LOCAL_DEVICE=m4-local
SESSION=seed-session-1
SOURCE_CWD=/tmp/proj-a
WORK="${E2E_WORK:-$(mktemp -d /tmp/dcs-m4.XXXXXX)}"
mkdir -p "$WORK"
KEEP=${KEEP_WORK:-0}
trap 'kill $(jobs -p) 2>/dev/null; if [ "$KEEP" = 1 ]; then echo "WORK preserved: $WORK"; elif [ "${FAILED:-0}" = 1 ]; then echo "WORK preserved(失败现场): $WORK"; else rm -rf "$WORK"; fi' EXIT

fail() {
  FAILED=1
  echo "M4-E2E-FAIL $*"
  echo "--- server.log ---"; tail -30 "$WORK/server.log" 2>/dev/null
  echo "--- dsh.log ---"; tail -60 "$WORK/dsh.log" 2>/dev/null
  exit 1
}

# wait_file <path> <秒>
wait_file() {
  for _ in $(seq 1 "$2"); do
    [ -f "$1" ] && return 0
    sleep 1
  done
  return 1
}

# 0. 端口预检：已被占用直接失败（避免误连别的实例）
curl -sf "http://127.0.0.1:$PORT/v1/healthz" > /dev/null 2>&1 && fail "端口 $PORT 已被占用（可 E2E_PORT= 换端口）"

# 1. 参考服务端
DATA_DIR="$WORK/server-data" DSH_SYNC_TOKEN=$TOKEN PORT=$PORT \
  node --import tsx "$ROOT/packages/server/src/index.ts" > "$WORK/server.log" 2>&1 &
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/v1/healthz" > /dev/null && break
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/v1/healthz" > /dev/null || fail "参考服务端未就绪"

# 2. 种子（两帧会话 + 同一 salt 的 kdf sidecar 镜像到 m4-local）
E2E_SERVER_URL="http://127.0.0.1:$PORT" E2E_TOKEN=$TOKEN E2E_DEVICE=$DEVICE \
  E2E_LOCAL_DEVICE=$LOCAL_DEVICE E2E_WORK="$WORK" \
  node --import tsx "$HERE/seed-cloud.mts" || fail "种子失败"
[ -f "$WORK/seed-frame2.hex" ] || fail "种子未写 seed-frame2.hex"

# 3. 真实 dsh web（源码 + tsx；必须 cwd 在 dsh 仓库根，tsconfig paths 依赖）
# --port 0 --no-open：e2e 不依赖 web UI，让 OS 选空闲端口且不弹浏览器
DSH_HOME="$WORK/dsh-home" E2E_WORK="$WORK" \
  bash -c 'cd "$0" && exec node --import tsx/esm apps/cli/src/bin.ts --profile web --patch "$1" --port 0 --no-open' \
  "$DSH" "$HERE/patch.yml" \
  > "$WORK/dsh.log" 2>&1 &

wait_file "$WORK/driver-ready" 120 || fail "driver 未就绪（120s 超时）"
grep -q "M4-DRIVER-ERROR" "$WORK/dsh.log" 2>/dev/null && fail "driver 启动报错"

# 4. 目录拉取
touch "$WORK/restore-list"
wait_file "$WORK/catalog.json" 40 || fail "catalog.json 未生成"
grep -q "M4-DRIVER-ERROR" "$WORK/dsh.log" 2>/dev/null && fail "目录拉取报错"

# 5. 恢复执行：targetCwd 指向本机同名项目目录（模拟「改选目录」）
mkdir -p "$WORK/proj-a"
AT=$(node -e 'console.log(Date.now())')
printf '{"at":%s,"items":[{"sessionId":"%s","device":"%s","targetCwd":"%s/proj-a"}]}' \
  "$AT" "$SESSION" "$DEVICE" "$WORK" > "$WORK/restore-run"
wait_file "$WORK/result.json" 60 || fail "result.json 未生成"
wait_file "$WORK/discovered.json" 30 || fail "discovered.json 未生成"
wait_file "$WORK/workspace.json" 30 || fail "workspace.json 未生成"
grep -q "M4-DRIVER-ERROR" "$WORK/dsh.log" 2>/dev/null && fail "恢复执行报错"

# 6. 断言（verify.mts 打印 M4-E2E-PASS）
E2E_WORK="$WORK" E2E_TARGET_CWD="$WORK/proj-a" E2E_RESTORE_AT="$AT" \
  E2E_DEVICE=$DEVICE E2E_LOCAL_DEVICE=$LOCAL_DEVICE E2E_SEED_CWD=$SOURCE_CWD \
  node --import tsx "$HERE/verify.mts" || fail "断言失败"
