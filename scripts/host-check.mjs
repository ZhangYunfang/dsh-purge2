/**
 * 进程内全链路验收（host-check）—— 把 E1/E2/E3 三级证据全部跑出**真实值**
 *
 * 与前两个冒烟的分工：
 *   · mount.smoke.mjs  —— 只验注入进没进 assemble（E2）
 *   · web.smoke.mjs    —— 只验面板与 API（HTTP）
 *   · 本脚本           —— 用真实 cordis + 真实 SystemPrompt，在**沙箱 aiBase** 上
 *                         把「打补丁 → 注入 → 审批放行 → 策略纠正 → 三级证据」整条链跑一遍
 *
 * 为什么不直接动真安装：验收要能随时重跑且不留副作用；沙箱用的是真实产物副本，
 * 走的是和生产完全一样的代码路径（DSH_HOME 指过去即可）。
 *
 * 断言（12 项）：
 *   1  插件挂载成功
 *   2...8  七条补丁 E1 静态生效（marker 命中）
 *   9  E2 注入真的进了 assemble
 *   10 E3 审批放行被观测到（approval/request → allowed-once）
 *   11 E3 策略保持器把 never 纠正成 ask
 *   12 verify() 汇总 health = green
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const reqProfile = createRequire(path.join(os.homedir(), ".dsh", "profiles", "web", "package.json"));

let ok = true;
const chk = (name, cond, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) ok = false;
};

// ── 1. 造沙箱：把真实产物复制进一个假 DSH_HOME ──────────────────────
const REAL_AI = path.join(os.homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai");
if (!fs.existsSync(REAL_AI)) {
  console.log("SKIP 本机没装 DSH");
  process.exit(0);
}

const { SOURCE_PATCHES } = await import(`${REPO}/lib/patches/legacy-0.1.js`);
const pkgs = new Set();
for (const p of SOURCE_PATCHES) for (const t of p.targets) pkgs.add(t.pkg);
// system-prompt 也复制：注入要挂真实服务
pkgs.add("dsh-system-prompt");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-hostcheck-"));
const aiDir = path.join(sandbox, "profiles", "node_modules", "@deepseek-ai");
for (const pkg of pkgs) {
  const src = path.join(REAL_AI, pkg);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(aiDir, pkg);
  fs.mkdirSync(path.join(dst, "lib"), { recursive: true });
  try {
    fs.copyFileSync(path.join(src, "package.json"), path.join(dst, "package.json"));
  } catch {
    /* 没有也行 */
  }
  for (const f of fs.readdirSync(path.join(src, "lib"))) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(src, "lib", f), path.join(dst, "lib", f));
  }
}
process.env.DSH_HOME = sandbox;

// ── 2. 真实 cordis + 真实 SystemPrompt ──────────────────────────────
const { Context } = reqProfile("@deepseek-ai/cordis");
const spMod = reqProfile("@deepseek-ai/dsh-system-prompt");
const ctx = new Context();

ctx.plugin(spMod.default ?? spMod.SystemPrompt ?? spMod, { includeHarnessIdentity: true, persona: "" });
await new Promise((r) => setTimeout(r, 80));
chk("真实 systemPrompt 服务就绪", typeof ctx.get?.("systemPrompt")?.assemble === "function");

// ── 3. 挂本插件（autoApplyOnStart=true 走真实 apply 路径）────────────
const ours = await import(`${REPO}/lib/index.js`);
ctx.plugin({ name: ours.name, inject: ours.inject, apply: ours.apply }, { autoApplyOnStart: true });
await new Promise((r) => setTimeout(r, 300));
const handle = ours.getHandle();
chk("插件挂载并暴露句柄", !!handle && Array.isArray(handle.patches));

