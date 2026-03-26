import { describe, it, expect } from "vitest";
import {
  detectIntent,
  getIntentWeights,
  getIntentPrefix,
  normalizePrompt,
  type TaskIntent,
  type SectionWeights,
} from "../src/intent";

// ─── normalizePrompt ─────────────────────────────────────────────

describe("normalizePrompt", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizePrompt("  Fix   the  BUG  ")).toBe("fix the bug");
  });

  it("returns empty string for empty input", () => {
    expect(normalizePrompt("")).toBe("");
    expect(normalizePrompt("   ")).toBe("");
  });

  it("handles tabs and newlines", () => {
    expect(normalizePrompt("add\n\ta\ntest")).toBe("add a test");
  });
});

// ─── detectIntent — positive cases ──────────────────────────────

describe("detectIntent", () => {
  const cases: [string, TaskIntent][] = [
    // test
    ["add tests for the auth module", "test"],
    ["fix the failing tests", "test"],
    ["write a spec for the parser", "test"],
    ["increase test coverage", "test"],
    ["the test is flaky", "test"],
    ["run vitest", "test"],
    ["add playwright e2e tests", "test"],

    // review
    ["review this PR", "review"],
    ["audit the permissions module", "review"],
    ["check for issues in the auth flow", "review"],
    ["look for bugs in the handler", "review"],
    ["do a code review", "review"],
    ["inspect the middleware", "review"],
    ["security audit the endpoints", "review"],

    // debug
    ["fix the login page", "debug"],
    ["there's a bug in the parser", "debug"],
    ["the server is crashing", "debug"],
    ["getting an error when uploading", "debug"],
    ["this function is failing", "debug"],
    ["debug the memory leak", "debug"],
    ["the form is not working", "debug"],
    ["doesn't work on Safari", "debug"],
    ["something is wrong with the build", "debug"],
    ["unexpected behavior in the API", "debug"],
    ["seeing a regression after the last deploy", "debug"],

    // refactor
    ["refactor the data layer", "refactor"],
    ["clean up the utils file", "refactor"],
    ["simplify this function", "refactor"],
    ["restructure the project layout", "refactor"],
    ["reorganize the components folder", "refactor"],
    ["extract a function from this handler", "refactor"],
    ["split this file into separate modules", "refactor"],
    ["deduplicate shared logic", "refactor"],
    ["reduce complexity in the router", "refactor"],
    ["improve readability of the config", "refactor"],

    // explain
    ["explain how the auth flow works", "explain"],
    ["why does this component re-render?", "explain"],
    ["how does the caching layer work?", "explain"],
    ["how do the middleware hooks work?", "explain"],
    ["what is the purpose of this file?", "explain"],
    ["walk me through the deploy process", "explain"],
    ["describe the data model", "explain"],
    ["tell me about the architecture", "explain"],

    // implement
    ["build a new dashboard page", "implement"],
    ["create a REST endpoint for users", "implement"],
    ["add pagination to the list view", "implement"],
    ["implement the notification system", "implement"],
    ["integrate Stripe for payments", "implement"],
    ["wire up the WebSocket handler", "implement"],
    ["scaffold a new service module", "implement"],
    ["generate the migration file", "implement"],
    ["set up the CI pipeline", "implement"],
    ["new feature for user profiles", "implement"],
    ["write a middleware for logging", "implement"],

    // general
    ["hello", "general"],
    ["thanks", "general"],
    ["ok", "general"],
    ["what time is it", "general"],
  ];

  for (const [prompt, expected] of cases) {
    it(`"${prompt}" → ${expected}`, () => {
      expect(detectIntent(prompt)).toBe(expected);
    });
  }

  // ─── Priority / disambiguation ──────────────────────────────

  describe("priority waterfall", () => {
    it('"fix the failing test" → test (not debug)', () => {
      expect(detectIntent("fix the failing test")).toBe("test");
    });

    it('"fix broken tests" → test (not debug)', () => {
      expect(detectIntent("fix broken tests")).toBe("test");
    });

    it('"add error handling tests" → test (not debug)', () => {
      expect(detectIntent("add error handling tests")).toBe("test");
    });

    it('"review the test suite" → test (test checked before review)', () => {
      expect(detectIntent("review the test suite")).toBe("test");
    });

    it('"fix the bug" → debug (no test signal)', () => {
      expect(detectIntent("fix the bug")).toBe("debug");
    });

    it('"review for bugs" → review (review checked before debug)', () => {
      expect(detectIntent("review for bugs")).toBe("review");
    });

    it('"check for security issues" → review', () => {
      expect(detectIntent("check for security issues")).toBe("review");
    });
  });

  // ─── "explain" anchoring ─────────────────────────────────────

  describe("explain anchoring to start of prompt", () => {
    it('"explain the module" → explain', () => {
      expect(detectIntent("explain the module")).toBe("explain");
    });

    it('"why does X happen" → explain', () => {
      expect(detectIntent("why does the server restart")).toBe("explain");
    });

    it('"add an explain function" → implement (explain not at start context)', () => {
      // "add" triggers implement; "explain" pattern requires start-of-string
      expect(detectIntent("add an explain function")).toBe("implement");
    });

    it('"please explain this" does not match explain (not anchored to start)', () => {
      // "please" at start means ^explain won't match — falls through
      const result = detectIntent("please explain this");
      expect(result).not.toBe("explain");
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("empty string → general", () => {
      expect(detectIntent("")).toBe("general");
    });

    it("whitespace only → general", () => {
      expect(detectIntent("   \n\t  ")).toBe("general");
    });

    it("case insensitive matching", () => {
      expect(detectIntent("FIX THE BUG")).toBe("debug");
      expect(detectIntent("REFACTOR the module")).toBe("refactor");
      expect(detectIntent("Add Tests")).toBe("test");
    });

    it("very long prompt still classifies correctly", () => {
      const longPrompt = "fix the " + "very ".repeat(500) + "broken handler";
      expect(detectIntent(longPrompt)).toBe("debug");
    });

    it("mixed signals — first matching rule wins", () => {
      // "test" is checked before "debug", so test wins
      expect(detectIntent("debug the test runner")).toBe("test");
    });

    it("punctuation does not break word boundaries", () => {
      expect(detectIntent("fix: the login is broken")).toBe("debug");
    });

    it("hyphenated words still match", () => {
      expect(detectIntent("set up the pre-build test")).toBe("test");
    });
  });
});

// ─── getIntentWeights ────────────────────────────────────────────

describe("getIntentWeights", () => {
  it("implement boosts Conventions, Co-Change Rules, Mandatory Checklist", () => {
    const w = getIntentWeights("implement");
    expect(w["Conventions"]).toBe(2);
    expect(w["Co-Change Rules"]).toBe(2);
    expect(w["Mandatory Checklist"]).toBe(2);
  });

  it("debug boosts Known Failure Patterns & AI Anti-Patterns, reduces Success Patterns", () => {
    const w = getIntentWeights("debug");
    expect(w["Known Failure Patterns"]).toBe(2);
    expect(w["AI-Specific Anti-Patterns"]).toBe(2);
    expect(w["Success Patterns"]).toBe(0.5);
  });

  it("refactor boosts Co-Change Rules & Conventions", () => {
    const w = getIntentWeights("refactor");
    expect(w["Co-Change Rules"]).toBe(2);
    expect(w["Conventions"]).toBe(2);
  });

  it("test boosts Known Failure Patterns & Conventions, reduces Success Patterns", () => {
    const w = getIntentWeights("test");
    expect(w["Known Failure Patterns"]).toBe(2);
    expect(w["Conventions"]).toBe(2);
    expect(w["Success Patterns"]).toBe(0.5);
  });

  it("review boosts Known Failure Patterns, AI Anti-Patterns, Co-Change Rules", () => {
    const w = getIntentWeights("review");
    expect(w["Known Failure Patterns"]).toBe(2);
    expect(w["AI-Specific Anti-Patterns"]).toBe(2);
    expect(w["Co-Change Rules"]).toBe(2);
  });

  it("explain boosts Success Patterns, reduces Mandatory Checklist", () => {
    const w = getIntentWeights("explain");
    expect(w["Success Patterns"]).toBe(2);
    expect(w["Mandatory Checklist"]).toBe(0.5);
  });

  it("general returns empty weights (all sections at implicit 1.0)", () => {
    const w = getIntentWeights("general");
    expect(Object.keys(w)).toHaveLength(0);
  });

  it("returns a copy — mutations don't affect internal state", () => {
    const w1 = getIntentWeights("implement");
    w1["Conventions"] = 99;
    const w2 = getIntentWeights("implement");
    expect(w2["Conventions"]).toBe(2);
  });

  it("unlisted sections have implicit weight of 1.0", () => {
    const w = getIntentWeights("debug");
    expect(w["Some Random Section"]).toBeUndefined();
    // Consumers should treat undefined as 1.0
  });
});

// ─── getIntentPrefix ─────────────────────────────────────────────

describe("getIntentPrefix", () => {
  const prompt = "add authentication to the API";

  it("implement prefix includes WHAT/WHERE structure reference", () => {
    const prefix = getIntentPrefix("implement", prompt);
    expect(prefix).toContain("WHAT/WHERE/CONNECTS/GUARDS/VERIFY");
    expect(prefix).toContain("boost-context");
    expect(prefix).toContain("mandatory checklist");
    expect(prefix.endsWith("Task: " + prompt)).toBe(true);
  });

  it("debug prefix references Known Failure Patterns", () => {
    const prefix = getIntentPrefix("debug", prompt);
    expect(prefix).toContain("Known Failure Patterns");
    expect(prefix).toContain("reproduce the issue");
    expect(prefix.endsWith("Issue: " + prompt)).toBe(true);
  });

  it("refactor prefix warns to preserve behavior", () => {
    const prefix = getIntentPrefix("refactor", prompt);
    expect(prefix).toContain("Preserve all behavior");
    expect(prefix).toContain("Co-Change Rules");
    expect(prefix.endsWith("Refactor: " + prompt)).toBe(true);
  });

  it("test prefix references test conventions", () => {
    const prefix = getIntentPrefix("test", prompt);
    expect(prefix).toContain("Known Failure Patterns");
    expect(prefix).toContain("test conventions");
    expect(prefix.endsWith("Test task: " + prompt)).toBe(true);
  });

  it("review prefix asks for severity-based reporting", () => {
    const prefix = getIntentPrefix("review", prompt);
    expect(prefix).toContain("findings by severity");
    expect(prefix).toContain("AI Anti-Patterns");
    expect(prefix.endsWith("Review: " + prompt)).toBe(true);
  });

  it("explain prefix references boost-context for project structure", () => {
    const prefix = getIntentPrefix("explain", prompt);
    expect(prefix).toContain("clearly and concisely");
    expect(prefix).toContain("boost-context");
    expect(prefix.endsWith("Question: " + prompt)).toBe(true);
  });

  it("general prefix is a generic task wrapper", () => {
    const prefix = getIntentPrefix("general", prompt);
    expect(prefix).toContain("boost-context");
    expect(prefix).toContain("conventions and checklist");
    expect(prefix.endsWith("Task: " + prompt)).toBe(true);
  });

  it("preserves the raw prompt exactly as provided", () => {
    const raw = "Fix: the login page (urgent!)";
    const prefix = getIntentPrefix("debug", raw);
    expect(prefix).toContain(raw);
  });
});
