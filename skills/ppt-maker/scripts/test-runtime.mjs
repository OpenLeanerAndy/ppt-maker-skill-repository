#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPptx, CONTENT_LOGO_PLACEMENT, expandOversizedTableSlides } from "./build-pptx.mjs";
import { auditDeckSpec } from "./lib/deck-audit.mjs";

function rows(count, columns) {
  return Array.from({ length: count }, (_, row) => Array.from({ length: columns }, (_, column) => (
    column === 0 ? String(row + 1) : `第${row + 1}行第${column + 1}列内容`
  )));
}

function outlinePagesFromSlides(slides) {
  return slides.map((slide) => ({
    type: String(slide.type ?? "content").toLowerCase(),
    title: String(slide.title ?? slide.heading ?? ""),
    contentGroupRef: String(slide.contentGroupRef ?? ""),
    layoutFlow: String(slide.layoutFlow ?? ""),
    moduleTitles: (slide.modules ?? []).map((module) => String(module.title ?? "")),
  }));
}

function testDeck() {
  const tableRows = rows(30, 5);
  const tableHeaders = [
    [
      { "text": "序号", "rowspan": 3 },
      { "text": "业务部门", "colspan": 4 }
    ],
    [{ "text": "分组A", "colspan": 2 }, { "text": "分组B", "colspan": 2 }],
    ["字段A", "字段B", "字段C", "字段D"]
  ];
  return {
    title: "通用长表布局测试",
    logo: "assets/logo.png",
    agenda: [{ title: "原文保真", sourceRef: "section-fidelity" }],
    sourceManifest: {
      sources: [],
      sections: [{ id: "section-fidelity", title: "原文保真" }],
      textItems: [{ id: "text-quote", text: "保留“原始引号”和12.3456精度。" }],
      tables: [{
        id: "table-long",
        bodyRows: 30,
        logicalColumns: 5,
        headerRowCount: 3,
        rowHeaderColumns: 1,
        headerRowsData: tableHeaders,
        bodyRowsData: tableRows,
      }],
      media: [],
      contentGroups: [
        { id: "group-fidelity", sourceOrder: 1, keepTogether: true, preferredFlow: "multi-column" },
        { id: "group-table", sourceOrder: 2, keepTogether: true, preferredFlow: "full-table" },
      ],
    },
    confirmedOutline: {
      initialApprovalRef: "outline-approved",
      initialPages: [
        { type: "title", title: "通用长表布局测试", moduleTitles: [] },
        { type: "content", title: "原文保真", contentGroupRef: "group-fidelity", layoutFlow: "multi-column", moduleTitles: ["规则", "结构化表达"] },
        { type: "table", title: "长表自动拆分", contentGroupRef: "group-table", layoutFlow: "full-table", moduleTitles: [] },
        { type: "closing", title: "测试完成", moduleTitles: [] },
      ],
      revisions: [],
    },
    slides: [
      { type: "title", title: "通用长表布局测试" },
      {
        type: "content",
        title: "原文保真",
        contentGroupRef: "group-fidelity",
        layoutFlow: "multi-column",
        sourceRef: "text-quote",
        columns: 2,
        modules: [
          { title: "规则", body: "保留“原始引号”和12.3456精度。", sourceRef: "text-quote" },
          {
            title: "结构化表达",
            blocks: [
              {
                type: "matrix",
                columns: 2,
                items: [
                  { title: "指标", body: "关键数字使用指标组" },
                  { title: "任务", body: "行动项使用事项矩阵" },
                  { title: "明细", body: "完整记录使用表格" },
                  { title: "异常", body: "风险使用语义提示" }
                ]
              },
              { type: "callout", label: "验收", text: "禁止把有稳定字段的内容退化为纯文字列表。" }
            ]
          }
        ],
      },
      {
        type: "table",
        title: "长表自动拆分",
        contentGroupRef: "group-table",
        layoutFlow: "full-table",
        table: {
          sourceRef: "table-long",
          orientation: "source",
          rowHeaderColumns: 1,
          headerRows: tableHeaders,
          rows: tableRows,
          colWidths: [0.7, 1.5, 1.5, 1.5, 1.5],
          splitMode: "rows-two-column",
          splitReason: "单表按10号字和1.3倍行距计算后超过单页表格区高度，按正文行左右分段。",
          approvalRef: "outline-approved"
        }
      },
      { type: "closing", title: "测试完成" }
    ]
  };
}

