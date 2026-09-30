# 序列识别与本机样例目录

复查日期：2026-09-30。本文区分现有实现、样例元数据事实、语义推断和后续计划。已修PSIR/SA识别并增加保守几何视角推断；更完整的重建角色组织及ROI显示仍在计划中。

## 如何判断文件属于哪个序列

当前导入使用 Study Instance UID 分检查、Series Instance UID 分原始序列，并按 SOP Class 判断是否是支持的 MR 影像。文件名、文件夹名、Series Number 和描述文本不是序列身份。同名但不同 UID 的重复采集保留为不同来源；改文件名不会改变归属。

以上可靠归属以 UID 完整有效为前提。当前缺失 UID 时会使用 `unknown-study` / `unknown-series` 占位，可能把本应分开的对象放进同一个候选组；后续需改为隔离并明确报告，不能宣称已可靠处理缺失 UID 的文件。

UI 中的“集合”不一定等于一个原始 Series：同一 Series 内方向不同会拆成多个集合；只有明确兼容、不同层位的 SAX Cine 才尝试自动合并。几何位置依赖 Image Position / Orientation / Pixel Spacing，帧序依赖可用时间字段与多帧维度，不按文件名字典序推定。

“这是什么序列”和“文件属于哪个 Series”是不同问题。当前 `src/core/spaceTime.ts` 合并 Series Description、Protocol Name、Sequence Name、Image Type 的文本，用规则识别类型及视角；部分 Cine 也有时间维度依据。没有跨厂商标准化的自由文本命名，描述缺失或自定义时，类型可能归入“其他”，视角可能显示“视角待确认”；可读 MR 仍保留供浏览。[DICOM Series 定义](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.3.html)

当前能人工修改视角并合并/拆分集合，不能在界面修改序列类型。仅有平面方向不能可靠区分心脏相对的 2CH、3CH、4CH；它描述患者坐标中的斜切平面，不包含完整心脏解剖标志。新增几何推断使用同检查、同Frame of Reference、已有明确视角标签的Cine作锚，要求方向、有限视野重叠与位置范围相符，目标全部平面唯一支持同一视角才补标签。推断结果不继续作锚，歧义保持「视角待确认」，详情单独标「几何推断」。

## 当前支持到什么程度

| 能力 | 当前边界 |
| --- | --- |
| 输入 | 灰度传统 MR 和未压缩整数 Enhanced MR；压缩传统单帧走 ITK-Wasm 并校验解码后的几何 |
| 类型分类 | Cine、LGE、灌注、Mapping、定位像、其他；不是任意厂商协议的可靠语义分类器 |
| Cine | 空间/心动导航、播放、不同帧数的相位联动；推算或近似匹配显式标记 |
| 其他 MR | 灰度、调窗、元数据、帧/参数浏览；有可靠坐标时可显示定位线及加入立方体 |
| Mapping | MR Image 中封装的源图和参数图可作为影像浏览；尚未拆分重建角色、校准参数单位或提供定量读数 |
| 尚未支持 | 压缩 Enhanced、Float Pixel Data、独立 Parametric Map 对象、ROI 显示、流量/灌注/功能定量 |

## cmr-eg 当前目录

当前目录有 **978 个 DICOM 文件**：**943 个传统 MR 单帧影像、43 个原始 MR Series、47 个展示集合**，另有 **35 个 PR（Presentation State）对象**被当前影像导入器跳过；失败文件为 0。目前没有 `.roi` 文件。早期文件数量见 [历史验证归档](archive/VALIDATION-2026-09-30.md)，不代表此次目录内容。

