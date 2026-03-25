import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FixChain, InteractionRecord, PendingUpdate, ScoringResult } from "../types";

// --- Playbook Stats ---

/**
 * Update the ## Stats section of the playbook with current metrics.
 * Only touches the Stats section — everything else is preserved.
 */
export async function updatePlaybookStats(
  boostDir: string,
  interactions: InteractionRecord[],
  scores: ScoringResult[],
): Promise<void> {
  const playbookPath = join(boostDir, "playbook.md");
  let playbook: string;
  try {
    playbook = await readFile(playbookPath, "utf-8");
  } catch {
    return; // no playbook yet
  }

  const total = interactions.length;
  const successCount = scores.filter((s) => s.composite >= 0.7).length;
  const successRate = total > 0 ? ((successCount / total) * 100).toFixed(1) : "0.0";
  const avgComposite =
    total > 0 ? (scores.reduce((sum, s) => sum + s.composite, 0) / total).toFixed(2) : "0.00";

  const lastSession =
    interactions.length > 0
      ? new Date(interactions[interactions.length - 1].timestamp).toISOString()
      : "N/A";
  const now = new Date().toISOString();

  const statsLines = [
    "## Stats",
    `- Total boosted prompts: ${total}`,
    `- First-attempt success rate: ${successRate}%`,
    `- Average composite score: ${avgComposite}`,
    `- Most recent session: ${lastSession}`,
    `- Last updated: ${now}`,
  ];

  const lines = playbook.split("\n");
  let statsStart = -1;
  let statsEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Stats")) {
      statsStart = i;
    } else if (statsStart >= 0 && lines[i].startsWith("## ")) {
      statsEnd = i;
      break;
    }
  }

  if (statsStart >= 0) {
    lines.splice(statsStart, statsEnd - statsStart, ...statsLines);
  } else {
    lines.push("", ...statsLines);
  }

  await writeFile(playbookPath, lines.join("\n"), "utf-8");
}

// --- Suggestion Generation ---

/**
 * Generate PendingUpdate suggestions from fix chains and low-scoring interactions.
 */
export function generateSuggestions(
  newFixChains: FixChain[],
  interactions: InteractionRecord[],
  scores: ScoringResult[],
): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  const now = new Date().toISOString();

  // Count how often each file-set appears across chains (repeated patterns are higher confidence)
  const filePatternCounts = new Map<string, number>();
  for (const chain of newFixChains) {
    const key = chain.sharedFiles.slice().sort().join(",");
    filePatternCounts.set(key, (filePatternCounts.get(key) ?? 0) + 1);
  }

  // Fix chain -> failure pattern rule
  for (const chain of newFixChains) {
    const key = chain.sharedFiles.slice().sort().join(",");
    const count = filePatternCounts.get(key) ?? 1;
    const shortFeature = chain.featureCommit.hash.slice(0, 7);
    const shortFix = chain.fixCommit.hash.slice(0, 7);
    const filesLabel = chain.sharedFiles.join(", ");
    const hoursApart = chain.hoursBetween.toFixed(1);

    updates.push({
      id: `fix_${chain.fixCommit.hash.slice(0, 12)}_${Date.now()}`,
      type: "new_rule",
      section: "known_failure_patterns",
      content: `When modifying ${filesLabel}, also check related files`,
      evidence: `Commit ${shortFix} fixed ${filesLabel} within ${hoursApart}h of feature commit ${shortFeature}`,
      confidence: Math.min(0.5 + count * 0.15, 0.95),
      created: now,
      status: "pending",
    });
  }

  // Low-scoring interactions -> review suggestion
  for (let i = 0; i < interactions.length; i++) {
    const score = scores[i];
    if (!score || score.composite >= 0.5) continue;

    const interaction = interactions[i];
    const category = interaction.category ?? "unknown";

    updates.push({
      id: `low_${interaction.id}_${Date.now()}`,
      type: "update_stat",
      section: "known_failure_patterns",
      content: `Task type "${category}" has low success rate — consider adding more specific conventions`,
      evidence: `Interaction ${interaction.id} scored ${score.composite.toFixed(2)} (turns: ${interaction.turns}, errors: ${interaction.toolErrors})`,
      confidence: 0.4,
      created: now,
      status: "pending",
    });
  }

  return updates;
}

// --- Pending Updates Persistence ---

/**
 * Append new updates to pending-updates.json, deduplicating by section + content.
 */
export async function savePendingUpdates(
  boostDir: string,
  updates: PendingUpdate[],
): Promise<void> {
  if (updates.length === 0) return;

  const filePath = join(boostDir, "pending-updates.json");

  let existing: PendingUpdate[] = [];
  try {
    existing = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    // file missing or invalid — start fresh
  }

  for (const update of updates) {
    const isDuplicate = existing.some(
      (e) => e.section === update.section && e.content === update.content && e.status === "pending",
    );
    if (!isDuplicate) {
      existing.push(update);
    }
  }

  await writeFile(filePath, JSON.stringify(existing, null, 2), "utf-8");
}

// --- Apply / Reject ---

const SECTION_HEADERS: Record<string, string> = {
  known_failure_patterns: "## Known Failure Patterns",
  co_change_rules: "## Co-Change Rules",
  conventions: "## Conventions",
  ai_anti_patterns: "## AI-Specific Anti-Patterns",
  success_patterns: "## Success Patterns",
  mandatory_checklist: "## Mandatory Checklist",
};

function sectionHeader(key: string): string {
  return SECTION_HEADERS[key] ?? `## ${key}`;
}

/**
 * Accept or reject a pending update.
 *
 * Accept: read the playbook, find the target section, append the new rule, then
 *         remove the update from pending-updates.json.
 * Reject: just remove from pending-updates.json.
 */
export async function applyUpdate(
  boostDir: string,
  update: PendingUpdate,
  action: "accept" | "reject",
): Promise<void> {
  if (action === "accept") {
    const playbookPath = join(boostDir, "playbook.md");
    let playbook: string;
    try {
      playbook = await readFile(playbookPath, "utf-8");
    } catch {
      return; // no playbook to update
    }

    const header = sectionHeader(update.section);
    const lines = playbook.split("\n");
    let inSection = false;
    let sectionEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(header)) {
        inSection = true;
      } else if (inSection && lines[i].startsWith("## ")) {
        sectionEnd = i;
        break;
      }
    }

    if (inSection) {
      if (sectionEnd === -1) sectionEnd = lines.length;
      // Walk back past trailing blank lines so the rule lands inside the section body
      let insertAt = sectionEnd;
      while (insertAt > 0 && !lines[insertAt - 1].trim()) {
        insertAt--;
      }
      lines.splice(insertAt, 0, `- ${update.content}`);
      await writeFile(playbookPath, lines.join("\n"), "utf-8");
    }
  }

  // Remove from pending-updates.json regardless of accept/reject
  const updatesPath = join(boostDir, "pending-updates.json");
  let existing: PendingUpdate[] = [];
  try {
    existing = JSON.parse(await readFile(updatesPath, "utf-8"));
  } catch {
    return;
  }

  existing = existing.filter((e) => e.id !== update.id);
  await writeFile(updatesPath, JSON.stringify(existing, null, 2), "utf-8");
}
