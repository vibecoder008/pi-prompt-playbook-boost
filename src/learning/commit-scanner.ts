import type { CommitInfo, CommitScanResult, DetectedFixPattern, ExecFn, FixChain } from "../types";

const FIX_PATTERN = /\b(fix|patch|oops|typo|forgot|broken|revert|hotfix|fixup|squash)\b/i;

const COMMIT_DELIMITER = "COMMIT|";
const GIT_LOG_FORMAT = "COMMIT|%H|%ad|%an|%s";
const FIX_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Parse raw git log output (COMMIT| prefix + --numstat) into CommitInfo[].
 *
 * Expected format from:
 *   git log --numstat --date=short --pretty=format:'COMMIT|%H|%ad|%an|%s' --no-renames
 */
export function parseGitLog(rawLog: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const lines = rawLog.split("\n");
  let current: CommitInfo | null = null;

  for (const line of lines) {
    if (line.startsWith(COMMIT_DELIMITER)) {
      if (current) commits.push(current);
      const parts = line.slice(COMMIT_DELIMITER.length).split("|");
      current = {
        hash: parts[0] ?? "",
        date: parts[1] ?? "",
        author: parts[2] ?? "",
        message: parts.slice(3).join("|"),
        files: [],
      };
    } else if (current && line.includes("\t")) {
      const segments = line.split("\t");
      if (segments.length >= 3) {
        const added = segments[0] === "-" ? 0 : parseInt(segments[0], 10);
        const deleted = segments[1] === "-" ? 0 : parseInt(segments[1], 10);
        const path = segments.slice(2).join("\t").trim();
        if (path) {
          current.files.push({
            added: isNaN(added) ? 0 : added,
            deleted: isNaN(deleted) ? 0 : deleted,
            path,
          });
        }
      }
    }
  }
  if (current) commits.push(current);

  return commits;
}

/**
 * Find fix-after-feature chains in a set of commits.
 *
 * A fix chain is a pair of commits by the same author where:
 * 1. They are within 24 hours of each other.
 * 2. They share at least one modified file.
 * 3. The later commit's message matches {@link FIX_PATTERN}.
 *
 * Commits are grouped by author and sorted chronologically. Each fix commit
 * is matched to the nearest prior feature commit with shared files.
 */
export function findFixChains(commits: CommitInfo[]): FixChain[] {
  const chains: FixChain[] = [];

  const byAuthor = new Map<string, CommitInfo[]>();
  for (const commit of commits) {
    const list = byAuthor.get(commit.author) ?? [];
    list.push(commit);
    byAuthor.set(commit.author, list);
  }

  for (const authorCommits of byAuthor.values()) {
    // Sort ascending by date so index 0 is oldest
    const sorted = [...authorCommits].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    for (let i = 1; i < sorted.length; i++) {
      const later = sorted[i];
      if (!FIX_PATTERN.test(later.message)) continue;

      const laterTime = new Date(later.date).getTime();

      for (let j = i - 1; j >= 0; j--) {
        const earlier = sorted[j];
        const earlierTime = new Date(earlier.date).getTime();
        const timeDelta = laterTime - earlierTime;

        if (timeDelta > FIX_WINDOW_MS) break;
        if (FIX_PATTERN.test(earlier.message)) continue;

        const earlierFiles = new Set(earlier.files.map((f) => f.path));
        const sharedFiles = later.files.map((f) => f.path).filter((p) => earlierFiles.has(p));

        if (sharedFiles.length > 0) {
          chains.push({
            featureCommit: earlier,
            fixCommit: later,
            sharedFiles,
            hoursBetween: timeDelta / (1000 * 60 * 60),
          });
          break; // one match per fix commit
        }
      }
    }
  }

  return chains;
}

/**
 * Scan for new commits since {@link lastHash}, parse them, and detect fix
 * chains among the new commits.
 *
 * Returns the parsed commits, any detected chains, and the current HEAD hash.
 */
export async function scanNewCommits(exec: ExecFn, lastHash: string): Promise<CommitScanResult> {
  const range = lastHash ? `${lastHash}..HEAD` : "HEAD~50..HEAD";
  const result = await exec("git", [
    "log",
    range,
    "--numstat",
    "--date=short",
    `--pretty=format:${GIT_LOG_FORMAT}`,
    "--no-renames",
  ]);

  if (result.code !== 0 || !result.stdout.trim()) {
    return { newCommits: [], newFixChains: [], newHash: lastHash };
  }

  const newCommits = parseGitLog(result.stdout);
  const newFixChains = findFixChains(newCommits);

  const headResult = await exec("git", ["rev-parse", "HEAD"]);
  const newHash = headResult.code === 0 ? headResult.stdout.trim() : lastHash;

  return { newCommits, newFixChains, newHash };
}

/**
 * Look for commits made during or after the current session that are fixes
 * for AI-generated code.
 *
 * Git log outputs newest-first, so index 0 is HEAD.  For each fix commit
 * we walk older (higher indices) looking for the feature commit it corrects.
 */
export async function detectFixCommitsSinceSession(
  exec: ExecFn,
  sessionStartHash: string,
): Promise<DetectedFixPattern[]> {
  if (!sessionStartHash) return [];

  const result = await exec("git", [
    "log",
    `${sessionStartHash}..HEAD`,
    "--numstat",
    "--date=short",
    `--pretty=format:${GIT_LOG_FORMAT}`,
    "--no-renames",
  ]);

  if (result.code !== 0 || !result.stdout.trim()) return [];

  const commits = parseGitLog(result.stdout);
  const patterns: DetectedFixPattern[] = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    if (!FIX_PATTERN.test(commit.message)) continue;

    let likelyFixFor = "";
    for (let j = i + 1; j < commits.length; j++) {
      const older = commits[j];
      if (FIX_PATTERN.test(older.message)) continue;

      const olderFiles = new Set(older.files.map((f) => f.path));
      if (commit.files.some((f) => olderFiles.has(f.path))) {
        likelyFixFor = older.hash;
        break;
      }
    }

    patterns.push({
      fixCommit: commit,
      affectedFiles: commit.files.map((f) => f.path),
      likelyFixFor,
    });
  }

  return patterns;
}
