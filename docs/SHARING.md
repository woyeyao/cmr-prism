# 项目传播 / Sharing CMR Prism

定位：**CMRI viewer + CMR × 3D 交互教程**。首屏展示“亲手切开3D心脏，再对照CMR”，让用户先试到最直观的功能；介绍中同时保留本机阅片工作台。

## 可直接发布：中文

**四腔心、短轴，到底是怎么切出来的？**

我做了 CMR Prism：拖动、旋转切面，亲手切开3D心脏；再在课程模式里对照真实CMR，把切面与解剖的空间关系串起来。

它也是一个本机 CMRI viewer：DICOM、Cine、多视角阅片都能用。

网页课堂直接体验，中英双语。你最想先试哪个切面？

https://woyeyao.github.io/cmr-prism/

#心脏磁共振 #医学影像 #3D解剖

## Ready to post: English

**Slice a 3D heart. Make sense of CMR planes.**

CMR Prism pairs free 3D slicing and guided atlas–CMR comparisons with a local cardiac MRI viewer.

Try the bilingual classroom: https://woyeyao.github.io/cmr-prism/

#CardiacMRI #MedEd

## 首轮发布顺序

| 途径 | 素材与目的 |
| --- | --- |
| 科室教学、熟悉的影像/住培学习群 | 两张图加体验链接，邀请试用；收集“哪个切面最难理解”的具体反馈 |
| 小红书；随后B站 | 图一展示自由切割，图二展示3D/CMR对照。B站再做30–60秒实操：四腔心→短轴→自由切面 |
| LinkedIn / X | 英文横图配上方英文短文，面向CMR、医学教育及可视化开发者；有录屏后再发原生视频 |
| GitHub；SCMR教育圈 | 仓库承接说明、源码和问题反馈；积累教学反馈后，可向SCMR NewsBeat提议介绍工具 |

先发布一次完整介绍，之后分别讲“四腔心的空间关系”“短轴从基底到心尖”，每条解决一个学习问题。优先记录实际试用和教师反馈，不以点赞替代教学有效性评价。上述顺序与时长是项目建议。

可用的官方入口：[小红书创作服务平台](https://creator.xiaohongshu.com/)、[LinkedIn视频及封面说明](https://www.linkedin.com/help/linkedin/answer/a7494039)、[SCMR NewsBeat投稿说明](https://scmr.org/newsletter/)。

## 配图与复用

- 中文竖图一：自由切割，突出拖轴/旋转环和切开的模型。
- 中文竖图二：模型断面与公开CMR并排，突出解剖对应的学习用途。
- 英文横图：1200×630，可用于英文帖、README及网页分享卡片。仓库只保留这一张公开预览，避免重复打包整套宣传素材。
- 录屏建议：0–3秒展示切口变化；3–10秒拖轴、转环；10–20秒切回课程，展示模型、断面和CMR；结尾给体验地址。录制时只使用公开参考资源。

图注保留：**图谱与MR为不同受试者的教学对照，非同人配准。** 自由切割改变的是模型切面，不会重建或重切MR；预设仍为候选。正文不使用“把MRI还原成3D”“精准融合”“临床验证”等未实现或未验证的表述。

分享图来自项目实际截图及公开模型/影像，排版为宣传展示。BodyParts3D由DBCLS提供，按CC BY 4.0署名；AMRG参考影像来自Cardiac Atlas公开资源。原始出处及衍生处理见 [ANATOMY](ANATOMY.md)。代码尚未指定项目许可证，宣传使用“源码公开 / source available on GitHub”。

## English notes

Lead with an actual cutaway, follow with the atlas–CMR comparison, then explain the local viewer. Share with medical learners first; use the English card for CMR educators and visualization developers. Seek feedback about difficult planes and teaching use.

Keep the image credit and teaching-comparison note visible. The atlas and reference MR come from different subjects; the app does not register them or reconstruct patient anatomy from MR. Describe the code as **source available on GitHub** until a project license is chosen.
