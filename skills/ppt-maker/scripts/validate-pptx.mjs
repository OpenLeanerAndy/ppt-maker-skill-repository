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

export function validatePptx(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const errors = [];
  const warnings = [];

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
  const result = {
    ok: errors.length === 0,
    file: absolutePath,
    size: buffer.length,
    entries: entries.length,
    slides: slides.length,
    media: media.length,
    charts: charts.length,
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
