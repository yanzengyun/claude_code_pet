#!/usr/bin/env bash
# cc-pet-notify.sh — Claude Code hook：把状态事件转发给 cc-pet-agent。
# 设计原则：永不阻塞 Claude Code —— 解析+转发全部后台执行，立即 exit 0。
#
# 环境变量：
#   CC_PET_URL   agent 地址（默认 http://127.0.0.1:47600）
#   CC_PET_TOKEN 可选 token
set +e
URL="${CC_PET_URL:-http://127.0.0.1:47600}"
TOKEN="${CC_PET_TOKEN:-}"
payload="$(cat)"

(
  q=""
  [ -n "$TOKEN" ] && q="?token=$TOKEN"
  body="$(printf '%s' "$payload" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
out = {
    "event": d.get("hook_event_name"),
    "sessionId": d.get("session_id"),
    "cwd": d.get("cwd"),
    "toolName": d.get("tool_name"),
}
if out["event"] and out["sessionId"]:
    print(json.dumps(out))
' 2>/dev/null)"
  [ -n "$body" ] && curl -s --max-time 1 -X POST "$URL/hook$q" \
    -H 'Content-Type: application/json' -d "$body" >/dev/null 2>&1
) >/dev/null 2>&1 &

exit 0
