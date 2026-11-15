# CMR Prism / 心磁棱镜

把心脏解剖、切面与真实磁共振放在一起学习。支持中英切换、课程切面与自由三维剖切。

**[在线解剖课堂](https://woyeyao.github.io/cmr-prism/)** · [GitHub 源码](https://github.com/woyeyao/cmr-prism)

在线版无需安装，包含两套公开图谱和 AMRG 参考影像。本机版另外提供 DICOM 导入和完整阅片工作台；在线版不提供上传入口。

## 本机运行

使用 Node.js 22 或 24，以及支持 WebGL2 的现代浏览器。无需 Python、ITK 或 VTK 安装。

```powershell
npm ci
npm run dev
```

打开 [127.0.0.1:3001](http://127.0.0.1:3001)。生产运行用 `npm run build`、`npm start`。服务仅绑定本机地址。

## 解剖课堂

首页点击「探索心脏解剖」，或顶部「解剖课堂」。不需要导入文件。

1. 选择 BodyParts3D 或 HRA 图谱，再按课程选择定位、长轴、短轴或流出道。切换模型保留视图名称，各标本使用自己的切面；缺少预设时明确提示。
2. 在三维心脏上旋转、平移、缩放；「正对切面」查看切口。「A 侧 / B 侧」独立控制，均关闭可只看断面。
3. 观察同一切面的二维彩色断面与定位线，可切换参考面交叉核对、点击「放大」并排细看。二维填色、三维切口填色、血池、大血管和结构显隐分别控制。
4. 课程模式中展开切面微调，沿 X/Y/Z 移动或叠加法线偏移、双轴倾斜。三处显示同步，重置恢复候选，支持导出参数。相机旋转不会改变切面。
5. 查看 AMRG 灰度参考影像和 Cine；导入自己的 DICOM 后可切换「本机病例」，自行选择序列、层位、时间帧、窗宽窗位。对照影像可放大，收起后保留原播放位置。拖宽右栏会按图像真实比例同步增高；本机影像考虑 PixelSpacing。纵向拖动增加高度留白，双击分隔条恢复等比高度。
6. 拖动分隔条调整目录、模型、断面、定位图及对照区域所占空间；可交换面板位置或重置布局。课堂采用合并顶栏，按桌面工作区设计。模型背景跟随深浅主题。顶部 English／中文切换语言并记住选择。

### 自由切面

顶部点击「自由切面」，进入只有三维模型的编辑区。拖动彩色轴平移、拖动旋转环改变方向；`G` 切换移动、`R` 切换旋转、`Esc` 返回观察。XYZ 数值不设旧范围限制，角度可超过一整圈，滑块视程可扩展；还可输入法线。旋转始终以当前切面中心为轴。支持保留正侧／负侧、整心、仅断面、恢复起点和参数导出。课程与自由编辑独立，切换模式会重新初始化该模式。

**图谱是静态标本，MR 来自另一受试者。** 并排显示用于比较解剖类型，不表示同人配准、时相同步或精确逐像素对应。预设均为待复核候选；微调不会改变 MR 采集位置。心肌填色保留腔隙，管腔几何只画轮廓，开放轮廓不补成组织。

切面依据、模型覆盖、数值调整及来源见 [解剖与切面](docs/ANATOMY.md)。

## DICOM 浏览

选择文件夹、多文件、ZIP，或拖入文件。一次导入一份检查中的全部所需序列，后续导入会替换检查。自己的样例可放项目旁 `../cmr-eg`，不随项目发布。

| 展示方式 | 用途 |
| --- | --- |
| 玻璃阵列 | 概览层位；调整可见层数及展示间距；点击切片进入大图 |
| 单张 | 调窗、平移缩放、查看采集参数和临时备注 |
| 分屏 | 2–4 个独立序列；同检查定位线与可选 Cine 相位联动 |
| 空间立方体 | 在真实 DICOM 空间内比较选中的 2–5 个采集平面 |

把 SAX 与长轴放入立方体：在分屏的各视口选择序列和层位，分别点工具栏「＋」，下方累计至少两个平面后点击「空间立方体」。加入的是空间层位，播放时内容随相位更新；同层再点即移除。仅允许同一检查、同一 Frame of Reference 且有可靠几何的平面。

| 操作 | 行为 |
| --- | --- |
| 滚轮 / 左右键 | 切时间帧；手动切帧暂停播放 |
| Shift + 滚轮 / 上下键 | 切空间层位 |
| 空格 | 播放 / 暂停；帧率可输入 1–60 fps |
| 影像左拖 / Ctrl + 滚轮 | 平移 / 鼠标位置缩放；「适应」复位 |
| 分屏影像双击 | 放大活动视口；「返回分屏」保留其状态 |
| 三维左拖 / Shift + 左拖或右拖 | 旋转 / 平移 |
| 两侧边缘箭头 | 折叠目录和参数，扩大中心区域 |

先聚焦影像再使用快捷键；输入框、备注和下拉框不触发全局导航。图谱课堂使用自己的导航与播放控件。

时间与层位独立。分屏中的「联动」按归一化心动周期匹配，近似匹配标「≈」；不同采集并非严格同时。LGE、灌注和 Mapping 可逐张浏览，不将参数采样解释为 Cine。组织序列面板可修正视角标签或合并兼容堆栈，标签修正不旋转像素或执行配准。

## 数据与边界

- 支持传统 MR 和未压缩整数 Enhanced MR；压缩传统单帧使用 ITK-Wasm。压缩多帧、浮点 MR、独立 Parametric Map、NIfTI、ROI 和定量分析尚未实现。
- 本机影像不发送外部服务。目录和像素分离按需读取，客户端像素缓存上限 128 MiB，后台预热有并发与预算限制。
- 会话、备注和切片选择不持久化；正常关闭或替换时释放会话；取消导入会中止后续处理，等待正在使用文件的任务结束后清理。30 分钟闲置清理兜底。强制终止服务可能留下系统临时文件。
- 三维故障时仍可浏览二维。暗色主题只改变界面，不改变灰度像素。浏览器仅保存主题和语言偏好。
- 图谱资源共用一份紧凑网格和一套公开参考帧；署名、许可与文件校验记录在 `public/anatomy/`。真实病例和本机截图不公开。

## 静态部署

`npm run build:pages` 构建独立课堂，`npm run verify:pages` 核对产物与资源路径。输出位于已忽略的 `artifacts/pages`，默认网址前缀 `/cmr-prism`；不包含本机病例 API、上传入口或服务端源码。构建前停止本机服务，完成后如需本机完整版，重新执行 `npm run build`、`npm start`。

GitHub Actions 在 `main` 更新时检查并发布该静态目录；构建与正常本机入口共用组件，避免维护第二份课堂。设置及发布检查见 [PUBLICATION](docs/PUBLICATION.md)。

## English

[Open the anatomy classroom](https://woyeyao.github.io/cmr-prism/) and choose **English** in the toolbar. Explore BodyParts3D and HRA with guided planes, or use **Free slicing** to move and rotate a cutting plane directly in 3D. CMR references resize proportionally and can be expanded without resetting playback.

The online site contains public atlas resources only. For local DICOM import and the full viewer, use Node.js 22/24, run `npm ci` and `npm run dev`, then open `http://127.0.0.1:3001`. Data stays on your computer. Atlas planes remain teaching candidates; the atlas and reference MR are not registered to each other.

## 开发与文档

常规检查：`npm run typecheck`、`npm test`、`npm run test:e2e`、`npm run build`。图谱源核验：`npm run verify:aorta`；实样检查：`npm run verify:sample`。发布前另跑 `npm run audit:publication`。

| 文档 | 内容 |
| --- | --- |
| [ANATOMY](docs/ANATOMY.md) | 图谱、切面计算、复核边界与资料来源 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 模块契约、坐标与生命周期 |
| [SEQUENCES](docs/SEQUENCES.md) | DICOM 序列识别与本机样例 |
| [VALIDATION](docs/VALIDATION.md) | 已执行验证及未覆盖范围 |
| [PROJECT](docs/PROJECT.md) / [ROADMAP](docs/ROADMAP.md) | 已实现与下一步 |
| [DEVELOPMENT](docs/DEVELOPMENT.md) / [PUBLICATION](docs/PUBLICATION.md) | 检查、资产管理、清理和发布 |
| [CHANGELOG](CHANGELOG.md) | 版本变化 |
