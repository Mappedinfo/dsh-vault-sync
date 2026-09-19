# 验证记录

全部使用**合成数据**与本地/进程内替身：没有真实 OSS 桶、没有真实 AccessKey、没有网络请求、没有真实文献库。下列数字来自本机一次完整运行，可复现。

```sh
npm test              # node --test tests/*.test.mjs
node scripts/validate.mjs
```

## 1. 自动化测试：80 项通过

| 文件 | 项数 | 覆盖 |
|:--|--:|:--|
| `tests/sigv4.test.mjs` | 7 | SigV4 与 AWS 公开向量逐字节比对；规范查询排序；键编码；会话令牌；载荷哈希进入规范请求但不被签名；头值只做空白归一化不做大小写折叠 |
| `tests/config.test.mjs` | 9 | 配置拒绝任何层级的 secret 字段；绝对路径；id/remote 唯一；远端取值校验；dotenv 解析；glob/include/exclude；并发上限；键拼接；报告脱敏 |
| `tests/planner.test.mjs` | 14 | 规划决策表：缺失→上传、摘要一致→跳过（已核对）、同大小无摘要→跳过（未核对）、摘要不符→归档+重传、大小变化→归档+重传、未管理远端文件不动、本地删除→归档+删除、`allowRemoteDelete=false`、其他源与临时键不参与、索引与孤儿临时键、确定性抽样 |
| `tests/sync.test.mjs` | 13 | 首次上传；幂等重跑零变化且无临时对象；覆盖前归档；删除前归档；保留远端；远端丢失后重传（续传）；死亡运行临时对象清理；核对（缺失/摘要被篡改）；版本定位与未知日期拒绝；干跑不写远端不写记录；超限文件显式跳过；失败源不推进索引；并发运行被锁拒绝 |
| `tests/s3.test.mjs` | 9 | 进程内 S3 兼容服务端上的端到端：签名形状与 `host` 必签；上传落位与 `x-amz-meta-sha256`；服务端复制归档（无下载）；无临时对象残留；分页列举；503 重试后成功；不可恢复错误成为失败项而非崩溃；复制源缺失的明确报错；核对读取摘要元数据 |
| `tests/rclone.test.mjs` | 7 | remote 名校验；`lsjson` 解析与前缀；`copyto`/`deletefile` argv 精确匹配；非零退出为可重试错误；挂起被超时杀死；缺失对象 `head` 返回 undefined；引擎经 rclone 通道完成同步并在无摘要时报告 `size-match-unverified`，同时仍能发现大小变化 |
| `tests/harness.test.mjs` | 12 | 工具声明完整性；工具→argv 映射（不含任何 secret 字段）；仅上传工具进入审批门；关闭审批；结果单行摘要；配置路径必须绝对且未知键被拒；默认配置候选路径；runner 真实命令返回 JSON 报告；核对不一致以报告返回而非抛错；缺失配置抛错而不是空成功；超时终止；内置技能解析与注册 |
| `tests/cost.test.mjs` | 9 | 设计场景按二进制 GB 与 2026 价格页复算（存储 13.92、流出 43.00、取回 6.19）；标准存储 5 GiB 免费额度；标准→低频在免费额度内反而更贵；三档单位价格序 standard > infrequent > archive；闲时单价减半；归档/低频 64 KiB 最小计费而标准按实际大小；最低存储时长被写入假设；单位与币种分开声明；零对象与假设声明 |

```
ℹ tests 80
ℹ pass 80
ℹ fail 0
```

## 2. 可复现端到端：`node scripts/validate.mjs`

3 项检查全部通过（合成目录 + 一次性本地远端）：

```
vault-sync validation: PASS (3 checks)
  ok   tests: 8 test files passed (80 cases)
  ok   round-trip: 3 uploads, idempotent re-run, 1 modification archived, 1 deletion archived, verify ok, 3 runs recorded
  ok   harness-contract: 6 tools and the bundled skill load without the Harness runtime
```

round-trip 逐步断言：首次运行上传 3 个文件且零失败 → 再跑一次上传 0、未改动 3（幂等）→ 修改一个文件并删除一个后，上传 1、归档 2、删除 1 → 被删除文件在 `versions/<日期>/…` 中保有原内容 → `verify` 报 ok → 干净之后 `plan` 不再要求上传 → `status` 记录 ≥3 次运行 → `cost` 返回 CNY 估算。

## 3. 被测试抓住的真实缺陷

这些不是"测试写错"，而是实现缺陷，记录在此以便回归：

