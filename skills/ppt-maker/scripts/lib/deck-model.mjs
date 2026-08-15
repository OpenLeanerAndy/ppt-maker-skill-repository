export function normalizeBlocks(module) {
  if (Array.isArray(module?.blocks) && module.blocks.length > 0) return module.blocks;
  const blocks = [];
  if (module?.body) blocks.push({ type: "text", text: module.body });
  if (module?.bullets?.length) blocks.push({ type: "bullets", items: module.bullets });
  if (module?.metrics?.length) blocks.push({ type: "metrics", items: module.metrics });
  if (module?.matrix) blocks.push({ type: "matrix", ...(Array.isArray(module.matrix) ? { items: module.matrix } : module.matrix) });
  if (module?.callout) blocks.push({ type: "callout", ...(typeof module.callout === "string" ? { text: module.callout } : module.callout) });
  if (module?.table) blocks.push({ type: "table", ...module.table });
  if (module?.chart) blocks.push({ type: "chart", ...module.chart });
  if (module?.image) blocks.push({ type: "image", ...(typeof module.image === "string" ? { path: module.image } : module.image) });
  return blocks;
}

export function cellText(cell) {
  if (cell && typeof cell === "object" && !Array.isArray(cell)) return String(cell.text ?? "");
  return String(cell ?? "");
}

export function cellColspan(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return 1;
  const value = Number(cell.colspan ?? cell.options?.colspan ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function cellRowspan(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return 1;
  const value = Number(cell.rowspan ?? cell.options?.rowspan ?? 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function logicalColumns(row) {
  return Array.isArray(row) ? row.reduce((sum, cell) => sum + cellColspan(cell), 0) : 0;
}

export function tableHeaderRows(table) {
  if (Array.isArray(table?.headerRows) && table.headerRows.length > 0) return table.headerRows;
  return Array.isArray(table?.headers) ? [table.headers] : [];
}

export function tableColumns(table) {
  const rows = [...tableHeaderRows(table), ...(Array.isArray(table?.rows) ? table.rows : [])];
  return rows.reduce((maximum, row) => Math.max(maximum, logicalColumns(row)), 0);
}
