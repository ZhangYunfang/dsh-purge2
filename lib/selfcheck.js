/**
 * 运维：分层自检（BYPASS_LAYERS）
 *
 * 设计取自社区版最值得抄的一层，但有两条硬规则：
 *   1. **读不到 ≠ 通过**：拿不到补丁状态时报 unknown（🟡），不允许折叠成 🟢
 *   2. **只有显式证据才能从分母里剔除**：na / missing_file 才降分母，pending 不行
 *
 * 每一层回答的不是「有没有打」，而是「这一层没了会发生什么」。
 */

import * as core from "./patch-engine.js";
import { LAYERS } from "./patches/legacy-0.1.js";

const OK = new Set([core.STATUS.APPLIED, core.STATUS.ALREADY]);
const NOT_APPLICABLE = new Set([core.STATUS.NA, core.STATUS.MISSING_FILE]);

/**
 * @param {object} params
 * @param {Array|null} params.rows plan/apply 的逐条结果；null = 读不到状态
 * @param {{e2?:object, e3?:object}} params.evidence 三级证据里的运行时/行为两级
 */
export function rollupLayers({ rows, evidence = {} } = {}) {
  // 读不到状态：全部报 unknown，绝不报绿
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      state: "unknown",
      note: "未取得补丁状态；这不等于通过",
      layers: LAYERS.map((l) => ({
        key: l.key,
        title: l.title,
        state: "unknown",
        why: l.why,
        ids: l.ids,
        detail: "no patch status available",
      })),
      counts: { green: 0, yellow: 0, red: 0, unknown: LAYERS.length },
    };
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const layers = LAYERS.map((layer) => {
    const states = layer.ids.map((id) => byId.get(id)?.status ?? "unknown");
    const applicable = states.filter((s) => !NOT_APPLICABLE.has(s));
    const okCount = states.filter((s) => OK.has(s)).length;
    let state;
    if (states.some((s) => s === core.STATUS.HIT_MISMATCH || s === core.STATUS.DRIFTED || s === core.STATUS.ERROR)) {
      state = "red"; // 有拒写或漂移：必须查
    } else if (applicable.length === 0) {
      state = "na"; // 显式不适用，从分母剔除
    } else if (okCount === applicable.length) {
      state = "green";
    } else if (okCount === 0) {
      state = "pending"; // 一条都没打：未应用
    } else {
      state = "partial"; // 打了部分：不一致
    }
    return {
      key: layer.key,
      title: layer.title,
      ids: layer.ids,
      why: layer.why,
      state,
      detail: `${okCount}/${applicable.length} 条生效`,
    };
  });

  const counts = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const l of layers) {
    if (l.state === "green") counts.green += 1;
    else if (l.state === "red") counts.red += 1;
    else if (l.state === "unknown") counts.unknown += 1;
    else counts.yellow += 1;
  }

  // 运行时两级只降级不升级：file 层全绿但注入没观测到 → 整体只能是 yellow
  const runtimeOk = evidence?.e2?.ok === true;
  const state =
    counts.red > 0
      ? "red"
      : counts.green === 0
        ? counts.yellow > 0
          ? "yellow"
          : "unknown"
        : runtimeOk
          ? "green"
          : "yellow";

  return {
    state,
    layers,
    counts,
    evidence: {
      e2: evidence?.e2?.ok ?? null,
      e3: evidence?.e3?.ok ?? null,
      note: runtimeOk ? undefined : "文件层已生效，但尚未观测到运行时注入（需在 DSH 进程内）",
    },
  };
}

/** 人读摘要 */
export function formatSelfcheck(result, patches = []) {
  const icon = { green: "✓", yellow: "·", red: "✗", unknown: "?", pending: "·", partial: "!", na: "-" };
  const lines = [`自检  ·  ${result.state.toUpperCase()}  ·  ${JSON.stringify(result.counts)}`, ""];
  for (const l of result.layers) {
    lines.push(`  ${icon[l.state] ?? "?"} ${l.title.padEnd(18)} ${String(l.state).padEnd(8)} ${l.detail}`);
    lines.push(`      ${l.why}`);
  }
  lines.push("");
  lines.push(`  运行时注入 E2：${result.evidence.e2 === true ? "已观测" : result.evidence.e2 === null ? "未知（CLI 独立进程正常）" : "未生效"}`);
  lines.push(`  行为钩子   E3：${result.evidence.e3 === true ? "已观测" : "未知（未观察到审批请求 ≠ 未生效）"}`);
  if (result.note) lines.push(`\n  ⚠ ${result.note}`);
  return lines.join("\n");
}
