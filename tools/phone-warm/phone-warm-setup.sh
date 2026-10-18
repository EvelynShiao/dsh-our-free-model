#!/usr/bin/env bash
# phone-warm-setup.sh —— 把「切到免费模型即预热本机 opencode 服务」装到手机上的
# dsh-our-free-model 插件里（2026-10-18）。
#
# 设计原则：
#   1. 只碰 5 个文件，改前逐个备份，校验失败自动回滚，绝不留下半坏状态。
#   2. 不下载任何东西，不装 opencode，不开机自启，不启动后台服务。
#   3. 手机上没装 opencode 也能装这个补丁：预热逻辑在无服务时返回 null，
#      不报错、不启动任何进程，行为与打补丁前完全一致。
#
# 用法（在放本脚本的目录里）：
#   bash phone-warm-setup.sh            # 干跑：只检查并报告，不改任何文件
#   bash phone-warm-setup.sh --apply    # 真的安装
set -uo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_ROOT/profiles/web/node_modules/dsh-our-free-model"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 源文件 → 目标相对路径
FILES=(
  "index.js:index.js"
  "client.js:client.js"
  "adapter.js:src/adapter.js"
  "opencode-bridge.js:src/opencode-bridge.js"
  "store.js:src/store.js"
)

printf '=== 环境 ===\n'
printf 'Arch:  '; uname -m
printf 'Node:  '; node --version 2>/dev/null || echo 'missing'
printf 'DSH:   %s\n' "$DSH_ROOT"
printf '插件:  %s\n\n' "$TARGET"

if [[ ! -d "$TARGET" ]]; then
  echo "BLOCKED: 找不到已安装的插件目录。"
  echo "先让 DSH 装好 dsh-our-free-model，再来跑这个脚本。未改动任何文件。"
  exit 3
fi

# 源文件齐不齐
missing=0
for pair in "${FILES[@]}"; do
  src="$HERE/${pair%%:*}"
  [[ -f "$src" ]] || { echo "缺文件: $src"; missing=1; }
done
if [[ $missing -ne 0 ]]; then
  echo "BLOCKED: 补丁包不完整，未改动任何文件。"
  exit 4
fi

printf '=== opencode 环境（不影响安装）===\n'
if command -v opencode >/dev/null 2>&1; then
  printf 'opencode: '; opencode --version 2>/dev/null || echo 'present'
  if [[ -f "$HOME/.local/state/opencode/service.json" ]]; then
    echo '服务: service.json 存在（当前可能在跑）'
  else
    echo '服务: 未启动（首次用免费模型时会自动拉起）'
  fi
else
  echo 'opencode: 未安装 —— 预热补丁会安静地什么都不做，免费车道本就不可用，属预期。'
fi

printf '\n=== 计划 ===\n'
for pair in "${FILES[@]}"; do
  src="$HERE/${pair%%:*}"
  dst="$TARGET/${pair##*:}"
  if [[ -f "$dst" ]]; then
    echo "  覆盖 $dst"
  else
    echo "  新增 $dst"
  fi
done

if [[ $APPLY -ne 1 ]]; then
  printf '\n这是干跑。确认无误后加 --apply 真正安装。\n'
  exit 0
fi

BK="$TARGET/.warm-patch-backup-$STAMP"
mkdir -p "$BK/src"
printf '\n=== 备份 → %s ===\n' "$BK"
for pair in "${FILES[@]}"; do
  dst="$TARGET/${pair##*:}"
  [[ -f "$dst" ]] && cp -p "$dst" "$BK/${pair##*:}" 2>/dev/null && echo "  backed ${pair##*:}"
done

rollback() {
  echo '!! 校验失败，回滚'
  for pair in "${FILES[@]}"; do
    rel="${pair##*:}"
    if [[ -f "$BK/$rel" ]]; then
      cp -p "$BK/$rel" "$TARGET/$rel" && echo "  restored $rel"
    fi
  done
  echo "回滚完成。原文件在 $BK"
  exit 5
}

printf '\n=== 安装 ===\n'
for pair in "${FILES[@]}"; do
  src="$HERE/${pair%%:*}"
  dst="$TARGET/${pair##*:}"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst" && echo "  wrote ${pair##*:}"
done

printf '\n=== 校验 ===\n'
node --check "$TARGET/index.js" 2>&1 || rollback
echo '  index.js 语法 OK'
node --check "$TARGET/src/adapter.js" 2>&1 || rollback
echo '  src/adapter.js 语法 OK'
node --check "$TARGET/src/opencode-bridge.js" 2>&1 || rollback
echo '  src/opencode-bridge.js 语法 OK'
node --check "$TARGET/src/store.js" 2>&1 || rollback
echo '  src/store.js 语法 OK'
node --check "$TARGET/client.js" 2>&1 || rollback
echo '  client.js 语法 OK'

# 关键锚点必须都在
grep -q "warm bridge on model selection" "$TARGET/index.js" || rollback
grep -q "ensureService" "$TARGET/index.js" || rollback
grep -q "export function configureBridge" "$TARGET/src/opencode-bridge.js" || rollback
grep -q "export async function ensureService" "$TARGET/src/opencode-bridge.js" || rollback
echo '  预热监听器 / ensureService / configureBridge 均在位'

printf '\n=== 闲置关停阈值 ===\n'
SETTINGS="$DSH_ROOT/our-free-model/settings.json"
if [[ -f "$SETTINGS" ]]; then
  cur=$(node -e "try{const s=require('fs').readFileSync('$SETTINGS','utf8');const j=JSON.parse(s);console.log((j.bridge&&j.bridge.idleStopMinutes)!==undefined?j.bridge.idleStopMinutes:'unset')}catch(e){console.log('parse-error')}" 2>/dev/null)
  echo "  当前 idleStopMinutes = $cur"
  if [[ "$cur" == "1" || "$cur" == "0" ]]; then
    echo '  注意：0 = 常驻；1 = 闲置一分钟就收，预热会被它抵消。建议 10。'
    echo '  改法：DSH 设置 → our free model → 闲置自动关闭，填 10。'
  fi
else
  echo "  未找到 $SETTINGS（插件首次运行后会生成，默认 10，无需处理）"
fi

printf '\nDONE: 重启手机 DSH 生效。本脚本没有启动 opencode 服务。\n'
printf '回滚包：%s\n' "$BK"