1. **SigV4 过度签名**：初版无条件把 `x-amz-content-sha256` 加入 `SignedHeaders`，对 `get-vanilla` 得到 `726c5c48…`，而 AWS/botocore 公开向量为 `5fa00fa3…`。修正为"只签名请求真实携带的头"。若没有向量比对，这会在真实 OSS 上以认证失败暴露。
2. **头值大小写折叠**：同一次修正前，头值被整体归一化并折叠大小写，破坏了 16 进制载荷哈希。
3. **`Authorization` 被覆盖**：签名结果的 headers 里同时存在小写 `authorization` 与规范大小写 `Authorization`，小写键覆盖了后者，导致请求匿名发出（服务端读到空 Authorization）。
4. **凭据变量名错误**：`authorize()` 引用了不存在的 `secretAccessKey`，所有请求在签名阶段抛 ReferenceError。
5. **规划器逻辑反转**：当远端没有摘要且本地文件已被管理时，初版把"无法证明相同"当成"内容不同"，于是每轮都归档并重传所有文件。修正为"宁可少传，不可错删/错覆盖"，并把这类文件单独报告为 `size-match-unverified`。
6. **规划统计字段互相覆盖**：`stats.remote`（远端对象数）展开时覆盖了同名的"远端前缀名"，报告里 `remote` 变成数字；同时 `skip` 与 `unchanged` 两个名称在 plan 与 run 之间不一致。统一为同一套字段契约。
7. **runner 吞掉失败**：退出码 1 且**无** JSON 报告（例如配置缺失）曾被当成"完成"，返回空成功。现在只有"退出码 1 且有报告"才降级为报告。
8. **`--quiet` 压过 `--json`**：`run --quiet --json` 曾输出人类可读单行，导致 Harness 解析失败。现在 `--json` 优先。
9. **临时对象清理条件写错**：清理只在 `currentPrefix` 为空串时执行，实际永不为空，导致死亡运行的临时对象不被回收。
10. **`restore` 位置参数偏移**：`options.rest` 含命令名本身，`restore` 把 `restore` 当成 source id。
11. **核对不回退到 HEAD**：OSS 的 `ListObjectsV2` 不返回用户元数据，初版因此把所有文件报为"未按摘要核对"；现在列表无摘要时按需 `HEAD` 单对象。
12. **费用口径**：偶发下载同时按"次数×单次字节"乘了一次，导致流出费放大三个数量级；单位从 GiB 改为 OSS 计价的十进制 GB；两分位舍入曾把真实的小额成本显示为 0。

13. **定价口径三处偏差**：把"计费单位"当成十进制 GB（阿里云官方明确按二进制 GB，1 GB = 2³⁰ 字节）；漏掉标准存储 (LRS) 每地域前 5 GiB 免费；默认全部按归档单价估算，而实际是"\`current/\` 里的 PDF 转归档 + \`versions/\` 与小文件留标准"的混合。修正后 4 GiB 的库存储费为 0，而 40 GiB 设计场景的存储估算由 15.84 变为 13.92（二进制 GB + 新费率）。
14. **低频访问 ≠ 更便宜**：在免费额度内，把标准存储转低频会把 0 元变成约 3.22 元/年；同时低频继承 64 KiB 最小计费与 30 天最短周期，却比归档贵一倍。已把这条写进 \`cost\` 的输出与假设说明，避免读者按"单价更低"做错决定。

同批修正也覆盖了测试替身本身的偏差：进程内 S3 服务端原先在 `CopyObject` 时丢失用户元数据（真实 S3/OSS 默认 `COPY` 元数据指令会携带），已改为默认携带。

## 4. 尚未验证

- **真实阿里云 OSS 桶**：没有可用凭据，因此端到端只在进程内 S3 兼容服务端与本地文件系统上验证。签名算法由公开向量锁定，但真实 OSS 的行为（如特定 XML 错误码措辞、归档存储转换、`RestoreObject`）未经实测。
- **真实 rclone 二进制**：本机未安装 rclone，rclone 通道只以注入的 `spawn` 替身验证 argv、解析、超时与重试；未验证真实 rclone 的退出码细节与 `lsjson --stat` 输出形状。
- **真实规模的容量/内存**：没有 40 GB / 1 万对象的实测。规划与扫描按文件逐个处理、清单常驻内存，因此大库的内存占用与小库同阶但更大；未测量。
- **Harness 运行时内挂载**：工具层以桩注册表验证（注册、审批门、argv 映射、真实 JSON 往返），未在实际 DSH Web 进程内启动过插件；`@deepseek-ai/dsh-tools` 未安装。
- **cron 实际触发**：调度由 dsh-cron-scheduler 承担，本仓库未部署真实 crontab 条目。
- **费用**：费率取自阿里云 2026-09-18 定价页中"中国大陆 / 华北2（北京）"一档，未与实际账单核对，也未验证汇率与不同地域的差价；生命周期的实际转换时间、不足最低存储时长的收费未实测。
- **免费额度**：定价页在多个中国大陆地域都标注标准存储 (LRS) 0~5 GB 免费，本实现按此计算；该额度的长期有效性与按地域/账号的具体口径未向客服确认。
