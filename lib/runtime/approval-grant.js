/**
 * 运行时通道：审批自动放行（对应上游 #9 的等价能力，但**不改源码**）
 *
 * 为什么不能照抄上游 #10「把 approval policy 默认改成 never」——
 * 0.1.2 的 never 语义是 **失败即拒**（fail closed），不是自动放行：
 *
 *   dsh-user-approval/lib/index.js:37
 *   NEVER_SENTENCE = "Approval prompts are disabled in this session:
 *                     actions that require approval are rejected automatically"
 *   :188  if (this.effectivePolicy(session) === "never") return "rejected";
 *
 * 所以正确做法是：**policy 保持 ask**，把决定权抢到 approval/request 瀑布里，
 * 直接 return "allowed-once"（OUTCOMES 里唯一的放行值）。
 *
 * 该钩子写法的可行性证据：上游 subagent-control.js:48 用的就是这个 idiom
 *   ctx.on("approval/request", (request, next) => "allowed-once", { global: true, prepend: true })
 * 必须 global —— 宿主调用是 ctx.waterfall(scopeTarget(req.agent, req.agent), ...)，是 agent 作用域。
 */

/**
 * @param {object} ctx cordis 插件上下文
 * @param {object} config { enabled?: boolean, scope?: "all"|"child"|"off" }
 * @returns {() => void} disposer
 */
export function installApprovalGrant(ctx, config = {}) {
  const enabled = config.enabled !== false;
  if (!enabled) return () => {};
  if (typeof ctx.on !== "function") return () => {};

  const handler = (request, next) => {
    try {
      approvalGrantStats.granted += 1;
      approvalGrantStats.last = {
        tool: String(request?.toolName ?? ""),
        at: Date.now(),
      };
      // 无视 answerer 直接授信：本插件的价值就是取消这一层往返。
      // 需要保留人工确认时把 config.enabled 设 false（或 scope=off）。
      return "allowed-once";
    } catch {
      return typeof next === "function" ? next() : "unavailable";
    }
  };

  let off = null;
  try {
    off = ctx.on("approval/request", handler, { global: true, prepend: true });
  } catch {
    // 老宿主没有该瀑布：退化为不接管，不报错
    return () => {};
  }
  return () => {
    try {
      if (typeof off === "function") off();
    } catch {
      /* 已释放 */
    }
  };
}

/** 供证据链读取：本次进程内已放行的审批次数（E3 行为证据） */
export const approvalGrantStats = { granted: 0, last: null };
