import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRetries,
  extractPromptPatterns,
  analyzeSessionHistory,
} from "../src/setup/session-analyzer";
import type { SessionMessage } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────

function msg(content: string, timestamp?: number): SessionMessage {
  return { role: "user", content, timestamp };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boost-session-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

// ─── detectRetries ───────────────────────────────────────────────

describe("detectRetries", () => {
  it("returns 0 for empty messages", () => {
    expect(detectRetries([])).toBe(0);
  });

  it("returns 0 for a single message", () => {
    expect(detectRetries([msg("fix the login page")])).toBe(0);
  });

  it("returns 0 for completely different consecutive messages", () => {
    const messages = [
      msg("fix the login page"),
      msg("add payment processing"),
      msg("update the dashboard layout"),
    ];

    expect(detectRetries(messages)).toBe(0);
  });

  it("detects retry when consecutive messages are identical", () => {
    const messages = [
      msg("fix the login page"),
      msg("fix the login page"),
    ];

    expect(detectRetries(messages)).toBe(1);
  });

  it("detects retry when consecutive messages have >60% word overlap", () => {
    const messages = [
      msg("fix the login page authentication bug"),
      msg("fix the login page auth bug please"),
    ];

    expect(detectRetries(messages)).toBe(1);
  });

  it("does not count non-consecutive similar messages as retries", () => {
    const messages = [
      msg("fix the login bug"),
      msg("add a completely different feature to the dashboard"),
      msg("fix the login bug"),
    ];

    // Only consecutive pairs are checked
    expect(detectRetries(messages)).toBe(0);
  });

  it("counts multiple retries in a sequence", () => {
    // Pair 1: {"fix","login","page","auth"} vs {"fix","login","page","auth","issue"} → 4/5=0.8
    // Pair 2: {"fix","login","page","auth","issue"} vs {"fix","login","page","auth","bug"} → 4/6≈0.67
    const messages = [
      msg("fix login page auth"),
      msg("fix login page auth issue"),
      msg("fix login page auth bug"),
    ];

    expect(detectRetries(messages)).toBe(2);
  });

  it("treats empty strings as overlap 1.0 (both empty)", () => {
    // Two empty messages: tokenize("") produces empty set, overlap returns 1
    const messages = [msg(""), msg("")];

    expect(detectRetries(messages)).toBe(1);
  });

  it("treats one empty and one non-empty as no retry", () => {
    const messages = [msg(""), msg("fix the bug")];

    expect(detectRetries(messages)).toBe(0);
  });
});

// ─── extractPromptPatterns ───────────────────────────────────────

describe("extractPromptPatterns", () => {
  it("returns empty array for empty messages", () => {
    expect(extractPromptPatterns([])).toEqual([]);
  });

  it("returns empty array when no pattern appears twice", () => {
    const messages = [
      msg("fix the login page"),
      msg("add payment processing"),
      msg("update the dashboard layout"),
    ];

    expect(extractPromptPatterns(messages)).toEqual([]);
  });

  it("groups messages by leading keywords (up to 3 non-stopword tokens)", () => {
    const messages = [
      msg("fix the authentication middleware bug"),
      msg("fix the authentication middleware issue"),
      msg("add a payment form to the checkout"),
    ];

    const patterns = extractPromptPatterns(messages);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe("fix authentication middleware");
    expect(patterns[0].count).toBe(2);
  });

  it("filters out stopwords from pattern keys", () => {
    // "please", "the" are stopwords; first 3 non-stopwords: "fix", "broken", "code"
    // Both messages produce the same key: "fix broken code"
    const messages = [
      msg("please fix the broken code in login"),
      msg("please just fix the broken code in auth"),
    ];

    const patterns = extractPromptPatterns(messages);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe("fix broken code");
  });

  it("requires count >= 2 to be included", () => {
    const messages = [
      msg("fix auth bug"),
      msg("add payment"),
      msg("update dashboard"),
    ];

    expect(extractPromptPatterns(messages)).toEqual([]);
  });

  it("sorts by count descending", () => {
    // "fix auth middleware X" all produce key "fix auth middleware" (first 3 non-stopwords)
    // "add payment form X" all produce key "add payment form"
    const messages = [
      msg("fix auth middleware bug"),
      msg("add payment form now"),
      msg("fix auth middleware issue"),
      msg("fix auth middleware error"),
      msg("add payment form later"),
    ];

    const patterns = extractPromptPatterns(messages);

    expect(patterns).toHaveLength(2);
    expect(patterns[0].count).toBeGreaterThanOrEqual(patterns[1].count);
    expect(patterns[0].pattern).toBe("fix auth middleware");
    expect(patterns[0].count).toBe(3);
    expect(patterns[1].pattern).toBe("add payment form");
    expect(patterns[1].count).toBe(2);
  });

  it("calculates avgTurns based on index distance", () => {
    // Both produce key "fix auth middleware" (first 3 non-stopwords)
    const messages = [
      msg("fix auth middleware bug"),
      msg("something completely different unrelated task"),
      msg("fix auth middleware issue"),
    ];

    const patterns = extractPromptPatterns(messages);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe("fix auth middleware");
    // First occurrence at index 0, turnsToNext = 1 (distance to index 1)
    // Second occurrence at index 2, turnsToNext = 1 (last message)
    expect(patterns[0].avgTurns).toBeGreaterThan(0);
  });

  it("caps turnsToNext at 20", () => {
    // Both produce key "fix auth middleware"
    const messages: SessionMessage[] = [];
    messages.push(msg("fix auth middleware bug"));
    // Insert unique filler messages between (each with unique first 3 words)
    for (let i = 0; i < 25; i++) {
      messages.push(msg(`unique${i} task${i} number${i} of many`));
    }
    messages.push(msg("fix auth middleware issue"));

    const patterns = extractPromptPatterns(messages);
    const fixPattern = patterns.find((p) => p.pattern === "fix auth middleware");

    expect(fixPattern).toBeDefined();
    // avgTurns should not exceed 20 due to cap
    expect(fixPattern!.avgTurns).toBeLessThanOrEqual(20);
  });

  it("ignores messages that produce no pattern key (only stopwords)", () => {
    const messages = [
      msg("the is a an"),
      msg("the is a an"),
      msg("fix real bug"),
    ];

    // "the is a an" produces no key (all filtered as stopwords or single-char)
    const patterns = extractPromptPatterns(messages);
    expect(patterns).toEqual([]);
  });
});

// ─── analyzeSessionHistory ───────────────────────────────────────

describe("analyzeSessionHistory", () => {
  it("returns empty analysis when directory does not exist", async () => {
    const result = await analyzeSessionHistory("/nonexistent/path/sessions");

    expect(result.totalSessions).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.totalUserMessages).toBe(0);
    expect(result.retryCount).toBe(0);
    expect(result.promptPatterns).toEqual([]);
    expect(result.avgTurnsPerSession).toBe(0);
    expect(result.toolErrorCount).toBe(0);
  });

  it("returns empty analysis for empty directory", async () => {
    const dir = await makeTempDir();

    const result = await analyzeSessionHistory(dir);

    expect(result.totalSessions).toBe(0);
    expect(result.totalMessages).toBe(0);
  });

  it("parses standard pi session format: {type:'message', message:{role:'user',...}}", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "fix the bug" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "done" } }),
      JSON.stringify({ type: "turn_end" }),
    ].join("\n");

    await writeFile(join(dir, "session1.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalSessions).toBe(1);
    expect(result.totalMessages).toBe(3);
    expect(result.totalUserMessages).toBe(1);
    expect(result.avgTurnsPerSession).toBe(1);
  });

  it("parses flat session format: {role:'user', content:'...'}", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ role: "user", content: "add a feature" }),
      JSON.stringify({ role: "assistant", content: "done" }),
    ].join("\n");

    await writeFile(join(dir, "session1.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalUserMessages).toBe(1);
  });

  it("parses boost v1 interaction format: {_type:'interaction', promptRaw:'...'}", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ _type: "interaction", promptRaw: "refactor the module", ts: Date.now() }),
    ].join("\n");

    await writeFile(join(dir, "session1.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalUserMessages).toBe(1);
  });

  it("also accepts type:'interaction' (without underscore)", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ type: "interaction", promptRaw: "do stuff", ts: Date.now() }),
    ].join("\n");

    await writeFile(join(dir, "session1.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalUserMessages).toBe(1);
  });

  it("counts tool errors from tool_result entries", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ type: "tool_result", isError: true }),
      JSON.stringify({ type: "tool_result", isError: false }),
      JSON.stringify({ _type: "tool_result", isError: true }),
    ].join("\n");

    await writeFile(join(dir, "session1.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.toolErrorCount).toBe(2);
  });

  it("counts turns from turn_end entries", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "task 1" } }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "task 2" } }),
      JSON.stringify({ _type: "turn_end" }),
    ].join("\n");

    await writeFile(join(dir, "session1.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.avgTurnsPerSession).toBe(2);
  });

  it("handles multiple session files", async () => {
    const dir = await makeTempDir();

    const session1 = [
      JSON.stringify({ type: "message", message: { role: "user", content: "fix auth" } }),
      JSON.stringify({ type: "turn_end" }),
    ].join("\n");

    const session2 = [
      JSON.stringify({ type: "message", message: { role: "user", content: "add tests" } }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "turn_end" }),
    ].join("\n");

    await writeFile(join(dir, "s1.jsonl"), session1);
    await writeFile(join(dir, "s2.jsonl"), session2);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalSessions).toBe(2);
    expect(result.totalUserMessages).toBe(2);
    // 3 total turns / 2 sessions = 1.5
    expect(result.avgTurnsPerSession).toBe(1.5);
  });

  it("handles nested directories with .jsonl files", async () => {
    const dir = await makeTempDir();
    const subdir = join(dir, "sub");
    await mkdir(subdir, { recursive: true });

    await writeFile(
      join(subdir, "nested.jsonl"),
      JSON.stringify({ role: "user", content: "nested session" }),
    );

    const result = await analyzeSessionHistory(dir);

    expect(result.totalSessions).toBe(1);
    expect(result.totalUserMessages).toBe(1);
  });

  it("skips malformed JSON lines", async () => {
    const dir = await makeTempDir();
    const lines = [
      "this is not json",
      JSON.stringify({ role: "user", content: "valid message" }),
      "{broken json",
    ].join("\n");

    await writeFile(join(dir, "session.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalUserMessages).toBe(1);
  });

  it("ignores non-jsonl files", async () => {
    const dir = await makeTempDir();

    await writeFile(join(dir, "notes.txt"), "not a session");
    await writeFile(join(dir, "data.json"), '{"not":"jsonl"}');

    const result = await analyzeSessionHistory(dir);

    expect(result.totalSessions).toBe(0);
  });

  it("handles content as array of text blocks", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "fix the bug" },
            { type: "text", text: " in module" },
          ],
        },
      }),
    ].join("\n");

    await writeFile(join(dir, "session.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.totalUserMessages).toBe(1);
  });

  it("detects retries across collected user messages", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ role: "user", content: "fix the login authentication bug" }),
      JSON.stringify({ role: "user", content: "fix the login authentication bug" }),
    ].join("\n");

    await writeFile(join(dir, "session.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.retryCount).toBe(1);
  });

  it("extracts prompt patterns from user messages", async () => {
    const dir = await makeTempDir();
    const lines = [
      JSON.stringify({ role: "user", content: "fix auth middleware bug" }),
      JSON.stringify({ role: "user", content: "fix auth middleware issue" }),
      JSON.stringify({ role: "user", content: "fix auth middleware error" }),
    ].join("\n");

    await writeFile(join(dir, "session.jsonl"), lines);

    const result = await analyzeSessionHistory(dir);

    expect(result.promptPatterns.length).toBeGreaterThanOrEqual(1);
    expect(result.promptPatterns[0].count).toBeGreaterThanOrEqual(2);
  });
});
