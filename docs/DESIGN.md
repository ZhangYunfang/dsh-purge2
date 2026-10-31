# 设计

## 一句话

把「破甲」实现成 **可证明、可回退的三通道干预层**，而不是一堆改宿主源码的脚本。

## 为什么不是直接抄三仓库

| 三仓库的做法 | 问题 |
| --- | --- |
| 全部能力都做「源码字面量替换」 | config 能解决的事也去改 `node_modules`，多一份被 npm 覆盖的风险 |
| 补丁按编号线性排布 | 版本一变，锚点全不命中，只能"尽力而为"地静默跳过 |
| 自检只证明"补丁写进去了" | 没证明"行为真的变了" |
| 上游把公网门禁写死在 pre-step | 非红队场景全是噪音；社区直接删掉又变成没边界 |

## 架构

```
L0 host-probe      宿主指纹 + 锚点探针表（只读，plan 的数据来源）
L1 patch-engine    变体链 + 六条不变式 + 三态执行（probe/plan/apply）
L2 inject-engine   注入（section / assemble / 尾部锚点）  ← 下一步
L3 capacity        三通道分级：config > runtime > source
L4 evidence        三级证据链 E1 静态 / E2 运行时 / E3 行为  ← 下一步
L5 ux              CLI（已可跑）+ 面板（待做）
L6 data            $DSH_HOME/purge2/（不写 profile YAML）
```

## 六条不变式（引擎的红线）

1. **拒写优先**——命中数与 `expect` 不符、锚点缺失 → 一条都不写，只记原因
2. **幂等**——`markers` 命中即 `already`，重复 apply 不叠加（上游为此吃过"每次 +841 字符"的亏）
3. **可逆**——首次改动前拷 `<file>.dshpurge2.bak`，`revert` 拷回即删
4. **自愈**——apply 开头先 `restoreMissingOriginalsFromBak`（npm 覆盖产物是必然事件）
5. **不猜**——`expect` 命中数契约，不符记 `hit_count_mismatch` 并停止该条
6. **三态**——`probe` 只读 / `plan` 只读出方案 / `apply` 才写

## 状态词表

`applied` `already` `pending` `na` `missing_file` `unmatched` `hit_count_mismatch` `drifted` `error`

健康度只有三档：🟢 全绿 / 🟡 部分 / 🔴 有拒写或漂移。**读不到状态不允许折叠成 🟢**。

## 红线

1. 只改 `node_modules` 产物，不改宿主源码树
2. 不写用户 profile 的 `cordis.patch.yml`；一个 loader id 只出现一条顶层条目
3. 命中数不符一律拒写，永不"尽力而为"
4. 默认不开削弱宿主自我保护的补丁（opt-in 需显式 `--enable-opt-in`）
5. 不把 `approval policy` 设为 `never`（0.1.2 语义相反，见 FINDINGS §1）
6. 网络/靶场门禁做成策略引擎（`off|loopback|private|allowlist|ask`），不硬编码

## 与上游的映射

| 本仓库 | 上游等价物 | 通道 |
| --- | --- | --- |
| S1 WORKSPACE_CONTEXT_INTRO | #1 | source |
| S2 FS_OBSERVATION_INTENT_FREE | #17 | source |
| S3 READ_CAPS_RAISED | #22 | source |
| C1 HARNESS_IDENTITY_STRIP | #25 / #4 | **config**（不用补丁） |
| R1 approval grant | #9（上游用源码补丁） | **runtime**（更安全） |
