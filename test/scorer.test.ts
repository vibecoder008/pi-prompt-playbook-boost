import { describe, it, expect } from "vitest";
import { scoreInteraction } from "../src/learning/scorer";
import type { InteractionRecord } from "../src/types";

function makeRecord(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    id: "test-1",
    timestamp: Date.now(),
    sessionId: "sess-1",
    promptRaw: "do something",
    sectionsUsed: [],
    turns: 1,
    totalToolCalls: 5,
    toolErrors: 0,
    retried: false,
    ...overrides,
  };
}

// ─── scoreInteraction ────────────────────────────────────────────

describe("scoreInteraction", () => {
  // ── Perfect score ────────────────────────────────────────────

  it("returns perfect score (1.0) for 1 turn, 0 errors, no retry", () => {
    const result = scoreInteraction(makeRecord());

    expect(result.signals.turnEfficiency).toBe(1.0);
    expect(result.signals.errorFree).toBe(1.0);
    expect(result.signals.noRetry).toBe(1.0);
    expect(result.composite).toBeCloseTo(1.0, 10);
  });

  // ── Turn efficiency: exponential decay ───────────────────────

  it("applies exponential decay for 3 turns (approx 0.55)", () => {
    const result = scoreInteraction(makeRecord({ turns: 3 }));

    // exp(-0.3 * 2) = exp(-0.6) ≈ 0.5488
    expect(result.signals.turnEfficiency).toBeCloseTo(Math.exp(-0.6), 4);
    expect(result.signals.turnEfficiency).toBeCloseTo(0.5488, 3);
  });

  it("applies exponential decay for 5 turns (approx 0.30)", () => {
    const result = scoreInteraction(makeRecord({ turns: 5 }));

    // exp(-0.3 * 4) = exp(-1.2) ≈ 0.3012
    expect(result.signals.turnEfficiency).toBeCloseTo(Math.exp(-1.2), 4);
    expect(result.signals.turnEfficiency).toBeCloseTo(0.3012, 3);
  });

  it("returns turnEfficiency 1.0 for exactly 1 turn", () => {
    const result = scoreInteraction(makeRecord({ turns: 1 }));

    // exp(-0.3 * max(0, 0)) = exp(0) = 1.0
    expect(result.signals.turnEfficiency).toBe(1.0);
  });

  it("decays steeply for many turns (10 turns)", () => {
    const result = scoreInteraction(makeRecord({ turns: 10 }));

    // exp(-0.3 * 9) = exp(-2.7) ≈ 0.0672
    expect(result.signals.turnEfficiency).toBeCloseTo(Math.exp(-2.7), 4);
    expect(result.signals.turnEfficiency).toBeLessThan(0.1);
  });

  // ── Error-free signal ────────────────────────────────────────

  it("returns errorFree 1.0 when there are zero tool errors", () => {
    const result = scoreInteraction(makeRecord({ toolErrors: 0, totalToolCalls: 10 }));
    expect(result.signals.errorFree).toBe(1.0);
  });

  it("reduces errorFree proportionally to error ratio", () => {
    const result = scoreInteraction(makeRecord({ toolErrors: 2, totalToolCalls: 10 }));

    // 1 - 2/10 = 0.8
    expect(result.signals.errorFree).toBeCloseTo(0.8, 10);
  });

  it("returns errorFree 0.0 when all tool calls are errors", () => {
    const result = scoreInteraction(makeRecord({ toolErrors: 5, totalToolCalls: 5 }));

    // 1 - 5/5 = 0.0
    expect(result.signals.errorFree).toBe(0.0);
  });

  it("handles zero totalToolCalls with errors safely (no division by zero)", () => {
    // max(1, 0) = 1, so errorFree = 1 - errors/1
    const result = scoreInteraction(makeRecord({ toolErrors: 1, totalToolCalls: 0 }));

    // 1 - 1/max(1,0) = 1 - 1/1 = 0.0
    expect(result.signals.errorFree).toBe(0.0);
    expect(Number.isFinite(result.signals.errorFree)).toBe(true);
    expect(Number.isFinite(result.composite)).toBe(true);
  });

  it("handles zero totalToolCalls with zero errors", () => {
    const result = scoreInteraction(makeRecord({ toolErrors: 0, totalToolCalls: 0 }));

    // 0 errors => errorFree = 1.0 (early return path)
    expect(result.signals.errorFree).toBe(1.0);
  });

  // ── No-retry signal ──────────────────────────────────────────

  it("returns noRetry 1.0 when user did not retry", () => {
    const result = scoreInteraction(makeRecord({ retried: false }));
    expect(result.signals.noRetry).toBe(1.0);
  });

  it("returns noRetry 0.2 when user retried", () => {
    const result = scoreInteraction(makeRecord({ retried: true }));
    expect(result.signals.noRetry).toBe(0.2);
  });

  // ── Composite: weight verification ──────────────────────────

  it("weights sum to 1.0 (0.35 + 0.35 + 0.30)", () => {
    // Verify by computing composite manually for known signals
    const record = makeRecord({ turns: 3, toolErrors: 1, totalToolCalls: 4, retried: false });
    const result = scoreInteraction(record);

    const expectedTurnEff = Math.exp(-0.3 * 2);
    const expectedErrorFree = 1 - 1 / 4;
    const expectedNoRetry = 1.0;
    const expectedComposite =
      0.35 * expectedTurnEff +
      0.35 * expectedErrorFree +
      0.30 * expectedNoRetry;

    expect(result.signals.turnEfficiency).toBeCloseTo(expectedTurnEff, 10);
    expect(result.signals.errorFree).toBeCloseTo(expectedErrorFree, 10);
    expect(result.signals.noRetry).toBe(expectedNoRetry);
    expect(result.composite).toBeCloseTo(expectedComposite, 10);
  });

  it("composite equals manual weighted sum", () => {
    const record = makeRecord({ turns: 4, toolErrors: 3, totalToolCalls: 8, retried: true });
    const result = scoreInteraction(record);

    const te = Math.exp(-0.3 * 3);
    const ef = 1 - 3 / 8;
    const nr = 0.2;
    const expected = 0.35 * te + 0.35 * ef + 0.30 * nr;

    expect(result.composite).toBeCloseTo(expected, 10);
  });

  // ── All signals bad ──────────────────────────────────────────

  it("returns low composite when all signals are bad", () => {
    const result = scoreInteraction(
      makeRecord({ turns: 10, toolErrors: 8, totalToolCalls: 8, retried: true }),
    );

    // turnEfficiency = exp(-2.7) ≈ 0.067
    // errorFree = 1 - 8/8 = 0.0
    // noRetry = 0.2
    // composite ≈ 0.35 * 0.067 + 0.35 * 0.0 + 0.30 * 0.2 ≈ 0.0835
    expect(result.composite).toBeLessThan(0.15);
    expect(result.composite).toBeGreaterThanOrEqual(0);
  });

  // ── Composite always in [0, 1] ──────────────────────────────

  it("composite is in [0, 1] for perfect case", () => {
    const result = scoreInteraction(makeRecord());
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(1);
  });

  it("composite is in [0, 1] for worst case", () => {
    const result = scoreInteraction(
      makeRecord({ turns: 100, toolErrors: 50, totalToolCalls: 50, retried: true }),
    );
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(1);
  });

  it("composite is in [0, 1] for moderate case", () => {
    const result = scoreInteraction(
      makeRecord({ turns: 5, toolErrors: 2, totalToolCalls: 10, retried: false }),
    );
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(1);
  });

  it("composite is in [0, 1] when retried with 1 turn and no errors", () => {
    const result = scoreInteraction(makeRecord({ retried: true }));
    // turnEfficiency = 1.0, errorFree = 1.0, noRetry = 0.2
    // composite = 0.35 + 0.35 + 0.06 = 0.76
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(1);
    expect(result.composite).toBeCloseTo(0.35 + 0.35 + 0.06, 10);
  });

  // ── Result structure ─────────────────────────────────────────

  it("returns signals and composite in the result", () => {
    const result = scoreInteraction(makeRecord());

    expect(result).toHaveProperty("signals");
    expect(result).toHaveProperty("composite");
    expect(result.signals).toHaveProperty("turnEfficiency");
    expect(result.signals).toHaveProperty("errorFree");
    expect(result.signals).toHaveProperty("noRetry");
    expect(typeof result.composite).toBe("number");
    expect(typeof result.signals.turnEfficiency).toBe("number");
    expect(typeof result.signals.errorFree).toBe("number");
    expect(typeof result.signals.noRetry).toBe("number");
  });
});
