import { describe, it, expect } from "vitest";
import {
  findFixChains,
  findCoupling,
  getLastCommitHash,
  analyzeGitHistory,
} from "../src/setup/git-analyzer";
import type { CommitInfo, ExecFn } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    hash: "abc123",
    date: "2025-06-15",
    author: "alice",
    message: "add feature",
    files: [{ path: "src/app.ts", added: 10, deleted: 2 }],
    ...overrides,
  };
}

function makeExec(stdout: string, code: number = 0): ExecFn {
  return async (_cmd: string, _args: string[]) => ({
    stdout,
    stderr: "",
    code,
    killed: false,
  });
}

function failExec(): ExecFn {
  return async () => ({ stdout: "", stderr: "fatal: not a git repo", code: 128, killed: false });
}

function throwExec(): ExecFn {
  return async () => {
    throw new Error("process failed");
  };
}

// ─── findFixChains ───────────────────────────────────────────────

describe("findFixChains", () => {
  it("returns empty array for empty commit list", () => {
    expect(findFixChains([])).toEqual([]);
  });

  it("returns empty array when no commits match fix pattern", () => {
    const commits = [
      makeCommit({ hash: "a1", message: "add user auth" }),
      makeCommit({ hash: "a2", message: "implement dashboard" }),
    ];
    expect(findFixChains(commits)).toEqual([]);
  });

  it("detects a simple fix chain (fix after feature, same author, shared file)", () => {
    const commits: CommitInfo[] = [
      // Newest first (git log order)
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix typo in app",
        files: [{ path: "src/app.ts", added: 1, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add feature",
        files: [{ path: "src/app.ts", added: 50, deleted: 0 }],
      }),
    ];

    const chains = findFixChains(commits);
    expect(chains).toHaveLength(1);
    expect(chains[0].fixCommit.hash).toBe("fix1");
    expect(chains[0].featureCommit.hash).toBe("feat1");
    expect(chains[0].sharedFiles).toEqual(["src/app.ts"]);
    expect(chains[0].hoursBetween).toBe(0); // same day
  });

  it("does not link fix to commit by a different author", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix broken test",
        files: [{ path: "src/app.ts", added: 1, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "bob",
        message: "add feature",
        files: [{ path: "src/app.ts", added: 50, deleted: 0 }],
      }),
    ];

    expect(findFixChains(commits)).toEqual([]);
  });

  it("does not link fix to commit with no shared files", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix config",
        files: [{ path: "config.json", added: 1, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add feature",
        files: [{ path: "src/app.ts", added: 50, deleted: 0 }],
      }),
    ];

    expect(findFixChains(commits)).toEqual([]);
  });

  it("does not link fix to commit more than 24 hours apart", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2025-06-17",
        author: "alice",
        message: "fix bug",
        files: [{ path: "src/app.ts", added: 1, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add feature",
        files: [{ path: "src/app.ts", added: 50, deleted: 0 }],
      }),
    ];

    // 2 days apart = 48 hours > 24
    expect(findFixChains(commits)).toEqual([]);
  });

  it("handles same-day commits (0 hours between)", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "oops forgot semicolon",
        files: [{ path: "src/index.ts", added: 1, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "implement parser",
        files: [{ path: "src/index.ts", added: 100, deleted: 5 }],
      }),
    ];

    const chains = findFixChains(commits);
    expect(chains).toHaveLength(1);
    expect(chains[0].hoursBetween).toBe(0);
  });

  it("detects multiple fix chains", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix2",
        date: "2025-06-16",
        author: "bob",
        message: "hotfix api crash",
        files: [{ path: "src/api.ts", added: 2, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat2",
        date: "2025-06-16",
        author: "bob",
        message: "add api endpoint",
        files: [{ path: "src/api.ts", added: 40, deleted: 0 }],
      }),
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix typo",
        files: [{ path: "src/app.ts", added: 1, deleted: 1 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add feature",
        files: [{ path: "src/app.ts", added: 50, deleted: 0 }],
      }),
    ];

    const chains = findFixChains(commits);
    expect(chains).toHaveLength(2);
    expect(chains[0].fixCommit.hash).toBe("fix2");
    expect(chains[0].featureCommit.hash).toBe("feat2");
    expect(chains[1].fixCommit.hash).toBe("fix1");
    expect(chains[1].featureCommit.hash).toBe("feat1");
  });

  it("matches various fix patterns: patch, oops, typo, forgot, broken, revert, hotfix, fixup", () => {
    const patterns = ["patch leak", "oops wrong var", "typo in name", "forgot import",
      "broken after merge", "revert bad change", "hotfix null ref", "fixup lint"];

    for (const msg of patterns) {
      const commits: CommitInfo[] = [
        makeCommit({
          hash: `fix-${msg}`,
          date: "2025-06-15",
          author: "alice",
          message: msg,
          files: [{ path: "src/x.ts", added: 1, deleted: 1 }],
        }),
        makeCommit({
          hash: "feat-base",
          date: "2025-06-15",
          author: "alice",
          message: "add feature",
          files: [{ path: "src/x.ts", added: 10, deleted: 0 }],
        }),
      ];

      const chains = findFixChains(commits);
      expect(chains).toHaveLength(1);
    }
  });

  it("only links fix to nearest same-author commit (skips intervening other-author commits)", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix crash",
        files: [{ path: "src/app.ts", added: 1, deleted: 1 }],
      }),
      // bob's commit in between — should be skipped
      makeCommit({
        hash: "bob1",
        date: "2025-06-15",
        author: "bob",
        message: "refactor utils",
        files: [{ path: "src/app.ts", added: 5, deleted: 5 }],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add feature",
        files: [{ path: "src/app.ts", added: 50, deleted: 0 }],
      }),
    ];

    const chains = findFixChains(commits);
    expect(chains).toHaveLength(1);
    expect(chains[0].featureCommit.hash).toBe("feat1");
  });

  it("reports shared files correctly when commits touch multiple files", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix rendering",
        files: [
          { path: "src/app.ts", added: 1, deleted: 1 },
          { path: "src/utils.ts", added: 2, deleted: 0 },
          { path: "src/unrelated.ts", added: 1, deleted: 0 },
        ],
      }),
      makeCommit({
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add feature",
        files: [
          { path: "src/app.ts", added: 50, deleted: 0 },
          { path: "src/utils.ts", added: 10, deleted: 0 },
          { path: "src/other.ts", added: 20, deleted: 0 },
        ],
      }),
    ];

    const chains = findFixChains(commits);
    expect(chains).toHaveLength(1);
    expect(chains[0].sharedFiles).toContain("src/app.ts");
    expect(chains[0].sharedFiles).toContain("src/utils.ts");
    expect(chains[0].sharedFiles).not.toContain("src/unrelated.ts");
    expect(chains[0].sharedFiles).not.toContain("src/other.ts");
  });

  it("returns empty for single commit", () => {
    const commits = [makeCommit({ message: "fix something" })];
    // Need at least 2 commits (a fix and a feature) for a chain
    expect(findFixChains(commits)).toEqual([]);
  });
});

