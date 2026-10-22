/**
 * Discovers the DeepSeek Harness launcher, spawns `dsh acp`, and owns its
 * lifecycle. Path/spawn planning is pure and unit-tested; the class performs
 * the actual child-process work.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { AcpClient } from "./acp/client.ts";
import type {
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionUpdateParams,
} from "./acp/protocol.ts";

export type RuntimePhase = "idle" | "probing" | "starting" | "ready" | "error" | "stopped";

export interface RuntimeStatus {
  phase: RuntimePhase;
  detail: string;
  firstStart: boolean;
}

export interface RuntimeSettings {
  launcherPath: string;
  dshHome: string;
  provider: string;
  model: string;
  extraArgs: string;
  extraPatchYaml: string;
  debugLog: boolean;
}

export interface LauncherInfo {
  launcher: string;
  kind: "desktop" | "cli";
  source: string;
}

export interface DesktopRuntimePaths {
  electronExecutable: string;
  cliScript: string;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  display: string;
  mode: "desktop-electron" | "windows-cmd" | "direct";
  /** True when the command is a full shell command line (Windows .cmd shims). */
  shell?: boolean;
}

export interface DesktopRoute {
  provider: string;
  model: string;
}

export interface DiscoveryDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => boolean;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  launcher?: string;
}

const RUNTIME_RELATIVE = ["resources", "runtime", "cli", "bin"];
const CLI_SCRIPT_RELATIVE = [
  "app.asar",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-desktop-host",
  "lib",
  "cli.js",
];
const MAX_LOG_LINES = 400;

function pathDirectories(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = platform === "win32" ? env.Path ?? env.PATH ?? "" : env.PATH ?? "";
  return raw.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function commandNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.bat"] : ["dsh"];
}

function desktopLauncherCandidates(deps: DiscoveryDeps): Array<{ launcher: string; source: string }> {
  const { platform, env, home } = deps;
  const candidates: Array<{ launcher: string; source: string }> = [];
  if (platform === "win32") {
    const roots = [
      env.LOCALAPPDATA,
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const root of roots) {
      candidates.push({
        launcher: join(root, "Programs", "DeepSeek Harness", ...RUNTIME_RELATIVE, "dsh.cmd"),
        source: "desktop-install",
      });
      candidates.push({
        launcher: join(root, "DeepSeek Harness", ...RUNTIME_RELATIVE, "dsh.cmd"),
        source: "desktop-install",
      });
    }
  } else if (platform === "darwin") {
    for (const root of ["/Applications", join(home, "Applications")]) {
      candidates.push({
        launcher: join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"),
        source: "desktop-install",
      });
    }
  } else {
    for (const root of [
      "/opt/DeepSeek Harness",
      "/usr/lib/deepseek-harness",
      join(home, ".local", "share", "deepseek-harness"),
    ]) {
      candidates.push({
        launcher: join(root, "resources", "runtime", "cli", "bin", "dsh"),
        source: "desktop-install",
      });
    }
  }
  return candidates;
}

/** Ordered launcher candidates: explicit setting, PATH, then desktop installs. */
export function discoverLaunchers(settings: RuntimeSettings, deps: DiscoveryDeps): LauncherInfo[] {
  const out: LauncherInfo[] = [];
  const configured = settings.launcherPath.trim();
  if (configured.length > 0) {
    out.push({ launcher: configured, kind: "cli", source: "setting" });
  }
  for (const directory of pathDirectories(deps.env, deps.platform)) {
    for (const name of commandNames(deps.platform)) {
      const candidate = join(directory, name);
      if (deps.exists(candidate)) {
        out.push({ launcher: candidate, kind: "cli", source: "path" });
      }
    }
  }
  for (const candidate of desktopLauncherCandidates(deps)) {
    if (deps.exists(candidate.launcher)) {
      out.push({ launcher: candidate.launcher, kind: "desktop", source: candidate.source });
    }
  }
  const unique: LauncherInfo[] = [];
  const seen = new Set<string>();
  for (const info of out) {
    const key = deps.platform === "win32" ? info.launcher.toLowerCase() : info.launcher;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(info);
  }
  return unique;
}

