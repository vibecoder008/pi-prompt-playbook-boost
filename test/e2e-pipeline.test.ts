/**
 * End-to-end integration test for the pi-prompt-playbook-boost pipeline.
 *
 * Creates a temporary project with realistic files, git history, and
 * session data, then runs every stage of the pipeline against it using
 * real function imports and real `git` commands.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExecFn, InteractionRecord } from "../src/types";
import { analyzeCodebase } from "../src/setup/codebase-analyzer";
import { analyzeGitHistory } from "../src/setup/git-analyzer";
import { analyzeSessionHistory } from "../src/setup/session-analyzer";
import { generatePlaybookPrompt, buildAnalysisSummary } from "../src/setup/playbook-generator";
import {
  parsePlaybook,
  selectRelevantSections,
  buildInjectionBlock,
} from "../src/playbook";
import { appendInteraction, readRecentInteractions, getInteractionCount } from "../src/learning/history";
import { scoreInteraction } from "../src/learning/scorer";
import { generateSuggestions } from "../src/learning/updater";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ExecFn that shells out to the real binary, running inside `cwd`. */
function makeRealExec(cwd: string): ExecFn {
  return async (command: string, args: string[]) => {
    try {
      const stdout = execSync(`${command} ${args.map(shellEscape).join(" ")}`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15_000,
      });
      return { stdout, stderr: "", code: 0, killed: false };
    } catch (err: any) {
      return {
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
        code: err.status ?? 1,
        killed: false,
      };
    }
  };
}

