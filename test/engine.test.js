/**
 * P0 验收测试：在真实产物的**副本**上跑 apply / 幂等 / revert。
 *
 * 为什么不直接 apply 到真安装：真安装改的是用户正在使用的 DSH，
 * 验收应该先证明"引擎是对的"，再让用户授权写。
 *
 * 断言：
 *   1. apply 后三条补丁都 applied
 *   2. 第二次 apply 全部 already（幂等，字符数不再增长）
 *   3. 备份文件生成且内容等于原始
 *   4. revert 后文件与原始**逐字节相同**
 *   5. 篡改一个锚点后引擎报 unmatched 且不写盘（拒写优先）
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatches, planPatches, revertPatches, STATUS } from "../lib/patch-engine.js";
import { SOURCE_PATCHES } from "../lib/patches/legacy-0.1.js";
import { buildHostProfile } from "../lib/host-probe.js";

const profile = buildHostProfile(process.env);
const hasHost = profile.aiBaseFound;

/** 把被补丁目标文件复制到一个临时 aiBase，模拟一次"安全的真机" */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-"));
  const originals = new Map();
  for (const p of SOURCE_PATCHES) {
    for (const t of p.targets) {
      const src = path.join(profile.aiBase, t.pkg, ...t.rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(root, t.pkg, ...t.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      originals.set(dst, fs.readFileSync(src));
    }
  }
  return { root, originals };
}

test("apply → 幂等 → revert 逐字节还原", { skip: !hasHost && "no host installed" }, () => {
  const { root, originals } = makeSandbox();
  assert.ok(originals.size >= 3, `expected >=3 target files, got ${originals.size}`);

  // 1) 首次 apply
  const first = applyPatches(root, SOURCE_PATCHES, profile.track);
  assert.equal(first.summary.health, "green", JSON.stringify(first.summary));
  assert.equal(first.rows.filter((r) => r.status === STATUS.APPLIED).length, 3);

  // 2) 幂等：第二次必须全 already，且字节不再变化
  const afterFirst = new Map([...originals.keys()].map((f) => [f, fs.readFileSync(f)]));
  const second = applyPatches(root, SOURCE_PATCHES, profile.track);
  assert.equal(second.rows.filter((r) => r.status === STATUS.ALREADY).length, 3);
  assert.equal(second.rows.filter((r) => r.status === STATUS.APPLIED).length, 0);
  for (const [f, buf] of afterFirst) {
    assert.ok(fs.readFileSync(f).equals(buf), `file changed on second apply: ${f}`);
  }

  // 3) 备份存在
  for (const f of originals.keys()) {
    assert.ok(fs.existsSync(`${f}.dshpurge2.bak`), `missing bak for ${f}`);
  }

  // 4) revert 逐字节还原
  const reverted = revertPatches(root, SOURCE_PATCHES);
  assert.equal(reverted.filter((r) => r.status === "reverted").length, 3);
  for (const [f, buf] of originals) {
    assert.ok(fs.readFileSync(f).equals(buf), `revert mismatch: ${f}`);
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test("锚点被篡改 → 拒写，文件不变", { skip: !hasHost && "no host installed" }, () => {
  const { root, originals } = makeSandbox();
  // 弄坏 S3 的一个锚点
  const f = path.join(root, "dsh-tool-fs", "lib", "index.js");
  const text = fs.readFileSync(f, "utf8").replace("const READ_LIMIT = 2e3;", "const READ_LIMIT = 9999;");
  fs.writeFileSync(f, text);
  const before = fs.readFileSync(f);

  const rep = applyPatches(root, SOURCE_PATCHES, profile.track);
  const s3 = rep.rows.find((r) => r.id === "S3");
  assert.equal(s3.status, STATUS.HIT_MISMATCH);
  assert.ok(fs.readFileSync(f).equals(before), "engine wrote despite hit mismatch");
  // 其它补丁照常打
  assert.equal(rep.rows.find((r) => r.id === "S1").status, STATUS.APPLIED);
  assert.equal(rep.summary.health, "red");

  fs.rmSync(root, { recursive: true, force: true });
});

test("plan 是纯只读：不改任何字节", { skip: !hasHost && "no host installed" }, () => {
  const { root, originals } = makeSandbox();
  planPatches(root, SOURCE_PATCHES, profile.track);
  for (const [f, buf] of originals) {
    assert.ok(fs.readFileSync(f).equals(buf), `plan wrote to ${f}`);
    assert.ok(!fs.existsSync(`${f}.dshpurge2.bak`), `plan created bak for ${f}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
