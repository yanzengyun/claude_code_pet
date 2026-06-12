#!/usr/bin/env bash
# vibe-user-setup.sh — vibe 共享机新用户一键接入：专属 agent + 广播注册 + cron 保活。
#
# 在【你自己的 vibe 网页终端】里运行（一次即可）：
#   bash /home/q/vibe/projects/zengyuny/claude-desktop-pet/scripts/vibe-user-setup.sh <你的vibe用户名> [端口]
#
# 它会：
#   1. 生成你的专属 agent 配置 ~/.cc-pet/vibe-<用户名>.json（slug 只看你自己的项目）
#   2. 启动 agent（满血版：启发式+hooks+标题+Codex；hooks 全机已装，无需再装）
#   3. 注册进 hook 广播列表（精确状态事件实时送达）
#   4. 挂 cron 每 5 分钟幂等保活（code-server 重启后 ≤5 分钟自动复活）
#
# 然后在 Mac 桌宠「设置 → SSH 自动连接」填：你的工号@l-picservice4.tj.cn5 + 下面输出的端口。
set -euo pipefail
USER_NAME="${1:?用法: vibe-user-setup.sh <你的vibe用户名> [端口]}"
PORT="${2:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

# 端口缺省按用户名哈希取 47610-47789，基本不撞；撞了手动指定第二个参数
if [ -z "$PORT" ]; then
  H="$(printf '%s' "$USER_NAME" | cksum | cut -d' ' -f1)"
  PORT=$((47610 + H % 180))
fi

CFG_DIR="$HOME/.cc-pet"
CFG="$CFG_DIR/vibe-$USER_NAME.json"
mkdir -p "$CFG_DIR"

# 端口占用检查：被别人的 agent 占了就报错（同一份配置重复跑则幂等通过）
PIDFILE="/tmp/cc-pet-agent-$PORT.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
  if ! tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | grep -qxF "CC_PET_CONFIG=$CFG"; then
    echo "✗ 端口 $PORT 已被别的 agent 占用（pid=$PID）。换个端口重跑："
    echo "  bash $0 $USER_NAME $((PORT + 1))"
    exit 1
  fi
fi

cat > "$CFG" <<EOF
{
  "port": $PORT,
  "host": "127.0.0.1",
  "token": "",
  "slugIncludes": ["-home-q-vibe-projects-$USER_NAME"],
  "providers": [
    { "type": "claude", "name": "claude" },
    { "type": "codex", "name": "codex" }
  ]
}
EOF
echo "✓ 配置已生成：$CFG"

CC_PET_CONFIG="$CFG" bash "$HERE/agent/start.sh"

URL="http://127.0.0.1:$PORT"
grep -qxF "$URL" "$CFG_DIR/agents.list" 2>/dev/null || echo "$URL" >> "$CFG_DIR/agents.list"
echo "✓ 已注册 hook 广播：$URL"

if [ "${SKIP_CRON:-0}" != "1" ]; then
  LINE="*/5 * * * * CC_PET_CONFIG=$CFG $HERE/agent/start.sh >/dev/null 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "vibe-$USER_NAME.json"; echo "$LINE" ) | crontab -
  echo "✓ cron 保活已挂上（每 5 分钟幂等检查）"
fi

echo
echo "全部完成！Mac 桌宠「设置 → SSH 自动连接」填："
echo "  SSH 机器：你的工号@l-picservice4.tj.cn5"
echo "  远端端口：$PORT"
echo "  项目过滤：-home-q-vibe-projects-$USER_NAME"
