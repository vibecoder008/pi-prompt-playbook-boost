import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendInteraction,
  readRecentInteractions,
  getInteractionCount,
} from "../src/learning/history";
import type { InteractionRecord } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeRecord(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    id: "rec-1",
    timestamp: Date.now(),
    sessionId: "sess-1",
    promptRaw: "do something",
    sectionsUsed: [],
    turns: 1,
    totalToolCalls: 5,
    toolErrors: 0,
    retried: false,
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boost-history-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

// ─── appendInteraction ───────────────────────────────────────────

describe("appendInteraction", () => {
  it("creates history directory and file when they do not exist", async () => {
    const boostDir = await makeTempDir();
    const record = makeRecord({ id: "rec-new" });

    await appendInteraction(boostDir, record);

    const content = await readFile(join(boostDir, "history", "sessions.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.id).toBe("rec-new");
  });

  it("appends to existing file without overwriting", async () => {
    const boostDir = await makeTempDir();

    await appendInteraction(boostDir, makeRecord({ id: "rec-1" }));
    await appendInteraction(boostDir, makeRecord({ id: "rec-2" }));

    const content = await readFile(join(boostDir, "history", "sessions.jsonl"), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe("rec-1");
    expect(JSON.parse(lines[1]).id).toBe("rec-2");
  });

  it("writes each record as a single JSON line terminated by newline", async () => {
    const boostDir = await makeTempDir();

    await appendInteraction(boostDir, makeRecord());

    const content = await readFile(join(boostDir, "history", "sessions.jsonl"), "utf-8");

    expect(content.endsWith("\n")).toBe(true);
    // No embedded newlines within the JSON
    const lines = content.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it("preserves all fields of the interaction record", async () => {
    const boostDir = await makeTempDir();
    const record = makeRecord({
      id: "rec-full",
      timestamp: 1711900000000,
      sessionId: "sess-42",
      promptRaw: "do the thing",
      sectionsUsed: ["conventions", "failure_patterns"],
      turns: 3,
      totalToolCalls: 12,
      toolErrors: 2,
      retried: true,
    });

    await appendInteraction(boostDir, record);

    const content = await readFile(join(boostDir, "history", "sessions.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed).toEqual(record);
  });

  it("works when history directory already exists", async () => {
    const boostDir = await makeTempDir();
    await mkdir(join(boostDir, "history"), { recursive: true });

    await appendInteraction(boostDir, makeRecord({ id: "rec-existing-dir" }));

    const content = await readFile(join(boostDir, "history", "sessions.jsonl"), "utf-8");
    expect(JSON.parse(content.trim()).id).toBe("rec-existing-dir");
  });
});

// ─── readRecentInteractions ──────────────────────────────────────

describe("readRecentInteractions", () => {
  it("returns empty array when file does not exist", async () => {
    const boostDir = await makeTempDir();

    const result = await readRecentInteractions(boostDir);

    expect(result).toEqual([]);
  });

  it("returns all records when fewer than limit", async () => {
    const boostDir = await makeTempDir();
    await appendInteraction(boostDir, makeRecord({ id: "rec-1" }));
    await appendInteraction(boostDir, makeRecord({ id: "rec-2" }));

    const result = await readRecentInteractions(boostDir, 50);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("rec-1");
    expect(result[1].id).toBe("rec-2");
  });

  it("returns only the last N records when more than limit", async () => {
    const boostDir = await makeTempDir();

    for (let i = 0; i < 5; i++) {
      await appendInteraction(boostDir, makeRecord({ id: `rec-${i}` }));
    }

    const result = await readRecentInteractions(boostDir, 3);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("rec-2");
    expect(result[1].id).toBe("rec-3");
    expect(result[2].id).toBe("rec-4");
  });

  it("skips malformed JSON lines", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });

    const lines = [
      JSON.stringify(makeRecord({ id: "good-1" })),
      "this is not valid json",
      JSON.stringify(makeRecord({ id: "good-2" })),
      "{broken",
    ].join("\n");

    await writeFile(join(historyDir, "sessions.jsonl"), lines);

    const result = await readRecentInteractions(boostDir);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("good-1");
    expect(result[1].id).toBe("good-2");
  });

  it("handles empty file", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "sessions.jsonl"), "");

    const result = await readRecentInteractions(boostDir);

    expect(result).toEqual([]);
  });

  it("handles file with only whitespace and blank lines", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "sessions.jsonl"), "  \n\n  \n");

    const result = await readRecentInteractions(boostDir);

    expect(result).toEqual([]);
  });

  it("uses default limit of 50", async () => {
    const boostDir = await makeTempDir();

    for (let i = 0; i < 60; i++) {
      await appendInteraction(boostDir, makeRecord({ id: `rec-${i}` }));
    }

    const result = await readRecentInteractions(boostDir);

    expect(result).toHaveLength(50);
    expect(result[0].id).toBe("rec-10");
    expect(result[49].id).toBe("rec-59");
  });
});

// ─── getInteractionCount ─────────────────────────────────────────

describe("getInteractionCount", () => {
  it("returns 0 when file does not exist", async () => {
    const boostDir = await makeTempDir();

    const count = await getInteractionCount(boostDir);

    expect(count).toBe(0);
  });

  it("returns 0 for empty file", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "sessions.jsonl"), "");

    const count = await getInteractionCount(boostDir);

    expect(count).toBe(0);
  });

  it("returns 0 for file with only whitespace", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "sessions.jsonl"), "   \n  \n  ");

    const count = await getInteractionCount(boostDir);

    expect(count).toBe(0);
  });

  it("counts non-empty lines correctly", async () => {
    const boostDir = await makeTempDir();

    await appendInteraction(boostDir, makeRecord({ id: "r1" }));
    await appendInteraction(boostDir, makeRecord({ id: "r2" }));
    await appendInteraction(boostDir, makeRecord({ id: "r3" }));

    const count = await getInteractionCount(boostDir);

    expect(count).toBe(3);
  });

  it("counts lines without parsing JSON (fast path)", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });

    // Even malformed JSON lines count as non-empty lines
    const lines = [
      '{"id":"r1"}',
      "not valid json",
      '{"id":"r2"}',
    ].join("\n");

    await writeFile(join(historyDir, "sessions.jsonl"), lines);

    const count = await getInteractionCount(boostDir);

    expect(count).toBe(3);
  });

  it("skips blank lines in the count", async () => {
    const boostDir = await makeTempDir();
    const historyDir = join(boostDir, "history");
    await mkdir(historyDir, { recursive: true });

    const content = '{"id":"r1"}\n\n{"id":"r2"}\n\n\n{"id":"r3"}\n';
    await writeFile(join(historyDir, "sessions.jsonl"), content);

    const count = await getInteractionCount(boostDir);

    expect(count).toBe(3);
  });
});
