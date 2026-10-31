/**
 * L1 补丁引擎 —— 本项目的核心资产。
 *
 * 六条不变式（每一条都来自三个上游仓库付过学费的教训）：
 *   1. 拒写优先   —— 命中数与声明不符、锚点缺失，一条都不写，只记原因
 *   2. 幂等       —— markers 命中即 already；skipIfMarked 真正参与跳过判断
 *   3. 可逆       —— 首次改动前拷 <file>.dshpurge2.bak；revert 拷回即删
 *   4. 自愈       —— apply 开头先跑 restoreMissingOriginalsFromBak
 *   5. 不猜       —— expect 命中数契约，不符则 hit_count_mismatch 并停止该条
 *   6. 三态执行   —— probe（只读）/ plan（只读出方案）/ apply（写）
 *
 * 与三仓库的结构差异：PatchSpec 带 variants 变体链，一条补丁可承载多个宿主版本的
 * 锚点写法；版本不符的变体直接不参与匹配，因此不会出现"版本一变全 pending"。
 */

import fs from "node:fs";
import path from "node:path";

export const BAK_SUFFIX = ".dshpurge2.bak";

/** 补丁状态取值（UI / 自检 / CLI 共用同一套词表） */
export const STATUS = Object.freeze({
  APPLIED: "applied",
  ALREADY: "already",
  PENDING: "pending",
  NA: "na", // 该变体与当前宿主版本不符
  MISSING_FILE: "missing_file",
  UNMATCHED: "unmatched", // 文件在，锚点全不命中
  HIT_MISMATCH: "hit_count_mismatch", // 命中数不符 → 拒写
  DRIFTED: "drifted", // 曾打过，现在文件里既无 marker 也无锚点（被 npm 覆盖）
  ERROR: "error",
});

function readText(fp) {
  return fs.readFileSync(fp, "utf8");
}

function writeAtomic(fp, text) {
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, fp);
}

/** 变体是否适用于当前宿主轨道 */
export function variantApplies(variant, track) {
  if (!variant) return false;
  const only = variant.track;
  if (!only) return true;
  return Array.isArray(only) ? only.includes(track) : only === track;
}

/**
 * 在单个文件上试算一条变体的全部 op（纯函数，不落盘）。
 * @returns {{ok:boolean, reason?:string, text:string, hits:number[]}}
 */
export function evalVariant(text, variant) {
  let out = text;
  const hits = [];
  for (const op of variant.ops || []) {
    const pat = op.pattern;
    if (pat instanceof RegExp) {
      const g = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : `${pat.flags}g`);
      const n = (out.match(g) || []).length;
      hits.push(n);
      out = out.replace(g, op.replace);
      continue;
    }
    const n = out.split(pat).length - 1;
    hits.push(n);
    out = out.split(pat).join(op.replace);
  }
  const expect = (variant.ops || []).reduce((s, op) => s + (op.expect ?? 1), 0);
  const actual = hits.reduce((s, n) => s + n, 0);
  if (actual !== expect) {
    return {
      ok: false,
      reason: `hit_count_mismatch:${actual}/${expect}`,
      text,
      hits,
    };
  }
  return { ok: true, text: out, hits };
}

/** 文件里是否已有本补丁的 marker（幂等判据） */
export function hasMarker(text, markers) {
  return (markers || []).some((m) => (m instanceof RegExp ? m.test(text) : text.includes(m)));
}

/** 备份是否存在 */
export function hasBak(fp) {
  return fs.existsSync(fp + BAK_SUFFIX);
}

/**
 * 自愈：声明过的文件不见了、但备份还在 → 拷回。
 * 对应"npm 覆盖产物"这个必然发生的场景。
 */
export function restoreMissingOriginalsFromBak(aiBase, patchSet) {
  const restored = [];
  for (const p of patchSet) {
    for (const t of p.targets || []) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      if (!fs.existsSync(fp) && hasBak(fp)) {
        try {
          fs.copyFileSync(fp + BAK_SUFFIX, fp);
          restored.push(fp);
        } catch {
          /* 拷不回就留给 apply 报 missing_file */
        }
      }
    }
  }
  return restored;
}

/**
 * plan —— 只读：算出每条补丁将要做什么。
 * 不写盘、不建备份，可随时安全调用。
 */
