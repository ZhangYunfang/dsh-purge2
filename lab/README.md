# dsh-purge2-lab · 演练台（可选层）

主包 `dsh-purge2` 只做「降低交互摩擦」，**不碰任何攻击资产**。
本包是独立 npm 包，给**已获授权的**演练场景提供三件事：

| 能力 | 说明 |
| --- | --- |
| 资产测绘 | `lab_asset_add` / `lab_asset_query` / `lab_asset_stats`，落在 `$DSH_HOME/purge2/lab/assets.db`（`node:sqlite`，无需外部依赖） |
| 四级证据账本 | `lab_evidence_record` / `lab_evidence_list`，`claimed / observed / derived / inferred` 四档 + `ev_<sha256>` 内容寻址 |
| 成果报告 | `lab_report`，报告里明确区分「可信计数」与「未验证自称」 |

## 为什么只有 6 个工具，不是上游的 64 个

上游把 64 个 `redteam_*` 工具 + 5 角色编排塞进主包，代价是：
包体 40% 是演练台、依赖 SQLite、且**默认安装者被迫接收一整套攻击资产**。

本仓库的取舍：**演练台独立成包**，需要才装。
按需扩展时照 `lib/index.js` 的 `reg({...})` 形状加即可，数据层已经就绪。

## 不随包分发攻击载荷与武器化技能

上游在 1.1.73 已把 23 个技能从开源版移除，原因写在它的 commit 里。
本包同样**不内置**扫描器/隧道/webshell 之类技能——`skills/` 下只放**环境适配类**模板，
用的人自己填自己的工具路径与凭据（凭据请放 `~/.dsh/.credentials.yaml`，不要写进本包）。

## 证据账本的设计要点

`claimed` 是「子代理/模型自称拿到了什么」，**绝不能直接写进成果**。
`ev_hash = sha256(level + summary + raw)` 做内容寻址：同一内容必同哈希，
改一个字哈希就变，因此可以用它核对「它说的」和「库里记的」是不是同一件事。

`lab_evidence_list` 会把 `trustworthy`（observed+derived）与 `claims`（claimed）分开报数。

## 使用边界（硬约束）

只在**你拥有或已获书面授权**的环境使用。本包不做网络门禁——
那是使用者自己的责任，主包也不提供「对公网放行」的开关。
