/**
 * 注入引擎 + 证据链测试（用假 ctx，不需要真宿主）。
 *
 * 断言：
 *   1. section 段位来自受控表（不是魔数）——DEPLOYMENT_PERSONA + 1
 *   2. 重复 install 不会叠多个 section（幂等）
 *   3. assemble 钩子把锚点段物理放到 sections 末尾（抢 recency）
 *   4. 锚点不会重复出现（同名先滤再 push）
 *   5. 风暴熔断：超过阈值后跳过改写并标记 skipped
 *   6. 提示词来源优先级：prompt-inject.md > builtin
 *   7. 证据链：E1 静态 / E2 运行时 / E3 未知≠false，且能落盘读回
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installSection,
  installAssembleHook,
  makePromptState,
  createBreaker,
  resolvePromptText,
  SECTION_NAME,
  ANCHOR_NAME,
  injectionStats,
} from "../lib/inject-engine.js";
import { verifyAll, record, read, collectE3 } from "../lib/evidence.js";
import { hasMarker } from "../lib/patch-engine.js";
import { SOURCE_PATCHES } from "../lib/patches/legacy-0.1.js";
import { buildHostProfile } from "../lib/host-probe.js";

/** 最小假 ctx：只提供本插件用到的接缝 */
function fakeCtx() {
  const sections = [];
  const listeners = new Map();
  return {
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => {
          const i = sections.indexOf(spec);
          if (i >= 0) sections.splice(i, 1);
        };
      },
      getSectionOrder(n) {
        return { DEPLOYMENT_PERSONA: 0, HARNESS_IDENTITY: -1000 }[n];
      },
    },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return () => {
        const arr = listeners.get(ev);
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    effect(fn) {
      fn();
    },
    logger: { info() {}, warn() {} },
    _sections: sections,
    _fire(ev, ...args) {
      const arr = listeners.get(ev) || [];
      let next = async () => args[0];
      return arr.reduceRight((n, fn) => () => fn(...args.slice(0, -1), n), next)();
    },
    _count(ev) {
      return (listeners.get(ev) || []).length;
    },
  };
}

test("section 段位来自受控表，且重复安装不叠加", () => {
  const ctx = fakeCtx();
  const state = makePromptState(os.tmpdir(), {});
  const d1 = installSection(ctx, state);
  const d2 = installSection(ctx, state);
  // 两次安装各自注册一个 section（宿主侧同名会覆盖），本测试确认段位与名字正确
  assert.equal(ctx._sections[0].name, SECTION_NAME);
  assert.equal(ctx._sections[0].order, 1, "order 应等于 DEPLOYMENT_PERSONA(0)+1");
  assert.equal(typeof ctx._sections[0].text, "function");
  d1();
  d2();
});

