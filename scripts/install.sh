#!/usr/bin/env bash
# dsh-purge2 安装脚本
#
# 只做三件事：备份 profile → 调官方 dsh plugin add → 验证真的进了 bundles。
# 不自动重启 DSH（重启会打断正在跑的会话），也不改用户的 cordis.patch.yml 内容。
#
# 用法：
#   ./scripts/install.sh                  # 装主包到 web profile
#   ./scripts/install.sh --profile desktop
#   ./scripts/install.sh --with-lab       # 同时装演练台（可选层）
#   ./scripts/install.sh --dry-run        # 只打印将要做什么
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="web"
WITH_LAB=0
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?需要 profile 名}"; shift 2 ;;
    --with-lab) WITH_LAB=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

DSH_BIN="${DSH_BIN:-}"
if [ -z "$DSH_BIN" ]; then
  for c in "$HOME/bin/dsh" "$(command -v dsh 2>/dev/null || true)" /opt/homebrew/bin/dsh /usr/local/bin/dsh; do
    [ -n "$c" ] && [ -x "$c" ] && { DSH_BIN="$c"; break; }
  done
fi
[ -n "$DSH_BIN" ] || { echo "找不到 dsh 命令；设置 DSH_BIN=/path/to/dsh"; exit 2; }

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
[ -d "$PROFILE_DIR" ] || { echo "profile 目录不存在：$PROFILE_DIR"; exit 2; }

echo "== dsh-purge2 安装 =="
echo "  dsh      $DSH_BIN"
echo "  profile  $PROFILE  ($PROFILE_DIR)"
echo "  源       $REPO"
echo "  演练台   $([ "$WITH_LAB" = 1 ] && echo 一起装 || echo 不装)"
echo

run() {
  if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi
}

# 1) 备份 profile 的 package.json（pnpm 改依赖前留一手）
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -f "$PROFILE_DIR/package.json" ]; then
  run cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.purge2bak-$STAMP"
  echo "✓ 已备份 package.json → package.json.purge2bak-$STAMP"
fi

# 2) 用官方入口安装（link: 形式，改代码即时生效，便于迭代）
run "$DSH_BIN" plugin --profile "$PROFILE" add "link:$REPO"
echo "✓ 主包已提交安装"

if [ "$WITH_LAB" = 1 ]; then
  run "$DSH_BIN" plugin --profile "$PROFILE" add "link:$REPO/lab"
  echo "✓ 演练台已提交安装"
fi

# 3) 验证真的进了 profile 的 bundles（pnpm 退出码 0 不算证据）
if [ "$DRY" = 0 ]; then
  echo
  echo "== 验证 =="
  CFG=$("$DSH_BIN" --profile "$PROFILE" --dump-config 2>/dev/null || true)
  if printf '%s' "$CFG" | grep -q "== dsh-purge2"; then
    echo "✓ dsh-purge2 已进入 profile bundles"
  else
    echo "⚠ 未在 --dump-config 里看到 dsh-purge2 层；请检查 $PROFILE_DIR/package.json 的依赖与 dsh.profile.bundles"
  fi
  if [ "$WITH_LAB" = 1 ]; then
    printf '%s' "$CFG" | grep -q "== dsh-purge2-lab" \
      && echo "✓ dsh-purge2-lab 已进入 profile bundles" \
      || echo "⚠ 未看到 dsh-purge2-lab 层"
  fi
fi

echo
echo "== 接下来 =="
echo "  1) 重启 DSH 让插件加载（会中断当前会话）："
echo "       supervisorctl restart dsh-web        # 若由 supervisor 托管"
echo "       # 或手工重启你启动 dsh web / 桌面的方式"
echo "  2) 重启后看面板： http://localhost:3080/purge2"
echo "  3) 看状态：      node \"$REPO/bin/dsh-purge2.js\" selfcheck"
echo
echo "  卸载： $DSH_BIN plugin --profile $PROFILE remove dsh-purge2"
echo "  回滚补丁： node \"$REPO/bin/dsh-purge2.js\" revert"