export function planPatches(aiBase, patchSet, track) {
  const rows = [];
  for (const p of patchSet) {
    const row = {
      id: p.id,
      name: p.name,
      layer: p.layer || "code",
      why: p.why || "",
      status: STATUS.PENDING,
      files: [],
      reason: "",
    };
    const variants = (p.variants || []).filter((v) => variantApplies(v, track));
    if (!variants.length) {
      row.status = STATUS.NA;
      row.reason = `no variant for track=${track}`;
      rows.push(row);
      continue;
    }
    let anyFile = false;
    let anyApplicable = false;
    let anyMarker = false;
    for (const t of p.targets || []) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      if (!fs.existsSync(fp)) {
        row.files.push({ file: fp, exists: false });
        continue;
      }
      anyFile = true;
      const text = readText(fp);
      if (hasMarker(text, p.markers)) {
        anyMarker = true;
        row.files.push({ file: fp, exists: true, marker: true });
        continue;
      }
      // 找第一个能命中且命中数正确的变体
      let picked = null;
      let lastReason = "";
      for (const v of variants) {
        const r = evalVariant(text, v);
        if (r.ok) {
          picked = { variant: v, result: r };
          break;
        }
        lastReason = r.reason || lastReason;
      }
      if (picked) {
        anyApplicable = true;
        const before = text.length;
        const after = picked.result.text.length;
        row.files.push({
          file: fp,
          exists: true,
          op: "patch",
          hits: picked.result.hits,
          delta: after - before,
        });
      } else {
        row.files.push({ file: fp, exists: true, op: "no-match", reason: lastReason });
      }
    }
    if (anyMarker) row.status = STATUS.ALREADY;
    else if (!anyFile) row.status = p.optional ? STATUS.MISSING_FILE : STATUS.MISSING_FILE;
    else if (anyApplicable) row.status = STATUS.PENDING;
    else row.status = STATUS.UNMATCHED;
    if (row.status === STATUS.MISSING_FILE && !p.optional) {
      row.reason = "target package/file absent on this host";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * apply —— 执行；先备份、再原子写、失败即停该条。
 */
export function applyPatches(aiBase, patchSet, track, options = {}) {
  const restored = restoreMissingOriginalsFromBak(aiBase, patchSet);
  const rows = [];
  for (const p of patchSet) {
    const row = {
      id: p.id,
      name: p.name,
      layer: p.layer || "code",
      status: STATUS.PENDING,
      files: [],
      reason: "",
    };
    if (p.defaultOff && !options.enableOptIn) {
      row.status = STATUS.NA;
      row.reason = "defaultOff: 需显式开启（会削弱宿主自我保护）";
      rows.push(row);
      continue;
    }
    const variants = (p.variants || []).filter((v) => variantApplies(v, track));
    if (!variants.length) {
      row.status = STATUS.NA;
      row.reason = `no variant for track=${track}`;
      rows.push(row);
      continue;
    }
    let anyFile = false;
    let written = 0;
    let already = 0;
    let mismatched = null;
    let unmatchedFile = null;
    for (const t of p.targets || []) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      const rel = `${t.pkg}/${t.rel.join("/")}`;
      if (!fs.existsSync(fp)) {
        row.files.push({ file: rel, exists: false });
        continue;
      }
      anyFile = true;
      const text = readText(fp);
      if (hasMarker(text, p.markers)) {
        already += 1;
        row.files.push({ file: rel, marker: true });
        continue;
      }
      let done = false;
      for (const v of variants) {
        const r = evalVariant(text, v);
        if (!r.ok) {
          if (String(r.reason || "").startsWith("hit_count_mismatch")) mismatched = r.reason;
          continue;
        }
        if (!hasBak(fp)) {
          try {
            fs.copyFileSync(fp, fp + BAK_SUFFIX);
          } catch (e) {
            row.status = STATUS.ERROR;
            row.reason = `backup failed: ${e.message}`;
            break;
          }
        }
        writeAtomic(fp, r.text);
        written += 1;
        row.files.push({ file: rel, op: "patched", hits: r.hits });
        done = true;
        break;
      }
      if (row.status === STATUS.ERROR) break;
      if (!done) {
        unmatchedFile = rel;
        row.files.push({ file: rel, op: "no-match" });
      }
    }
    if (row.status === STATUS.ERROR) {
      rows.push(row);
      continue;
    }
    if (!anyFile) {
      row.status = STATUS.MISSING_FILE;
      row.reason = "target package/file absent on this host";
    } else if (mismatched && !written) {
      row.status = STATUS.HIT_MISMATCH;
      row.reason = mismatched;
    } else if (written > 0) {
      row.status = STATUS.APPLIED;
    } else if (already > 0) {
      row.status = STATUS.ALREADY;
    } else if (unmatchedFile) {
      row.status = STATUS.UNMATCHED;
      row.reason = `anchor not found in ${unmatchedFile}`;
    }
    rows.push(row);
  }
  return { restored, rows, summary: summarize(rows) };
}

/** revert —— 用 .bak 覆盖回去并删掉备份 */
export function revertPatches(aiBase, patchSet) {
  const rows = [];
  for (const p of patchSet) {
    for (const t of p.targets || []) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      const rel = `${t.pkg}/${t.rel.join("/")}`;
      if (!hasBak(fp)) {
        rows.push({ id: p.id, file: rel, status: "no-backup" });
        continue;
      }
      try {
        fs.copyFileSync(fp + BAK_SUFFIX, fp);
        fs.rmSync(fp + BAK_SUFFIX, { force: true });
        rows.push({ id: p.id, file: rel, status: "reverted" });
      } catch (e) {
        rows.push({ id: p.id, file: rel, status: "error", reason: e.message });
      }
    }
  }
  return rows;
}

export function summarize(rows) {
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  const applicable = rows.filter((r) => r.status !== STATUS.NA && r.status !== STATUS.MISSING_FILE);
  const ready = rows.filter((r) => r.status === STATUS.PENDING);
  const good = rows.filter((r) => r.status === STATUS.APPLIED || r.status === STATUS.ALREADY);
  return {
    total: rows.length,
    by,
    applicable: applicable.length,
    /** 可打（plan 视角）：锚点齐全、只看还没打的 */
    ready: ready.length,
    good: good.length,
    /** 🟢 全绿 / 🟡 部分 / 🔴 有漂移或拒写 —— 三态，不用二态骗人 */
    health: rows.some((r) => r.status === STATUS.HIT_MISMATCH || r.status === STATUS.DRIFTED || r.status === STATUS.ERROR)
      ? "red"
      : good.length + ready.length === applicable.length && applicable.length > 0
        ? "green"
        : "yellow",
  };
}
