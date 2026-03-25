import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InteractionRecord } from "../types";

const HISTORY_DIR = "history";
const SESSIONS_FILE = "sessions.jsonl";

/**
 * Append a single interaction record as one JSON line to history/sessions.jsonl.
 * Creates the history/ directory if it does not exist.
 */
export async function appendInteraction(
  boostDir: string,
  record: InteractionRecord,
): Promise<void> {
  const historyDir = join(boostDir, HISTORY_DIR);
  await mkdir(historyDir, { recursive: true });

  const filePath = join(historyDir, SESSIONS_FILE);
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Read the last `limit` interaction records from sessions.jsonl.
 * Returns an empty array if the file does not exist.
 */
export async function readRecentInteractions(
  boostDir: string,
  limit = 50,
): Promise<InteractionRecord[]> {
  const filePath = join(boostDir, HISTORY_DIR, SESSIONS_FILE);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-limit);

  const records: InteractionRecord[] = [];
  for (const line of tail) {
    try {
      records.push(JSON.parse(line) as InteractionRecord);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/**
 * Count the number of interaction records in sessions.jsonl.
 * Fast: counts non-empty lines without parsing JSON.
 */
export async function getInteractionCount(boostDir: string): Promise<number> {
  const filePath = join(boostDir, HISTORY_DIR, SESSIONS_FILE);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return 0;
  }

  if (!content.trim()) return 0;
  return content.split("\n").filter((l) => l.trim()).length;
}
