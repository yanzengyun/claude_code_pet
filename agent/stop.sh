#!/usr/bin/env bash
# stop.sh — 停止 cc-pet-agent（只停本目录这一份，不误杀同机其他人的）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME/node/bin" "$HOME/.nvm/versions/node"/*/bin "$HOME/.local/bin" \
           /usr/local/bin /opt/node/bin /usr/local/node/bin; do
    [ -x "$d/node" ] && PATH="$d:$PATH" && break
  done
fi
PORT="$(node -e 'const fs=require("fs"); const p=process.env.CC_PET_CONFIG || "'"$HERE"'/config.json"; let c={}; try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{} process.stdout.write(String(process.env.CC_PET_PORT || c.port || 47600));')"
PIDFILE="${CC_PET_PIDFILE:-/tmp/cc-pet-agent-$PORT.pid}"
# 兼容旧版固定路径 pidfile
[ -f "$PIDFILE" ] || { [ -f /tmp/cc-pet-agent.pid ] && PIDFILE=/tmp/cc-pet-agent.pid; } || true
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then kill "$PID" && echo "✓ 已停止 pid=$PID"; else echo "进程不在（pid=$PID）"; fi
  rm -f "$PIDFILE"
else
  echo "没有 pidfile，按本目录特征杀进程"
  pkill -f "$HERE/server.js" && echo "✓ 已按特征停止" || echo "未找到运行中的 agent"
fi