/** Derive the packaged Electron executable and CLI script from a desktop launcher path. */
export function deriveDesktopRuntime(
  launcher: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): DesktopRuntimePaths | null {
  const binDir = dirname(launcher);
  const resourcesDir = resolve(binDir, "..", "..", "..");
  const archive = join(resourcesDir, "app.asar");
  const cliScript = join(resourcesDir, ...CLI_SCRIPT_RELATIVE);
  // Files inside app.asar are virtual to the OS, so accept the archive itself.
  if (!exists(cliScript) && !exists(archive)) return null;
  if (platform === "darwin") {
    const electronExecutable = resolve(resourcesDir, "..", "MacOS", "DeepSeek Harness");
    return { electronExecutable, cliScript };
  }
  const installDir = resolve(resourcesDir, "..");
  const electronExecutable =
    platform === "win32"
      ? join(installDir, "DeepSeek Harness.exe")
      : join(installDir, "deepseek-harness");
  if (platform === "win32" && !exists(electronExecutable)) return null;
  return { electronExecutable, cliScript };
}

function quoteWindowsCommand(parts: string[]): string {
  return parts
    .map((part) => (/[\s"]/u.test(part) ? `"${part.replace(/"/g, '""')}"` : part))
    .join(" ");
}

/** Build the concrete spawn plan for a launcher and app arguments. */
export function buildSpawnPlan(input: {
  launcher: LauncherInfo;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  cliArgs: string[];
  exists?: (path: string) => boolean;
}): SpawnPlan {
  const exists = input.exists ?? existsSync;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (typeof value === "string") env[key] = value;
  }
  const desktop = deriveDesktopRuntime(input.launcher.launcher, input.platform, exists);

  if (desktop && input.platform === "win32") {
    return {
      command: desktop.electronExecutable,
      args: ["--expose-internals", desktop.cliScript, ...input.cliArgs],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        DSH_DESKTOP_NODE_EXECUTABLE: desktop.electronExecutable,
      },
      display: `${desktop.electronExecutable} ${input.cliArgs.join(" ")}`,
      mode: "desktop-electron",
    };
  }

  if (desktop) {
    return {
      command: input.launcher.launcher,
      args: [...input.cliArgs],
      env: { ...env, DSH_DESKTOP_NODE_EXECUTABLE: desktop.electronExecutable },
      display: `${input.launcher.launcher} ${input.cliArgs.join(" ")}`,
      mode: "direct",
    };
  }

  const isWindowsScript = input.platform === "win32" && /\.(cmd|bat)$/iu.test(input.launcher.launcher);
  if (isWindowsScript) {
    // cmd.exe shims must run through the shell. Node wraps this single command
    // string in `cmd.exe /d /s /c "…"` with verbatim argument handling.
    return {
      command: quoteWindowsCommand([input.launcher.launcher, ...input.cliArgs]),
      args: [],
      env: { ...env },
      display: `${input.launcher.launcher} ${input.cliArgs.join(" ")}`,
      mode: "windows-cmd",
      shell: true,
    };
  }

  return {
    command: input.launcher.launcher,
    args: [...input.cliArgs],
    env,
    display: `${input.launcher.launcher} ${input.cliArgs.join(" ")}`,
    mode: "direct",
  };
}

/** Split a user-supplied argument string, honouring simple quoting. */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started || current.length > 0) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current.length > 0) args.push(current);
  return args;
}

export function resolveDshHome(
  configured: string,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const explicit = configured.trim();
  if (explicit.length > 0) return explicit;
  const fromEnv = env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(home, ".dsh");
}

function stripYamlScalar(value: string): string {
  let out = value.trim();
  const comment = out.search(/\s+#/u);
  if (comment >= 0) out = out.slice(0, comment).trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

/** Read the provider/model the desktop profile pins in its user patch layer. */
export function parseDefaultModelPatch(text: string): DesktopRoute | null {
  const lines = text.split(/\r?\n/u);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*-\s+id:\s*agent-default-model\b/u.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;
  let provider = "";
  let model = "";
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*-\s+(id|insert|name):/u.test(line) && !/^\s*-\s+id:\s*agent-default-model\b/u.test(line)) break;
    const providerMatch = /^\s*provider:\s*(.+)$/u.exec(line);
    if (providerMatch) provider = stripYamlScalar(providerMatch[1]);
    const modelMatch = /^\s*model:\s*(.+)$/u.exec(line);
    if (modelMatch) model = stripYamlScalar(modelMatch[1]);
  }
  if (!provider || !model) return null;
  return { provider, model };
}

export type ReadTextFile = (path: string) => string | null;

/** Look for the desktop/web profile's pinned default route. */
export function detectDesktopRoute(dshHome: string, readFile: ReadTextFile): DesktopRoute | null {
  for (const profile of ["desktop", "web"]) {
    const text = readFile(join(dshHome, "profiles", profile, "cordis.patch.yml"));
    if (!text) continue;
    const route = parseDefaultModelPatch(text);
    if (route) return route;
  }
  return null;
}

/** YAML text for the generated `--patch` overlay, or null when nothing is needed. */
export function buildOverrideYaml(
  route: DesktopRoute | null,
  extraPatch: string,
): string | null {
  const sections: string[] = [];
  if (route) {
    sections.push(
      [
        "- id: acp",
        "  name: '@deepseek-ai/dsh-acp'",
        "  config:",
        `    provider: ${JSON.stringify(route.provider)}`,
        `    model: ${JSON.stringify(route.model)}`,
      ].join("\n"),
    );
  }
  const extra = extraPatch.trim();
  if (extra.length > 0) sections.push(extra);
  if (sections.length === 0) return null;
  return `${sections.join("\n")}\n`;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolvePromise(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

export interface RuntimeHooks {
  vaultPath: string;
  pluginDir: string;
  getSettings: () => RuntimeSettings;
  onStatus: (status: RuntimeStatus) => void;
  onLog: (line: string) => void;
  onUpdate: (params: AcpSessionUpdateParams) => void;
  onPermission: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
}

export class RuntimeError extends Error {
  readonly code: "not-found" | "spawn" | "initialize" | "stopped";

  constructor(code: RuntimeError["code"], message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class DshRuntime {
  private child: ChildProcess | null = null;
  private client: AcpClient | null = null;
  private phase: RuntimePhase = "idle";
  private detail = "";
  private firstStart = false;
  private logLines: string[] = [];
  private startPromise: Promise<AcpClient> | null = null;
  private expectedStop = false;
  private launcher: LauncherInfo | null = null;
  private readonly hooks: RuntimeHooks;

  constructor(hooks: RuntimeHooks) {
    this.hooks = hooks;
  }

  get status(): RuntimeStatus {
    return { phase: this.phase, detail: this.detail, firstStart: this.firstStart };
  }

  get logText(): string {
    return this.logLines.join("\n");
  }

  discoveryDeps(): DiscoveryDeps {
    return {
      platform: process.platform,
      env: process.env,
      home: homedir(),
      exists: existsSync,
    };
  }

  resolveLauncher(): LauncherInfo | null {
    const found = discoverLaunchers(this.hooks.getSettings(), this.discoveryDeps());
    this.launcher = found[0] ?? null;
    return this.launcher;
  }

  async probe(): Promise<ProbeResult> {
    const previousPhase = this.phase;
    this.phase = "probing";
    this.hooks.onStatus(this.status);
    try {
      const launcher = this.resolveLauncher();
      if (!launcher) {
        this.phase = previousPhase;
        this.hooks.onStatus(this.status);
        return { ok: false, detail: "no launcher found" };
      }
      const plan = this.buildPlan(launcher, ["--version"]);
      this.pushLog(`probe: ${plan.display}`);
      const result = await this.runProbe(plan);
      this.phase = previousPhase;
      this.hooks.onStatus(this.status);
      if (result.ok) {
        this.launcher = launcher;
        return { ok: true, detail: result.detail, launcher: launcher.launcher };
      }
      return result;
    } catch (error) {
      this.phase = previousPhase;
      this.hooks.onStatus(this.status);
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensure(): Promise<AcpClient> {
    if (this.client && this.phase === "ready" && !this.client.isDisposed) return this.client;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return await this.startPromise;
  }

  async restart(): Promise<AcpClient> {
    await this.stop("restart");
    return await this.ensure();
  }

  private async start(): Promise<AcpClient> {
    if (this.child) {
      throw new RuntimeError("spawn", "the runtime process is already running");
    }
    const settings = this.hooks.getSettings();
    const env = process.env as Record<string, string | undefined>;
    const dshHome = resolveDshHome(settings.dshHome, env, homedir());
    const launcher = this.resolveLauncher();
    if (!launcher) {
      this.phase = "error";
      this.detail = "not-found";
      this.hooks.onStatus(this.status);
      throw new RuntimeError("not-found", "DeepSeek Harness launcher was not found");
    }
    this.launcher = launcher;

    this.firstStart = !this.profileExists(dshHome, "acp");
    this.phase = "starting";
    this.detail = this.firstStart ? "first-start" : "";
    this.hooks.onStatus(this.status);

    const patchPath = this.writeOverridePatch(settings, dshHome);
    const cliArgs = ["acp"];
    if (patchPath) cliArgs.push("--patch", patchPath);
    cliArgs.push(...splitArgs(settings.extraArgs));
    const plan = this.buildPlan(launcher, cliArgs, dshHome);
    this.pushLog(`spawn (${plan.mode}): ${plan.display}`);

    const child = spawn(plan.command, plan.args, {
      cwd: this.hooks.vaultPath,
      env: plan.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: plan.shell === true,
    });
    this.child = child;

    const client = new AcpClient({
      input: child.stdout!,
      output: child.stdin!,
      clientName: "obsidian-dsh-agent",
      clientVersion: "0.1.0",
      onUpdate: this.hooks.onUpdate,
      onPermission: this.hooks.onPermission,
      onLog: (entry) => {
        if (this.hooks.getSettings().debugLog) {
          this.pushLog(`[${entry.direction}] ${entry.text}`);
        }
      },
    });
    this.client = client;

    child.stderr?.setEncoding("utf8");
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let newline = stderrBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stderrBuffer.slice(0, newline).replace(/\r$/, "");
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line.trim().length > 0) this.pushLog(`[stderr] ${stripAnsi(line)}`);
        newline = stderrBuffer.indexOf("\n");
      }
    });

    child.once("error", (error) => {
      this.pushLog(`spawn error: ${error.message}`);
      if (this.phase === "starting") {
        this.phase = "error";
        this.detail = error.message;
        this.hooks.onStatus(this.status);
      }
    });

    child.once("exit", (code, signal) => {
      const expected = this.expectedStop;
      this.expectedStop = false;
      this.pushLog(`runtime exited (code=${String(code)}, signal=${String(signal)})`);
      client.dispose(new RuntimeError("stopped", `runtime exited (code=${String(code)})`));
      this.child = null;
      this.client = null;
      if (this.phase !== "error") {
        this.phase = expected ? "stopped" : "error";
        this.detail = expected ? "" : `exit ${String(code ?? signal)}`;
      }
      this.hooks.onStatus(this.status);
      this.hooks.onExit({ code, signal, expected });
    });

    let rejectSpawn: ((error: Error) => void) | null = null;
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      rejectSpawn = reject;
    });
    child.once("error", (error: Error) => {
      rejectSpawn?.(error);
    });

    try {
      const result = await Promise.race([client.initialize(), spawnFailure]);
      rejectSpawn = null;
      if (result.protocolVersion !== 1) {
        this.pushLog(`warning: agent speaks ACP protocol version ${result.protocolVersion}; continuing`);
      }
      this.phase = "ready";
      this.detail = result.agentInfo?.version ?? "";
      this.hooks.onStatus(this.status);
      return client;
    } catch (error) {
      this.pushLog(`initialize failed: ${error instanceof Error ? error.message : String(error)}`);
      this.phase = "error";
      this.detail = error instanceof Error ? error.message : String(error);
      this.hooks.onStatus(this.status);
      this.expectedStop = true;
      await this.terminate(child);
      throw new RuntimeError(
        "initialize",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async stop(reason = "stop"): Promise<void> {
    this.pushLog(`stop requested (${reason})`);
    this.expectedStop = true;
    const child = this.child;
    this.client?.dispose(new RuntimeError("stopped", "runtime stopped"));
    this.client = null;
    if (!child) {
      if (this.phase !== "stopped") {
        this.phase = "stopped";
        this.detail = "";
        this.hooks.onStatus(this.status);
      }
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      // stdin may already be closed
    }
    const exited = await waitForExit(child, 2500);
    if (!exited) await this.terminate(child);
    this.child = null;
    if (this.phase !== "stopped" && this.phase !== "error") {
      this.phase = "stopped";
      this.detail = "";
      this.hooks.onStatus(this.status);
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    try {
      child.kill();
    } catch {
      // ignore
    }
    const exited = await waitForExit(child, 1500);
    if (exited) return;
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => undefined);
      } catch {
        // best effort
      }
    }
  }

  private buildPlan(
    launcher: LauncherInfo,
    cliArgs: string[],
    dshHome?: string,
  ): SpawnPlan {
    const env: Record<string, string | undefined> = { ...process.env };
    const home = dshHome ?? resolveDshHome(this.hooks.getSettings().dshHome, env, homedir());
    env.DSH_HOME = home;
    return buildSpawnPlan({
      launcher,
      platform: process.platform,
      env,
      cliArgs,
      exists: existsSync,
    });
  }

  private profileExists(dshHome: string, profile: string): boolean {
    return existsSync(join(dshHome, "profiles", profile, "package.json"));
  }

  private writeOverridePatch(settings: RuntimeSettings, dshHome: string): string | null {
    const explicitProvider = settings.provider.trim();
    const explicitModel = settings.model.trim();
    const detected =
      explicitProvider && explicitModel
        ? null
        : detectDesktopRoute(dshHome, (file) => {
            try {
              return readFileSync(file, "utf8");
            } catch {
              return null;
            }
          });
    let route: DesktopRoute | null = null;
    if (explicitProvider || explicitModel) {
      const provider = explicitProvider || detected?.provider || "";
      const model = explicitModel || detected?.model || "";
      if (provider && model) route = { provider, model };
    } else {
      route = detected;
    }
    const yaml = buildOverrideYaml(route, settings.extraPatchYaml);
    if (!yaml) return null;
    if (route) this.pushLog(`model route override: ${route.provider}/${route.model}`);
    const dir = join(this.hooks.pluginDir, "runtime");
    const file = join(dir, "acp-override.yml");
    try {
      mkdirSync(dir, { recursive: true });
      let current: string | null = null;
      try {
        current = readFileSync(file, "utf8");
      } catch {
        current = null;
      }
      if (current !== yaml) writeFileSync(file, yaml, "utf8");
      return file;
    } catch (error) {
      this.pushLog(`failed to write override patch: ${String(error)}`);
      return null;
    }
  }

  private async runProbe(plan: SpawnPlan): Promise<ProbeResult> {
    return await new Promise<ProbeResult>((resolvePromise) => {
      let output = "";
      let settled = false;
      const child = spawn(plan.command, plan.args, {
        cwd: this.hooks.vaultPath,
        env: plan.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: plan.shell === true,
      });
      const finish = (result: ProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish({ ok: false, detail: "probe timed out" });
      }, 15_000);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        output += chunk;
      });
      child.once("error", (error) => finish({ ok: false, detail: error.message }));
      child.once("exit", (code) => {
        const text = stripAnsi(output).trim();
        const firstLine = text.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
        if (code === 0) finish({ ok: true, detail: firstLine || "ok" });
        else finish({ ok: false, detail: firstLine || `exit ${String(code)}` });
      });
    });
  }

  private pushLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    }
    this.hooks.onLog(line);
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}
