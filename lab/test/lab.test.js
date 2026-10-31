/**
 * lab 层测试：资产库 / 四级证据 / 报告
 *
 * 全部用真实 node:sqlite 落临时目录，不 mock 数据库。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb,
  assetAdd,
  assetQuery,
  assetStats,
  evidenceRecord,
  evidenceList,
  evidenceHash,
  buildReport,
  LEVELS,
  labDir,
} from "../lib/index.js";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "purge2-lab-"));

test("资产：写入可查、同键覆盖、按 kind 过滤", () => {
  const home = tmpHome();
  const db = openDb(home);
  assetAdd(db, { kind: "host", key: "10.0.0.5", value: "web-01", source: "scan" });
  assetAdd(db, { kind: "host", key: "10.0.0.5", value: "web-01-updated", source: "manual" });
  assetAdd(db, { kind: "service", key: "10.0.0.5:22", value: "ssh", source: "scan" });

  const hosts = assetQuery(db, { kind: "host" });
  assert.equal(hosts.length, 1, "同 kind+key 必须覆盖而不是重复");
  assert.equal(hosts[0].value, "web-01-updated");

  const all = assetQuery(db, { q: "10.0.0.5" });
  assert.equal(all.length, 2);

  const st = assetStats(db);
  assert.equal(st.total, 2);
  assert.equal(st.byKind.find((k) => k.kind === "host").n, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("证据：四档校验、内容寻址去重、哈希对内容敏感", () => {
  const home = tmpHome();
  const db = openDb(home);

  assert.throws(() => evidenceRecord(db, { level: "true", summary: "x" }), /level must be one of/);

  const a = evidenceRecord(db, { level: "observed", summary: "22 端口 banner 是 OpenSSH 8.9" });
  assert.match(a.ev_hash, /^ev_[0-9a-f]{24}$/);

  const dup = evidenceRecord(db, { level: "observed", summary: "22 端口 banner 是 OpenSSH 8.9" });
  assert.equal(dup.duplicate, true, "同内容必须去重");

  const b = evidenceRecord(db, { level: "observed", summary: "22 端口 banner 是 OpenSSH 8.9（改一个字）" });
  assert.notEqual(b.ev_hash, a.ev_hash, "改一个字哈希必须变");

  evidenceRecord(db, { level: "claimed", summary: "子代理说拿到了 root" });
  const list = evidenceList(db, { limit: 10 });
  assert.equal(list.rows.length, 3);
  assert.equal(list.trustworthy, 2, "observed 计入可信");
  assert.equal(list.claims, 1, "claimed 单独计数，不进可信");

  assert.equal(LEVELS.length, 4);
  assert.equal(evidenceHash({ level: "inferred", summary: "x", raw: "" }), evidenceHash({ level: "inferred", summary: "x" }));
  fs.rmSync(home, { recursive: true, force: true });
});

test("报告：明确区分可信与自称，且带免责说明", () => {
  const home = tmpHome();
  const db = openDb(home);
  assetAdd(db, { kind: "host", key: "10.0.0.9", value: "db-01" });
  evidenceRecord(db, { level: "observed", summary: "3306 可连" });
  evidenceRecord(db, { level: "claimed", summary: "说能读全库" });

  const r = buildReport(db, { target: "内网 A 段" });
  assert.equal(r.target, "内网 A 段");
  assert.equal(r.stats.total, 1);
  assert.equal(r.assets.length, 1);
  assert.match(r.note, /claimed.*不可作为成果/s);
  assert.ok(r.generatedAt);
  fs.rmSync(home, { recursive: true, force: true });
});

test("数据落在 $DSH_HOME/purge2/lab/，不污染别处", () => {
  const home = tmpHome();
  const db = openDb(home);
  db.close();
  const dir = labDir(home);
  assert.ok(fs.existsSync(path.join(dir, "assets.db")), "assets.db 应在 lab 目录");
  assert.ok(dir.startsWith(home), "目录必须在给定 home 下");
  fs.rmSync(home, { recursive: true, force: true });
});
