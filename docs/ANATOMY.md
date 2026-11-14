# 三维解剖与 CMR 教学

更新：2026-11-15。预设版本 `2026.11.15-r4`。图谱面均为**候选、待独立专家复核**；没有登记为临床准确面。它们与 AMRG 或本机 DICOM 不属于同一受试者，不能据此做颜色叠加或配准。

## 数据与共享视图

BodyParts3D v4.0：41 个网格，保留心室壁、两房壁、四个血池、独立瓣叶、乳头肌及近心大血管。HRA 女性心脏／血管 v1.3：26 个网格，具有独立左右室、室间隔、两组命名的左室乳头肌及整体瓣膜。两图谱共用视图 ID，但使用各自坐标、地标和预设。切换图谱时保留教学视图；缺面显示待补标，不借用另一标本的平面。

| 视图 | BodyParts3D | HRA |
| --- | --- | --- |
| 横断、冠状、矢状定位 | 3 个原始候选 | 原始 GLB 与解剖地标核实人体轴后新增 |
| 初步 2CH、初步 4CH | 2 个原始候选 | 自身心尖／二尖瓣轴，依次垂直横断面／初步二腔 |
| 4CH | 三点候选，四腔／房室瓣交线核查 | 自身地标新候选，四腔／房室瓣交线核查 |
| 2CH | 4CH 绕长轴转 90°的候选，前／下壁待复核 | 待补前／下壁地标；候选误入右房，未启用 |
| 3CH | 三点候选 | 自身地标新候选 |
| 基底 SAX | 从 19% 移至 30% | 本标本长轴 15%，独立扫层选取 |
| 乳头肌 SAX | 保留约 67.7% | 保留交接原型平面 |
| 心尖 SAX | 从约 96.8% 回撤至 95% | 本标本长轴 75%，越过两组乳头肌 |
| 冠状 LVOT | 原始候选 | 待补主动脉根中心轴 |
| 斜矢状 RVOT | 原始候选，新增近瓣下中心线核查 | 人体轴已核实，仍缺漏斗部中心 |
| RV 流入–流出 | 原始三点候选 | 自身三点新候选 |

AMRG 公共影像有 3 组静态黑血定位图与 7 组 × 32 帧 cine；初步定位、专门冠状 LVOT 和 RV 流入–流出没有一一对应影像。2CH／3CH／4CH 为交接材料按形态选取的参考，RVOT 保留原始序列命名。播放只控制影像时间，不暗示静态图谱具有同一心动相位。

## 处方原则与本轮优化