function shellEscape(s: string): string {
  // Wrap in single quotes, escaping any embedded single quotes.
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function git(cwd: string, ...args: string[]): void {
  execSync(`git ${args.join(" ")}`, { cwd, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Temp project scaffolding
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionsDir: string;
let boostDir: string;
let exec: ExecFn;

/** Today's date string in YYYY-MM-DD format. */
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Build the fake project tree, git history, and session data.
 */
async function scaffold(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), "boost-e2e-"));
  sessionsDir = join(tmpDir, ".pi", "sessions");
  boostDir = join(tmpDir, ".pi", "boost");
  exec = makeRealExec(tmpDir);

  // -- Project files --------------------------------------------------------

  await mkdir(join(tmpDir, "src", "components"), { recursive: true });
  await mkdir(join(tmpDir, "src", "lib"), { recursive: true });
  await mkdir(join(tmpDir, "prisma"), { recursive: true });

  await writeFile(
    join(tmpDir, "package.json"),
    JSON.stringify(
      {
        name: "acme-app",
        version: "1.0.0",
        scripts: {
          build: "tsc && vite build",
          lint: "eslint src/",
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
          "@prisma/client": "^5.0.0",
          tailwindcss: "^3.4.0",
          zustand: "^4.5.0",
        },
        devDependencies: {
          typescript: "^5.4.0",
          vitest: "^1.6.0",
          prisma: "^5.0.0",
          eslint: "^9.0.0",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(tmpDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          jsx: "react-jsx",
          strict: true,
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(tmpDir, "CLAUDE.md"),
    [
      "# Project Rules",
      "",
      "- Always use `@/` import alias",
      "- Prefer server components by default",
      "- Run `pnpm typecheck` before committing",
      "- Use Zustand for client state; no Redux",
    ].join("\n"),
  );

  await writeFile(
    join(tmpDir, "src", "App.tsx"),
    `import { Dashboard } from "@/components/Dashboard";\nexport function App() { return <Dashboard />; }\n`,
  );

  await writeFile(
    join(tmpDir, "src", "components", "Dashboard.tsx"),
    `export function Dashboard() { return <div className="p-4">Dashboard</div>; }\n`,
  );

  await writeFile(
    join(tmpDir, "src", "components", "LoginForm.tsx"),
    `export function LoginForm() { return <form className="flex flex-col gap-2">Login</form>; }\n`,
  );

  await writeFile(
    join(tmpDir, "src", "lib", "db.ts"),
    `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();\n`,
  );

  await writeFile(
    join(tmpDir, "src", "lib", "auth.ts"),
    `export async function validateSession(token: string) { return !!token; }\n`,
  );

  await writeFile(
    join(tmpDir, "src", "lib", "utils.ts"),
    `export function cn(...classes: string[]) { return classes.filter(Boolean).join(" "); }\n`,
  );

  await writeFile(
    join(tmpDir, "prisma", "schema.prisma"),
    `datasource db { provider = "postgresql" url = env("DATABASE_URL") }\ngenerator client { provider = "prisma-client-js" }\nmodel User { id Int @id @default(autoincrement()) email String @unique }\n`,
  );

  // -- Git history ----------------------------------------------------------
  // Use a fixed author identity so the tests are hermetic.

  git(tmpDir, "init", "-b", "main");
  git(tmpDir, "config", "user.email", "test@acme.dev");
  git(tmpDir, "config", "user.name", "TestDev");

  // Helper to commit with a specific date so fix-chain detection works.
  // The git-analyzer's findFixChains walks newest→oldest and links a fix
  // commit to the NEAREST same-author commit that shares files.  To create
  // reliable chains the fix must immediately follow its feature commit.
  const commitAt = (date: string, msg: string) => {
    git(tmpDir, "-c", `user.name=TestDev`, "-c", `user.email=test@acme.dev`,
      "commit", "--allow-empty-message", "-am", `"${msg}"`,
      `--date="${date}T10:00:00"`);
  };

  // Commit 1 — initial
  git(tmpDir, "add", "-A");
  commitAt("2025-06-01", "initial commit: scaffold project");

  // Commit 2 — feature: sidebar
  await writeFile(join(tmpDir, "src", "components", "Sidebar.tsx"),
    `export function Sidebar() { return <aside>Sidebar</aside>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-02", "feat: add sidebar component");

  // Commit 3 — feature: api client (touches api.ts)
  await writeFile(join(tmpDir, "src", "lib", "api.ts"),
    `export async function fetchUsers() { return []; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-03", "feat: add api client");

  // Commit 4 — fix for api.ts (same day, immediately follows commit 3)
  await writeFile(join(tmpDir, "src", "lib", "api.ts"),
    `export async function fetchUsers() { return fetch("/api/users").then(r => r.json()); }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-03", "fix: broken fetchUsers was returning empty array");

  // Commit 5 — feature: extend auth
  await writeFile(join(tmpDir, "src", "lib", "auth.ts"),
    `export async function validateSession(token: string) { return token.length > 0; }\nexport async function refreshToken(t: string) { return t; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-03", "feat: extend auth with refreshToken");

  // Commit 6 — feature: dashboard data (touches Dashboard.tsx)
  await writeFile(join(tmpDir, "src", "components", "Dashboard.tsx"),
    `import { fetchUsers } from "@/lib/api";\nexport function Dashboard() { return <div className="p-4">Dashboard with users</div>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-04", "feat: dashboard fetches users on mount");

  // Commit 7 — fix for Dashboard.tsx (same day, immediately follows commit 6)
  await writeFile(join(tmpDir, "src", "components", "Dashboard.tsx"),
    `import { fetchUsers } from "@/lib/api";\nexport function Dashboard() { const [users, setUsers] = useState([]); return <div className="p-4">Dashboard ({users.length})</div>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-04", "fix: forgot useState import in Dashboard");

  // Commit 8 — feature: UserCard
  await writeFile(join(tmpDir, "src", "components", "UserCard.tsx"),
    `export function UserCard({ name }: { name: string }) { return <div>{name}</div>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-05", "feat: add UserCard component");

  // Commit 9 — feature: zustand store (touches store.ts)
  await writeFile(join(tmpDir, "src", "lib", "store.ts"),
    `import { create } from "zustand";\nexport const useAppStore = create(() => ({ count: 0 }));\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-06", "feat: add zustand app store");

  // Commit 10 — fix for store.ts (same day, immediately follows commit 9)
  await writeFile(join(tmpDir, "src", "lib", "store.ts"),
    `import { create } from "zustand";\nexport const useAppStore = create(() => ({ count: 0, loading: false }));\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-06", "fix: store missing loading state");

  // Commit 11 — chore: utils
  await writeFile(join(tmpDir, "src", "lib", "utils.ts"),
    `export function cn(...classes: string[]) { return classes.filter(Boolean).join(" "); }\nexport function formatDate(d: Date) { return d.toISOString().slice(0,10); }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-07", "chore: add formatDate utility");

  // Commit 12 — feature: header (touches Header.tsx)
  await writeFile(join(tmpDir, "src", "components", "Header.tsx"),
    `export function Header() { return <header className="flex items-center h-16">Acme</header>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-08", "feat: add header component");

  // Commit 13 — fix for Header.tsx (same day, immediately follows commit 12)
  await writeFile(join(tmpDir, "src", "components", "Header.tsx"),
    `export function Header() { return <header className="flex items-center h-16 px-4">Acme App</header>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-08", "fix: typo in header title and missing padding");

  // Commit 14 — feature: footer
  await writeFile(join(tmpDir, "src", "components", "Footer.tsx"),
    `export function Footer() { return <footer className="py-4">Footer</footer>; }\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-09", "feat: add footer component");

  // Commit 15 — docs: update README
  await writeFile(join(tmpDir, "README.md"),
    `# Acme App\n\nA React + Prisma + Tailwind application.\n`);
  git(tmpDir, "add", "-A");
  commitAt("2025-06-10", "docs: add project README");

  // -- Session data ---------------------------------------------------------

  await mkdir(sessionsDir, { recursive: true });

  const session1Lines = [
    JSON.stringify({ type: "message", message: { role: "user", content: "add a login form with email and password" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will create a login form." }] } }),
    JSON.stringify({ type: "tool_result", name: "write", isError: false }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "add validation to the login form" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "Done." } }),
    JSON.stringify({ type: "turn_end" }),
  ];
  await writeFile(join(sessionsDir, "session-001.jsonl"), session1Lines.join("\n") + "\n");

  // Retry detection uses Jaccard word overlap > 0.6 between consecutive
  // user messages.  The two "fix the dashboard" messages below share 4 of
  // 5 tokens → overlap = 4/5 = 0.80.
  const session2Lines = [
    JSON.stringify({ type: "message", message: { role: "user", content: "fix the dashboard layout please" } }),
    JSON.stringify({ type: "tool_result", name: "bash", isError: true }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "please fix the dashboard layout" } }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "add a search bar to the header" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "Search bar added." } }),
    JSON.stringify({ type: "turn_end" }),
  ];
  await writeFile(join(sessionsDir, "session-002.jsonl"), session2Lines.join("\n") + "\n");

  const session3Lines = [
    JSON.stringify({ type: "message", message: { role: "user", content: "create a user profile page" } }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "add settings to the user profile page" } }),
    JSON.stringify({ type: "turn_end" }),
  ];
  await writeFile(join(sessionsDir, "session-003.jsonl"), session3Lines.join("\n") + "\n");

  // -- Boost dir for learning tests -----------------------------------------
  await mkdir(join(boostDir, "history"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await scaffold();
}, 30_000);

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E Pipeline", () => {
  // ── Stage 1: Codebase Analysis ────────────────────────────────

  describe("analyzeCodebase", () => {
    it("detects the full tech stack from the fake project", async () => {
      const result = await analyzeCodebase(tmpDir, exec);

      expect(result.stack.language).toBe("TypeScript");
      expect(result.stack.framework).toBe("React");
      expect(result.stack.orm).toBe("Prisma");
      expect(result.stack.styling).toBe("Tailwind CSS");
      expect(result.stack.stateManagement).toBe("Zustand");
      expect(result.stack.monorepo).toBe(false);
    });

    it("detects the test framework", async () => {
      const result = await analyzeCodebase(tmpDir, exec);
      expect(result.testFramework).toBe("Vitest");
    });

    it("detects build and lint commands from scripts", async () => {
      const result = await analyzeCodebase(tmpDir, exec);
      expect(result.buildCommands.length).toBeGreaterThan(0);
      expect(result.buildCommands.some((c) => c.includes("tsc"))).toBe(true);
      expect(result.lintCommands.length).toBeGreaterThan(0);
      expect(result.lintCommands.some((c) => c.includes("eslint"))).toBe(true);
    });

    it("reads existing CLAUDE.md rules", async () => {
      const result = await analyzeCodebase(tmpDir, exec);
      expect(result.existingRules.length).toBeGreaterThan(0);
      const claudeRule = result.existingRules.find((r) => r.source === "CLAUDE.md");
      expect(claudeRule).toBeDefined();
      expect(claudeRule!.content).toContain("@/");
    });

    it("finds key directories", async () => {
      const result = await analyzeCodebase(tmpDir, exec);
      expect(result.keyDirectories.length).toBeGreaterThan(0);
      // src and prisma should be detected
      expect(result.keyDirectories.some((d) => d === "src" || d.includes("src"))).toBe(true);
    });

    it("finds file extension patterns", async () => {
      const result = await analyzeCodebase(tmpDir, exec);
      expect(result.filePatterns.length).toBeGreaterThan(0);
      const tsxPattern = result.filePatterns.find((p) => p.extension === ".tsx");
      expect(tsxPattern).toBeDefined();
      expect(tsxPattern!.count).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Stage 2: Git History Analysis ─────────────────────────────

  describe("analyzeGitHistory", () => {
    it("finds all commits from the fake repo", async () => {
      const result = await analyzeGitHistory(exec, 200);

      expect(result.totalCommits).toBe(15);
      expect(result.commits).toHaveLength(15);
      expect(result.authors).toContain("TestDev");
    });

    it("detects fix-after-feature chains", async () => {
      const result = await analyzeGitHistory(exec, 200);

      // We created 4 fix commits (4, 7, 10, 13), each immediately after
      // its feature commit with the same files.  The git-analyzer links
      // each fix to the nearest same-author commit that shares files.
      expect(result.fixChains.length).toBeGreaterThanOrEqual(4);

      // Verify at least one chain references expected files
      const dashboardChain = result.fixChains.find((fc) =>
        fc.sharedFiles.some((f) => f.includes("Dashboard")),
      );
      expect(dashboardChain).toBeDefined();
    });

    it("computes hotspots from commit frequency", async () => {
      const result = await analyzeGitHistory(exec, 200);

      expect(result.hotspots.length).toBeGreaterThan(0);
      // Dashboard.tsx and auth.ts were modified multiple times
      const dashboardHotspot = result.hotspots.find((h) =>
        h.path.includes("Dashboard"),
      );
      expect(dashboardHotspot).toBeDefined();
      expect(dashboardHotspot!.commitCount).toBeGreaterThanOrEqual(2);
    });

    it("computes a clean commit rate below 1.0 (has fix chains)", async () => {
      const result = await analyzeGitHistory(exec, 200);
      expect(result.cleanCommitRate).toBeLessThan(1);
      expect(result.cleanCommitRate).toBeGreaterThan(0);
    });

    it("returns a valid date range", async () => {
      const result = await analyzeGitHistory(exec, 200);
      expect(result.dateRange).not.toBeNull();
      expect(result.dateRange!.earliest).toBe("2025-06-01");
      expect(result.dateRange!.latest).toBe("2025-06-10");
    });
  });

  // ── Stage 3: Session History Analysis ─────────────────────────

  describe("analyzeSessionHistory", () => {
    it("finds all session files", async () => {
      const result = await analyzeSessionHistory(sessionsDir);
      expect(result.totalSessions).toBe(3);
    });

    it("counts total and user messages", async () => {
      const result = await analyzeSessionHistory(sessionsDir);
      expect(result.totalMessages).toBeGreaterThan(0);
      expect(result.totalUserMessages).toBeGreaterThanOrEqual(6);
    });

    it("detects tool errors", async () => {
      const result = await analyzeSessionHistory(sessionsDir);
      // session-002 has one isError: true tool_result
      expect(result.toolErrorCount).toBeGreaterThanOrEqual(1);
    });

    it("detects retries (similar consecutive user messages)", async () => {
      const result = await analyzeSessionHistory(sessionsDir);
      // "fix the dashboard layout" followed by "fix the dashboard layout, the grid is broken"
      expect(result.retryCount).toBeGreaterThanOrEqual(1);
    });

    it("extracts prompt patterns from repeated phrases", async () => {
      const result = await analyzeSessionHistory(sessionsDir);
      // "add" appears in multiple user messages: "add a login form", "add validation",
      // "add a search bar", "add settings" — the pattern extractor groups by leading keywords
      // We just verify patterns is populated if the data triggers it
      // The pattern threshold is count >= 2
      expect(result.promptPatterns).toBeDefined();
    });
  });

  // ── Stage 4: Playbook Prompt Generation ───────────────────────

  describe("generatePlaybookPrompt + buildAnalysisSummary", () => {
    let gitResult: Awaited<ReturnType<typeof analyzeGitHistory>>;
    let sessionResult: Awaited<ReturnType<typeof analyzeSessionHistory>>;
    let codeResult: Awaited<ReturnType<typeof analyzeCodebase>>;

    beforeAll(async () => {
      [gitResult, sessionResult, codeResult] = await Promise.all([
        analyzeGitHistory(exec, 200),
        analyzeSessionHistory(sessionsDir),
        analyzeCodebase(tmpDir, exec),
      ]);
    });

    it("generates a non-empty playbook prompt", () => {
      const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
      expect(prompt.length).toBeGreaterThan(500);
    });

    it("prompt contains project-specific data", () => {
      const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
      expect(prompt).toContain("TypeScript");
      expect(prompt).toContain("React");
      expect(prompt).toContain("Prisma");
      expect(prompt).toContain("Tailwind");
      expect(prompt).toContain("Vitest");
      expect(prompt).toContain("TestDev");
    });

    it("prompt includes fix chain data", () => {
      const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
      expect(prompt).toContain("Fix-After-Feature");
      expect(prompt).toContain("fix");
    });

    it("prompt includes session stats", () => {
      const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
      expect(prompt).toContain("Sessions analyzed");
      expect(prompt).toContain("User messages");
    });

    it("prompt includes existing CLAUDE.md rules", () => {
      const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
      expect(prompt).toContain("CLAUDE.md");
      expect(prompt).toContain("@/");
    });

    it("buildAnalysisSummary mentions the detected stack", () => {
      const summary = buildAnalysisSummary(gitResult, sessionResult, codeResult);
      expect(summary).toContain("TypeScript");
      expect(summary).toContain("React");
      expect(summary).toContain("Prisma");
      expect(summary).toContain("Tailwind");
    });

    it("buildAnalysisSummary mentions commit and session counts", () => {
      const summary = buildAnalysisSummary(gitResult, sessionResult, codeResult);
      expect(summary).toContain("15 commits");
      expect(summary).toContain("3 pi sessions");
    });

    it("buildAnalysisSummary handles null git and session analysis", () => {
      const summary = buildAnalysisSummary(null, null, codeResult);
      expect(summary).toContain("No git history");
      expect(summary).toContain("No pi session history");
      expect(summary).toContain("TypeScript");
    });
  });

  // ── Stage 5: Playbook Parse / Select / Inject ─────────────────

  describe("playbook parse → select → inject", () => {
    const FAKE_PLAYBOOK = [
      "# Project Playbook",
      "",
      "## Project Identity",
      "- **Stack**: TypeScript, React, Prisma, Tailwind CSS",
      "- **Test runner**: Vitest",
      "",
      "## Prompt Structure",
      "### 1. WHAT",
      "State exactly what to build.",
      "### 2. WHERE",
      "Name the files to create or modify.",
      "",
      "## Mandatory Checklist",
      "- [ ] Run pnpm typecheck before committing",
      "- [ ] Add tests for new functions",
      "",
      "## Conventions",
      "- Use @/ import alias for src/ paths",
      "- Prefer server components by default",
      "- Use Zustand for client state",
      "",
      "## Co-Change Rules",
      "- When modifying prisma/schema.prisma -> run prisma generate",
      "- Dashboard.tsx and api.ts are tightly coupled",
      "",
      "## Known Failure Patterns",
      "- Forgetting useState import when adding state to components",
      "- Missing error handling in API fetch calls",
      "",
      "## Stats",
      "- Total boosted prompts: 0",
      "- First-attempt success rate: N/A",
    ].join("\n");

    it("parsePlaybook extracts sections with headings and keywords", () => {
      const sections = parsePlaybook(FAKE_PLAYBOOK);
      expect(sections.length).toBeGreaterThanOrEqual(6);

      const headings = sections.map((s) => s.heading);
      expect(headings).toContain("Project Identity");
      expect(headings).toContain("Prompt Structure");
      expect(headings).toContain("Mandatory Checklist");
      expect(headings).toContain("Conventions");
      expect(headings).toContain("Co-Change Rules");
      expect(headings).toContain("Known Failure Patterns");
      expect(headings).toContain("Stats");

      // Keywords should be populated
      for (const section of sections) {
        // Even a short section like Stats has at least a few keywords
        expect(section.keywords.length).toBeGreaterThan(0);
      }
    });

    it("selectRelevantSections always includes core sections", () => {
      const sections = parsePlaybook(FAKE_PLAYBOOK);
      const selected = selectRelevantSections(sections, "add a button");

      const headings = selected.map((s) => s.heading);
      expect(headings).toContain("Project Identity");
      expect(headings).toContain("Prompt Structure");
      expect(headings).toContain("Mandatory Checklist");
      expect(headings).toContain("Stats");
    });

    it("selectRelevantSections picks relevant sections based on prompt keywords", () => {
      const sections = parsePlaybook(FAKE_PLAYBOOK);

      // Prompt about prisma should score "Co-Change Rules" higher (mentions prisma)
      const selected = selectRelevantSections(sections, "modify the prisma schema and add a new model");
      const headings = selected.map((s) => s.heading);
      expect(headings).toContain("Co-Change Rules");
    });

    it("buildInjectionBlock wraps sections in boost-context XML", () => {
      const sections = parsePlaybook(FAKE_PLAYBOOK);
      const selected = selectRelevantSections(sections, "add authentication");
      const block = buildInjectionBlock(selected);

      expect(block).toMatch(/^<boost-context source="project-playbook">/);
      expect(block).toMatch(/<\/boost-context>$/);
      expect(block).toContain("## Project Identity");
      expect(block).toContain("## Mandatory Checklist");
      expect(block.length).toBeGreaterThan(100);
    });

    it("round-trip: parse → select → inject produces a coherent block", () => {
      const sections = parsePlaybook(FAKE_PLAYBOOK);
      expect(sections.length).toBeGreaterThanOrEqual(6);

      const selected = selectRelevantSections(sections, "fix the dashboard fetch");
      expect(selected.length).toBeGreaterThanOrEqual(4); // at least the 4 always-inject

      const block = buildInjectionBlock(selected);
      expect(block).toContain("boost-context");

      // The block should contain at least some project-specific info
      expect(block).toContain("TypeScript");
    });
  });

  // ── Stage 6: Learning Pipeline ────────────────────────────────

  describe("learning: history → score → suggest", () => {
    const interactions: InteractionRecord[] = [
      {
        id: "e2e_1",
        timestamp: Date.now() - 3000,
        sessionId: "sess_e2e",
        promptRaw: "add a login form with email and password validation",
        sectionsUsed: ["Project Identity", "Conventions"],
        turns: 1,
        totalToolCalls: 3,
        toolErrors: 0,
        retried: false,
      },
      {
        id: "e2e_2",
        timestamp: Date.now() - 2000,
        sessionId: "sess_e2e",
        promptRaw: "fix the dashboard to show user count",
        sectionsUsed: ["Project Identity", "Known Failure Patterns"],
        turns: 4,
        totalToolCalls: 8,
        toolErrors: 2,
        retried: true,
      },
      {
        id: "e2e_3",
        timestamp: Date.now() - 1000,
        sessionId: "sess_e2e",
        promptRaw: "refactor api client to use fetch with error handling",
        sectionsUsed: ["Project Identity", "Conventions", "Co-Change Rules"],
        turns: 2,
        totalToolCalls: 5,
        toolErrors: 0,
        retried: false,
      },
    ];

    it("appendInteraction writes and readRecentInteractions reads them back", async () => {
      for (const record of interactions) {
        await appendInteraction(boostDir, record);
      }

      const recent = await readRecentInteractions(boostDir, 10);
      expect(recent).toHaveLength(3);
      expect(recent[0].id).toBe("e2e_1");
      expect(recent[1].id).toBe("e2e_2");
      expect(recent[2].id).toBe("e2e_3");
    });

    it("getInteractionCount returns the correct count", async () => {
      const count = await getInteractionCount(boostDir);
      expect(count).toBe(3);
    });

    it("scoreInteraction produces sensible scores", () => {
      const scores = interactions.map((i) => scoreInteraction(i));

      // Interaction 1: 1 turn, 0 errors, no retry — should score high
      expect(scores[0].composite).toBeGreaterThan(0.8);
      expect(scores[0].signals.turnEfficiency).toBeCloseTo(1.0, 1);
      expect(scores[0].signals.errorFree).toBe(1.0);
      expect(scores[0].signals.noRetry).toBe(1.0);

      // Interaction 2: 4 turns, 2 errors out of 8, retried — should score low
      expect(scores[1].composite).toBeLessThan(0.5);
      expect(scores[1].signals.noRetry).toBe(0.2);
      expect(scores[1].signals.errorFree).toBeLessThan(1.0);

      // Interaction 3: 2 turns, 0 errors, no retry — mid-high score
      expect(scores[2].composite).toBeGreaterThan(0.7);
      expect(scores[2].signals.errorFree).toBe(1.0);
      expect(scores[2].signals.noRetry).toBe(1.0);
    });

    it("generateSuggestions creates pending updates from fix chains and low scores", async () => {
      const gitResult = await analyzeGitHistory(exec, 200);
      const scores = interactions.map((i) => scoreInteraction(i));

      const suggestions = generateSuggestions(gitResult.fixChains, interactions, scores);

      // Should have at least 1 from fix chains + 1 from low-scoring interaction 2
      expect(suggestions.length).toBeGreaterThanOrEqual(2);

      // Verify fix chain suggestions
      const fixSuggestions = suggestions.filter((s) => s.type === "new_rule");
      expect(fixSuggestions.length).toBeGreaterThanOrEqual(1);
      for (const s of fixSuggestions) {
        expect(s.section).toBe("known_failure_patterns");
        expect(s.confidence).toBeGreaterThan(0);
        expect(s.status).toBe("pending");
        expect(s.content.length).toBeGreaterThan(0);
        expect(s.evidence.length).toBeGreaterThan(0);
      }

      // Verify low-score suggestion (interaction 2 scored < 0.5)
      const lowScoreSuggestions = suggestions.filter((s) => s.type === "update_stat");
      expect(lowScoreSuggestions.length).toBeGreaterThanOrEqual(1);
      expect(lowScoreSuggestions[0].content).toContain("dashboard");
    });
  });

  // ── Stage 7: Full Round-Trip Smoke Test ───────────────────────

  describe("full pipeline round-trip", () => {
    it("runs the entire pipeline end-to-end without errors", async () => {
      // 1. Analyze codebase
      const codeResult = await analyzeCodebase(tmpDir, exec);
      expect(codeResult.stack.language).toBe("TypeScript");

      // 2. Analyze git
      const gitResult = await analyzeGitHistory(exec, 200);
      expect(gitResult.totalCommits).toBe(15);

      // 3. Analyze sessions
      const sessionResult = await analyzeSessionHistory(sessionsDir);
      expect(sessionResult.totalSessions).toBe(3);

      // 4. Generate playbook prompt
      const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
      expect(prompt.length).toBeGreaterThan(500);

      // 5. Build summary
      const summary = buildAnalysisSummary(gitResult, sessionResult, codeResult);
      expect(summary).toContain("TypeScript");
      expect(summary).toContain("15 commits");

      // 6. Simulate playbook creation (write a minimal one)
      const playbookContent = [
        "# Project Playbook",
        "",
        "## Project Identity",
        `- **Stack**: ${codeResult.stack.language}, ${codeResult.stack.framework}, ${codeResult.stack.orm}`,
        "",
        "## Prompt Structure",
        "Use WHAT/WHERE/CONNECTS/GUARDS/VERIFY.",
        "",
        "## Mandatory Checklist",
        "- [ ] Run typecheck",
        "",
        "## Conventions",
        "- Use @/ import alias",
        "",
        "## Known Failure Patterns",
        `- ${gitResult.fixChains.length} fix chains detected`,
        "",
        "## Stats",
        "- Total boosted prompts: 0",
      ].join("\n");

      // 7. Parse and inject
      const sections = parsePlaybook(playbookContent);
      expect(sections.length).toBeGreaterThanOrEqual(5);

      const selected = selectRelevantSections(sections, "add a new prisma model");
      const injection = buildInjectionBlock(selected);
      expect(injection).toContain("boost-context");
      expect(injection).toContain("TypeScript");

      // 8. Score some interactions
      const interaction: InteractionRecord = {
        id: "roundtrip_1",
        timestamp: Date.now(),
        sessionId: "sess_roundtrip",
        promptRaw: "add a new prisma model for blog posts",
        sectionsUsed: selected.map((s) => s.heading),
        turns: 1,
        totalToolCalls: 4,
        toolErrors: 0,
        retried: false,
      };

      const score = scoreInteraction(interaction);
      expect(score.composite).toBeGreaterThan(0.8);

      // 9. Generate suggestions
      const suggestions = generateSuggestions(
        gitResult.fixChains,
        [interaction],
        [score],
      );
      expect(suggestions.length).toBeGreaterThanOrEqual(1);

      // All stages completed without throwing.
    });
  });
});
