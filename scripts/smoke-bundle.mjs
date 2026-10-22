#!/usr/bin/env node
/**
 * Loads the generated main.js with a stubbed `obsidian` module to verify that
 * the bundle is self-contained and exports the plugin class. This catches
 * bundling mistakes (missing local modules, ESM leftovers) without Obsidian.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class Stub {}

const obsidianStub = new Proxy(
  {},
  {
    get(target, property) {
      if (property === "__esModule") return true;
      if (property === "getLanguage") return () => "zh";
      if (!(property in target)) {
        target[property] = class ObsidianStub extends Stub {};
      }
      return target[property];
    },
  },
);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian" || request === "electron") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

const entry = require(path.join(projectDir, "main.js"));

if (typeof entry !== "function") {
  throw new Error(`main.js must export a plugin class, got ${typeof entry}`);
}
if (entry.name !== "DshChatPlugin") {
  throw new Error(`main.js exported ${entry.name || "(anonymous)"} instead of DshChatPlugin`);
}
console.log(`bundle ok: ${entry.name}, ${entry.length} constructor argument(s)`);
