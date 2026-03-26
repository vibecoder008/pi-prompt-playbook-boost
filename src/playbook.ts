/**
 * Playbook — Read, write, parse, and smart-load the project playbook.
 *
 * The playbook is a Markdown file split into sections by `## ` headings.
 * Smart loading selects only the sections relevant to the user's prompt,
 * keeping context injection lean (~2-4KB instead of full 10KB).
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────

export interface PlaybookSection {
  heading: string;
  content: string;
  keywords: string[];
}

// Sections always injected regardless of prompt content
const ALWAYS_INJECT = [
  "project identity",
  "prompt structure",
  "mandatory checklist",
  "stats",
];

// Max additional sections to inject beyond the always-inject set
const MAX_ADDITIONAL_SECTIONS = 3;

// ─── Read / Write ────────────────────────────────────────────────

let cachedContent: string | null = null;
let cachedMtime: number = 0;

export async function readPlaybook(boostDir: string): Promise<string | null> {
  const path = join(boostDir, "playbook.md");
  try {
    const st = await stat(path);
    if (cachedContent && st.mtimeMs === cachedMtime) {
      return cachedContent;
    }
    cachedContent = await readFile(path, "utf-8");
    cachedMtime = st.mtimeMs;
    return cachedContent;
  } catch {
    return null;
  }
}

export function invalidateCache(): void {
  cachedContent = null;
  cachedMtime = 0;
}

export async function writePlaybook(boostDir: string, content: string): Promise<void> {
  await writeFile(join(boostDir, "playbook.md"), content, "utf-8");
  invalidateCache();
}

// ─── Parse ───────────────────────────────────────────────────────

export function parsePlaybook(content: string): PlaybookSection[] {
  const sections: PlaybookSection[] = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Save previous section
      if (currentHeading) {
        const text = currentLines.join("\n").trim();
        sections.push({
          heading: currentHeading,
          content: text,
          keywords: extractKeywords(currentHeading + " " + text),
        });
      }
      currentHeading = line.slice(3).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Save last section
  if (currentHeading) {
    const text = currentLines.join("\n").trim();
    sections.push({
      heading: currentHeading,
      content: text,
      keywords: extractKeywords(currentHeading + " " + text),
    });
  }

  return sections;
}

// ─── Smart Section Selection ─────────────────────────────────────

/**
 * Select the most relevant playbook sections for a user prompt.
 *
 * Always includes: Project Identity, Prompt Structure, Mandatory Checklist, Stats.
 * Scores remaining sections by keyword overlap with the user's prompt.
 * Returns the top MAX_ADDITIONAL_SECTIONS by relevance.
 */
export function selectRelevantSections(
  sections: PlaybookSection[],
  userPrompt: string,
  weights?: Record<string, number>,
): PlaybookSection[] {
  const promptKeywords = new Set(extractKeywords(userPrompt));
  const selected: PlaybookSection[] = [];
  const candidates: { section: PlaybookSection; score: number }[] = [];

  for (const section of sections) {
    const headingLower = section.heading.toLowerCase();

    // Always include these sections
    if (ALWAYS_INJECT.some((h) => headingLower.includes(h))) {
      selected.push(section);
      continue;
    }

    // Score by keyword overlap
    let overlap = 0;
    for (const kw of section.keywords) {
      if (promptKeywords.has(kw)) overlap++;
    }

    // Normalize by section keyword count to avoid bias toward large sections.
    // Apply intent weight if provided (default 1.0).
    const weight = weights?.[section.heading] ?? 1.0;
    const score = section.keywords.length > 0
      ? (overlap / Math.sqrt(section.keywords.length)) * weight
      : 0;

    candidates.push({ section, score });
  }

  // Sort by score descending, take top N
  candidates.sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(MAX_ADDITIONAL_SECTIONS, candidates.length); i++) {
    if (candidates[i].score > 0) {
      selected.push(candidates[i].section);
    }
  }

  // If no candidates scored > 0, include all sections (playbook is small)
  if (selected.length <= ALWAYS_INJECT.length && candidates.length > 0) {
    for (let i = 0; i < Math.min(MAX_ADDITIONAL_SECTIONS, candidates.length); i++) {
      selected.push(candidates[i].section);
    }
  }

  return selected;
}

// ─── Build Injection Block ───────────────────────────────────────

/**
 * Format selected sections as a <boost-context> XML block for system prompt injection.
 */
export function buildInjectionBlock(sections: PlaybookSection[]): string {
  const parts = sections.map((s) => `## ${s.heading}\n${s.content}`);
  return `<boost-context source="project-playbook">\n${parts.join("\n\n")}\n</boost-context>`;
}

// ─── Stats Section Update ────────────────────────────────────────

/**
 * Surgically update only the Stats section of the playbook without touching anything else.
 */
export async function updateStatsSection(boostDir: string, statsContent: string): Promise<void> {
  const content = await readPlaybook(boostDir);
  if (!content) return;

  const statsRegex = /## Stats\n[\s\S]*?(?=\n## |\n*$)/;
  const newStats = `## Stats\n${statsContent}`;

  let updated: string;
  if (statsRegex.test(content)) {
    updated = content.replace(statsRegex, newStats);
  } else {
    // Append stats section at the end
    updated = content.trimEnd() + "\n\n" + newStats + "\n";
  }

  await writePlaybook(boostDir, updated);
}

// ─── Helpers ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "but", "and",
  "or", "if", "while", "about", "up", "it", "its", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "him", "his", "she", "her", "they", "them", "their", "what", "which",
  "who", "whom", "also", "use", "using", "make", "get",
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.\/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}