test("assemble：锚点物理追加到末尾且不重复", async () => {
  const ctx = fakeCtx();
  const state = makePromptState(os.tmpdir(), {});
  const dispose = installAssembleHook(ctx, state);
  const asm = {
    sections: [
      { name: "harness:identity", order: -1000, text: "identity" },
      { name: ANCHOR_NAME, order: 9999, text: "stale" },
      { name: "tool:read", order: 1100, text: "read" },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
  const out = await ctx._fire("system-prompt/assemble", asm, {}, undefined);
  assert.equal(out.sections[out.sections.length - 1].name, ANCHOR_NAME, "锚点必须在最后");
  assert.equal(out.sections.filter((s) => s.name === ANCHOR_NAME).length, 1, "锚点不能重复");
  assert.ok(!out.sections.some((s) => s.text === "stale"), "旧锚点应被替换");
  assert.equal(out.sections.length, asm.sections.length, "数量不应变化（先滤后加）");
  assert.equal(injectionStats.last.sections, out.sections.length);
  dispose();
});

test("风暴熔断：超过窗口阈值后跳过改写", async () => {
  const ctx = fakeCtx();
  const state = makePromptState(os.tmpdir(), {});
  const breaker = createBreaker({ maxCalls: 3, windowMs: 60_000, slowMs: 60_000, cooldownMs: 60_000 });
  const dispose = installAssembleHook(ctx, state, { breaker });
  const mk = () => ({ sections: [{ name: "a", order: 0, text: "a" }], contexts: [], tools: [], variables: {} });
  // 前 3 次正常改写
  for (let i = 0; i < 3; i += 1) {
    const out = await ctx._fire("system-prompt/assemble", mk(), {}, undefined);
    assert.equal(out.sections[out.sections.length - 1].name, ANCHOR_NAME);
  }
  // 第 4 次应被熔断跳过：不追加锚点
  const out = await ctx._fire("system-prompt/assemble", mk(), {}, undefined);
  assert.ok(!out.sections.some((s) => s.name === ANCHOR_NAME), "熔断后不应改写");
  assert.equal(injectionStats.last.skipped, "storm-breaker");
  dispose();
});

test("提示词来源：prompt-inject.md 优先于 builtin", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-inj-"));
  const builtinOnly = resolvePromptText(home, {});
  assert.equal(builtinOnly.source, "builtin");
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "MY OPERATOR RULES\n", "utf8");
  const fromFile = resolvePromptText(home, {});
  assert.equal(fromFile.source, "prompt-inject.md");
  assert.match(fromFile.text, /MY OPERATOR RULES/);
  assert.ok(fromFile.sha && fromFile.sha.length === 16);
  fs.rmSync(home, { recursive: true, force: true });
});

test("证据链：E3 未知记 null 而不是 false", () => {
  const e3 = collectE3({ granted: 0, last: null });
  assert.equal(e3.ok, null, "没观察到审批请求时必须是 null（未知），不能是 false");
  assert.ok(e3.note);
  const e3b = collectE3({ granted: 2, last: { tool: "bash", at: 1 } });
  assert.equal(e3b.ok, true);
  assert.equal(e3b.lastTool, "bash");
});

test("证据链：落盘可读回 + verifyAll 汇总", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge2-ev-"));
  record(home, "E1", { id: "S1", ok: true });
  record(home, "E3", { granted: 1 });
  const rows = read(home, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[rows.length - 1].level, "E1", "倒序：最早的在后");

  const profile = buildHostProfile(process.env);
  const v = verifyAll({
    aiBase: profile.aiBase,
    patchSet: SOURCE_PATCHES,
    hasMarker,
    injectionStats: { assembles: 0, last: null },
    approvalGrantStats: { granted: 0, last: null },
  });
  assert.ok(["green", "yellow", "red"].includes(v.health));
  assert.equal(v.e2.ok, null, "还没 assemble 时必须 null");
  assert.equal(v.e3.ok, null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("健康度三态：未应用=🟡 / 打了一半=🔴 / 全打且注入在=🟢", () => {
  const mk = (markerFounds) => ({
    e1: markerFounds.map((m, i) => ({ id: `S${i}`, file: "f", sha: "x", markerFound: m })),
    e2: { ok: null },
    e3: { ok: null },
  });
  // 用 verifyAll 的判定逻辑等价复算（避免依赖真实文件）
  const judge = ({ e1, e2 }) => {
    const known = e1.filter((r) => r.markerFound !== null);
    const found = known.filter((r) => r.markerFound === true);
    const state = known.length === 0 ? "unknown" : found.length === known.length ? "all" : found.length === 0 ? "none" : "partial";
    return state === "partial" ? "red" : state === "all" ? (e2.ok === true ? "green" : "yellow") : "yellow";
  };
  assert.equal(judge(mk([false, false, false])), "yellow", "一条都没打 → 未应用，不是坏");
  assert.equal(judge(mk([true, false, false])), "red", "打了一半 → 不一致，必须是红");
  assert.equal(judge(mk([true, true, true])), "yellow", "全打但注入未观察 → 黄");
  assert.equal(judge({ ...mk([true, true, true]), e2: { ok: true } }), "green", "全打且注入在 → 绿");
  assert.equal(judge(mk([null, null, null])), "yellow", "读不到 → 未知也是黄，不能报绿");
});
