#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { auditDeckSpec } from "./lib/deck-audit.mjs";

function parseArgs(argv) {
  const args = { input: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input" || token === "-i") args.input = argv[++index];
    else if (token === "--json") args.json = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.input) throw new Error("用法：node audit-deck.mjs --input deck.json [--json]");
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const absoluteInput = path.resolve(args.input);
  if (!fs.existsSync(absoluteInput)) throw new Error(`输入文件不存在：${absoluteInput}`);
  const deck = JSON.parse(fs.readFileSync(absoluteInput, "utf8"));
  const result = auditDeckSpec(deck, { inputDir: path.dirname(absoluteInput) });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`内容保真审计：${result.ok ? "通过" : "失败"}`);
    console.log(`必需条目：${result.stats.requiredItems ?? 0}；已引用：${result.stats.referencedItems ?? 0}`);
    for (const warning of result.warnings) console.log(`警告：${warning}`);
    for (const error of result.errors) console.error(`错误：${error}`);
  }
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
