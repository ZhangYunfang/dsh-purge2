/**
 * dsh-purge2 插件入口（host 半侧）
 *
 * 启动时按侵入性从低到高做四件事，全部幂等：
 *   1. 探测宿主（HostProfile）—— 只读
 *   2. 挂 runtime 钩子（审批自动放行）—— 零源码改动
 *   3. 挂注入（section + assemble 尾部锚点）—— 零源码改动
 *   4. 自愈 + 打 source 补丁 —— 改 node_modules 产物，带 .bak
 *
 * 红线见 docs/DESIGN.md：不写 profile YAML、不改源码树、命中数不符拒写。
 */

import { buildHostProfile } from "./host-probe.js";
import { applyPatches, planPatches, revertPatches, summarize, hasMarker } from "./patch-engine.js";
import { SOURCE_PATCHES } from "./patches/legacy-0.1.js";
import { installApprovalGrant, approvalGrantStats } from "./runtime/approval-grant.js";
import {
  installSection,
  installAssembleHook,
  makePromptState,
  injectionStats,
} from "./inject-engine.js";
import { verifyAll, record, read } from "./evidence.js";

export const name = "dsh-purge2";
export const inject = ["systemPrompt"];

/** 模块级句柄：不往 cordis 的 ctx 上写未知属性（会抛错并让整个 fiber 被回收） */
let handle = null;
export function getHandle() {
  return handle;
}

const DEFAULT_CONFIG = {
  enabled: true,
  autoApplyOnStart: true,
  approvalGrant: true,
  inject: true,
  anchor: true,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return;

  const profile = buildHostProfile(process.env);
  let lastReport = null;

  const applySources = () => {
    if (!profile.aiBaseFound) return null;
    lastReport = applyPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
    try {
      ctx.logger?.info?.(`[purge2] patches ${JSON.stringify(lastReport.summary.by)} health=${lastReport.summary.health}`);
    } catch {
      /* logger 可选 */
    }
    return lastReport;
  };

  const disposers = [];

  // ② runtime：审批自动放行
  if (cfg.approvalGrant) disposers.push(installApprovalGrant(ctx, { enabled: true }));

  // ③ 注入：section（稳态）+ assemble（首轮兜底 & 尾部锚点）
  let promptState = null;
  if (cfg.inject) {
    try {
      promptState = makePromptState(profile.dshHome, {});
      disposers.push(installSection(ctx, promptState, cfg));
      if (cfg.anchor) disposers.push(installAssembleHook(ctx, promptState, cfg));
    } catch (e) {
      ctx.logger?.warn?.(`[purge2] inject install failed: ${e?.message || e}`);
    }
  }

  // ④ source 补丁
  if (cfg.autoApplyOnStart) {
    try {
      applySources();
    } catch (e) {
      ctx.logger?.warn?.(`[purge2] auto-apply failed: ${e?.message || e}`);
    }
  }

  ctx.effect?.(() => () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  });

  // 暴露给 CLI / 面板（模块级，不污染 ctx）
  handle = {
    profile,
    patches: SOURCE_PATCHES,
    plan: () => planPatches(profile.aiBase, SOURCE_PATCHES, profile.track),
    apply: applySources,
    revert: () => revertPatches(profile.aiBase, SOURCE_PATCHES),
    verify: () =>
      verifyAll({
        aiBase: profile.aiBase,
        patchSet: SOURCE_PATCHES,
        hasMarker,
        injectionStats,
        approvalGrantStats,
      }),
    evidence: (limit = 50) => read(profile.dshHome, limit),
    record,
    status: () => {
      const rows = planPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
      return { profile, rows, summary: summarize(rows), last: lastReport };
    },
  };
  return handle;
}

export default apply;
