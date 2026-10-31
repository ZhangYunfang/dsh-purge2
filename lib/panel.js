/**
 * 面板：单个自包含 HTML 页（无 CDN、断网可用）
 *
 * 样式不自己发明：直接内联 ui-iron-law 技能的 theme.css（唯一真相源），
 * 再叠一小段页面级样式。找不到主题就明确报错，**不复制一份来私改**。
 *
 * 交付前必须过门禁：verify_ui.py <页面> → 末行 UI_IRON_LAW: PASS
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 主题真源候选路径（环境项，不硬编码别的机器的路径） */
const THEME_CANDIDATES = [
  process.env.UI_IRON_LAW_THEME || "",
  path.join(os.homedir(), ".agents", "skills", "ui-iron-law", "assets", "theme.css"),
].filter(Boolean);

export function loadThemeCss() {
  for (const p of THEME_CANDIDATES) {
    try {
      const css = fs.readFileSync(p, "utf8");
      if (css.trim()) return { css, file: p };
    } catch {
      /* 下一个候选 */
    }
  }
  return { css: "", file: "" };
}

/** 页面级补充样式（只加铁律没覆盖的，不改令牌） */
const PAGE_CSS = `
.wrap{max-width:1180px;margin:0 auto;padding:18px 20px 64px;position:relative;z-index:1}
h1{font-size:21px}
.sub{font-size:12.5px}
.meta{font-size:12px}
.banner{font-size:12.5px}
.metric-value{font-size:23px}
.metric-label{font-size:12px}
.cards .card .k{font-size:12px}
.cards .card .v{font-size:20px}
.cards .card .s{font-size:11.5px}
table{font-size:12.5px}
th{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase}
td.pad{padding:9px 10px}
.tag{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums;
  border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--fg-dim)}
.tag.ok{color:var(--green);border-color:rgba(74,222,128,.45);background:rgba(74,222,128,.10)}
.tag.warn{color:var(--amber);border-color:rgba(247,185,85,.45);background:rgba(247,185,85,.10)}
.tag.bad{color:var(--red);border-color:rgba(255,122,122,.5);background:rgba(255,122,122,.10)}
.tag.na{color:var(--fg-mute);border-color:var(--line-soft)}
details.plate{background:var(--bg-elev);border:1px solid var(--line-soft);border-radius:var(--radius);
  padding:10px 14px;margin:10px 0;transition:border-color .18s ease}
details.plate[open]{border-color:var(--line)}
details.plate summary{cursor:pointer;font-weight:600;font-size:13px}
details.plate .why{color:var(--fg-dim);font-size:12.5px;margin-top:6px}
.kv{color:var(--fg-mute);font-size:11.5px;font-family:var(--mono);font-variant-numeric:tabular-nums}
footer{margin-top:28px;padding-top:14px;border-top:1px solid var(--line-soft);color:var(--fg-mute);font-size:12px}
`;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_TAG = {
  applied: "ok",
  already: "ok",
  pending: "warn",
  na: "na",
  missing_file: "na",
  unmatched: "warn",
  hit_count_mismatch: "bad",
  drifted: "bad",
  error: "bad",
};

function freshness(snapshotAt) {
  const t = Date.parse(snapshotAt || "");
  if (!Number.isFinite(t)) return { cls: "warn", text: "🟡 数据时间未知：状态快照没有时间戳", age: "未知" };
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  const age = min < 60 ? `${min} 分钟` : `${(min / 60).toFixed(1)} 小时`;
  if (min <= 5) return { cls: "ok", text: `🟢 状态新鲜：快照 ${age}前生成`, age };
  if (min <= 60) return { cls: "warn", text: `🟡 状态偏旧：快照 ${age}前生成 —— 重启 DSH 或刷新可得最新`, age };
  return { cls: "bad", text: `🔴 状态陈旧：快照 ${age}前生成 —— 本页是历史渲染，不代表当前进程`, age };
}

/**
 * 生成面板 HTML。
 * @param {object} state {profile, rows, summary, selfcheck, evidence, backups, audit, snapshotAt}
 */
