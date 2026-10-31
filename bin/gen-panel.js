#!/usr/bin/env node
/** 生成面板到 dist/panel.html（供 verify_ui.py 门禁与离线查看） */
import fs from "node:fs";
import path from "node:path";
import { buildPanelHtml, loadThemeCss } from "../lib/panel.js";
import { buildHostProfile } from "../lib/host-probe.js";
import { planPatches, summarize, hasMarker } from "../lib/patch-engine.js";
import { SOURCE_PATCHES } from "../lib/patches/legacy-0.1.js";
import { rollupLayers } from "../lib/selfcheck.js";
import { verifyAll, read as readEvidence } from "../lib/evidence.js";
import { listBackups, backupsUsage } from "../lib/backup.js";
import { readAudit } from "../lib/audit.js";
import { injectionStats } from "../lib/inject-engine.js";
import { approvalGrantStats } from "../lib/runtime/approval-grant.js";
import { policyKeeperStats } from "../lib/runtime/policy-keeper.js";

const theme = loadThemeCss();
if (!theme.css) {
  console.error("找不到 ui-iron-law 的 theme.css；设置 UI_IRON_LAW_THEME 或先安装该技能");
  process.exit(1);
}
const profile = buildHostProfile(process.env);
const rows = planPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
const ev = verifyAll({ aiBase: profile.aiBase, patchSet: SOURCE_PATCHES, hasMarker, injectionStats, approvalGrantStats, policyKeeperStats });
const html = buildPanelHtml({
  profile, rows, summary: summarize(rows),
  selfcheck: rollupLayers({ rows, evidence: { e2: ev.e2, e3: ev.e3 } }),
  evidence: ev,
  backups: backupsUsage(profile.dshHome),
  audit: readAudit(profile.dshHome, 20),
  snapshotAt: new Date().toISOString(),
});
const out = path.join(process.cwd(), "dist", "panel.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, "utf8");
console.log(`wrote ${out} bytes=${html.length} theme=${theme.file}`);
