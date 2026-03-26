/**
 * Intent Detection — Classify user prompts into task intents and map them
 * to playbook section weights and tailored prompt prefixes.
 *
 * Intent detection feeds directly into section selection: instead of generic
 * classification, each intent produces concrete section weight multipliers
 * so the most relevant playbook sections are prioritized.
 *
 * Pure functions, no dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────

/** Supported task intent categories. */
export type TaskIntent =
  | "implement"
  | "debug"
  | "refactor"
  | "test"
  | "review"
  | "explain"
  | "general";

/** Multipliers applied to keyword scores during section selection. */
export interface SectionWeights {
  [sectionHeading: string]: number;
}

// ─── Pattern Definitions ─────────────────────────────────────────

/**
 * Each rule is a tuple of [intent, patterns].
 * Order matters — first match wins (priority waterfall).
 * "test" is checked first so "fix the failing test" maps to "test" not "debug".
 */
const INTENT_RULES: [TaskIntent, RegExp[]][] = [
  [
    "test",
    [
      /\btest(?:s|ing)?\b/,
      /\bspec(?:s)?\b/,
      /\bcoverage\b/,
      /\b(?:add|write|create|fix|update|run)\b.*\btest/,
      /\btest\b.*\b(?:fail|pass|broken|flaky)\b/,
      /\btdd\b/,
      /\bjest\b/,
      /\bvitest\b/,
      /\bmocha\b/,
      /\bcypress\b/,
      /\bplaywright\b/,
    ],
  ],
  [
    "review",
    [
      /\breview\b/,
      /\baudit\b/,
      /\bcheck\s+(?:for|if|whether)\b/,
      /\blook\s+(?:for|at|over|into)\s+(?:issues|problems|bugs|errors)\b/,
      /\bcode\s*review\b/,
      /\binspect\b/,
      /\bsecurity\s+(?:check|audit|review|scan)\b/,
    ],
  ],
  [
    "debug",
    [
      /\bfix\b/,
      /\bbug(?:s)?\b/,
      /\bbroken\b/,
      /\bcrash(?:es|ing)?\b/,
      /\berror(?:s)?\b/,
      /\bfail(?:s|ing|ed)?\b/,
      /\bdebug\b/,
      /\bnot\s+working\b/,
      /\bdoesn'?t\s+work\b/,
      /\bissue(?:s)?\b/,
      /\bwrong\b/,
      /\bregression\b/,
      /\bstack\s*trace\b/,
      /\bunexpected\b/,
    ],
  ],
  [
    "refactor",
    [
      /\brefactor\b/,
      /\bclean\s*up\b/,
      /\bsimplif(?:y|ied|ication)\b/,
      /\brestructure\b/,
      /\breorganize\b/,
      /\bextract\b.*\b(?:function|method|component|module|class)\b/,
      /\bsplit\b.*\b(?:file|module|component)\b/,
      /\bdedup(?:licate)?\b/,
      /\breduce\s+complexity\b/,
      /\bimprove\s+(?:readability|structure|code\s+quality)\b/,
    ],
  ],
  [
    "explain",
    [
      /^explain\b/,
      /^why\b/,
      /^how\s+does\b/,
      /^how\s+do\b/,
      /^what\s+(?:is|are|does)\b/,
      /^walk\s+me\s+through\b/,
      /^describe\b/,
      /^tell\s+me\s+(?:about|how|why)\b/,
    ],
  ],
  [
    "implement",
    [
      /\bbuild\b/,
      /\bcreate\b/,
      /\badd\b/,
      /\bimplement\b/,
      /\bintegrate\b/,
      /\bwire\s+up\b/,
      /\bscaffold\b/,
      /\bgenerate\b/,
      /\bset\s*up\b/,
      /\bnew\s+(?:feature|component|module|endpoint|page|route|api)\b/,
      /\bwrite\s+(?:a|the|an)\b/,
    ],
  ],
];

