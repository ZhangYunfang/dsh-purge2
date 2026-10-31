/**
 * L0 宿主探测层 —— 在改动任何字节之前，先说清"我在改谁"。
 *
 * 设计要点（三仓库都没有的增量）：
 *   · 只认「当前实例」，不扫描机器上其它安装（社区 instance.js 的教训）
 *   · 逐包读版本，不一致就标 partial，不假装统一
 *   · 产出 anchors 探针表：把"这条补丁能不能打"从运行时才知道，变成开工前就知道
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 认得的宿主大版本（本方案只做 0.1.x） */
export const SUPPORTED_TRACKS = ["legacy-0.1"];

/** 探测目标包 → 用于判断宿主版本一致性的核心包 */
const CORE_PACKAGES = [
  "dsh-agent-instructions",
  "dsh-system-prompt",
  "dsh-user-approval",
  "dsh-fs-observation-policy",
  "dsh-tool-fs",
];

/** dshHome 三级探测：$DSH_HOME → 启动器旁 .dsh → ~/.dsh */
export function resolveDshHome(env = process.env) {
  const candidates = [];
  if (env.DSH_HOME) candidates.push(env.DSH_HOME);
  // 启动器旁（源码/便携布局）
  try {
    candidates.push(path.join(process.cwd(), ".dsh"));
  } catch {
    /* cwd 不可用 */
  }
  candidates.push(path.join(os.homedir(), ".dsh"));
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "profiles"))) return c;
  }
  // 一个都不存在时返回最后一级，方便报错信息可读
  return candidates[candidates.length - 1];
}

/** 在 dshHome 下找真正装 @deepseek-ai 的那层 node_modules */
export function resolveAiBase(dshHome) {
  const candidates = [
    path.join(dshHome, "profiles", "node_modules", "@deepseek-ai"),
    path.join(dshHome, "node_modules", "@deepseek-ai"),
  ];
  // 也支持 profile 自带 node_modules（`dsh plugin add` 的布局）
  try {
    for (const name of fs.readdirSync(path.join(dshHome, "profiles"))) {
      if (name === "node_modules") continue;
      candidates.push(path.join(dshHome, "profiles", name, "node_modules", "@deepseek-ai"));
    }
  } catch {
    /* profiles 不可读 */
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return { aiBase: c, found: true };
  }
  return { aiBase: candidates[0], found: false };
}

function readPkgVersion(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

/** 版本 → 轨道标签。0.1.x 一律 legacy-0.1 */
export function trackOf(version) {
  const m = /^(\d+)\.(\d+)\./.exec(String(version || ""));
  if (!m) return "unknown";
  const [, major, minor] = m;
  if (major === "0" && minor === "1") return "legacy-0.1";
  if (major === "0" && minor === "2") return "current-0.2";
  return "unknown";
}

/**
 * 探一张锚点表：对每个 target 文件数一遍锚点出现次数。
 * 纯只读，不写任何字节。plan 的数据来源就是它。
 *
 * @param {string} aiBase @deepseek-ai 目录
 * @param {Array<{pkg:string, rel:string[]}>} targets
 * @param {string[]} anchors 需统计的锚点字面量
 */
export function probeAnchors(aiBase, targets, anchors) {
  const table = {};
  for (const t of targets) {
    const file = path.join(aiBase, t.pkg, ...t.rel);
    const key = `${t.pkg}/${t.rel.join("/")}`;
    if (!fs.existsSync(file)) {
      table[key] = { exists: false, counts: {} };
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      table[key] = { exists: true, readable: false, counts: {} };
      continue;
    }
    const counts = {};
    for (const a of anchors) {
      counts[a] = a ? text.split(a).length - 1 : 0;
    }
    table[key] = { exists: true, readable: true, counts };
  }
  return table;
}

/**
 * 生成 HostProfile。这是所有后续决策的唯一事实来源。
 */
export function buildHostProfile(env = process.env) {
  const dshHome = resolveDshHome(env);
  const { aiBase, found } = resolveAiBase(dshHome);
  const packages = {};
  if (found) {
    for (const p of CORE_PACKAGES) {
      const v = readPkgVersion(path.join(aiBase, p));
      if (v) packages[p] = v;
    }
  }
  const versions = [...new Set(Object.values(packages))];
  const dshVersion = versions.length === 1 ? versions[0] : versions.length > 1 ? "partial" : "";
  return {
    dshHome,
    aiBase,
    aiBaseFound: found,
    dshVersion,
    packageVersions: versions,
    packages,
    track: trackOf(versions[0]),
    surface: detectSurface(dshHome),
  };
}

/** 面判定：有 web profile 目录 → web；否则 desktop/headless 不可靠区分，标 unknown */
function detectSurface(dshHome) {
  try {
    const dirs = fs.readdirSync(path.join(dshHome, "profiles")).filter((d) => d !== "node_modules");
    if (dirs.includes("web")) return "web";
    if (dirs.includes("desktop")) return "desktop";
    return dirs[0] || "unknown";
  } catch {
    return "unknown";
  }
}
