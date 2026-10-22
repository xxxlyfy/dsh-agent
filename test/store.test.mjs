import test from "node:test";
import assert from "node:assert/strict";
import { PluginStore } from "../src/store.ts";

function snapshot() {
  return {
    version: 1,
    sessionId: "s1",
    cwd: "/vault",
    createdAt: 1,
    updatedAt: 2,
    usage: null,
    items: [],
  };
}

function makeStore(rename) {
  const files = new Map();
  const calls = [];
  const adapter = {
    async exists(path) {
      return files.has(path);
    },
    async mkdir() {},
    async write(path, data) {
      calls.push(["write", path]);
      files.set(path, data);
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (rename) rename(from, to);
      const data = files.get(from);
      if (data === undefined) throw new Error("missing temp file");
      files.delete(from);
      files.set(to, data);
    },
    async remove(path) {
      calls.push(["remove", path]);
      files.delete(path);
    },
  };
  return { store: new PluginStore({ vault: { adapter } }, ".obsidian/plugins/dsh-agent"), files, calls };
}

test("writes transcripts through a temporary file and atomic rename", async () => {
  const { store, files, calls } = makeStore();
  await store.writeTranscript(snapshot());
  const target = ".obsidian/plugins/dsh-agent/transcripts/s1.json";
  assert.equal(JSON.parse(files.get(target)).sessionId, "s1");
  assert.ok(calls.some((call) => call[0] === "write" && call[1].endsWith(".tmp")));
  assert.ok(calls.some((call) => call[0] === "rename" && call[2] === target));
  assert.equal([...files.keys()].filter((path) => path.endsWith(".tmp")).length, 0);
});

test("falls back to a direct write when rename is unsupported", async () => {
  const { store, files, calls } = makeStore(() => {
    throw new Error("EPERM");
  });
  await store.writeTranscript(snapshot());
  const target = ".obsidian/plugins/dsh-agent/transcripts/s1.json";
  assert.equal(JSON.parse(files.get(target)).sessionId, "s1");
  assert.equal([...files.keys()].filter((path) => path.endsWith(".tmp")).length, 0);
  assert.ok(calls.some((call) => call[0] === "write" && call[1] === target));
  assert.ok(calls.some((call) => call[0] === "remove"));
});

test("serializes overlapping writes so the newest snapshot wins", async () => {
  const { store, files } = makeStore();
  const older = { ...snapshot(), updatedAt: 1 };
  const newer = { ...snapshot(), updatedAt: 2 };
  await Promise.all([store.writeTranscript(older), store.writeTranscript(newer)]);
  const target = ".obsidian/plugins/dsh-agent/transcripts/s1.json";
  assert.equal(JSON.parse(files.get(target)).updatedAt, 2);
});
