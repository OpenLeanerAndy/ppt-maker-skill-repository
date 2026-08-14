#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPptx } from "./build-pptx.mjs";
import { auditDeckSpec } from "./lib/deck-audit.mjs";

function rows(count, columns) {
  return Array.from({ length: count }, (_, row) => Array.from({ length: columns }, (_, column) => (
    column === 0 ? String(row + 1) : `第${row + 1}行第${column + 1}列内容`
  )));
}

function testDeck() {
  return {
    title: "通用长表布局测试",
    logo: "assets/logo.png",
    agenda: [{ title: "原文保真", sourceRef: "section-fidelity" }],
    sourceManifest: {
      sources: [],
      sections: [{ id: "section-fidelity", title: "原文保真" }],
      textItems: [{ id: "text-quote", text: "保留“原始引号”和12.3456精度。" }],
      tables: [{ id: "table-long", rows: 30, columns: 5, headerRows: 2 }],
      media: [],
    },
    slides: [
      { type: "title", title: "通用长表布局测试" },
      {
        type: "content",
        title: "原文保真",
        sourceRef: "text-quote",
        modules: [{ title: "规则", body: "保留“原始引号”和12.3456精度。", sourceRef: "text-quote" }],
      },
      {
        type: "table",
        title: "长表自动拆分",
        table: {
          sourceRef: "table-long",
          headerRows: [
            [
              { "text": "序号", "rowspan": 2 },
              { "text": "分组A", "colspan": 2 },
              { "text": "分组B", "colspan": 2 }
            ],
            ["字段A", "字段B", "字段C", "字段D"]
          ],
          rows: rows(30, 5),
          colWidths: [0.7, 1.5, 1.5, 1.5, 1.5],
          splitMode: "auto"
        }
      },
      { type: "closing", title: "测试完成" }
    ]
  };
}

const validDeck = testDeck();
assert.equal(auditDeckSpec(validDeck).ok, true, "完整清单应通过审计");

const missingColumn = structuredClone(validDeck);
missingColumn.slides[2].table.headerRows[0].shift();
for (const row of missingColumn.slides[2].table.rows) row.shift();
missingColumn.slides[2].table.colWidths.shift();
const missingColumnAudit = auditDeckSpec(missingColumn);
assert.equal(missingColumnAudit.ok, false, "删除最左列必须失败");
assert(missingColumnAudit.errors.some((message) => message.includes("列数不符")), "错误应指出列数不符");

const changedQuote = structuredClone(validDeck);
changedQuote.slides[1].modules[0].body = "保留「原始引号」和12.35精度。";
const changedQuoteAudit = auditDeckSpec(changedQuote);
assert.equal(changedQuoteAudit.ok, false, "改写引号和数字精度必须失败");
assert(changedQuoteAudit.errors.some((message) => message.includes("未原样")), "错误应指出文字未原样保留");

const missingAgenda = structuredClone(validDeck);
missingAgenda.agenda = [];
const missingAgendaAudit = auditDeckSpec(missingAgenda);
assert.equal(missingAgendaAudit.ok, false, "遗漏一级标题必须失败");
assert(missingAgendaAudit.errors.some((message) => message.includes("未原样出现在目录")), "错误应指出目录缺少一级标题");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-maker-test-"));
const keepIndex = process.argv.indexOf("--keep-output");
const keepOutput = keepIndex >= 0 ? process.argv[keepIndex + 1] : null;
if (keepIndex >= 0 && !keepOutput) throw new Error("--keep-output 需要提供 .pptx 路径。 ");
try {
  const input = path.join(temporary, "long-table.json");
  const output = path.join(temporary, "long-table.pptx");
  fs.writeFileSync(input, JSON.stringify(validDeck, null, 2), "utf8");
  const result = await buildPptx({ inputPath: input, outputPath: output, validate: true });
  assert.equal(result.ok, true);
  assert.equal(result.validation.ok, true);
  assert.equal(result.slides, 4);
  assert(result.validation.tables >= 2, "30行长表应拆为左右两个表格");
  assert(result.validation.media <= 2, "重复Logo应通过母版复用，不能按页面重复打包");
  assert(fs.statSync(output).size > 1000, "生成的PPTX不能为空");
  if (keepOutput) {
    const destination = path.resolve(keepOutput);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(output, destination);
  }

  const tooWide = structuredClone(validDeck);
  tooWide.sourceManifest.tables[0] = { id: "table-long", rows: 30, columns: 7, headerRows: 1 };
  tooWide.slides[2].table = {
    sourceRef: "table-long",
    headers: ["序号", "字段A", "字段B", "字段C", "字段D", "字段E", "字段F"],
    rows: rows(30, 7),
    colWidths: [0.7, 1, 1, 1, 1, 1, 1],
    splitMode: "auto",
  };
  const tooWideInput = path.join(temporary, "too-wide.json");
  fs.writeFileSync(tooWideInput, JSON.stringify(tooWide, null, 2), "utf8");
  const tooWideResult = await buildPptx({ inputPath: tooWideInput, outputPath: path.join(temporary, "too-wide.pptx"), validate: true });
  assert.equal(tooWideResult.ok, true);
  assert(tooWideResult.slides > validDeck.slides.length, "列数过多的超长独立表格必须自动拆成连续页面");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("ppt-maker runtime tests: passed");
