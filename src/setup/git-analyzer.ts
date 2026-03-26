import type {
  CommitInfo,
  CouplingRule,
  ExecFn,
  FileChange,
  FixChain,
  GitAnalysis,
} from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIX_PATTERN =
  /\b(fix|patch|oops|typo|forgot|broken|revert|hotfix|fixup)\b/i;

/** 24 hours in milliseconds. */
const FIX_WINDOW_MS = 24 * 60 * 60 * 1000;

const COMMIT_DELIMITER = "COMMIT|";

const GIT_LOG_FORMAT = "COMMIT|%H|%ad|%an|%s";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `git log` and parse the output into a structured {@link GitAnalysis}.
 *
 * @param exec  Wrapper around `pi.exec`.
 * @param limit Maximum number of commits to fetch (default 200 for the
 *              progressive-scan instant phase).
 */
export async function analyzeGitHistory(
  exec: ExecFn,
  limit: number = 200
): Promise<GitAnalysis> {
  const commits = await fetchCommits(exec, limit);

  if (commits.length === 0) {
    return emptyAnalysis();
  }

  const fixChains = findFixChains(commits);
  const couplingRules = findCoupling(commits);
  const hotspots = buildHotspots(commits, fixChains);
  const cleanCommitRate = computeCleanRate(commits, fixChains);
  const authors = [...new Set(commits.map((c) => c.author))];

  const dates = commits.map((c) => c.date).filter(Boolean);
  const dateRange =
    dates.length > 0
      ? { earliest: dates[dates.length - 1], latest: dates[0] }
      : null;

  return {
    commits,
    totalCommits: commits.length,
    fixChains,
    couplingRules,
    hotspots,
    cleanCommitRate,
    authors,
    dateRange,
  };
}

/**
 * Detect fix-after-feature chains.
 *
 * A fix chain is a pair of commits by the *same author* where:
 * 1. They are within 24 hours of each other.
 * 2. They share at least one file.
 * 3. The later commit's message matches {@link FIX_PATTERN}.
 *
 * Commits come newest-first from git log.  For each commit that looks like a
 * "fix", we search forward (older) for the nearest same-author commit that
 * shares files and is within the time window.
 */
export function findFixChains(commits: CommitInfo[]): FixChain[] {
  const chains: FixChain[] = [];

  for (let i = 0; i < commits.length - 1; i++) {
    const newer = commits[i];
    if (!FIX_PATTERN.test(newer.message)) continue;

    // Walk forward (older) to find the nearest same-author commit.
    for (let j = i + 1; j < commits.length; j++) {
      const older = commits[j];
      if (older.author !== newer.author) continue;

      const hoursBetween = dateDiffHours(older.date, newer.date);
      if (hoursBetween > 24) break; // too far apart

      const olderPaths = new Set(older.files.map((f) => f.path));
      const sharedFiles = newer.files
        .map((f) => f.path)
        .filter((p) => olderPaths.has(p));

      if (sharedFiles.length > 0) {
        chains.push({
          featureCommit: older,
          fixCommit: newer,
          sharedFiles,
          hoursBetween,
        });
      }
      break; // only check the nearest same-author commit
    }
  }

  return chains;
}

/**
 * Build a file co-occurrence matrix from commit history and return coupling
 * rules where the coupling rate exceeds 30 % **and** there are more than 5
 * co-occurrences.
 *
 * Results are sorted by coupling rate descending.
 */
