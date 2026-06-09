#!/usr/bin/env bash
# uninstall-hooks.sh — 从 Claude Code settings.json 移除 cc-pet 注册的 hook。
# 同样默认 DRY-RUN，--apply 才真正写入（先备份）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/cc-pet-notify.sh"
SETTINGS="${SETTINGS:-$HOME/.claude/settings.json}"
APPLY=0
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done

[ -f "$SETTINGS" ] || { echo "✗ 找不到 $SETTINGS"; exit 1; }

python3 - "$SETTINGS" "$SCRIPT" "$APPLY" <<'PY'
import sys, json, os, time, shutil
settings_path, script, apply = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
with open(settings_path, encoding="utf-8") as f:
    data = json.load(f)
hooks = data.get("hooks", {})
removed = []
for ev, groups in list(hooks.items()):
    if not isinstance(groups, list):
        continue
    new_groups = []
    for g in groups:
        ghooks = [h for h in g.get("hooks", []) if h.get("command") != script]
        if not ghooks:
            removed.append(ev); continue          # 整组都是我们的 → 删掉
        if len(ghooks) != len(g.get("hooks", [])):
            removed.append(ev)
        g = {**g, "hooks": ghooks}
        new_groups.append(g)
    if new_groups:
        hooks[ev] = new_groups
    else:
        del hooks[ev]

print(f"将从这些事件移除 cc-pet hook: {sorted(set(removed)) if removed else '（无）'}")
merged = json.dumps(data, ensure_ascii=False, indent=2)
if not apply:
    print("\n[DRY-RUN] 未改动。加 --apply 真正写入。")
    sys.exit(0)
if not removed:
    print("\n无可移除项。")
    sys.exit(0)
ts = time.strftime("%Y%m%d-%H%M%S")
bak = f"{settings_path}.bak-{ts}"
shutil.copy2(settings_path, bak)
tmp = settings_path + ".cc-pet-tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(merged + "\n")
with open(tmp, encoding="utf-8") as f:
    json.load(f)
os.replace(tmp, settings_path)
print(f"\n✓ 已移除。备份：{bak}")
PY
