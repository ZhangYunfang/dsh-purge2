/**
 * P3 测试：自检 / 审计 / 备份回滚
 *
 * 重点断言：
 *   1. 读不到状态 → unknown（🟡），绝不报绿
 *   2. 打了一半 → red；全绿但注入未观测 → 只能 yellow
 *   3. 备份 → 篡改产物 → 回滚 → 逐字节还原；快照自身损坏时整体不动
 *   4. 审计追加/轮转可读
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rollupLayers, formatSelfcheck } from "../lib/selfcheck.js";
import { logAudit, readAudit, auditFile } from "../lib/audit.js";
import { createBackup, listBackups, restoreBackup, pruneBackups, backupsUsage, backupsDir } from "../lib/backup.js";
import { SOURCE_PATCHES, LAYERS } from "../lib/patches/legacy-0.1.js";
import { STATUS } from "../lib/patch-engine.js";

test("自检：读不到状态必须是 unknown 而不是 green", () => {
  const r = rollupLayers({ rows: null });
  assert.equal(r.state, "unknown");
  assert.match(r.note, /不等于通过/);
  assert.equal(r.counts.green, 0);
});

test("自检：全绿但注入未观测 → 只能 yellow", () => {
  const rows = SOURCE_PATCHES.map((p) => ({ id: p.id, status: STATUS.APPLIED }));
  const r = rollupLayers({ rows, evidence: { e2: { ok: null } } });
  assert.equal(r.state, "yellow", "没有运行时证据就不能报绿");
  const g = rollupLayers({ rows, evidence: { e2: { ok: true } } });
  assert.equal(g.state, "green");
});

test("自检：打了一半 → red；显式 na 从分母剔除", () => {
  const rows = SOURCE_PATCHES.map((p) => ({ id: p.id, status: STATUS.APPLIED }));
  rows[0].status = STATUS.HIT_MISMATCH;
  assert.equal(rollupLayers({ rows }).state, "red");

  const rows2 = SOURCE_PATCHES.map((p) => ({ id: p.id, status: STATUS.APPLIED }));
  for (const l of LAYERS) for (const id of l.ids) {
    const row = rows2.find((r) => r.id === id);
    if (row) row.status = STATUS.NA;
  }
  const r2 = rollupLayers({ rows: rows2 });
  assert.equal(r2.counts.green, 0, "全部 na 时不应算作绿层");
});

test("自检：待应用（pending）是 yellow 不是 red", () => {
  const rows = SOURCE_PATCHES.map((p) => ({ id: p.id, status: STATUS.PENDING }));
  assert.equal(rollupLayers({ rows }).state, "yellow");
});

test("自检：formatSelfcheck 可读且含 why", () => {
  const rows = SOURCE_PATCHES.map((p) => ({ id: p.id, status: STATUS.APPLIED }));
  const text = formatSelfcheck(rollupLayers({ rows, evidence: { e2: { ok: true } } }), SOURCE_PATCHES);
  assert.match(text, /SELFCHECK|自检/);
  assert.match(text, /本层没了/);
});

test("审计：追加可读倒序，超过 2MB 轮转", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-audit-"));
  logAudit(home, { action: "apply", result: "ok", detail: { n: 7 } });
  logAudit(home, { action: "revert", result: "ok" });
  const rows = readAudit(home, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "revert", "倒序：最新在前");
  assert.equal(rows[1].detail.n, 7);

  // 伪造一个超大审计文件，触发轮转
  fs.writeFileSync(auditFile(home), "x".repeat(2 * 1024 * 1024 + 10));
  logAudit(home, { action: "rotate-check" });
  assert.ok(fs.existsSync(`${auditFile(home)}.1`), "应生成 .1 轮转文件");
  assert.equal(readAudit(home, 5)[0].action, "rotate-check");
  fs.rmSync(home, { recursive: true, force: true });
});

test("备份 → 篡改 → 回滚：逐字节还原并清掉 .bak", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-bk-"));
  const aiBase = path.join(home, "ai");
  // 造一份假的"宿主产物"
  const entries = [];
  const originals = new Map();
  for (const p of SOURCE_PATCHES) {
    for (const t of p.targets) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const body = `// original ${p.id} ${t.pkg}\n`;
      fs.writeFileSync(fp, body);
      entries.push(fp);
      originals.set(fp, body);
    }
  }
  const made = createBackup(home, aiBase, SOURCE_PATCHES, { dshVersion: "0.1.2-alpha.2", track: "legacy-0.1" });
  assert.ok(made.id, JSON.stringify(made));
  assert.ok(made.files >= 1);

  const listed = listBackups(home);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, made.id);
  assert.ok(backupsUsage(home).bytes > 0);

  // 篡改全部目标文件 + 造一个 .bak
  for (const fp of entries) {
    fs.writeFileSync(fp, `// MUTATED\n`);
    fs.writeFileSync(`${fp}.dshpurge2.bak`, `// bak\n`);
  }

  const res = restoreBackup(home, aiBase, made.id);
  assert.equal(res.verified, true);
  assert.ok(res.restored >= 1);
  for (const fp of entries) {
    assert.equal(fs.readFileSync(fp, "utf8"), originals.get(fp), `回滚后必须逐字节还原：${fp}`);
    assert.ok(!fs.existsSync(`${fp}.dshpurge2.bak`), "回滚后应清掉 .bak");
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("备份损坏 → 整体不动（不回滚一半）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-bk2-"));
  const aiBase = path.join(home, "ai");
  for (const p of SOURCE_PATCHES) {
    for (const t of p.targets) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, "ORIGINAL\n");
    }
  }
  const made = createBackup(home, aiBase, SOURCE_PATCHES, {});
  // 改坏快照里的第一个文件
  const firstFile = fs.readdirSync(path.join(backupsDir(home), made.id, "files"), { recursive: true })
    .find((n) => n.endsWith(".js"));
  fs.writeFileSync(path.join(backupsDir(home), made.id, "files", firstFile), "TAMPERED\n");
  // 把产物也改掉
  for (const p of SOURCE_PATCHES) for (const t of p.targets) {
    fs.writeFileSync(path.join(aiBase, t.pkg, ...t.rel), "CHANGED\n");
  }
  const res = restoreBackup(home, aiBase, made.id);
  assert.equal(res.verified, false);
  assert.ok(res.errors.some((e) => e.includes("corrupt")));
  assert.equal(res.restored, 0, "校验失败必须一个字节都不写");
  for (const p of SOURCE_PATCHES) for (const t of p.targets) {
    assert.equal(fs.readFileSync(path.join(aiBase, t.pkg, ...t.rel), "utf8"), "CHANGED\n");
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("pruneBackups 保留最近 keep 份", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-bk3-"));
  const aiBase = path.join(home, "ai");
  const p = SOURCE_PATCHES[0];
  const fp = path.join(aiBase, p.targets[0].pkg, ...p.targets[0].rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "x");
  for (let i = 0; i < 4; i += 1) createBackup(home, aiBase, [p], { reason: `no${i}` });
  assert.equal(listBackups(home).length, 4);
  const r = pruneBackups(home, 2);
  assert.equal(r.removed, 2);
  assert.equal(listBackups(home).length, 2);
  fs.rmSync(home, { recursive: true, force: true });
});
