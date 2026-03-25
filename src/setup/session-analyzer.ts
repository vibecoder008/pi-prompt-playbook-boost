import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptPattern, SessionAnalysis, SessionMessage } from "../types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse past pi sessions stored as JSONL files under {@link sessionsDir}
 * (typically `.pi/sessions/` inside the project).
 *
 * Returns an empty analysis when the directory does not exist or contains no
 * parseable sessions.
 */
export async function analyzeSessionHistory(
  sessionsDir: string
): Promise<SessionAnalysis> {
  const files = await listJsonlFiles(sessionsDir);

  if (files.length === 0) {
    return emptyAnalysis();
  }

  let totalMessages = 0;
  let totalTurns = 0;
  let toolErrorCount = 0;
  const allUserMessages: SessionMessage[] = [];

  for (const file of files) {
    const entries = await readJsonl(file);

    for (const entry of entries) {
      totalMessages++;

      // Count turns from turn_end entries.
      if (entry._type === "turn_end" || entry.type === "turn_end") {
        totalTurns++;
      }

      // Track tool errors.
      if (
        (entry._type === "tool_result" || entry.type === "tool_result") &&
        entry.isError
      ) {
        toolErrorCount++;
      }

      // Collect user messages from session message entries.
      const msg = extractUserMessage(entry);
      if (msg) {
        allUserMessages.push(msg);
      }
    }
  }

  const retryCount = detectRetries(allUserMessages);
  const promptPatterns = extractPromptPatterns(allUserMessages);
  const avgTurnsPerSession =
    files.length > 0 ? totalTurns / files.length : 0;

  return {
    totalSessions: files.length,
    totalMessages,
    totalUserMessages: allUserMessages.length,
    retryCount,
    promptPatterns,
    avgTurnsPerSession,
    toolErrorCount,
  };
}

/**
 * Count retries by comparing consecutive user messages.
 * Two consecutive messages with >60 % word overlap are considered a retry.
 */
export function detectRetries(messages: SessionMessage[]): number {
  let retries = 0;

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (wordOverlap(prev.content, curr.content) > 0.6) {
      retries++;
    }
  }

  return retries;
}

/**
 * Group user prompts by common leading keywords and return frequency counts
 * together with average turn count (approximated as 1-based index distance
 * between consecutive user messages, since we do not always have turn_end
 * data correlated per-message).
 */
export function extractPromptPatterns(
  messages: SessionMessage[]
): PromptPattern[] {
  const buckets = new Map<string, { count: number; turnSum: number }>();

  for (let i = 0; i < messages.length; i++) {
    const key = patternKey(messages[i].content);
    if (!key) continue;

    // Estimate turns as distance to next user message (capped at 20)
    let turnsToNext = 1;
    if (i < messages.length - 1) {
      for (let j = i + 1; j < messages.length; j++) {
        turnsToNext = j - i;
        break;
      }
      turnsToNext = Math.min(20, turnsToNext);
    }

    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.turnSum += turnsToNext;
    } else {
      buckets.set(key, { count: 1, turnSum: turnsToNext });
    }
  }

  return [...buckets.entries()]
    .filter(([, v]) => v.count >= 2)
    .map(([pattern, v]) => ({
      pattern,
      count: v.count,
      avgTurns: Math.round((v.turnSum / v.count) * 10) / 10,
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively find all `.jsonl` files under a directory.
 */
async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await listJsonlFiles(fullPath);
        results.push(...nested);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }

    return results;
  } catch {
    // Directory doesn't exist or is inaccessible.
    return [];
  }
}

/**
 * Read a JSONL file, returning an array of parsed objects.
 * Malformed lines are silently skipped.
 */
async function readJsonl(filePath: string): Promise<Record<string, any>[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const entries: Record<string, any>[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip unparseable lines.
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Try to extract a user message from a session JSONL entry.
 *
 * Pi session entries use several shapes — we handle the common ones:
 * - `{ type: "message", message: { role: "user", content: [...] } }`
 * - `{ role: "user", content: "..." }`
 * - `{ _type: "interaction", promptRaw: "..." }`
 */
function extractUserMessage(
  entry: Record<string, any>
): SessionMessage | null {
  // Standard pi session message entry.
  if (entry.type === "message" && entry.message?.role === "user") {
    const content = stringifyContent(entry.message.content);
    if (content) {
      return { role: "user", content, timestamp: entry.message.timestamp };
    }
  }

  // Flat shape.
  if (entry.role === "user" && typeof entry.content === "string") {
    return { role: "user", content: entry.content, timestamp: entry.timestamp };
  }

  // Boost v1 interaction shape.
  if (
    (entry._type === "interaction" || entry.type === "interaction") &&
    typeof entry.promptRaw === "string"
  ) {
    return { role: "user", content: entry.promptRaw, timestamp: entry.ts };
  }

  return null;
}

/**
 * Normalise message content (which may be a string or a content-block array)
 * into a plain string.
 */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" && typeof block.text === "string")
          return block.text;
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Jaccard-like word overlap between two strings.
 * Returns a value in [0, 1].
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

/**
 * Derive a grouping key from a user prompt.
 *
 * Strategy: take the first meaningful verb/noun phrase (up to 3 words)
 * after lowering and stripping noise.  For example:
 * - "fix the auth middleware bug" → "fix auth middleware"
 * - "add a payment form"         → "add payment form"
 */
function patternKey(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

  if (words.length === 0) return null;
  return words.slice(0, 3).join(" ");
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "it",
  "to",
  "in",
  "of",
  "for",
  "and",
  "or",
  "on",
  "at",
  "by",
  "with",
  "from",
  "this",
  "that",
  "my",
  "your",
  "be",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "was",
  "were",
  "can",
  "could",
  "should",
  "would",
  "please",
  "just",
  "also",
  "then",
  "now",
  "so",
  "but",
  "if",
  "me",
  "i",
  "we",
  "you",
]);

function emptyAnalysis(): SessionAnalysis {
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalUserMessages: 0,
    retryCount: 0,
    promptPatterns: [],
    avgTurnsPerSession: 0,
    toolErrorCount: 0,
  };
}
