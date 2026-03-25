import type { InteractionRecord, ScoringResult, ScoringSignals } from "../types";

const WEIGHTS = {
  turnEfficiency: 0.35,
  errorFree: 0.35,
  noRetry: 0.3,
} as const;

/**
 * Score a boosted interaction based on heuristic signals.
 *
 * Signals:
 *   turnEfficiency — exp(-0.3 * max(0, turns - 1))
 *     1 turn = 1.0, 3 turns ~ 0.55, 5 turns ~ 0.30
 *
 *   errorFree — 1.0 if zero tool errors, else 1 - (errors / max(1, totalToolCalls))
 *
 *   noRetry — 1.0 if the user did not retry, 0.2 if retried
 *
 * Composite: weighted average using (0.35, 0.35, 0.30).
 */
export function scoreInteraction(interaction: InteractionRecord): ScoringResult {
  const turnEfficiency = Math.exp(-0.3 * Math.max(0, interaction.turns - 1));

  const errorFree =
    interaction.toolErrors === 0
      ? 1.0
      : 1 - interaction.toolErrors / Math.max(1, interaction.totalToolCalls);

  const noRetry = interaction.retried ? 0.2 : 1.0;

  const signals: ScoringSignals = { turnEfficiency, errorFree, noRetry };

  const composite =
    WEIGHTS.turnEfficiency * signals.turnEfficiency +
    WEIGHTS.errorFree * signals.errorFree +
    WEIGHTS.noRetry * signals.noRetry;

  return { signals, composite };
}
