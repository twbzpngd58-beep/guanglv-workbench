#!/usr/bin/env bash
# 恢复演练：把最新一份自动备份恢复到临时目录，在旁路端口起一个只监听本机的实例，
# 核对项目数量后关掉并清理。不碰正在运行的服务和正式数据。
#
#   bash scripts/restore_drill.sh            # 默认端口 8011，期望项目数不校验
#   EXPECT=19 bash scripts/restore_drill.sh  # 同时校验项目数
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${DATA_DIR:-$REPO/data}"
case "$DATA" in /*) ;; *) DATA="$REPO/$DATA" ;; esac
BACKUP_DIR="${BACKUP_DIR:-$DATA/backups/auto}"
DRILL_PORT="${DRILL_PORT:-8011}"
LATEST="$(ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -1)"
[ -n "$LATEST" ] || { echo "没有可用备份：$BACKUP_DIR"; exit 1; }
if ss -ltn | grep -q ":$DRILL_PORT "; then echo "端口 $DRILL_PORT 已被占用，换 DRILL_PORT 再试"; exit 1; fi
TMP="$(mktemp -d /tmp/guanglv-restore-XXXX)"
trap 'kill "$PID" 2>/dev/null; rm -rf "$TMP"' EXIT
cp -a "$LATEST"/. "$TMP"/
cd "$REPO"
env -u PORT DATA_DIR="$TMP" SEED_DEMO=0 "$REPO/.venv/bin/python" -m uvicorn backend.app:app \
  --host 127.0.0.1 --port "$DRILL_PORT" > "$TMP/drill.log" 2>&1 < /dev/null &
PID=$!
for _ in $(seq 1 40); do curl -fs -o /dev/null "http://127.0.0.1:$DRILL_PORT/api/health" && break; sleep 1; done
COUNT="$(curl -fs "http://127.0.0.1:$DRILL_PORT/api/projects" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)"
echo "备份：$LATEST"
echo "恢复实例列出项目：${COUNT:-读取失败}"
if [ -z "$COUNT" ] || { [ -n "${EXPECT:-}" ] && [ "$COUNT" != "$EXPECT" ]; }; then
  echo "恢复演练失败"; tail -20 "$TMP/drill.log"; exit 1
fi
echo "恢复演练通过"
