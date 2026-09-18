# 第三方组件与许可

本仓库原创代码采用 [MIT](LICENSE)。本包**没有运行时依赖**：`dependencies` 为空，`@deepseek-ai/dsh-tools` 作为可选 peer 依赖，只在 Harness 运行时由宿主提供。

## 可选与外部组件

| 组件 | 关系 | 许可 | 本仓库的义务 |
|:--|:--|:--|:--|
| [rclone](https://rclone.org/) | 可选传输通道（`engine: rclone`）。用户自行安装，本仓库不打包、不安装、不启动安装程序 | MIT | 仅在 `spawn` 中按 argv 调用；未内嵌其代码 |
| 阿里云 OSS | 目标服务 | 商业服务 | 通过公开 S3 兼容 HTTP API 访问；本仓库不分发其 SDK |
| DeepSeek Harness | 宿主运行时 | 见其仓库 | 只使用公开的插件与工具注册接口 |
| Paper Library 插件 | 并列、可选配合 | MIT | 本插件只读其管理的目录；不导入其代码、不写其数据库 |

`@deepseek-ai/dsh-tools` 等 Harness 运行时包由宿主提供，不随本包分发；其许可与版本约束见 Harness 仓库。

## 未打包

- 没有 vendored 的 CSL、字体、模型或 PDF 引擎。
- 没有把任何云厂商 SDK 复制进本仓库。
- 没有把凭据、桶名、真实路径或运行产物提交进版本库（见 `.gitignore`）。
