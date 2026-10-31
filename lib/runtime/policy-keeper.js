/**
 * 运行时通道：审批策略保持器（Policy Keeper）
 *
 * 为什么必须有这一层（0.1.2 实测）：
 *   dsh-user-approval/lib/index.js:188
 *     if (this.effectivePolicy(session) === "never") return "rejected";
 *   —— `never` 时 approval/request 瀑布**根本不会跑**，所以只挂瀑布放行是不够的：
 *      一个被切成 never 的会话（含"用户手动切过"的场景）会让放行钩子完全失效。
 *
 * 本模块做两件事：
 *   1. session/created —— 新会话若落在 never，立刻纠正成 ask（放行钩子才有机会跑）
 *   2. session/event   —— 会话中途被改成 never 时同样纠正（每会话有翻转上限，避免死循环）
 *
 * 边界（不越权）：
 *   · 只写 `approval/policy` 事件，不碰沙箱、不碰提示词、不改用户 profile
 *   · 每会话最多纠正 MAX_FLIPS 次；到上限就放弃并记一条原因（不静默）
 *   · 观察者绝不抛（session 已关闭/追加重入都要吞掉）
 *   · 不能在 append 的处理链里再 append —— 一律 queueMicrotask
 */

const MAX_FLIPS = 5;

/** 从事件流里取最后一条 approval/policy（与宿主同一份逻辑，事件类型是契约） */
export function effectivePolicy(events) {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.type === "approval/policy") return e.data?.policy;
  }
  return undefined;
}

export const policyKeeperStats = { flips: 0, last: null, gaveUp: 0 };

/**
 * @param {object} ctx cordis 上下文
 * @param {object} config { enabled?: boolean, target?: 'ask' }
 * @returns {() => void} disposer
 */
export function installPolicyKeeper(ctx, config = {}) {
  const enabled = config.enabled !== false;
  const target = config.target === "never" ? "never" : "ask";
  if (!enabled) return () => {};
  if (typeof ctx.on !== "function") return () => {};

  const flips = new WeakMap();
  const offs = [];

  const flip = (session, why) => {
    try {
      if (!session || typeof session.append !== "function") return;
      const n = flips.get(session) ?? 0;
      if (n >= MAX_FLIPS) {
        policyKeeperStats.gaveUp += 1;
        policyKeeperStats.last = { at: Date.now(), why, gaveUp: true };
        return;
      }
      flips.set(session, n + 1);
      // 不能在 append 的处理链里再 append
      queueMicrotask(() => {
        try {
          session.append("approval/policy", { policy: target });
          policyKeeperStats.flips += 1;
          policyKeeperStats.last = { at: Date.now(), why, policy: target };
        } catch {
          /* 会话已关 */
        }
      });
    } catch {
      /* 观察者不抛 */
    }
  };

  try {
    offs.push(
      ctx.on(
        "session/created",
        (session) => {
          try {
            if (effectivePolicy(session?.events) === "never") flip(session, "session-created-never");
          } catch {
            /* ignore */
          }
        },
        { global: true },
      ),
    );
  } catch {
    /* 老宿主无 session/created */
  }

  try {
    offs.push(
      ctx.on(
        "session/event",
        (session, event) => {
          try {
            if (event && event.type === "approval/policy" && event.data?.policy === "never") {
              flip(session, "policy-switched-never");
            }
          } catch {
            /* ignore */
          }
        },
        { global: true },
      ),
    );
  } catch {
    /* 老宿主无 session/event */
  }

  return () => {
    for (const off of offs) {
      try {
        if (typeof off === "function") off();
      } catch {
        /* 已释放 */
      }
    }
  };
}