// ─── findCoupling ────────────────────────────────────────────────

describe("findCoupling", () => {
  it("returns empty array for empty commit list", () => {
    expect(findCoupling([])).toEqual([]);
  });

  it("returns empty when no pair exceeds threshold (<=5 co-occurrences)", () => {
    // Only 3 commits touching the same pair
    const commits = Array.from({ length: 3 }, (_, i) =>
      makeCommit({
        hash: `c${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );

    expect(findCoupling(commits)).toEqual([]);
  });

  it("returns empty when co-occurrences > 5 but coupling rate <= 30%", () => {
    // a.ts and b.ts co-occur in 6 commits, but a.ts appears in 30 total
    // coupling rate = 6/30 = 0.2 (below 0.3 threshold)
    const coCommits = Array.from({ length: 6 }, (_, i) =>
      makeCommit({
        hash: `co${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );
    const soloCommits = Array.from({ length: 24 }, (_, i) =>
      makeCommit({
        hash: `solo${i}`,
        files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
      }),
    );

    expect(findCoupling([...coCommits, ...soloCommits])).toEqual([]);
  });

  it("detects coupling when pair exceeds both thresholds", () => {
    // a.ts and b.ts co-occur in 8 commits, a.ts total = 10, b.ts total = 8
    // coupling rate = 8/max(10,8) = 8/10 = 0.8
    const coCommits = Array.from({ length: 8 }, (_, i) =>
      makeCommit({
        hash: `co${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );
    const soloCommits = Array.from({ length: 2 }, (_, i) =>
      makeCommit({
        hash: `solo${i}`,
        files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
      }),
    );

    const rules = findCoupling([...coCommits, ...soloCommits]);
    expect(rules).toHaveLength(1);
    expect(rules[0].fileA).toBe("src/a.ts");
    expect(rules[0].fileB).toBe("src/b.ts");
    expect(rules[0].coOccurrences).toBe(8);
    expect(rules[0].couplingRate).toBeCloseTo(0.8, 4);
    expect(rules[0].totalCommitsA).toBe(10);
    expect(rules[0].totalCommitsB).toBe(8);
  });

  it("sorts results by coupling rate descending", () => {
    // Pair (a,b): 7 co-occurrences, a=10 total => rate 7/10 = 0.7
    // Pair (c,d): 9 co-occurrences, c=10 total => rate 9/10 = 0.9
    const abCommits = Array.from({ length: 7 }, (_, i) =>
      makeCommit({
        hash: `ab${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );
    const aSolo = Array.from({ length: 3 }, (_, i) =>
      makeCommit({
        hash: `a-solo${i}`,
        files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
      }),
    );
    const cdCommits = Array.from({ length: 9 }, (_, i) =>
      makeCommit({
        hash: `cd${i}`,
        files: [
          { path: "src/c.ts", added: 1, deleted: 0 },
          { path: "src/d.ts", added: 1, deleted: 0 },
        ],
      }),
    );
    const cSolo = Array.from({ length: 1 }, (_, i) =>
      makeCommit({
        hash: `c-solo${i}`,
        files: [{ path: "src/c.ts", added: 1, deleted: 0 }],
      }),
    );

    const rules = findCoupling([...abCommits, ...aSolo, ...cdCommits, ...cSolo]);
    expect(rules.length).toBeGreaterThanOrEqual(2);
    // c,d pair (0.9) should come before a,b pair (0.7)
    expect(rules[0].couplingRate).toBeGreaterThan(rules[1].couplingRate);
  });

  it("uses alphabetical pair keys (fileA < fileB)", () => {
    const commits = Array.from({ length: 7 }, (_, i) =>
      makeCommit({
        hash: `c${i}`,
        files: [
          { path: "z-file.ts", added: 1, deleted: 0 },
          { path: "a-file.ts", added: 1, deleted: 0 },
        ],
      }),
    );

    const rules = findCoupling(commits);
    expect(rules).toHaveLength(1);
    // Deterministic: alphabetically first should be fileA
    expect(rules[0].fileA).toBe("a-file.ts");
    expect(rules[0].fileB).toBe("z-file.ts");
  });

  it("counts duplicate file paths within one commit only once", () => {
    // If a file appears twice in numstat (shouldn't normally, but test dedup)
    const commits = Array.from({ length: 7 }, (_, i) =>
      makeCommit({
        hash: `c${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/a.ts", added: 2, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );

    const rules = findCoupling(commits);
    expect(rules).toHaveLength(1);
    // Should count each commit once for a.ts, not twice
    expect(rules[0].totalCommitsA).toBe(7);
    expect(rules[0].coOccurrences).toBe(7);
  });

  it("handles commits with a single file (no pairs generated)", () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      makeCommit({
        hash: `c${i}`,
        files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
      }),
    );

    expect(findCoupling(commits)).toEqual([]);
  });

  it("boundary: exactly 5 co-occurrences does not pass threshold", () => {
    const commits = Array.from({ length: 5 }, (_, i) =>
      makeCommit({
        hash: `c${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );

    // 5 co-occurrences, rate = 5/5 = 1.0 (above 0.3), but count <= 5 so filtered
    expect(findCoupling(commits)).toEqual([]);
  });

  it("boundary: exactly 6 co-occurrences passes count threshold", () => {
    const commits = Array.from({ length: 6 }, (_, i) =>
      makeCommit({
        hash: `c${i}`,
        files: [
          { path: "src/a.ts", added: 1, deleted: 0 },
          { path: "src/b.ts", added: 1, deleted: 0 },
        ],
      }),
    );

    // 6 co-occurrences > 5, rate = 6/6 = 1.0 > 0.3
    const rules = findCoupling(commits);
    expect(rules).toHaveLength(1);
    expect(rules[0].coOccurrences).toBe(6);
    expect(rules[0].couplingRate).toBeCloseTo(1.0, 4);
  });
});

// ─── getLastCommitHash ───────────────────────────────────────────

describe("getLastCommitHash", () => {
  it("returns the trimmed hash on success", async () => {
    const exec = makeExec("abc123def456\n");
    const hash = await getLastCommitHash(exec);
    expect(hash).toBe("abc123def456");
  });

  it("returns null when git command fails (non-zero exit)", async () => {
    const exec = failExec();
    const hash = await getLastCommitHash(exec);
    expect(hash).toBeNull();
  });

  it("returns null when exec throws an error", async () => {
    const exec = throwExec();
    const hash = await getLastCommitHash(exec);
    expect(hash).toBeNull();
  });

  it("returns null when stdout is empty", async () => {
    const exec = makeExec("");
    const hash = await getLastCommitHash(exec);
    expect(hash).toBeNull();
  });

  it("returns null when stdout is only whitespace", async () => {
    const exec = makeExec("   \n  ");
    const hash = await getLastCommitHash(exec);
    expect(hash).toBeNull();
  });

  it("passes correct arguments to exec", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return { stdout: "abc123\n", stderr: "", code: 0, killed: false };
    };

    await getLastCommitHash(exec);
    expect(capturedCmd).toBe("git");
    expect(capturedArgs).toEqual(["rev-parse", "HEAD"]);
  });
});

// ─── analyzeGitHistory ───────────────────────────────────────────

describe("analyzeGitHistory", () => {
  // Simulate the git log format: COMMIT|<hash>|<date>|<author>|<message>
  // followed by numstat lines: <added>\t<deleted>\t<path>

  function buildGitLog(entries: Array<{
    hash: string;
    date: string;
    author: string;
    message: string;
    files: Array<{ added: number; deleted: number; path: string }>;
  }>): string {
    const lines: string[] = [];
    for (const entry of entries) {
      lines.push(`COMMIT|${entry.hash}|${entry.date}|${entry.author}|${entry.message}`);
      lines.push(""); // blank line after commit header
      for (const f of entry.files) {
        lines.push(`${f.added}\t${f.deleted}\t${f.path}`);
      }
      lines.push(""); // blank line after numstat
    }
    return lines.join("\n");
  }

  it("returns empty analysis when git log fails", async () => {
    const exec = failExec();
    const result = await analyzeGitHistory(exec);

    expect(result.commits).toEqual([]);
    expect(result.totalCommits).toBe(0);
    expect(result.fixChains).toEqual([]);
    expect(result.couplingRules).toEqual([]);
    expect(result.hotspots).toEqual([]);
    expect(result.cleanCommitRate).toBe(1);
    expect(result.authors).toEqual([]);
    expect(result.dateRange).toBeNull();
  });

  it("returns empty analysis when git log returns empty stdout", async () => {
    const exec = makeExec("");
    const result = await analyzeGitHistory(exec);

    expect(result.totalCommits).toBe(0);
    expect(result.dateRange).toBeNull();
  });

  it("parses commits from git log output", async () => {
    const log = buildGitLog([
      {
        hash: "aaa111",
        date: "2025-06-15",
        author: "alice",
        message: "add user auth",
        files: [
          { added: 50, deleted: 0, path: "src/auth.ts" },
          { added: 10, deleted: 2, path: "src/user.ts" },
        ],
      },
      {
        hash: "bbb222",
        date: "2025-06-14",
        author: "bob",
        message: "initial commit",
        files: [{ added: 100, deleted: 0, path: "src/index.ts" }],
      },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    expect(result.totalCommits).toBe(2);
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0].hash).toBe("aaa111");
    expect(result.commits[0].author).toBe("alice");
    expect(result.commits[0].files).toHaveLength(2);
    expect(result.commits[1].hash).toBe("bbb222");
    expect(result.commits[1].files).toHaveLength(1);
  });

  it("detects fix chains from parsed log", async () => {
    const log = buildGitLog([
      {
        hash: "fix1",
        date: "2025-06-15",
        author: "alice",
        message: "fix typo in auth",
        files: [{ added: 1, deleted: 1, path: "src/auth.ts" }],
      },
      {
        hash: "feat1",
        date: "2025-06-15",
        author: "alice",
        message: "add user auth",
        files: [{ added: 50, deleted: 0, path: "src/auth.ts" }],
      },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    expect(result.fixChains).toHaveLength(1);
    expect(result.fixChains[0].fixCommit.hash).toBe("fix1");
    expect(result.fixChains[0].featureCommit.hash).toBe("feat1");
  });

  it("computes authors list (deduplicated)", async () => {
    const log = buildGitLog([
      { hash: "a1", date: "2025-06-15", author: "alice", message: "one",
        files: [{ added: 1, deleted: 0, path: "x.ts" }] },
      { hash: "a2", date: "2025-06-14", author: "bob", message: "two",
        files: [{ added: 1, deleted: 0, path: "x.ts" }] },
      { hash: "a3", date: "2025-06-13", author: "alice", message: "three",
        files: [{ added: 1, deleted: 0, path: "x.ts" }] },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    expect(result.authors).toHaveLength(2);
    expect(result.authors).toContain("alice");
    expect(result.authors).toContain("bob");
  });

  it("computes dateRange (earliest and latest)", async () => {
    const log = buildGitLog([
      { hash: "a1", date: "2025-06-20", author: "alice", message: "latest",
        files: [{ added: 1, deleted: 0, path: "x.ts" }] },
      { hash: "a2", date: "2025-06-10", author: "alice", message: "middle",
        files: [{ added: 1, deleted: 0, path: "x.ts" }] },
      { hash: "a3", date: "2025-06-01", author: "alice", message: "earliest",
        files: [{ added: 1, deleted: 0, path: "x.ts" }] },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    // Commits are newest-first; earliest = last, latest = first
    expect(result.dateRange).not.toBeNull();
    expect(result.dateRange!.latest).toBe("2025-06-20");
    expect(result.dateRange!.earliest).toBe("2025-06-01");
  });

  it("builds hotspots sorted by commit count", async () => {
    const log = buildGitLog([
      { hash: "a1", date: "2025-06-15", author: "alice", message: "one",
        files: [
          { added: 1, deleted: 0, path: "src/hot.ts" },
          { added: 1, deleted: 0, path: "src/cold.ts" },
        ] },
      { hash: "a2", date: "2025-06-14", author: "alice", message: "two",
        files: [{ added: 1, deleted: 0, path: "src/hot.ts" }] },
      { hash: "a3", date: "2025-06-13", author: "alice", message: "three",
        files: [{ added: 1, deleted: 0, path: "src/hot.ts" }] },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    expect(result.hotspots.length).toBeGreaterThanOrEqual(2);
    expect(result.hotspots[0].path).toBe("src/hot.ts");
    expect(result.hotspots[0].commitCount).toBe(3);
    expect(result.hotspots[1].path).toBe("src/cold.ts");
    expect(result.hotspots[1].commitCount).toBe(1);
  });

  it("computes cleanCommitRate correctly", async () => {
    // 3 commits total, 1 is a fix in a fix chain => 2/3 clean
    const log = buildGitLog([
      { hash: "fix1", date: "2025-06-15", author: "alice", message: "fix crash",
        files: [{ added: 1, deleted: 1, path: "src/app.ts" }] },
      { hash: "feat1", date: "2025-06-15", author: "alice", message: "add feature",
        files: [{ added: 50, deleted: 0, path: "src/app.ts" }] },
      { hash: "unrelated", date: "2025-06-14", author: "bob", message: "docs update",
        files: [{ added: 5, deleted: 0, path: "README.md" }] },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    // fix1 is the fix side of the chain => 2 clean / 3 total
    expect(result.cleanCommitRate).toBeCloseTo(2 / 3, 4);
  });

  it("passes limit parameter to git log", async () => {
    let capturedArgs: string[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      capturedArgs = args;
      return { stdout: "", stderr: "", code: 0, killed: false };
    };

    await analyzeGitHistory(exec, 50);
    expect(capturedArgs).toContain("50");
    expect(capturedArgs).toContain("-n");
  });

  it("handles commit messages containing pipe characters", async () => {
    const log = [
      "COMMIT|abc123|2025-06-15|alice|feat: add A | B | C support",
      "",
      "5\t0\tsrc/app.ts",
    ].join("\n");

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    expect(result.totalCommits).toBe(1);
    expect(result.commits[0].message).toBe("feat: add A | B | C support");
  });

  it("cleanCommitRate is 1.0 when there are no fix chains", async () => {
    const log = buildGitLog([
      { hash: "a1", date: "2025-06-15", author: "alice", message: "add feature",
        files: [{ added: 10, deleted: 0, path: "src/a.ts" }] },
      { hash: "a2", date: "2025-06-14", author: "bob", message: "refactor code",
        files: [{ added: 5, deleted: 5, path: "src/b.ts" }] },
    ]);

    const exec = makeExec(log);
    const result = await analyzeGitHistory(exec);

    expect(result.fixChains).toEqual([]);
    expect(result.cleanCommitRate).toBe(1.0);
  });
});
