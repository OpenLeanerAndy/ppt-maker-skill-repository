#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { auditDeckSpec, tableModel } from "./lib/deck-audit.mjs";
import { loadPptxGenJS, skillDir } from "./lib/pptxgen-loader.mjs";
import { validatePptx } from "./validate-pptx.mjs";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const BODY_FONT_SIZE = 10;
const BODY_LINE_SPACING = 1.3;
const MIN_BODY_ROW_HEIGHT = 0.24;
const DEFAULT_THEME = {
  fontFace: "Source Han Sans SC",
  colors: {
    primary: "0B2791",
    secondary: "009ADD",
    text: "262626",
    muted: "666666",
    pale: "EAEFF7",
    tableHeader: "4472C4",
    white: "FFFFFF",
    danger: "C00000",
  },
};

function parseArgs(argv) {
  const args = { input: null, output: null, validate: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input" || token === "-i") args.input = argv[++index];
    else if (token === "--output" || token === "-o") args.output = argv[++index];
    else if (token === "--no-validate") args.validate = false;
    else if (token === "--json") args.json = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.input) {
    throw new Error(
      "用法：node build-pptx.mjs --input deck.json [--output deck.pptx] [--no-validate] [--json]",
    );
  }
  return args;
}

function normalizeColor(value, fallback) {
  const normalized = String(value ?? fallback ?? "").replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) {
    throw new Error(`颜色必须为 6 位十六进制值：${value}`);
  }
  return normalized;
}

function makeTheme(theme = {}) {
  const mergedColors = { ...DEFAULT_THEME.colors, ...(theme.colors ?? {}) };
  for (const key of Object.keys(mergedColors)) {
    mergedColors[key] = normalizeColor(mergedColors[key], DEFAULT_THEME.colors[key]);
  }
  return {
    fontFace: theme.fontFace || DEFAULT_THEME.fontFace,
    colors: mergedColors,
  };
}

function sanitizeFilename(value) {
  return String(value || "presentation")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim() || "presentation";
}

function resolveAsset(assetPath, inputDir) {
  if (!assetPath) return null;
  if (/^https?:\/\//i.test(assetPath)) {
    throw new Error("不支持远程图片 URL；请在获得用户许可后先下载为本地 PNG、JPEG 或 GIF。 ");
  }
  if (path.isAbsolute(assetPath)) return assetPath;
  const candidates = [
    path.resolve(inputDir, assetPath),
    path.resolve(skillDir, assetPath),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function requireLocalAsset(assetPath, label) {
  if (!fs.existsSync(assetPath)) throw new Error(`${label}不存在：${assetPath}`);
}

function imageDimensions(filePath) {
  if (/^https?:\/\//i.test(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return { format: "gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { format: "jpeg", width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (size < 2) break;
      offset += size + 2;
    }
  }
  return null;
}

function containRect(dimensions, x, y, w, h) {
  if (!dimensions?.width || !dimensions?.height) return { x, y, w, h };
  const imageRatio = dimensions.width / dimensions.height;
  const boxRatio = w / h;
  if (imageRatio > boxRatio) {
    const fittedH = w / imageRatio;
    return { x, y: y + (h - fittedH) / 2, w, h: fittedH };
  }
  const fittedW = h * imageRatio;
  return { x: x + (w - fittedW) / 2, y, w: fittedW, h };
}

function validatedImageOptions(filePath, box, altText = "") {
  requireLocalAsset(filePath, "图片");
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`图片格式不受支持：${filePath}。仅允许 PNG、JPEG 和 GIF。`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`图片路径不是文件：${filePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 25 MB 安全上限：${filePath}`);
  }
  const dimensions = imageDimensions(filePath);
  if (!dimensions?.width || !dimensions?.height) {
    throw new Error(`图片内容与扩展名不匹配或文件已损坏：${filePath}`);
  }
  const expectedFormat = [".jpg", ".jpeg"].includes(extension) ? "jpeg" : extension.slice(1);
  if (dimensions.format !== expectedFormat) {
    throw new Error(`图片文件签名与扩展名不匹配：${filePath}`);
  }
  const fitted = containRect(dimensions, box.x, box.y, box.w, box.h);
  return { path: filePath, ...fitted, altText };
}

function addImageContained(slide, filePath, box, altText = "") {
  slide.addImage(validatedImageOptions(filePath, box, altText));
}

function addLogo(slide, context, mode = "content") {
  if (!context.logo || context.logoOnMaster) return;
  const box = mode === "title"
    ? { x: 9.9, y: 0.45, w: 2.75, h: 0.9 }
    : { x: 11.25, y: 0.18, w: 1.55, h: 0.52 };
  addImageContained(slide, context.logo, box, "Logo");
}

function defineLogoMasters(context) {
  const base = { background: { color: context.theme.colors.white }, margin: 0 };
  const contentObjects = context.logo
    ? [{ image: validatedImageOptions(context.logo, { x: 11.25, y: 0.18, w: 1.55, h: 0.52 }, "Logo") }]
    : [];
  const titleObjects = context.logo
    ? [{ image: validatedImageOptions(context.logo, { x: 9.9, y: 0.45, w: 2.75, h: 0.9 }, "Logo") }]
    : [];
  context.pptx.defineSlideMaster({ ...base, title: "PPT_MAKER_CONTENT", objects: contentObjects });
  context.pptx.defineSlideMaster({ ...base, title: "PPT_MAKER_TITLE", objects: titleObjects });
  context.logoOnMaster = Boolean(context.logo);
}

