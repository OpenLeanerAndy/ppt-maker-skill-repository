#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { input: null, output: null, width: 1600, height: 900, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input" || token === "-i") args.input = argv[++index];
    else if (token === "--output" || token === "-o") args.output = argv[++index];
    else if (token === "--width") args.width = Number.parseInt(argv[++index], 10);
    else if (token === "--height") args.height = Number.parseInt(argv[++index], 10);
    else if (token === "--json") args.json = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (!args.input || !args.output) throw new Error("用法：node render-pptx.mjs --input deck.pptx --output <空目录> [--width 1600 --height 900] [--json]");
  if (![args.width, args.height].every((value) => Number.isInteger(value) && value >= 320 && value <= 7680)) {
    throw new Error("渲染宽高必须是 320–7680 之间的整数。 ");
  }
  return args;
}

function commandPaths(command) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
}

function requireEmptyDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length > 0) throw new Error(`输出目录必须为空：${directory}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || result.error?.message || `${command} 执行失败`).trim());
  return result.stdout.trim();
}

function renderWithPowerPoint(input, output, width, height) {
  const shell = commandPaths("powershell.exe")[0] ?? commandPaths("pwsh.exe")[0];
  if (!shell) throw new Error("找不到 PowerShell，无法调用 PowerPoint COM。 ");
  run(shell, [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    path.join(scriptsDir, "render-pptx.ps1"),
    "-InputPath",
    input,
    "-OutputDirectory",
    output,
    "-Width",
    String(width),
    "-Height",
    String(height),
  ]);
  return "PowerPoint COM";
}

function renderWithLibreOffice(input, output) {
  const soffice = commandPaths("soffice")[0];
  const pdftoppm = commandPaths("pdftoppm")[0];
  if (!soffice || !pdftoppm) throw new Error("LibreOffice 渲染需要同时具备 soffice 和 pdftoppm。 ");
  run(soffice, ["--headless", "--convert-to", "pdf", "--outdir", output, input]);
  const pdf = path.join(output, `${path.basename(input, path.extname(input))}.pdf`);
  if (!fs.existsSync(pdf)) throw new Error(`LibreOffice 未生成 PDF：${pdf}`);
  run(pdftoppm, ["-png", "-r", "144", pdf, path.join(output, "slide")]);
  return "LibreOffice + pdftoppm";
}

try {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input);
  const output = path.resolve(args.output);
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new Error(`PPTX 文件不存在：${input}`);
  if (path.extname(input).toLowerCase() !== ".pptx") throw new Error(`输入文件必须是 .pptx：${input}`);
  requireEmptyDirectory(output);

  let renderer;
  if (process.platform === "win32" && commandPaths("powershell.exe").length > 0) {
    try {
      renderer = renderWithPowerPoint(input, output, args.width, args.height);
    } catch (powerPointError) {
      if (commandPaths("soffice").length === 0) throw powerPointError;
      renderer = renderWithLibreOffice(input, output);
    }
  } else renderer = renderWithLibreOffice(input, output);

  const pages = fs.readdirSync(output).filter((name) => /\.(png)$/i.test(name)).length;
  if (pages === 0) throw new Error("渲染器未生成任何 PNG 页面。 ");
  const result = { ok: true, input, output, renderer, pages };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`渲染完成：${pages} 页；渲染器：${renderer}；目录：${output}`);
} catch (error) {
  console.error(`渲染失败：${error.message}`);
  process.exitCode = 2;
}
