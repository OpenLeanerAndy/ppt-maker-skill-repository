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

需要确认Windows上的PowerPoint COM确实可调用时，在获得运行外部应用所需许可后执行：

```bash
node scripts/preflight.mjs --probe-renderer
```

2. 复制 `scripts/example-deck.json`，按照已确认的大纲和`sourceManifest`填充内容。禁止把正文拼接进临时Python/JavaScript源码；必须直接编辑或序列化UTF-8 JSON。

3. 生成前执行内容保真审计：

```bash
node scripts/audit-deck.mjs --input scripts/example-deck.json
```

4. 审计通过后生成 PPTX：

```bash
node scripts/build-pptx.mjs --input scripts/example-deck.json --output output/example.pptx
```

5. 单独执行结构校验：

```bash
node scripts/validate-pptx.mjs output/example.pptx --expected-slides 7
```

6. 将全部页面渲染为PNG；输出目录必须为空：

```bash
node scripts/render-pptx.mjs --input output/example.pptx --output output/rendered
```

上述脚本均支持 `--json`，用于让 Agent 获取结构化执行结果。`build-pptx.mjs` 默认会自动运行结构校验；只有诊断场景才应使用 `--no-validate`。

## 输入 JSON 顶层字段

| 字段 | 必需 | 说明 |
|---|---:|---|
| `title` | 是 | 演示文稿总标题，也是未指定输出路径时的默认文件名。 |
| `slides` | 是 | 非空页面数组，按数组顺序生成。 |
| `sourceManifest` | 是 | 源文件、必需文字、表格和媒体清单，用于生成前保真审计。 |
| `department` | 否 | 标题页部门或汇报单位。 |
| `date` | 否 | 标题页日期。 |
| `author`、`company`、`subject` | 否 | 写入 PPTX 文档属性。 |
| `lang` | 否 | 文档语言，默认 `zh-CN`。 |
| `logo` | 否 | Logo 路径；默认 `assets/logo.png`。设为 `false` 可关闭所有页面 Logo。 |
| `agenda` | 否 | 目录项字符串数组，供 `agenda` 和 `section` 页面使用。 |
| `theme` | 否 | 字体和颜色覆盖项。 |

相对素材路径首先相对于输入 JSON 所在目录解析，其次相对于 Skill 根目录解析。脚本拒绝远程图片 URL；若需要网络图片，应先在获得许可后下载到本地，再写入 JSON。

## `sourceManifest`

```json
{
  "sourceManifest": {
    "sources": [{"id": "source-1", "path": "source.docx", "sha256": "可选"}],
    "sections": [{"id": "section-1", "title": "一级标题原文"}],
    "textItems": [{"id": "text-1", "text": "必须原样保留的文字"}],
    "tables": [{
      "id": "table-1",
      "bodyRows": 12,
      "logicalColumns": 6,
      "headerRowCount": 3,
      "rowHeaderColumns": 2,
      "headerRowsData": [
        [{"text":"类别","rowspan":3},{"text":"指标","rowspan":3},{"text":"业务部门","colspan":4}],
        [{"text":"部门A","colspan":2},{"text":"部门B","colspan":2}],
        ["目标","已完成","目标","已完成"]
      ],
      "bodyRowsData": [["分类1","指标1","10","8","12","11"]]
    }],
    "media": [{"id": "image-1", "path": "extracted/image1.png"}],
    "contentGroups": [{"id": "group-1", "sourceOrder": 1, "keepTogether": true, "preferredFlow": "single-column"}]
  }
}
```

目录项、页面、模块或内容块使用`sourceRef`或`sourceRefs`引用清单条目。内容页还必须使用`contentGroupRef`和`layoutFlow`声明语义组及阅读流。默认条目均为必需项；经用户确认可以省略时写入非空`omittedReason`。审计会拒绝：一级标题缺失、必需文字被改写、表格多级表头/二维矩阵/行列方向不符、未经确认分栏或拆页、必需媒体未使用、源文件不存在或SHA-256不一致。

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
- `columns`：模块列数，范围1–4；缺省时为1。只有大纲确认并列/对照关系时才显式设置为多列。
- `layoutFlow`：`single-column`、`multi-column`、`full-table`或`mixed`，必须与`sourceManifest.contentGroups[].preferredFlow`一致。
- `contentGroupRef`：该页对应的语义组；一个组默认只能出现于一页。
- `gap`：模块间距，单位为英寸。
- `visualExemptionReason`：仅当本页确为无稳定字段、无数值关系的纯叙述页时填写；非空时允许本页没有结构化内容块。