const validDeck = testDeck();
assert.equal(auditDeckSpec(validDeck).ok, true, "完整清单应通过审计");
assert.equal(CONTENT_LOGO_PLACEMENT.top, 1 / 2.54, "Logo顶部边距应为1厘米");
assert.equal(CONTENT_LOGO_PLACEMENT.right, 1 / 2.54, "Logo右侧边距应为1厘米");
assert.equal(CONTENT_LOGO_PLACEMENT.w, 1.55, "Logo宽度应沿用原内容页尺寸");
assert.equal(CONTENT_LOGO_PLACEMENT.h, 0.52, "Logo高度应沿用原内容页尺寸");

const missingConfirmedOutline = structuredClone(validDeck);
delete missingConfirmedOutline.confirmedOutline;
const missingOutlineAudit = auditDeckSpec(missingConfirmedOutline);
assert.equal(missingOutlineAudit.ok, false, "缺少用户确认大纲时必须失败");
assert(missingOutlineAudit.errors.some((message) => message.includes("confirmedOutline")), "错误应指出缺少确认大纲");

const unauthorizedOutlineChange = structuredClone(validDeck);
unauthorizedOutlineChange.slides[1].title = "系统自行修改的标题";
const unauthorizedOutlineAudit = auditDeckSpec(unauthorizedOutlineChange);
assert.equal(unauthorizedOutlineAudit.ok, false, "未经用户授权修改页面结构必须失败");
assert(unauthorizedOutlineAudit.errors.some((message) => message.includes("有效确认大纲")), "错误应指出与有效确认大纲不一致");

const authorizedOutlineChange = structuredClone(unauthorizedOutlineChange);
const revisedPages = structuredClone(authorizedOutlineChange.confirmedOutline.initialPages);
revisedPages[1].title = "系统自行修改的标题";
authorizedOutlineChange.confirmedOutline.revisions.push({
  instructionRef: "user-requested-title-change",
  effectivePages: revisedPages,
});
assert.equal(auditDeckSpec(authorizedOutlineChange).ok, true, "用户明确提出并记录的结构修改应更新有效大纲");

const pureTextPage = structuredClone(validDeck);
pureTextPage.slides[1].modules = [pureTextPage.slides[1].modules[0]];
pureTextPage.confirmedOutline.initialPages[1].moduleTitles = ["规则"];
const pureTextAudit = auditDeckSpec(pureTextPage);
assert.equal(pureTextAudit.ok, false, "没有结构化证据的内容页必须失败");
assert(pureTextAudit.errors.some((message) => message.includes("只有正文/项目符号")), "错误应指出缺少结构化证据");
pureTextPage.slides[1].visualExemptionReason = "本页仅验证一条不可拆分的原文，内容无稳定字段和比较关系。";
assert.equal(auditDeckSpec(pureTextPage).ok, true, "说明纯叙述例外理由后应通过审计");

const labeledList = structuredClone(validDeck);
labeledList.slides[1].modules[1] = {
  title: "行动计划",
  bullets: ["任务A：完成方案", "任务B：组织评审", "任务C：提交成果"],
};
labeledList.confirmedOutline.initialPages[1].moduleTitles[1] = "行动计划";
const labeledListAudit = auditDeckSpec(labeledList);
assert.equal(labeledListAudit.ok, false, "多项标签说明不得退化为项目符号");
assert(labeledListAudit.errors.some((message) => message.includes("标签：说明")), "错误应建议使用matrix或table");

const missingColumn = structuredClone(validDeck);
missingColumn.slides[2].table.headerRows[0].shift();
for (const row of missingColumn.slides[2].table.rows) row.shift();
missingColumn.slides[2].table.colWidths.shift();
const missingColumnAudit = auditDeckSpec(missingColumn);
assert.equal(missingColumnAudit.ok, false, "删除最左列必须失败");
assert(missingColumnAudit.errors.some((message) => message.includes("列数不符")), "错误应指出列数不符");

const missingHeaderLevel = structuredClone(validDeck);
missingHeaderLevel.slides[2].table.headerRows.pop();
const missingHeaderAudit = auditDeckSpec(missingHeaderLevel);
assert.equal(missingHeaderAudit.ok, false, "删除子表头必须失败");
assert(missingHeaderAudit.errors.some((message) => message.includes("表头行数不符") || message.includes("多级表头")), "错误应指出多级表头不一致");

