/**
 * L4 三级证据链 —— 本项目相对三上游的核心增量。
 *
 * 社区版的 23 层自检证明的是「补丁写进去了」（E1），
 * 没证明「注入真的进了这一轮」（E2），也没证明「行为真的变了」（E3）。
 *
 *   E1 静态：文件字节 + marker 命中 + 命中数契约
 *   E2 运行时：注入文本真的进入本次 assemble（长度 / sha / 段位 / 是否被熔断跳过）
 *   E3 行为：运行时钩子真的被调用过（审批放行次数、工具名、时间）
 *
 * 未知一律记 null，不折叠成 false —— 「不知道」和「没生效」是两件事。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function evidencesDir(dshHome) {
  return path.join(dshHome, "purge2", "evidence");
}

function todayFile(dshHome) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(evidencesDir(dshHome), `${day}.jsonl`);
}

/** 追加一条证据（追加式，不覆写） */
export function record(dshHome, level, payload) {
  try {
    const file = todayFile(dshHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = { level, at: new Date().toISOString(), ...payload };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  } catch {
    return null;
  }
}

/** 读最近 N 条（跨文件，按时间倒序） */
export function read(dshHome, limit = 50) {
  const dir = evidencesDir(dshHome);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* 坏行跳过，不整体失败 */
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * E1 静态证据：对每个补丁的每个目标文件取 sha256 + marker 命中。
 * 与 apply 报告配合使用：apply 说 applied，这里证明文件确实是目标字节。
 */
export function collectE1(aiBase, patchSet, hasMarker) {
  const rows = [];
  for (const p of patchSet) {
    for (const t of p.targets || []) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      const rel = `${t.pkg}/${t.rel.join("/")}`;
      let sha = null;
      let markerFound = null;
      try {
        const buf = fs.readFileSync(fp);
        sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
        markerFound = hasMarker(buf.toString("utf8"), p.markers);
      } catch {
        sha = null;
        markerFound = null; // 未知，不是 false
      }
      rows.push({ id: p.id, file: rel, sha, markerFound });
    }
  }
  return rows;
}

/**
 * E2 运行时证据：把 injectionStats 快照成一条记录。
 * 判据：assembles > 0 且 last 里没有 skipped，才算注入真的跑过。
 */
export function collectE2(injectionStats) {
  const last = injectionStats.last;
  if (!last) {
    return { ok: null, reason: "no assemble observed yet", assembles: 0 };
  }
  if (last.skipped) {
    return { ok: false, reason: `assemble hook skipped (${last.skipped})`, assembles: injectionStats.assembles, last };
  }
  return {
    ok: true,
    assembles: injectionStats.assembles,
    injectedBytes: last.injectedBytes,
    injectedSha: last.injectedSha,
    source: last.source,
    anchorIndex: last.anchorIndex,
    sections: last.sections,
    costMs: last.costMs,
  };
}

/**
 * E3 行为证据：运行时钩子调用计数。
 * 注意：approvalGranted = 0 不等于"没生效"——可能这一轮根本没有需要审批的操作。
 * 所以 ok 用 null（未知），不写 false。
 */
export function collectE3(approvalGrantStats) {
  const n = Number(approvalGrantStats?.granted ?? 0);
  return {
    ok: n > 0 ? true : null,
    approvalGranted: n,
    lastTool: approvalGrantStats?.last?.tool ?? null,
    lastAt: approvalGrantStats?.last?.at ?? null,
    note: n > 0 ? undefined : "没有观察到审批请求；这不等于未生效（可能本轮无需审批）",
  };
}

/** 汇总三级 */
export function verifyAll({ aiBase, patchSet, hasMarker, injectionStats, approvalGrantStats }) {
  const e1 = collectE1(aiBase, patchSet, hasMarker);
  const e2 = collectE2(injectionStats);
  const e3 = collectE3(approvalGrantStats);

  const known = e1.filter((r) => r.markerFound !== null);
  const found = known.filter((r) => r.markerFound === true);
  const e1State =
    known.length === 0
      ? "unknown" // 文件都读不到 → 未知，不是失败
      : found.length === known.length
        ? "all"
        : found.length === 0
          ? "none" // 一条都没打 → 尚未应用，不是"坏了"
          : "partial";

  // 健康度只用三态，且"尚未应用"是 🟡 而不是 🔴——红只留给"应用了但证据矛盾"
  const health =
    e1State === "partial"
      ? "red" // 打了一半：不一致，必须查
      : e1State === "all"
        ? e2.ok === true
          ? "green"
          : "yellow" // 补丁到位但注入没观察到
        : e1State === "none"
          ? "yellow" // 还没 apply
          : "yellow"; // unknown

  return { e1, e2, e3, e1State, health };
}
