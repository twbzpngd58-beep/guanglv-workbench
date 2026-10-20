#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Prefer a Python that satisfies the locked requirements (numpy 2.x requires 3.11+).
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for cand in python3.12 python3.13 python3.11 python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      PY="$cand"
      break
    fi
  done
fi
if [ -z "$PY" ]; then
  echo "需要 Python 3.11 或更高版本（建议 3.12）。" >&2
  echo "macOS 可执行：brew install python@3.12；或从 https://www.python.org/downloads/ 安装。" >&2
  exit 1
fi
exec "$PY" start.py "$@"
