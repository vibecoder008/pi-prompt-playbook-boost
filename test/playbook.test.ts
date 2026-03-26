import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePlaybook,
  selectRelevantSections,
  buildInjectionBlock,
  updateStatsSection,
  invalidateCache,
  type PlaybookSection,
} from "../src/playbook";

// ─── parsePlaybook ───────────────────────────────────────────────

describe("parsePlaybook", () => {
  it("parses multiple sections by ## headings", () => {
    const content = [
      "## Alpha",
      "Alpha body line 1",
      "Alpha body line 2",
      "",
      "## Beta",
      "Beta body",
    ].join("\n");

    const sections = parsePlaybook(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Alpha");
    expect(sections[0].content).toBe("Alpha body line 1\nAlpha body line 2");
    expect(sections[1].heading).toBe("Beta");
    expect(sections[1].content).toBe("Beta body");
  });

  it("returns empty array for empty string", () => {
    expect(parsePlaybook("")).toEqual([]);
  });

  it("returns empty array when content has no ## headings", () => {
    const content = "Just some text\nwithout any headings\n# H1 heading";
    expect(parsePlaybook(content)).toEqual([]);
  });

  it("handles a single section", () => {
    const content = "## Only Section\nSome content here";
    const sections = parsePlaybook(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Only Section");
    expect(sections[0].content).toBe("Some content here");
  });

  it("trims trailing whitespace from section content", () => {
    const content = "## Heading\nBody text\n\n\n";
    const sections = parsePlaybook(content);
    expect(sections[0].content).toBe("Body text");
  });

  it("handles section with empty body", () => {
    const content = "## Empty\n## Next\nhas content";
    const sections = parsePlaybook(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Empty");
    expect(sections[0].content).toBe("");
    expect(sections[1].heading).toBe("Next");
  });

  it("ignores text before the first ## heading", () => {
    const content = [
      "# Title",
      "Preamble text that is not under a ## heading",
      "",
      "## Real Section",
      "Real content",
    ].join("\n");

    const sections = parsePlaybook(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Real Section");
  });

  it("preserves heading text exactly (no extra trimming of inner spaces)", () => {
    const content = "## My  Spaced  Heading\nbody";
    const sections = parsePlaybook(content);
    expect(sections[0].heading).toBe("My  Spaced  Heading");
  });

  it("does not treat ### as a section delimiter", () => {
    const content = [
      "## Parent",
      "intro",
      "### Sub-heading",
      "sub content",
    ].join("\n");

    const sections = parsePlaybook(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain("### Sub-heading");
    expect(sections[0].content).toContain("sub content");
  });

  // ─── Keyword extraction (tested through parsePlaybook) ─────────

  it("extracts keywords from heading and body", () => {
    const content = "## Database Migration\nRun postgres migrations carefully";
    const sections = parsePlaybook(content);
    const kw = sections[0].keywords;
    expect(kw).toContain("database");
    expect(kw).toContain("migration");
    expect(kw).toContain("postgres");
    expect(kw).toContain("migrations");
    expect(kw).toContain("carefully");
  });

  it("filters out stop words from keywords", () => {
    const content = "## The Section\nThis is a very simple and basic test";
    const sections = parsePlaybook(content);
    const kw = sections[0].keywords;
    // "the", "this", "is", "a", "very", "and" are stop words
    expect(kw).not.toContain("the");
    expect(kw).not.toContain("this");
    expect(kw).not.toContain("very");
    expect(kw).not.toContain("and");
  });

  it("filters out words with 2 or fewer characters", () => {
    const content = "## UI UX\nDo it or go to db";
    const sections = parsePlaybook(content);
    const kw = sections[0].keywords;
    // "ui", "ux", "do", "it", "or", "go", "to", "db" are all <= 2 chars or stop words
    expect(kw).toEqual([]);
  });

  it("lowercases all keywords", () => {
    const content = "## TypeScript Configuration\nUse STRICT mode";
    const sections = parsePlaybook(content);
    const kw = sections[0].keywords;
    expect(kw).toContain("typescript");
    expect(kw).toContain("configuration");
    expect(kw).toContain("strict");
    expect(kw).toContain("mode");
    expect(kw).not.toContain("TypeScript");
    expect(kw).not.toContain("STRICT");
  });

  it("strips non-alphanumeric characters (except dashes, dots, underscores, slashes)", () => {
    const content = "## Code Style!\nUse eslint@latest; config_file.json, path/to/file";
    const sections = parsePlaybook(content);
    const kw = sections[0].keywords;
    expect(kw).toContain("code");
    expect(kw).toContain("style");
    expect(kw).toContain("eslint");
    expect(kw).toContain("config_file.json");
    expect(kw).toContain("path/to/file");
  });

  it("preserves hyphenated words and file paths in keywords", () => {
    const content = "## Error Handling\nuse error-boundary in src/components/error-boundary.tsx";
    const sections = parsePlaybook(content);
    const kw = sections[0].keywords;
    expect(kw).toContain("error-boundary");
    expect(kw).toContain("src/components/error-boundary.tsx");
  });
});

// ─── selectRelevantSections ──────────────────────────────────────

describe("selectRelevantSections", () => {
  function makeSection(heading: string, content: string): PlaybookSection {
    // Replicate keyword extraction logic from parsePlaybook
    return parsePlaybook(`## ${heading}\n${content}`)[0];
  }

  const alwaysSections = [
    makeSection("Project Identity", "This project is a CLI tool"),
    makeSection("Prompt Structure", "Format prompts clearly"),
    makeSection("Mandatory Checklist", "Always run tests"),
    makeSection("Stats", "Total prompts: 42"),
  ];

  it("always includes Project Identity, Prompt Structure, Mandatory Checklist, and Stats", () => {
    const others = [
      makeSection("Database", "postgres migration schema"),
      makeSection("Frontend", "react components styling"),
    ];
    const all = [...alwaysSections, ...others];

    const result = selectRelevantSections(all, "unrelated topic zebra");
    const headings = result.map((s) => s.heading);
    expect(headings).toContain("Project Identity");
    expect(headings).toContain("Prompt Structure");
    expect(headings).toContain("Mandatory Checklist");
    expect(headings).toContain("Stats");
  });

  it("includes sections matching prompt keywords", () => {
    const others = [
      makeSection("Database", "postgres migration schema indexes"),
      makeSection("Frontend", "react components styling tailwind"),
      makeSection("Testing", "vitest unit integration coverage"),
    ];
    const all = [...alwaysSections, ...others];

    const result = selectRelevantSections(all, "fix the postgres migration");
    const headings = result.map((s) => s.heading);
    expect(headings).toContain("Database");
  });

  it("caps additional sections at 3 even when all match", () => {
    const others = [
      makeSection("React Components", "react component rendering hooks"),
      makeSection("React Testing", "react testing library render screen"),
      makeSection("React Router", "react router navigation routes"),
      makeSection("React State", "react state management redux zustand"),
      makeSection("React Styling", "react styling tailwind css modules"),
    ];
    const all = [...alwaysSections, ...others];

    const result = selectRelevantSections(all, "react component rendering");
    // 4 always-inject + at most 3 additional = max 7
    expect(result.length).toBeLessThanOrEqual(7);

    const nonAlways = result.filter(
      (s) => !["Project Identity", "Prompt Structure", "Mandatory Checklist", "Stats"]
        .includes(s.heading),
    );
    expect(nonAlways.length).toBeLessThanOrEqual(3);
  });

  it("falls back to including top 3 when no prompt keywords match", () => {
    const others = [
      makeSection("Database", "postgres migration schema"),
      makeSection("Frontend", "react components styling"),
      makeSection("Testing", "vitest unit integration"),
    ];
    const all = [...alwaysSections, ...others];

    // Prompt with words that match nothing
    const result = selectRelevantSections(all, "zyxwv completely unrelated gibberish");
    const headings = result.map((s) => s.heading);
    // Should still include always-inject + fallback top 3
    expect(headings).toContain("Database");
    expect(headings).toContain("Frontend");
    expect(headings).toContain("Testing");
  });

  it("returns only always-inject sections when no other sections exist", () => {
    const result = selectRelevantSections(alwaysSections, "anything at all");
    expect(result).toHaveLength(4);
    const headings = result.map((s) => s.heading);
    expect(headings).toContain("Project Identity");
    expect(headings).toContain("Prompt Structure");
    expect(headings).toContain("Mandatory Checklist");
    expect(headings).toContain("Stats");
  });

  it("returns empty array when given no sections", () => {
    const result = selectRelevantSections([], "some prompt");
    expect(result).toEqual([]);
  });

  it("handles sections with no keywords gracefully (score=0)", () => {
    // Short words only => no keywords after filtering
    const emptyKw = makeSection("Go", "do it");
    const real = makeSection("Deployment Pipeline", "docker kubernetes terraform helm");
    const all = [...alwaysSections, emptyKw, real];

    const result = selectRelevantSections(all, "deploy with docker kubernetes");
    const headings = result.map((s) => s.heading);
    expect(headings).toContain("Deployment Pipeline");
  });

  it("scores by normalized keyword overlap (not raw count)", () => {
    // Small section with high overlap ratio should score higher than
    // large section with same raw overlap count
    const small = makeSection("Deployment", "docker compose deploy");
    const large = makeSection(
      "Everything",
      "docker react postgres redis kafka elasticsearch nginx terraform ansible puppet" +
      " monitoring grafana prometheus alerting logging kibana fluentd jaeger tracing",
    );
    const all = [...alwaysSections, small, large];

    const result = selectRelevantSections(all, "docker compose deploy");
    const nonAlways = result.filter(
      (s) => !["Project Identity", "Prompt Structure", "Mandatory Checklist", "Stats"]
        .includes(s.heading),
    );
    // "Deployment" should rank first because its overlap/sqrt(kw_count) is higher
    expect(nonAlways[0].heading).toBe("Deployment");
  });

  it("matches always-inject headings case-insensitively", () => {
    const mixed = [
      makeSection("PROJECT IDENTITY", "our project"),
      makeSection("prompt structure", "how to prompt"),
      makeSection("Mandatory Checklist", "always check"),
      makeSection("STATS", "numbers here"),
      makeSection("Other", "extra content keywords"),
    ];

    const result = selectRelevantSections(mixed, "unrelated prompt zebra");
    const headings = result.map((s) => s.heading);
    expect(headings).toContain("PROJECT IDENTITY");
    expect(headings).toContain("prompt structure");
    expect(headings).toContain("Mandatory Checklist");
    expect(headings).toContain("STATS");
  });

  it("matches always-inject headings by substring (e.g. 'Project Identity & Goals')", () => {
    const extended = [
      makeSection("Project Identity & Goals", "our project mission"),
      makeSection("Prompt Structure Guidelines", "format rules"),
      makeSection("Mandatory Checklist Items", "check these"),
      makeSection("Stats Overview", "numbers dashboard"),
      makeSection("Unrelated", "extra stuff here"),
    ];

    const result = selectRelevantSections(extended, "random topic zebra");
    const headings = result.map((s) => s.heading);
    expect(headings).toContain("Project Identity & Goals");
    expect(headings).toContain("Prompt Structure Guidelines");
    expect(headings).toContain("Mandatory Checklist Items");
    expect(headings).toContain("Stats Overview");
  });

  it("includes fewer than 3 additional if fewer non-always candidates exist", () => {
    const sections = [
      ...alwaysSections,
      makeSection("Solo Extra", "only one extra section here"),
    ];

    const result = selectRelevantSections(sections, "extra section");
    const nonAlways = result.filter(
      (s) => !["Project Identity", "Prompt Structure", "Mandatory Checklist", "Stats"]
        .includes(s.heading),
    );
    expect(nonAlways).toHaveLength(1);
    expect(nonAlways[0].heading).toBe("Solo Extra");
  });
});

// ─── buildInjectionBlock ─────────────────────────────────────────

describe("buildInjectionBlock", () => {
  it("wraps sections in boost-context XML", () => {
    const sections: PlaybookSection[] = [
      { heading: "Project Identity", content: "CLI tool", keywords: [] },
      { heading: "Stats", content: "Total: 5", keywords: [] },
    ];

    const result = buildInjectionBlock(sections);
    expect(result.startsWith('<boost-context source="project-playbook">')).toBe(true);
    expect(result.endsWith("</boost-context>")).toBe(true);
    expect(result).toContain("## Project Identity\nCLI tool");
    expect(result).toContain("## Stats\nTotal: 5");
  });

  it("separates sections with double newlines", () => {
    const sections: PlaybookSection[] = [
      { heading: "A", content: "one", keywords: [] },
      { heading: "B", content: "two", keywords: [] },
      { heading: "C", content: "three", keywords: [] },
    ];

    const result = buildInjectionBlock(sections);
    expect(result).toContain("## A\none\n\n## B\ntwo\n\n## C\nthree");
  });

  it("handles a single section", () => {
    const sections: PlaybookSection[] = [
      { heading: "Only", content: "sole section", keywords: [] },
    ];

    const result = buildInjectionBlock(sections);
    const expected = [
      '<boost-context source="project-playbook">',
      "## Only",
      "sole section",
      "</boost-context>",
    ].join("\n");
    expect(result).toBe(expected);
  });

  it("handles empty sections array", () => {
    const result = buildInjectionBlock([]);
    expect(result).toBe(
      '<boost-context source="project-playbook">\n\n</boost-context>',
    );
  });

  it("preserves multiline content within sections", () => {
    const sections: PlaybookSection[] = [
      {
        heading: "Rules",
        content: "- Rule one\n- Rule two\n- Rule three",
        keywords: [],
      },
    ];

    const result = buildInjectionBlock(sections);
    expect(result).toContain("- Rule one\n- Rule two\n- Rule three");
  });
});

// ─── updateStatsSection ──────────────────────────────────────────

describe("updateStatsSection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    invalidateCache();
    tmpDir = await mkdtemp(join(tmpdir(), "playbook-test-"));
  });

  afterEach(async () => {
    invalidateCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTestPlaybook(content: string): Promise<void> {
    await writeFile(join(tmpDir, "playbook.md"), content, "utf-8");
  }

  async function readTestPlaybook(): Promise<string> {
    return readFile(join(tmpDir, "playbook.md"), "utf-8");
  }

  it("replaces existing Stats section at end of file", async () => {
    await writeTestPlaybook([
      "## Project Identity",
      "My project",
      "",
      "## Stats",
      "Old stats content",
      "More old stats",
    ].join("\n"));

    await updateStatsSection(tmpDir, "New stats: 100 prompts");
    const result = await readTestPlaybook();

    expect(result).toContain("## Project Identity\nMy project");
    expect(result).toContain("## Stats\nNew stats: 100 prompts");
    expect(result).not.toContain("Old stats content");
    expect(result).not.toContain("More old stats");
  });

  it("replaces existing Stats section in the middle of file", async () => {
    await writeTestPlaybook([
      "## Project Identity",
      "My project",
      "",
      "## Stats",
      "Old stats",
      "",
      "## Mandatory Checklist",
      "Run tests always",
    ].join("\n"));

    await updateStatsSection(tmpDir, "Updated stats: 200 prompts");
    const result = await readTestPlaybook();

    expect(result).toContain("## Stats\nUpdated stats: 200 prompts");
    expect(result).toContain("## Mandatory Checklist\nRun tests always");
    expect(result).not.toContain("Old stats");
  });

  it("appends Stats section when missing from playbook", async () => {
    await writeTestPlaybook([
      "## Project Identity",
      "My project",
      "",
      "## Mandatory Checklist",
      "Run tests",
    ].join("\n"));

    await updateStatsSection(tmpDir, "Brand new stats");
    const result = await readTestPlaybook();

    expect(result).toContain("## Project Identity\nMy project");
    expect(result).toContain("## Mandatory Checklist\nRun tests");
    expect(result).toContain("## Stats\nBrand new stats");
  });

  it("does nothing when playbook file does not exist", async () => {
    // tmpDir exists but has no playbook.md
    await updateStatsSection(tmpDir, "stats content");
    // Should not throw, should not create the file
    const files = await readFile(join(tmpDir, "playbook.md"), "utf-8").catch(() => null);
    expect(files).toBeNull();
  });

  it("preserves all other sections when replacing Stats", async () => {
    await writeTestPlaybook([
      "## Project Identity",
      "Identity content here",
      "",
      "## Prompt Structure",
      "Structure content here",
      "",
      "## Stats",
      "Old stats line 1",
      "Old stats line 2",
      "",
      "## Mandatory Checklist",
      "Checklist content here",
      "",
      "## Database",
      "Database content here",
    ].join("\n"));

    await updateStatsSection(tmpDir, "Replaced stats");
    const result = await readTestPlaybook();

    expect(result).toContain("## Project Identity\nIdentity content here");
    expect(result).toContain("## Prompt Structure\nStructure content here");
    expect(result).toContain("## Stats\nReplaced stats");
    expect(result).toContain("## Mandatory Checklist\nChecklist content here");
    expect(result).toContain("## Database\nDatabase content here");
    expect(result).not.toContain("Old stats line 1");
  });

  it("handles Stats section with multiline content", async () => {
    await writeTestPlaybook([
      "## Stats",
      "- prompts: 10",
      "- sessions: 5",
      "- tokens: 50000",
    ].join("\n"));

    await updateStatsSection(tmpDir, "- prompts: 20\n- sessions: 10\n- tokens: 100000");
    const result = await readTestPlaybook();

    expect(result).toContain("## Stats\n- prompts: 20\n- sessions: 10\n- tokens: 100000");
    expect(result).not.toContain("prompts: 10");
  });

  it("handles playbook that is only a Stats section", async () => {
    await writeTestPlaybook("## Stats\nOld data");

    await updateStatsSection(tmpDir, "New data");
    const result = await readTestPlaybook();

    expect(result).toContain("## Stats\nNew data");
    expect(result).not.toContain("Old data");
  });

  it("invalidates the read cache after writing", async () => {
    await writeTestPlaybook("## Stats\nInitial");

    await updateStatsSection(tmpDir, "Round 1");
    // The cache should be invalidated, so a second update reads fresh content
    await updateStatsSection(tmpDir, "Round 2");
    const result = await readTestPlaybook();

    expect(result).toContain("## Stats\nRound 2");
    expect(result).not.toContain("Round 1");
    expect(result).not.toContain("Initial");
  });
});

// ─── Integration: parse -> select -> build ───────────────────────

describe("integration: parse -> select -> build", () => {
  it("produces a complete injection block from raw playbook markdown", () => {
    const playbook = [
      "## Project Identity",
      "A TypeScript CLI for data processing",
      "",
      "## Prompt Structure",
      "Be concise and cite files",
      "",
      "## Mandatory Checklist",
      "- Run vitest",
      "- Check types",
      "",
      "## Stats",
      "Sessions: 12, Prompts: 48",
      "",
      "## Database Layer",
      "Uses postgres with drizzle ORM for schema migrations",
      "",
      "## Frontend",
      "React with tailwind for component styling",
      "",
      "## API Design",
      "REST endpoints with zod validation schemas",
      "",
      "## Deployment",
      "Docker containers on kubernetes with helm charts",
    ].join("\n");

    const sections = parsePlaybook(playbook);
    expect(sections).toHaveLength(8);

    const selected = selectRelevantSections(sections, "fix the postgres drizzle migration");
    const headings = selected.map((s) => s.heading);

    // Always-inject present
    expect(headings).toContain("Project Identity");
    expect(headings).toContain("Prompt Structure");
    expect(headings).toContain("Mandatory Checklist");
    expect(headings).toContain("Stats");

    // Database should be selected due to keyword match
    expect(headings).toContain("Database Layer");

    // Build the final block
    const block = buildInjectionBlock(selected);
    expect(block.startsWith('<boost-context source="project-playbook">')).toBe(true);
    expect(block.endsWith("</boost-context>")).toBe(true);
    expect(block).toContain("## Database Layer");
    expect(block).toContain("postgres");
  });

  it("handles a minimal playbook with only always-inject sections", () => {
    const playbook = [
      "## Project Identity",
      "Small project",
      "",
      "## Stats",
      "New project, no stats",
    ].join("\n");

    const sections = parsePlaybook(playbook);
    const selected = selectRelevantSections(sections, "anything");
    const block = buildInjectionBlock(selected);

    expect(selected).toHaveLength(2);
    expect(block).toContain("## Project Identity");
    expect(block).toContain("## Stats");
  });
});