// ─── Section Weight Maps ─────────────────────────────────────────

const WEIGHT_MAPS: Record<TaskIntent, SectionWeights> = {
  implement: {
    "Conventions": 2,
    "Co-Change Rules": 2,
    "Mandatory Checklist": 2,
  },
  debug: {
    "Known Failure Patterns": 2,
    "AI-Specific Anti-Patterns": 2,
    "Success Patterns": 0.5,
  },
  refactor: {
    "Co-Change Rules": 2,
    "Conventions": 2,
  },
  test: {
    "Known Failure Patterns": 2,
    "Conventions": 2,
    "Success Patterns": 0.5,
  },
  review: {
    "Known Failure Patterns": 2,
    "AI-Specific Anti-Patterns": 2,
    "Co-Change Rules": 2,
  },
  explain: {
    "Success Patterns": 2,
    "Mandatory Checklist": 0.5,
  },
  general: {},
};

// ─── Prompt Prefix Templates ─────────────────────────────────────

const PREFIX_TEMPLATES: Record<TaskIntent, (prompt: string) => string> = {
  implement: (p) =>
    "Following the project playbook in <boost-context>, implement the following. " +
    "Apply the WHAT/WHERE/CONNECTS/GUARDS/VERIFY structure. " +
    "Follow all mandatory checklist items and conventions.\n\nTask: " + p,
  debug: (p) =>
    "Following the project playbook in <boost-context>, debug and fix the following issue. " +
    "Check the Known Failure Patterns section for common causes. " +
    "Inspect before editing \u2014 reproduce the issue, find root cause, fix, verify.\n\nIssue: " + p,
  refactor: (p) =>
    "Following the project playbook in <boost-context>, refactor the following. " +
    "Preserve all behavior \u2014 improve structure only. " +
    "Check Co-Change Rules for files that must change together.\n\nRefactor: " + p,
  test: (p) =>
    "Following the project playbook in <boost-context>, work on the following test task. " +
    "Check Known Failure Patterns for recurring issues. " +
    "Follow project test conventions.\n\nTest task: " + p,
  review: (p) =>
    "Following the project playbook in <boost-context>, review the following. " +
    "Check for Known Failure Patterns and AI Anti-Patterns. " +
    "Report findings by severity before suggesting changes.\n\nReview: " + p,
  explain: (p) =>
    "Explain the following clearly and concisely. " +
    "Reference the project structure from <boost-context> where relevant.\n\nQuestion: " + p,
  general: (p) =>
    "Following the project playbook in <boost-context>, handle the following task. " +
    "Follow all conventions and checklist items.\n\nTask: " + p,
};

// ─── Public API ──────────────────────────────────────────────────

/**
 * Normalize a prompt for matching: lowercase, collapse whitespace, trim.
 */
export function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify a user prompt into a {@link TaskIntent}.
 *
 * Uses a priority waterfall: test > review > debug > refactor > explain > implement > general.
 * This ordering ensures specific intents win over general ones
 * (e.g. "fix the failing test" resolves to "test", not "debug").
 */
export function detectIntent(prompt: string): TaskIntent {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return "general";

  for (const [intent, patterns] of INTENT_RULES) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return intent;
      }
    }
  }

  return "general";
}

/**
 * Return section heading weight multipliers for the given intent.
 *
 * Sections not listed in the returned map have an implicit weight of 1.0.
 * Values > 1 boost a section's keyword score; values < 1 reduce it.
 */
export function getIntentWeights(intent: TaskIntent): SectionWeights {
  return { ...WEIGHT_MAPS[intent] };
}

/**
 * Return an intent-tailored prompt prefix wrapping the raw user prompt.
 *
 * The prefix references `<boost-context>` so the model knows to consult
 * the injected playbook sections.
 */
export function getIntentPrefix(intent: TaskIntent, rawPrompt: string): string {
  return PREFIX_TEMPLATES[intent](rawPrompt);
}
