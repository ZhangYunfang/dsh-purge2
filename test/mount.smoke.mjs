/**
 * 真机契约冒烟（不安装插件，只用已装包搭真实 cordis Context）
 *
 * 这一步等价于「E2 运行时证据」的硬证明：不是在假 ctx 里验证，
 * 而是把真实的 @deepseek-ai/dsh-system-prompt 挂进真实 cordis Context，
 * 再把本插件挂上去，看注入是否真的进了 assemble 结果。
 *
 * 运行：node test/mount.smoke.mjs
 * 依赖：本机已装 DSH（~/.dsh/profiles/node_modules/@deepseek-ai）
 */

import path from "node:path";
import os from "node:os";

const AI = path.join(os.homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai");

function ok(name, cond, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

let Context;
try {
  ({ Context } = await import(path.join(AI, "cordis", "lib", "index.js")));
} catch (e) {
  console.log(`SKIP 未找到本机 DSH 的 cordis：${e.message}`);
  process.exit(0);
}

const ctx = new Context();
const spMod = await import(path.join(AI, "dsh-system-prompt", "lib", "index.js"));
ctx.plugin(spMod.default, { includeHarnessIdentity: true, persona: "" });
await new Promise((r) => setTimeout(r, 50));

const sp = ctx.get?.("systemPrompt");
if (!ok("真实 systemPrompt 服务可用", !!sp && typeof sp.assemble === "function")) process.exit(0);

// 基线：未挂本插件时的段
const base = await sp.assemble({});
console.log(`  基线段：${base.sections.map((s) => s.name).join(", ")}`);

// 挂本插件（真实 apply 路径）
const ours = await import("../lib/index.js");
// 传模块命名空间（带 name/inject/apply），cordis 才会按 inject 等待服务
ctx.plugin({ name: ours.name, inject: ours.inject, apply: ours.apply }, { autoApplyOnStart: false, approvalGrant: true });
await new Promise((r) => setTimeout(r, 80));

const after = await sp.assemble({});
const names = after.sections.map((s) => s.name);
console.log(`  注入后段：${names.join(", ")}`);

ok("section 已注册（purge2:operator）", names.includes("purge2:operator"));
ok("尾部锚点已追加且位于末尾", names[names.length - 1] === "purge2:anchor");
ok("锚点不重复", names.filter((n) => n === "purge2:anchor").length === 1);
ok("原有段未被破坏", base.sections.every((s) => names.includes(s.name)));

// 渲染后真实文本里应能看到注入内容
const rendered = typeof spModuleRender === "function" ? "" : "";
const { renderPrompt } = spMod;
if (typeof renderPrompt === "function") {
  let text = "";
  try {
    text = renderPrompt(after, {});
  } catch {
    text = "";
  }
  ok("渲染文本包含 purge2 标记", text.includes("purge2"), `len=${text.length}`);
}

// 证据：注入统计应有值
const inj = await import("../lib/inject-engine.js");
ok("E2 观测已记录", inj.injectionStats.assembles > 0, `assembles=${inj.injectionStats.assembles} 段数=${inj.injectionStats.last?.sections}`);

process.exit(process.exitCode || 0);
