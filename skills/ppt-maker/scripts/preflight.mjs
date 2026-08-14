#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadPptxGenJS, scriptsDir, skillDir } from "./lib/pptxgen-loader.mjs";

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function commandExists(command) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
}

function checkPowerPoint() {
  if (process.platform !== "win32") return [];
  const candidates = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ]
    .filter(Boolean)
    .flatMap((base) => [
      path.join(base, "Microsoft Office", "root", "Office16", "POWERPNT.EXE"),
      path.join(base, "Microsoft Office", "Office16", "POWERPNT.EXE"),
    ]);
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

const checks = [];
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
checks.push({
  name: "Node.js >= 18",
  required: true,
  ok: nodeMajor >= 18,
  detail: process.version,
});

let runtime = null;
try {
  runtime = loadPptxGenJS();
  checks.push({
    name: "PptxGenJS",
    required: true,
    ok: true,
    detail: `${runtime.version} (${runtime.resolvedEntry})`,
  });
} catch (error) {
  checks.push({
    name: "PptxGenJS",
    required: true,
    ok: false,
    detail: error.message,
  });
}

for (const [name, relativePath, required] of [
  ["默认 Logo", "assets/logo.png", false],
  ["思源黑体 Regular", "assets/fonts/SourceHanSansSC-Regular.otf", false],
  ["思源黑体 Bold", "assets/fonts/SourceHanSansSC-Bold.otf", false],
]) {
  const absolutePath = path.join(skillDir, relativePath);
  checks.push({
    name,
    required,
    ok: fs.existsSync(absolutePath),
    detail: absolutePath,
  });
}

const renderers = {
  libreOffice: commandExists("soffice"),
  powerPoint: checkPowerPoint(),
  wps: [...commandExists("wps"), ...commandExists("wpp")],
};
checks.push({
  name: "可选视觉渲染器",
  required: false,
  ok: Object.values(renderers).some((items) => items.length > 0),
  detail: Object.entries(renderers)
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => `${name}: ${items.join(", ")}`)
    .join("; ") || "未发现 PowerPoint、LibreOffice 或 WPS；仍可生成并做结构校验。",
});

const result = {
  ok: checks.filter((check) => check.required).every((check) => check.ok),
  platform: `${os.platform()} ${os.release()} (${os.arch()})`,
  scriptsDir,
  skillDir,
  checks,
};

if (hasFlag("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`ppt-maker 预检：${result.ok ? "通过" : "失败"}`);
  console.log(`平台：${result.platform}`);
  for (const check of checks) {
    const mark = check.ok ? "✓" : check.required ? "✗" : "!";
    console.log(`${mark} ${check.name}: ${check.detail}`);
  }
}

process.exitCode = result.ok ? 0 : 2;
