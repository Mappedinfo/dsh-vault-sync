# Changelog

## 未发布

### 新增（数据恢复）
- **`recover`：在新机器上按镜像重建本地文件**（`vault_sync_recover` 工具）。目标非空默认拒绝；从不删除目标已有文件；先写 `.part` 并按摘要校验后才落位；已存在且摘要一致则跳过，可反复重跑续传。归档/冷归档对象默认明确失败并给出解冻指引（`--on-archived skip` 可改为记录跳过），避免产出看似完整的半成品树。
- `recover --dry-run` 只规划不写。
- S3 与 filesystem 传输新增流式 `downloadFile`：原子落盘、摘要校验、归档态识别为独立错误类型。

### 新增（可观测性与按源参数）
- **逐源调参**：`concurrency` / `timeoutSeconds` / `retries` 可按源覆盖，缺省继承；`concurrency: "auto"` 按文件大小自动降档。
- **运行中进度**：独立瞬态文件 + `progress` 命令 + `status` 进度行，均为零网络本地读取。
- **优雅收尾**：第一次 SIGINT/SIGTERM 停止领新文件、落盘 `interrupted` 记录与进度、释放锁，退出码 130。
- 失败与归档警告**即时**打印（`--quiet` 也不抑制失败）。
- `verify` 三态：`ok` / `okWithWarnings` / `mismatch`，并标出 `remoteOnlyTruncated`。
- 单源失败不再中断整轮；该源记录 `error` 且不推进索引。

### 修复（本轮）
- 引擎向 applier 传递被拆平的 source，使按源参数被静默忽略。
- 优雅停止时索引仍推进到完整扫描，把未上传的文件记成已备份。
- 计划失败的源丢失了错误信息，使一轮看似完成。

### 修复
- **传输层错误不再中断整轮**：连接超时、连接重置、`fetch failed` 等此前被当作致命错误，现在会退避重试；`SignatureDoesNotMatch` 也归入可重试（VPN 隧道会损坏请求），而 `InvalidAccessKeyId`、`AccessDenied` 仍快速失败。
- **并发写临时文件碰撞**：`atomicWrite` 用 `pid+毫秒` 命名临时文件，同毫秒并发写会互抢导致 `rename` 失败——而摘要索引与远端元数据都走这个函数。已加随机后缀。
- **文件系统传输的远端元数据竞态**：并发上传各读同一份 sidecar，最后一个胜出会丢掉其他条目。整个读-改-写改为按路径串行。
- **索引只在整源结束时落盘**：跑到 99% 被打断会丢失全部进度、重启要重算整棵树的摘要。现在边做边写（每 250 个文件一次）。
- **不再对整个桶做根列举**：临时对象清理改为只列举临时前缀；`status` 默认不再列举远端。
- 费用口径按官方定价页更正：二进制 GB 计费、标准存储 5 GiB 免费额度、归档/低频 64 KiB 最小计费单位与 60/30 天最低存储时长。

### 新增
- `remote.publishStrategy`（默认 `direct`）：发布不再依赖服务端复制。
- `remote.archiveFailure`（默认 `warn`）：归档失败降级为警告，当前内容仍上传。
- 按源 `allowRemoteDelete` 覆盖，支持"只增不减"的集合。
- `credentialsFile`：允许把凭据文件放在状态目录之外的显式位置。
- `cost --storage-class`；`status --remote`。

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
- 文档：README、设计决策、API 契约、验证记录；130 项测试与可复现端到端校验脚本。

### 说明

- 调度不在本插件内，交由 dsh-cron-scheduler / 系统 cron。
- 恢复只报告远端 key，由用户用 rclone 或 ossutil 取回；插件不下载覆盖本地。
- 无运行时依赖。可选 rclone 通道需要用户自装 rclone。
- 费用估算按阿里云 2026-09-18 定价页（中国大陆 / 华北2北京）：二进制 GB 计费、标准存储 (LRS) 前 5 GiB 免费、归档与低频 64 KiB 最小计费单位、归档 60 天与低频 30 天最低存储时长。
