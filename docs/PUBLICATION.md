# GitHub发布与隐私

首次上传：2026-09-30，公开仓库 `woyeyao/cmr-prism`。只发布经过检查的源码、文档、合成测试、配置、锁文件及官方字体/许可证；真实DICOM、患者身份、原始实例UID、截图、上传文件、会话缓存、凭据和本机用户目录不上传。

文档中保留不含身份的聚合验收结果和通用协议说明。测试中的PatientName、PatientID及实例UID是人工合成值，DICOM标准SOP/编码UID是公开规范常量；它们不来自真实患者。真实样例需使用者自行提供，不随仓库分发。

2026-11-15 新增 `public/anatomy/`：BodyParts3D、HRA 的 CC BY 4.0 衍生网格，以及官方 public-domain AMRG 的灰度参考帧。仅此批已审阅资源允许发布；精确来源、署名、许可与哈希见其 `provenance.json` 及 [ANATOMY](ANATOMY.md)。另保留两份合计约101 KB的官方主动脉压缩源 OBJ，按压缩/解压哈希与字节数精确校验，用于离线重现接口修正。它们与本机病例严格分开，不能据此开放任意医疗图像或压缩文件后缀。

## 历史与发布分支

原本机提交历史包含私人Git邮箱，且早期README曾含本机用户路径，不能直接推送。首次公开上传建立没有父提交的源码快照，提交及标签统一使用项目匿名身份。原本机 `main` 与 `v0.1.0` 仅保留为本地历史。

本机发布分支为 `github-public`，对应GitHub的 `main`；匿名标签 `public/v0.1.0` 对应远端 `v0.1.0`。本项目的默认推送配置只推送发布分支，并关闭自动跟随标签。公开版本的后续提交仍使用项目匿名身份。GitHub新克隆得到的是公开 `main` 及公开稳定标签，均不含原本机历史。

## GitHub Pages

在线地址：[woyeyao.github.io/cmr-prism](https://woyeyao.github.io/cmr-prism/)。仓库 Pages Source 使用 **GitHub Actions**，由 `.github/workflows/pages.yml` 在 `main` 更新后发布。

工作流先执行类型、单元、主动脉源与发布审计，再构建独立静态课堂、验证产物并上传 `artifacts/pages`。仅部署解剖课堂与公开资产；本机 DICOM 页面、上传入口、API、真实影像、脚本及服务端源码不进入站点。`build-info.json` 记录版本与部署 commit，便于线上核对。Actions 固定版本 SHA，构建仅有读取权限，部署 job 才有 Pages 写入和 OIDC 权限；产物保留1天。

静态构建命令为 `npm run build:pages` 和 `npm run verify:pages`。默认 basePath 为 `/cmr-prism`，发布 workflow 使用 configure-pages 返回的路径。正常本机版继续使用 `npm run build` / `npm start`。静态构建占用 `.next` 中间目录，先停服务；恢复本机版前重新普通构建。

字体在静态包中只保留一组经哈希核验的副本及完整许可证；公开模型仍使用已有精确资产清单。审计仅特别允许本工作流文件，未开放任意 YAML 或数据文件。首次设置与权限依据：[GitHub 自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 后续检查

先检查 `git status` 与暂存清单，只添加需要的源码和文档；不要使用包含未知文件的批量上传。普通测试使用合成影像；真实影像检查产生的输出留在已忽略的本机目录。

```powershell
npm run audit:publication
npm run audit:publication -- --worktree
git diff --check
git push
```

隐私检查读取当前提交及全部可达祖先，检查提交身份、文件类型、DICOM签名、本机用户路径、邮箱和常见密钥格式，只输出文件路径与原因，不输出命中的敏感值。指定其他待上传引用可使用 `npm run audit:publication -- github-public public/v0.1.0`。

`--worktree` 另检查当前已跟踪和未忽略文件，适用于提交前验收；HEAD检查本身不能覆盖未提交修改。图谱JPEG按已审核资产集合与精确哈希放行，新增或变更图像需要重新核查来源和更新已审阅集合。

规则扫描是最后一道辅助检查，新增文件仍需人工确认来源。不能推送原本机 `main`、原本机 `v0.1.0`，也不能使用 `--all`、`--mirror`、`--tags`、自动跟随标签或将原本机历史合并进发布分支。`.gitignore`不能阻止已跟踪的文件上传。
