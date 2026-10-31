/**
 * 运维：备份 / 回滚
 *
 * 粒度是「补丁目标文件」而不是整个 node_modules：
 * 只把会被改的那几个文件按包结构拷进快照，manifest 记 sha256 便于校验。
 *
 * 为什么不用 .bak 就够：.bak 只有"改前一份"，做不了「回滚到三天前那次 apply」。
 * 快照是带时间戳的多版本，.bak 是即时撤销，两者互补。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function backupsDir(dshHome) {
  return path.join(dshHome, "purge2", "backups");
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function collectFiles(aiBase, patchSet) {
  const out = [];
  for (const p of patchSet) {
    for (const t of p.targets || []) {
      const fp = path.join(aiBase, t.pkg, ...t.rel);
      if (!fs.existsSync(fp)) continue;
      out.push({ patchId: p.id, pkg: t.pkg, rel: t.rel, file: fp });
    }
  }
  return out;
}

/**
 * 建一份快照。
 * @returns {{id:string, dir:string, files:number, bytes:number}|null}
 */
export function createBackup(dshHome, aiBase, patchSet, meta = {}) {
  try {
    const id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(backupsDir(dshHome), id);
    fs.mkdirSync(dir, { recursive: true });
    const entries = [];
    let bytes = 0;
    for (const f of collectFiles(aiBase, patchSet)) {
      const buf = fs.readFileSync(f.file);
      const dst = path.join(dir, "files", f.pkg, ...f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
      bytes += buf.length;
      entries.push({ patchId: f.patchId, pkg: f.pkg, rel: f.rel, sha: sha(buf), bytes: buf.length });
    }
    const manifest = {
      id,
      at: new Date().toISOString(),
      dshVersion: meta.dshVersion || "",
      track: meta.track || "",
      reason: meta.reason || "manual",
      patches: [...new Set(patchSet.map((p) => p.id))],
      files: entries,
      bytes,
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { id, dir, files: entries.length, bytes };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** 列出快照（新→旧） */
export function listBackups(dshHome) {
  const dir = backupsDir(dshHome);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.includes("."));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort().reverse()) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, n, "manifest.json"), "utf8"));
      out.push({ id: m.id, at: m.at, reason: m.reason, files: m.files.length, bytes: m.bytes, dshVersion: m.dshVersion });
    } catch {
      out.push({ id: n, at: "", reason: "unreadable", files: 0, bytes: 0 });
    }
  }
  return out;
}

/**
 * 回滚到指定快照。先校验每个文件的 sha 与 manifest 一致（快照自身不能坏）。
 * @returns {{restored:number, skipped:number, errors:string[], verified:boolean}}
 */
export function restoreBackup(dshHome, aiBase, id) {
  const dir = path.join(backupsDir(dshHome), id);
  const result = { restored: 0, skipped: 0, errors: [], verified: false };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (e) {
    result.errors.push(`manifest unreadable: ${String(e?.message || e)}`);
    return result;
  }
  if (!manifest.files?.length) {
    result.errors.push("manifest has no files");
    return result;
  }
  // 先整体校验，坏一个就整体不动（宁可不回滚，也不回滚一半）
  for (const f of manifest.files) {
    const src = path.join(dir, "files", f.pkg, ...f.rel);
    try {
      const buf = fs.readFileSync(src);
      if (sha(buf) !== f.sha) result.errors.push(`snapshot corrupt: ${f.pkg}/${f.rel.join("/")}`);
    } catch (e) {
      result.errors.push(`snapshot missing: ${f.pkg}/${f.rel.join("/")} (${String(e?.message || e)})`);
    }
  }
  if (result.errors.length) return result;
  result.verified = true;

  for (const f of manifest.files) {
    const src = path.join(dir, "files", f.pkg, ...f.rel);
    const dst = path.join(aiBase, f.pkg, ...f.rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const buf = fs.readFileSync(src);
      if (fs.existsSync(dst) && fs.readFileSync(dst).equals(buf)) {
        result.skipped += 1;
        continue;
      }
      fs.writeFileSync(dst, buf);
      // 回滚后旧的 .bak 已无意义（它对应的是被回滚掉的那份），清掉避免误用
      try {
        fs.rmSync(`${dst}.dshpurge2.bak`, { force: true });
      } catch {
        /* ignore */
      }
      result.restored += 1;
    } catch (e) {
      result.errors.push(`write failed: ${f.pkg}/${f.rel.join("/")} (${String(e?.message || e)})`);
    }
  }
  return result;
}

/** 清理旧快照，保留最近 keep 份 */
export function pruneBackups(dshHome, keep = 10) {
  const all = listBackups(dshHome);
  const drop = all.slice(keep);
  let removed = 0;
  for (const b of drop) {
    try {
      fs.rmSync(path.join(backupsDir(dshHome), b.id), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return { kept: Math.min(all.length, keep), removed };
}

/** 快照占用 */
export function backupsUsage(dshHome) {
  const all = listBackups(dshHome);
  return { count: all.length, bytes: all.reduce((s, b) => s + (b.bytes || 0), 0) };
}
