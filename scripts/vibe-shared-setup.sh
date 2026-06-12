#!/usr/bin/env bash
# vibe-shared-setup.sh — vibe 共享机的「机器级一次性配置」。管理员在自己的 vibe 网页终端跑一次，
# 之后所有同事零平台操作：Mac 客户端选「vibe 共享机」填用户名即可使用。
#
#   bash /home/q/vibe/projects/zengyuny/claude-desktop-pet/scripts/vibe-shared-setup.sh
#
# 它会：
#   1. 起一个「共享 agent」（端口 47888，不做 slug 过滤，看全机会话；
#      客户端订阅时各自带 ?slug= 参数，服务端按人过滤）
#   2. 注册进 hook 广播列表（精确事件实时送达；hooks 需已按 README 第四节装好）
#   3. 挂 cron 每 5 分钟幂等保活（code-server 重启 ≤5 分钟自动复活）
set -euo pipefail
PORT="${1:-47888}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CFG_DIR="$HOME/.cc-pet"
CFG="$CFG_DIR/vibe-shared.json"
mkdir -p "$CFG_DIR"

cat > "$CFG" <<EOF
{
  "port": $PORT,
  "host": "127.0.0.1",
  "token": "",
  "slugIncludes": null,
  "providers": [
    { "type": "claude", "name": "claude" },
    { "type": "codex", "name": "codex" }
  ]
}
EOF
echo "✓ 共享配置已生成：$CFG"

CC_PET_CONFIG="$CFG" bash "$HERE/agent/start.sh"

URL="http://127.0.0.1:$PORT"
grep -qxF "$URL" "$CFG_DIR/agents.list" 2>/dev/null || echo "$URL" >> "$CFG_DIR/agents.list"
echo "✓ 已注册 hook 广播：$URL"

if [ "${SKIP_CRON:-0}" != "1" ]; then
  LINE="*/5 * * * * CC_PET_CONFIG=$CFG $HERE/agent/start.sh >/dev/null 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "vibe-shared.json"; echo "$LINE" ) | crontab -
  echo "✓ cron 保活已挂上（每 5 分钟幂等检查）"
fi

echo
echo "机器级配置完成！之后同事接入零平台操作，只需："
echo "  Mac 装桌宠 → 设置「SSH 自动连接」选【vibe 共享机】→ 填自己的用户名 → 保存"
echo "  （前提：他的 Mac 到本机有 SSH 免密）"
