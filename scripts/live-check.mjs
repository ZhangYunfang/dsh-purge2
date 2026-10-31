/**
 * 活体验证（live-check）—— 重启 dsh-web 之后跑这个，确认插件在**真实进程里**已生效
 *
 * 与 host-check 的分工：
 *   host-check  进程内全链路（沙箱、随时可跑、无副作用）
 *   live-check  真实运行实例（需要先装好并重启；只读，不改任何东西）
 *
 * 判据（每条都给出"没通过意味着什么"）：
 *   1  面板 HTTP 200          —— 插件已加载且 webServer 路由注册成功
 *   2  面板含补丁清单          —— 渲染链路正常
 *   3  api/state 里 applied>0  —— 插件进程内真的 apply 过
 *   4  真机产物含 marker       —— 补丁确实写进了 node_modules
 *   5  证据目录有文件          —— E1 证据在落盘
 *   6  api/state 的 e2 非 null —— 运行时注入已被观测（说明 assemble 跑过）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.DSH_PORT || "3080";
const HOST = process.env.DSH_HOST || "localhost";
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const AI = path.join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai");
const BASE = `http://${HOST}:${PORT}`;

let ok = true;
const chk = (name, cond, extra = "", hint = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) {
    ok = false;
    if (hint) console.log(`    → ${hint}`);
  }
};

const get = async (p) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(BASE + p, { signal: ac.signal });
    return { status: res.status, text: await res.text(), ct: res.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, text: String(e?.message || e), ct: "" };
  } finally {
    clearTimeout(t);
  }
};

console.log(`== 活体验证 ${BASE}  (DSH_HOME=${DSH_HOME}) ==\n`);

const panel = await get("/purge2/");
chk("面板 200", panel.status === 200, `status=${panel.status}`, "插件可能还没加载；重启 dsh-web 后再试。也可能是系统代理吃掉了 localhost，试试 DSH_HOST=127.0.0.1");
chk("面板是 HTML", panel.ct.includes("text/html"), "", "路由返回的不是页面");
chk("面板含补丁清单", panel.text.includes("补丁清单"), `${panel.text.length}B`);

const api = await get("/purge2/api/state");
let st = null;
try {
  st = JSON.parse(api.text);
} catch {
  /* ignore */
}
chk("api/state 200 且可解析", api.status === 200 && !!st, `status=${api.status}`);
if (st) {
  const applied = (st.rows || []).filter((r) => r.status === "applied" || r.status === "already").length;
  const pending = (st.rows || []).filter((r) => r.status === "pending").length;
  chk("进程内 applied>0", applied > 0, `applied=${applied} pending=${pending}`, "插件加载了但没打补丁：看 autoApplyOnStart 或宿主版本");
  chk(
    "E2 运行时注入已被观测",
    st.evidence?.e2?.ok === true,
    `e2=${JSON.stringify(st.evidence?.e2?.ok)} assembles=${st.evidence?.e2?.assembles ?? 0}`,
    "还没发生一次系统提示组装；在本会话里发一轮消息再看",
  );
  chk("E3 行为证据有值", st.evidence?.e3?.ok === true, `e3=${JSON.stringify(st.evidence?.e3?.ok)}`);
}

// 磁盘侧：真机产物是否真有 marker
const { SOURCE_PATCHES } = await import(new URL("../lib/patches/legacy-0.1.js", import.meta.url).pathname);
const { hasMarker } = await import(new URL("../lib/patch-engine.js", import.meta.url).pathname);
let onDisk = 0;
for (const p of SOURCE_PATCHES) {
  for (const t of p.targets) {
    const fp = path.join(AI, t.pkg, ...t.rel);
    try {
      if (hasMarker(fs.readFileSync(fp, "utf8"), p.markers)) {
        onDisk += 1;
        break;
      }
    } catch {
      /* 文件不在 */
    }
  }
}
chk("真机产物含补丁 marker", onDisk > 0, `${onDisk}/${SOURCE_PATCHES.length} 条`, "插件还没在真实进程里跑过 apply");

const evDir = path.join(DSH_HOME, "purge2", "evidence");
let evFiles = 0;
try {
  evFiles = fs.readdirSync(evDir).filter((f) => f.endsWith(".jsonl")).length;
} catch {
  /* 还没写过 */
}
chk("证据目录已落盘", evFiles > 0, `${evFiles} 个文件`, "跑一次 apply 或等一轮对话");

console.log(ok ? "\nLIVE-CHECK: PASS" : "\nLIVE-CHECK: FAIL（上面每条都带了原因与下一步）");
await new Promise((r) => setTimeout(r, 50));
process.exit(ok ? 0 : 1);
