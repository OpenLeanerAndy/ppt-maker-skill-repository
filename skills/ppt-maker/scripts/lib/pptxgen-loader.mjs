import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const scriptsDir = path.resolve(moduleDir, "..");
export const skillDir = path.resolve(scriptsDir, "..");

function npmGlobalRoot() {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    return execFileSync(npm, ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function candidateModuleRoots() {
  const roots = [
    path.join(scriptsDir, "node_modules"),
    path.join(scriptsDir, "vendor", "node_modules"),
    path.join(skillDir, "node_modules"),
    path.join(process.cwd(), "node_modules"),
    path.join(os.homedir(), "node_modules"),
    npmGlobalRoot(),
  ];

  if (process.env.NODE_PATH) {
    roots.push(...process.env.NODE_PATH.split(path.delimiter));
  }

  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

function findPackageJson(resolvedEntry) {
  let current = path.dirname(resolvedEntry);
  while (current !== path.dirname(current)) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
        if (parsed.name === "pptxgenjs") return { packageJson, parsed };
      } catch {
        // Continue walking in case this package.json belongs to a nested dependency.
      }
    }
    current = path.dirname(current);
  }
  return null;
}

export function loadPptxGenJS() {
  const attempts = [];

  for (const root of candidateModuleRoots()) {
    const resolver = createRequire(path.join(root, "__ppt_maker_resolver.cjs"));
    try {
      const resolvedEntry = resolver.resolve("pptxgenjs");
      const PptxGenJS = resolver("pptxgenjs");
      const packageInfo = findPackageJson(resolvedEntry);
      return {
        PptxGenJS,
        resolvedEntry,
        version: packageInfo?.parsed?.version ?? "unknown",
        license: packageInfo?.parsed?.license ?? "unknown",
        moduleRoot: root,
      };
    } catch (error) {
      attempts.push({ root, message: error?.message ?? String(error) });
    }
  }

  const installCommand = `npm ci --prefix "${scriptsDir}" --ignore-scripts`;
  const error = new Error(
    `找不到 PptxGenJS。请在获得用户许可后运行：${installCommand}`,
  );
  error.code = "PPTXGENJS_NOT_FOUND";
  error.attempts = attempts;
  error.installCommand = installCommand;
  throw error;
}
