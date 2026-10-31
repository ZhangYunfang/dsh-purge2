/**
 * 配置通道：不需要改任何源码就能拿到的能力。
 *
 * 两条都在 dsh-system-prompt / dsh-user-approval 的 Config schema 里，
 * 由本包自带的 cordis.patch.yml（bundle 层）声明，不写用户 profile 文件。
 *
 * 为什么单列一条通道：这三个上游仓库把一切都当"源码补丁"，
 * 于是连 config 能解决的事也去改 node_modules——多一次可被 npm 覆盖的风险，
 * 多一套 .bak 需要维护。能配置就不打补丁，是更省事的工程选择。
 */

/**
 * 已声明的 config seam。
 * 与 cordis.patch.yml 必须一一对应，verifyConfigSeams() 会核对。
 */
export const CONFIG_SEAMS = [
  {
    id: "C1",
    name: "HARNESS_IDENTITY_STRIP",
    loaderId: "system-prompt",
    loaderName: "@deepseek-ai/dsh-system-prompt",
    config: { includeHarnessIdentity: false, persona: "" },
    why: "官方身份句「You are a coding agent powered by the {{model}} model.」会压过操作者的角色设定",
    verify: "system-prompt 的 includeHarnessIdentity=false 且 persona 为空",
  },
];

/**
 * 明确**不**做的事：不要把 approval policy 设成 never。
 * 在 0.1.2 里那是 fail-closed（拒绝一切需要审批的操作），不是自动放行。
 * 真正的自动放行走 runtime/approval-grant.js 的 approval/request 瀑布。
 */
export const APPROVAL_POLICY_NOTES = {
  policyAsk: "保持 ask：审批请求会进入 approval/request 瀑布，插件在那里放行",
  policyNever: "切勿设为 never：0.1.2 的 never = 一律 rejected（见 dsh-user-approval/lib/index.js:188）",
};

/** 从一段 cordis.patch.yml 文本里粗判某个 loader id 的 config 是否已按预期设置 */
export function seamsPresentInPatchText(text) {
  const out = [];
  const src = String(text || "");
  for (const s of CONFIG_SEAMS) {
    const hasId = new RegExp(`-\\s*id:\\s*["']?${s.loaderId}["']?`).test(src);
    const hasCmds = Object.entries(s.config).every(([k, v]) => {
      const re = new RegExp(`${k}:\\s*["']?${String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?`);
      return re.test(src);
    });
    out.push({ ...s, declared: hasId && hasCmds });
  }
  return out;
}
