import { describe, it, expect, vi } from "vitest";
import {
  parseGitLog,
  findFixChains,
  scanNewCommits,
  detectFixCommitsSinceSession,
} from "../src/learning/commit-scanner";
import type { CommitInfo, ExecFn, ExecResult } from "../src/types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { stdout: "", stderr: "", code: 0, killed: false, ...overrides };
}

function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    hash: "abc1234567890abcdef1234567890abcdef123456",
    date: "2026-03-20",
    author: "Alice",
    message: "add feature",
    files: [],
    ...overrides,
  };
}

// ─── parseGitLog ─────────────────────────────────────────────────

describe("parseGitLog", () => {
  it("parses a single commit with numstat", () => {
    const raw = [
      "COMMIT|aaa111|2026-03-20|Alice|add login page",
      "12\t3\tsrc/login.ts",
      "5\t0\tsrc/login.test.ts",
    ].join("\n");

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    expect(commits[0].hash).toBe("aaa111");
    expect(commits[0].date).toBe("2026-03-20");
    expect(commits[0].author).toBe("Alice");
    expect(commits[0].message).toBe("add login page");
    expect(commits[0].files).toHaveLength(2);
    expect(commits[0].files[0]).toEqual({ added: 12, deleted: 3, path: "src/login.ts" });
    expect(commits[0].files[1]).toEqual({ added: 5, deleted: 0, path: "src/login.test.ts" });
  });

  it("parses multiple commits", () => {
    const raw = [
      "COMMIT|aaa111|2026-03-20|Alice|first commit",
      "10\t2\tfile1.ts",
      "",
      "COMMIT|bbb222|2026-03-21|Bob|second commit",
      "3\t1\tfile2.ts",
    ].join("\n");

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(2);
    expect(commits[0].hash).toBe("aaa111");
    expect(commits[0].author).toBe("Alice");
    expect(commits[1].hash).toBe("bbb222");
    expect(commits[1].author).toBe("Bob");
  });

  it("returns empty array for empty log", () => {
    expect(parseGitLog("")).toEqual([]);
  });

  it("returns empty array for whitespace-only log", () => {
    expect(parseGitLog("  \n  \n  ")).toEqual([]);
  });

  it("handles binary files (dash in numstat)", () => {
    const raw = [
      "COMMIT|aaa111|2026-03-20|Alice|add image",
      "-\t-\tassets/logo.png",
      "5\t0\tsrc/app.ts",
    ].join("\n");

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    expect(commits[0].files).toHaveLength(2);
    expect(commits[0].files[0]).toEqual({ added: 0, deleted: 0, path: "assets/logo.png" });
    expect(commits[0].files[1]).toEqual({ added: 5, deleted: 0, path: "src/app.ts" });
  });

  it("handles pipes in commit messages", () => {
    const raw = "COMMIT|aaa111|2026-03-20|Alice|fix: a | b | c\n";

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("fix: a | b | c");
  });

  it("handles commit with no files", () => {
    const raw = "COMMIT|aaa111|2026-03-20|Alice|empty commit\n";

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    expect(commits[0].files).toEqual([]);
  });

  it("skips lines that are not commits or numstat", () => {
    const raw = [
      "COMMIT|aaa111|2026-03-20|Alice|commit one",
      "some random line without tabs",
      "10\t5\tsrc/valid.ts",
    ].join("\n");

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    expect(commits[0].files).toHaveLength(1);
    expect(commits[0].files[0].path).toBe("src/valid.ts");
  });

  it("handles tabs in file paths (renames with arrows)", () => {
    const raw = [
      "COMMIT|aaa111|2026-03-20|Alice|rename file",
      "0\t0\told/path.ts\tnew/path.ts",
    ].join("\n");

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    // segments.slice(2).join("\t") rejoins the tab-separated path parts
    expect(commits[0].files[0].path).toBe("old/path.ts\tnew/path.ts");
  });

  it("handles missing fields gracefully with partial COMMIT line", () => {
    const raw = "COMMIT|aaa111\n";

    const commits = parseGitLog(raw);

    expect(commits).toHaveLength(1);
    expect(commits[0].hash).toBe("aaa111");
    expect(commits[0].date).toBe("");
    expect(commits[0].author).toBe("");
    expect(commits[0].message).toBe("");
  });
});

// ─── findFixChains ───────────────────────────────────────────────