export function findCoupling(commits: CommitInfo[]): CouplingRule[] {
  const pairCount = new Map<string, number>();
  const fileCommitCount = new Map<string, number>();

  for (const commit of commits) {
    const paths = [...new Set(commit.files.map((f) => f.path))];

    for (const p of paths) {
      fileCommitCount.set(p, (fileCommitCount.get(p) ?? 0) + 1);
    }

    // For every unique pair, increment co-occurrence counter.
    for (let a = 0; a < paths.length; a++) {
      for (let b = a + 1; b < paths.length; b++) {
        const key = pairKey(paths[a], paths[b]);
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  const rules: CouplingRule[] = [];

  for (const [key, count] of pairCount) {
    if (count <= 5) continue;

    const [fileA, fileB] = key.split("\0");
    const totalA = fileCommitCount.get(fileA) ?? 0;
    const totalB = fileCommitCount.get(fileB) ?? 0;
    const maxTotal = Math.max(totalA, totalB);
    if (maxTotal === 0) continue;

    const couplingRate = count / maxTotal;
    if (couplingRate <= 0.3) continue;

    rules.push({
      fileA,
      fileB,
      coOccurrences: count,
      couplingRate,
      totalCommitsA: totalA,
      totalCommitsB: totalB,
    });
  }

  rules.sort((a, b) => b.couplingRate - a.couplingRate);
  return rules;
}

/**
 * Return the current HEAD commit hash, or `null` if the working directory is
 * not inside a git repository.
 */
export async function getLastCommitHash(exec: ExecFn): Promise<string | null> {
  try {
    const result = await exec("git", ["rev-parse", "HEAD"]);
    if (result.code !== 0) return null;
    const hash = result.stdout.trim();
    return hash.length > 0 ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Fetch commits added after {@link sinceHash} (exclusive) up to HEAD.
 * Used for incremental scanning (`/boost refresh`).
 */
export async function getCommitsSince(
  exec: ExecFn,
  sinceHash: string,
  limit: number = 500
): Promise<CommitInfo[]> {
  const result = await exec("git", [
    "log",
    "--numstat",
    "--date=short",
    `--pretty=format:${GIT_LOG_FORMAT}`,
    "--no-renames",
    "-n",
    String(limit),
    `${sinceHash}..HEAD`,
  ]);

  if (result.code !== 0) return [];
  return parseGitLog(result.stdout);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchCommits(
  exec: ExecFn,
  limit: number
): Promise<CommitInfo[]> {
  const args = [
    "log",
    "--numstat",
    "--date=short",
    `--pretty=format:${GIT_LOG_FORMAT}`,
    "--no-renames",
  ];

  // limit <= 0 means "all commits"
  if (limit > 0) {
    args.push("-n", String(limit));
  }

  const result = await exec("git", args);

  if (result.code !== 0) return [];
  return parseGitLog(result.stdout);
}

/**
 * Parse the combined `--pretty=format:COMMIT|%H|%ad|%an|%s` + `--numstat`
 * output into an array of {@link CommitInfo}.
 *
 * The format looks like:
 * ```
 * COMMIT|<hash>|<date>|<author>|<subject>
 *
 * 3\t1\tpath/to/file.ts
 * 10\t0\tpath/to/other.ts
 *
 * COMMIT|<hash>|...
 * ```
 */
function parseGitLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const lines = raw.split("\n");

  let current: CommitInfo | null = null;

  for (const line of lines) {
    if (line.startsWith(COMMIT_DELIMITER)) {
      // Flush previous commit.
      if (current) commits.push(current);

      const parts = line.slice(COMMIT_DELIMITER.length).split("|");
      // parts: [hash, date, author, ...messageParts]
      const hash = parts[0] ?? "";
      const date = parts[1] ?? "";
      const author = parts[2] ?? "";
      const message = parts.slice(3).join("|"); // message may contain pipes

      current = { hash, date, author, message, files: [] };
      continue;
    }

    // numstat line: "added\tdeleted\tpath"
    if (current && line.includes("\t")) {
      const file = parseNumstatLine(line);
      if (file) current.files.push(file);
    }
  }

  // Don't forget the last commit.
  if (current) commits.push(current);

  return commits;
}

function parseNumstatLine(line: string): FileChange | null {
  const parts = line.split("\t");
  if (parts.length < 3) return null;

  const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
  const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
  const path = parts.slice(2).join("\t").trim();
  if (!path) return null;

  return {
    added: isNaN(added) ? 0 : added,
    deleted: isNaN(deleted) ? 0 : deleted,
    path,
  };
}

/**
 * Build hotspot list: files sorted by commit frequency, annotated with how
 * many of those commits were part of a fix chain.
 */
function buildHotspots(
  commits: CommitInfo[],
  fixChains: FixChain[]
): GitAnalysis["hotspots"] {
  const commitCounts = new Map<string, number>();
  const fixCounts = new Map<string, number>();

  for (const commit of commits) {
    for (const f of commit.files) {
      commitCounts.set(f.path, (commitCounts.get(f.path) ?? 0) + 1);
    }
  }

  const fixCommitHashes = new Set(fixChains.map((fc) => fc.fixCommit.hash));
  for (const commit of commits) {
    if (!fixCommitHashes.has(commit.hash)) continue;
    for (const f of commit.files) {
      fixCounts.set(f.path, (fixCounts.get(f.path) ?? 0) + 1);
    }
  }

  return [...commitCounts.entries()]
    .map(([path, commitCount]) => ({
      path,
      commitCount,
      fixCount: fixCounts.get(path) ?? 0,
    }))
    .sort((a, b) => b.commitCount - a.commitCount);
}

/**
 * Ratio of commits that are NOT the "fix" side of a fix chain.
 */
function computeCleanRate(
  commits: CommitInfo[],
  fixChains: FixChain[]
): number {
  if (commits.length === 0) return 1;
  const fixHashes = new Set(fixChains.map((fc) => fc.fixCommit.hash));
  const cleanCount = commits.filter((c) => !fixHashes.has(c.hash)).length;
  return cleanCount / commits.length;
}

function emptyAnalysis(): GitAnalysis {
  return {
    commits: [],
    totalCommits: 0,
    fixChains: [],
    couplingRules: [],
    hotspots: [],
    cleanCommitRate: 1,
    authors: [],
    dateRange: null,
  };
}

/**
 * Deterministic pair key (alphabetical order, null-byte separator).
 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/**
 * Approximate date diff in hours from two `YYYY-MM-DD` strings.
 * Returns absolute value.
 */
function dateDiffHours(dateA: string, dateB: string): number {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.abs(b - a) / (1000 * 60 * 60);
}
