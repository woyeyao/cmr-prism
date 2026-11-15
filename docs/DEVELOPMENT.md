# 开发与维护

## 稳定基线

当前版本 `0.3.0`，包括本机完整工作台与 Pages 静态课堂，未新增版本标签。两种入口共用课堂组件；影像模块契约、图谱坐标、候选状态与资源生命周期见 ARCHITECTURE 和 ANATOMY。

| 文件 | 职责 |
| --- | --- |
| [README](../README.md) / [中文](../README.zh-CN.md) | 项目双重定位、启动及用户操作 |
| [SHARING](SHARING.md) | 可发布的中英文短文案、渠道建议及图像复用边界 |
| [PROJECT](PROJECT.md) | 已实现任务、依赖、验收与剩余问题 |
| [ARCHITECTURE](ARCHITECTURE.md) | 数据流、模块接口与关键不变量 |
| [SEQUENCES](SEQUENCES.md) | 序列识别、样例内容和语义边界 |
| [ANATOMY](ANATOMY.md) | 双图谱、候选切面、几何证据与来源 |
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

本轮按用户要求进行切面计算、浏览器交互与视觉检查。截图只保存于已忽略的 artifacts，复核完成后清理；文档保留结论和可重跑步骤。

## 公开课堂构建

先停止占用 `.next` 的开发／生产服务，再运行 `npm run build:pages`、`npm run verify:pages`。产物为 `artifacts/pages`，使用 `*.pages.tsx` 独立入口；不复制或移动本机 API 文件。检查 `/cmr-prism/` 前缀下的模型、Cine、JS/CSS/字体，以及两种语言与自由切面。

若要恢复本机完整工作台，重新 `npm run build`、`npm start`。静态包和构建临时目录均不加入 Git；由 Actions 从源码重建部署。新界面文案加入 `src/i18n` 离线词典；不翻译患者原文，不因语言切换替换模型、平面或 source 对象。

## 文件保留与清理

| 目录 / 文件 | 处理规则 |
| --- | --- |
| `src/`、`tests/`、`scripts/`、配置和锁文件 | 项目实现与可复用检查，提交并保留 |
| `public/fonts/` | 运行所需字体、许可证和NOTICE，保留 |
| `public/anatomy/` | 运行所需公开图谱、共享参考帧、署名与精确来源校验，保留 |
| `docs/` | 当前文档与少量可回溯归档，保留 |
| `artifacts/` | 本机截图、匿名测量和临时调试文件；已忽略，可在验收结束后清理 |
| `test-results/`、`playwright-report/` | 浏览器测试产物；已忽略，可清理 |
| `*.tsbuildinfo` | 可再生成的TypeScript增量缓存；已忽略，可清理 |
| `.next/` | 可再生成的构建/开发产物；清理前停止使用它的服务，清理后重新构建 |
| `node_modules/` | 本机依赖；需要重新安装时才清理，使用 `npm ci` 恢复 |

清理只针对项目内明确的生成路径，递归操作前检查绝对路径和链接。真实样例 `../cmr-eg`、参考项目 `../OS-03-P` 和系统临时目录中的活跃影像会话不属于项目清理范围。匿名测量结论存入VALIDATION后可以删除原始本机输出，不提交真实影像、截图、患者身份或原始UID。

图谱资源由 `node scripts/prepare-anatomy.mjs` 从项目旁的 handoff 原型生成；运行应用不需要这些原型。脚本记录各文件来源、大小、SHA-256 和衍生操作，两个图谱共用一套 MR 参考帧。仅保留 `scripts/sources/bodyparts3d` 中经核验的两个小型压缩源 OBJ；其哈希与具体来源固定在提取脚本和发布审计中。不要另复制原型 HTML、整个 ZIP 或重复网格。运行 `npm run verify:aorta` 检查源坐标及接口。更新资源后重新运行工作区资产审计。

Windows 沙箱若出现临时缓存 rename UNKNOWN，可仅为该终端将 TEMP/TMP 指向项目已忽略的 `artifacts/tmp` 后重跑；不改变系统环境设置，结束后清理该任务缓存。

## 后续变更流程

新任务在PROJECT记录状态、依赖、验收与剩余问题；未实现能力在ROADMAP维护。更新共享类型时检查四模块边界，使用足以验证行为的测试；通过后更新CHANGELOG。保留当前稳定标签作为回退点，不在当前版本中宣称未验收的医学语义或量化能力。