describe("findFixChains", () => {
  it("detects a fix chain when fix commit follows feature on same file within 24h", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "feature1",
        date: "2026-03-20",
        author: "Alice",
        message: "add dashboard",
        files: [{ added: 50, deleted: 0, path: "src/dashboard.ts" }],
      }),
      makeCommit({
        hash: "fix1",
        date: "2026-03-20",
        author: "Alice",
        message: "fix dashboard crash",
        files: [{ added: 2, deleted: 1, path: "src/dashboard.ts" }],
      }),
    ];

    const chains = findFixChains(commits);

    expect(chains).toHaveLength(1);
    expect(chains[0].featureCommit.hash).toBe("feature1");
    expect(chains[0].fixCommit.hash).toBe("fix1");
    expect(chains[0].sharedFiles).toEqual(["src/dashboard.ts"]);
    expect(chains[0].hoursBetween).toBe(0);
  });

  it("returns empty array when no commits match fix pattern", () => {
    const commits: CommitInfo[] = [
      makeCommit({ message: "add feature A", files: [{ added: 10, deleted: 0, path: "a.ts" }] }),
      makeCommit({ message: "add feature B", files: [{ added: 10, deleted: 0, path: "a.ts" }] }),
    ];

    expect(findFixChains(commits)).toEqual([]);
  });

  it("returns empty array for empty commits", () => {
    expect(findFixChains([])).toEqual([]);
  });

  it("does not pair commits from different authors", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        author: "Alice",
        date: "2026-03-20",
        message: "add feature",
        files: [{ added: 10, deleted: 0, path: "shared.ts" }],
      }),
      makeCommit({
        author: "Bob",
        date: "2026-03-20",
        message: "fix shared issue",
        files: [{ added: 2, deleted: 1, path: "shared.ts" }],
      }),
    ];

    expect(findFixChains(commits)).toEqual([]);
  });

  it("does not pair commits that are more than 24 hours apart", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "feature1",
        date: "2026-03-18",
        author: "Alice",
        message: "add feature",
        files: [{ added: 10, deleted: 0, path: "f.ts" }],
      }),
      makeCommit({
        hash: "fix1",
        date: "2026-03-21",
        author: "Alice",
        message: "fix typo",
        files: [{ added: 1, deleted: 1, path: "f.ts" }],
      }),
    ];

    expect(findFixChains(commits)).toEqual([]);
  });

  it("does not pair commits with no shared files", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        date: "2026-03-20",
        author: "Alice",
        message: "add feature",
        files: [{ added: 10, deleted: 0, path: "a.ts" }],
      }),
      makeCommit({
        date: "2026-03-20",
        author: "Alice",
        message: "fix something",
        files: [{ added: 1, deleted: 1, path: "b.ts" }],
      }),
    ];

    expect(findFixChains(commits)).toEqual([]);
  });

  it("sorts by date ascending within author groups", () => {
    // Feed commits in reverse chronological order; findFixChains should still work
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "fix1",
        date: "2026-03-21",
        author: "Alice",
        message: "hotfix for crash",
        files: [{ added: 2, deleted: 1, path: "app.ts" }],
      }),
      makeCommit({
        hash: "feature1",
        date: "2026-03-20",
        author: "Alice",
        message: "add app logic",
        files: [{ added: 50, deleted: 0, path: "app.ts" }],
      }),
    ];

    const chains = findFixChains(commits);

    expect(chains).toHaveLength(1);
    expect(chains[0].featureCommit.hash).toBe("feature1");
    expect(chains[0].fixCommit.hash).toBe("fix1");
  });

  it("matches each fix commit to only one earlier feature commit", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "feat1",
        date: "2026-03-20",
        author: "Alice",
        message: "first feature",
        files: [{ added: 10, deleted: 0, path: "shared.ts" }],
      }),
      makeCommit({
        hash: "feat2",
        date: "2026-03-20",
        author: "Alice",
        message: "second feature",
        files: [{ added: 10, deleted: 0, path: "shared.ts" }],
      }),
      makeCommit({
        hash: "fix1",
        date: "2026-03-20",
        author: "Alice",
        message: "fix shared.ts bug",
        files: [{ added: 1, deleted: 1, path: "shared.ts" }],
      }),
    ];

    const chains = findFixChains(commits);

    expect(chains).toHaveLength(1);
    // Should match nearest prior non-fix commit (feat2, since sorted ascending feat2 is at index 1, fix is at 2)
    expect(chains[0].featureCommit.hash).toBe("feat2");
  });

  it("skips earlier fix-pattern commits when searching for feature commit", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "feat1",
        date: "2026-03-20",
        author: "Alice",
        message: "add module",
        files: [{ added: 20, deleted: 0, path: "mod.ts" }],
      }),
      makeCommit({
        hash: "fix1",
        date: "2026-03-20",
        author: "Alice",
        message: "fix typo",
        files: [{ added: 1, deleted: 1, path: "mod.ts" }],
      }),
      makeCommit({
        hash: "fix2",
        date: "2026-03-20",
        author: "Alice",
        message: "oops missed semicolon",
        files: [{ added: 1, deleted: 0, path: "mod.ts" }],
      }),
    ];

    const chains = findFixChains(commits);

    // fix1 matches feat1; fix2 skips fix1 (fix pattern) and also matches feat1
    expect(chains).toHaveLength(2);
    expect(chains[0].fixCommit.hash).toBe("fix1");
    expect(chains[0].featureCommit.hash).toBe("feat1");
    expect(chains[1].fixCommit.hash).toBe("fix2");
    expect(chains[1].featureCommit.hash).toBe("feat1");
  });

  it("recognises various fix patterns: patch, oops, typo, forgot, revert, hotfix, fixup", () => {
    const patterns = ["patch it", "oops wrong", "typo in code", "forgot export", "revert change", "hotfix crash", "fixup linting"];

    for (const msg of patterns) {
      const commits: CommitInfo[] = [
        makeCommit({
          hash: "feat",
          date: "2026-03-20",
          author: "Alice",
          message: "add stuff",
          files: [{ added: 10, deleted: 0, path: "x.ts" }],
        }),
        makeCommit({
          hash: "fixcommit",
          date: "2026-03-20",
          author: "Alice",
          message: msg,
          files: [{ added: 1, deleted: 1, path: "x.ts" }],
        }),
      ];

      const chains = findFixChains(commits);
      expect(chains).toHaveLength(1);
    }
  });

  it("calculates hoursBetween correctly", () => {
    const commits: CommitInfo[] = [
      makeCommit({
        hash: "feat",
        date: "2026-03-20",
        author: "Alice",
        message: "add feature",
        files: [{ added: 10, deleted: 0, path: "f.ts" }],
      }),
      makeCommit({
        hash: "fixhash",
        date: "2026-03-21",
        author: "Alice",
        message: "fix bug",
        files: [{ added: 1, deleted: 1, path: "f.ts" }],
      }),
    ];

    const chains = findFixChains(commits);

    expect(chains).toHaveLength(1);
    expect(chains[0].hoursBetween).toBe(24);
  });
});

