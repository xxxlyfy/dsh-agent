#!/usr/bin/env node
/**
 * Real-runtime smoke test: boots `dsh acp`, performs the ACP handshake, creates
 * a session, sends one prompt and prints the resulting updates.
 *
 * Usage:
 *   node scripts/smoke-acp.mjs                 # uses the real DSH_HOME
 *   node scripts/smoke-acp.mjs --home <dir>    # isolated DSH_HOME
 *   node scripts/smoke-acp.mjs --no-prompt     # handshake + session only
 *
 * The first run creates $DSH_HOME/profiles/acp inside the DSH home, which is
 * normal DSH behaviour. The plugin itself never writes there.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../src/acp/client.ts";
import {
  buildOverrideYaml,
  buildSpawnPlan,
  detectDesktopRoute,
  discoverLaunchers,
  resolveDshHome,
} from "../src/runtime.ts";

function parseArgs(argv) {
  const args = { home: "", prompt: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--home") args.home = argv[index + 1] ?? "";
    if (argv[index] === "--no-prompt") args.prompt = false;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const settings = {
  launcherPath: "",
  dshHome: args.home,
  provider: "",
  model: "",
  extraArgs: "",
  extraPatchYaml: "",
  debugLog: false,
};
const env = process.env;
const dshHome = resolveDshHome(settings.dshHome, env, homedir());
const discovery = discoverLaunchers(settings, {
  platform: process.platform,
  env,
  home: homedir(),
  exists: existsSync,
});
if (discovery.length === 0) {
  console.error("smoke: no DeepSeek Harness launcher found");
  process.exit(2);
}
const launcher = discovery[0];
console.log(`smoke: launcher ${launcher.launcher} (${launcher.source})`);
console.log(`smoke: DSH_HOME ${dshHome}`);

const route = detectDesktopRoute(dshHome, (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
});
console.log(`smoke: route ${route ? `${route.provider}/${route.model}` : "(profile default)"}`);
const override = buildOverrideYaml(route, "");
let cliArgs = ["acp"];
if (override) {
  const dir = join(process.cwd(), "runtime");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "smoke-override.yml");
  writeFileSync(file, override, "utf8");
  cliArgs = ["acp", "--patch", file];
  console.log(`smoke: override ${file}`);
}

const plan = buildSpawnPlan({
  launcher,
  platform: process.platform,
  env: { ...env, DSH_HOME: dshHome },
  cliArgs,
  exists: existsSync,
});
console.log(`smoke: spawn ${plan.display}`);
const child = spawn(plan.command, plan.args, {
  cwd: process.cwd(),
  env: plan.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  shell: plan.shell === true,
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(`[stderr] ${chunk}`));

let updates = 0;
const client = new AcpClient({
  input: child.stdout,
  output: child.stdin,
  clientName: "dsh-chat-smoke",
  clientVersion: "0.1.0",
  onUpdate: (params) => {
    updates += 1;
    const update = params.update ?? {};
    const text = update.content?.text;
    console.log(
      `smoke: update ${String(update.sessionUpdate)}${text ? ` ${JSON.stringify(text)}` : ""}`,
    );
  },
  onPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
});

const timer = setTimeout(() => {
  console.error("smoke: timed out after 180s");
  try {
    child.kill();
  } catch {
    // ignore
  }
  process.exit(3);
}, 180_000);
timer.unref();

try {
  const init = await client.initialize();
  console.log(
    `smoke: initialized protocol=${init.protocolVersion} agent=${init.agentInfo?.name ?? "?"} ` +
      `caps=${JSON.stringify(client.sessionCapabilities)}`,
  );
  const list = await client.listSessions();
  console.log(`smoke: sessions in store: ${(list.sessions ?? []).length}`);

  const session = await client.newSession(process.cwd(), []);
  console.log(`smoke: session ${session.sessionId}`);
  for (const option of session.configOptions ?? []) {
    console.log(`smoke: option ${option.id}=${option.currentValue ?? "?"}`);
  }

  if (args.prompt) {
    const result = await client.prompt(session.sessionId, [
      { type: "text", text: "Reply with exactly the two characters: OK" },
    ]);
    console.log(`smoke: stopReason=${result.stopReason} updates=${updates}`);
  }
  await client.closeSession(session.sessionId);
  console.log("smoke: OK");
  child.stdin.end();
  process.exit(0);
} catch (error) {
  console.error("smoke: FAILED", error);
  try {
    child.kill();
  } catch {
    // ignore
  }
  process.exit(1);
}