function addPageNumber(slide, context, pageNumber) {
  slide.addText(String(pageNumber), {
    x: 12.25,
    y: 7.03,
    w: 0.45,
    h: 0.2,
    margin: 0,
    fontFace: context.theme.fontFace,
    fontSize: 10,
    color: context.theme.colors.text,
    align: "right",
  });
}

function addHeader(slide, context, title, pageNumber) {
  const { colors, fontFace } = context.theme;
  assertTextFits(title, { w: 10.35, h: 0.48 }, "页面标题", 24, 0);
  slide.addText(title, {
    x: 0.6,
    y: 0.28,
    w: 10.35,
    h: 0.48,
    margin: 0,
    fontFace,
    fontSize: 24,
    bold: true,
    color: colors.text,
    valign: "middle",
  });
  slide.addShape(context.pptx.ShapeType.line, {
    x: 0.6,
    y: 0.92,
    w: 11.95,
    h: 0,
    line: { color: colors.secondary, width: 1.25 },
  });
  addLogo(slide, context, "content");
  addPageNumber(slide, context, pageNumber);
}

function addTitleSlide(slide, context, spec) {
  const { colors, fontFace } = context.theme;
  slide.background = { color: colors.white };
  addLogo(slide, context, "title");
  slide.addShape(context.pptx.ShapeType.line, {
    x: 1.65, y: 2.02, w: 0, h: 3.05,
    line: { color: colors.primary, width: 1.5 },
  });
  slide.addShape(context.pptx.ShapeType.line, {
    x: 1.75, y: 2.02, w: 0, h: 3.05,
    line: { color: colors.secondary, width: 1.5 },
  });
  slide.addText(spec.title || context.deck.title, {
    x: 2.1, y: 2.02, w: 8.95, h: 1.5,
    margin: 0, fontFace, fontSize: 34, bold: true,
    color: colors.primary, align: "center", valign: "middle", fit: "shrink",
  });
  const detail = [spec.department ?? context.deck.department, spec.date ?? context.deck.date]
    .filter(Boolean)
    .join("\n");
  if (detail) {
    slide.addText(detail, {
      x: 2.1, y: 3.95, w: 8.95, h: 0.85,
      margin: 0, fontFace, fontSize: 14, bold: false,
      color: colors.text, align: "center", valign: "middle", breakLine: false,
    });
  }
}

function agendaItems(spec, context) {
  return spec.items ?? context.deck.agenda ?? [];
}

function addAgendaSlide(slide, context, spec, pageNumber, isSection = false) {
  const { colors, fontFace } = context.theme;
  slide.background = { color: colors.white };
  slide.addText(spec.heading || "目录", {
    x: 0.72, y: 0.45, w: 2, h: 0.5,
    margin: 0, fontFace, fontSize: 24, bold: true, color: colors.primary,
  });
  slide.addShape(context.pptx.ShapeType.line, {
    x: 0.72, y: 1.13, w: 10.2, h: 0,
    line: { color: colors.primary, width: 2 },
  });
  slide.addShape(context.pptx.ShapeType.line, {
    x: 10.92, y: 1.13, w: 1.15, h: 0,
    line: { color: colors.secondary, width: 2 },
  });
  addLogo(slide, context, "content");
  const items = agendaItems(spec, context);
  if (items.length === 0 && isSection) {
    slide.addText(spec.title || "章节", {
      x: 2.35, y: 2.25, w: 8.7, h: 2.25,
      margin: 0, fontFace, fontSize: 34, bold: true,
      color: colors.primary, align: "center", valign: "middle", fit: "shrink",
    });
  } else {
    const current = Number.isInteger(spec.current) ? spec.current : -1;
    const rowH = Math.min(0.78, 4.9 / Math.max(items.length, 1));
    items.forEach((item, index) => {
      const active = !isSection || index === current;
      const label = typeof item === "string" ? item : item.title;
      const prefix = typeof item === "object" && item.index
        ? item.index
        : `${index + 1}`.padStart(2, "0");
      const y = 1.65 + index * rowH;
      slide.addText(prefix, {
        x: 3.0, y, w: 0.7, h: rowH - 0.08,
        margin: 0, fontFace, fontSize: 14, bold: true,
        color: active ? colors.primary : colors.muted, valign: "middle",
      });
      slide.addText(label, {
        x: 3.85, y, w: 6.9, h: rowH - 0.08,
        margin: 0, fontFace, fontSize: 24, bold: active,
        color: active ? colors.text : colors.muted, valign: "middle", fit: "shrink",
      });
    });
  }
  addPageNumber(slide, context, pageNumber);
}

