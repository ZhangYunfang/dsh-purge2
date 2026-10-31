/**
 * 运维：审计日志
 *
 * 记的是「可观测的部分」：谁/什么时候/改了什么/结果如何。
 * 明确不记的：宿主内部某次工具调用被哪条补丁放行——那在宿主里不可见，
 * 硬编一个「已放行」只会制造假证据。真证据在 evidence.js 的 E1/E2/E3。
 */

import fs from "node:fs";
import path from "node:path";

export function auditFile(dshHome) {
  return path.join(dshHome, "purge2", "audit.jsonl");
}

const MAX_BYTES = 2 * 1024 * 1024; // 2MB 后轮转一次，避免长跑无限增长

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* 不存在就没什么可轮转 */
  }
}

/**
 * 追加一条审计。
 * @param {string} dshHome
 * @param {{action:string, result?:string, detail?:object, actor?:string}} entry
 */
export function logAudit(dshHome, entry) {
  try {
    const file = auditFile(dshHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const row = {
      at: new Date().toISOString(),
      actor: entry.actor || "purge2",
      action: String(entry.action || "unknown"),
      result: entry.result || "ok",
      detail: entry.detail || {},
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  } catch {
    return null;
  }
}

/** 读最近 limit 条（倒序） */
export function readAudit(dshHome, limit = 50) {
  const file = auditFile(dshHome);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}
