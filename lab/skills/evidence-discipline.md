---
name: lab-evidence-discipline
description: 证据纪律：区分"它说"与"我看到"；claimed 不得进成果。
---

# 证据纪律

每条结论必须落一条 `lab_evidence_record`，并按来源选 level：

| level | 含义 | 能否进成果 |
| --- | --- | --- |
| `claimed` | 子代理/模型自称（"我拿到了"） | **不能** |
| `observed` | 工具回显、数据库记录、截图实证 | 能 |
| `derived` | 从 observed 推理得出 | 能（须标推理链） |
| `inferred` | 推测，须显式标注 | 不能 |

三条硬规则：

1. 收到 `claimed` 先去找 `observed` 复现；复现不了就降级成 `inferred` 并写明。
2. 同一件事只记一条——`ev_hash` 天然去重，重复记录会返回 `duplicate: true`。
3. 报告里 `trustworthy` 与 `claims` 必须分开报，不许把两者相加当战果。
