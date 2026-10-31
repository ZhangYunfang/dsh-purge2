/**
 * dsh-purge2-lab —— 演练台（可选层，默认不装）
 *
 * 定位：把「破甲」的收益用在授权演练上——资产测绘、证据记账、成果报告。
 * 与主包的边界：
 *   · 主包只做「降低交互摩擦」，不碰任何攻击资产
 *   · 本包是独立 npm 包，`dsh plugin remove` 单独退场，不影响主包
 *   · **不随包分发攻击载荷/武器化技能**（上游为此在 1.1.73 已移除 skills）
 *
 * 数据落在 $DSH_HOME/purge2/lab/：assets.db（node:sqlite）+ evidence.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const name = "dsh-purge2-lab";
export const inject = ["tools"];

/** 数据目录 */
export function labDir(dshHome) {
  return path.join(dshHome, "purge2", "lab");
}

/* ──────────────────────────── 资产库 ──────────────────────────── */

export function openDb(dshHome) {
  const dir = labDir(dshHome);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "assets.db"));
  db.exec(`
    create table if not exists assets (
      id integer primary key autoincrement,
      kind text not null,            -- host | service | credential | note
      key text not null,             -- 唯一键（如 10.0.0.5:22 或 host:abc）
      value text not null,
      source text default '',
      created_at text not null
    );
    create unique index if not exists assets_key on assets(kind, key);
    create table if not exists evidence (
      id integer primary key autoincrement,
      asset_key text default '',
      level text not null,           -- claimed | observed | derived | inferred
      summary text not null,
      raw text default '',
      ev_hash text not null,
      created_at text not null
    );
  `);
  return db;
}

const now = () => new Date().toISOString();

/** 记一个资产（同 kind+key 覆盖更新） */
export function assetAdd(db, { kind, key, value, source = "" }) {
  db.prepare(
    `insert into assets(kind,key,value,source,created_at) values(?,?,?,?,?)
     on conflict(kind,key) do update set value=excluded.value, source=excluded.source`,
  ).run(kind, key, value, source, now());
  return { ok: true, kind, key };
}

export function assetQuery(db, { kind, q, limit = 50 }) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  let sql = "select kind,key,value,source,created_at from assets where 1=1";
  const args = [];
  if (kind) {
    sql += " and kind = ?";
    args.push(kind);
  }
  if (q) {
    sql += " and (key like ? or value like ?)";
    args.push(`%${q}%`, `%${q}%`);
  }
  sql += " order by id desc limit ?";
  args.push(lim);
  return db.prepare(sql).all(...args);
}

export function assetStats(db) {
  const byKind = db.prepare("select kind, count(*) n from assets group by kind order by n desc").all();
  const total = db.prepare("select count(*) n from assets").get();
  const ev = db.prepare("select count(*) n from evidence").get();
  return { total: total.n, byKind, evidence: ev.n };
}

/* ──────────────────────────── 证据账本 ──────────────────────────── */

/** 四档置信度：claimed 是"子代理自称"，绝不能直接采信 */
export const LEVELS = ["claimed", "observed", "derived", "inferred"];

/** 语义哈希：同一内容必同哈希，改一个字就变（可验"说的"和"记的"是否一致） */
export function evidenceHash({ level, summary, raw }) {
  const norm = JSON.stringify([level, String(summary).trim(), String(raw ?? "").trim()]);
  return `ev_${createHash("sha256").update(norm).digest("hex").slice(0, 24)}`;
}

export function evidenceRecord(db, { level, summary, raw = "", assetKey = "" }) {
  if (!LEVELS.includes(level)) throw new Error(`evidence level must be one of ${LEVELS.join("/")}`);
  const hash = evidenceHash({ level, summary, raw });
  const dup = db.prepare("select id from evidence where ev_hash = ?").get(hash);
  if (dup) return { ok: true, duplicate: true, ev_hash: hash, id: dup.id };
  db.prepare(
    "insert into evidence(asset_key,level,summary,raw,ev_hash,created_at) values(?,?,?,?,?,?)",
  ).run(assetKey, level, String(summary), String(raw), hash, now());
  return { ok: true, ev_hash: hash, level };
}

/** 只采信 observed / derived；claimed 单独列出来供人核对 */
export function evidenceList(db, { limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = db
    .prepare("select id,asset_key,level,summary,ev_hash,created_at from evidence order by id desc limit ?")
    .all(lim);
  return {
    rows,
    trustworthy: rows.filter((r) => r.level === "observed" || r.level === "derived").length,
    claims: rows.filter((r) => r.level === "claimed").length,
  };
}

/* ──────────────────────────── 成果报告 ──────────────────────────── */

export function buildReport(db, { target = "" } = {}) {
  const stats = assetStats(db);
  const ev = evidenceList(db, { limit: 200 });
  const assets = db.prepare("select kind,key,value,source from assets order by kind, key limit 200").all();
  return {
    target,
    generatedAt: now(),
    stats,
    assets,
    evidence: ev.rows,
    note: "claimed 级证据未经验证，不可作为成果；只有 observed/derived 计数可信",
  };
}

/* ──────────────────────────── 插件入口 ──────────────────────────── */

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || path.join(process.env.HOME || "", ".dsh");
  let db = null;
  try {
    db = openDb(home);
  } catch (e) {
    ctx.logger?.warn?.(`[purge2-lab] asset db unavailable: ${e?.message || e}`);
  }
  if (!db) return;

  const tools = ctx.tools;
  if (!tools || typeof tools.register !== "function") return;

  const reg = (def) => {
    try {
      tools.register(def);
    } catch (e) {
      ctx.logger?.warn?.(`[purge2-lab] tool ${def.name} failed: ${e?.message || e}`);
    }
  };

  reg({
    name: "lab_asset_add",
    description: "记录/更新一条演练资产（kind: host|service|credential|note）",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string" },
        key: { type: "string" },
        value: { type: "string" },
        source: { type: "string" },
      },
      required: ["kind", "key", "value"],
    },
    handler: async (args) => assetAdd(db, args),
  });

  reg({
    name: "lab_asset_query",
    description: "按 kind / 关键词查询演练资产",
    parameters: {
      type: "object",
      properties: { kind: { type: "string" }, q: { type: "string" }, limit: { type: "number" } },
    },
    handler: async (args) => ({ rows: assetQuery(db, args || {}) }),
  });

  reg({
    name: "lab_asset_stats",
    description: "资产与证据数量统计",
    parameters: { type: "object", properties: {} },
    handler: async () => assetStats(db),
  });

  reg({
    name: "lab_evidence_record",
    description: "记一条证据。level 必须是 claimed/observed/derived/inferred；claimed 表示『子代理自称』，不可直接采信",
    parameters: {
      type: "object",
      properties: {
        level: { type: "string" },
        summary: { type: "string" },
        raw: { type: "string" },
        assetKey: { type: "string" },
      },
      required: ["level", "summary"],
    },
    handler: async (args) => evidenceRecord(db, args),
  });

  reg({
    name: "lab_evidence_list",
    description: "列出证据，并区分可信（observed/derived）与自称（claimed）",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
    handler: async (args) => evidenceList(db, args || {}),
  });

  reg({
    name: "lab_report",
    description: "生成本次演练成果报告（JSON）",
    parameters: { type: "object", properties: { target: { type: "string" } } },
    handler: async (args) => buildReport(db, args || {}),
  });
}

export default apply;
