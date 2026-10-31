/**
 * 真机 Web 冒烟：真实 cordis Context + 真实 WebServer + 真实 HTTP 请求。
 *
 * 按本机验证过的配方：
 *   · createRequire 从 profile 取真实包
 *   · Service 类必须走 ctx.plugin 才会执行 [Service.init]（内部才真正 listen）
 *   · 轮询 port > 0 等就绪
 *   · 末尾必须 process.exit —— 真实 WebServer 会永久挂住事件循环
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const reqProfile = createRequire(join(homedir(), ".dsh", "profiles", "web", "package.json"));

let ok = true;
const chk = (name, cond, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) ok = false;
};

let Context, WebServer;
try {
  ({ Context } = reqProfile("@deepseek-ai/cordis"));
  const wsMod = reqProfile("@deepseek-ai/dsh-host-webserver");
  WebServer = wsMod.WebServer ?? wsMod.default ?? wsMod;
} catch (e) {
  console.log(`SKIP 取不到真实包：${e.message}`);
  process.exit(0);
}

const ctx = new Context();
let port = 0;
try {
  ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    const svc = ctx.get?.("webServer") ?? ctx.webServer;
    port = svc?.port ?? svc?.listenedPort ?? 0;
    if (port > 0) break;
  }
} catch (e) {
  chk("WebServer 挂载", false, e.message);
}

chk("真实 WebServer 已监听", port > 0, `port=${port}`);
if (port <= 0) {
  await new Promise((r) => setTimeout(r, 30));
  process.exit(1);
}

// 本插件只 inject systemPrompt；宿主里它是真服务，这里用最小假实现补齐
ctx.provide?.("systemPrompt", {
  section: () => () => {},
  getSectionOrder: () => 0,
});

const ours = await import("../lib/index.js");
ctx.plugin({ name: ours.name, inject: ours.inject, apply: ours.apply }, { autoApplyOnStart: false });
await new Promise((r) => setTimeout(r, 400));

const base = `http://127.0.0.1:${port}`;
const get = async (p, method = "GET") => {
  const res = await fetch(base + p, { method });
  const text = await res.text();
  return { status: res.status, text, ct: res.headers.get("content-type") || "" };
};

const panel = await get("/purge2/");
chk("面板 200", panel.status === 200, `status=${panel.status}`);
chk("面板是 HTML", panel.ct.includes("text/html"));
chk("面板自包含（无外部 http 资源）", !/(?:src|href)="https?:\/\//.test(panel.text));
chk("面板含铁律基调 #232d3a", panel.text.includes("#232d3a"));
chk("面板含补丁清单", panel.text.includes("补丁清单"));

const api = await get("/purge2/api/state");
chk("API state 200", api.status === 200, `status=${api.status}`);
let parsed = null;
try {
  parsed = JSON.parse(api.text);
} catch {
  /* ignore */
}
chk("API state 是合法 JSON 且 rows 是数组", !!parsed && Array.isArray(parsed.rows), `rows=${parsed?.rows?.length}`);

const audit = await get("/purge2/api/audit");
chk("API audit 200", audit.status === 200, `status=${audit.status}`);

const ro = await get("/purge2/api/state", "POST");
chk("写方法被拒（405 只读）", ro.status === 405, `status=${ro.status}`);

const nf = await get("/purge2/nope");
chk("未知子路径 404", nf.status === 404, `status=${nf.status}`);

await new Promise((r) => setTimeout(r, 60));
process.exit(ok ? 0 : 1);
