#!/usr/bin/env bash
# stop.sh — 停止 cc-pet-agent。
set -euo pipefail
PIDFILE="${CC_PET_PIDFILE:-/tmp/cc-pet-agent.pid}"
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then kill "$PID" && echo "✓ 已停止 pid=$PID"; else echo "进程不在（pid=$PID）"; fi
  rm -f "$PIDFILE"
else
  echo "没有 pidfile，尝试按特征杀进程"
  pkill -f "agent/server.js" && echo "✓ 已按特征停止" || echo "未找到运行中的 agent"
fi
