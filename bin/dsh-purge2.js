#!/usr/bin/env node
/**
 * dsh-purge2 CLI —— 只做四件事：probe / plan / apply / revert（+ status）
 *
 * 默认**只读**。plan 绝不写盘；apply 才写，且每条改动前先建 .bak。
 */

import fs from "node:fs";
import path from "node:path";
import { buildHostProfile, probeAnchors } from "../lib/host-probe.js";
import { applyPatches, planPatches, revertPatches, summarize, STATUS } from "../lib/patch-engine.js";
import { SOURCE_PATCHES } from "../lib/patches/legacy-0.1.js";
import { CONFIG_SEAMS, APPROVAL_POLICY_NOTES } from "../lib/config-seams.js";
import { verifyAll, read as readEvidence } from "../lib/evidence.js";
import { hasMarker } from "../lib/patch-engine.js";
import { injectionStats } from "../lib/inject-engine.js";
import { approvalGrantStats } from "../lib/runtime/approval-grant.js";
import { policyKeeperStats } from "../lib/runtime/policy-keeper.js";
import { rollupLayers, formatSelfcheck } from "../lib/selfcheck.js";
import { logAudit, readAudit } from "../lib/audit.js";
import { createBackup, listBackups, restoreBackup, pruneBackups, backupsUsage } from "../lib/backup.js";

const argv = process.argv.slice(2);
const op = argv[0] || "status";
const json = argv.includes("--json");
const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

function collectAnchors() {
  const set = new Set();
  for (const p of SOURCE_PATCHES) {
    for (const v of p.variants || []) {
      for (const op of v.ops || []) {
        if (typeof op.pattern === "string") set.add(op.pattern);
      }
    }
  }
  return [...set];
}

function fmtRow(r) {
  const icon =
    r.status === STATUS.APPLIED || r.status === STATUS.ALREADY
      ? "✓"
      : r.status === STATUS.PENDING
        ? "·"
        : r.status === STATUS.NA || r.status === STATUS.MISSING_FILE
          ? "-"
          : "!";
  return `  ${icon} ${String(r.id).padEnd(3)} ${r.name.padEnd(30)} ${r.status.padEnd(18)} ${r.reason || ""}`;
}