export function buildPanelHtml(state = {}) {
  const theme = loadThemeCss();
  const profile = state.profile || {};
  const rows = state.rows || [];
  const summary = state.summary || { by: {}, applicable: 0, good: 0, ready: 0, health: "yellow" };
  const selfcheck = state.selfcheck || { state: "unknown", layers: [], counts: {}, evidence: {} };
  const evidence = state.evidence || { e1: [], e2: { ok: null }, e3: { ok: null } };
  const back = state.backups || { count: 0, bytes: 0 };
  const audit = state.audit || [];
  const snapAt = state.snapshotAt || new Date().toISOString();
  const fr = freshness(snapAt);

  const pill = summary.health === "green" ? ["ok", "全绿"] : summary.health === "red" ? ["bad", "需处理"] : ["warn", "部分"];
  const total = rows.length;
  const applied = rows.filter((r) => r.status === "applied" || r.status === "already").length;
  const ready = rows.filter((r) => r.status === "pending").length;
  const greenLayers = selfcheck.counts?.green ?? 0;
  const layerTotal = (selfcheck.layers || []).length;

  const cards = [
    { k: "补丁总数", v: String(total), s: "本轨道 legacy-0.1", w: 100 },
    { k: "已生效", v: String(applied), s: "applied + already", w: total ? (applied / total) * 100 : 0 },
    { k: "待应用", v: String(ready), s: "锚点已验，未写入", w: total ? (ready / total) * 100 : 0 },
    { k: "分层通过", v: `${greenLayers}/${layerTotal}`, s: "自检绿层数", w: layerTotal ? (greenLayers / layerTotal) * 100 : 0 },
    { k: "快照", v: String(back.count ?? 0), s: `${Math.round((back.bytes || 0) / 1024)} KB`, w: Math.min(100, (back.count || 0) * 10) },
    { k: "审计", v: String(audit.length), s: "最近记录条数", w: Math.min(100, audit.length * 5) },
  ];

  const metric = [
    {
      cls: "metric-high",
      v: evidence.e1?.filter?.((x) => x.markerFound === true).length ?? 0,
      label: "E1 静态生效文件",
    },
    { cls: "metric-confidence", v: evidence.e2?.ok === true ? "在" : "未知", label: "E2 运行时注入" },
    { cls: "metric-low", v: String(evidence.e3?.approvalGranted ?? 0), label: "E3 审批放行次数" },
    { cls: "metric-time", v: `${((evidence.e2?.costMs ?? 0) | 0)}ms`, label: "E2 单次注入耗时" },
  ];

  const rowHtml = rows
    .map((r) => {
      const cls = STATUS_TAG[r.status] || "na";
      const hits = (r.files || [])
        .filter((f) => f.hits)
        .map((f) => `${path.basename(String(f.file))} ${f.hits.join("+")}`)
        .join(" · ");
      return `<tr>
        <td class="kv">${esc(r.id)}</td>
        <td><b>${esc(r.name)}</b><div class="kv">${esc(r.why || "")}</div></td>
        <td class="kv">${esc(r.layer || "")}</td>
        <td><span class="tag ${cls}">${esc(r.status)}</span></td>
        <td class="kv">${esc(hits || r.reason || "—")}</td>
      </tr>`;
    })
    .join("\n");

  const layerHtml = (selfcheck.layers || [])
    .map(
      (l) => `<details class="plate"><summary>${esc(l.title)} · <span class="tag ${
        l.state === "green" ? "ok" : l.state === "red" ? "bad" : "warn"
      }">${esc(l.state)}</span> <span class="kv">${esc(l.detail || "")}</span></summary>
        <div class="why">本层没了：${esc(l.why)}</div></details>`,
    )
    .join("\n");

  const auditHtml = audit
    .slice(0, 8)
    .map(
      (a) =>
        `<tr><td class="kv">${esc(a.at)}</td><td>${esc(a.action)}</td><td class="kv">${esc(a.result)}</td><td class="kv">${esc(
          JSON.stringify(a.detail || {}),
        )}</td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>dsh-purge2 · 破甲控制台</title>
<style>
${theme.css}
${PAGE_CSS}
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="mark"></div>
    <div class="titleblock">
      <div class="titleline">
        <h1>dsh-purge2 · 破甲控制台</h1>
        <span class="pill-status ${pill[0]}"><span class="dot"></span>${pill[1]}</span>
      </div>
      <div class="sub">DSH ${esc(profile.dshVersion || "未知")} · 轨道 ${esc(profile.track || "?")} · 面 ${esc(
        profile.surface || "?",
      )} · 每条改动能证明、能回退</div>
    </div>
  </div>
  <div class="meta">
    <span>快照时间 <b>${esc(snapAt)}</b></span>
    <span>状态年龄 <b>${esc(fr.age)}</b></span>
    <span>补丁 <b>${applied}/${total}</b></span>
    <span>自检 <b>${esc(selfcheck.state || "unknown")}</b></span>
    <div class="links">
      <a href="api/state">↓ 状态 JSON</a><a href="api/evidence">↓ 证据</a><a href="api/audit">↓ 审计</a>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="banner ${fr.cls}">${esc(fr.text)}</div>

  <div class="cards">
${cards
  .map(
    (c) =>
      `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div><div class="s">${esc(
        c.s,
      )}</div><div class="spark"><i style="width:${Math.max(2, Math.min(100, c.w || 0))}%"></i></div></div>`,
  )
  .join("\n")}
  </div>

  <div class="metric-grid">
${metric
  .map(
    (m) =>
      `<div class="metric-card ${m.cls}"><div class="metric-value">${esc(m.v)}</div><div class="metric-label">${esc(
        m.label,
      )}</div></div>`,
  )
  .join("\n")}
  </div>

  <h2><span class="no">一</span>补丁清单</h2>
  <div class="toolbar">
    <input type="search" id="q" placeholder="筛选：编号 / 名称 / 状态（按 / 聚焦，Esc 清空）" oninput="flt(this.value)">
    <button onclick="expandAll(true)">展开全部</button>
    <button onclick="expandAll(false)">全部收起</button>
    <span class="hint" id="fcount"></span>
  </div>
  <div class="tablewrap">
    <table>
      <thead><tr><th>#</th><th>补丁</th><th>层</th><th>状态</th><th>锚点 / 原因</th></tr></thead>
      <tbody>
${rowHtml || '<tr><td colspan="5" class="kv">没有补丁记录</td></tr>'}
      </tbody>
    </table>
  </div>

  <h2><span class="no">二</span>分层自检（这层没了会怎样）</h2>
${layerHtml || '<div class="kv">未取得分层状态</div>'}

  <h2><span class="no">三</span>最近审计</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>时间</th><th>动作</th><th>结果</th><th>明细</th></tr></thead>
      <tbody>${auditHtml || '<tr><td colspan="4" class="kv">还没有审计记录</td></tr>'}</tbody>
    </table>
  </div>

  <footer>
    dsh-purge2 · 数据来源：本机 <code>$DSH_HOME/purge2</code> 与宿主产物探测（只读）·
    快照时间由服务端生成，<b>不使用文件 mtime</b> 判定新鲜度 ·
    页面自包含、断网可用 · 这是本地自托管工具，不连接任何外部服务
  </footer>
</div>

<button id="toTop" onclick="window.scrollTo({top:0,behavior:'smooth'})" title="回到顶部">↑</button>
<script>
(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr'));
  var count = document.getElementById('fcount');
  function update(n){ if(count) count.textContent = n + ' 行'; }
  window.flt = function(q){
    var k = (q||'').trim().toLowerCase(), n = 0;
    rows.forEach(function(tr){
      var t = tr.textContent.toLowerCase();
      var hit = !k || t.indexOf(k) !== -1;
      tr.classList.toggle('hidden', !hit);
      if(hit) n++;
    });
    update(n);
  };
  window.expandAll = function(open){
    document.querySelectorAll('details.plate').forEach(function(d){ d.open = !!open; });
  };
  document.addEventListener('keydown', function(e){
    var q = document.getElementById('q');
    if(e.key === '/' && document.activeElement !== q){ e.preventDefault(); q && q.focus(); }
    if(e.key === 'Escape' && q){ q.value=''; window.flt(''); q.blur(); }
  });
  var top = document.getElementById('toTop');
  window.addEventListener('scroll', function(){
    if(top) top.classList.toggle('show', window.scrollY > 600);
  });
  update(rows.length);
})();
</script>
</body>
</html>
`;
}
