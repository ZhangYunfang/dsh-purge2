# dsh-purge2

**DSH 破甲（0.1.x 专用）** —— DSH 0.1.x 上可证明、可回退的「降低交互摩擦」层。

上游 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 三兄弟（上游 / 镜像 / 社区）全部不支持
DSH 0.1.x，而本机跑的是 **0.1.2-alpha.2**。这个仓库把那三份的最优设计抽出来、把锚点全部重采到 0.1.2、
并补上它们都没有的东西：**三通道分级 + 三级证据链**。

## 三条通道（侵入性从低到高）

| 通道 | 做法 | 需要改 node_modules？ | 例子 |
| --- | --- | --- | --- |
| **config** | 由本包 `cordis.patch.yml`（bundle 层）声明 | ❌ | 身份剥离 `includeHarnessIdentity:false` |
| **runtime** | `ctx.on(...)` 挂宿主接缝 | ❌ | 审批自动放行 `approval/request` 瀑布 |
| **source** | 字面量替换产物 + `.bak` | ✅ | 提示词免责声明、观察策略、read 上限 |

**能配置就不打补丁，能挂钩子就不改源码**。上游三个仓库把一切都当源码补丁，
于是连 config 能解决的事也去改 `node_modules`，多一份被 npm 覆盖的风险。

## 快速开始

```bash
node bin/dsh-purge2.js probe     # 只读：宿主指纹 + 锚点命中数
node bin/dsh-purge2.js plan      # 只读：将改哪些文件、命中数、字符增量
node bin/dsh-purge2.js apply     # 写：先建 .dshpurge2.bak，命中数不符一律拒写
node bin/dsh-purge2.js verify    # 只读：三级证据链 E1/E2/E3
node bin/dsh-purge2.js evidence  # 只读：最近证据记录（JSONL）
node bin/dsh-purge2.js revert    # 用 .bak 逐字节还原
npm test                         # 10 项验收
```

## 三级证据链（相对三上游的核心增量）

社区版的自检只证明「补丁写进去了」；本仓库把证据分三级，**未知一律记 `null`，不折叠成 false**：

| 级别 | 问的问题 | 判据 |
| --- | --- | --- |
| **E1 静态** | 文件真的是目标字节吗？ | 每个目标文件 sha256 + marker 命中 |
| **E2 运行时** | 注入真的进了这一轮吗？ | assemble 观测：段数 / 注入字节 / sha / 段位 / 是否被熔断跳过 |
| **E3 行为** | 钩子真的被调用了吗？ | 审批放行次数与最后工具名 |

健康度三态：🟡 未应用或未知 / 🔴 打了一半（不一致）/ 🟢 补丁到位且注入在。
注意 **E2/E3 只有在 DSH 进程内才有值**，CLI 是独立进程，显示 `?` 属于正常。

## 关键结论（先读这个）

- **不要**把 approval policy 设成 `never`：0.1.2 里它的语义是「一律拒绝」，不是自动放行。
  见 [docs/FINDINGS-0.1.2.md](docs/FINDINGS-0.1.2.md) 第 1 节。
- 上游 85 条补丁里，只有 **30 条**在 0.1.2 上锚点直接命中；本仓库只收**重采验证过**的。
- `apply` 之后必须重启 DSH，产物才被加载。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) —— 架构、六条不变式、红线
- [docs/FINDINGS-0.1.2.md](docs/FINDINGS-0.1.2.md) —— 0.1.2 实测发现（含三条致命坑）
- [docs/PATCH-SPEC.md](docs/PATCH-SPEC.md) —— 补丁规格与如何新增一条

## 许可与署名

Apache-2.0。衍生自 YuJunZhiXue/dsh-purge（Apache-2.0）与 kingcharleslzy-ai/dsh-purge（MIT），
保留原作者署名，见 [NOTICE](NOTICE)。
