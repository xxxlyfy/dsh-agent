/**
 * Transcript persistence in the plugin directory, accessed through Obsidian's
 * vault adapter (vault-relative paths, `.obsidian/...` included).
 */
import type { App, DataAdapter } from "obsidian";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptSnapshot } from "./transcript.ts";

export interface TranscriptReadResult {
  snapshot: TranscriptSnapshot | null;
  corrupt: boolean;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/gu, "_");
}

export class PluginStore {
  private readonly adapter: DataAdapter;
  private readonly pluginDir: string;
  private readonly basePath: string | null;
  private tempCounter = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(app: App, pluginDir: string) {
    this.adapter = app.vault.adapter;
    this.pluginDir = pluginDir;
    const maybeFileSystem = this.adapter as DataAdapter & { getBasePath?: () => string };
    this.basePath =
      typeof maybeFileSystem.getBasePath === "function" ? maybeFileSystem.getBasePath() : null;
  }

  private normalizedDir(): string {
    return this.pluginDir.replace(/\\/gu, "/").replace(/\/+$/u, "");
  }

  private transcriptsDir(): string {
    return `${this.normalizedDir()}/transcripts`;
  }

  transcriptPath(sessionId: string): string {
    return `${this.transcriptsDir()}/${safeSessionId(sessionId)}.json`;
  }

  async ensureDir(): Promise<void> {
    const dir = this.transcriptsDir();
    if (await this.adapter.exists(dir)) return;
    try {
      await this.adapter.mkdir(dir);
    } catch (error) {
      if (!(await this.adapter.exists(dir))) throw error;
    }
  }

  async readTranscript(sessionId: string): Promise<TranscriptReadResult> {
    const path = this.transcriptPath(sessionId);
    try {
      if (!(await this.adapter.exists(path))) return { snapshot: null, corrupt: false };
      const text = await this.adapter.read(path);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return { snapshot: null, corrupt: true };
      const snapshot = parsed as TranscriptSnapshot;
      if (snapshot.version !== 1 || typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.items)) {
        return { snapshot: null, corrupt: true };
      }
      return { snapshot, corrupt: false };
    } catch {
      return { snapshot: null, corrupt: true };
    }
  }

  async writeTranscript(snapshot: TranscriptSnapshot): Promise<void> {
    // Serialize writes so a slower older snapshot can never rename last.
    const run = (): Promise<void> => this.writeSnapshot(snapshot);
    const next = this.writeChain.then(run, run);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  private async writeSnapshot(snapshot: TranscriptSnapshot): Promise<void> {
    await this.ensureDir();
    const target = this.transcriptPath(snapshot.sessionId);
    const data = JSON.stringify(snapshot);
    // Write to a sibling temp file first, then rename over the target. A crash
    // mid-write leaves the previous transcript intact instead of a truncated one.
    const temp = `${target}.${Date.now()}-${++this.tempCounter}.tmp`;
    await this.adapter.write(temp, data);
    // Obsidian's adapter.rename refuses to replace an existing destination; the
    // underlying fs rename does replace atomically, so prefer it on local vaults.
    if (this.basePath) {
      try {
        await rename(join(this.basePath, temp), join(this.basePath, target));
        return;
      } catch (error) {
        console.warn("[dsh-chat] atomic transcript rename failed; falling back", error);
      }
    }
    try {
      await this.adapter.rename(temp, target);
    } catch (error) {
      // Some platforms/filesystems cannot rename over an existing file.
      try {
        await this.adapter.write(target, data);
      } finally {
        try {
          await this.adapter.remove(temp);
        } catch {
          // best effort
        }
      }
      console.warn("[dsh-chat] atomic transcript rename failed; wrote directly", error);
    }
  }
}
