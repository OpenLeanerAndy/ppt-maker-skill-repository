# Contributing

欢迎提交 Issue 和 Pull Request。

## 基本要求

- Skill 目录名和 `SKILL.md` frontmatter 中的 `name` 必须保持为 `ppt-maker`。
- 不要在 Skill 内加入与执行无关的 README、CHANGELOG 或安装文档；面向用户的仓库文档放在仓库根目录。
- 不要提交 `node_modules/`、生成的 PPTX、渲染图片、临时文件或包含敏感信息的素材。
- 新增或替换 Logo、字体、模板、截图前，必须明确其许可证和公开分发权。
- 修改脚本后必须完成实际 PPTX 生成测试，不能只做语法检查。

## 本地验证

```bash
cd skills/ppt-maker
npm ci --prefix scripts --ignore-scripts
node scripts/preflight.mjs
node scripts/build-pptx.mjs \
  --input scripts/example-deck.json \
  --output scripts/output/example.pptx
node scripts/validate-pptx.mjs \
  scripts/output/example.pptx \
  --expected-slides 7
```

如果本机具有 PowerPoint、LibreOffice 或 WPS，还应将所有页面导出为图片，逐页检查文字溢出、遮挡、图片变形、图表和表格样式。

提交前请确认公开版本不包含个人信息、内部文档、客户数据或未经授权的企业资产。
