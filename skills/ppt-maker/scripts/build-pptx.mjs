#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadPptxGenJS, skillDir } from "./lib/pptxgen-loader.mjs";
import { validatePptx } from "./validate-pptx.mjs";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
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

function addImageContained(slide, filePath, box, altText = "") {
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
  slide.addImage({ path: filePath, ...fitted, altText });
}

function addLogo(slide, context, mode = "content") {
  if (!context.logo) return;
  const box = mode === "title"
    ? { x: 9.9, y: 0.45, w: 2.75, h: 0.9 }
    : { x: 11.25, y: 0.18, w: 1.55, h: 0.52 };
  addImageContained(slide, context.logo, box, "Logo");
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
    fit: "shrink",
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
  slide.addText(String(block.text ?? ""), {
    x: box.x, y: box.y, w: box.w, h: box.h,
    margin: 0.06, fontFace: context.theme.fontFace,
    fontSize: 10, color: context.theme.colors.text,
    valign: "top", fit: "shrink", breakLine: false,
    paraSpaceAfterPt: 3,
  });
}

function addBulletsBlock(slide, context, block, box) {
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
    fontSize: 10, color: context.theme.colors.text,
    valign: "top", fit: "shrink",
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

function addTableBlock(slide, context, block, box) {
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  if (headers.length === 0) throw new Error("表格必须包含 headers。 ");
  if (rows.some((row) => row.length !== headers.length)) {
    throw new Error("表格每一行的单元格数量必须与 headers 一致。 ");
  }
  const data = [
    headers.map((value) => ({
      text: String(value),
      options: {
        bold: true,
        color: context.theme.colors.white,
        fill: { color: context.theme.colors.tableHeader },
        align: "center",
      },
    })),
    ...rows.map((row, rowIndex) => row.map((value) => ({
      text: String(value ?? ""),
      options: {
        color: context.theme.colors.text,
        fill: { color: rowIndex % 2 === 0 ? context.theme.colors.pale : "F5F7FB" },
        align: numericValue(value) ? "right" : "left",
      },
    }))),
  ];
  const widths = block.colWidths?.length === headers.length
    ? block.colWidths.map(Number)
    : Array(headers.length).fill(box.w / headers.length);
  const widthTotal = widths.reduce((sum, value) => sum + value, 0);
  const normalizedWidths = widths.map((value) => (value / widthTotal) * box.w);
  slide.addTable(data, {
    x: box.x, y: box.y, w: box.w, h: box.h,
    colW: normalizedWidths,
    rowH: box.h / data.length,
    margin: 0.035,
    fontFace: context.theme.fontFace,
    fontSize: 10,
    border: { type: "solid", color: context.theme.colors.white, pt: 0.5 },
    autoFit: false,
    valign: "middle",
  });
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
  slide.addShape(context.pptx.ShapeType.rect, {
    x: box.x, y: box.y, w: box.w, h: titleH,
    fill: { color: normalizeColor(module.titleColor, colors.primary) },
    line: { color: normalizeColor(module.titleColor, colors.primary), width: 0.5 },
  });
  slide.addText(module.title || "", {
    x: box.x + 0.05, y: box.y + 0.03, w: box.w - 0.1, h: titleH - 0.06,
    margin: 0, fontFace, fontSize: 14, bold: true,
    color: colors.white, align: "center", valign: "middle", fit: "shrink",
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
  if (count <= 6) return 3;
  return 4;
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
    slide.addText(spec.summary, {
      x: 0.78, y: 1.25, w: 11.75, h: 0.4,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 14, bold: true,
      color: context.theme.colors.text, valign: "middle", fit: "shrink",
    });
  }
  const modules = spec.modules ?? [];
  if (modules.length === 0) throw new Error(`内容页“${spec.title}”没有 modules。`);
  if (modules.length > 8) throw new Error(`内容页“${spec.title}”最多支持 8 个模块。`);
  const area = { x: 0.6, y: hasSummary ? 1.98 : 1.15, w: 12.1, h: hasSummary ? 4.85 : 5.68 };
  const gap = Number.isFinite(spec.gap) ? spec.gap : 0.16;
  const columns = gridColumns(modules.length, spec.columns);
  const rows = Math.ceil(modules.length / columns);
  const cellW = (area.w - gap * (columns - 1)) / columns;
  const cellH = (area.h - gap * (rows - 1)) / rows;
  modules.forEach((module, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    addModule(slide, context, module, {
      x: area.x + column * (cellW + gap),
      y: area.y + row * (cellH + gap),
      w: cellW,
      h: cellH,
    });
  });
}

function addTableSlide(slide, context, spec, pageNumber) {
  addHeader(slide, context, spec.title || "表格", pageNumber);
  if (spec.summary) {
    slide.addText(spec.summary, {
      x: 0.6, y: 1.12, w: 12.1, h: 0.48,
      margin: 0, fontFace: context.theme.fontFace, fontSize: 14, bold: true,
      color: context.theme.colors.text, fit: "shrink",
    });
  }
  addTableBlock(slide, context, spec.table ?? spec, {
    x: 0.6, y: spec.summary ? 1.72 : 1.2, w: 12.1, h: spec.summary ? 5.15 : 5.67,
  });
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
}

export async function buildPptx({ inputPath, outputPath, validate = true }) {
  const absoluteInput = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInput)) throw new Error(`输入文件不存在：${absoluteInput}`);
  const deck = JSON.parse(fs.readFileSync(absoluteInput, "utf8"));
  validateDeckSpec(deck);
  const inputDir = path.dirname(absoluteInput);
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

  deck.slides.forEach((spec, index) => {
    const pageNumber = index + 1;
    const slide = pptx.addSlide();
    slide.background = { color: context.theme.colors.white };
    const type = String(spec.type ?? "content").toLowerCase();
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

  const validation = validate ? validatePptx(absoluteOutput, { expectedSlides: deck.slides.length }) : null;
  if (validation && !validation.ok) {
    throw new Error(`PPTX 已生成但结构校验失败：${validation.errors.join("；")}`);
  }
  return {
    ok: true,
    input: absoluteInput,
    output: absoluteOutput,
    slides: deck.slides.length,
    pptxgenjs: runtime.version,
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
      if (result.validation) console.log("结构校验：通过");
    }
  } catch (error) {
    console.error(`生成失败：${error.message}`);
    process.exitCode = 2;
  }
}