// ── 4. E1：七条补丁的 marker 真的进了沙箱产物 ──────────────────────
const { hasMarker } = await import(`${REPO}/lib/patch-engine.js`);
let e1ok = 0;
for (const p of SOURCE_PATCHES) {
  let found = false;
  for (const t of p.targets) {
    const fp = path.join(aiDir, t.pkg, ...t.rel);
    try {
      if (hasMarker(fs.readFileSync(fp, "utf8"), p.markers)) found = true;
    } catch {
      /* 文件不在 */
    }
  }
  if (found) e1ok += 1;
  chk(`E1 ${p.id} ${p.name} marker 命中`, found);
}
chk(`E1 汇总 ${e1ok}/${SOURCE_PATCHES.length} 条生效`, e1ok === SOURCE_PATCHES.length);

// ── 5. E2：注入真的进了 assemble ───────────────────────────────────
const asm = await ctx.get("systemPrompt").assemble({});
const names = (asm.sections || []).map((s) => s.name);
chk("E2 assemble 含 purge2:operator", names.includes("purge2:operator"), `sections=${names.length}`);
chk("E2 锚点在末尾（抢 recency）", names[names.length - 1] === "purge2:anchor");

const inj = await import(`${REPO}/lib/inject-engine.js`);
chk("E2 注入统计已记录", inj.injectionStats.assembles > 0, `assembles=${inj.injectionStats.assembles}`);

// ── 6. E3-a：审批放行真的被调用 ────────────────────────────────────
const grantMod = await import(`${REPO}/lib/runtime/approval-grant.js`);
const before = grantMod.approvalGrantStats.granted;
let outcome = null;
try {
  // cordis waterfall：优先 (thisArg, name, ...args)，退化 (name, ...args)
  outcome = await ctx.waterfall({}, "approval/request", { toolName: "e2e-bash" }, () => Promise.resolve("unavailable"));
} catch {
  try {
    outcome = await ctx.waterfall("approval/request", { toolName: "e2e-bash" }, () => Promise.resolve("unavailable"));
  } catch (e) {
    outcome = `dispatch-failed: ${e.message}`;
  }
}
chk(
  "E3 approval/request → allowed-once",
  outcome === "allowed-once",
  `outcome=${String(outcome).slice(0, 60)}`,
);
chk(
  "E3 放行计数增加",
  grantMod.approvalGrantStats.granted > before,
  `granted=${grantMod.approvalGrantStats.granted}`,
);

// ── 7. E3-b：策略保持器把 never 纠正成 ask ─────────────────────────
const keeperMod = await import(`${REPO}/lib/runtime/policy-keeper.js`);
const flipsBefore = keeperMod.policyKeeperStats.flips;
const fakeSession = {
  events: [{ type: "approval/policy", data: { policy: "never" } }],
  appended: [],
  append(type, data) {
    this.appended.push({ type, data });
  },
};
let flipErr = null;
try {
  const l = ctx.getListeners?.("session/created") || [];
  for (const fn of l) await fn(fakeSession);
  if (l.length === 0) {
    // 退化为直接驱动：cordis 的监听器不一定能被枚举，用 emit 试一次
    await ctx.emit?.("session/created", fakeSession);
  }
} catch (e) {
  flipErr = e.message;
}
await new Promise((r) => setTimeout(r, 60));
const flipped =
  fakeSession.appended.some((a) => a.type === "approval/policy" && a.data.policy === "ask") ||
  keeperMod.policyKeeperStats.flips > flipsBefore;
chk("E3 策略保持器：never → ask", flipped, flipErr ? `err=${flipErr}` : `flips=${keeperMod.policyKeeperStats.flips}`);

// ── 8. 汇总：verify() 必须 green ───────────────────────────────────
const v = handle.verify();
console.log(
  `\n  verify 汇总：health=${v.health}  E1生效=${v.e1.filter((x) => x.markerFound).length}/${v.e1.length}` +
    `  E2=${v.e2.ok}  E3=${v.e3.ok}（放行 ${v.e3.approvalGranted}，纠正 ${v.e3.policyFlips}）`,
);
chk("verify 健康度 green", v.health === "green", `health=${v.health}`);
chk("E2 证据 ok", v.e2.ok === true);
chk("E3 证据 ok", v.e3.ok === true);

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(ok ? "\nHOST-CHECK: PASS" : "\nHOST-CHECK: FAIL");
await new Promise((r) => setTimeout(r, 50));
process.exit(ok ? 0 : 1);