// ─── scanNewCommits ──────────────────────────────────────────────

describe("scanNewCommits", () => {
  it("uses lastHash..HEAD range when lastHash is provided", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ stdout: "", code: 0 }));

    await scanNewCommits(exec, "abc123");

    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["abc123..HEAD"]),
    );
  });

  it("uses HEAD~50..HEAD range when lastHash is empty", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ stdout: "", code: 0 }));

    await scanNewCommits(exec, "");

    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["HEAD~50..HEAD"]),
    );
  });

  it("returns empty result when git log returns non-zero exit code", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 1, stdout: "" }));

    const result = await scanNewCommits(exec, "abc123");

    expect(result.newCommits).toEqual([]);
    expect(result.newFixChains).toEqual([]);
    expect(result.newHash).toBe("abc123");
  });

  it("returns empty result when git log stdout is empty", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: "  " }));

    const result = await scanNewCommits(exec, "abc123");

    expect(result.newCommits).toEqual([]);
    expect(result.newFixChains).toEqual([]);
    expect(result.newHash).toBe("abc123");
  });

  it("parses commits and updates hash on success", async () => {
    const logOutput = [
      "COMMIT|new111|2026-03-20|Alice|add feature",
      "10\t0\tapp.ts",
    ].join("\n");

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: "newhead123\n" }));

    const result = await scanNewCommits(exec, "oldhash");

    expect(result.newCommits).toHaveLength(1);
    expect(result.newCommits[0].hash).toBe("new111");
    expect(result.newHash).toBe("newhead123");
  });

  it("falls back to lastHash when rev-parse HEAD fails", async () => {
    const logOutput = "COMMIT|new111|2026-03-20|Alice|add feature\n";

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));
    exec.mockResolvedValueOnce(makeExecResult({ code: 128, stdout: "" }));

    const result = await scanNewCommits(exec, "oldhash");

    expect(result.newHash).toBe("oldhash");
  });

  it("detects fix chains among new commits", async () => {
    const logOutput = [
      "COMMIT|feat1|2026-03-20|Alice|add login",
      "10\t0\tlogin.ts",
      "",
      "COMMIT|fix1|2026-03-20|Alice|fix login crash",
      "2\t1\tlogin.ts",
    ].join("\n");

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: "headhash\n" }));

    const result = await scanNewCommits(exec, "oldhash");

    expect(result.newFixChains).toHaveLength(1);
    expect(result.newFixChains[0].sharedFiles).toEqual(["login.ts"]);
  });
});