每个模块至少应有 `title` 和内容。内容可以写在 `blocks` 数组中，也可以使用 `body`、`bullets`、`metrics`、`matrix`、`callout`、`table`、`chart`、`image` 等简写字段。纯文字列表只有在[结构化表达.md](./结构化表达.md)允许时使用；单个模块确为同质叙述时填写非空 `plainListReason`。

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
| `matrix` | `items` | 事项/任务矩阵；每项支持 `title`、`body`、`meta`、`color`，可用 `columns` 指定1–4列。 |
| `callout` | `label`、`text` | 结论、风险或异常提示；`tone`支持`primary`、`danger`、`muted`。 |
| `table` | `headers`、`rows` | 可选 `colWidths`；每行列数必须等于表头列数。 |
| `chart` | `chartType`、`series` | 支持 `bar`、`column`、`line`、`pie`、`doughnut`。 |
| `image` | `path` | 可选 `altText`；25 MB 内的 PNG、JPEG、GIF 会校验文件签名并按原始比例适配。 |

示例：

```json
{
  "type": "matrix",
  "columns": 3,
  "items": [
    {"title": "任务A", "body": "保留完整行动说明", "meta": ["时间：6月", "状态：进行中"]},
    {"title": "任务B", "body": "保留完整行动说明"}
  ]
}
```

```json
{"type":"callout","label":"项目调整","text":"原文风险或调整说明","tone":"danger"}
```

## 表格输入和拆分

- 单行表头使用`headers`；多级表头使用`headerRows`。
- 单元格可以是字符串，也可以是`{"text":"标题","rowspan":2,"colspan":1}`。
- `colWidths`必须与逻辑列数一致。脚本会核对每个正文行的逻辑列数，禁止通过少写第一列或其他字段来适配页面。
- 脚本按列宽、文字长度、10号字和1.3倍行距估算行高。超高表格默认`splitMode: "none"`并报错，禁止生成阶段自动决定拆分。
- 只有大纲已确认拆分时，才能同时提供非空`splitReason`和`approvalRef`，并选择：
  - `splitMode: "rows-two-column"`：按正文行拆成左右两个表，重复完整多级表头和全部逻辑列；兼容旧值`columns`。
  - `splitMode: "paginate"`：仅用于独立表格页，按正文行生成连续页。
- 每个表格块必须声明`orientation: "source"`和`rowHeaderColumns`。不得使用转置或拆列解决容量问题。
- 脚本不会通过缩小到10号字以下、越过模块边框或删除数据来完成布局。

内容页默认按模块内容量分配行列尺寸。需要精确复合布局时，可给每个模块提供归一化`layout: {"x":0,"y":0,"w":0.6,"h":1}`；所有模块必须位于0–1的内容区域内且不得重叠。

图表的每个 `series` 必须使用 PptxGenJS 数据结构：

```json
{
  "name": "完成量",
  "labels": ["Q1", "Q2", "Q3", "Q4"],
  "values": [62, 78, 91, 108]
}
```

## 验收边界

`audit-deck.mjs`检查源内容清单、原文、表格多级表头与正文二维矩阵、媒体引用、内容组、阅读流和拆页依据。`validate-pptx.mjs`检查ZIP/OOXML、页面关系、对象外框，以及表格各行实际高度是否超出表格框或页面。形状模拟表格和模块语义边界仍必须通过全页渲染检查；不得把结构检查通过表述成视觉验收通过。

如果渲染失败，只能报告“内容和结构审计通过，视觉验收未完成”。不得用OOXML检查代替视觉验收，也不得为了继续任务而后台安装`python-pptx`或其他依赖。

脚本不会自动安装依赖、下载网络素材、修改系统字体或调用外部服务；这些动作都必须单独获得用户授权。

## 依赖安全说明

截至 2026-08-14，PptxGenJS 4.0.1 间接依赖的 `image-size` 对 ICNS、JXL 和 HEIF 解析存在拒绝服务公告，npm 尚未提供已修复版本。当前脚本不接受这些格式，只允许 25 MB 内、文件签名有效的 PNG、JPEG 和 GIF，从调用路径上避免触发受影响的解析器。不要删除或绕过 `addImageContained` 中的格式、大小和文件签名检查。公告详情见 [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) 与 [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)。
