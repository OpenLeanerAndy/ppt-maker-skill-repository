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

function cellRowspan(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return 1;
  const value = Number(cell.rowspan ?? cell.options?.rowspan ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function canonicalRows(rows) {
  return JSON.stringify((rows ?? []).map((row) => (row ?? []).map((cell) => ({
    text: cellText(cell),
    colspan: cellColspan(cell),
    rowspan: cellRowspan(cell),
  }))));
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
  const slideStructures = [];
  const moduleStructures = [];

  function addRefs(value) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const ref of values) refs.add(String(ref));
  }

  function visitBlock(block, location, typeSet = null) {
    if (!block || typeof block !== "object") return;
    addRefs(block.sourceRef);
    addRefs(block.sourceRefs);
    const type = String(block.type ?? "text").toLowerCase();
    if (typeSet) typeSet.add(type);
    if (type === "text") text.push(String(block.text ?? ""));
    if (type === "bullets") {
      for (const item of block.items ?? []) text.push(typeof item === "string" ? item : String(item?.text ?? ""));
    }
    if (type === "metrics") {
      for (const item of block.items ?? []) text.push([item?.value, item?.unit, item?.label].filter(Boolean).join(""));
    }
    if (type === "matrix") {
      for (const item of block.items ?? []) {
        if (typeof item === "string") text.push(item);
        else text.push(String(item?.title ?? item?.label ?? ""), String(item?.body ?? item?.text ?? item?.description ?? ""), Array.isArray(item?.meta) ? item.meta.join("\n") : String(item?.meta ?? ""));
      }
    }
    if (type === "callout") text.push(String(block.label ?? block.title ?? ""), String(block.text ?? block.body ?? ""));
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
    const slideTypes = new Set();
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
      visitBlock({ type: "table", ...table }, `${slideLocation}.table`, slideTypes);
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
          ...(module?.matrix ? [{ type: "matrix", ...(Array.isArray(module.matrix) ? { items: module.matrix } : module.matrix) }] : []),
          ...(module?.callout ? [{ type: "callout", ...(typeof module.callout === "string" ? { text: module.callout } : module.callout) }] : []),
          ...(module?.table ? [{ type: "table", ...module.table }] : []),
          ...(module?.chart ? [{ type: "chart", ...module.chart }] : []),
          ...(module?.image ? [{ type: "image", ...(typeof module.image === "string" ? { path: module.image } : module.image) }] : []),
        ];
      const moduleTypes = new Set();
      for (const [blockIndex, block] of blocks.entries()) {
        visitBlock(block, `${moduleLocation}.blocks[${blockIndex}]`, moduleTypes);
        slideTypes.add(String(block?.type ?? "text").toLowerCase());
      }
      const bulletItems = blocks
        .filter((block) => String(block?.type ?? "text").toLowerCase() === "bullets")
        .flatMap((block) => block.items ?? [])
        .map((item) => typeof item === "string" ? item : String(item?.text ?? ""));
      moduleStructures.push({
        location: moduleLocation,
        title: String(module?.title ?? ""),
        types: [...moduleTypes],
        bulletItems,
        plainListReason: String(module?.plainListReason ?? "").trim(),
      });
    }
    slideStructures.push({
      index: slideIndex,
      location: slideLocation,
      title: String(slide?.title ?? slide?.heading ?? ""),
      type: String(slide?.type ?? "content").toLowerCase(),
      types: [...slideTypes],
      visualExemptionReason: String(slide?.visualExemptionReason ?? "").trim(),
      contentGroupRef: String(slide?.contentGroupRef ?? "").trim(),
      layoutFlow: String(slide?.layoutFlow ?? "").trim(),
      columns: Number.isInteger(slide?.columns) ? slide.columns : 1,
      moduleCount: Array.isArray(slide?.modules) ? slide.modules.length : 0,
      splitReason: String(slide?.splitReason ?? "").trim(),
      approvalRef: String(slide?.approvalRef ?? "").trim(),
      continuationIndex: Number(slide?.continuationIndex),
    });
    addRefs(slide?.contentGroupRef);
  }
  return { text: text.join("\n"), refs, tables, images, agendaTitles, slideStructures, moduleStructures };
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

  for (const key of ["sources", "sections", "textItems", "tables", "media", "contentGroups"]) {
    if (manifest[key] !== undefined && !Array.isArray(manifest[key])) errors.push(`sourceManifest.${key} 必须是数组。`);
  }

  const collections = ["sources", "sections", "textItems", "tables", "media", "contentGroups"];
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
  const auditableSlides = collected.slideStructures.filter((slide) => slide.type === "content" || slide.type === "table");
  if (auditableSlides.length > 0 && (!Array.isArray(manifest.contentGroups) || manifest.contentGroups.length === 0)) {
    errors.push("sourceManifest.contentGroups 不能为空；无法核对页面是否被无依据分栏、拆模块或拆页。");
  }

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
    const expectedRows = Number.isInteger(expected.bodyRows) ? expected.bodyRows : expected.rows;
    const expectedColumns = Number.isInteger(expected.logicalColumns) ? expected.logicalColumns : expected.columns;
    const expectedHeaderRows = Number.isInteger(expected.headerRowCount) ? expected.headerRowCount : expected.headerRows;
    for (const field of ["bodyRows", "logicalColumns", "headerRowCount", "rowHeaderColumns", "headerRowsData", "bodyRowsData"]) {
      if (expected[field] === undefined) errors.push(`表格 ${expected.id} 的 sourceManifest 缺少 ${field}，无法检出转置、表头吞并或单元格丢失。`);
    }
    const actualRows = matches.reduce((sum, table) => sum + (table.rows?.length ?? 0), 0);
    const actualColumns = Math.max(...matches.map(tableColumns));
    const actualHeaderRows = Math.max(...matches.map((table) => tableHeaderRows(table).length));
    if (Number.isInteger(expectedRows) && actualRows !== expectedRows) {
      errors.push(`表格 ${expected.id} 正文行数不符：源表 ${expectedRows} 行，输入 ${actualRows} 行。`);
    }
    if (Number.isInteger(expectedColumns) && actualColumns !== expectedColumns) {
      errors.push(`表格 ${expected.id} 逻辑列数不符：源表 ${expectedColumns} 列，输入 ${actualColumns} 列；禁止删除最左列或其他字段。`);
    }
    if (Number.isInteger(expectedHeaderRows) && actualHeaderRows !== expectedHeaderRows) {
      errors.push(`表格 ${expected.id} 表头行数不符：源表 ${expectedHeaderRows} 行，输入 ${actualHeaderRows} 行；不得吞并父表头下的子表头。`);
    }
    for (const table of matches) {
      if (String(table.orientation ?? "").toLowerCase() !== "source") {
        errors.push(`表格 ${expected.id} 在 ${table.location} 未声明 orientation: "source"；禁止转置或重排源表。`);
      }
      if (Number.isInteger(expected.rowHeaderColumns) && Number(table.rowHeaderColumns) !== expected.rowHeaderColumns) {
        errors.push(`表格 ${expected.id} 在 ${table.location} 的行表头列数不符：源表 ${expected.rowHeaderColumns} 列，输入 ${table.rowHeaderColumns ?? "未声明"} 列。`);
      }
      if (Array.isArray(expected.headerRowsData) && canonicalRows(tableHeaderRows(table)) !== canonicalRows(expected.headerRowsData)) {
        errors.push(`表格 ${expected.id} 在 ${table.location} 的多级表头文字、顺序或合并关系与源表不一致。`);
      }
    }
    if (Array.isArray(expected.bodyRowsData)) {
      const actualBodyRows = matches.flatMap((table) => table.rows ?? []);
      if (canonicalRows(actualBodyRows) !== canonicalRows(expected.bodyRowsData)) {
        errors.push(`表格 ${expected.id} 的正文二维矩阵与源表不一致；可能存在转置、字段重排、分组数据被吞并或单元格改写。`);
      }
    }
    if (matches.length > 1) {
      for (const table of matches) {
        if (!String(table.splitReason ?? "").trim() || !String(table.approvalRef ?? "").trim()) {
          errors.push(`表格 ${expected.id} 被拆成 ${matches.length} 个表格块，但 ${table.location} 缺少 splitReason 或 approvalRef。`);
        }
      }
    }
  }

  const requiredGroups = (manifest.contentGroups ?? []).filter(required);
  if (requiredGroups.length > 0) {
    const contentSlides = collected.slideStructures.filter((slide) => slide.type === "content" || slide.type === "table");
    for (const slide of contentSlides) {
      if (!slide.contentGroupRef) errors.push(`${slide.location}“${slide.title}”缺少 contentGroupRef，无法核对是否被无依据分栏或拆页。`);
      if (!slide.layoutFlow) errors.push(`${slide.location}“${slide.title}”缺少 layoutFlow；连续内容必须显式声明 single-column。`);
      if (slide.layoutFlow === "single-column" && slide.columns !== 1) {
        errors.push(`${slide.location}“${slide.title}”声明单列阅读流，但 columns=${slide.columns}。`);
      }
    }
    for (const group of requiredGroups) {
      if (!Number.isFinite(Number(group.sourceOrder))) errors.push(`内容组 ${group.id} 缺少数字 sourceOrder。`);
      if (group.keepTogether === undefined) errors.push(`内容组 ${group.id} 缺少 keepTogether；默认单页归属必须显式记录。`);
      if (!String(group.preferredFlow ?? "").trim()) errors.push(`内容组 ${group.id} 缺少 preferredFlow。`);
      const matches = contentSlides.filter((slide) => slide.contentGroupRef === group.id);
      if (matches.length === 0) {
        errors.push(`必需内容组 ${group.id} 没有对应页面。`);
        continue;
      }
      const preferredFlow = String(group.preferredFlow ?? "single-column");
      for (const slide of matches) {
        if (slide.layoutFlow && slide.layoutFlow !== preferredFlow) {
          errors.push(`内容组 ${group.id} 要求 ${preferredFlow}，但 ${slide.location} 使用 ${slide.layoutFlow}。`);
        }
      }
      const keepTogether = group.keepTogether !== false;
      if (matches.length > 1 && (keepTogether || group.allowSlideSplit !== true)) {
        errors.push(`内容组 ${group.id} 默认应保持单页，却被拆成 ${matches.length} 页；必须先证明单页无法容纳并获得用户确认。`);
      }
      if (matches.length > 1 && group.allowSlideSplit === true) {
        const evidence = group.capacityEvidence;
        if (!evidence || evidence.singlePageAttempted !== true || !Number.isFinite(Number(evidence.requiredHeight)) || !Number.isFinite(Number(evidence.availableHeight)) || Number(evidence.requiredHeight) <= Number(evidence.availableHeight)) {
          errors.push(`内容组 ${group.id} 缺少有效 capacityEvidence；拆页前必须证明单页所需高度大于可用高度。`);
        }
        matches.forEach((slide, index) => {
          if (!slide.splitReason || !slide.approvalRef) errors.push(`${slide.location} 属于拆分内容组 ${group.id}，但缺少 splitReason 或 approvalRef。`);
          if (slide.continuationIndex !== index + 1) errors.push(`${slide.location} 的 continuationIndex 应为 ${index + 1}。`);
        });
      }
    }
    const ordered = contentSlides
      .map((slide) => ({ slide, group: requiredGroups.find((group) => group.id === slide.contentGroupRef) }))
      .filter((item) => item.group && Number.isFinite(Number(item.group.sourceOrder)));
    for (let index = 1; index < ordered.length; index += 1) {
      if (Number(ordered[index].group.sourceOrder) < Number(ordered[index - 1].group.sourceOrder)) {
        errors.push(`${ordered[index].slide.location} 的内容组顺序早于前一页，违反源文档连续顺序。`);
      }
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

  const structuredTypes = new Set(["metrics", "matrix", "table", "chart", "image", "callout"]);
  const requireStructuredEvidence = true;
  if (requireStructuredEvidence) {
    for (const slide of collected.slideStructures) {
      if (slide.type !== "content") continue;
      const hasStructuredEvidence = slide.types.some((type) => structuredTypes.has(type));
      if (!hasStructuredEvidence && !slide.visualExemptionReason) {
        errors.push(`${slide.location}“${slide.title}”只有正文/项目符号，没有结构化证据；请使用指标、表格、图表、图片、事项矩阵或提示块，纯叙述页则填写 visualExemptionReason。`);
      }
    }
    for (const module of collected.moduleStructures) {
      const hasStructuredEvidence = module.types.some((type) => structuredTypes.has(type));
      if (hasStructuredEvidence || module.plainListReason) continue;
      const labeledItems = module.bulletItems.filter((item) => /[^：:\s]{1,20}[：:]/.test(item));
      if (module.bulletItems.length >= 3 && labeledItems.length >= 2) {
        errors.push(`${module.location}“${module.title}”包含多项“标签：说明”，不得退化为项目符号；请使用 matrix 或 table，确为同质叙述时填写 plainListReason。`);
      } else if (module.bulletItems.length >= 6) {
        errors.push(`${module.location}“${module.title}”包含 ${module.bulletItems.length} 条纯文字列表；请评估 matrix、table 或分页，确为同质叙述时填写 plainListReason。`);
      }
    }
  }

  const requiredReferenceIds = ["sections", "textItems", "tables", "media", "contentGroups"]
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
      contentGroups: manifest.contentGroups?.length ?? 0,
      discoveredTableBlocks: collected.tables.length,
      discoveredImageBlocks: collected.images.length,
      structuredSlides: collected.slideStructures.filter((slide) => slide.types.some((type) => structuredTypes.has(type))).length,
    },
  };
}

export const tableModel = { cellText, logicalColumns, tableColumns, tableHeaderRows };
