# 架构与接口

## 不变量

- 患者空间统一为 LPS 毫米；像素坐标统一为 `[column, row]`，ImagePositionPatient 是首个像素中心，有限图像边界位于半像素外侧。
- DICOM PixelSpacing 是 `[rowSpacing, columnSpacing]`；切片朝向来自 IOP，不默认等于轴向、冠状或矢状面。
- 几何、标量像素和展示材质彼此独立。灰度映射是二维与三维共用的函数；重标度只执行一次。
- 一张空间平面可有 Cine 相位、采集时间、参数采样或静态帧。已知缺帧用 `null` 槽保留，不静默跳过或插值。
- Cine 可用 DICOM 名义百分比或名义 R-R 周期进行相位映射；仅有帧序时用逐层归一化位置并标为近似，不跨层精确匹配 TriggerTime。记录的名义周期不等于生理或定量有效性验证。
- 不同 Study / Frame of Reference 不自动建立空间关系；跨序列定位线表示采集平面关系，不表示配准。

## 模块边界

| 模块 | 输入 / 输出 | 禁止承担 |
| --- | --- | --- |
| StudySource | 文件 → StudyCatalog；frameId → Float32Array；释放会话 | UI 布局、调色和动画 |
| CmrSpaceTime | 描述符 → 集合、平面、时间槽；导航 → 帧；几何 → 定位线 | 文件系统、GPU、React 状态 |
| ViewerSession | action → ViewerState；状态 → 当前视口/立方体游标 | DICOM 解析、像素解码、Three 场景 |
| PresentationRuntime | 标量帧、窗宽窗位、位姿 → 二维/三维显示 | 序列分类、时空推断、修改原始值 |

共享类型在 `src/core/types.ts`。接口改变必须同步检查调用者与验收用例。UI 外壳组织控件，通过 reducer 调用功能；复杂几何、解码、缓存和 GPU 生命周期藏在模块内部。

## 数据流

1. 本机上传：限制文件总大小、ZIP 解压大小和路径，复制到匿名临时会话。
2. dcmjs 读取 MR 及 Enhanced MR 元数据，过滤非影像 SOP；输出不包含 PatientName / PatientID 的目录。
3. CmrSpaceTime 按 Series、几何、空间位置和维度组织集合，保存原 Series 来源。
4. 浏览器按需要请求 Float32 标量帧；native 解码或 ITK-Wasm 处理后，缓存已经重标度的像素。
5. ViewerSession 维护模式、相位、层位、视口独立窗参数和备注。展示模块只接收已解析状态。

导入签名检查、文件统计与元数据解析使用最多4路并行，结果保持输入顺序；ZIP解包与预算检查仍按顺序执行。类型与视角分别判断：明确文本优先，未知视角只在同Study/同Frame of Reference且已有明确Cine锚时，以方向、有限视野重叠和平面位置补充；冲突保持未知，推断附警告，人工标签不修改原始描述符。

浏览器StudySource隐藏请求队列和像素缓存：可见帧最高优先，相邻帧其次，选中Cine的完整平面循环先于其他Cine；后台最多2路，总并发最多6路。预热按完整循环的标量字节计入128MiB缓存的75%预算，可见帧受保护；切换集合取消旧后台工作，共享请求去重，释放会话取消全部请求。React视口同步读取缓存，异步更新按动画帧合并，缓存命中不经过额外加载画面。

分屏双击使用单个inspectViewport动作保存活动视口与分屏来源；returnToSplit只恢复布局，时间、层位、窗参数、联动和备注均留在ViewerSession。侧栏折叠属于展示外壳，Canvas和三维renderer按中心区尺寸重排。

二维导航在每个ViewportState保存缩放与相对视口宽高的平移量。core/imageTransform隐藏适应视口、物理比例、鼠标锚点缩放和限幅；Canvas与SVG定位线只使用一个计算后的矩形。Ctrl滚轮缩放、普通左拖平移，不进入调窗或时空导航动作；帧/层切换及分屏放大保留变换，换序列或「适应」重置。帧率控件隐藏输入草稿、空白与限幅，session仍接收有效fps。

## 解剖课堂

`AnatomyClassroom` 选择课程工作区 `AnatomyWorkspace` 或独立 `FreeSliceWorkspace`，不占用旧 `atlas`（玻璃阵列）模式名。进入课堂暂停旧播放器和预热，返回时保留原阅片状态；本机对照复用 `BrowserStudySource`，拥有自己的序列、层位、帧和窗参数。关闭课堂释放图形资源和监听，病例会话仍由外壳维护。

