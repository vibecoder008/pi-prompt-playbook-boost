/**
 * pi-boost-prompt v2 — Main extension entry point
 *
 * Learns from project history to optimize prompts.
 *
 * Commands:
 *   /boost first setup   — Scan project, generate playbook
 *   /boost <message>     — Boost and send a prompt
 *   /boost-preview <msg> — Preview without sending
 *   /boost-stats         — Show learning progress
 *   /boost-review        — Review pending playbook updates
 *   /boost-refresh       — Incremental re-scan
 *   /boost-reset         — Delete playbook and start over
 *
 * Install: ln -s /path/to/pi-boost-prompt ~/.pi/agent/extensions/pi-boost-prompt
 * Test:    pi -e /path/to/pi-boost-prompt/src/index.ts
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { BoostState, InteractionRecord, ExecFn } from "./types";
import {
  readPlaybook,
  parsePlaybook,
  selectRelevantSections,
  buildInjectionBlock,
  invalidateCache,
  type PlaybookSection,
} from "./playbook";
import { analyzeGitHistory, getLastCommitHash } from "./setup/git-analyzer";
import { analyzeSessionHistory } from "./setup/session-analyzer";
import { analyzeCodebase } from "./setup/codebase-analyzer";
import { generatePlaybookPrompt, buildAnalysisSummary } from "./setup/playbook-generator";
import { scanNewCommits } from "./learning/commit-scanner";
import { scoreInteraction } from "./learning/scorer";
import { updatePlaybookStats, generateSuggestions, savePendingUpdates, applyUpdate } from "./learning/updater";
import { appendInteraction, readRecentInteractions, getInteractionCount } from "./learning/history";

// ─── Constants ───────────────────────────────────────────────────

const BOOST_DIR_NAME = "boost";

function getBoostDir(cwd: string): string {
  return join(cwd, ".pi", BOOST_DIR_NAME);
}

/** Safely parse JSON, returning null on any error. */
function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Extension ───────────────────────────────────────────────────