依据 [SCMR 2020 标准协议](https://pmc.ncbi.nlm.nih.gov/articles/PMC7038611/) 与 [EACVI CMR Pocket Guide 第二版，第 6–10 页](https://www.escardio.org/static-file/Escardio/Subspecialty/EACVI/Publications%20and%20recommendations/Books%20and%20booklets/CMR%20pocket%20guides/CMR_guide_2nd_edition_148x105mm_03May2017_last%20version.pdf)：正式切面需要多平面核对；SAX 应垂直于 LV 体部长轴并在 2CH 与 4CH 上检查，不能只取与瓣环平行。4CH 由心尖与两房室瓣定位后，还应在基底 SAX 检查 RV 急缘、室间隔与 LVOT 避让。2CH 的 90°只是起点；3CH 要沿 LVOT 中心、主动脉瓣与根部。RVOT 为经过肺动脉瓣的矢状／斜矢状面；RV 流入–流出另由 TV、RV 心尖和 PV 三点确定。

以下为**同一图谱网格上的几何检查**，不计作独立解剖精度，也不据此设临床合格阈值。

| 面 | 修改／检查 | 结果与待审问题 |
| --- | --- | --- |
| BP 基底 SAX | MV→LV 心尖代理轴长 73.857 mm；14.03 → 22.16 mm（19% → 30%） | 旧面 LA／RA 断面积约 103／541 mm²；新面两房与 AV 均无交点，LV／RV 腔约 1889／2229 mm²。仍切到延长的瓣下结构；需审完整心室肌环。 |
| BP 中段 SAX | 保留乳头肌投影层位 | 两左室乳头肌部件面积合计约 429 mm²；移至 70% 仅约 438 mm²，未凭小幅面积增益更换层位。它们是外侧乳头肌及其分部，不能称两组前外侧／后内侧。 |
| BP 心尖 SAX | 约 71.47 → 70.16 mm（96.8% → 95%） | 左室腔约 138 → 199 mm²。两乳头肌最远投影 70.065／68.932 mm，新面均已越过；94% 仍会切第一部件，因此没有选 94%。 |
| BP 4CH | 保留心尖、MV、TV 三点面 | 四腔与房室瓣相交，AV／近端升主动脉不相交。必经点距面为零是构造结果，不能当精度。 |
| BP RVOT | 保留原面，沿 PV→肺动脉干轴在瓣下 2–12 mm 取 RV 腔截面中心 | 六个中心距现面约 0.31／0.13／0.31／0.98／1.83／2.92 mm；更下方进入宽 RV 体部。仍需读者确认 RV 漏斗部→PV→MPA 连续且居中。 |
| HRA 4CH | 当前网格独立计算 MV、TV 整体表面积加权中心与 LV 心尖代理点 | 四腔和两房室瓣均相交；AV、升主动脉、弓均不相交，AV／升主动脉最近顶点距面约 12.50／19.03 mm。需要审左房覆盖与长轴缩短。 |
| HRA 2CH | 绕自身 LV 轴扫描正交候选 ±90°，每 5° 比较 | 正交候选误入 AV、RV、RA；−10°／−15° 可避 AV 与 RV，但仍切 RA。未找到同时避开三者的面，因此保留待补标，避免按单一几何指标伪造“标准二腔”。 |
| HRA SAX | 重算 LV 代理长轴与继承法线比较 | 夹角约 0.306°，仅说明重复性。新基底层未切两房／MV；新心尖层未切两组左室乳头肌，LV 内腔约 514 mm²。不能把 BP 的百分比移植过来。 |

BodyParts3D 的 MV／TV 中心由同时邻近两侧血池的瓣叶顶点估计，AV／PV 用瓣尖表面中心；心尖取相对房室瓣最远 1% 血池顶点均值。HRA 新面用整个瓣膜表面面积加权中心，心尖用心室壁最远 1% 顶点均值。这些均为代理地标，不是人工标注瓣环与真心尖。建议优先审阅：两模型 4CH＋基底 SAX 定位线、乳头肌 SAX＋双长轴、BP RVOT＋横断参考。

## 几何与显示契约

- 两图谱运行时统一为 LPS 毫米轴（X 左、Y 后、Z 头），各保留自身原点；均无病例 DICOM Frame of Reference，轴名相同不代表配准。HRA 原始公开资产不变，载入时作下述刚体旋转。
- `origin/normal/up` 是唯一切面定义；二维断面、三维切口与参考定位线共用同一坐标架。最终原点为 `preset.origin + translationXYZ + tiltedNormal × offset`；XYZ 沿模型毫米轴平移，倾斜先改变法线。相机旋转不改平面；导出同时保存原始预设、调整量与已应用调整的有效平面。
- HRA 4CH 保持 TV／RV 在画面左侧、心尖向下。r4 将全部网格、地标、继承 SAX 的原点／法线／面内向上向量一起旋转，既有切面几何与 SAX 二维画面保持不变。
- 真实相交线按端点容差 `0.0001 mm` 拼接。闭合环采用 even-odd 填充以保留孔洞；开放边界与分叉保持开放，绝不用直线擅自封口。血管仅管腔几何时始终只画切口轮廓。
- 心肌、瓣膜、乳头肌可填色，血池另行开关；二维填色和三维切口填色独立。血池显示不是测量，也不应覆盖心肌孔洞。

### HRA 坐标追溯

核对[官方心脏 v1.3 GLB](https://cdn.humanatlas.io/digital-objects/ref-organ/heart-female/v1.3/assets/3d-vh-f-heart.glb)及[同版血管 GLB](https://cdn.humanatlas.io/digital-objects/ref-organ/blood-vasculature-female/v1.3/assets/3d-vh-f-blood-vasculature.glb)：18／157 个节点的 world 变换均为单位矩阵。原型全部 **26 个网格、64,766 个顶点**的顺序及完整索引一致，194,298 个坐标全部精确满足 `prototype = round((GLB × 1000 + [-27,-461,66]) × 20) / 20`；最大误差小于 0.025 mm，为原型量化所致。心脏源 GLB SHA256：`98f66e46b149bfc3836592d9404c50290e21d302ec55c98813435e2d9847b1d9`；血管只读取所需 HTTP ranges，未保留完整文件。

原始轴为 **+X 左、+Y 头、+Z 前**。[CardioAtlas](https://kalanimd.com/cardio-atlas/index.html) 的实际脚本仅应用节点 world 变换、共享平移缩放，其前／左／上相机分别从 +Z／+X／+Y 观察；[官方 RUI 视角实现](https://github.com/hubmapconsortium/hra-ui/blob/6cae361fc9960f6d28befd2f2f0e0652340691b4/apps/ccf-rui/src/app/core/store/scene/scene.state.ts)与此一致。另用本地网格独立复核：左／右肺动脉及肺静脉的左右顺序、上／下腔静脉的头足顺序、右室在左房前方、降主动脉在升主动脉后方，方向均一致。只参考其交互与方向约定，未复制站点代码。

运行时 `LPS = [prototype.x, -prototype.z, prototype.y]`，即矩阵 `[[1,0,0],[0,0,-1],[0,1,0]]`，行列式 +1；保留毫米、表面手性与切面距离。不要把 HRA 知识图谱的 CCF placement 旋转再次套到这些已验证的 GLB 原始顶点。新增 3 个体轴定位与 2 个初步长轴后，HRA 共 **11 个候选**；正式 2CH、冠状 LVOT、RVOT 仍按各自缺失证据保留待补标。

### BodyParts3D 主动脉接口

对照[官方 v4.0 原始 OBJ](https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip)：原型所用 FJ1931 的近端比主动脉弓末端高约 17.84 mm，且外径不匹配，原始网格已存在该差异。本版改用同源 FJ3427 的胸段，并恢复 FJ3411 弓后缘被原型裁去的约 2.3 mm；没有平移或变形。远端仍在 z=1158.19 mm 裁剪，保持开放，不新增组织。

新接口两端轴向差约 0.01 mm；两端 1 mm 薄层外轮廓 XY 投影的双向边距，中位/P95/最大为 **0.384/0.742/0.894 mm**（旧组合约 4.83/16.07/16.26 mm）。这是源组件的对齐检查，不是血管壁厚或配准误差；两个原始封闭部件仍独立，未宣称拓扑焊接。`npm run verify:aorta` 校验官方源哈希、坐标保留、接口与开放远端。

## 资产、许可与维护

`scripts/prepare-anatomy.mjs` 从项目相邻 `demos` 的两份交接 HTML 提取数据，再用两份经核验的官方 OBJ 修正主动脉，不读取本机 DICOM。运行 `node scripts/prepare-anatomy.mjs` 可重现 2 个模型 JSON、1 个 cine 目录 JSON 和 227 张去重 JPEG；运行资产总计约 **9.68 MB**。另在 `scripts/sources/bodyparts3d` 保留两份合计约 101 KB 的压缩源 OBJ，支持离线重现，未保留整个官方 ZIP。HRA 坐标按原型 int16 ÷ 20 解码。未复制原型 HTML、运行脚本或离线重复 cine。`public/anatomy/provenance.json` 保存输入 SHA256、资产 SHA256／字节数及来源，出版审计只允许清单中哈希相符的公开影像。

| 资产 | 来源与署名 |
| --- | --- |
| BodyParts3D v4.0 | “BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International”。[下载](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html)／[现行许可](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html)。衍生处理为局部裁剪、网格简化、坐标量化与教学预设；主动脉弓与降段的官方源修订见上文。 |
| HRA female heart v1.3 | Kristen Browne、Heidi Schlehlein，CC BY 4.0。[心脏 DOI](https://doi.org/10.48539/HBM449.SHRV.225)／[血管 DOI](https://doi.org/10.48539/HBM322.KKFC.394)。保留原型裁剪与量化；运行时旋转为 LPS。 |
| AMRG | Auckland MRI Research Group, Auckland, New Zealand。[官方图谱](https://www.cardiacatlas.org/amrg-cardiac-atlas/)／[首页 public-domain 说明](https://www.cardiacatlas.org/)。来自另一位健康志愿者，派生为灰度 JPEG 教学帧，无人工轮廓。 |

`src/core/anatomy/anatomy.test.ts` 验证正交架、平面交线、精确落顶点／共面边、孔洞、开放截口、分叉、模型身份、真实网格的 SAX 层位与 HRA 4CH 结构覆盖；`hraCoordinates.test.ts` 独立验证解剖方向、旋转手性、重复载入、继承 SAX 画面不变和新增定位面。浏览器交互和截图检查见 `VALIDATION.md`。任何新预设变更应同步调整版本、依据、审阅状态与对应测试；不要把本机案例加入公共图谱目录。
