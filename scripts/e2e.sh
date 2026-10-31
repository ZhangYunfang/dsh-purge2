#!/usr/bin/env bash
# dsh-purge2 端到端验收：在沙箱 DSH_HOME 上跑完整 CLI 链路
#
# 为什么用沙箱：验收要证明"引擎在真实布局上是对的"，不该先动用户正在跑的安装。
# 沙箱从真实产物**复制**目标文件，其余按 DSH 目录结构摆好，
# 再用 DSH_HOME 把 CLI 指过去——走的是和生产完全相同的代码路径。
#
# 断言链：probe → plan(只读) → apply → verify → selfcheck → 幂等 → backup → rollback → revert
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node "$REPO/bin/dsh-purge2.js")
REAL_HOME="${DSH_HOME:-$HOME/.dsh}"
REAL_AI="$REAL_HOME/profiles/node_modules/@deepseek-ai"

PASS=0
FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head1(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ ! -d "$REAL_AI" ]; then
  echo "找不到真实 @deepseek-ai ${REAL_AI} —— 本机没装 DSH？跳过 e2e。"
  exit 0
fi

SANDBOX="$(mktemp -d -t purge2-e2e-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/profiles/node_modules/@deepseek-ai"

# 只复制补丁目标包，保持真实目录形状
for pkg in dsh-agent-instructions dsh-sandbox-policy dsh-sandbox dsh-tool-bash dsh-tool-pwsh dsh-user-approval dsh-fs-observation-policy dsh-tool-fs dsh-system-prompt; do
  [ -d "$REAL_AI/$pkg" ] || continue
  mkdir -p "$SANDBOX/profiles/node_modules/@deepseek-ai/$pkg/lib"
  cp "$REAL_AI/$pkg/package.json" "$SANDBOX/profiles/node_modules/@deepseek-ai/$pkg/" 2>/dev/null || true
  cp "$REAL_AI/$pkg"/lib/*.js "$SANDBOX/profiles/node_modules/@deepseek-ai/$pkg/lib/" 2>/dev/null || true
done

export DSH_HOME="$SANDBOX"

head1 "1/9 probe —— 宿主指纹与锚点（只读）"
if "${CLI[@]}" probe >"$SANDBOX/probe.txt" 2>&1; then
  ok "probe 退出码 0"
  grep -q "轨道 legacy-0.1" "$SANDBOX/probe.txt" && ok "识别轨道 legacy-0.1" || bad "未识别轨道"
  grep -qE "→ [1-9][0-9]*/[1-9][0-9]* 可打" "$SANDBOX/probe.txt" && ok "有可打补丁" || bad "无可打补丁"
else
  bad "probe 失败"
  cat "$SANDBOX/probe.txt"
fi

head1 "2/9 plan —— 只读，必须不写盘"
BEFORE=$(find "$SANDBOX/profiles/node_modules/@deepseek-ai" -name '*.js' -o -name '*.bak' | xargs shasum 2>/dev/null | shasum | cut -d' ' -f1)
"${CLI[@]}" plan >"$SANDBOX/plan.txt" 2>&1
AFTER=$(find "$SANDBOX/profiles/node_modules/@deepseek-ai" -name '*.js' -o -name '*.bak' | xargs shasum 2>/dev/null | shasum | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] && ok "plan 未改变任何字节" || bad "plan 写了文件"
[ "$(find "$SANDBOX/profiles/node_modules/@deepseek-ai" -name '*.dshpurge2.bak' | wc -l | tr -d ' ')" = "0" ] && ok "plan 未创建备份" || bad "plan 创建了备份"

head1 "3/9 apply —— 写盘 + 逐条状态"
"${CLI[@]}" apply >"$SANDBOX/apply.txt" 2>&1
grep -q "健康度 green" "$SANDBOX/apply.txt" && ok "apply 后健康度 green" || { bad "apply 健康度非 green"; cat "$SANDBOX/apply.txt"; }
for id in S1 S2 S3 S4 S5 S6 S7; do
  grep -qE "✓ $id " "$SANDBOX/apply.txt" && ok "$id 已生效" || bad "$id 未生效"
done

