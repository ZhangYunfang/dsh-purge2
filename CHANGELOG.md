# CHANGELOG

## v0.1.0 —— 首个可用版本（DSH 0.1.2-alpha.2 专用）

### 三通道破甲

| 通道 | 能力 | 是否改 node_modules |
| --- | --- | --- |
| **config** | 身份剥离（`includeHarnessIdentity:false` + `persona:''`） | 否 |
| **runtime** | 审批自动放行（`approval/request` 瀑布 → `allowed-once`） | 否 |
| **runtime** | 审批策略保持器（`never` 会话自动纠正成 `ask`，否则瀑布根本不跑） | 否 |
| **runtime** | 注入（section + assemble 尾部锚点，含三个熔断） | 否 |
| **source** | 7 条补丁（提示词优先级 / 沙箱文案 / 拒绝提示 / 工具 schema / 审批话术 / FS 围栏 / 读取上限） | 是（带 `.bak`） |

### 引擎

- 变体链（按宿主轨道选锚点，版本不符不参与匹配）
- 六条不变式：拒写优先 / 幂等 / 可逆 / 自愈 / 不猜 / 三态执行
- 14 个状态词，健康度三态（🟢/🟡/🔴），**未知不折叠成通过**

### 三级证据链

- E1 静态：文件 sha256 + marker 命中
- E2 运行时：注入真的进了本次 assemble（段数/字节/sha/段位/熔断状态）
- E3 行为：审批放行次数 + 策略纠正次数
- 全程 `null` 表示未知，`false` 才表示未生效

### 运维

- 分层自检（5 层，每层回答「这层没了会怎样」）
- 审计（JSONL，2MB 轮转）
- 备份/回滚（按补丁目标文件粒度 + manifest sha256，坏一个就整体不动）
- CLI：probe / plan / status / apply / revert / verify / evidence / selfcheck / audit / backup / rollback

### 面板

- 单文件自包含（内联 ui-iron-law 主题，无 CDN）
- UI 铁律门禁 19/19 PASS
- `/purge2` 面板 + `/purge2/api/{state,evidence,audit}` 只读接口

### 演练台（可选层 `dsh-purge2-lab`）

- `node:sqlite` 资产库 + 四级证据账本（`claimed` 不进成果）+ 成果报告
- 6 个 `lab_*` 工具；不内置攻击载荷

### 已知边界

- **只支持 DSH 0.1.x**；0.2.x 的锚点不同（上游 85 条补丁里只有 30 条在 0.1.2 命中）
- 不把 `approval policy` 设为 `never`——0.1.2 里那是「拒绝一切」
- 注入 E2/E3 只有在 DSH 进程内才有值；CLI 显示 `?` 属正常
