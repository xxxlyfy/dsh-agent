import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildOverrideYaml,
  buildSpawnPlan,
  deriveDesktopRuntime,
  detectDesktopRoute,
  discoverLaunchers,
  parseDefaultModelPatch,
  resolveDshHome,
  splitArgs,
} from "../src/runtime.ts";

const home = "C:\\Users\\me";
const install = join(home, "AppData", "Local", "Programs", "DeepSeek Harness");
const launcher = join(install, "resources", "runtime", "cli", "bin", "dsh.cmd");
const electron = join(install, "DeepSeek Harness.exe");
const cliScript = join(
  install,
  "resources",
  "app.asar",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "cli.js",
);

const settings = {
  launcherPath: "",
  dshHome: "",
  provider: "",
  model: "",
  extraArgs: "",
  extraPatchYaml: "",
  debugLog: false,
};

test("discovers configured, PATH and desktop launchers in order", () => {
  const pathShim = join("C:\\tools", "dsh.cmd");
  const deps = {
    platform: "win32",
    env: { LOCALAPPDATA: join(home, "AppData", "Local"), Path: "C:\\tools" },
    home,
    exists: (candidate) => candidate === pathShim || candidate === launcher,
  };
  const found = discoverLaunchers(settings, deps);
  assert.deepEqual(
    found.map((entry) => [entry.launcher, entry.kind, entry.source]),
    [
      [pathShim, "cli", "path"],
      [launcher, "desktop", "desktop-install"],
    ],
  );

  const configured = discoverLaunchers({ ...settings, launcherPath: launcher }, deps);
  assert.equal(configured[0].source, "setting");
  assert.equal(configured.filter((entry) => entry.launcher === launcher).length, 1);
});

test("derives the packaged Electron executable and CLI script", () => {
  const paths = deriveDesktopRuntime(launcher, "win32", (candidate) => {
    return candidate === cliScript || candidate === electron;
  });
  assert.ok(paths);
  assert.equal(paths.electronExecutable, electron);
  assert.equal(paths.cliScript, cliScript);

  // Inside app.asar only the archive itself is visible to the filesystem.
  const archive = join(install, "resources", "app.asar");
  const fromArchive = deriveDesktopRuntime(launcher, "win32", (candidate) => {
    return candidate === archive || candidate === electron;
  });
  assert.ok(fromArchive);
  assert.equal(fromArchive.cliScript, cliScript);

  assert.equal(deriveDesktopRuntime(launcher, "win32", () => false), null);
});

test("plans a direct Electron spawn for desktop installs", () => {
  const plan = buildSpawnPlan({
    launcher: { launcher, kind: "desktop", source: "desktop-install" },
    platform: "win32",
    env: { Path: "C:\\Windows" },
    cliArgs: ["acp", "--patch", "C:\\vault\\override.yml"],
    exists: (candidate) => candidate === cliScript || candidate === electron,
  });
  assert.equal(plan.mode, "desktop-electron");
  assert.equal(plan.command, electron);
  assert.deepEqual(plan.args, [
    "--expose-internals",
    cliScript,
    "acp",
    "--patch",
    "C:\\vault\\override.yml",
  ]);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(plan.env.DSH_DESKTOP_NODE_EXECUTABLE, electron);
});

test("falls back to a shell command for a bare Windows launcher", () => {
  const plan = buildSpawnPlan({
    launcher: { launcher: "C:\\Program Files\\tool dir\\dsh.cmd", kind: "cli", source: "setting" },
    platform: "win32",
    env: {},
    cliArgs: ["acp"],
    exists: () => false,
  });
  assert.equal(plan.mode, "windows-cmd");
  assert.equal(plan.shell, true);
  assert.deepEqual(plan.args, []);
  assert.ok(plan.command.startsWith('"C:\\Program Files\\tool dir\\dsh.cmd"'));
  assert.ok(plan.command.endsWith("acp"));
});

test("spawns a plain executable directly", () => {
  const plan = buildSpawnPlan({
    launcher: { launcher: "/usr/local/bin/dsh", kind: "cli", source: "path" },
    platform: "linux",
    env: {},
    cliArgs: ["acp"],
    exists: () => false,
  });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.command, "/usr/local/bin/dsh");
  assert.deepEqual(plan.args, ["acp"]);
});

test("splits launcher arguments with quoting", () => {
  assert.deepEqual(splitArgs('--patch "C:\\a b\\c.yml" --flag'), [
    "--patch",
    "C:\\a b\\c.yml",
    "--flag",
  ]);
  assert.deepEqual(splitArgs("   "), []);
  assert.deepEqual(splitArgs("'single quoted' plain"), ["single quoted", "plain"]);
});

test("resolves DSH_HOME with the documented precedence", () => {
  assert.equal(resolveDshHome("D:\\home", { DSH_HOME: "E:\\env" }, "C:\\Users\\me"), "D:\\home");
  assert.equal(resolveDshHome("", { DSH_HOME: "E:\\env" }, "C:\\Users\\me"), "E:\\env");
  assert.equal(resolveDshHome("", {}, "C:\\Users\\me"), join("C:\\Users\\me", ".dsh"));
});

const desktopPatch = `# Your patch layer for this dsh profile
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: "deepseek-account"  # account route
    model: 'deepseek-flash'
    reasoningEffort: high

- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: compact
`;

test("parses the desktop profile's pinned model route", () => {
  assert.deepEqual(parseDefaultModelPatch(desktopPatch), {
    provider: "deepseek-account",
    model: "deepseek-flash",
  });
  assert.equal(parseDefaultModelPatch("- id: other\n  config:\n    provider: p\n"), null);
  assert.equal(parseDefaultModelPatch("- id: agent-default-model\n  config:\n    provider: p\n"), null);
});

test("detects the desktop route before the web route", () => {
  const desktopFile = join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
  const webFile = join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
  const files = new Map([
    [desktopFile, desktopPatch],
    [webFile, "- id: agent-default-model\n  config:\n    provider: web-provider\n    model: web-model\n"],
  ]);
  const route = detectDesktopRoute(join(home, ".dsh"), (file) => files.get(file) ?? null);
  assert.deepEqual(route, { provider: "deepseek-account", model: "deepseek-flash" });

  const webOnly = detectDesktopRoute(join(home, ".dsh"), (file) => {
    if (file === webFile) return files.get(webFile);
    return null;
  });
  assert.deepEqual(webOnly, { provider: "web-provider", model: "web-model" });

  assert.equal(detectDesktopRoute(join(home, ".dsh"), () => null), null);
});

test("builds the generated --patch overlay", () => {
  const yaml = buildOverrideYaml({ provider: "deepseek-account", model: "deepseek-flash" }, "");
  assert.ok(yaml);
  assert.match(yaml, /- id: acp\n  name: '@deepseek-ai\/dsh-acp'/u);
  assert.match(yaml, /provider: "deepseek-account"/u);
  assert.match(yaml, /model: "deepseek-flash"/u);

  const extra = buildOverrideYaml(null, "- id: deepseek-account\n  config:\n    desktopPlatform: win32");
  assert.ok(extra);
  assert.match(extra, /desktopPlatform: win32/u);

  assert.equal(buildOverrideYaml(null, "   "), null);
});
