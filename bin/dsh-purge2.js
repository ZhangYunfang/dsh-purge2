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
    const report = applyPatches(profile.aiBase, SOURCE_PATCHES, profile.track, {
      enableOptIn: argv.includes("--enable-opt-in"),
    });
    if (json) out(report);
    else {
      console.log(`apply 完成  ·  健康度 ${report.summary.health}`);
      if (report.restored.length) console.log(`  自愈还原 ${report.restored.length} 个文件`);
      report.rows.forEach((r) => console.log(fmtRow(r)));
      console.log("");
      console.log("重启 DSH 后补丁才会加载（插件/宿主在进程启动时读取产物）。");
    }
    process.exit(report.summary.health === "red" ? 1 : 0);
  }

  if (op === "revert") {
    const rows = revertPatches(profile.aiBase, SOURCE_PATCHES);
    if (json) out(rows);
    else {
      for (const r of rows) console.log(`  ${r.status === "reverted" ? "✓" : "-"} ${r.file}  ${r.status}`);
      console.log("");
      console.log("已还原；重启 DSH 生效。");
    }
    process.exit(0);
  }

  console.error(`用法：dsh-purge2 <probe|plan|status|apply|revert> [--json] [--enable-opt-in]`);
  process.exit(2);
} catch (e) {
  console.error(`[dsh-purge2] ${e?.stack || e}`);
  process.exit(1);
}
