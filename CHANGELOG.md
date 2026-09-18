# Changelog

## 0.1.0 — 2026-09-18

首个可用版本：把本地研究数据单向、可版本化地备份到阿里云 OSS。

### 新增

- `vault-sync` CLI：`init`、`doctor`、`plan`、`run`、`status`、`verify`、`cost`、`restore`、`sources`。
- 传输：内置 SigV4 S3 兼容客户端（阿里云 OSS）、rclone 通道、本地文件系统镜像（语义等价，用于演练与验证）。
- 单向镜像与版本化：被覆盖或被删除的远端对象先服务端复制到 `versions/<日期>/…`；上传经 `incoming/<runId>/…` 中转并校验后落位。
- 幂等与续传：中断后重跑只补缺失对象；死亡运行的临时对象在下一轮回收并计入运行记录。
- 核对：区分远端缺失、大小不符、摘要不符与"未按摘要核对"；列表无元数据时回退到逐对象 `HEAD`。
- 规划器决策表：只有在大小变化或摘要不符时才覆盖，无法证明相同时保守不动并如实标注。
- 严格配置：绝对路径、唯一 id/remote、取值范围校验，且**拒绝任何 secret 字段**；AccessKey 只来自 0600 的 `oss.env` 或环境变量。
- Harness 插件：6 个 `vault_sync_*` 工具（仅上传需确认）、内置 `vault-sync` 技能、注册脚本与 `cordis.patch.yml`。
- 费用估算：按配置费率与自述假设计算年存储/流出/取回/请求费用。
- 文档：README、设计决策、API 契约、验证记录；76 项测试与可复现端到端校验脚本。

### 说明

- 调度不在本插件内，交由 dsh-cron-scheduler / 系统 cron。
- 恢复只报告远端 key，由用户用 rclone 或 ossutil 取回；插件不下载覆盖本地。
- 无运行时依赖。可选 rclone 通道需要用户自装 rclone。
