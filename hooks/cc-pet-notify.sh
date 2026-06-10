#!/usr/bin/env bash
# cc-pet-notify.sh — Claude Code hook：把状态事件转发给 cc-pet-agent。
# 设计原则：永不阻塞 Claude Code —— 解析+转发全部后台执行，立即 exit 0。
#
# 多人共用：事件会广播给「注册表」里的所有 agent，各 agent 自己按 slugIncludes
# 过滤只收自己项目的。新用户起好 agent 后把地址追加进注册表即可，无需重装 hook：
#   echo "http://127.0.0.1:477XX" >> ~/.cc-pet/agents.list
#
# 环境变量：
#   CC_PET_URL    主 agent 地址（默认 http://127.0.0.1:47600）
#   CC_PET_TOKEN  可选 token（仅用于 CC_PET_URL；注册表里的地址自行带 ?token=）
#   CC_PET_AGENTS 注册表路径（默认 ~/.cc-pet/agents.list，一行一个 URL，# 注释）
set +e
URL="${CC_PET_URL:-http://127.0.0.1:47600}"
TOKEN="${CC_PET_TOKEN:-}"
AGENTS_LIST="${CC_PET_AGENTS:-$HOME/.cc-pet/agents.list}"
payload="$(cat)"

(
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
  [ -z "$body" ] && exit 0

  # 收集目标：主 agent + 注册表（去重、跳过空行和 # 注释）
  urls="$URL"
  if [ -f "$AGENTS_LIST" ]; then
    while IFS= read -r line; do
      line="${line%%#*}"
      line="$(printf '%s' "$line" | tr -d '[:space:]')"
      [ -z "$line" ] && continue
      case " $urls " in *" $line "*) ;; *) urls="$urls $line" ;; esac
    done < "$AGENTS_LIST"
  fi

  for u in $urls; do
    q=""
    [ "$u" = "$URL" ] && [ -n "$TOKEN" ] && q="?token=$TOKEN"
    curl -s --max-time 1 -X POST "$u/hook$q" \
      -H 'Content-Type: application/json' -d "$body" >/dev/null 2>&1 &
  done
  wait
) >/dev/null 2>&1 &

exit 0
