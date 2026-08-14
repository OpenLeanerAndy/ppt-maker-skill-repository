# Security Policy

## 报告安全问题

请不要在公开 Issue 中披露尚未修复的安全问题。请通过 GitHub Security Advisory 的“Report a vulnerability”功能联系维护者，并提供受影响版本、复现步骤、影响范围和建议修复方式。

## 依赖安全边界

PptxGenJS 4.0.1 间接依赖的 `image-size` 存在 ICNS、JXL 和 HEIF 解析拒绝服务公告：

- [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)

截至 2026-08-14，npm 尚未提供已修复版本。内置脚本通过以下方式降低风险：

- 只接受本地 PNG、JPEG 和 GIF；
- 拒绝远程图片 URL；
- 校验扩展名、文件签名和图片尺寸；
- 将单张图片限制在 25 MB 以内；
- 不接收受影响的 ICNS、JXL 和 HEIF 格式。

贡献者不得绕过 `build-pptx.mjs` 中的图片格式、大小和文件签名检查。依赖发布修复版本后，应升级锁文件并重新完成 PPTX 生成、PowerPoint 打开和视觉回归测试。