const transposedTable = structuredClone(validDeck);
transposedTable.slides[2].table.rows = transposedTable.slides[2].table.rows[0].map((_, column) => transposedTable.slides[2].table.rows.map((row) => row[column]));
const transposedAudit = auditDeckSpec(transposedTable);
assert.equal(transposedAudit.ok, false, "转置源表必须失败");
assert(transposedAudit.errors.some((message) => message.includes("正文二维矩阵")), "错误应指出正文矩阵或方向不一致");

const unauthorizedColumns = structuredClone(validDeck);
unauthorizedColumns.sourceManifest.contentGroups[0].preferredFlow = "single-column";
unauthorizedColumns.slides[1].layoutFlow = "single-column";
unauthorizedColumns.slides[1].columns = 2;
const columnsAudit = auditDeckSpec(unauthorizedColumns);
assert.equal(columnsAudit.ok, false, "单列内容被无故分栏必须失败");
assert(columnsAudit.errors.some((message) => message.includes("声明单列阅读流")), "错误应指出单列与columns冲突");

const unauthorizedPageSplit = structuredClone(validDeck);
unauthorizedPageSplit.slides.splice(2, 0, structuredClone(unauthorizedPageSplit.slides[1]));
const pageSplitAudit = auditDeckSpec(unauthorizedPageSplit);
assert.equal(pageSplitAudit.ok, false, "同一内容组被无依据拆页必须失败");
assert(pageSplitAudit.errors.some((message) => message.includes("默认应保持单页")), "错误应指出内容组被无依据拆页");

const pendingCapacityDecision = structuredClone(validDeck);
pendingCapacityDecision.sourceManifest.contentGroups[1].capacityStatus = "warning-pending";
pendingCapacityDecision.sourceManifest.contentGroups[1].capacityEvidence = {
  singlePageAttempts: [
    { strategy: "table-full-row", result: "still-overflow" },
    { strategy: "rows-three-column", result: "still-overflow" },
  ],
};
const pendingAudit = auditDeckSpec(pendingCapacityDecision);
assert.equal(pendingAudit.ok, false, "等待用户决定是否拆页时不得开始生成");
assert(pendingAudit.errors.some((message) => message.includes("等待用户决定")), "错误应提示先询问用户");

const approvedOverflow = structuredClone(validDeck);
approvedOverflow.sourceManifest.contentGroups[1].capacityStatus = "user-confirmed-no-split";
approvedOverflow.sourceManifest.contentGroups[1].overflowPolicy = "warn-and-proceed";
approvedOverflow.sourceManifest.contentGroups[1].overflowApprovalRef = "user-keeps-one-slide";
approvedOverflow.sourceManifest.contentGroups[1].capacityEvidence = {
  singlePageAttempts: [
    { strategy: "expand-table-region", result: "still-overflow" },
    { strategy: "table-full-row", result: "still-overflow" },
    { strategy: "rows-two-column", result: "still-overflow" },
    { strategy: "rows-three-column", result: "still-overflow" },
  ],
};
approvedOverflow.slides[2].overflowPolicy = "warn-and-proceed";
approvedOverflow.slides[2].overflowApprovalRef = "user-keeps-one-slide";
approvedOverflow.slides[2].table.splitMode = "none";
const approvedOverflowAudit = auditDeckSpec(approvedOverflow);
assert.equal(approvedOverflowAudit.ok, true, "用户明确坚持不拆页后，边界预警不应阻断内容审计");
assert(approvedOverflowAudit.warnings.some((message) => message.includes("用户确认不拆页")), "审计应保留不拆页警告");

