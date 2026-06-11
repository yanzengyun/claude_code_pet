#!/usr/bin/env bash
# start.sh — 在当前机器（如 vibe）后台启动 cc-pet-agent。幂等。
# pid/日志按端口隔离，同机多人各跑各的互不影响。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="$(node -e 'const fs=require("fs"); const p=process.env.CC_PET_CONFIG || "'"$HERE"'/config.json"; let c={}; try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{} process.stdout.write(String(process.env.CC_PET_PORT || c.port || 47600));')"
PIDFILE="${CC_PET_PIDFILE:-/tmp/cc-pet-agent-$PORT.pid}"
LOG="${CC_PET_LOG:-/tmp/cc-pet-agent-$PORT.log}"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "已在运行 pid=$(cat "$PIDFILE")（port $PORT）"; exit 0
fi

nohup node "$HERE/server.js" >"$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 1.2
if curl -s -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "✓ 已启动 pid=$(cat "$PIDFILE") port=$PORT"
  echo "  本机自测: curl http://127.0.0.1:$PORT/status"
  echo "  日志:     $LOG"
else
  echo "✗ 启动后健康检查失败，看日志：$LOG"; tail -5 "$LOG" || true; exit 1
fi
