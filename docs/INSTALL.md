# 安装与运维

## 前置

- DSH **0.1.x**（实测 0.1.2-alpha.2）
- Node ≥ 18（`node:sqlite` 需要 ≥ 22，只有装演练台才需要）

## 一键安装

```bash
./scripts/install.sh --dry-run      # 先看要做什么
./scripts/install.sh                # 装主包到 web profile
./scripts/install.sh --with-lab     # 连演练台一起装
./scripts/install.sh --profile desktop
```

脚本做三件事：备份 profile 的 `package.json` → 调官方 `dsh plugin add link:<repo>` → 用
`--dump-config` 验证真的进了 bundles（**不看 pnpm 退出码**，那不算证据）。

## 重启

插件在进程启动时加载，**装完必须重启**：

```bash
supervisorctl restart dsh-web     # supervisor 托管时
```

⚠ 重启会中断当前会话。

## 验证

```bash
node bin/dsh-purge2.js probe      # 宿主指纹 + 锚点命中（只读）
node bin/dsh-purge2.js selfcheck  # 5 层自检
```

浏览器打开 `http://localhost:3080/purge2`（用 `localhost` 不要 `127.0.0.1`，
本机系统代理的绕过表对 `127.*` 无效）。

## 常用操作

| 目的 | 命令 |
| --- | --- |
| 看将改什么（不写盘） | `node bin/dsh-purge2.js plan` |
| 打补丁 | `node bin/dsh-purge2.js apply` |
| 撤销补丁 | `node bin/dsh-purge2.js revert` |
| 三级证据 | `node bin/dsh-purge2.js verify` |
| 快照 / 回滚 | `backup create` / `backup list` / `rollback <id>` |
| 审计 | `node bin/dsh-purge2.js audit` |

## 卸载

```bash
dsh plugin --profile web remove dsh-purge2
node bin/dsh-purge2.js revert      # 若打过补丁，先还原
```

## 出问题

| 现象 | 先看 |
| --- | --- |
| 补丁显示 `unmatched` | 宿主版本变了，锚点不再匹配；不要改引擎，重采锚点（见 PATCH-SPEC） |
| 显示 `hit_count_mismatch` | 官方产物里该代码出现次数变了 → 引擎拒写是**正确行为** |
| 面板打不开 | 用 `localhost`；确认 dsh-web 在跑；`/purge2` 是 prefix 路由不需要尾斜杠 |
| 注入显示 `?` | CLI 独立进程看不到运行时状态，正常；在 DSH 内看面板 |
| 补丁突然消失 | npm 覆盖了产物 → 重启 DSH 会自动自愈（`restoreMissingOriginalsFromBak`） |
