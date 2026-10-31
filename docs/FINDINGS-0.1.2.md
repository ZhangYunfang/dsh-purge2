# DSH 0.1.2-alpha.2 实测发现

> 全部结论来自本机 `~/.dsh/profiles/node_modules/@deepseek-ai`（0.1.2-alpha.2 产物）
> 与 `packages/` 源码，不是从上游 docs 转述。

---

## 1. 致命坑：`approval policy = never` 是「拒绝一切」，不是自动放行

**这是三个上游仓库在 0.1.x 上会踩反的坑。**

`dsh-user-approval/lib/index.js`：

```js
:37  const NEVER_SENTENCE = "Approval prompts are disabled in this session:
        actions that require approval are rejected automatically …"
:188 async decide(req, session) {
        if (signal?.aborted) return "cancelled";
        if (this.effectivePolicy(session) === "never") return "rejected";   // ← 在这里就返回了
        const answer = …ctx.waterfall(… "approval/request" …)                 // ← 瀑布根本不会跑
      }
```

也就是说：

| 做法 | 0.1.2 上的真实效果 |
| --- | --- |
| `policy: "never"` | 需要审批的操作**全部 rejected**，且 `approval/request` 瀑布**不执行** |
| `policy: "ask"` + 瀑布里 `return "allowed-once"` | **真正的自动放行** |

上游的补丁 `#10 APPROVAL_CONFIG_DEFAULT_NEVER`（把 Config 默认改成 `never`）如果直接搬到 0.1.2，
结果是把用户变成"什么都做不了"。上游能在 0.2.x 这么干，说明 0.2.x 的 `never` 语义与 0.1.x 相反。

**本仓库的做法**：`policy` 保持 `ask`，在 `approval/request` 瀑布 `prepend` 一个 handler 直接
`return "allowed-once"`（`OUTCOMES` 里唯一的放行值）。见 `lib/runtime/approval-grant.js`。

该钩子写法有上游实证：`YuJunZhiXue/dsh-purge lib/subagent-control.js:48` 用的就是这个 idiom，
且必须 `{ global: true }`——宿主调用是 `ctx.waterfall(scopeTarget(req.agent, req.agent), …)`，是 agent 作用域。

---

## 2. 上游 85 条补丁，只有 30 条在 0.1.2 上锚点命中

把上游 `ALL_PATCHES` 的每条 `replacements[].pattern` 直接拿去数 0.1.2 产物的出现次数：

```
补丁总数 85 → 有锚点命中 30
```

命中的里有几条是"意外之喜"（0.1.2 与 0.2.x 该文件逐字节相同）：

| 上游补丁 | 0.1.2 命中 | 备注 |
| --- | --- | --- |
| #17 FS_OBSERVATION_INTENT_FREE | 2 | 连 tab 缩进都一样，**原样可用** |
| #22 READ_CAPS_RAISED | 3 | 三个常量全在 |
| #25 HARNESS_IDENTITY_STRIP | 3 | 但这条其实该走 config |
| #1 WORKSPACE_CONTEXT_INTRO | 1 | 0.1.2 只有老一代写法（无 `AGENT_INSTRUCTIONS_INTRO`） |
| #33 TOOL_SHELL_DENIAL_PROMPT | 19 | |
| #89 SANDBOX_POLICY_BRAND_NEUTRAL | 6 | |

不命中的 55 条分三类：
1. **包不存在**（如 `dsh-hooks-codex`、`dsh-desktop-*` 在 0.1.2 没有对应产物）
2. **同名文件但代码重写过**（如 `personaPrefix` 在 0.1.2 是 `persona`）
3. **语义相反**（如 #10，见第 1 节）

**结论：不能按"补丁编号"移植，必须按"锚点"重采。** 本仓库的 `lib/patches/legacy-0.1.js`
每一条都附 `expect` 命中数契约，`apply` 时实际不符就整条拒写。

---

## 3. 两条能力其实不用改源码

| 能力 | 0.1.2 的接缝 | 证据 |
| --- | --- | --- |
| 身份剥离 | `dsh-system-prompt` 的 `Config.includeHarnessIdentity` + `persona` | `lib/index.js:196-201`，bundle 层 `cordis.patch.yml` 可配 |
| 审批自动放行 | `approval/request` waterfall | `lib/index.js:189` + 上游 subagent-control.js:48 |

