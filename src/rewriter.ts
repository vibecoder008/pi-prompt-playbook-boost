/**
 * LLM-powered prompt rewriter — Uses the active model to improve user prompts
 * based on the project playbook context.
 *
 * Instead of static template prefixes, this module makes a real LLM call to
 * rewrite the user's prompt incorporating playbook knowledge.
 */

import { complete } from "@mariozechner/pi-ai";
import type { Context, Message } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskIntent } from "./intent";

// ─── Constants ───────────────────────────────────────────────────

const MAX_OUTPUT_TOKENS = 4096;
const REWRITE_TIMEOUT_MS = 30_000;

// ─── System Prompt ───────────────────────────────────────────────

const REWRITER_SYSTEM_PROMPT = `You are a prompt engineering assistant. Your job is to rewrite user prompts to be clearer, more specific, and more actionable for an AI coding agent.

You will receive:
1. A user's original prompt
2. The detected intent (implement, debug, refactor, test, review, explain, general)
3. Relevant sections from the project's playbook (conventions, patterns, rules)

Your task:
- Rewrite the prompt to be clearer, better structured, and more specific
- Incorporate relevant playbook knowledge naturally into the prompt
- Fix typos and grammar issues
- If the prompt has multiple sub-tasks, structure them clearly
- Add relevant context from the playbook (e.g., "use the @/ import alias", "run typecheck after changes")
- Keep the user's original intent and requirements — do NOT add tasks they didn't ask for
- Do NOT add generic boilerplate instructions — only add what's specific and useful from the playbook
- Be concise — improved prompts should be actionable, not verbose
- If the original prompt references files, paths, or screenshots, preserve those exactly

Reply with ONLY the improved prompt text. No explanations, no preamble, no markdown fences around the whole thing.`;

// ─── Intent-Specific Guidance ────────────────────────────────────

const INTENT_GUIDANCE: Record<TaskIntent, string> = {
  implement:
    "This is an implementation task. Structure the rewrite around: what to build, where it goes, " +
    "what it connects to, constraints, and how to verify it works.",
  debug:
    "This is a debugging task. Structure the rewrite to: describe the problem clearly, " +
    "suggest investigation steps, mention known failure patterns from the playbook if relevant.",
  refactor:
    "This is a refactoring task. Emphasize: preserving behavior, improving structure, " +
    "and checking co-change rules for files that must change together.",
  test:
    "This is a testing task. Incorporate: project test conventions, test framework specifics, " +
    "and known failure patterns that tests should cover.",
  review:
    "This is a review task. Structure around: what to check, known anti-patterns, " +
    "and severity-based reporting.",
  explain:
    "This is an explanation request. Keep it focused and reference project structure where helpful.",
  general:
    "This is a general task. Apply relevant conventions and checklist items from the playbook.",
};

// ─── Public API ──────────────────────────────────────────────────

export interface RewriteResult {
  rewrittenPrompt: string;
  model: string;
}

/**
 * Rewrite a user prompt using the active LLM model and playbook context.
 *
 * @param ctx - Extension context (provides model + modelRegistry)
 * @param rawPrompt - The user's original prompt text
 * @param intent - Detected task intent
 * @param playbookContext - The selected playbook sections as formatted text
 * @param signal - Optional abort signal
 * @returns The rewritten prompt, or null if cancelled/failed
 */
export async function rewritePrompt(
  ctx: ExtensionContext,
  rawPrompt: string,
  intent: TaskIntent,
  playbookContext: string,
  signal?: AbortSignal,
): Promise<RewriteResult | null> {
  const model = ctx.model;
  if (!model) {
    throw new Error("No active model available for prompt rewriting.");
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    throw new Error(
      `No API key available for ${model.provider}/${model.id}. Cannot rewrite prompt.`,
    );
  }

  const userContent = [
    `## Original Prompt\n${rawPrompt}`,
    `## Detected Intent: ${intent}`,
    INTENT_GUIDANCE[intent],
    `## Project Playbook Context\n${playbookContext}`,
    `\nRewrite the original prompt incorporating the playbook knowledge. Reply with ONLY the improved prompt.`,
  ].join("\n\n");

  const userMessage: Message = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: userContent }],
  };

  const request: Context = {
    systemPrompt: REWRITER_SYSTEM_PROMPT,
    messages: [userMessage],
  };

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REWRITE_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await complete(model, request, {
      apiKey,
      signal: requestSignal,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

    if (response.stopReason === "aborted") {
      return null;
    }

    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("LLM returned an empty response for prompt rewrite.");
    }

    return {
      rewrittenPrompt: text,
      model: `${model.provider}/${model.id}`,
    };
  } catch (error) {
    if (signal?.aborted) return null;
    if (timeoutController.signal.aborted) {
      throw new Error(
        `Prompt rewrite timed out after ${REWRITE_TIMEOUT_MS / 1000}s. ` +
        `Try again or use /boost-config autosend on to skip rewriting.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
