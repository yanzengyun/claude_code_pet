#!/usr/bin/env bash
# build-dmg.sh — 在 macOS 上把桌宠打包成 .dmg（一条命令）。
# 用法（在你的 Mac 上）：
#   cd claude-desktop-pet/pet
#   bash build-dmg.sh            # 同时出 arm64 + x64 两个 dmg
#   bash build-dmg.sh arm        # 只出 Apple Silicon (arm64)
#   bash build-dmg.sh intel      # 只出 Intel (x64)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# 1) 必须在 macOS（dmg 依赖 mac 专有的 hdiutil/iconutil）
if [ "$(uname)" != "Darwin" ]; then
  echo "✗ .dmg 只能在 macOS 上构建（依赖 hdiutil/iconutil）。"
  echo "  把本项目拷到你的 Mac，再在 Mac 上跑：bash build-dmg.sh"
  exit 1
fi

# 2) Node 检查
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 node。先装：brew install node（需 Node ≥ 18）"; exit 1
fi
echo "node $(node -v) / npm $(npm -v)"

# 3) 装依赖（含 electron + electron-builder）
if [ ! -d node_modules ]; then
  echo ">>> npm install（首次较慢，会下 Electron 运行时）"
  npm install
fi

# 4) 选目标
TARGET="${1:-both}"
case "$TARGET" in
  arm)   SCRIPT="dist:arm" ;;
  intel) SCRIPT="dist:intel" ;;
  both|"") SCRIPT="dist" ;;
  *) echo "未知参数 '$TARGET'（可选 arm / intel / 留空=both）"; exit 1 ;;
esac

echo ">>> npm run $SCRIPT"
npm run "$SCRIPT"

# 5) 结果
echo
echo "✓ 完成。产物在 dist/："
ls -1 dist/*.dmg 2>/dev/null || { echo "（没找到 .dmg，看上面的构建日志）"; exit 1; }
echo
echo "安装：双击 .dmg → 把 Claude Pet 拖进 Applications。"
echo "首次打开被 Gatekeeper 拦（未签名）时，二选一："
echo "  • 右键点 App → 打开 → 再点『打开』；或"
echo "  • 终端执行：xattr -cr /Applications/Claude\\ Pet.app"
