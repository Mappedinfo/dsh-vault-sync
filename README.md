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

## 社区

非官方项目，由社区成员独立开发与维护。在 DSH 插件专区的分享帖见 [discussions/2004 专区](https://github.com/deepseek-ai/deepseek-harness/discussions/2004)；帖子正文与截图源文件在 [docs/community/](docs/community/)。

推送前请跑 `npm run check:publication`（含历史扫描），它会拦住云密钥、密钥赋值、绝对家目录路径、私有集合名与真实 OSS 地域。

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
node src/cli.mjs cost --storage-class standard   # 也可算 standard / infrequent / archive
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
    "allowRemoteDelete": true,
    "publishStrategy": "direct",
    "archiveFailure": "warn"
  },
  "sources": [
    { "id": "paper-library", "kind": "paper-library", "root": "~/.local/share/dsh-paper-library", "remote": "paper-library",
      "exclude": ["backups/**", "**/*.tmp", "**/.DS_Store"] },
    { "id": "paper-library-state", "kind": "directory", "root": "~/.dsh/paper-library",
      "exclude": ["**/*.lock", "**/runs/**", "**/*.tmp"] },
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

### 存储类型与生命周期（费用要点）

阿里云 OSS 按**二进制 GB**（1 GB = 2³⁰ 字节）计费，几个官方规则直接决定这个备份该怎么做：

| 规则 | 结论 |
|:--|:--|
| **标准存储 (LRS) 每地域前 5 GiB 免费** | 4 GiB 的库放标准存储，存储费为 **0**。不要为了"单价更低"去买存储包（最小规格 40 GB）或转低频——免费额度内转档只会把 0 元变成要付钱 |
| 归档 60 天 / 低频 30 天**最低存储时长** | 不足期删除、覆盖或转档按剩余天数比例加收。**`versions/` 前缀必须留在标准存储**，否则"180 天到期删除"会变成罚款 |
| 归档与低频按 **64 KiB 最小计费单位**，标准按实际大小 | 知识文件、Obsidian 笔记大量小于 64 KiB，转档后计费容量会虚高 |
| 低频读取需先 `RestoreObject` 解冻 | 与归档同样的取回延迟；低频还比归档贵一倍 |

因此推荐顺序：**先什么都不设**（标准存储 + 免费额度）→ 库明显超过 5 GiB 后，只给 `current/paper-library/` 加一条 30 天→归档规则 → 跳过低频。频繁改写的小文件（文献库状态、Obsidian 仓库）保持标准存储。

费用看 `vault-sync cost`，可指定档位复算：

```sh
node src/cli.mjs cost                          # 默认按归档估算
node src/cli.mjs cost --storage-class standard # 标准存储，含 5 GiB 免费额度
node src/cli.mjs cost --egress idle            # 闲时（00:00-08:00）流出单价减半
```

真正的费用杠杆是**流出流量**而非存储：40 GiB 场景下流出约 43 元/年，是存储费的 3 倍多。闲时取回（0.25 元/GiB）比忙时（0.50）省一半，是最大的一项优化。

### 按源调参（大文件与小文件不能共用一套）

`concurrency`、`timeoutSeconds`、`retries` 都可以**按源覆盖**，缺省即继承 `remote` 的全局值：

```jsonc
{
  "id": "zotero-attachments",
  "root": "/path/to/pdfs",
  "concurrency": 4,          // 大文件：降低并发，避免把上行切碎
  "timeoutSeconds": 1800,    // 大文件：给单个请求足够时间
  "retries": 5
}
```

两个设置是**传输级**（`timeoutSeconds`、`retries`），`concurrency` 是**调度级**。这个区分很实际：真实备份曾因全局 `concurrency: 16` + `timeoutSeconds: 300` 一次性丢掉 65 个大 PDF 上传——为小文件调优的值直接害了大文件。

- `concurrency: "auto"` 让调度按大小自动降档：一个批次被大文件（≥16 MiB）主导时，并发按 `24/√大文件数` 下调，最低 2。
- 某个源覆盖了传输参数但没有可用来构建传输的工厂时，**构造期直接报错**，而不是悄悄用继承值——静默忽略比报错难查得多。
- `doctor` 会打印每个源解析后的实际策略，传承自全局的会标 `(inherited)`。

### 运行中观察（不产生下行费用）

长备份最需要的是一句话回答"它还在动吗"。进度写在独立瞬态文件 `state/progress/<runId>.json`，与摘要索引**刻意分开**：索引的语义是"上一轮成功备份了什么"，按源、且只对完全成功的文件推进，用它看当前进度在设计上就不成立（曾有一个 422 文件的源因为落盘阈值 250、下一档 500 永远不到而完全看不到进度）。

```sh
vault-sync progress          # 纯本地读取，零网络
vault-sync status            # 也包含活动运行的进度行
```

- 有文件完成就推进进度，**包括失败**——卡在重试某个对象的运行才会显出"卡住"的样子。
- 结束的运行会删掉进度文件（结果在运行记录里）；中断或失败的**保留**，那正是需要看它跑到哪里的时候。
- 进程被 kill 后残留的进度文件会被标为 `stale`，与"正在慢慢跑"区分开。
- 进度写入失败只记录、不中断：它是可观测性，不是正确性。

前台运行时每 2 秒打印一行 `[done/planned 43.2%] 1.2 GiB  0.9 files/s  ETA 12m`；失败与归档警告**即时**打印，`--quiet` 也不抑制失败。

### 中断与退出码

`Ctrl-C`（或 `SIGTERM`）第一次会：停止领取新文件、让已在传输的文件跑完（中途打断正是产生半份对象的途径）、落盘运行记录（`status: interrupted`）与进度、释放锁，然后以 **130** 退出。第二次信号立即退出。

退出码：`0` 完成；`1` 完成但有失败项；`130` 被中断。中断的那一轮**不会**推进索引——没有上传的文件不会被记成已备份。

### `verify` 的三态

```jsonc
{ "status": "ok" | "okWithWarnings" | "mismatch", "ok": true|false,
  "warnings": { "unreadableFiles": 0, "unverifiedFiles": 0, "remoteOnlyTruncated": false, "sampled": false } }
```

`mismatch` 指真实矛盾（远端缺失、大小不符、摘要不符）；本地读不了或无法按摘要核对属于 `okWithWarnings`——它不是矛盾，但也**不是干净的核对通过**。`ok` 仍保留（等价于 `status === "ok"`）。退出码只有 `mismatch` 为 1。`remoteOnlyTruncated` 明确标出"远端多出"列表被截断到 50，不再静默截断。

### 发布与归档的取舍

| 设置 | 默认 | 含义 |
|:--|:--|:--|
| `publishStrategy` | `direct` | 直接 PUT 到正式路径，再校验大小与摘要；`temp-copy` 则先传临时键再用服务端复制发布。`direct` 少两次往返、不依赖 `CopyObject`；代价是传输中断可能短暂留下不完整对象，靠随后的大小/摘要校验发现并重传 |
| `archiveFailure` | `warn` | 归档旧版本失败时只记警告，**当前内容照常上传**；`fail` 则整文件失败 |
| `allowRemoteDelete`（按源） | 继承 | 设为 `false` 的源**只增不减**：文件被移动或删除后，远端历史副本原地保留，并在报告中标记 `local-deleted-keep-remote` |

### 远端布局


```
<currentPrefix>/<source.remote>/<相对路径>                当前镜像
<versionsPrefix>/<YYYY-MM-DD>/<source.remote>/<相对路径>  被覆盖或删除的版本
<tempPrefix>/<runId>/<source.remote>/<相对路径>           本轮上传中，永不作为正式副本
```

归档用服务端复制，不重新下载。OSS 侧建议再加生命周期规则：`current/paper-library/` 30 天后转归档存储，`versions/` 180 天后删除。文献库状态、知识文件与 Obsidian 仓库属于**频繁改写的小文件**，建议给它们单独的、更长的转换时间（或保持标准存储），否则小文件（不足 64 KiB 按 64 KiB 计费）的归档费用与重复版本量都会偏高。

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
npm test                      # 120 项 JavaScript 测试，仅用合成数据与本地/进程内替身
```

测试覆盖：SigV4 与 AWS 公开测试向量逐字节比对、配置与凭据规则、规划决策表、首次上传/幂等重跑/覆盖归档/本地删除归档/中断续传/临时对象清理/核对/版本定位/锁互斥、进程内 S3 兼容服务端到端（签名、分页、服务端复制、重试、错误映射）、rclone argv 构造与超时、Harness 工具映射与审批门、费用算术。详见 [验证记录](docs/validation.md)。