try {
  const profile = buildHostProfile(process.env);

  if (op === "probe") {
    const anchors = probeAnchors(profile.aiBase, SOURCE_PATCHES.flatMap((p) => p.targets), collectAnchors());
    if (json) {
      out({ profile, anchors });
    } else {
      console.log("宿主 / HostProfile");
      console.log(`  DSH_HOME   ${profile.dshHome}`);
      console.log(`  aiBase     ${profile.aiBase}${profile.aiBaseFound ? "" : "  (未找到)"}`);
      console.log(`  版本       ${profile.dshVersion}   轨道 ${profile.track}   面 ${profile.surface}`);
      console.log("");
      console.log("锚点探针（只读）");
      for (const [file, info] of Object.entries(anchors)) {
        const total = Object.values(info.counts).reduce((s, n) => s + n, 0);
        console.log(`  ${file}  ${info.exists ? "存在" : "缺失"}  命中 ${total}`);
      }
      console.log("");
      console.log("补丁可行性");
      const rows = planPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
      rows.forEach((r) => console.log(fmtRow(r)));
      const s = summarize(rows);
      console.log(`  → ${s.ready + s.good}/${s.applicable} 可打，健康度 ${s.health}`);
    }
    process.exit(0);
  }

  if (op === "plan" || op === "status") {
    const rows = planPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
    const summary = summarize(rows);
    if (json) {
      out({ profile, rows, summary, configSeams: CONFIG_SEAMS });
    } else {
      console.log(`dsh-purge2 ${op}  ·  ${profile.dshVersion} (${profile.track})`);
      console.log("");
      rows.forEach((r) => {
        console.log(fmtRow(r));
        for (const f of r.files) {
          const tag = f.op === "patch" ? `将改 (命中 ${f.hits.join("+")}, ${f.delta > 0 ? "+" : ""}${f.delta} 字符)` : f.marker ? "已是目标状态" : f.exists === false ? "文件缺失" : "锚点不匹配";
          console.log(`        ${path.basename(String(f.file))}  ${tag}`);
        }
      });
      console.log("");
      console.log(`健康度 ${summary.health}  ·  可打 ${summary.ready + summary.good}/${summary.applicable}`);
      console.log("");
      console.log("配置通道（不用改源码，已写在本包 cordis.patch.yml）");
      for (const s of CONFIG_SEAMS) console.log(`  · ${s.id} ${s.name}  → ${JSON.stringify(s.config)}`);
      console.log("");
      console.log(`⚠ ${APPROVAL_POLICY_NOTES.policyNever}`);
    }
    process.exit(0);
  }

  if (op === "apply") {
    const snap = createBackup(profile.dshHome, profile.aiBase, SOURCE_PATCHES, {
      dshVersion: profile.dshVersion,
      track: profile.track,
      reason: "before-apply",
    });
    const report = applyPatches(profile.aiBase, SOURCE_PATCHES, profile.track, {
      enableOptIn: argv.includes("--enable-opt-in"),
    });
    logAudit(profile.dshHome, {
      action: "apply",
      result: report.summary.health,
      detail: { by: report.summary.by, backup: snap?.id || null },
    });
    if (json) out({ ...report, backup: snap?.id || null });
    else {
      console.log(`apply 完成  ·  健康度 ${report.summary.health}${snap?.id ? `  ·  快照 ${snap.id}` : ""}`);
      if (report.restored.length) console.log(`  自愈还原 ${report.restored.length} 个文件`);
      report.rows.forEach((r) => console.log(fmtRow(r)));
      console.log("");
      console.log("重启 DSH 后补丁才会加载（插件/宿主在进程启动时读取产物）。");
    }
    process.exit(report.summary.health === "red" ? 1 : 0);
  }

  if (op === "verify" || op === "evidence") {
    if (op === "evidence") {
      const rows = readEvidence(profile.dshHome, Number(argv[1]) || 30);
      if (json) out(rows);
      else {
        console.log(`证据 ${rows.length} 条  ·  ${path.join(profile.dshHome, "purge2", "evidence")}`);
        for (const r of rows) console.log(`  ${r.at}  ${String(r.level).padEnd(3)} ${JSON.stringify({ ...r, at: undefined, level: undefined })}`);
      }
      process.exit(0);
    }
    const v = verifyAll({
      aiBase: profile.aiBase,
      patchSet: SOURCE_PATCHES,
      hasMarker,
      injectionStats,
      approvalGrantStats,
    });
    if (json) out(v);
    else {
      console.log(`三级证据链  ·  健康度 ${v.health}`);
      console.log("");
      console.log("E1 静态（文件字节 + marker）");
      for (const r of v.e1) {
        const icon = r.markerFound === true ? "✓" : r.markerFound === false ? "·" : "?";
        console.log(`  ${icon} ${String(r.id).padEnd(3)} ${r.file.padEnd(42)} sha ${r.sha || "-"}`);
      }
      console.log("");
      console.log(`E2 运行时注入  ${v.e2.ok === true ? "✓ 已观察到" : v.e2.ok === null ? "? 尚未 assemble（进程内未挂载时正常）" : "✗ " + v.e2.reason}`);
      if (v.e2.ok) console.log(`     assembles=${v.e2.assembles} 注入 ${v.e2.injectedBytes}B sha=${v.e2.injectedSha} 段位=${v.e2.anchorIndex} 耗时=${v.e2.costMs}ms`);
      console.log(`E3 行为钩子    ${v.e3.ok === true ? `✓ 已放行 ${v.e3.approvalGranted} 次` : "? 未观察到审批请求（≠未生效）"}`);
      console.log("");
      console.log("注：CLI 是独立进程，E2/E3 只在 DSH 进程内才有观测值；此处显示 ? 是正常的。");
    }
    process.exit(v.health === "red" ? 1 : 0);
  }

  if (op === "selfcheck") {
    const rows = planPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
    const result = rollupLayers({
      rows,
      evidence: { e2: { ok: null }, e3: { ok: null } },
    });
    if (json) out(result);
    else console.log(formatSelfcheck(result, SOURCE_PATCHES));
    process.exit(result.state === "red" ? 1 : 0);
  }

  if (op === "audit") {
    const rows = readAudit(profile.dshHome, Number(argv[1]) || 30);
    if (json) out(rows);
    else {
      console.log(`审计 ${rows.length} 条`);
      for (const r of rows) console.log(`  ${r.at}  ${r.action.padEnd(10)} ${r.result.padEnd(8)} ${JSON.stringify(r.detail)}`);
    }
    process.exit(0);
  }

  if (op === "backup") {
    const sub = argv[1] || "list";
    let result;
    if (sub === "create") {
      result = createBackup(profile.dshHome, profile.aiBase, SOURCE_PATCHES, {
        dshVersion: profile.dshVersion,
        track: profile.track,
        reason: "cli",
      });
      logAudit(profile.dshHome, { action: "backup", detail: { id: result?.id } });
    } else if (sub === "prune") {
      result = pruneBackups(profile.dshHome, Number(argv[2]) || 10);
    } else if (sub === "usage") {
      result = backupsUsage(profile.dshHome);
    } else {
      result = listBackups(profile.dshHome);
    }
    if (json) out(result);
    else if (Array.isArray(result)) {
      console.log(`快照 ${result.length} 份`);
      for (const b of result) console.log(`  ${b.id}  ${b.at}  ${b.reason}  ${b.files} 文件 ${Math.round((b.bytes || 0) / 1024)}KB`);
    } else console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (op === "rollback") {
    const id = argv[1];
    if (!id) {
      console.error("用法：dsh-purge2 rollback <快照ID>   （先 dsh-purge2 backup list 看有哪些）");
      process.exit(2);
    }
    const res = restoreBackup(profile.dshHome, profile.aiBase, id);
    logAudit(profile.dshHome, { action: "rollback", detail: { id, ...res } });
    if (json) out(res);
    else {
      console.log(`回滚 ${res.verified ? "已校验" : "校验失败"}  ·  还原 ${res.restored}  跳过 ${res.skipped}`);
      for (const e of res.errors) console.log(`  ✗ ${e}`);
      if (res.restored) console.log("\n重启 DSH 生效。");
    }
    process.exit(res.errors.length ? 1 : 0);
  }

  if (op === "revert") {
    const rows = revertPatches(profile.aiBase, SOURCE_PATCHES);
    logAudit(profile.dshHome, {
      action: "revert",
      result: rows.some((r) => r.status === "error") ? "partial" : "ok",
      detail: { reverted: rows.filter((r) => r.status === "reverted").length },
    });
    if (json) out(rows);
    else {
      for (const r of rows) console.log(`  ${r.status === "reverted" ? "✓" : "-"} ${r.file}  ${r.status}`);
      console.log("");
      console.log("已还原；重启 DSH 生效。");
    }
    process.exit(0);
  }

  console.error(`用法：dsh-purge2 <probe|plan|status|apply|revert|verify|evidence|selfcheck|audit|backup|rollback> [--json] [--enable-opt-in]`);
  process.exit(2);
} catch (e) {
  console.error(`[dsh-purge2] ${e?.stack || e}`);
  process.exit(1);
}
