#!/usr/bin/env bash
# install-hooks.sh — 把 cc-pet 的状态 hook 注册进 Claude Code settings.json。
#
# 安全策略：
#   • 默认 DRY-RUN：只打印将要新增的内容，并把合并结果写到 <settings>.cc-pet-preview，不动原文件。
#   • 只有加 --apply 才会真正写入；写入前先备份 <settings>.bak-<时间戳>，原子替换，写后校验 JSON。
#   • 只增不改：保留 settings.json 里所有既有内容与既有 hooks，只追加本工具的 hook 组（幂等，不重复）。
#
# 用法：
#   ./install-hooks.sh                 # 预览（dry-run）
#   ./install-hooks.sh --apply         # 真正写入
#   SETTINGS=/path/to/settings.json ./install-hooks.sh --apply
#   ./install-hooks.sh --apply --with-tools   # 额外注册 PreToolUse/PostToolUse（更实时但更吵）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/cc-pet-notify.sh"
SETTINGS="${SETTINGS:-$HOME/.claude/settings.json}"
APPLY=0
WITH_TOOLS=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --with-tools) WITH_TOOLS=1 ;;
  esac
done

chmod +x "$SCRIPT" 2>/dev/null || true

if [ ! -f "$SETTINGS" ]; then
  echo "✗ 找不到 settings.json：$SETTINGS"
  echo "  用 SETTINGS=/your/path ./install-hooks.sh 指定。"
  exit 1
fi

EVENTS="UserPromptSubmit Notification Stop SessionStart SessionEnd SubagentStop"
[ "$WITH_TOOLS" = "1" ] && EVENTS="$EVENTS PreToolUse PostToolUse"

python3 - "$SETTINGS" "$SCRIPT" "$APPLY" "$EVENTS" <<'PY'
import sys, json, os, time, shutil

settings_path, script, apply, events_str = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
events = events_str.split()

with open(settings_path, "r", encoding="utf-8") as f:
    data = json.load(f)

hooks = data.setdefault("hooks", {})
added = []

def already(groups):
    for g in groups:
        for h in g.get("hooks", []):
            if h.get("command") == script:
                return True
    return False

for ev in events:
    groups = hooks.setdefault(ev, [])
    if not isinstance(groups, list):
        print(f"  ! 跳过 {ev}：已存在的结构不是数组，留给你手动处理")
        continue
    if already(groups):
        continue
    groups.append({
        "matcher": "",
        "hooks": [{"type": "command", "command": script, "timeout": 5}],
    })
    added.append(ev)

print(f"settings: {settings_path}")
print(f"hook 脚本: {script}")
print(f"将新增 hook 的事件: {added if added else '（无，已是最新）'}")

merged = json.dumps(data, ensure_ascii=False, indent=2)

if not apply:
    preview = settings_path + ".cc-pet-preview"
    with open(preview, "w", encoding="utf-8") as f:
        f.write(merged + "\n")
    print(f"\n[DRY-RUN] 未改动原文件。合并结果已写到：\n  {preview}")
    print("确认无误后，加 --apply 真正写入。")
    sys.exit(0)

if not added:
    print("\n已经是最新，无需写入。")
    sys.exit(0)

# 备份 + 原子写 + 校验
ts = time.strftime("%Y%m%d-%H%M%S")
bak = f"{settings_path}.bak-{ts}"
shutil.copy2(settings_path, bak)
tmp = settings_path + ".cc-pet-tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(merged + "\n")
# 校验
with open(tmp, "r", encoding="utf-8") as f:
    json.load(f)
os.replace(tmp, settings_path)
print(f"\n✓ 已写入。备份：{bak}")
print("  重启 / 新开 Claude Code 会话后生效。")
PY

echo
echo "提示：hook 用环境变量找 agent，默认 http://127.0.0.1:47600。"
echo "若 agent 端口/带 token 不同，在你的 shell 环境里导出 CC_PET_URL / CC_PET_TOKEN。"
