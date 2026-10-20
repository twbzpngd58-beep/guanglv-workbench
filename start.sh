#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
exec python3 start.py "$@"
