#!/usr/bin/env bash
# 光律 GUANGLV 每日在线备份：服务不停。
#   - studio.sqlite3 用 sqlite3 .backup 做一致性快照（WAL 下也安全）
#   - uploads/ 与 lighting3d/ 用 rsync 增量，未变化的文件与前一天硬链接，不重复占空间
#   - 默认保留 7 天
#
#   BACKUP_DIR=/vol2/guanglv-backup bash scripts/backup.sh
#   KEEP_DAYS=14 bash scripts/backup.sh
#
# crontab（hermes-studio 用户）：
#   30 3 * * * /path/to/repo/scripts/backup.sh >> /path/to/repo/data/backup.log 2>&1
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${DATA_DIR:-$REPO/data}"
case "$DATA" in /*) ;; *) DATA="$REPO/$DATA" ;; esac
BACKUP_DIR="${BACKUP_DIR:-$DATA/backups/auto}"
KEEP_DAYS="${KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
PREV="$(ls -1d "$BACKUP_DIR"/2*/ 2>/dev/null | sort | tail -1 || true)"

echo "=== 备份开始 $(date -Is) → $DEST ==="
mkdir -p "$DEST"
sqlite3 "$DATA/studio.sqlite3" ".backup '$DEST/studio.sqlite3'"
CHECK="$(sqlite3 "$DEST/studio.sqlite3" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "数据库备份校验失败：$CHECK"
  exit 1
fi
echo "数据库：$(du -h "$DEST/studio.sqlite3" | cut -f1)，项目 $(sqlite3 "$DEST/studio.sqlite3" 'SELECT count(*) FROM projects;') 个"

for dir in uploads lighting3d; do
  [ -d "$DATA/$dir" ] || continue
  if [ -n "$PREV" ] && [ -d "$PREV/$dir" ]; then
    rsync -a --delete --link-dest="$PREV/$dir" "$DATA/$dir/" "$DEST/$dir/"
  else
    rsync -a --delete "$DATA/$dir/" "$DEST/$dir/"
  fi
done
for f in workbench-versions.json; do
  [ -f "$DATA/$f" ] && cp -p "$DATA/$f" "$DEST/"
done
echo "备份目录合计（未变化文件为硬链接，不重复计）：$(du -sh "$BACKUP_DIR" | cut -f1)"

# 只清理本脚本生成的日期目录，保留最近 KEEP_DAYS 天
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '2*' -mtime +"$KEEP_DAYS" -print -exec rm -rf {} +
echo "=== 备份完成 $(date -Is) ==="
