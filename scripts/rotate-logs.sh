#!/bin/bash
#
# rotate-logs.sh —— CyberStrikeAI 日志轮转
#
# launchd 的 StandardOutPath 不做轮转，服务持续输出会让 server.log 无限增长
# （实测约 315 KB/小时，7.5 MB/天）。本脚本在超过阈值时归档并重启服务，
# 由 launchd 重新打开日志文件句柄。
#
# 之所以用「重启」而非 copytruncate：进程持有原 fd，截断后写入偏移不前移，
# 会产生前面全是空字节的稀疏文件。重启最干净，且阈值触发频率很低。
#
# 由 ~/Library/LaunchAgents/com.cyberstrikeai.logrotate.plist 每小时调用。
set -u

# 以脚本所在位置推导项目根，避免硬编码绝对路径
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
LOG="$LOG_DIR/server.log"
LABEL="com.cyberstrikeai.server"
MAX_BYTES=$((20 * 1024 * 1024))   # 20 MB 触发
KEEP=7                            # 保留最近 7 份归档

[ -f "$LOG" ] || exit 0

SIZE=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
if [ "$SIZE" -lt "$MAX_BYTES" ]; then
    exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
mv "$LOG" "$LOG_DIR/server.log.$STAMP" || exit 1

# 重启服务：launchd 会按 StandardOutPath 重新创建日志文件
launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1

# 只保留最近 KEEP 份归档
ls -1t "$LOG_DIR"/server.log.* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
done

exit 0
