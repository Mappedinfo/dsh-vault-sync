# 项目交接

面向继续开发的人或 AI。先读 [README](README.md) 与 [设计决策](docs/design.md)。

## 当前状态（2026-09-18，v0.1.0）

可用：把配置好的本地目录**单向、可版本化**地备份到阿里云 OSS，并提供核对、版本定位与费用估算。120 项测试与 4 项可复现校验通过（`npm test`、`node scripts/validate.mjs`）。没有真实 OSS 桶、真实 rclone 或真实 Harness 运行时的验证，详见[验证记录](docs/validation.md#4-尚未验证)。

### 代码地图

| 路径 | 职责 |
|:--|:--|
| `src/cli.mjs` | 全部命令；参数解析；人类可读与 `--json` 两种输出 |
| `src/config-file.mjs` | 配置文件读写（0600），复用 `core/config.mjs` 的校验 |
| `src/report.mjs` | 报告表格与脱敏 JSON 输出 |
| `src/core/config.mjs` | 严格配置归一化；拒绝 secret 字段 |
| `src/core/credentials.mjs` | `oss.env` / 环境变量凭据解析与权限报告 |
| `src/core/util.mjs` | 原子写、跨进程锁、摘要、glob、受限并发、脱敏 |
| `src/core/journal.mjs` | `stateDir` 下的运行记录与每源索引 |
| `src/core/manifest.mjs` | 本地扫描：受限枚举 + mtime/size 摘要缓存 |
| `src/core/backend.mjs` | 传输接口契约、键安全校验、键布局 |
| `src/core/planner.mjs` | **纯函数**规划与统计（决策表，见设计文档 3.5） |
| `src/core/applier.mjs` | 执行：归档 → 临时上传 → 校验 → 发布；临时键回收 |
| `src/core/engine.mjs` | 组装 plan/run/verify/restore/status；传输选择 |
| `src/core/pricing.mjs` | 费率与费用算术 |
| `src/core/progress.mjs` | 运行中进度：独立瞬态文件、节流、陈旧判定、清理 |
| `src/backends/filesystem.mjs` | 本地镜像传输（语义等价，测试基准） |
| `src/backends/s3.mjs` | SigV4 与 S3 兼容 REST（OSS 路径） |
| `src/backends/rclone.mjs` | rclone 通道（argv、超时、重试） |
| `src/harness/*` | CLI 子进程 runner、工具注册与审批门、内置技能 |
| `skills/vault-sync/SKILL.md` | 交给会话的使用说明与红线 |
| `cordis.patch.yml` | 一个 insert 挂载全部工具 |

## 不变量（改动前务必确认）

1. 单向：不存在远端 → 源目录的写入路径。
2. `config.json` 不含 secret；报告一律脱敏。
3. 覆盖前先归档；上传经临时键并校验后发布。
4. 只有"大小变化"或"摘要不符"才替换远端对象。
5. 只有整源成功才推进该源索引。
6. 规划器保持纯函数，测试不需要 I/O。
7. 每轮开头回收死亡运行的临时键并计数。
8. `--json` 是稳定契约；退出码 1 = 有问题的完成。

## 待办与已知边界

| 优先级 | 事项 | 说明 |
|:--|:--|:--|
| 高 | 真实 OSS 桶往返 | 用受限 RAM 子账号跑 `doctor`/`plan`/`run`/`verify`，核对真实错误码措辞与归档行为；把结论写进验证记录，替换"未验证"条目 |
| 高 | 真实 rclone 通道 | 在有 rclone 的机器上验证 `lsjson --stat` 输出、退出码与超时；确认 `size-match-unverified` 的实际比例 |
| 中 | Harness 运行时挂载 | 在真实 DSH Web profile 注册并让模型调用一次 `vault_sync_plan`；验证 `requireToolApproval` 的审批气泡 |
| 中 | cron 任务落地 | 用 dsh-cron-scheduler 建一条周任务，确认 headless 会话里能读到 JSON 报告 |
| 中 | 断点续传的细粒度 | 目前以对象为最小续传单位（已由优雅停止与增量进度覆盖大部分痛点） |
| 中 | 版本区保留清理 | 目前依赖 OSS 生命周期规则；可选实现 `versions` 侧按天清理（需要远端列举与删除，注意幂等） |
| 中 | 跨源并发 | `sources` 目前串行；`remote.concurrency` 已校验但未用于并行上传。若启用，必须保持"同源串行、归档先于覆盖" |
| 低 | 大库容量测量 | 1 万对象 / 40 GB 的扫描时间与常驻内存未测；清单当前全量驻内存 |
| 低 | 断点续传的细粒度 | 目前以"对象"为最小续传单位；超大单文件仍是整体重传 |

## 继续开发

```sh
npm test                  # 120 项
node scripts/validate.mjs # 测试 + 真实本地端到端 + Harness 契约
```

新增行为前先加测试；`tests/helpers.mjs` 提供合成目录、本地镜像传输与进程内 S3 服务端。修改规划器时同步更新 `tests/planner.test.mjs` 的决策表。