`core/anatomy` 保存共享教学视图 ID、各标本毫米坐标、候选处方和纯几何算法。`public/anatomy` 仅含有来源记录的公开图谱及 AMRG 参考帧，按需读取，不进入患者目录。HRA 经官方 GLB 与参考站坐标核验，以 `[x,-z,y]` 统一到 LPS；原文件保持可追溯。两图谱的 LPS 轴都不构成与病例的配准。

模型预设加微调只生成一个 `PlaneFrame`；原点为 `preset.origin + translationXYZ + tiltedNormal × offset`，XYZ 平移在模型毫米轴下计算、与相机无关。三维裁剪、二维断面与参考面定位线使用该帧。相机变换与切面解耦。三角网格求交后只拼接重合端点；开放/分叉轮廓不强行闭合，组织闭环以 even-odd 填色保留孔洞，血管管腔只描边。三维与二维填色独立。

静态图谱、AMRG 和本机病例仅并排比较，不自动共享空间或心动相位。模型切换保留教学视图，但使用该模型自己的处方；不存在的组合显式报告。模型预设均是待专家复核候选，几何相交、地标拟合或公式自洽不表示临床选面精度。

自由模式保存切面原点与完整姿态，经 `freePlaneFrame` 生成同一个右手正交坐标架；世界轴移动和旋转控件只作用于独立 plane proxy，旋转不移动原点。拖控件时关闭 Orbit，按 RAF 合并更新，退出时释放控件和 GPU 资源。自由模式不参与候选处方或课程微调限制。

`I18nProvider` 仅保存语言和翻译显示文本，未知病例名称保留原文。模型、平面、像素及 source 对象不因语言变更替换。CMR 视窗以图像宽高比计算自然高度，本机使用物理像素间距；纵向调整为附加高度，不改变像素几何。

Pages 构建以 `pageExtensions: ["pages.tsx"]` 选择独立入口，导入 `PublicAnatomyApp`；普通页面和 API 不进入静态路由。公共资产统一经过 `publicAsset()` 加 basePath。静态包检查确认没有本机病例客户端/API/源码，字体按哈希去掉重复副本、保留许可。普通本机入口仍使用 `page.tsx`。

## HTTP 接口

| 接口 | 结果 |
| --- | --- |
| POST `/api/studies`，multipart `files` | StudyCatalog + ImportReport |
| GET `/api/studies/:id` | 活跃会话目录并续期 |
| GET `/api/studies/:id/frames/:frameId` | little-endian Float32 标量字节；尺寸与灰度语义在描述符中 |
| DELETE `/api/studies/:id` | 清理缓存和临时文件 |

错误使用 `{code,message}` 和恰当状态码，响应 `Cache-Control: no-store`。目录与像素分离，不用 Base64 预着色纹理。客户端预算 128 MiB，服务端预算 256 MiB，预取和普通请求去重。关闭/替换导入会话时清理；5 分钟心跳保持打开的会话活跃。

目录中的 Study、Series、Frame of Reference 使用会话内匿名 ID，保留分组和空间关联；服务器保留原始来源关系。未压缩 Enhanced 按功能组及维度指针解析。压缩单帧经 ITK 解码后直接使用已重标度值；压缩多帧在验证逐帧变换前拒绝。取消信号贯穿上传、ZIP、并发解析与会话登记；等待活动任务和文件句柄关闭后清理 session、cache 与目录。服务被强制结束时可能残留临时目录，不承诺跨进程自动清理。

## 展示与降级

Canvas2D 提供正面灰度影像，遵守物理像素比例；定位线和影像共用显示变换。Three.js 提供一个三维 renderer，优先 WebGPU 并回退 WebGL2；故障后释放资源，二维仍可使用。阵列是展示性排列，立方体是单一刚体坐标变换后的真实采集平面。三维没有 CT 色表、体素外挤或组织推断。

封面使用CSS动画和有界requestAnimationFrame指针视差，并遵守减少动态效果偏好；Three场景在进入影像模式后才加载。阵列保留OS-03-P的斜置玻璃盒、细线与抽出效果，反光只在边框，不叠加到灰度影像。拖动超过阈值后不触发点击抽出，滚轮仍交给统一时间/空间导航。

封面为10个错开相位的波浪玻璃盒。阵列只有一个弹出目标，优先待打开/悬停层，回退活动层，始终沿Y轴移动而不改变Z层序。层间距是独立展示参数，不进入患者几何；Shift左拖交由OrbitControls自身的修饰键行为，不再二次反转。玻璃使用浅色、不受灯光压暗的材质，影像材质保持独立。明暗主题只修改界面、边框和场景背景，像素灰度映射不变；浏览器只持久化主题和语言偏好。