于是本仓库把它们放进 config / runtime 通道，零源码改动。

loader id（bundle 层声明要用）：

```yaml
- id: system-prompt      # name: @deepseek-ai/dsh-system-prompt
- id: approval           # name: @deepseek-ai/dsh-user-approval，config.policy 只能 ask|never
- id: fs-observation-policy   # name: @deepseek-ai/dsh-fs-observation-policy
```

---

## 4. 补丁目标文件的真实位置

本机 **不是** 每 profile 一套包，而是共享一层：

```
~/.dsh/profiles/node_modules/@deepseek-ai/
  dsh-agent-instructions/lib/index.js
  dsh-fs-observation-policy/lib/index.js
  dsh-tool-fs/lib/index.js
  dsh-system-prompt/lib/index.js
  dsh-user-approval/lib/index.js
```

`host-probe.js` 因此按 `$DSH_HOME/profiles/node_modules` → 各 profile 自带 `node_modules` 顺序找，
并**只认一份**（不扫描机器上其它安装——社区版 `instance.js` 的教训）。

---

## 5. 产物缩进是 tab

0.1.2 的 `lib/*.js` 用 **tab** 缩进。写 pattern 时若用空格，一条都匹配不上。
本仓库所有多行 pattern 一律用 `\t` 拼接，且 `plan` 会打印每条的实际字符增量供肉眼复核。

---

## 6. 致命坑（实现期实测）：往 cordis 的 `ctx` 上写未知属性 = 整个插件被静默回收

现象：`ctx.plugin(...)` 挂载成功、`apply()` 里的 `console.log` 也确实打印了，
但**所有 effect 全部失效**——注入的 section 不在 assemble 结果里，事件钩子也不触发。没有任何报错。

根因：cordis 4.0.2 的 `ctx` 是 **Proxy**（`lib/index.js` 的 `Context` 类）。给 ctx 写一个
它不认识的属性（当时写的是 `ctx.purge2 = {...}` 用于对外暴露句柄）会让 Proxy 的 set 抛错；
`apply()` 因此抛出 → fiber 判定插件失败 → **回首掏把所有已注册的 effect dispose 掉**。
而 cordis 把这个错误吞进 `internal/error`，不打日志。

两个必须遵守的写法：

```js
// ❌ 会静默炸掉整个插件
ctx.purge2 = { plan, apply };

// ✅ 模块级句柄
let handle = null;
export function getHandle() { return handle; }
```

另外：`apply()` 整体要包 try/catch。局部 try/catch 救不了——抛出点在外面一样会回收 fiber。

**判据**：挂载后用真实 `systemPrompt.assemble({})` 看 sections 里有没有你的段。
`test/mount.smoke.mjs` 就是这条判据的可执行版本（7 项断言全绿）。

## 7. 真实挂载的最小可行姿势

```js
const { Context } = await import('@deepseek-ai/cordis');
const ctx = new Context();
const sp = await import('@deepseek-ai/dsh-system-prompt');
ctx.plugin(sp.default, { includeHarnessIdentity: true, persona: '' });
await new Promise(r => setTimeout(r, 50));           // 让 fiber 落地

const svc = ctx.get('systemPrompt');                  // ctx.systemPrompt 也可以，但 get() 更稳
console.log(svc.getSectionOrder('DEPLOYMENT_PERSONA')); // → 0

ctx.plugin({ name, inject, apply }, config);          // ← 传「带 inject 的对象」，别只传函数
await new Promise(r => setTimeout(r, 80));
const asm = await svc.assemble({});
// asm.sections → [harness:identity, deployment:persona, purge2:operator, purge2:anchor]
```

关键两点：
1. **只传函数不行**：cordis 从 `plugin.inject` 读依赖，裸函数没有 inject，服务还没就绪就跑了。
2. 段位用 `getSectionOrder('DEPLOYMENT_PERSONA') + 1`（=1），落在 persona 之后、PLAN_POLICY(500) 之前。
