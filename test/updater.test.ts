import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateSuggestions,
  savePendingUpdates,
  applyUpdate,
  updatePlaybookStats,
} from "../src/learning/updater";
import type {
  CommitInfo,
  FixChain,
  InteractionRecord,
  PendingUpdate,
  ScoringResult,
} from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boost-updater-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    hash: "abc1234567890000",
    date: "2026-03-20",
    author: "Alice",
    message: "add feature",
    files: [],
    ...overrides,
  };
}

function makeFixChain(overrides: Partial<FixChain> = {}): FixChain {
  return {
    featureCommit: makeCommit({ hash: "feat123456789000", message: "add feature" }),
    fixCommit: makeCommit({ hash: "fix1234567890000", message: "fix bug" }),
    sharedFiles: ["src/module.ts"],
    hoursBetween: 2.5,
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    id: "int-1",
    timestamp: Date.now(),
    sessionId: "sess-1",
    promptRaw: "do something important for the project",
    sectionsUsed: [],
    turns: 1,
    totalToolCalls: 5,
    toolErrors: 0,
    retried: false,
    ...overrides,
  };
}

function makeScore(composite: number): ScoringResult {
  return {
    signals: { turnEfficiency: composite, errorFree: composite, noRetry: 1.0 },
    composite,
  };
}

function makePendingUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  return {
    id: "upd-1",
    type: "new_rule",
    section: "known_failure_patterns",
    content: "When modifying src/module.ts, also check related files",
    evidence: "some evidence",
    confidence: 0.65,
    created: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

// ─── generateSuggestions ─────────────────────────────────────────

describe("generateSuggestions", () => {
  it("returns empty array when all inputs are empty", () => {
    const result = generateSuggestions([], [], []);
    expect(result).toEqual([]);
  });

  it("generates new_rule from fix chains", () => {
    const chain = makeFixChain({
      sharedFiles: ["src/auth.ts"],
      hoursBetween: 3.0,
    });

    const result = generateSuggestions([chain], [], []);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("new_rule");
    expect(result[0].section).toBe("known_failure_patterns");
    expect(result[0].content).toContain("src/auth.ts");
    expect(result[0].evidence).toContain("3.0h");
    expect(result[0].status).toBe("pending");
  });

  it("generates update_stat from low-scoring interactions (composite < 0.5)", () => {
    const interaction = makeInteraction({
      id: "low-1",
      promptRaw: "refactor the entire authentication module now",
      turns: 8,
      toolErrors: 5,
    });
    const score = makeScore(0.3);

    const result = generateSuggestions([], [interaction], [score]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("update_stat");
    expect(result[0].section).toBe("known_failure_patterns");
    expect(result[0].content).toContain("refactor the entire authentication module");
    expect(result[0].evidence).toContain("0.30");
    expect(result[0].confidence).toBe(0.4);
  });

  it("does not generate update_stat for interactions scoring >= 0.5", () => {
    const interaction = makeInteraction({ id: "ok-1" });
    const score = makeScore(0.5);

    const result = generateSuggestions([], [interaction], [score]);

    expect(result).toEqual([]);
  });

  it("does not generate update_stat for high-scoring interactions", () => {
    const interaction = makeInteraction({ id: "good-1" });
    const score = makeScore(0.9);

    const result = generateSuggestions([], [interaction], [score]);

    expect(result).toEqual([]);
  });

  it("handles interactions without corresponding scores (undefined score)", () => {
    const interaction = makeInteraction({ id: "no-score" });

    // scores array is shorter than interactions
    const result = generateSuggestions([], [interaction], []);

    expect(result).toEqual([]);
  });

  it("scales confidence with repeated file patterns in fix chains", () => {
    const chain1 = makeFixChain({
      fixCommit: makeCommit({ hash: "fix1_abcdef12" }),
      sharedFiles: ["src/shared.ts"],
    });
    const chain2 = makeFixChain({
      fixCommit: makeCommit({ hash: "fix2_abcdef12" }),
      sharedFiles: ["src/shared.ts"],
    });

    const result = generateSuggestions([chain1, chain2], [], []);

    expect(result).toHaveLength(2);
    // Both have the same file pattern key, count = 2
    // confidence = min(0.5 + 2 * 0.15, 0.95) = 0.8
    expect(result[0].confidence).toBeCloseTo(0.8, 2);
    expect(result[1].confidence).toBeCloseTo(0.8, 2);
  });

  it("caps confidence at 0.95", () => {
    // 10 chains with same file pattern: confidence = min(0.5 + 10 * 0.15, 0.95) = 0.95
    const chains: FixChain[] = [];
    for (let i = 0; i < 10; i++) {
      chains.push(
        makeFixChain({
          fixCommit: makeCommit({ hash: `fix${i}_abcdef12345` }),
          sharedFiles: ["src/hot.ts"],
        }),
      );
    }

    const result = generateSuggestions(chains, [], []);

    for (const update of result) {
      expect(update.confidence).toBeLessThanOrEqual(0.95);
    }
  });

  it("base confidence is 0.65 for a single fix chain", () => {
    const chain = makeFixChain();

    const result = generateSuggestions([chain], [], []);

    // count = 1, confidence = 0.5 + 1 * 0.15 = 0.65
    expect(result[0].confidence).toBeCloseTo(0.65, 2);
  });

  it("truncates prompt in update_stat content to 60 chars", () => {
    const longPrompt = "x".repeat(100);
    const interaction = makeInteraction({ id: "long", promptRaw: longPrompt });
    const score = makeScore(0.1);

    const result = generateSuggestions([], [interaction], [score]);

    expect(result).toHaveLength(1);
    // Content includes truncated version of promptRaw
    expect(result[0].content.length).toBeLessThan(longPrompt.length + 100);
  });

  it("generates both new_rule and update_stat when both inputs present", () => {
    const chain = makeFixChain();
    const interaction = makeInteraction({ id: "low" });
    const score = makeScore(0.2);

    const result = generateSuggestions([chain], [interaction], [score]);

    const types = result.map((u) => u.type);
    expect(types).toContain("new_rule");
    expect(types).toContain("update_stat");
  });

  it("includes evidence with commit short hashes", () => {
    const chain = makeFixChain({
      featureCommit: makeCommit({ hash: "abcdef1234567890" }),
      fixCommit: makeCommit({ hash: "1234567890abcdef" }),
    });

    const result = generateSuggestions([chain], [], []);

    expect(result[0].evidence).toContain("1234567");
    expect(result[0].evidence).toContain("abcdef1");
  });
});

// ─── savePendingUpdates ──────────────────────────────────────────

describe("savePendingUpdates", () => {
  it("creates pending-updates.json with new updates", async () => {
    const boostDir = await makeTempDir();
    const updates = [makePendingUpdate({ id: "upd-1" })];

    await savePendingUpdates(boostDir, updates);

    const content = JSON.parse(await readFile(join(boostDir, "pending-updates.json"), "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].id).toBe("upd-1");
  });

  it("appends to existing updates without overwriting", async () => {
    const boostDir = await makeTempDir();

    await savePendingUpdates(boostDir, [makePendingUpdate({ id: "upd-1" })]);
    await savePendingUpdates(boostDir, [makePendingUpdate({ id: "upd-2", content: "different content" })]);

    const content = JSON.parse(await readFile(join(boostDir, "pending-updates.json"), "utf-8"));
    expect(content).toHaveLength(2);
  });

  it("deduplicates by section + content (same section and content not added twice)", async () => {
    const boostDir = await makeTempDir();
    const update = makePendingUpdate({
      id: "upd-1",
      section: "conventions",
      content: "always use strict mode",
    });

    await savePendingUpdates(boostDir, [update]);
    await savePendingUpdates(boostDir, [
      makePendingUpdate({
        id: "upd-2",
        section: "conventions",
        content: "always use strict mode",
      }),
    ]);

    const content = JSON.parse(await readFile(join(boostDir, "pending-updates.json"), "utf-8"));
    expect(content).toHaveLength(1);
  });

  it("allows same content in different sections", async () => {
    const boostDir = await makeTempDir();

    await savePendingUpdates(boostDir, [
      makePendingUpdate({ id: "upd-1", section: "conventions", content: "check types" }),
    ]);
    await savePendingUpdates(boostDir, [
      makePendingUpdate({ id: "upd-2", section: "known_failure_patterns", content: "check types" }),
    ]);

    const content = JSON.parse(await readFile(join(boostDir, "pending-updates.json"), "utf-8"));
    expect(content).toHaveLength(2);
  });

  it("does nothing when updates array is empty", async () => {
    const boostDir = await makeTempDir();

    await savePendingUpdates(boostDir, []);

    // File should not be created
    await expect(readFile(join(boostDir, "pending-updates.json"), "utf-8")).rejects.toThrow();
  });

  it("handles corrupted existing file by starting fresh", async () => {
    const boostDir = await makeTempDir();
    await writeFile(join(boostDir, "pending-updates.json"), "not valid json");

    await savePendingUpdates(boostDir, [makePendingUpdate({ id: "upd-new" })]);

    const content = JSON.parse(await readFile(join(boostDir, "pending-updates.json"), "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].id).toBe("upd-new");
  });

  it("only deduplicates against pending status entries", async () => {
    const boostDir = await makeTempDir();
    // Pre-seed with an accepted update
    const existing: PendingUpdate[] = [
      makePendingUpdate({
        id: "upd-old",
        section: "conventions",
        content: "use strict",
        status: "accepted",
      }),
    ];
    await writeFile(join(boostDir, "pending-updates.json"), JSON.stringify(existing));

    // Same section+content but status on existing is "accepted", not "pending"
    await savePendingUpdates(boostDir, [
      makePendingUpdate({
        id: "upd-new",
        section: "conventions",
        content: "use strict",
        status: "pending",
      }),
    ]);

    const content = JSON.parse(await readFile(join(boostDir, "pending-updates.json"), "utf-8"));
    expect(content).toHaveLength(2);
  });
});

// ─── applyUpdate ─────────────────────────────────────────────────

describe("applyUpdate", () => {
  const PLAYBOOK_WITH_SECTIONS = [
    "# Project Playbook",
    "",
    "## Known Failure Patterns",
    "- Existing pattern one",
    "",
    "## Conventions",
    "- Use TypeScript strict mode",
    "",
    "## Stats",
    "- Total boosted prompts: 5",
    "",
  ].join("\n");

  it("accept: appends rule to correct playbook section", async () => {
    const boostDir = await makeTempDir();
    await writeFile(join(boostDir, "playbook.md"), PLAYBOOK_WITH_SECTIONS);
    await writeFile(
      join(boostDir, "pending-updates.json"),
      JSON.stringify([makePendingUpdate({ id: "upd-1", section: "known_failure_patterns" })]),
    );

    const update = makePendingUpdate({ id: "upd-1", section: "known_failure_patterns" });
    await applyUpdate(boostDir, update, "accept");

    const playbook = await readFile(join(boostDir, "playbook.md"), "utf-8");
    expect(playbook).toContain("- Existing pattern one");
    expect(playbook).toContain(`- ${update.content}`);

    // Verify it's under the correct section
    const lines = playbook.split("\n");
    const sectionIdx = lines.findIndex((l) => l.startsWith("## Known Failure Patterns"));
    const nextSectionIdx = lines.findIndex(
      (l, i) => i > sectionIdx && l.startsWith("## "),
    );
    const sectionContent = lines.slice(sectionIdx, nextSectionIdx).join("\n");
    expect(sectionContent).toContain(update.content);
  });

  it("accept: removes the update from pending-updates.json", async () => {
    const boostDir = await makeTempDir();
    await writeFile(join(boostDir, "playbook.md"), PLAYBOOK_WITH_SECTIONS);

    const updates = [
      makePendingUpdate({ id: "upd-1" }),
      makePendingUpdate({ id: "upd-2", content: "other rule" }),
    ];
    await writeFile(join(boostDir, "pending-updates.json"), JSON.stringify(updates));

    await applyUpdate(boostDir, updates[0], "accept");

    const remaining = JSON.parse(
      await readFile(join(boostDir, "pending-updates.json"), "utf-8"),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("upd-2");
  });

  it("reject: removes update from pending but does not modify playbook", async () => {
    const boostDir = await makeTempDir();
    await writeFile(join(boostDir, "playbook.md"), PLAYBOOK_WITH_SECTIONS);

    const update = makePendingUpdate({ id: "upd-reject" });
    await writeFile(
      join(boostDir, "pending-updates.json"),
      JSON.stringify([update]),
    );

    await applyUpdate(boostDir, update, "reject");

    const playbook = await readFile(join(boostDir, "playbook.md"), "utf-8");
    expect(playbook).not.toContain(update.content);

    const remaining = JSON.parse(
      await readFile(join(boostDir, "pending-updates.json"), "utf-8"),
    );
    expect(remaining).toEqual([]);
  });

  it("accept: does nothing when playbook does not exist", async () => {
    const boostDir = await makeTempDir();
    await writeFile(
      join(boostDir, "pending-updates.json"),
      JSON.stringify([makePendingUpdate({ id: "upd-1" })]),
    );

    const update = makePendingUpdate({ id: "upd-1" });

    // Should not throw
    await expect(applyUpdate(boostDir, update, "accept")).resolves.toBeUndefined();
  });

  it("accept: handles missing section in playbook (no insertion)", async () => {
    const boostDir = await makeTempDir();
    const playbook = "# Playbook\n\n## Conventions\n- rule one\n";
    await writeFile(join(boostDir, "playbook.md"), playbook);
    await writeFile(
      join(boostDir, "pending-updates.json"),
      JSON.stringify([makePendingUpdate({ id: "upd-1", section: "nonexistent_section" })]),
    );

    const update = makePendingUpdate({ id: "upd-1", section: "nonexistent_section" });
    await applyUpdate(boostDir, update, "accept");

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");
    // Section doesn't exist, so content should NOT be appended
    expect(result).not.toContain(update.content);
  });

  it("reject: handles missing pending-updates.json gracefully", async () => {
    const boostDir = await makeTempDir();

    const update = makePendingUpdate({ id: "upd-missing" });

    await expect(applyUpdate(boostDir, update, "reject")).resolves.toBeUndefined();
  });

  it("accept: maps known section keys to correct headers", async () => {
    const boostDir = await makeTempDir();
    const playbook = [
      "# Playbook",
      "",
      "## Co-Change Rules",
      "- existing rule",
      "",
    ].join("\n");
    await writeFile(join(boostDir, "playbook.md"), playbook);
    await writeFile(join(boostDir, "pending-updates.json"), JSON.stringify([]));

    const update = makePendingUpdate({
      id: "upd-cochange",
      section: "co_change_rules",
      content: "a.ts and b.ts always change together",
    });

    await applyUpdate(boostDir, update, "accept");

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");
    expect(result).toContain("- a.ts and b.ts always change together");
  });

  it("accept: inserts before trailing blank lines in section", async () => {
    const boostDir = await makeTempDir();
    const playbook = [
      "## Known Failure Patterns",
      "- existing rule",
      "",
      "",
      "## Conventions",
      "- convention one",
    ].join("\n");
    await writeFile(join(boostDir, "playbook.md"), playbook);
    await writeFile(join(boostDir, "pending-updates.json"), JSON.stringify([]));

    const update = makePendingUpdate({
      id: "upd-insert",
      section: "known_failure_patterns",
      content: "new rule here",
    });

    await applyUpdate(boostDir, update, "accept");

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");
    const lines = result.split("\n");
    const ruleIdx = lines.findIndex((l) => l.includes("new rule here"));
    const convIdx = lines.findIndex((l) => l.startsWith("## Conventions"));
    // New rule should be before the Conventions section
    expect(ruleIdx).toBeLessThan(convIdx);
    // New rule should be after the existing rule
    const existingIdx = lines.findIndex((l) => l.includes("existing rule"));
    expect(ruleIdx).toBeGreaterThan(existingIdx);
  });
});

// ─── updatePlaybookStats ─────────────────────────────────────────

describe("updatePlaybookStats", () => {
  it("updates existing Stats section with correct metrics", async () => {
    const boostDir = await makeTempDir();
    const playbook = [
      "# Playbook",
      "",
      "## Conventions",
      "- Use strict mode",
      "",
      "## Stats",
      "- Total boosted prompts: 0",
      "- First-attempt success rate: 0.0%",
      "",
    ].join("\n");
    await writeFile(join(boostDir, "playbook.md"), playbook);

    const interactions: InteractionRecord[] = [
      makeInteraction({ timestamp: 1711900000000 }),
      makeInteraction({ timestamp: 1711900001000 }),
    ];
    const scores: ScoringResult[] = [makeScore(0.9), makeScore(0.3)];

    await updatePlaybookStats(boostDir, interactions, scores);

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");

    expect(result).toContain("Total boosted prompts: 2");
    expect(result).toContain("First-attempt success rate: 50.0%");
    expect(result).toContain("Average composite score: 0.60");
    expect(result).toContain("## Conventions");
  });

  it("appends Stats section when it does not exist", async () => {
    const boostDir = await makeTempDir();
    const playbook = "# Playbook\n\n## Conventions\n- Use strict mode\n";
    await writeFile(join(boostDir, "playbook.md"), playbook);

    const interactions: InteractionRecord[] = [makeInteraction()];
    const scores: ScoringResult[] = [makeScore(0.8)];

    await updatePlaybookStats(boostDir, interactions, scores);

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");

    expect(result).toContain("## Stats");
    expect(result).toContain("Total boosted prompts: 1");
    expect(result).toContain("First-attempt success rate: 100.0%");
  });

  it("preserves other sections when updating Stats", async () => {
    const boostDir = await makeTempDir();
    const playbook = [
      "# Playbook",
      "",
      "## Conventions",
      "- Use strict mode",
      "- Always lint",
      "",
      "## Stats",
      "- Total boosted prompts: 0",
      "",
      "## Known Failure Patterns",
      "- Pattern one",
      "",
    ].join("\n");
    await writeFile(join(boostDir, "playbook.md"), playbook);

    await updatePlaybookStats(boostDir, [makeInteraction()], [makeScore(1.0)]);

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");

    expect(result).toContain("## Conventions");
    expect(result).toContain("- Use strict mode");
    expect(result).toContain("- Always lint");
    expect(result).toContain("## Known Failure Patterns");
    expect(result).toContain("- Pattern one");
    expect(result).toContain("Total boosted prompts: 1");
  });

  it("does nothing when playbook does not exist", async () => {
    const boostDir = await makeTempDir();

    // Should not throw
    await expect(
      updatePlaybookStats(boostDir, [makeInteraction()], [makeScore(0.5)]),
    ).resolves.toBeUndefined();
  });

  it("handles empty interactions and scores", async () => {
    const boostDir = await makeTempDir();
    const playbook = "# Playbook\n\n## Stats\n- old stats\n";
    await writeFile(join(boostDir, "playbook.md"), playbook);

    await updatePlaybookStats(boostDir, [], []);

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");

    expect(result).toContain("Total boosted prompts: 0");
    expect(result).toContain("First-attempt success rate: 0.0%");
    expect(result).toContain("Average composite score: 0.00");
    expect(result).toContain("Most recent session: N/A");
  });

  it("calculates success rate as percentage of scores >= 0.7", async () => {
    const boostDir = await makeTempDir();
    const playbook = "# Playbook\n\n## Stats\n- placeholder\n";
    await writeFile(join(boostDir, "playbook.md"), playbook);

    const interactions = [
      makeInteraction({ timestamp: 1000 }),
      makeInteraction({ timestamp: 2000 }),
      makeInteraction({ timestamp: 3000 }),
      makeInteraction({ timestamp: 4000 }),
    ];
    // 3 out of 4 have composite >= 0.7
    const scores = [makeScore(0.9), makeScore(0.7), makeScore(0.3), makeScore(0.8)];

    await updatePlaybookStats(boostDir, interactions, scores);

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");
    expect(result).toContain("First-attempt success rate: 75.0%");
  });

  it("writes last updated timestamp", async () => {
    const boostDir = await makeTempDir();
    const playbook = "# Playbook\n\n## Stats\n- old\n";
    await writeFile(join(boostDir, "playbook.md"), playbook);

    const before = new Date().toISOString().slice(0, 10);
    await updatePlaybookStats(boostDir, [makeInteraction()], [makeScore(0.5)]);

    const result = await readFile(join(boostDir, "playbook.md"), "utf-8");
    expect(result).toContain("Last updated: ");
    // The date portion should match today
    const match = result.match(/Last updated: (\d{4}-\d{2}-\d{2})/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(before);
  });
});
