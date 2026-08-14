import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function cellText(cell) {
  if (cell && typeof cell === "object" && !Array.isArray(cell)) return String(cell.text ?? "");
  return String(cell ?? "");
}

function cellColspan(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return 1;
  const value = Number(cell.colspan ?? cell.options?.colspan ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function logicalColumns(row) {
  return Array.isArray(row) ? row.reduce((sum, cell) => sum + cellColspan(cell), 0) : 0;
}

function tableHeaderRows(table) {
  if (Array.isArray(table?.headerRows) && table.headerRows.length > 0) return table.headerRows;
  return Array.isArray(table?.headers) ? [table.headers] : [];
}

function tableColumns(table) {
  const rows = [...tableHeaderRows(table), ...(Array.isArray(table?.rows) ? table.rows : [])];
  return rows.reduce((maximum, row) => Math.max(maximum, logicalColumns(row)), 0);
}

function collectDeck(deck) {
  const text = [];
  const refs = new Set();
  const tables = [];
  const images = [];
  const agendaTitles = [];

  function addRefs(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const ref of values) refs.add(String(ref));
  }

  function visitBlock(block, location) {
    if (!block || typeof block !== "object") return;
    addRefs(block.sourceRef);
    addRefs(block.sourceRefs);
    const type = String(block.type ?? "text").toLowerCase();
    if (type === "text") text.push(String(block.text ?? ""));
    if (type === "bullets") {
      for (const item of block.items ?? []) text.push(typeof item === "string" ? item : String(item?.text ?? ""));
    }
    if (type === "metrics") {
      for (const item of block.items ?? []) text.push([item?.value, item?.unit, item?.label].filter(Boolean).join(""));
    }
    if (type === "table") {
      tables.push({ ...block, location });
      for (const row of [...tableHeaderRows(block), ...(block.rows ?? [])]) {
        for (const cell of row) text.push(cellText(cell));
      }
    }
    if (type === "chart") {
      text.push(String(block.title ?? ""));
      for (const series of block.series ?? []) {
        text.push(String(series?.name ?? ""));
        for (const label of series?.labels ?? []) text.push(String(label));
        for (const value of series?.values ?? []) text.push(String(value));
      }
    }
    if (type === "image") images.push({ ...block, location });
  }

  for (const item of deck.agenda ?? []) {
    const title = typeof item === "string" ? item : String(item?.title ?? "");
    text.push(title);
    agendaTitles.push(title);
    if (item && typeof item === "object") {
      addRefs(item.sourceRef);
      addRefs(item.sourceRefs);
    }
  }

  for (const [slideIndex, slide] of (deck.slides ?? []).entries()) {
    const slideLocation = `slides[${slideIndex}]`;
    addRefs(slide?.sourceRef);
    addRefs(slide?.sourceRefs);
    text.push(String(slide?.title ?? ""), String(slide?.heading ?? ""), String(slide?.summary ?? ""), String(slide?.subtitle ?? ""));
    if (String(slide?.type ?? "").toLowerCase() === "agenda") {
      for (const item of slide.items ?? []) {
        const title = typeof item === "string" ? item : String(item?.title ?? "");
        text.push(title);
        agendaTitles.push(title);
        if (item && typeof item === "object") {
          addRefs(item.sourceRef);
          addRefs(item.sourceRefs);
        }
      }
    }
    if (String(slide?.type ?? "").toLowerCase() === "table" || slide?.table) {
      const table = slide.table ?? slide;
      visitBlock({ type: "table", ...table }, `${slideLocation}.table`);
    }
    for (const [moduleIndex, module] of (slide?.modules ?? []).entries()) {
      const moduleLocation = `${slideLocation}.modules[${moduleIndex}]`;
      addRefs(module?.sourceRef);
      addRefs(module?.sourceRefs);
      text.push(String(module?.title ?? ""), String(module?.body ?? ""));
      const blocks = Array.isArray(module?.blocks) && module.blocks.length > 0
        ? module.blocks
        : [
          ...(module?.body ? [{ type: "text", text: module.body }] : []),
          ...(module?.bullets?.length ? [{ type: "bullets", items: module.bullets }] : []),
          ...(module?.metrics?.length ? [{ type: "metrics", items: module.metrics }] : []),
          ...(module?.table ? [{ type: "table", ...module.table }] : []),
          ...(module?.chart ? [{ type: "chart", ...module.chart }] : []),
          ...(module?.image ? [{ type: "image", ...(typeof module.image === "string" ? { path: module.image } : module.image) }] : []),
        ];
      for (const [blockIndex, block] of blocks.entries()) visitBlock(block, `${moduleLocation}.blocks[${blockIndex}]`);
    }
  }
  return { text: text.join("\n"), refs, tables, images, agendaTitles };
}

function resolveLocal(filePath, inputDir) {
  if (!filePath) return null;
  if (/^https?:\/\//i.test(filePath)) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(inputDir, filePath);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function required(item) {
  return item?.required !== false && !item?.omittedReason;
}

export function auditDeckSpec(deck, { inputDir = process.cwd() } = {}) {
  const errors = [];
  const warnings = [];
  const manifest = deck?.sourceManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      ok: false,
      errors: ["缺少 sourceManifest；无法证明原始文字、表格列和媒体素材是否完整保留。"],
      warnings,
      stats: {},
    };
  }

  for (const key of ["sources", "sections", "textItems", "tables", "media"]) {
    if (manifest[key] !== undefined && !Array.isArray(manifest[key])) errors.push(`sourceManifest.${key} 必须是数组。`);
  }

  const collections = ["sources", "sections", "textItems", "tables", "media"];
  const ids = new Set();
  for (const collection of collections) {
    for (const [index, item] of (manifest[collection] ?? []).entries()) {
      if (!item?.id || typeof item.id !== "string") {
        errors.push(`sourceManifest.${collection}[${index}] 缺少字符串 id。`);
      } else if (ids.has(item.id)) {
        errors.push(`sourceManifest 中存在重复 id：${item.id}`);
      } else ids.add(item.id);
    }
  }

  const collected = collectDeck(deck);
  const deckText = normalizeText(collected.text);

  for (const source of manifest.sources ?? []) {
    if (!required(source)) continue;
    const absolute = resolveLocal(source.path, inputDir);
    if (!absolute) {
      errors.push(`源文件 ${source.id} 必须使用本地字面路径，不允许 URL 或空路径。`);
      continue;
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      errors.push(`源文件 ${source.id} 不存在：${absolute}`);
      continue;
    }
    if (source.sha256 && sha256(absolute).toLowerCase() !== String(source.sha256).toLowerCase()) {
      errors.push(`源文件 ${source.id} 的 SHA-256 与清单不一致：${absolute}`);
    }
  }

  for (const item of manifest.textItems ?? []) {
    if (!required(item)) continue;
    if (!collected.refs.has(item.id)) errors.push(`必需文字 ${item.id} 没有被任何页面或内容块引用。`);
    const exact = normalizeText(item.text);
    if (!exact) errors.push(`必需文字 ${item.id} 的 text 为空。`);
    else if (!deckText.includes(exact)) errors.push(`必需文字 ${item.id} 未原样出现在演示文稿输入中；不得改写引号、标点、数字或措辞。`);
  }

  const normalizedAgendaTitles = collected.agendaTitles.map(normalizeText);
  for (const section of manifest.sections ?? []) {
    if (!required(section)) continue;
    if (!collected.refs.has(section.id)) errors.push(`必需章节 ${section.id} 没有被目录项引用。`);
    const title = normalizeText(section.title);
    if (!title) errors.push(`必需章节 ${section.id} 的 title 为空。`);
    else if (!normalizedAgendaTitles.includes(title)) errors.push(`必需章节 ${section.id} 未原样出现在目录中；不得遗漏、擅自合并或重命名一级标题。`);
  }

  for (const expected of manifest.tables ?? []) {
    if (!required(expected)) continue;
    const matches = collected.tables.filter((table) => {
      const refs = [table.sourceRef, ...(table.sourceRefs ?? [])].filter(Boolean).map(String);
      return refs.includes(expected.id);
    });
    if (matches.length === 0) {
      errors.push(`必需表格 ${expected.id} 没有对应的 table 内容块。`);
      continue;
    }
    const actualRows = matches.reduce((sum, table) => sum + (table.rows?.length ?? 0), 0);
    const actualColumns = Math.max(...matches.map(tableColumns));
    const actualHeaderRows = Math.max(...matches.map((table) => tableHeaderRows(table).length));
    if (Number.isInteger(expected.rows) && actualRows !== expected.rows) {
      errors.push(`表格 ${expected.id} 行数不符：源表 ${expected.rows} 行，输入 ${actualRows} 行。`);
    }
    if (Number.isInteger(expected.columns) && actualColumns !== expected.columns) {
      errors.push(`表格 ${expected.id} 列数不符：源表 ${expected.columns} 列，输入 ${actualColumns} 列；禁止删除最左列或其他字段。`);
    }
    if (Number.isInteger(expected.headerRows) && actualHeaderRows !== expected.headerRows) {
      errors.push(`表格 ${expected.id} 表头行数不符：源表 ${expected.headerRows} 行，输入 ${actualHeaderRows} 行。`);
    }
  }

  for (const item of manifest.media ?? []) {
    if (!required(item)) continue;
    const expectedAbsolute = resolveLocal(item.path, inputDir);
    if (!expectedAbsolute || !fs.existsSync(expectedAbsolute)) {
      errors.push(`必需媒体 ${item.id} 的源文件不存在：${item.path ?? "(空路径)"}`);
      continue;
    }
    const expectedHash = item.sha256 ? String(item.sha256).toLowerCase() : sha256(expectedAbsolute);
    if (item.sha256 && sha256(expectedAbsolute).toLowerCase() !== expectedHash) {
      errors.push(`必需媒体 ${item.id} 的 SHA-256 与清单不一致：${expectedAbsolute}`);
      continue;
    }
    const matches = collected.images.filter((image) => {
      const refs = [image.sourceRef, ...(image.sourceRefs ?? [])].filter(Boolean).map(String);
      return refs.includes(item.id);
    });
    if (matches.length === 0) {
      errors.push(`必需媒体 ${item.id} 没有对应的 image 内容块。`);
      continue;
    }
    for (const image of matches) {
      const absolute = resolveLocal(image.path, inputDir);
      if (!absolute || !fs.existsSync(absolute)) errors.push(`媒体 ${item.id} 的图片不存在：${image.path ?? "(空路径)"}`);
      else if (sha256(absolute).toLowerCase() !== expectedHash) errors.push(`媒体 ${item.id} 引用的图片与源媒体内容不一致：${image.path}`);
    }
  }

  const requiredReferenceIds = ["sections", "textItems", "tables", "media"]
    .flatMap((collection) => (manifest[collection] ?? []).filter(required).map((item) => item.id));
  const requiredSourceIds = (manifest.sources ?? []).filter(required).map((item) => item.id);
  for (const ref of collected.refs) {
    if (!ids.has(ref)) warnings.push(`内容引用了未在 sourceManifest 中声明的 sourceRef：${ref}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      requiredItems: requiredReferenceIds.length + requiredSourceIds.length,
      requiredSources: requiredSourceIds.length,
      requiredReferences: requiredReferenceIds.length,
      referencedItems: requiredReferenceIds.filter((id) => collected.refs.has(id)).length,
      textItems: manifest.textItems?.length ?? 0,
      sections: manifest.sections?.length ?? 0,
      tables: manifest.tables?.length ?? 0,
      media: manifest.media?.length ?? 0,
      discoveredTableBlocks: collected.tables.length,
      discoveredImageBlocks: collected.images.length,
    },
  };
}

export const tableModel = { cellText, logicalColumns, tableColumns, tableHeaderRows };
