# ppt-maker

`ppt-maker` 是一个面向 Agent 的 PPT 制作 Skill。它可以根据用户提供的素材、页面大纲和设计要求生成 `.pptx` 演示文稿；当 Agent 没有原生 PPT 制作能力时，可使用 Skill 内置的 PptxGenJS 脚本作为降级方案。

## 功能

- 根据 PDF、DOCX、文本等素材规划演示文稿内容。
- 按预设的内容分析、布局和视觉规范制作 PPT。
- 支持标题页、目录页、章节页、内容页、表格页和结束页。
- 支持文本、项目符号、指标卡、表格、图片和原生图表。
- 自动进行 PPTX/OOXML 结构校验。
- 在 PowerPoint、LibreOffice 或 WPS 可用时进行页面渲染和视觉验收。

## 仓库结构

```text
ppt-maker-skill-repository/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
├── THIRD_PARTY_NOTICES.md
└── skills/
    └── ppt-maker/
        ├── SKILL.md
        ├── agents/
        ├── assets/
        ├── references/
        └── scripts/
```

## 安装

### 跨 Agent 一行安装（推荐）

使用开放 Agent Skills CLI 安装到用户级目录，并按提示选择本机已安装的 Agent：

```bash
npx skills add OpenLeanerAndy/ppt-maker-skill-repository --skill ppt-maker -g
```

该命令适用于 Codex、Claude Code、Cursor、OpenCode 等支持 Agent Skills 的工具。CLI 项目与完整支持列表见 [vercel-labs/skills](https://github.com/vercel-labs/skills)。

### 让 Agent 安装

把本仓库的 GitHub URL 发给支持 Agent Skills 的 Agent，并使用类似提示词：

```text
请从 https://github.com/OpenLeanerAndy/ppt-maker-skill-repository 安装 skills/ppt-maker Skill。
安装完成后，按照 Skill 中的说明检查 PptxGenJS 依赖。
```

对于带有官方 `skill-installer` 的 Codex，Agent 会从仓库中的 `skills/ppt-maker` 路径安装到 `$CODEX_HOME/skills/ppt-maker`。

### Codex 控制台安装

```bash
python "$CODEX_HOME/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo OpenLeanerAndy/ppt-maker-skill-repository \
  --path skills/ppt-maker
```

如果没有设置 `CODEX_HOME`，Codex 的默认目录通常是 `~/.codex`。Windows PowerShell 可以使用：

```powershell
python "$HOME\.codex\skills\.system\skill-installer\scripts\install-skill-from-github.py" `
  --repo OpenLeanerAndy/ppt-maker-skill-repository `
  --path skills/ppt-maker
```

### 手动安装

也可以克隆仓库后，把 `skills/ppt-maker` 整个目录复制到 Agent 的 Skills 目录。例如 Codex 默认使用：

```text
~/.codex/skills/ppt-maker
```

安装完成后，请开始一个新任务或重新启动 Agent，使 Skill 被重新发现。

## 安装 PptxGenJS 降级运行时

只有在 Agent 缺少原生 PPT 制作能力、需要调用内置脚本时才需要安装：

```bash
cd skills/ppt-maker
npm ci --prefix scripts --ignore-scripts
node scripts/preflight.mjs
```

安装依赖会访问网络并写入 `scripts/node_modules/`，Agent 应先取得用户许可。Skill 不会静默安装依赖。

## 脚本快速测试

```bash
cd skills/ppt-maker
node scripts/build-pptx.mjs \
  --input scripts/example-deck.json \
  --output scripts/output/example.pptx
```

完整的输入 JSON 说明见 `skills/ppt-maker/references/PptxGenJS脚本使用说明.md`。

## License

本仓库自行编写的代码和文档采用 [MIT License](LICENSE)。第三方软件、字体和品牌资产适用各自的许可证或权利声明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