head1 "4/9 幂等 —— 再 apply 一次必须全 already 且字节不变"
B1=$(find "$SANDBOX/profiles/node_modules/@deepseek-ai" -name '*.js' | xargs shasum | shasum | cut -d' ' -f1)
"${CLI[@]}" apply >"$SANDBOX/apply2.txt" 2>&1
B2=$(find "$SANDBOX/profiles/node_modules/@deepseek-ai" -name '*.js' | xargs shasum | shasum | cut -d' ' -f1)
[ "$B1" = "$B2" ] && ok "第二次 apply 字节不变（幂等）" || bad "第二次 apply 改动了字节"
grep -qc "" /dev/null 2>/dev/null || true
if grep -q "✓ S1" "$SANDBOX/apply2.txt"; then
  ALREADY=$(node -e '
    const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");
    console.log((t.match(/already/g)||[]).length);
  ' "$SANDBOX/apply2.txt")
  [ "${ALREADY:-0}" -ge 1 ] && ok "第二次 apply 报 already=$ALREADY" || bad "没有 already 状态"
else
  bad "第二次 apply 没有 ✓ 行"
fi

head1 "5/9 verify —— 三级证据链"
"${CLI[@]}" verify >"$SANDBOX/verify.txt" 2>&1
grep -q "E1 静态" "$SANDBOX/verify.txt" && ok "verify 输出 E1" || bad "verify 缺 E1"
grep -qE "✓ S[0-9]" "$SANDBOX/verify.txt" && ok "E1 有生效文件" || bad "E1 没有生效文件"
grep -q "未观察到审批请求" "$SANDBOX/verify.txt" && ok "E3 未知态如实标注（≠未生效）" || bad "E3 表达不当"

head1 "6/9 selfcheck —— 分层证明"
"${CLI[@]}" selfcheck >"$SANDBOX/self.txt" 2>&1
grep -q "本层没了" "$SANDBOX/self.txt" && ok "每层都有 why" || bad "缺 why"
grep -qE "自检  ·  (GREEN|YELLOW)" "$SANDBOX/self.txt" && ok "自检有状态" || bad "自检无状态"
"${CLI[@]}" selfcheck --json >"$SANDBOX/self.json" 2>&1
GREEN=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).counts.green)}catch(e){console.log(-1)}' "$SANDBOX/self.json")
[ "${GREEN:-0}" -ge 5 ] && ok "5 层全部文件级绿 green=${GREEN}" || bad "文件级绿层数不足 green=${GREEN}"

head1 "7/9 backup —— 快照可建可列"
"${CLI[@]}" backup create >"$SANDBOX/bk.txt" 2>&1
BID=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.id||"")}catch(e){console.log("")}' "$SANDBOX/bk.txt")
[ -n "$BID" ] && ok "快照已创建 $BID" || bad "快照创建失败"
"${CLI[@]}" backup list >"$SANDBOX/bkl.txt" 2>&1
grep -q "快照" "$SANDBOX/bkl.txt" && ok "backup list 可用" || bad "backup list 失败"

head1 "8/9 rollback —— 篡改后回滚必须逐字节还原"
TARGET="$SANDBOX/profiles/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js"
sha_orig=$(shasum -a 256 "$TARGET" | cut -d' ' -f1)
printf '\n// tampered by e2e\n' >> "$TARGET"
sha_bad=$(shasum -a 256 "$TARGET" | cut -d' ' -f1)
[ "$sha_orig" != "$sha_bad" ] && ok "已篡改（sha 变化）" || bad "篡改未生效"
"${CLI[@]}" rollback "$BID" >"$SANDBOX/rb.txt" 2>&1
sha_back=$(shasum -a 256 "$TARGET" | cut -d' ' -f1)
[ "$sha_orig" = "$sha_back" ] && ok "回滚后 sha 与快照一致" || { bad "回滚未还原"; cat "$SANDBOX/rb.txt"; }

head1 "9/9 revert —— 回到原始宿主"
"${CLI[@]}" revert >"$SANDBOX/rv.txt" 2>&1
grep -q "已还原" "$SANDBOX/rv.txt" && ok "revert 执行" || bad "revert 未执行"
LEFTOVER=$(find "$SANDBOX/profiles/node_modules/@deepseek-ai" -name '*.dshpurge2.bak' | wc -l | tr -d ' ')
[ "$LEFTOVER" = "0" ] && ok "无残留 .bak" || bad "残留 $LEFTOVER 个 .bak"
"${CLI[@]}" selfcheck >"$SANDBOX/self2.txt" 2>&1
grep -qE "pending" "$SANDBOX/self2.txt" && ok "revert 后分层回到 pending" || bad "revert 后状态不对"

printf '\n\033[1m合计：PASS=%d FAIL=%d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && { printf '\033[32mE2E: PASS\033[0m\n'; exit 0; } || { printf '\033[31mE2E: FAIL\033[0m\n'; exit 1; }