function normalizeBlocks(module) {
  if (Array.isArray(module.blocks) && module.blocks.length > 0) return module.blocks;
  const blocks = [];
  if (module.body) blocks.push({ type: "text", text: module.body });
  if (module.bullets?.length) blocks.push({ type: "bullets", items: module.bullets });
  if (module.metrics?.length) blocks.push({ type: "metrics", items: module.metrics });
  if (module.table) blocks.push({ type: "table", ...module.table });
  if (module.chart) blocks.push({ type: "chart", ...module.chart });
  if (module.image) blocks.push({ type: "image", ...(typeof module.image === "string" ? { path: module.image } : module.image) });
  return blocks;
}

function blockWeight(block) {
  if (Number.isFinite(block.weight) && block.weight > 0) return block.weight;
  if (block.type === "metrics") return 1.1;
  if (block.type === "image" || block.type === "chart") return 2.1;
  if (block.type === "table") return Math.max(1.5, ((block.rows?.length ?? 2) + 1) * 0.34);
  if (block.type === "bullets") return Math.max(1, (block.items ?? []).join("").length / 90);
  return Math.max(1, String(block.text ?? "").length / 120);
}

function displayUnits(value) {
  let units = 0;
  for (const character of String(value ?? "")) {
    if (character === "\n") continue;
    if (/\s/.test(character)) units += 0.35;
    else if (character.codePointAt(0) > 0xff) units += 1;
    else if (/[A-Z0-9]/.test(character)) units += 0.62;
    else units += 0.52;
  }
  return units;
}

function estimatedWrappedLines(value, width, fontSize = BODY_FONT_SIZE) {
  const glyphWidth = (fontSize / 72) * 0.92;
  const capacity = Math.max(1, (width - 0.12) / glyphWidth);
  return String(value ?? "").split(/\r?\n/).reduce(
    (sum, paragraph) => sum + Math.max(1, Math.ceil(displayUnits(paragraph) / capacity)),
    0,
  );
}

function estimatedTextHeight(value, width, fontSize = BODY_FONT_SIZE, margin = 0.06) {
  const lineHeight = (fontSize / 72) * BODY_LINE_SPACING;
  return estimatedWrappedLines(value, width - margin * 2, fontSize) * lineHeight + margin * 2 + 0.04;
}

function assertTextFits(value, box, label, fontSize = BODY_FONT_SIZE, margin = 0.06) {
  const required = estimatedTextHeight(value, box.w, fontSize, margin);
  if (required > box.h + 0.02) {
    throw new Error(
      `${label}预计需要 ${required.toFixed(2)} 英寸高度，但区域只有 ${box.h.toFixed(2)} 英寸；请增加区域、拆分模块或分页，不得缩小字号或让文字越界。`,
    );
  }
}

