/**
 * Web 路由：面板 + 只读 API
 *
 * 接缝：ctx.inject(['webServer'], host => host.effect(() => host.webServer.register(route)))
 * route = { kind: 'exact'|'prefix', path, handler(req, res) } —— handler 是 Node 原生 (req, res)，
 * 不是 Fetch API。分发规则「精确表优先，其后最长前缀」，所以第三方 prefix 不会被 /api 挡住。
 *
 * 只读：所有 GET 都不改宿主、不改配置；写操作一律走 CLI（要人明确敲命令）。
 */

import { buildPanelHtml } from "./panel.js";

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, html, code = 200) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} deps { getState: () => state, getEvidence, getAudit }
 * @returns {() => void} disposer
 */
export function installWeb(ctx, deps = {}) {
  if (typeof ctx.inject !== "function") return () => {};
  let disposed = false;
  try {
    ctx.inject(["webServer"], (host) => {
      const web = host.webServer || host.get?.("webServer");
      if (!web || typeof web.register !== "function") return;
      const disposers = [];

      const handle = async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          // 前缀路由不带尾斜杠（宿主 match 用 startsWith(prefix + "/")，带斜杠会变成 "//" 永不命中）
          const sub = url.pathname.replace(/^\/purge2/, "").replace(/^\//, "").replace(/\/$/, "");
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, { error: "read-only endpoint; use the CLI for writes" }, 405);
          }
          if (sub === "" || sub === "index.html") {
            const state = deps.getState ? await deps.getState() : {};
            return sendHtml(res, buildPanelHtml(state));
          }
          if (sub === "api/state") {
            const state = deps.getState ? await deps.getState() : {};
            // 面板 HTML 太大，不进 API
            const { rows, summary, profile, selfcheck, evidence, backups, audit, snapshotAt } = state;
            return sendJson(res, { profile, rows, summary, selfcheck, evidence, backups, audit, snapshotAt });
          }
          if (sub === "api/evidence") {
            return sendJson(res, deps.getEvidence ? await deps.getEvidence() : {});
          }
          if (sub === "api/audit") {
            return sendJson(res, deps.getAudit ? await deps.getAudit() : []);
          }
          return sendJson(res, { error: "not found", path: url.pathname }, 404);
        } catch (e) {
          return sendJson(res, { error: String(e?.message || e) }, 500);
        }
      };

      // kind=prefix + path 不带尾斜杠：命中 /purge2 与 /purge2/* 全部
      disposers.push(web.register({ kind: "prefix", path: "/purge2", handler: handle }));

      host.effect(() => () => {
        disposed = true;
        for (const d of disposers) {
          try {
            if (typeof d === "function") d();
          } catch {
            /* ignore */
          }
        }
      });
    });
  } catch {
    return () => {};
  }
  return () => {
    disposed = true;
  };
}

export const PANEL_PATH = "/purge2/";
export { sendJson, sendHtml };