// ─── detectFixCommitsSinceSession ────────────────────────────────

describe("detectFixCommitsSinceSession", () => {
  it("returns empty array when sessionStartHash is empty", async () => {
    const exec = vi.fn<ExecFn>();

    const result = await detectFixCommitsSinceSession(exec, "");

    expect(result).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns empty array when git log fails", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 128, stdout: "" }));

    const result = await detectFixCommitsSinceSession(exec, "starthash");

    expect(result).toEqual([]);
  });

  it("returns empty array when git log is empty", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: "" }));

    const result = await detectFixCommitsSinceSession(exec, "starthash");

    expect(result).toEqual([]);
  });

  it("detects fix commits and links to likely feature commit", async () => {
    // git log outputs newest-first, so fix commit is at index 0
    const logOutput = [
      "COMMIT|fixhash|2026-03-21|Alice|fix the bug",
      "2\t1\tmodule.ts",
      "",
      "COMMIT|feathash|2026-03-20|Alice|add module",
      "30\t0\tmodule.ts",
    ].join("\n");

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));

    const result = await detectFixCommitsSinceSession(exec, "starthash");

    expect(result).toHaveLength(1);
    expect(result[0].fixCommit.hash).toBe("fixhash");
    expect(result[0].affectedFiles).toEqual(["module.ts"]);
    expect(result[0].likelyFixFor).toBe("feathash");
  });

  it("returns empty likelyFixFor when no matching feature commit exists", async () => {
    const logOutput = [
      "COMMIT|fixhash|2026-03-21|Alice|fix orphan bug",
      "2\t1\torphan.ts",
      "",
      "COMMIT|feathash|2026-03-20|Alice|add something else",
      "30\t0\tother.ts",
    ].join("\n");

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));

    const result = await detectFixCommitsSinceSession(exec, "starthash");

    expect(result).toHaveLength(1);
    expect(result[0].likelyFixFor).toBe("");
  });

  it("uses correct git log range with sessionStartHash", async () => {
    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: "" }));

    await detectFixCommitsSinceSession(exec, "abc123def");

    expect(exec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["abc123def..HEAD"]),
    );
  });

  it("skips non-fix commits in the output", async () => {
    const logOutput = [
      "COMMIT|nonfixhash|2026-03-21|Alice|add more features",
      "10\t0\tfeature.ts",
      "",
      "COMMIT|feathash|2026-03-20|Alice|initial feature",
      "30\t0\tfeature.ts",
    ].join("\n");

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));

    const result = await detectFixCommitsSinceSession(exec, "starthash");

    expect(result).toEqual([]);
  });

  it("skips earlier fix-pattern commits when searching for feature commit", async () => {
    const logOutput = [
      "COMMIT|fix2|2026-03-22|Alice|fix again",
      "1\t1\tmod.ts",
      "",
      "COMMIT|fix1|2026-03-21|Alice|oops typo",
      "1\t1\tmod.ts",
      "",
      "COMMIT|feat1|2026-03-20|Alice|add mod",
      "20\t0\tmod.ts",
    ].join("\n");

    const exec = vi.fn<ExecFn>();
    exec.mockResolvedValueOnce(makeExecResult({ code: 0, stdout: logOutput }));

    const result = await detectFixCommitsSinceSession(exec, "starthash");

    expect(result).toHaveLength(2);
    // fix2 skips fix1 (fix pattern) and links to feat1
    expect(result[0].fixCommit.hash).toBe("fix2");
    expect(result[0].likelyFixFor).toBe("feat1");
    // fix1 links to feat1
    expect(result[1].fixCommit.hash).toBe("fix1");
    expect(result[1].likelyFixFor).toBe("feat1");
  });
});
