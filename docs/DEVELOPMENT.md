# 开发与维护

## 稳定基线

当前版本为 `0.1.0`，本地Git标签为 `v0.1.0`。版本整理只统一文档、命令入口和生成文件，不改影像行为。后续实现沿用四个模块契约，先明确接口与不变量，再修改内部实现；接口变更同步更新调用者、测试和文档。

| 文件 | 职责 |
| --- | --- |
| [README](../README.md) | 项目简介、启动及用户操作 |
| [PROJECT](PROJECT.md) | 已实现任务、依赖、验收与剩余问题 |
| [ARCHITECTURE](ARCHITECTURE.md) | 数据流、模块接口与关键不变量 |
| [SEQUENCES](SEQUENCES.md) | 序列识别、样例内容和语义边界 |
| [VALIDATION](VALIDATION.md) | 稳定版验证摘要及覆盖边界 |
| [ROADMAP](ROADMAP.md) | 尚未实现的能力及优先级 |
| [CHANGELOG](../CHANGELOG.md) | 版本变更 |
| [PUBLICATION](PUBLICATION.md) | 公开内容、干净历史与隐私检查 |
| [历史归档](archive/VALIDATION-2026-09-30.md) | 开发阶段原始计数，供回溯使用 |

## 常用命令

在项目根目录执行。Windows默认使用已安装Chrome；其他环境可通过 `CMR_BROWSER_EXECUTABLE` 指定浏览器可执行文件。

| 命令 | 用途 / 前置条件 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run dev` | 本机开发服务，127.0.0.1:3001 |
| `npm run build` / `npm start` | 生产构建 / 本机生产运行；启动前先停止同端口开发服务 |
| `npm run typecheck` | TypeScript检查 |
| `npm run audit:publication` | 当前提交与可达历史的发布隐私检查 |
| `npm test` | 纯逻辑、导入、缓存和状态测试 |
| `npm run test:e2e` | 合成DICOM浏览器流程；自动使用/启动开发服务，失败时可留诊断产物 |
| `npm run verify:sample` | 相邻 `cmr-eg` 的目录、帧序、灰度和ITK核验 |
| `npm run catalog:sample` | 相邻 `cmr-eg` 的匿名序列聚合统计 |
| `npm run verify:fluidity` | 已启动服务中的导入/首批像素/25步导航统计；不生成截图 |
| `npm run verify:browser` | 可选真实样例四模式、截图、播放和资源检查 |
| `npm run verify:controls` | 可选真实样例平移对照、间距、主题和截图 |

后三个浏览器工具默认连接127.0.0.1:3001，通过 `CMR_BASE_URL` 指定其他地址。`verify:browser` 支持 `CMR_FORCE_WEBGL=1` 强制WebGL2。性能测量与其他浏览器验收分开运行，避免相互干扰。

当前用户偏好是不继续截图验收；保留工具供以后明确需要时复查，不将可选截图工具当成每次文档修改的必跑项。

## 文件保留与清理

| 目录 / 文件 | 处理规则 |
| --- | --- |
| `src/`、`tests/`、`scripts/`、配置和锁文件 | 项目实现与可复用检查，提交并保留 |
| `public/fonts/` | 运行所需字体、许可证和NOTICE，保留 |
| `docs/` | 当前文档与少量可回溯归档，保留 |
| `artifacts/` | 本机截图、匿名测量和临时调试文件；已忽略，可在验收结束后清理 |
| `test-results/`、`playwright-report/` | 浏览器测试产物；已忽略，可清理 |
| `*.tsbuildinfo` | 可再生成的TypeScript增量缓存；已忽略，可清理 |
| `.next/` | 可再生成的构建/开发产物；清理前停止使用它的服务，清理后重新构建 |
| `node_modules/` | 本机依赖；需要重新安装时才清理，使用 `npm ci` 恢复 |

清理只针对项目内明确的生成路径，递归操作前检查绝对路径和链接。真实样例 `../cmr-eg`、参考项目 `../OS-03-P` 和系统临时目录中的活跃影像会话不属于项目清理范围。匿名测量结论存入VALIDATION后可以删除原始本机输出，不提交真实影像、截图、患者身份或原始UID。

## 后续变更流程

新任务在PROJECT记录状态、依赖、验收与剩余问题；未实现能力在ROADMAP维护。更新共享类型时检查四模块边界，使用足以验证行为的测试；通过后更新CHANGELOG。保留当前稳定标签作为回退点，不在当前版本中宣称未验收的医学语义或量化能力。
