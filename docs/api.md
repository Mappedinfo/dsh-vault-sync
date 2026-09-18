# API：CLI、JSON 报告与 Harness 工具

## 1. CLI

```
vault-sync <command> [options]
```

| 命令 | 作用 | 退出码 |
|:--|:--|:--|
| `init` | 写 starter `config.json` 与 0600 的 `oss.env`；已存在则不覆盖 | 0 |
| `doctor` | 检查配置、源目录、凭据文件权限、传输、远端可读性 | 0 / 1 |
| `plan` | 规划，不写任何东西 | 0 |
| `run` | 执行单向备份 | 0；有失败项为 1 |
| `status` | 引擎、源、索引规模、最近运行 | 0 |
| `verify` | 与远端镜像核对 | 0 / 不符为 1 |
| `cost` | 年费用算术估算 | 0 |
| `restore` | 定位当前对象与日期版本 | 0 |
| `sources` | 列出配置的源 | 0 |

公共选项：`--config <绝对路径>`、`--source <id>`（可重复）、`--json`、`--help`。
`run` 另有 `--dry-run`（等价 `plan`）与 `--quiet`（仅打印一行摘要；`--json` 优先）。
`verify` 另有 `--sample <n>`。`restore` 另有 `--stamp YYYY-MM-DD`。
`cost` 另有 `--full-downloads <n>`、`--sporadic-gb <n>`、`--sporadic-objects <n>`、`--egress busy|idle`。

`--json` 输出是稳定契约；人类可读输出仅为便利，不保证逐字稳定。

## 2. JSON 报告（`--json`）

### plan

```jsonc
{
  "entries": { "<sourceId>": { "source": {}, "scan": {}, "listing": [], "previous": {}, "items": [], "stats": {} } },
  "summary": [{ "id": "papers", "root": "/abs", "remote": "papers", "scanned": 12,
                "upload": 3, "version": 1, "delete": 0, "unchanged": 8, "skip": 9,
                "remoteOnly": 1, "unchangedUnverified": 0, "bytesToUpload": 1024,
                "skippedLocal": 0 }],
  "totals": { "scanned": 12, "upload": 3, "version": 1, "delete": 0, "unchanged": 8,
              "skippedLocal": 0, "failed": 0, "bytesUploaded": 1024, "bytesUploadedHuman": "1.0 KiB" },
  "tempKeys": 0
}
```

计划项 `items[].action` 取值 `upload | version | delete | skip`，并带 `reason`：
`new-file`、`remote-missing-despite-index`、`digest-match`、`size-match-unverified`、
`local-modified`、`size-changed`、`content-differs`、`local-deleted`、`local-deleted-keep-remote`、
`remote-only-unmanaged`。`skip` 项带 `verified: true|false`。

### run

```jsonc
{
  "runId": "20260918032346-bb6qr4",
  "stamp": "2026-09-18",
  "runPath": "/abs/state/runs/<runId>.json",
  "engine": { "kind": "s3", "detail": "bucket @ endpoint", "capabilities": {} },
  "tempPruned": ["incoming/<dead-run>/…"],
  "perSource": [{ "id": "papers", "remote": "papers", "scanned": 12, "uploaded": 3,
                  "versioned": 1, "deleted": 0, "unchanged": 8, "bytesUploaded": 1024,
                  "skippedLocal": [{ "path": "x", "reason": "over-max-file-bytes:…" }],
                  "failed": [{ "relPath": "y", "action": "upload", "error": "…", "retryable": true }] }],
  "totals": { "…": 0 },
  "record": { "status": "ok" }
}
```

`record.status`：`ok` | `partial`（有失败项）| `failed`（整轮异常）| `running`（进行中，崩溃后可见）。

### verify

```jsonc
{ "checked": 12, "ok": true,
  "sources": [{ "id": "papers", "local": 12, "remoteTotal": 12, "checked": 12,
                "missing": [], "sizeMismatch": [], "digestMismatch": [],
                "digestUnavailable": 0, "remoteOnly": [], "remoteOnlyCount": 0,
                "unreadable": [], "ok": true }] }
```

`digestUnavailable` 表示"大小一致但该对象没有摘要元数据可核对"，不是通过。

### status / cost / restore / doctor

`status` 返回 `{ engine, stateDir, sources[], runs[] }`。
`cost` 返回 `{ pricingVersion, unit, rates, assumptions, inputs, perYear{}, totalPerYear, currency }`。
`restore` 返回 `{ currentKey, currentPresent, currentSize, candidates[{key,stamp,size}], note }`；带 `--stamp` 时返回 `chose`。
`doctor` 返回 `{ ok, checks[{name, ok, detail}], configPath }`。

## 3. Harness 工具

| 工具 | 参数 | 变异 | 映射到 |
|:--|:--|:--|:--|
| `vault_sync_status` | — | 否 | `status` |
| `vault_sync_plan` | `source[]` | 否 | `plan` |
| `vault_sync_run` | `source[]`, `dry_run` | 是（需确认） | `run --quiet` / `plan` |
| `vault_sync_verify` | `source[]`, `sample` | 否 | `verify` |
| `vault_sync_restore` | `source`, `path`, `stamp` | 否 | `restore` |
| `vault_sync_cost` | `full_downloads`, `sporadic_gb`, `egress` | 否 | `cost` |

工具结果 = CLI JSON 报告 + `exitCode`（+ 截断的 `stderr`）。参数无法指定库路径、桶、凭据或前缀：这些只来自部署配置或私有凭据文件，请求 JSON 不能控制。

## 4. 状态目录

```
$DSH_HOME/vault-sync/
├── config.json          配置（0600，禁止任何 secret 字段）
├── oss.env              凭据（0600；也可只用环境变量）
├── run.lock             运行互斥锁；超过 6 小时视为陈旧可回收
├── index/<sourceId>.json  上轮成功清单（相对路径 → 大小/时间/摘要）
└── runs/<runId>.json      运行记录，默认保留最近 200 条
```

## 5. 环境变量

凭据按 `DSH_VAULT_SYNC_*` → `OSS_*` / `ALIBABA_CLOUD_*` → `AWS_*` 顺序查找，先看 `oss.env` 再看进程环境。
另有 `DSH_VAULT_SYNC_CONFIG`（插件配置文件的绝对路径）、`VAULT_SYNC_PROGRESS=0`（关闭逐项进度输出）、`VAULT_SYNC_DEBUG=1`（打印异常栈）。
`*_ACCESS_KEY_SECRET`、`*_SESSION_TOKEN` 等字段在任何报告中都会被脱敏。
