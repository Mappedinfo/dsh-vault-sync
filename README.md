# Vault Sync

独立的 DeepSeek Harness 插件：把本地研究数据（Paper Library 文献库、Obsidian 仓库、知识文件目录）**单向、可版本化**地备份到阿里云 OSS。

本插件与 [Paper Library](https://github.com/mappedinfo/dsh-paper-library) **并列存在、可独立安装**：它只把被管理的文献库目录当作若干备份源之一，从不写入任何源目录。

项目原创代码采用 [MIT](LICENSE)。本包没有运行时依赖；可选的 rclone 传输需要用户自行安装 rclone（MIT），详见 [第三方说明](THIRD_PARTY.md)。

设计依据来自仓库内的评审文档 `同步方案与 dsh 插件设计.md`（最初由 shiqi 与 DeepSeek 网页版讨论、检索与验证），本次实现按 Paper Library 插件的实际结构做了调整。

## 为什么不是普通网盘客户端

- **单向**：只从本地写向远端。远端新增不改动本地；本地删除才按配置清理远端镜像（先归档）。
- **可检索**：PDF 与知识文件保持原始目录结构与文件名，不压缩、不打包，远端路径与本地一一对应。
- **抗中断**：每轮是幂等的。中断后重跑只补缺失对象，已完成文件不重传；上传先写到本次运行的临时前缀，校验后再落到正式路径，因此不会出现半个文件被当作正式副本。
- **可版本化**：被覆盖或被删除的远端对象先服务端复制到 `versions/<日期>/…`，可追溯历史版本。
- **可核对**：`verify` 比较本地与远端，明确区分"摘要一致""仅大小一致""远端缺失"；无法用摘要核对时如实报出，不假装已校验。
- **零常驻**：没有后台进程、没有全文索引、没有 PDF 解析。每次运行是一个短时 Node 进程，任务结束即退出。

## 安装

Node `^22.19 || >=24`。本包无运行时依赖：

```sh
git clone https://github.com/mappedinfo/dsh-vault-sync.git
cd dsh-vault-sync
```

初始化配置（写入 `$DSH_HOME/vault-sync/config.json` 与同目录的 `oss.env`，权限 0600）：

```sh
node src/cli.mjs init
```

编辑 `config.json` 的 `remote.bucket` / `remote.endpoint` 与各 `sources[].root`；把 RAM 子账号的 AccessKey 填进 `oss.env`。
**凭据只放 `oss.env` 或环境变量**：`config.json` 里出现 `accessKeySecret` 之类的字段会被直接拒绝，避免误提交。

```sh
node src/cli.mjs doctor     # 配置、源目录、传输、凭据、远端可读性
node src/cli.mjs plan       # 只看计划，不写任何东西
node src/cli.mjs run        # 执行备份
node src/cli.mjs verify     # 与远端镜像核对
node src/cli.mjs cost       # 年费用算术估算
```

注册到本地 Harness profile（只改目标 profile，不动全局配置）：

```sh
node scripts/install-harness.mjs --harness /absolute/deepseek-harness --home /absolute/dsh-home --profile web
```

## 配置

```jsonc
{
  "version": 1,
  "stateDir": "~/.dsh/vault-sync",          // 索引、运行记录、0600 凭据文件
  "remote": {
    "type": "oss",                            // oss | filesystem | rclone
    "engine": "auto",                         // auto | native | rclone
    "bucket": "your-bucket",
    "endpoint": "oss-cn-hangzhou.aliyuncs.com",
    "region": "cn-hangzhou",
    "currentPrefix": "current",
    "versionsPrefix": "versions",
    "tempPrefix": "incoming",
    "versionRetentionDays": 180,
    "concurrency": 16,                        // 1–24
    "retries": 5,
    "timeoutSeconds": 300,
    "allowRemoteDelete": true
  },
  "sources": [
    { "id": "paper-library", "kind": "paper-library", "root": "~/.local/share/dsh-paper-library", "remote": "paper-library",
      "exclude": ["backups/**", "**/*.tmp", "**/.DS_Store"] },
    { "id": "knowledge", "kind": "directory", "root": "~/.dsh/paper-library", "exclude": ["**/*.lock"] },
    { "id": "obsidian-vault", "kind": "directory", "root": "~/Documents/my-vault",
      "exclude": [".git/**", ".trash/**", ".obsidian/workspace.json"] }
  ]
}
```

路径必须是绝对路径（`~` 会展开）。`sources[].remote` 是远端前缀段，必须唯一。`include` 为空表示全部，`exclude` 最后匹配者生效。

### 传输方式

| type / engine | 说明 |
|:--|:--|
| `oss` + `auto` | 有 rclone remote 就用 rclone，否则用内置原生 SigV4 客户端（默认） |
| `oss` + `native` | 只用内置 S3 兼容客户端；每个对象写入 `x-amz-meta-sha256`，因此"未改动"判定是精确的 |
| `oss` + `rclone` | 走 `rclone copyto/lsjson/deletefile`；也可设 `rcloneRemote` 指向已有 remote |
| `filesystem` | 镜像到本地目录，语义与 OSS 完全一致；用于演练与验证 |
| `rclone` | 仅用 rclone remote |

rclone 传输没有摘要元数据，因此"大小一致但无法证明相同"的文件会报告为 `size-match-unverified`，不会被反复重传，也不会被宣称已核对。

### 远端布局

```
<currentPrefix>/<source.remote>/<相对路径>                当前镜像
<versionsPrefix>/<YYYY-MM-DD>/<source.remote>/<相对路径>  被覆盖或删除的版本
<tempPrefix>/<runId>/<source.remote>/<相对路径>           本轮上传中，永不作为正式副本
```

归档用服务端复制，不重新下载。OSS 侧建议再加生命周期规则：`current/` 30 天后转归档存储，`versions/` 180 天后删除。

## 恢复

本插件**不会**自行下载覆盖本地。`restore` 只报告位置：

```sh
node src/cli.mjs restore paper-library 2024/paper.pdf
node src/cli.mjs restore paper-library 2024/paper.pdf --stamp 2026-03-04
```

拿到 key 后用 `rclone copy aliyun-oss:your-bucket/<key> ./out/` 或 `ossutil cp` 取回；归档存储需要先 `RestoreObject` 解冻。

## 定时备份

调度属于 [dsh-cron-scheduler](https://github.com/mappedinfo/dsh-cron-scheduler)：它把规则写成系统 crontab，由 `dsh --profile headless` 在进程外执行，Web 不必常开。典型任务：

```
每周日 02:00（分 时 日 月 周：0 2 * * 0）
运行 node /absolute/dsh-vault-sync/src/cli.mjs run --quiet --json，
读取 JSON 报告，用中文汇报上传/版本化/删除/失败数量与总字节，点名失败项；不要修改本地资料库。
```

cron 表达式按系统时区解释，不承诺秒级精度。

## Harness 工具

插件挂载后，会话可用 6 个工具；只有 `vault_sync_run` 需要确认：

| 工具 | 作用 |
|:--|:--|
| `vault_sync_status` | 引擎、源、已记录文件数、远端对象数、最近运行 |
| `vault_sync_plan` | 只看计划：上传/版本/删除/未改动 |
| `vault_sync_run` | 执行单向备份（`dry_run` 等价于 plan） |
| `vault_sync_verify` | 核对镜像，区分缺失/大小/摘要/未按摘要核对 |
| `vault_sync_restore` | 定位当前对象与各日期版本 |
| `vault_sync_cost` | 年费用估算 |

工具与 CLI 共用同一实现与同一份配置：插件把 CLI 作为短时子进程运行并解析其 JSON 报告，主机不保留第二套引擎状态。内置 `vault-sync` 技能记录单向红线、标准流程与故障处理。

## 边界

- 不做双向同步、不做远端 → 本地的自动回写。
- 不处理 OSS 生命周期规则本身（在控制台/`ossutil` 配置），也不做解冻。
- 不解析 PDF、不做 OCR、不建全文索引。
- 不打包、不压缩、不去重（软链接不跟随）；`maxFileBytes` 默认 512 MiB、单轮总字节上限 200 GiB。
- 费用是配置费率的算术估算，不是账单，也不是容量实测。

## 验证

```sh
npm test                      # 75 项 JavaScript 测试，仅用合成数据与本地/进程内替身
```

测试覆盖：SigV4 与 AWS 公开测试向量逐字节比对、配置与凭据规则、规划决策表、首次上传/幂等重跑/覆盖归档/本地删除归档/中断续传/临时对象清理/核对/版本定位/锁互斥、进程内 S3 兼容服务端到端（签名、分页、服务端复制、重试、错误映射）、rclone argv 构造与超时、Harness 工具映射与审批门、费用算术。详见 [验证记录](docs/validation.md)。