const approvedButMissingContent = structuredClone(approvedOverflow);
approvedButMissingContent.slides[1].modules[0].body = "原文被删减。";
const approvedMissingAudit = auditDeckSpec(approvedButMissingContent);
assert.equal(approvedMissingAudit.ok, false, "不拆页授权不得豁免内容保真错误");
assert(approvedMissingAudit.errors.some((message) => message.includes("未原样")), "硬错误仍应指出原文缺失");

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

  const approvedOverflowInput = path.join(temporary, "approved-overflow.json");
  const approvedOverflowOutput = path.join(temporary, "approved-overflow.pptx");
  fs.writeFileSync(approvedOverflowInput, JSON.stringify(approvedOverflow, null, 2), "utf8");
  const approvedOverflowResult = await buildPptx({ inputPath: approvedOverflowInput, outputPath: approvedOverflowOutput, validate: true });
  assert.equal(approvedOverflowResult.ok, true, "用户坚持单页时应允许先生成文件");
  assert.equal(approvedOverflowResult.validation.ok, true, "经授权的边界问题不应变成结构硬错误");
  assert.equal(approvedOverflowResult.deliveryStatus, "generated-with-boundary-decision-pending", "交付状态应提示边界问题待用户决定");
  assert(approvedOverflowResult.validation.softBoundaryIssues.length > 0, "应记录实际边界问题");

  const threeWay = structuredClone(validDeck);
  const threeWayRows = Array.from({ length: 27 }, (_, index) => [String(index + 1), `记录${index + 1}`]);
  threeWay.sourceManifest.tables[0] = {
    id: "table-long",
    bodyRows: 27,
    logicalColumns: 2,
    headerRowCount: 1,
    rowHeaderColumns: 1,
    headerRowsData: [["序号", "内容"]],
    bodyRowsData: threeWayRows,
  };
  threeWay.slides[2].table = {
    sourceRef: "table-long",
    orientation: "source",
    rowHeaderColumns: 1,
    headers: ["序号", "内容"],
    rows: threeWayRows,
    colWidths: [0.8, 2.2],
    splitMode: "rows-three-column",
    splitReason: "单页重排后按正文行拆成三个并列表格。",
    approvalRef: "outline-approved",
  };
  const threeWayInput = path.join(temporary, "three-way.json");
  fs.writeFileSync(threeWayInput, JSON.stringify(threeWay, null, 2), "utf8");
  const threeWayResult = await buildPptx({ inputPath: threeWayInput, outputPath: path.join(temporary, "three-way.pptx"), validate: true });
  assert(threeWayResult.validation.tables >= 3, "三段横向拆表应生成至少三个表格对象");

  const tooWide = structuredClone(validDeck);
  const tooWideRows = rows(30, 7);
  const tooWideHeaders = ["序号", "字段A", "字段B", "字段C", "字段D", "字段E", "字段F"];
  tooWide.sourceManifest.tables[0] = {
    id: "table-long",
    bodyRows: 30,
    logicalColumns: 7,
    headerRowCount: 1,
    rowHeaderColumns: 1,
    headerRowsData: [tooWideHeaders],
    bodyRowsData: tooWideRows,
  };
  tooWide.sourceManifest.contentGroups[1] = {
    ...tooWide.sourceManifest.contentGroups[1],
    keepTogether: false,
    allowSlideSplit: true,
    capacityStatus: "split-approved",
    splitApprovalRef: "user-approved-pagination",
    capacityEvidence: {
      singlePageAttempted: true,
      requiredHeight: 10,
      availableHeight: 5.67,
      singlePageAttempts: [
        { strategy: "table-full-row", result: "still-overflow" },
        { strategy: "rows-two-column", result: "unreadable" },
        { strategy: "rows-three-column", result: "unreadable" },
      ],
    },
  };
  tooWide.slides[2].splitReason = "单页重排仍无法容纳，用户已同意拆页。";
  tooWide.slides[2].approvalRef = "user-approved-pagination";
  tooWide.slides[2].table = {
    sourceRef: "table-long",
    orientation: "source",
    rowHeaderColumns: 1,
    headers: tooWideHeaders,
    rows: tooWideRows,
    colWidths: [0.7, 1, 1, 1, 1, 1, 1],
    splitMode: "paginate",
    splitReason: "七列长表在单页无法保持10号字完整显示。",
    approvalRef: "outline-approved",
  };
  tooWide.confirmedOutline.revisions.push({
    instructionRef: "user-approved-pagination",
    effectivePages: outlinePagesFromSlides(expandOversizedTableSlides(tooWide.slides)),
  });
  const tooWideInput = path.join(temporary, "too-wide.json");
  fs.writeFileSync(tooWideInput, JSON.stringify(tooWide, null, 2), "utf8");
  const tooWideResult = await buildPptx({ inputPath: tooWideInput, outputPath: path.join(temporary, "too-wide.pptx"), validate: true });
  assert.equal(tooWideResult.ok, true);
  assert(tooWideResult.slides > validDeck.slides.length, "列数过多的超长独立表格必须自动拆成连续页面");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("ppt-maker runtime tests: passed");