function layoutBlocks(blocks, box) {
  const gap = 0.1;
  const available = box.h - gap * Math.max(0, blocks.length - 1);
  const weights = blocks.map(blockWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = box.y;
  return blocks.map((block, index) => {
    const h = index === blocks.length - 1
      ? box.y + box.h - cursor
      : available * (weights[index] / totalWeight);
    const placement = { block, x: box.x, y: cursor, w: box.w, h };
    cursor += h + gap;
    return placement;
  });
}

function addTextBlock(slide, context, block, box) {
  const value = String(block.text ?? "");
  assertTextFits(value, box, "正文文本");
  slide.addText(String(block.text ?? ""), {
    x: box.x, y: box.y, w: box.w, h: box.h,
    margin: 0.06, fontFace: context.theme.fontFace,
    fontSize: BODY_FONT_SIZE, color: context.theme.colors.text,
    valign: "top", breakLine: false,
    paraSpaceAfterPt: 3,
  });
}

function addBulletsBlock(slide, context, block, box) {
  const plainText = (block.items ?? [])
    .map((item) => (typeof item === "string" ? item : item?.text ?? ""))
    .join("\n");
  assertTextFits(plainText, box, "项目符号文本");
  const items = (block.items ?? []).map((item, index, array) => ({
    text: typeof item === "string" ? item : item.text,
    options: {
      bullet: { indent: 12 },
      hanging: 3,
      breakLine: index < array.length - 1,
      paraSpaceAfterPt: 3,
      ...(typeof item === "object" && Number.isInteger(item.level)
        ? { indentLevel: item.level }
        : {}),
    },
  }));
  slide.addText(items, {
    x: box.x, y: box.y, w: box.w, h: box.h,
    margin: 0.06, fontFace: context.theme.fontFace,
    fontSize: BODY_FONT_SIZE, color: context.theme.colors.text,
    valign: "top",
  });
}

function addMetricsBlock(slide, context, block, box) {
  const items = block.items ?? [];
  if (items.length === 0) return;
  const gap = 0.1;
  const cardW = (box.w - gap * (items.length - 1)) / items.length;
  items.forEach((item, index) => {
    const x = box.x + index * (cardW + gap);
    slide.addShape(context.pptx.ShapeType.rect, {
      x, y: box.y, w: cardW, h: box.h,
      fill: { color: context.theme.colors.white },
      line: { color: context.theme.colors.secondary, width: 0.75 },
    });
    slide.addText(String(item.value ?? ""), {
      x: x + 0.04, y: box.y + 0.08, w: cardW - 0.08, h: box.h * 0.52,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 24, bold: true,
      color: normalizeColor(item.color, context.theme.colors.primary),
      align: "center", valign: "middle", fit: "shrink",
    });
    slide.addText([item.unit, item.label].filter(Boolean).join("\n"), {
      x: x + 0.06, y: box.y + box.h * 0.58, w: cardW - 0.12, h: box.h * 0.31,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 10, bold: true,
      color: context.theme.colors.text, align: "center", valign: "middle", fit: "shrink",
    });
  });
}

function numericValue(value) {
  return typeof value === "number" || /^[-+]?\d[\d,.]*(%|万|亿|元)?$/.test(String(value).trim());
}

function tableCellText(cell) {
  return cell && typeof cell === "object" && !Array.isArray(cell)
    ? String(cell.text ?? "")
    : String(cell ?? "");
}

function tableCellSpan(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return 1;
  const span = Number(cell.colspan ?? cell.options?.colspan ?? 1);
  return Number.isInteger(span) && span > 0 ? span : 1;
}

function styleTableCell(cell, context, { header, rowIndex }) {
  const value = tableCellText(cell);
  const provided = cell && typeof cell === "object" && !Array.isArray(cell) ? cell : {};
  const options = {
    ...(header
      ? {
        bold: true,
        color: context.theme.colors.white,
        fill: { color: context.theme.colors.tableHeader },
        align: "center",
      }
      : {
        color: context.theme.colors.text,
        fill: { color: rowIndex % 2 === 0 ? context.theme.colors.pale : "F5F7FB" },
        align: numericValue(value) ? "right" : "left",
      }),
    ...(provided.options ?? {}),
  };
  for (const key of ["colspan", "rowspan"]) {
    const raw = provided[key] ?? provided.options?.[key];
    if (Number.isInteger(Number(raw)) && Number(raw) > 1) options[key] = Number(raw);
  }
  return { text: value, options };
}

function normalizeColumnWidths(block, columnCount, width) {
  if (block.colWidths !== undefined && (!Array.isArray(block.colWidths) || block.colWidths.length !== columnCount)) {
    throw new Error(`表格 colWidths 必须包含 ${columnCount} 个宽度值，不得通过少给一列来隐藏字段。`);
  }
  const raw = block.colWidths?.map(Number) ?? Array(columnCount).fill(1);
  if (raw.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("表格 colWidths 必须全部为正数。 ");
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => (value / total) * width);
}

function estimateTableRowHeight(row, widths, { header = false } = {}) {
  let column = 0;
  let lines = 1;
  for (const cell of row) {
    const span = tableCellSpan(cell);
    const cellWidth = widths.slice(column, column + span).reduce((sum, value) => sum + value, 0);
    lines = Math.max(lines, estimatedWrappedLines(tableCellText(cell), Math.max(0.2, cellWidth - 0.07), BODY_FONT_SIZE));
    column += span;
  }
  const lineHeight = (BODY_FONT_SIZE / 72) * BODY_LINE_SPACING;
  return Math.max(header ? 0.31 : MIN_BODY_ROW_HEIGHT, lines * lineHeight + 0.10);
}

function renderTable(slide, context, headerRows, bodyRows, box, widths) {
  const data = [
    ...headerRows.map((row) => row.map((cell) => styleTableCell(cell, context, { header: true, rowIndex: 0 }))),
    ...bodyRows.map((row, rowIndex) => row.map((cell) => styleTableCell(cell, context, { header: false, rowIndex }))),
  ];
  const rowHeights = [
    ...headerRows.map((row) => estimateTableRowHeight(row, widths, { header: true })),
    ...bodyRows.map((row) => estimateTableRowHeight(row, widths)),
  ];
  const height = rowHeights.reduce((sum, value) => sum + value, 0);
  if (height > box.h + 0.02) throw new Error("内部错误：表格分段后仍超过目标区域。 ");
  slide.addTable(data, {
    x: box.x, y: box.y, w: box.w, h: height,
    colW: widths,
    rowH: rowHeights,
    margin: 0.035,
    fontFace: context.theme.fontFace,
    fontSize: BODY_FONT_SIZE,
    border: { type: "solid", color: context.theme.colors.white, pt: 0.5 },
    autoFit: false,
    autoPage: false,
    valign: "middle",
  });
}

function splitRowsByHeight(rows, widths, headerRows, height) {
  const headerHeight = headerRows.reduce((sum, row) => sum + estimateTableRowHeight(row, widths, { header: true }), 0);
  if (headerHeight >= height) throw new Error("表格多级表头本身已超过目标区域高度。 ");
  const capacity = height - headerHeight;
  const rowHeights = rows.map((row) => estimateTableRowHeight(row, widths));
  for (const rowHeight of rowHeights) {
    if (headerHeight + rowHeight > height) {
      throw new Error("表格存在单行内容过长，无法在10号字下完整显示；请加宽长文本列或把该记录改为独立页面。 ");
    }
  }
  const total = rowHeights.reduce((sum, value) => sum + value, 0);
  if (total > capacity * 2 + 0.02) return { segments: null, required: Math.ceil(total / capacity) };
  let leftHeight = 0;
  let best = null;
  for (let index = 1; index < rows.length; index += 1) {
    leftHeight += rowHeights[index - 1];
    const rightHeight = total - leftHeight;
    if (leftHeight <= capacity + 0.02 && rightHeight <= capacity + 0.02) {
      const difference = Math.abs(leftHeight - rightHeight);
      if (!best || difference < best.difference) best = { index, difference };
    }
  }
  if (!best) return { segments: null, required: 3 };
  return { segments: [rows.slice(0, best.index), rows.slice(best.index)], required: 2 };
}

function addTableBlock(slide, context, block, box) {
  const headerRows = tableModel.tableHeaderRows(block);
  const rows = Array.isArray(block.rows) ? block.rows : [];
  if (headerRows.length === 0) throw new Error("表格必须包含 headers 或 headerRows。 ");
  if (headerRows.length > 3) throw new Error("表格最多支持3行多级表头；请先核对源表结构。 ");
  const columnCount = tableModel.tableColumns(block);
  if (columnCount === 0) throw new Error("表格没有可识别的列。 ");
  for (const [index, row] of rows.entries()) {
    if (tableModel.logicalColumns(row) !== columnCount) {
      throw new Error(`表格正文第 ${index + 1} 行为 ${tableModel.logicalColumns(row)} 列，表格应为 ${columnCount} 列；不得删除最左列或其他字段。`);
    }
  }

  const widths = normalizeColumnWidths(block, columnCount, box.w);
  const totalHeight = [...headerRows.map((row) => estimateTableRowHeight(row, widths, { header: true })), ...rows.map((row) => estimateTableRowHeight(row, widths))]
    .reduce((sum, value) => sum + value, 0);
  if (totalHeight <= box.h + 0.02) {
    renderTable(slide, context, headerRows, rows, box, widths);
    return;
  }

  const splitMode = String(block.splitMode ?? "auto").toLowerCase();
  if (!["auto", "columns", "none"].includes(splitMode)) throw new Error(`不支持的表格 splitMode：${splitMode}`);
  if (splitMode === "none") {
    throw new Error(`表格预计需要 ${totalHeight.toFixed(2)} 英寸高度，但区域只有 ${box.h.toFixed(2)} 英寸；必须拆分，不得越过模块或页面边界。`);
  }
  if (columnCount > Number(block.maxColumnsForSideSplit ?? 6) || box.w < 8) {
    throw new Error(`表格有 ${columnCount} 列且纵向超高，不适合左右并排；请在大纲阶段拆成连续页面，每页保留全部列和重复表头。`);
  }

  const gap = Number.isFinite(block.splitGap) ? block.splitGap : 0.16;
  const segmentWidth = (box.w - gap) / 2;
  const segmentWidths = normalizeColumnWidths(block, columnCount, segmentWidth);
  const split = splitRowsByHeight(rows, segmentWidths, headerRows, box.h);
  if (!split.segments) {
    throw new Error(`表格在10号字下至少需要 ${split.required} 个纵向分段；当前页面只允许左右两个表格，请拆成连续页面。`);
  }
  const segments = split.segments;
  renderTable(slide, context, headerRows, segments[0], { ...box, w: segmentWidth }, segmentWidths);
  renderTable(slide, context, headerRows, segments[1], { ...box, x: box.x + segmentWidth + gap, w: segmentWidth }, segmentWidths);
}

function addChartBlock(slide, context, block, box) {
  const type = String(block.chartType ?? block.kind ?? "bar").toLowerCase();
  const typeMap = {
    bar: context.pptx.ChartType.bar,
    column: context.pptx.ChartType.bar,
    line: context.pptx.ChartType.line,
    pie: context.pptx.ChartType.pie,
    doughnut: context.pptx.ChartType.doughnut,
  };
  if (!typeMap[type]) throw new Error(`不支持的图表类型：${type}`);
  const series = block.series ?? [];
  if (series.length === 0) throw new Error("图表必须包含 series。 ");
  const options = {
    x: box.x, y: box.y, w: box.w, h: box.h,
    fontFace: context.theme.fontFace,
    fontSize: 10,
    showLegend: block.showLegend ?? series.length > 1,
    legendPos: block.legendPos ?? "b",
    showTitle: Boolean(block.title),
    title: block.title,
    chartColors: (block.colors ?? [context.theme.colors.primary, context.theme.colors.secondary, "7EA6E0"])
      .map((color) => normalizeColor(color)),
    showValue: block.showValue ?? true,
    showPercent: block.showPercent ?? ["pie", "doughnut"].includes(type),
    showCatName: block.showCatName ?? false,
    catAxisLabelColor: context.theme.colors.muted,
    valAxisLabelColor: context.theme.colors.muted,
    valGridLine: { color: "D9E2F3", size: 0.5 },
    showBorder: false,
  };
  if (type === "bar" || type === "column") options.barDir = type === "bar" ? "bar" : "col";
  if (type === "line") options.lineSize = block.lineSize ?? 2;
  slide.addChart(typeMap[type], series, options);
}

function addImageBlock(slide, context, block, box) {
  const filePath = resolveAsset(block.path, context.inputDir);
  if (!filePath) throw new Error("图片块必须包含 path。 ");
  addImageContained(slide, filePath, box, block.altText ?? "演示文稿图片");
}

function renderBlock(slide, context, placement) {
  const { block, ...box } = placement;
  const type = String(block.type ?? "text").toLowerCase();
  if (type === "text") addTextBlock(slide, context, block, box);
  else if (type === "bullets") addBulletsBlock(slide, context, block, box);
  else if (type === "metrics") addMetricsBlock(slide, context, block, box);
  else if (type === "table") addTableBlock(slide, context, block, box);
  else if (type === "chart") addChartBlock(slide, context, block, box);
  else if (type === "image") addImageBlock(slide, context, block, box);
  else throw new Error(`不支持的内容块类型：${type}`);
}

function addModule(slide, context, module, box) {
  const { colors, fontFace } = context.theme;
  const titleH = 0.38;
  assertTextFits(module.title || "", { w: box.w - 0.1, h: titleH - 0.06 }, "模块标题", 14, 0);
  slide.addShape(context.pptx.ShapeType.rect, {
    x: box.x, y: box.y, w: box.w, h: titleH,
    fill: { color: normalizeColor(module.titleColor, colors.primary) },
    line: { color: normalizeColor(module.titleColor, colors.primary), width: 0.5 },
  });
  slide.addText(module.title || "", {
    x: box.x + 0.05, y: box.y + 0.03, w: box.w - 0.1, h: titleH - 0.06,
    margin: 0, fontFace, fontSize: 14, bold: true,
    color: colors.white, align: "center", valign: "middle",
  });
  slide.addShape(context.pptx.ShapeType.rect, {
    x: box.x, y: box.y + titleH, w: box.w, h: box.h - titleH,
    fill: { color: colors.white, transparency: 100 },
    line: { color: colors.secondary, width: 0.75 },
  });
  const inner = {
    x: box.x + 0.12,
    y: box.y + titleH + 0.11,
    w: box.w - 0.24,
    h: box.h - titleH - 0.22,
  };
  const blocks = normalizeBlocks(module);
  layoutBlocks(blocks, inner).forEach((placement) => renderBlock(slide, context, placement));
}

function gridColumns(count, requested) {
  if (Number.isInteger(requested) && requested >= 1 && requested <= 4) return requested;
  if (count <= 1) return 1;
  if (count <= 3) return count;
  if (count === 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

function normalizedSegments(weights, start, length, gap) {
  if (weights.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("布局权重必须全部为正数。 ");
  const available = length - gap * Math.max(0, weights.length - 1);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = start;
  return weights.map((weight) => {
    const size = available * (weight / total);
    const segment = { start: cursor, size };
    cursor += size + gap;
    return segment;
  });
}

function moduleContentWeight(module) {
  return Math.max(1, normalizeBlocks(module).reduce((sum, block) => sum + blockWeight(block), 0));
}

function explicitModuleLayout(modules, area) {
  if (!modules.some((module) => module.layout)) return null;
  if (!modules.every((module) => module.layout)) throw new Error("使用 module.layout 时，每个模块都必须提供归一化 x、y、w、h。 ");
  const boxes = modules.map((module, index) => {
    const layout = module.layout;
    for (const key of ["x", "y", "w", "h"]) {
      if (!Number.isFinite(layout[key])) throw new Error(`第 ${index + 1} 个模块的 layout.${key} 必须是数字。`);
    }
    if (layout.x < 0 || layout.y < 0 || layout.w <= 0 || layout.h <= 0 || layout.x + layout.w > 1 || layout.y + layout.h > 1) {
      throw new Error(`第 ${index + 1} 个模块的 layout 必须完整位于 0–1 的内容区域内。`);
    }
    return { x: area.x + layout.x * area.w, y: area.y + layout.y * area.h, w: layout.w * area.w, h: layout.h * area.h };
  });
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left];
      const b = boxes[right];
      const overlap = a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.h - 0.01 && a.y + a.h > b.y + 0.01;
      if (overlap) throw new Error(`第 ${left + 1} 与第 ${right + 1} 个模块的显式布局发生重叠。`);
    }
  }
  return boxes;
}

function addContentSlide(slide, context, spec, pageNumber) {
  addHeader(slide, context, spec.title || `第 ${pageNumber} 页`, pageNumber);
  const hasSummary = Boolean(spec.summary);
  if (hasSummary) {
    slide.addShape(context.pptx.ShapeType.rect, {
      x: 0.6, y: 1.12, w: 12.1, h: 0.68,
      fill: { color: context.theme.colors.white },
      line: { color: context.theme.colors.secondary, width: 0.8 },
    });
    assertTextFits(spec.summary, { w: 11.75, h: 0.4 }, "页面总述", 14, 0);
    slide.addText(spec.summary, {
      x: 0.78, y: 1.25, w: 11.75, h: 0.4,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 14, bold: true,
      color: context.theme.colors.text, valign: "middle",
    });
  }
  const modules = spec.modules ?? [];
  if (modules.length === 0) throw new Error(`内容页“${spec.title}”没有 modules。`);
  if (modules.length > 8) throw new Error(`内容页“${spec.title}”最多支持 8 个模块。`);
  const area = { x: 0.6, y: hasSummary ? 1.98 : 1.15, w: 12.1, h: hasSummary ? 4.85 : 5.68 };
  const gap = Number.isFinite(spec.gap) ? spec.gap : 0.16;
  const explicitBoxes = explicitModuleLayout(modules, area);
  if (explicitBoxes) {
    modules.forEach((module, index) => addModule(slide, context, module, explicitBoxes[index]));
    return;
  }
  const columns = gridColumns(modules.length, spec.columns);
  const rows = Math.ceil(modules.length / columns);
  const weights = modules.map(moduleContentWeight);
  const columnWeights = Array.isArray(spec.columnWeights)
    ? spec.columnWeights.map(Number)
    : Array.from({ length: columns }, (_, column) => Math.max(...weights.filter((_, index) => index % columns === column), 1));
  const rowWeights = Array.isArray(spec.rowWeights)
    ? spec.rowWeights.map(Number)
    : Array.from({ length: rows }, (_, row) => Math.max(...weights.slice(row * columns, (row + 1) * columns), 1));
  if (columnWeights.length !== columns) throw new Error(`columnWeights 必须包含 ${columns} 个值。`);
  if (rowWeights.length !== rows) throw new Error(`rowWeights 必须包含 ${rows} 个值。`);
  const columnSegments = normalizedSegments(columnWeights, area.x, area.w, gap);
  const rowSegments = normalizedSegments(rowWeights, area.y, area.h, gap);
  modules.forEach((module, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    addModule(slide, context, module, {
      x: columnSegments[column].start,
      y: rowSegments[row].start,
      w: columnSegments[column].size,
      h: rowSegments[row].size,
    });
  });
}

function addTableSlide(slide, context, spec, pageNumber) {
  addHeader(slide, context, spec.title || "表格", pageNumber);
  if (spec.summary) {
    assertTextFits(spec.summary, { w: 12.1, h: 0.48 }, "表格页总述", 14, 0);
    slide.addText(spec.summary, {
      x: 0.6, y: 1.12, w: 12.1, h: 0.48,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 14, bold: true,
      color: context.theme.colors.text,
    });
  }
  addTableBlock(slide, context, spec.table ?? spec, {
    x: 0.6, y: spec.summary ? 1.72 : 1.2, w: 12.1, h: spec.summary ? 5.15 : 5.67,
  });
}

function paginateTableRows(block, box) {
  const headerRows = tableModel.tableHeaderRows(block);
  const columnCount = tableModel.tableColumns(block);
  const widths = normalizeColumnWidths(block, columnCount, box.w);
  const headerHeight = headerRows.reduce((sum, row) => sum + estimateTableRowHeight(row, widths, { header: true }), 0);
  if (headerHeight >= box.h) throw new Error("表格表头超过独立表格页的可用高度。 ");
  const chunks = [];
  let current = [];
  let used = headerHeight;
  for (const row of block.rows ?? []) {
    const rowHeight = estimateTableRowHeight(row, widths);
    if (headerHeight + rowHeight > box.h) {
      throw new Error("表格存在单行内容过长，无法在独立表格页以10号字完整显示；请加宽长文本列或把该记录改为独立内容页。 ");
    }
    if (current.length > 0 && used + rowHeight > box.h) {
      chunks.push(current);
      current = [];
      used = headerHeight;
    }
    current.push(row);
    used += rowHeight;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function expandOversizedTableSlides(slides) {
  const expanded = [];
  for (const spec of slides) {
    const type = String(spec.type ?? "content").toLowerCase();
    if (type !== "table") {
      expanded.push(spec);
      continue;
    }
    const block = spec.table ?? spec;
    const box = { x: 0.6, y: spec.summary ? 1.72 : 1.2, w: 12.1, h: spec.summary ? 5.15 : 5.67 };
    const headerRows = tableModel.tableHeaderRows(block);
    const columnCount = tableModel.tableColumns(block);
    const widths = normalizeColumnWidths(block, columnCount, box.w);
    const totalHeight = [...headerRows.map((row) => estimateTableRowHeight(row, widths, { header: true })), ...(block.rows ?? []).map((row) => estimateTableRowHeight(row, widths))]
      .reduce((sum, value) => sum + value, 0);
    if (totalHeight <= box.h + 0.02 || String(block.splitMode ?? "auto").toLowerCase() !== "auto") {
      expanded.push(spec);
      continue;
    }

    let canUseTwoColumns = false;
    if (columnCount <= Number(block.maxColumnsForSideSplit ?? 6)) {
      const gap = Number.isFinite(block.splitGap) ? block.splitGap : 0.16;
      const segmentWidth = (box.w - gap) / 2;
      const segmentWidths = normalizeColumnWidths(block, columnCount, segmentWidth);
      canUseTwoColumns = Boolean(splitRowsByHeight(block.rows ?? [], segmentWidths, headerRows, box.h).segments);
    }
    if (canUseTwoColumns) {
      expanded.push(spec);
      continue;
    }

    const chunks = paginateTableRows(block, box);
    chunks.forEach((rows, index) => {
      expanded.push({
        ...spec,
        title: index === 0 ? spec.title : `${spec.title || "表格"}（续${index}）`,
        table: { ...block, rows, splitMode: "none" },
      });
    });
  }
  return expanded;
}

function addClosingSlide(slide, context, spec) {
  slide.background = { color: context.theme.colors.white };
  addLogo(slide, context, "title");
  slide.addText(spec.title || "谢谢", {
    x: 1.2, y: 2.45, w: 10.9, h: 1.3,
    margin: 0, fontFace: context.theme.fontFace, fontSize: 34, bold: true,
    color: context.theme.colors.primary, align: "center", valign: "middle", fit: "shrink",
  });
  if (spec.subtitle) {
    slide.addText(spec.subtitle, {
      x: 1.5, y: 4.0, w: 10.3, h: 0.65,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 14,
      color: context.theme.colors.text, align: "center", valign: "middle", fit: "shrink",
    });
  }
}

function validateDeckSpec(deck) {
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) throw new Error("输入 JSON 必须是对象。 ");
  if (!deck.title || typeof deck.title !== "string") throw new Error("输入 JSON 必须包含字符串 title。 ");
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) throw new Error("输入 JSON 必须包含非空 slides 数组。 ");
  if (!deck.sourceManifest || typeof deck.sourceManifest !== "object" || Array.isArray(deck.sourceManifest)) {
    throw new Error("输入 JSON 必须包含 sourceManifest，用于核对源文字、表格列和媒体素材。 ");
  }
}

export async function buildPptx({ inputPath, outputPath, validate = true }) {
  const absoluteInput = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInput)) throw new Error(`输入文件不存在：${absoluteInput}`);
  const deck = JSON.parse(fs.readFileSync(absoluteInput, "utf8"));
  validateDeckSpec(deck);
  const inputDir = path.dirname(absoluteInput);
  const audit = auditDeckSpec(deck, { inputDir });
  if (!audit.ok) {
    throw new Error(`内容保真审计失败：${audit.errors.join("；")}`);
  }
  const runtime = loadPptxGenJS();
  const pptx = new runtime.PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = deck.author || "ppt-maker";
  pptx.company = deck.company || "";
  pptx.subject = deck.subject || "";
  pptx.title = deck.title;
  pptx.lang = deck.lang || "zh-CN";
  pptx.theme = {
    headFontFace: deck.theme?.fontFace || DEFAULT_THEME.fontFace,
    bodyFontFace: deck.theme?.fontFace || DEFAULT_THEME.fontFace,
    lang: deck.lang || "zh-CN",
  };
  pptx.defineLayout({ name: "PPT_MAKER_WIDE", width: SLIDE_W, height: SLIDE_H });
  pptx.layout = "PPT_MAKER_WIDE";

  const logoValue = deck.logo === false ? null : (deck.logo || "assets/logo.png");
  const context = {
    pptx,
    deck,
    theme: makeTheme(deck.theme),
    inputDir,
    logo: logoValue ? resolveAsset(logoValue, inputDir) : null,
  };
  if (context.logo) requireLocalAsset(context.logo, "Logo");
  defineLogoMasters(context);

  const slideSpecs = expandOversizedTableSlides(deck.slides);
  slideSpecs.forEach((spec, index) => {
    const pageNumber = index + 1;
    const type = String(spec.type ?? "content").toLowerCase();
    const masterName = ["title", "closing"].includes(type) ? "PPT_MAKER_TITLE" : "PPT_MAKER_CONTENT";
    const slide = pptx.addSlide(masterName);
    slide.background = { color: context.theme.colors.white };
    if (type === "title") addTitleSlide(slide, context, spec);
    else if (type === "agenda") addAgendaSlide(slide, context, spec, pageNumber, false);
    else if (type === "section") addAgendaSlide(slide, context, spec, pageNumber, true);
    else if (type === "content") addContentSlide(slide, context, spec, pageNumber);
    else if (type === "table") addTableSlide(slide, context, spec, pageNumber);
    else if (type === "closing") addClosingSlide(slide, context, spec);
    else throw new Error(`第 ${pageNumber} 页使用了不支持的页面类型：${type}`);
  });

  const absoluteOutput = path.resolve(
    outputPath || path.join(inputDir, `${sanitizeFilename(deck.title)}.pptx`),
  );
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  await pptx.writeFile({ fileName: absoluteOutput, compression: true });

  const validation = validate ? validatePptx(absoluteOutput, { expectedSlides: slideSpecs.length }) : null;
  if (validation && !validation.ok) {
    throw new Error(`PPTX 已生成但结构校验失败：${validation.errors.join("；")}`);
  }
  return {
    ok: true,
    input: absoluteInput,
    output: absoluteOutput,
    slides: slideSpecs.length,
    pptxgenjs: runtime.version,
    audit,
    validation,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildPptx({
      inputPath: args.input,
      outputPath: args.output,
      validate: args.validate,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`PPTX 生成完成：${result.output}`);
      console.log(`页面：${result.slides}；PptxGenJS：${result.pptxgenjs}`);
      console.log(`内容保真审计：通过；必需条目 ${result.audit.stats.requiredItems} 项`);
      if (result.validation) console.log("结构校验：通过");
    }
  } catch (error) {
    console.error(`生成失败：${error.message}`);
    process.exitCode = 2;
  }
}
