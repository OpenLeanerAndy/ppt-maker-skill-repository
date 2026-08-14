# PptxGenJS 脚本使用说明

本说明只适用于当前 Agent 没有现成 PPT 制作能力时的降级方案。若 Agent 已具备可靠的 `.pptx` 创建、编辑和验证能力，应优先使用该能力。

## 环境要求

- Node.js 18 或更高版本。
- PptxGenJS 4.0.1。依赖声明位于 `scripts/package.json`。
- PowerPoint、LibreOffice 或 WPS 不是生成文件的必需条件，但至少具备其中一种时才能完成页面渲染和视觉验收。

安装依赖会访问网络并写入 `scripts/node_modules/`。Agent 必须先获得用户许可，再在本 Skill 根目录执行：

```bash
npm ci --prefix scripts --ignore-scripts
```

安装完成后不要把 `node_modules/` 提交到 Git 仓库。

## 标准调用流程

以下命令默认在本 Skill 根目录执行；也可以把脚本路径替换为绝对路径。

1. 检查 Node.js、PptxGenJS、默认素材和可选渲染器：

```bash
node scripts/preflight.mjs
```

2. 复制 `scripts/example-deck.json`，按照已确认的大纲填充内容，然后生成 PPTX：

```bash
node scripts/build-pptx.mjs --input scripts/example-deck.json --output output/example.pptx
```

3. 单独执行结构校验：

```bash
node scripts/validate-pptx.mjs output/example.pptx --expected-slides 7
```

上述脚本均支持 `--json`，用于让 Agent 获取结构化执行结果。`build-pptx.mjs` 默认会自动运行结构校验；只有诊断场景才应使用 `--no-validate`。

## 输入 JSON 顶层字段

| 字段 | 必需 | 说明 |
|---|---:|---|
| `title` | 是 | 演示文稿总标题，也是未指定输出路径时的默认文件名。 |
| `slides` | 是 | 非空页面数组，按数组顺序生成。 |
| `department` | 否 | 标题页部门或汇报单位。 |
| `date` | 否 | 标题页日期。 |
| `author`、`company`、`subject` | 否 | 写入 PPTX 文档属性。 |
| `lang` | 否 | 文档语言，默认 `zh-CN`。 |
| `logo` | 否 | Logo 路径；默认 `assets/logo.png`。设为 `false` 可关闭所有页面 Logo。 |
| `agenda` | 否 | 目录项字符串数组，供 `agenda` 和 `section` 页面使用。 |
| `theme` | 否 | 字体和颜色覆盖项。 |

相对素材路径首先相对于输入 JSON 所在目录解析，其次相对于 Skill 根目录解析。脚本拒绝远程图片 URL；若需要网络图片，应先在获得许可后下载到本地，再写入 JSON。

## 页面类型

### `title`

标题页。可提供 `title`、`department` 和 `date`；缺省时使用顶层同名字段。

### `agenda`

目录页。可提供 `heading` 和 `items`。`items` 缺省时使用顶层 `agenda`。

### `section`

章节过渡页。提供从零开始的 `current`，高亮顶层 `agenda` 中的对应章节；也可在没有目录项时使用 `title` 显示独立章节标题。

### `content`

模块化内容页。必需字段为 `modules`；可选字段包括：

- `title`：页面标题。
- `summary`：标题下方的一句话结论。
- `columns`：模块列数，范围 1–4；缺省时根据模块数量自动计算。
- `gap`：模块间距，单位为英寸。

每个模块至少应有 `title` 和内容。内容可以写在 `blocks` 数组中，也可以使用 `body`、`bullets`、`metrics`、`table`、`chart`、`image` 等简写字段。

### `table`

独立表格页。提供 `title`、可选的 `summary`，以及 `table` 对象。

### `closing`

结束页。可提供 `title` 和 `subtitle`。

## 内容块类型

| `type` | 关键字段 | 说明 |
|---|---|---|
| `text` | `text` | 普通段落。 |
| `bullets` | `items` | 项目符号数组；每项可为字符串，或带 `text`、`level` 的对象。 |
| `metrics` | `items` | 指标卡数组；每项支持 `value`、`unit`、`label`、`color`。 |
| `table` | `headers`、`rows` | 可选 `colWidths`；每行列数必须等于表头列数。 |
| `chart` | `chartType`、`series` | 支持 `bar`、`column`、`line`、`pie`、`doughnut`。 |
| `image` | `path` | 可选 `altText`；25 MB 内的 PNG、JPEG、GIF 会校验文件签名并按原始比例适配。 |

图表的每个 `series` 必须使用 PptxGenJS 数据结构：

```json
{
  "name": "完成量",
  "labels": ["Q1", "Q2", "Q3", "Q4"],
  "values": [62, 78, 91, 108]
}
```

## 验收边界

`validate-pptx.mjs` 检查 ZIP/OOXML 文件结构、必要条目、页面关系和页数，不能证明页面没有文字溢出、遮挡或视觉问题。正式交付前仍须使用 PowerPoint、LibreOffice 或 WPS 把所有页面渲染为图片，并逐页进行视觉检查。

脚本不会自动安装依赖、下载网络素材、修改系统字体或调用外部服务；这些动作都必须单独获得用户授权。

## 依赖安全说明

截至 2026-08-14，PptxGenJS 4.0.1 间接依赖的 `image-size` 对 ICNS、JXL 和 HEIF 解析存在拒绝服务公告，npm 尚未提供已修复版本。当前脚本不接受这些格式，只允许 25 MB 内、文件签名有效的 PNG、JPEG 和 GIF，从调用路径上避免触发受影响的解析器。不要删除或绕过 `addImageContained` 中的格式、大小和文件签名检查。公告详情见 [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) 与 [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)。
