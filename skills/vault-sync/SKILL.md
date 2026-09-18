---
name: vault-sync
description: "把本地研究数据（文献库、Obsidian 仓库、知识文件）单向、可版本化地备份到阿里云 OSS，并核对、定位历史版本与估算费用。用于备份文献库/仓库到 OSS、同步到阿里云、定期单向备份、检查备份完整性、恢复某个历史版本、估算备份年费用，或配置 dsh-vault-sync 与 vault-sync CLI。"
---

# Vault Sync

本技能驱动独立插件 `@mappedinfo/dsh-vault-sync`。它把配置好的本地目录**单向**镜像到远端（阿里云 OSS）；被覆盖或删除的远端对象先转入按日期分目录的版本区，因此历史版本可追溯。

## 红线

1. **单向**：只从本地写向远端。绝不把远端内容拉回覆盖本地资料；恢复由用户自行用 `rclone copy` / `ossutil cp` 执行。
2. **凭据不进配置、不进对话**：AccessKey 只存在于状态目录下的 `oss.env`（权限 0600）或环境变量。不要写进 `config.json`、工具参数或聊天记录；插件配置里出现 `accessKey` 会被直接拒绝。
3. **不改源数据**：插件只读源目录；所有写入都发生在远端和管理状态目录。
4. **不臆造**：`verify` 报出"未按摘要核对"的文件时如实说明，不要宣称已逐字节校验。费用是配置费率的算术估算，不是账单，也不是实测。
5. **删除要慎重**：`remote.allowRemoteDelete` 为 true 时，本地删除会导致远端镜像移除（先归档）。不确定就先 `vault_sync_plan` 看清单，或临时设为 false。

## 标准流程

1. **确认配置**：插件默认读 `$DSH_HOME/vault-sync/config.json`。没有就让用户执行 `node <repo>/src/cli.mjs init`。
2. **体检**：`doctor` 确认源目录、传输方式与凭据。
3. **看计划**：`vault_sync_plan`，读清 upload / version / delete 三类数量与字节数。出现 delete 时向用户说明哪些文件会从远端镜像移除（版本区仍保留副本）。
4. **执行**：`vault_sync_run`。失败项会列在报告里；索引只在某个源全部成功后才推进，所以重跑会补传，已完成文件不会重传。
5. **核对**：`vault_sync_verify`（大库用 `sample`）。出现 mismatch 如实报告，不要靠重跑掩盖。
6. **版本定位**：`vault_sync_restore` 返回当前 key 与按日期归档的 key，交给用户用 rclone / ossutil 取回。
7. **费用**：`vault_sync_cost`，说明这是费率算术估算及其假设。

## 定时备份

调度**不属于本插件**。用 dsh-cron-scheduler 的 `automation_create` 建系统级 cron 任务，权限 `workspace-write`，prompt 必须自包含，例如：

```
运行 /absolute/path/to/dsh-vault-sync/src/cli.mjs run --quiet --json，读取 JSON 报告，
用中文汇报本次上传/版本化/删除/失败数量与总字节，点名失败项；不要修改本地资料库。
```

cron 表达式按系统时区解释。建议避开 VPN 高峰；网络抖动时原生 S3 与 rclone 两条路径都会退避重试。

## 与 Paper Library 的配合

`kind: "paper-library"` 只表示"这是一个被管理的文献库目录"，插件依然只读它。文献库路径与 Obsidian 仓库、知识目录并列写入 `sources`。两者可独立安装：没有 Paper Library 时本插件照常备份任意目录。

## 常见故障

| 现象 | 处理 |
|:--|:--|
| `OSS remote is not configured` | 检查 `oss.env` 的 key / endpoint / bucket，或对应环境变量 |
| `another vault-sync run holds ...` | 已有任务在跑；等它结束，或确认锁文件确已陈旧 |
| 计费字节远大于实际 | 小文件不足 64 KiB 按 64 KiB 计费，属正常 |
| `verify` 报 unverified | 该传输不返回摘要元数据（如 rclone）；可换原生 S3 传输，或按大小核对并如实说明 |
| 上传后远端文件数少于本地 | 看报告 `failed`；重跑即可补传 |
