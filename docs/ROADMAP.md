# 后续路线图

基线：`v0.1.0`（2026-09-30）。下表均为尚未实现或尚需扩展验证的工作；已实现项及验收见 [项目台账](PROJECT.md)，验证边界见 [验证摘要](VALIDATION.md)。优先级表示开发次序，不承诺交付日期。

| 优先级 | 功能 | 前置条件 / 验收方向 |
| --- | --- | --- |
| P1 | 更多厂商与压缩DICOM实样 | Enhanced、JPEG/JPEG-LS/JPEG2000的帧序、重标度、厂商私有时间字段验证 |
| P1 | 大型检查与压缩Cine性能 | 先区分上传、目录解析、解码、传输和渲染耗时；比较worker解码池、批量帧API、紧凑目录等，保持取消和有界内存；需要时再评估Python/原生后端的实测收益及本机安装成本，不因单帧加载慢直接换栈 |
| P1 | 压缩Enhanced与浮点MR对象 | 验证逐帧解码顺序和不同重标度，支持Float Pixel Data，不能假设统一变换 |
| P1 | 异常退出后的临时目录恢复 | 多个本机服务进程间的所有权与存活判断，避免误删活跃会话 |
| P1 | 序列识别与重建角色完善（D06） | 已修PSIR前缀/SA并增加保守几何视角推断；后续补充结构化厂商证据、人工类型/重建角色修正与Mapping输出拆分；缺失UID隔离报告，详见SEQUENCES |
| P1 | 已有ROI导入与二维显示（R01→R02） | 当前样例35 PR没有图形/文字标注，需另验证包含ROI的GSPS或厂商实样；规范化点、轮廓与文字，正确关联原影像/多帧帧号；单张/分屏覆盖显示、开关和标签；坐标缺失或引用失效单独报告 |
| P1 | NIfTI 3D/4D | 保留affine、时间轴、单位与RAS/LPS转换；缺少CMR视角语义时允许人工关联 |
| P2 | ROI空间平面覆盖（R03） | 依赖R02；二维坐标经同一像素→患者变换投影到原平面；按有效引用更新，不能将一帧轮廓自动复制到全部Cine时相 |
| P2 | 更多ROI格式适配 | 按实际数据逐项验证厂商格式、RTSTRUCT等；未验证格式不宣称支持，DISPLAY坐标必须处理显示区域/旋转/翻转 |
| P3 | 定量分析 | 逐项定义T1/T2单位、功能参数、分割、采集协议、有效性与验证集 |
| P4 | 持久化与团队使用 | 单独设计身份认证、存储生命周期、访问控制和部署；不将当前本机会话直接开放公网 |

ROI本轮定义为**显示已有区域/轮廓标注**，不含新建、编辑、自动追踪、组织识别或ROI统计/导出。覆盖层与灰度像素分离，调窗不改ROI；首先保留源SOP引用的服务端映射，不能先跳过PR再尝试找回引用。StudySource隐藏格式及引用解析，CmrSpaceTime负责坐标关联，ViewerSession管理可见性，PresentationRuntime负责绘制与释放。

参考：[DICOM图像平面](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html)、[多帧维度](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.17.html)、[DICOM图形标注](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.5.html)。
