/**
 * dsh-purge2 插件入口（host 半侧）
 *
 * 启动时做三件事，全部幂等：
 *   1. 探测宿主（HostProfile）—— 只读
 *   2. 自愈 + 打 source 补丁 —— 改 node_modules 产物，带 .bak
 *   3. 挂 runtime 钩子 —— 审批自动放行
 *
 * 设计约束（见 docs/DESIGN.md 红线）：
 *   · 不写用户 profile 的 cordis.patch.yml
 *   · 不改宿主源码树，只改 node_modules 产物
 *   · 命中数不符一律拒写
 */

import path from "node:path";
import { buildHostProfile } from "./host-probe.js";
import { applyPatches, planPatches, revertPatches, summarize } from "./patch-engine.js";
import { SOURCE_PATCHES } from "./patches/legacy-0.1.js";
import { installApprovalGrant } from "./runtime/approval-grant.js";

export const name = "dsh-purge2";
export const inject = [];

/** 默认配置 */
const DEFAULT_CONFIG = {
  enabled: true,
  /** 启动时自动打补丁（关掉则只挂运行时钩子） */
  autoApplyOnStart: true,
  /** 审批自动放行 */
  approvalGrant: true,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return;

  const profile = buildHostProfile(process.env);
  let lastReport = null;

  const run = () => {
    if (!profile.aiBaseFound) {
      return { ok: false, reason: "no @deepseek-ai package dir found", profile };
    }
    if (cfg.autoApplyOnStart) {
      lastReport = applyPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
      try {
        ctx.logger?.info?.(
          `[purge2] patches ${JSON.stringify(lastReport.summary.by)} health=${lastReport.summary.health}`,
        );
      } catch {
        /* logger 可选 */
      }
    }
    return lastReport;
  };

  // 运行时通道：审批自动放行
  let disposeGrant = () => {};
  if (cfg.approvalGrant) {
    disposeGrant = installApprovalGrant(ctx, { enabled: true });
  }

  // 启动即尝试打补丁；失败不阻塞插件加载
  try {
    run();
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[purge2] auto-apply failed: ${e?.message || e}`);
    } catch {
      /* ignore */
    }
  }

  ctx.effect?.(() => () => {
    try {
      disposeGrant();
    } catch {
      /* ignore */
    }
  });

  // 暴露给 CLI / 面板复用的句柄
  ctx.purge2 = {
    profile,
    patches: SOURCE_PATCHES,
    plan: () => planPatches(profile.aiBase, SOURCE_PATCHES, profile.track),
    apply: () => run(),
    revert: () => revertPatches(profile.aiBase, SOURCE_PATCHES),
    status: () => {
      const rows = planPatches(profile.aiBase, SOURCE_PATCHES, profile.track);
      return { profile, rows, summary: summarize(rows), last: lastReport };
    },
  };
  return ctx.purge2;
}

export default apply;