export default function boostPromptExtension(pi: ExtensionAPI) {
  // ── Runtime state ──────────────────────────────────────────
  let boostDir = "";
  let state: BoostState | null = null;
  let playbookContent: string | null = null;
  let playbookSections: PlaybookSection[] = [];
  let pendingInjection: string | null = null;
  let currentInteraction: InteractionRecord | null = null;
  let interactionSeq = 0;
  let sessionStartHash: string | null = null;
  let currentSessionId: string | null = null;
  let exec: ExecFn;

  // ── Helpers ────────────────────────────────────────────────

  async function loadState(): Promise<BoostState | null> {
    try {
      const data = await readFile(join(boostDir, "state.json"), "utf-8");
      return safeJsonParse<BoostState>(data);
    } catch {
      return null;
    }
  }

  async function saveState(): Promise<void> {
    if (!state) return;
    state.lastUpdated = new Date().toISOString();
    try {
      await writeFile(join(boostDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Non-critical — state will be rebuilt next session
    }
  }

  async function ensureBoostDir(): Promise<void> {
    await mkdir(boostDir, { recursive: true });
    await mkdir(join(boostDir, "history"), { recursive: true });
  }

  async function reloadPlaybook(): Promise<void> {
    playbookContent = await readPlaybook(boostDir);
    if (playbookContent) {
      playbookSections = parsePlaybook(playbookContent);
    } else {
      playbookSections = [];
    }
  }

  function isSetupComplete(): boolean {
    return state?.setupComplete === true && playbookContent !== null;
  }

  // ── Session Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    boostDir = getBoostDir(ctx.cwd);
    exec = (cmd, args, opts) => pi.exec(cmd, args, opts);

    await ensureBoostDir();
    state = await loadState();
    await reloadPlaybook();

    if (state?.setupComplete && !playbookContent) {
      state.setupComplete = false;
      await saveState();
    }

    // Check for new commits since last session
    if (state?.setupComplete) {
      try {
        const currentHash = await getLastCommitHash(exec);
        sessionStartHash = currentHash;
        if (currentHash && state.lastScanHash && currentHash !== state.lastScanHash) {
          ctx.ui.setStatus("boost", "⚡ Boost (scanning new commits...)");
          const scan = await scanNewCommits(exec, state.lastScanHash);
          if (scan.newFixChains.length > 0) {
            const suggestions = generateSuggestions(scan.newFixChains, [], []);
            if (suggestions.length > 0) {
              await savePendingUpdates(boostDir, suggestions);
              ctx.ui.notify(
                `⚡ Boost detected ${scan.newFixChains.length} fix-after-feature pattern(s). Run /boost-review to see suggestions.`,
                "info",
              );
            }
          }
          state.lastScanHash = scan.newHash;
          await saveState();
        }
      } catch {
        // Not a git repo or git not available — skip
      }
    }

    // Set footer status
    if (isSetupComplete()) {
      ctx.ui.setStatus("boost", "⚡ Boost");
    } else {
      ctx.ui.setStatus("boost", "⚡ Boost (run /boost first setup)");
    }
  });

  pi.on("session_shutdown", async () => {
    if (!state?.setupComplete) return;

    try {
      const recent = await readRecentInteractions(boostDir, 20);
      const sessionInteractions = currentSessionId
        ? recent.filter((r) => r.sessionId === currentSessionId)
        : [];
      const scores = sessionInteractions.map((i) => scoreInteraction(i));

      // Update playbook stats
      if (sessionInteractions.length > 0) {
        await updatePlaybookStats(boostDir, sessionInteractions, scores);
      }

      // Scan for fix commits made during session
      if (sessionStartHash) {
        try {
          const currentHash = await getLastCommitHash(exec);
          if (currentHash && currentHash !== sessionStartHash) {
            const scan = await scanNewCommits(exec, sessionStartHash);
            if (scan.newFixChains.length > 0) {
              const suggestions = generateSuggestions(scan.newFixChains, sessionInteractions, scores);
              if (suggestions.length > 0) {
                await savePendingUpdates(boostDir, suggestions);
              }
            }
            if (state) {
              state.lastScanHash = scan.newHash;
            }
          }
        } catch {
          // Git not available — skip commit scanning
        }
      }

      await saveState();
    } catch {
      // Non-critical — don't block shutdown
    }
  });

  // ── Boost: Input Interception ──────────────────────────────

  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    if (event.source === "extension") return { action: "continue" as const };

    const text = event.text.trim();

    // Setup command
    if (/^\/boost\s+(first\s+)?setup$/i.test(text)) {
      await runSetup(ctx);
      return { action: "handled" as const };
    }

    // Preview command
    const previewMatch = text.match(/^\/boost[\s-]preview\s+(.+)/s);
    if (previewMatch) {
      await runPreview(previewMatch[1].trim(), ctx);
      return { action: "handled" as const };
    }

    // Main boost
    const boostMatch = text.match(/^\/boost\s+(.+)/s);
    if (!boostMatch) return { action: "continue" as const };

    const rawPrompt = boostMatch[1].trim();

    if (!isSetupComplete()) {
      ctx.ui.notify("⚡ No playbook found. Run /boost first setup first.", "warning");
      return { action: "continue" as const };
    }

    // Select relevant sections and prepare injection
    const relevant = selectRelevantSections(playbookSections, rawPrompt);
    pendingInjection = buildInjectionBlock(relevant);

    interactionSeq++;
    if (!currentSessionId) {
      currentSessionId = sessionStartHash ?? `sess_${Date.now()}`;
    }

    currentInteraction = {
      id: `boost_${Date.now()}_${interactionSeq}`,
      timestamp: Date.now(),
      sessionId: currentSessionId,
      promptRaw: rawPrompt,
      sectionsUsed: relevant.map((s) => s.heading),
      turns: 0,
      totalToolCalls: 0,
      toolErrors: 0,
      retried: false,
    };

    // Notify
    const sectionNames = relevant
      .filter((s) => !["Stats", "Project Identity"].includes(s.heading))
      .map((s) => s.heading)
      .slice(0, 3)
      .join(", ");
    ctx.ui.notify(`⚡ Boosted with: ${sectionNames || "playbook defaults"}`, "info");
    ctx.ui.setStatus("boost", `⚡ Boost (${interactionSeq})`);

    // Restructure prompt
    const boostedText = `Following the project playbook in <boost-context>, implement the following task.
Apply the WHAT/WHERE/CONNECTS/GUARDS/VERIFY structure from the playbook.
Follow all mandatory checklist items and project conventions listed in <boost-context>.

Task: ${rawPrompt}`;

    return { action: "transform" as const, text: boostedText };
  });

  // ── System Prompt Injection ────────────────────────────────

  pi.on("before_agent_start", async (event: any, _ctx: ExtensionContext) => {
    if (!pendingInjection) return undefined;

    const injection = pendingInjection;
    pendingInjection = null; // One-shot

    return { systemPrompt: event.systemPrompt + "\n\n" + injection };
  });

  // ── Telemetry ──────────────────────────────────────────────

  pi.on("turn_end", async (_event: any, _ctx: ExtensionContext) => {
    if (currentInteraction) currentInteraction.turns++;
  });

  pi.on("tool_result", async (event: any, _ctx: ExtensionContext) => {
    if (!currentInteraction) return;
    currentInteraction.totalToolCalls++;
    if (event.isError) currentInteraction.toolErrors++;
  });

  pi.on("agent_end", async (_event: any, _ctx: ExtensionContext) => {
    const interaction = currentInteraction;
    currentInteraction = null;

    if (!interaction || !state?.setupComplete) return;

    // Persist interaction (async, non-blocking for next interaction)
    try {
      await appendInteraction(boostDir, interaction);
      if (state) {
        state.interactionCount++;
        await saveState();
      }
    } catch {
      // Non-critical — interaction data lost but extension continues
    }
  });

  // ── Commands ───────────────────────────────────────────────

  pi.registerCommand("boost-stats", {
    description: "Show boost learning progress and playbook stats",
    handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
      if (!isSetupComplete()) {
        ctx.ui.notify("⚡ No playbook found. Run /boost first setup first.", "warning");
        return;
      }

      const count = await getInteractionCount(boostDir);
      const recent = await readRecentInteractions(boostDir, 50);
      const scores = recent.map((i) => scoreInteraction(i));
      const avgScore = scores.length > 0
        ? scores.reduce((sum, s) => sum + s.composite, 0) / scores.length
        : 0;
      const successCount = scores.filter((s) => s.composite >= 0.7).length;
      const successRate = scores.length > 0 ? (successCount / scores.length) * 100 : 0;

      let pendingCount = 0;
      try {
        const raw = await readFile(join(boostDir, "pending-updates.json"), "utf-8");
        const parsed = safeJsonParse<any[]>(raw);
        pendingCount = Array.isArray(parsed) ? parsed.length : 0;
      } catch { /* no pending updates file */ }

      const lines = [
        "",
        "  ⚡ Boost Stats",
        `  ${"─".repeat(40)}`,
        `  Total boosted prompts:    ${count}`,
        `  Avg composite score:      ${(avgScore * 100).toFixed(1)}%`,
        `  First-attempt success:    ${successRate.toFixed(0)}% (score ≥ 70%)`,
        `  Pending playbook updates: ${pendingCount}`,
        `  Playbook sections:        ${playbookSections.length}`,
        "",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("boost-review", {
    description: "Review pending playbook update suggestions",
    handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
      let updates: any[] = [];
      try {
        const raw = await readFile(join(boostDir, "pending-updates.json"), "utf-8");
        const parsed = safeJsonParse<any[]>(raw);
        updates = Array.isArray(parsed) ? parsed : [];
      } catch {
        ctx.ui.notify("⚡ No pending updates.", "info");
        return;
      }

      if (updates.length === 0) {
        ctx.ui.notify("⚡ No pending updates.", "info");
        return;
      }

      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        const lines = [
          `${update.type?.toUpperCase() ?? "UPDATE"}: ${update.section ?? "unknown"}`,
          "",
          update.content ?? "(no content)",
          "",
          `Evidence: ${update.evidence ?? "none"}`,
          `Confidence: ${update.confidence ? (update.confidence * 100).toFixed(0) + "%" : "unknown"}`,
        ];

        const accept = await ctx.ui.confirm(
          `⚡ Playbook Update (${i + 1}/${updates.length})`,
          lines.join("\n"),
        );

        try {
          await applyUpdate(boostDir, update, accept ? "accept" : "reject");
        } catch (e) {
          ctx.ui.notify(`⚡ Failed to apply update: ${e}`, "error");
        }
      }

      await reloadPlaybook();
      ctx.ui.notify("⚡ Review complete. Playbook updated.", "success");
    },
  });

  pi.registerCommand("boost-refresh", {
    description: "Incremental re-scan of project for new patterns",
    handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
      if (!state?.setupComplete) {
        ctx.ui.notify("⚡ No playbook found. Run /boost first setup first.", "warning");
        return;
      }

      ctx.ui.notify("⚡ Refreshing — scanning for new patterns...", "info");

      try {
        const gitResult = await analyzeGitHistory(exec, 500);
        const codeResult = await analyzeCodebase(ctx.cwd, exec);

        const sessionsDir = join(ctx.cwd, ".pi", "sessions");
        const sessionResult = await analyzeSessionHistory(sessionsDir);

        const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);
        const summary = buildAnalysisSummary(gitResult, sessionResult, codeResult);

        await ctx.waitForIdle();
        pi.sendUserMessage(
          `Regenerate my project playbook based on this updated analysis. ` +
          `Keep any manually added rules from the existing playbook at ${join(boostDir, "playbook.md")}. ` +
          `Write the updated playbook to that file.\n\n${prompt}`,
        );

        ctx.ui.notify(`⚡ Refresh analysis:\n${summary}`, "info");

        const hash = await getLastCommitHash(exec);
        if (hash && state) {
          state.lastScanHash = hash;
          await saveState();
        }
      } catch (e) {
        ctx.ui.notify(`⚡ Refresh failed: ${e}`, "error");
      }
    },
  });

  pi.registerCommand("boost-reset", {
    description: "Delete playbook and all boost data",
    handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
      const ok = await ctx.ui.confirm(
        "⚡ Reset Boost",
        "This will delete your playbook, all learned patterns, and interaction history. Continue?",
      );
      if (!ok) return;

      try {
        await rm(boostDir, { recursive: true, force: true });
        await ensureBoostDir();
        state = null;
        playbookContent = null;
        playbookSections = [];
        currentSessionId = null;
        invalidateCache();
        ctx.ui.notify("⚡ Boost data cleared. Run /boost first setup to start over.", "info");
        ctx.ui.setStatus("boost", "⚡ Boost (run /boost first setup)");
      } catch (e) {
        ctx.ui.notify(`⚡ Reset failed: ${e}`, "error");
      }
    },
  });

  // ── Setup ──────────────────────────────────────────────────

  async function runSetup(ctx: ExtensionContext): Promise<void> {
    ctx.ui.notify("⚡ Starting project analysis...", "info");

    await ensureBoostDir();

    // Privacy prompt
    const shareWithTeam = await ctx.ui.confirm(
      "⚡ Share playbook with team?",
      "If yes: playbook.md will be ready to commit to git.\nIf no: .pi/boost/ will be added to .gitignore.",
    );

    // Phase 1: Instant scan (codebase + recent git)
    ctx.ui.setStatus("boost", "⚡ Boost (scanning codebase...)");
    const codeResult = await analyzeCodebase(ctx.cwd, exec);

    ctx.ui.setStatus("boost", "⚡ Boost (scanning git history...)");
    let gitResult;
    try {
      gitResult = await analyzeGitHistory(exec, 200);
    } catch {
      gitResult = null;
    }

    ctx.ui.setStatus("boost", "⚡ Boost (scanning pi sessions...)");
    let sessionResult;
    try {
      const sessionsDir = join(ctx.cwd, ".pi", "sessions");
      sessionResult = await analyzeSessionHistory(sessionsDir);
    } catch {
      sessionResult = null;
    }

    // Build analysis summary
    const summary = buildAnalysisSummary(gitResult, sessionResult, codeResult);
    ctx.ui.notify(`⚡ Analysis complete:\n${summary}`, "info");

    const hash = gitResult ? await getLastCommitHash(exec) : null;
    state = {
      lastScanHash: hash ?? "",
      interactionCount: 0,
      shareWithTeam,
      lastUpdated: new Date().toISOString(),
      setupComplete: false,
    };
    await saveState();

    // Generate playbook via LLM
    ctx.ui.setStatus("boost", "⚡ Boost (generating playbook...)");
    const prompt = generatePlaybookPrompt(gitResult, sessionResult, codeResult);

    pi.sendUserMessage(
      `Generate my project playbook and write it to ${join(boostDir, "playbook.md")}.\n\n${prompt}`,
    );

    // Configure .gitignore if not sharing
    if (!shareWithTeam) {
      try {
        const gitignorePath = join(ctx.cwd, ".gitignore");
        let existing = "";
        try {
          existing = await readFile(gitignorePath, "utf-8");
        } catch { /* no .gitignore yet */ }
        if (!existing.includes(".pi/boost/")) {
          await writeFile(gitignorePath, existing.trimEnd() + "\n.pi/boost/\n", "utf-8");
        }
      } catch { /* non-critical */ }
    }

    ctx.ui.setStatus("boost", "⚡ Boost (waiting for playbook...)");

    // Poll until the LLM writes the playbook via the Write tool
    const checkPlaybook = async () => {
      for (let i = 0; i < 60; i++) { // Check for up to 5 minutes
        await new Promise((r) => setTimeout(r, 5000));
        await reloadPlaybook();
        if (playbookContent) {
          if (state) {
            state.setupComplete = true;
            await saveState();
          }
          ctx.ui.setStatus("boost", "⚡ Boost");
          ctx.ui.notify("⚡ Playbook ready! Use /boost <message> to start.", "success");
          return;
        }
      }
      // Timeout — playbook never appeared
      ctx.ui.notify("⚡ Playbook generation timed out. Try /boost first setup again.", "warning");
      ctx.ui.setStatus("boost", "⚡ Boost (run /boost first setup)");
    };

    // Run check in background (don't block the command)
    checkPlaybook().catch(() => {});
  }

  async function runPreview(rawPrompt: string, ctx: ExtensionContext): Promise<void> {
    if (!isSetupComplete()) {
      ctx.ui.notify("⚡ No playbook found. Run /boost first setup first.", "warning");
      return;
    }

    const relevant = selectRelevantSections(playbookSections, rawPrompt);
    const injection = buildInjectionBlock(relevant);

    const lines = [
      "",
      "  ⚡ Boost Preview",
      `  ${"─".repeat(40)}`,
      `  Sections injected (${relevant.length}):`,
      ...relevant.map((s) => `    • ${s.heading}`),
      "",
      `  ── Injection size: ${injection.length} chars ──`,
      "",
      `  ── Restructured prompt ──`,
      `  Following the project playbook in <boost-context>,`,
      `  implement the following task.`,
      `  Apply the WHAT/WHERE/CONNECTS/GUARDS/VERIFY structure.`,
      "",
      `  Task: ${rawPrompt}`,
      "",
    ];

    ctx.ui.notify(lines.join("\n"), "info");
  }
}