下表“序列数”按原始 Series UID 统计，“影像数”按 MR 实例统计；名字相同不代表同一次采集。具体用途是结合命名与 Image Type 的解释，不能仅凭名字确认所有采集条件。Cine、首过灌注、LGE、黑血/T2 加权的通用用途参考 [SCMR 标准扫描协议](https://pmc.ncbi.nlm.nih.gov/articles/PMC7038611/)，Mapping 的源图与参数图区别参考 [SCMR/EACVI Mapping 共识](https://link.springer.com/article/10.1186/s12968-017-0389-8)。

| 实际描述 | 序列数 / 影像数 | 内容与用途 | 当前分类 / 需注意 |
| --- | --- | --- | --- |
| SURVEY | 1 / 60 | 定位、规划；分成 3 组方向，各 20 层 | 定位像；3 个展示集合 |
| BTFE_FS | 3 / 50 | 名称提示 balanced TFE 脂肪抑制；静态解剖图 | 其他；每层 1 图，不能因 balanced 读出就认作 Cine，也不是 fat-only 图 |
| SSh_TSE_BB | 1 / 14 | 名称提示单次激发 TSE 黑血，供形态观察 | 其他；14 个层位 |
| csT2_STIR_BB | 2 / 4 | T2 加权、STIR 脂肪抑制、黑血；观察组织信号 | 其他；`cs` 前缀未确认 |
| T2_SPIR_BB_4CH | 1 / 1 | 四腔 T2 加权、频谱脂肪抑制黑血图 | 其他 / 4CH |
| Cine_2CH_BH | 2 / 50 | 二腔长轴电影，左室/左房运动 | Cine / 2CH；每次 25 帧 |
| Cine_3CH_BH | 2 / 50 | 三腔长轴电影，含左室流出道 | Cine / 3CH；每次 25 帧 |
| Cine_4CH_BH | 3 / 75 | 四腔长轴电影，观察左右心腔 | Cine / 4CH；每次 25 帧 |
| Cine_LVOT_BH | 3 / 75 | 左室流出道电影 | Cine / LVOT；每次 25 帧 |
| Cine_SA_BH | 1 / 25 | 单层短轴电影 | Cine / SAX；1 层 × 25 帧 |
| Cine_SAX_BH | 1 / 275 | 主要短轴电影堆栈 | Cine / SAX；11 层 × 25 帧 |
| IR_TFE_LL_PSIR | 1 / 28 | `LL` 提示 Look-Locker / TI scout，可能用于选择反转时间 | 按命名推断归定位/scout类，并提示需核实；公共TI字段未证实，不解释为心动相位 |
| PSIR_TFE_BH | 4 / 42 | PSIR 延迟增强类采集；每层有 M_IR、CR_IR、M_FFE 三种图像角色 | LGE；3 种输出不是 3 个心动相位 |
| sPSIR_CR | 4 / 14 | Image Type 为 CR_IR，提示 PSIR corrected-real 输出 | 已修为LGE；视角按明确描述或唯一几何证据补充 |
| 3D_PSIR-TFE_BH_SA | 1 / 33 | 3D PSIR 短轴类采集，11 层 × 3 种输出 | 已修为LGE / SAX；展示已有平面 |
| s3D_PSIR-CR | 1 / 11 | 3D PSIR corrected-real 输出，11 层 | LGE；不能由名字推断额外时间维度 |
| DYN_sTFE_Multi-Plane | 2 / 16 | 动态、多平面灌注类采集 | 灌注；共拆为 4 集合，目前每层仅 2 帧，不能证明是完整首过过程 |
| sWIP DYN_sTFE_Multi-Plane_1 / _2 / _3 / _4 | 4 / 8 | 同类动态数据，每个来源 2 张 | 灌注；后缀不能证明应激/静息或特定重建角色 |
| T1 mapping_native | 2 / 48 | 名称提示未增强 T1 Mapping | Mapping；8 张 T1 MAP + 40 张 M_FFE |
| T1 enhanced | 2 / 48 | 名称提示增强后 T1 Mapping；增强时点未仅凭命名确认 | Mapping；8 张 T1 MAP + 40 张 M_FFE |
| T2 mapping | 2 / 16 | T2 Mapping 相关输出 | Mapping；4 张 T2 MAP、4 张 R2、8 张 M_SE |

按上述家族归纳，Cine 550 张、定位像 60 张、静态形态/T2 加权 69 张、PSIR/LL 相关 128 张、动态灌注类 24 张、Mapping 112 张，合计 943 张。部分同名重复采集仍为独立 Series，不自动合并。

### PR 与 ROI 复查

35 个 PR 均为 Grayscale Softcopy Presentation State。本次只读检查中，Graphic Annotation Sequence、Graphic Object Sequence、Text Object Sequence 均为 0，**未发现可显示的 ROI 轮廓或文字**。它们有引用影像、显示区域、缩放与窗变换等内容；显示区域的矩形角点不是 ROI。部分引用的 MR 实例不在当前样例中。

因此不能把“PR 导入”直接等同于“ROI 支持”。当前目录也无 `.roi` 文件，真实 ROI 格式、像素/显示/患者坐标和帧范围尚无实样验收材料；路线图先定义已有标注显示，并用包含图形标注的样例验证。参见 [DICOM 图形标注模块](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.10.5.html)。

### 本次发现的识别边界

- `sPSIR_CR` 前缀漏判及 `3D_PSIR-TFE_BH_SA` 的 `SA` 视角识别已修复；已有明确Cine锚的Mapping可以保守补充视角，缺失/冲突证据仍待确认。
- Look-Locker/TI scout 应与最终 LGE 分开。公共元数据不能确认时应显示“待确认”，不能把 28 张当成 28 个心动相位。
- 两组 T1 每层当前有 12 个浏览槽，T2 每层有 4 个槽；这些混合了源图与重建角色，不是 12/4 个心动时相，也不能把全部槽解释成同一 TI/TE 参数轴。当前参数轴是弱规则组织，仍需改进。
- 样例参数图的 Image Type 含 `T1 MAP` / `T2 MAP`，同时标 `ORIGINAL`，说明只看 ORIGINAL/DERIVED 也不够。需要检查重建角色及数值单位变换；显示灰度不代表已经能读取正确的毫秒值。
- 两帧灌注不足以证明完整增强时程；名字也不能证明应激/静息条件。

本轮最终复核：LGE为10个集合（SAX2、4CH2、视角待确认6），Mapping为6个集合（SAX3、4CH3）；已明确文本标签优先，几何推断记录独立警告。此前宽泛列为LGE的LL组现按命名推断归定位/scout类。几何阈值为方向差≤5°、有限FOV重叠≥较小影像50%、长轴平面中心法向偏移≤3mm、短轴位于方向/FOV合格锚堆栈范围±5mm；这些是保守工程启发式，不是解剖自动识别或配准。

### 两组 2CH 的位置与 25 帧排序

“两次二腔”更准确应称“两组独立 Series”，并不证明两次完全相同的定位或一定是重新扫描。样例两组 Cine_2CH_BH 在同一检查、同一 Frame of Reference；平面法线夹角约 0.462°，两组均为 240×240、1.25×1.25 mm 像素、8 mm 层厚。它们定位相近，但平面不完全重合，保留为两个来源。每组内部 25 帧的几何元数据完全相同，代表同一采集平面内的不同时间帧；患者实际运动不能仅由静态几何元数据判断。

帧排序先在各空间平面内进行，不能混入相邻层。当前 Cine 优先使用有变化的时间维度索引 / Temporal Position Identifier，再用显式 nominal phase，再用 TriggerTime，最后以 InstanceNumber 等作为近似回退。恒定 TPI 不提供排序信息。文件名和目录读取顺序不决定时间先后。[MR 时间字段定义](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.8.3.html)

样例两组 2CH 的 TPI 均为 1、无 nominal phase；原始 TriggerTime 升序分别为 `0, 37, 73, …, 840, 877 ms` 和 `0, 40, 79, …, 909, 948 ms`，InstanceNumber 各自为 1–25。对应 NominalInterval 为 860 / 805 ms，短于部分 TriggerTime，因此不能直接认定 `TriggerTime / NominalInterval` 是有效的周期百分比，更不能通过取余后重排帧。序列内先后应保留 TriggerTime 升序；跨序列相位关联采用近似估计并明确标记。

本轮已修复此前取余后重排的问题：原实现会将第一组的末帧放到 F2，第二组的末尾 4 帧穿插到开头。修正后两组 InstanceNumber 均按 1–25 展示，phaseMatching 为 approximate。真实样例全部 22 个 Cine 平面的 TriggerTime 顺序通过 `verify:sample`；其中 20 个存在标称 R–R 越界，均降为近似相位匹配。排序与联动的准确程度分开判断，不因“知道先后”就宣称已知准确的周期百分比。

## 后续识别完善

保持原始归属、序列语义、视角、维度和重建角色分开建模，供 CmrSpaceTime 对外返回判断及依据：

1. UID / SOP 先确定对象身份和关系。
2. 读取标准结构化采集、心动、维度字段及 Image Type；Scanning Sequence、Sequence Variant、Scan Options 等需补充读取。TR/TE/TI 是证据，不能单个阈值直接决定临床用途。
3. 通过经过实样验证的厂商规则解释私有字段和重建输出，再用描述文本补充。bSSFP、TrueFISP、FIESTA、bFFE 等读出名称不能单独证明一定是 Cine。
4. 分别报告类型、视角、重建角色的证据与可信程度；冲突/缺失时保留“待确认”，而不是强行选一个已知标签。
5. 在现有视角修正之外加入类型/角色人工修正。覆盖配置与原始元数据分开；同名不同 UID 不因人工标签被合并。

当前已实现UID归属、基础文本分类、保守几何补充及人工视角修正。上述完整证据接口、厂商字段、类型/角色人工修正仍属路线图；验收需覆盖改文件名、删改描述、厂商前缀、重复采集、混合重建输出，以及 Cine / 灌注 / TI scout / Mapping 互不误当相同时间轴。

缺失或异常 UID 也应进入验收：无法确认归属的实例隔离保留并报告，不能共享占位身份后静默合并。

## 可复查的本机统计

```powershell
npm run catalog:sample
```

只读项目相邻 `cmr-eg`，输出聚合描述、类型、视角、层/帧数、Image Type 和采集参数，不输出患者身份、原始 UID 或文件名；结束释放临时会话，不复制影像进项目。它复用当前导入/组织逻辑，因此用于检查当前行为，不是独立的分类正确性证明。
