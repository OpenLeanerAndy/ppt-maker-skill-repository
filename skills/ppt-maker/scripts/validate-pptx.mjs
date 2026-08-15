#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REQUIRED_ENTRIES = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/app.xml",
  "docProps/core.xml",
  "ppt/presentation.xml",
  "ppt/_rels/presentation.xml.rels",
];

function parseArgs(argv) {
  const args = { file: null, expectedSlides: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--expected-slides") {
      args.expectedSlides = Number.parseInt(argv[++index], 10);
    } else if (token === "--json") {
      args.json = true;
    } else if (!token.startsWith("-") && !args.file) {
      args.file = token;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  if (!args.file) {
    throw new Error("用法：node validate-pptx.mjs <file.pptx> [--expected-slides N] [--json]");
  }
  return args;
}
function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function parseZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("找不到 ZIP 中央目录，文件可能损坏或不是 PPTX。 ");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`中央目录第 ${index + 1} 项签名无效。`);
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({
      name,
      compression,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (offset !== centralOffset + centralSize) {
    throw new Error("ZIP 中央目录长度不一致。 ");
  }
  return entries;
}

function readEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`本地文件头无效：${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.compression}：${entry.name}`);
}

function naturalSlideNumber(name) {
  const match = name.match(/slide(\d+)\.xml$/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function xmlNumber(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}="(-?\\d+)"`));
  return match ? Number.parseInt(match[1], 10) : null;
}

function slideBoundsIssues(xml, slideWidth, slideHeight) {
  const issues = [];
  const pattern = /<a:off\b([^>]*)\/>[\s\S]{0,320}?<a:ext\b([^>]*)\/>/g;
  for (const match of xml.matchAll(pattern)) {
    const x = xmlNumber(match[1], "x");
    const y = xmlNumber(match[1], "y");
    const width = xmlNumber(match[2], "cx");
    const height = xmlNumber(match[2], "cy");
    if ([x, y, width, height].some((value) => value === null)) continue;
    const tolerance = 1000;
    if (x < -tolerance || y < -tolerance || x + width > slideWidth + tolerance || y + height > slideHeight + tolerance) {
      issues.push({ x, y, width, height });
    }
  }
  return issues;
}

function tableRenderedBoundsIssues(xml, slideHeight) {
  const issues = [];
  const frames = [...xml.matchAll(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g)];
  let tableIndex = 0;
  for (const frameMatch of frames) {
    const frame = frameMatch[0];
    if (!frame.includes("<a:tbl>")) continue;
    tableIndex += 1;
    const offset = frame.match(/<a:off\b([^>]*)\/>/);
    const extent = frame.match(/<a:ext\b([^>]*)\/>/);
    if (!offset || !extent) continue;
    const y = xmlNumber(offset[1], "y");
    const frameHeight = xmlNumber(extent[1], "cy");
    const rowHeights = [...frame.matchAll(/<a:tr\b([^>]*)>/g)]
      .map((match) => xmlNumber(match[1], "h"))
      .filter((value) => value !== null);
    if (y === null || frameHeight === null || rowHeights.length === 0) continue;
    const renderedHeight = rowHeights.reduce((sum, value) => sum + value, 0);
    const tolerance = 1000;
    if (renderedHeight > frameHeight + tolerance) {
      issues.push({ table: tableIndex, type: "rows-exceed-frame", y, frameHeight, renderedHeight });
    }
    if (y + renderedHeight > slideHeight + tolerance) {
      issues.push({ table: tableIndex, type: "rows-exceed-slide", y, frameHeight, renderedHeight });
    }
  }
  return issues;
}

export function validatePptx(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const errors = [];
  const warnings = [];
  const allowedOverflowSlides = new Set((options.allowedOverflowSlides ?? []).map(Number));
  const softBoundaryIssues = [];

  if (!fs.existsSync(absolutePath)) {
    return { ok: false, file: absolutePath, errors: ["文件不存在。"], warnings };
  }
  if (path.extname(absolutePath).toLowerCase() !== ".pptx") {
    errors.push("文件扩展名不是 .pptx。");
  }

  const buffer = fs.readFileSync(absolutePath);
  if (buffer.length < 100) errors.push("文件过小，不像有效 PPTX。");

  let entries = [];
  try {
    entries = parseZip(buffer);
  } catch (error) {
    errors.push(error.message);
    return { ok: false, file: absolutePath, size: buffer.length, errors, warnings };
  }

  const names = entries.map((entry) => entry.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) errors.push("ZIP 中存在重名条目。");
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..")) {
      errors.push(`发现不安全的 ZIP 路径：${name}`);
    }
  }

  const entryMap = new Map(entries.map((entry) => [entry.name, entry]));
  for (const required of REQUIRED_ENTRIES) {
    const entry = entryMap.get(required);
    if (!entry) errors.push(`缺少必要条目：${required}`);
    else if (entry.uncompressedSize === 0) errors.push(`必要条目为空：${required}`);
  }

  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((left, right) => naturalSlideNumber(left.name) - naturalSlideNumber(right.name));
  if (slides.length === 0) errors.push("未发现任何幻灯片页面。 ");
  if (Number.isInteger(options.expectedSlides) && slides.length !== options.expectedSlides) {
    errors.push(`页数不符：预期 ${options.expectedSlides} 页，实际 ${slides.length} 页。`);
  }

  let slideWidth = null;
  let slideHeight = null;
  let tableCount = 0;
  const slideTableCounts = [];
  const slideTableRenderedBounds = [];
  try {
    const presentationEntry = entryMap.get("ppt/presentation.xml");
    if (presentationEntry) {
      const xml = readEntry(buffer, presentationEntry).toString("utf8");
      const size = xml.match(/<p:sldSz\b([^>]*)\/>/);
      if (size) {
        slideWidth = xmlNumber(size[1], "cx");
        slideHeight = xmlNumber(size[1], "cy");
      }
    }
    if (slideWidth && slideHeight) {
      for (const slide of slides) {
        const xml = readEntry(buffer, slide).toString("utf8");
        const slideNumber = naturalSlideNumber(slide.name);
        const boundaryIsSoft = allowedOverflowSlides.has(slideNumber);
        const tablesOnSlide = [...xml.matchAll(/<a:tbl>/g)].length;
        tableCount += tablesOnSlide;
        slideTableCounts.push({ slide: naturalSlideNumber(slide.name), tables: tablesOnSlide });
        const bounds = slideBoundsIssues(xml, slideWidth, slideHeight);
        if (bounds.length > 0) {
          const message = `${slide.name} 有 ${bounds.length} 个对象超出页面边界。`;
          if (boundaryIsSoft) {
            warnings.push(`用户确认不拆页：${message}`);
            softBoundaryIssues.push({ slide: slideNumber, type: "object-outside-slide", count: bounds.length });
          } else errors.push(message);
        }
        const renderedBounds = tableRenderedBoundsIssues(xml, slideHeight);
        if (renderedBounds.length > 0) {
          slideTableRenderedBounds.push({ slide: naturalSlideNumber(slide.name), issues: renderedBounds });
          const frameIssues = renderedBounds.filter((issue) => issue.type === "rows-exceed-frame").length;
          const slideIssues = renderedBounds.filter((issue) => issue.type === "rows-exceed-slide").length;
          if (frameIssues > 0) {
            const message = `${slide.name} 有 ${frameIssues} 个表格的实际行高之和超出表格对象框，可能越过所属模块。`;
            if (boundaryIsSoft) {
              warnings.push(`用户确认不拆页：${message}`);
              softBoundaryIssues.push({ slide: slideNumber, type: "table-rows-outside-frame", count: frameIssues });
            } else errors.push(message);
          }
          if (slideIssues > 0) {
            const message = `${slide.name} 有 ${slideIssues} 个表格按实际行高计算超出页面下边界。`;
            if (boundaryIsSoft) {
              warnings.push(`用户确认不拆页：${message}`);
              softBoundaryIssues.push({ slide: slideNumber, type: "table-rows-outside-slide", count: slideIssues });
            } else errors.push(message);
          }
        }
      }
    } else warnings.push("无法读取幻灯片尺寸，未执行对象边界检查。 ");
  } catch (error) {
    errors.push(`对象边界检查失败：${error.message}`);
  }

  try {
    const presentationEntry = entryMap.get("ppt/presentation.xml");
    const relationshipsEntry = entryMap.get("ppt/_rels/presentation.xml.rels");
    if (presentationEntry && relationshipsEntry) {
      const presentationXml = readEntry(buffer, presentationEntry).toString("utf8");
      const relationshipsXml = readEntry(buffer, relationshipsEntry).toString("utf8");
      const relationshipIds = [...presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
        .map((match) => match[1]);
      const slideTargets = new Map(
        [...relationshipsXml.matchAll(/<Relationship\b([^>]+)>/g)]
          .map((match) => match[1])
          .map((attributes) => ({
            id: attributes.match(/\bId="([^"]+)"/)?.[1],
            target: attributes.match(/\bTarget="([^"]+)"/)?.[1],
            type: attributes.match(/\bType="([^"]+)"/)?.[1],
          }))
          .filter((rel) => rel.id && rel.type?.endsWith("/slide"))
          .map((rel) => [rel.id, rel.target]),
      );
      for (const id of relationshipIds) {
        if (!slideTargets.has(id)) errors.push(`页面关系缺失：${id}`);
      }
      if (relationshipIds.length !== slides.length) {
        errors.push(`presentation.xml 声明 ${relationshipIds.length} 页，但 ZIP 中有 ${slides.length} 页。`);
      }
    }
  } catch (error) {
    errors.push(`无法解析演示文稿关系：${error.message}`);
  }

  const media = entries.filter((entry) => entry.name.startsWith("ppt/media/") && !entry.name.endsWith("/"));
  const charts = entries.filter((entry) => /^ppt\/charts\/chart\d+\.xml$/.test(entry.name));
  const duplicateMedia = new Map();
  for (const entry of media) {
    const key = `${entry.crc32}:${entry.uncompressedSize}`;
    duplicateMedia.set(key, [...(duplicateMedia.get(key) ?? []), entry.name]);
  }
  const duplicateMediaGroups = [...duplicateMedia.values()].filter((group) => group.length > 1);
  if (duplicateMediaGroups.length > 0) warnings.push(`发现 ${duplicateMediaGroups.length} 组重复媒体资源，可考虑通过幻灯片母版复用。`);
  const result = {
    ok: errors.length === 0,
    scope: "structural",
    visualInspectionRequired: true,
    file: absolutePath,
    size: buffer.length,
    entries: entries.length,
    slides: slides.length,
    media: media.length,
    duplicateMediaGroups: duplicateMediaGroups.length,
    charts: charts.length,
    tables: tableCount,
    slideTableCounts,
    slideTableRenderedBounds,
    softBoundaryIssues,
    errors,
    warnings,
  };
  return result;
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`PPTX 结构校验：${result.ok ? "通过" : "失败"}`);
  console.log("范围：仅ZIP/OOXML结构与可计算边界；仍须渲染全部页面完成视觉验收。");
  console.log(`文件：${result.file}`);
  if (result.size !== undefined) console.log(`大小：${result.size} 字节`);
  if (result.slides !== undefined) {
    console.log(`页面：${result.slides}；媒体：${result.media}；图表：${result.charts}`);
  }
  for (const warning of result.warnings ?? []) console.log(`警告：${warning}`);
  for (const error of result.errors ?? []) console.error(`错误：${error}`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = validatePptx(args.file, { expectedSlides: args.expectedSlides });
    printResult(result, args.json);
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
