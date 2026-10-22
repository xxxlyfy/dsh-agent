#!/usr/bin/env node
/**
 * Dependency-free bundler for this plugin.
 *
 * esbuild's JavaScript API spawns its native binary through pipes, which the
 * DSH Windows sandbox forbids (spawn EPERM). TypeScript's compiler runs
 * in-process, so this script transpiles every `src/**\/*.ts` to CommonJS with
 * `ts.transpileModule`, maps relative imports statically, and emits one
 * CommonJS `main.js` with a tiny module registry. Imports without a leading
 * "." (obsidian, electron, node builtins) fall through to the host require.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const srcDir = path.join(projectDir, "src");
const entryFile = path.join(srcDir, "main.ts");
const outFile = path.join(projectDir, "main.js");

function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk(srcDir).sort();
const idByFile = new Map(files.map((file, index) => [file, index]));
const entryId = idByFile.get(entryFile);
if (entryId === undefined) throw new Error(`entry module not found: ${entryFile}`);

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: false,
  allowSyntheticDefaultImports: false,
  isolatedModules: true,
  sourceMap: false,
  inlineSourceMap: false,
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
  importHelpers: false,
};

/** @type {string[]} */
const defs = [];
/** @type {Array<Record<string, number>>} */
const deps = [];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions,
    fileName: file,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const message = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("\n");
    throw new Error(`transpile failed for ${path.relative(projectDir, file)}:\n${message}`);
  }

  /** @type {Record<string, number>} */
  const localDeps = {};
  for (const match of result.outputText.matchAll(/require\("(\.[^"]+)"\)/g)) {
    const specifier = match[1];
    if (specifier in localDeps) continue;
    const target = path.resolve(path.dirname(file), specifier);
    const targetId = idByFile.get(target);
    if (targetId === undefined) {
      throw new Error(
        `${path.relative(projectDir, file)} imports "${specifier}", which is not a source module (use an explicit .ts extension)`,
      );
    }
    localDeps[specifier] = targetId;
  }
  deps.push(localDeps);

  defs.push(
    `function (module, exports, require) {\n${result.outputText}\n}`,
  );
}

const banner = [
  "/*",
  " * DSH Agent for Obsidian - generated bundle.",
  " * Edit src/ and run `node scripts/build.mjs` (or `npm run build`).",
  " */",
  '"use strict";',
  "var __hostRequire =",
  '  typeof require === "function"',
  "    ? require",
  '    : function () { throw new Error("require is unavailable in this context"); };',
  "",
].join("\n");

const registry = [
  `var __modules = [\n${defs.join(",\n")}\n];`,
  `var __deps = ${JSON.stringify(deps)};`,
  "var __cache = Object.create(null);",
  "function __load(id) {",
  "  var cached = __cache[id];",
  "  if (cached) return cached.exports;",
  "  var module = { exports: {} };",
  "  __cache[id] = module;",
  "  var local = __deps[id] || {};",
  "  __modules[id](module, module.exports, function (spec) {",
  '    if (Object.prototype.hasOwnProperty.call(local, spec)) return __load(local[spec]);',
  "    return __hostRequire(spec);",
  "  });",
  "  return module.exports;",
  "}",
  `var __entry = __load(${entryId});`,
  "module.exports =",
  '  __entry && __entry.__esModule && __entry.default !== undefined ? __entry.default : __entry;',
  "",
].join("\n");

fs.writeFileSync(outFile, banner + registry, "utf8");
console.log(
  `built ${path.relative(projectDir, outFile)}: ${files.length} modules, ${(fs.statSync(outFile).size / 1024).toFixed(1)} KiB`,
);
