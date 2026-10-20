#!/usr/bin/env bash
# 三维灯光模块的回归总闸：一条命令跑完全部测试。
#
# 改 dxf_lighting.py / lighting3d.py / lighting3d_page/ 之后**必须**跑这个；
# 改完别忘了 bump 版本号（PARSER_VERSION 也要 +1），否则老项目不会提示重新生成。
#
# 用法：bash scripts/check-lighting3d.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
PY="$REPO/.venv/bin/python"
[ -x "$PY" ] || { echo "找不到 $PY（先跑一次 start.py 装依赖）"; exit 1; }

fail=0
for t in tests/test_lighting3d_walls.py \
         tests/test_lighting3d_furniture.py \
         tests/test_lighting3d_spaces.py \
         tests/test_lighting3d_health.py \
         tests/smoke_lighting3d.py; do
  log="/tmp/$(basename "$t").log"
  printf '=== %-40s ' "$t"
  if "$PY" "$t" >"$log" 2>&1; then
    grep -E '^=== RESULT' "$log" | tail -1
  else
    fail=1
    echo "FAILED"
    tail -25 "$log"
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "=== 全部通过（墙 / 家具 / 空间名 / 体检 / 端到端冒烟）"
else
  echo "=== 有失败：上面每个失败用例的尾巴都打出来了"
fi
exit "$fail"
