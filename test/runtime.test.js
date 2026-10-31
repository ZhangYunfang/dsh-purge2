/**
 * 运行时通道测试：策略保持器 + 审批放行
 *
 * 断言的核心是「never 会话里放行钩子根本不会跑」这条 0.1.2 事实，
 * 所以保持器必须先把会话纠正成 ask，放行才有机会发生。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { installPolicyKeeper, effectivePolicy, policyKeeperStats } from "../lib/runtime/policy-keeper.js";
import { installApprovalGrant, approvalGrantStats } from "../lib/runtime/approval-grant.js";

function fakeCtx() {
  const listeners = new Map();
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return () => {
        const a = listeners.get(ev);
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },
    async fire(ev, ...args) {
      for (const fn of listeners.get(ev) || []) await fn(...args);
    },
    count(ev) {
      return (listeners.get(ev) || []).length;
    },
  };
}

function fakeSession(events = []) {
  const log = [...events];
  return {
    events: log,
    appended: [],
    append(type, data) {
      this.appended.push({ type, data });
      log.push({ type, data });
    },
  };
}

test("effectivePolicy 折叠：取最后一条 approval/policy", () => {
  assert.equal(effectivePolicy([]), undefined);
  assert.equal(effectivePolicy([{ type: "turn/start" }]), undefined);
  assert.equal(
    effectivePolicy([
      { type: "approval/policy", data: { policy: "never" } },
      { type: "turn/start" },
      { type: "approval/policy", data: { policy: "ask" } },
    ]),
    "ask",
    "必须取最后一条，不能取第一条",
  );
});

test("新建会话落在 never → 自动纠正成 ask", async () => {
  const ctx = fakeCtx();
  installPolicyKeeper(ctx, { enabled: true });
  const s = fakeSession([{ type: "approval/policy", data: { policy: "never" } }]);
  await ctx.fire("session/created", s);
  await new Promise((r) => setTimeout(r, 10)); // 等 queueMicrotask
  const last = s.appended.at(-1);
  assert.deepEqual(last, { type: "approval/policy", data: { policy: "ask" } });
  assert.ok(policyKeeperStats.flips >= 1);
});

test("会话中途被切成 never → 自动纠正；已是 ask 不动", async () => {
  const ctx = fakeCtx();
  installPolicyKeeper(ctx, { enabled: true });
  const s = fakeSession();
  await ctx.fire("session/event", s, { type: "approval/policy", data: { policy: "never" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.appended.length, 1);

  const before = s.appended.length;
  await ctx.fire("session/event", s, { type: "approval/policy", data: { policy: "ask" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.appended.length, before, "已经是 ask 时不应再写");
});

test("翻转有上限：最多 5 次后放弃并计数", async () => {
  const ctx = fakeCtx();
  installPolicyKeeper(ctx, { enabled: true });
  const s = fakeSession();
  for (let i = 0; i < 8; i += 1) {
    await ctx.fire("session/event", s, { type: "approval/policy", data: { policy: "never" } });
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(s.appended.length, 5, "MAX_FLIPS=5，不能无限写");
  assert.ok(policyKeeperStats.gaveUp >= 1, "到上限必须记账，不静默");
});

test("审批放行：approval/request 返回 allowed-once 并计数", () => {
  const ctx = fakeCtx();
  let handler = null;
  // 模拟 host 的 waterfall 调用约定
  ctx.on("approval/request", (fn) => fn); // 占位
  const real = fakeCtx();
  const origOn = real.on.bind(real);
  real.on = (ev, fn, opts) => {
    if (ev === "approval/request") handler = fn;
    return origOn(ev, fn, opts);
  };
  installApprovalGrant(real, { enabled: true });
  assert.equal(typeof handler, "function", "必须挂上 approval/request");
  const before = approvalGrantStats.granted;
  const out = handler({ toolName: "bash" }, () => "unavailable");
  assert.equal(out, "allowed-once");
  assert.equal(approvalGrantStats.granted, before + 1);
  assert.equal(approvalGrantStats.last.tool, "bash");
});

test("审批放行：enabled=false 时不挂任何监听", () => {
  const ctx = fakeCtx();
  installApprovalGrant(ctx, { enabled: false });
  assert.equal(ctx.count("approval/request"), 0);
});
