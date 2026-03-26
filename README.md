# ⚡ pi-prompt-playbook-boost

**Make your AI coding agent actually understand your project.**

pi-prompt-playbook-boost scans your codebase, git history, and past sessions to build a *playbook* — a living document of your project's conventions, failure patterns, and structure. Every time you use `/boost`, that knowledge is injected into your prompt automatically. No extra API calls. No extra cost.

```
You type:     /boost add a payment form with Stripe

What the AI sees:
  ✦ Your tech stack (React, Prisma, Tailwind...)
  ✦ Your project conventions (import aliases, error handling patterns...)
  ✦ Your linter and formatter rules
  ✦ Your CI pipeline and verification commands
  ✦ Files that always change together
  ✦ Mistakes the AI keeps making in your project
  ✦ A structured prompt format that works for your codebase
```

---

## Install

```bash
pi install https://github.com/vibecoder008/pi-prompt-playbook-boost
```

That's it. Restart pi and the extension is active.

---

## Quick Start

### 1. Generate your playbook

```
/boost-first-setup
```

The extension scans your project and asks the AI to write a playbook tailored to your codebase. Takes about 30 seconds.

```
⚡ Analysis complete:
• Tech stack: TypeScript, Next.js, Prisma, Tailwind CSS
• Linter: ESLint
• 200 commits analyzed → 23 fix-after-feature chains found
• 8 pi sessions → 45 prompts analyzed
• 2 CI workflow(s) detected
• 14 environment variables from .env.example
• Project docs found: CONTRIBUTING.md, ARCHITECTURE.md
• Existing rules imported from: CLAUDE.md

⚡ Playbook ready! Use /boost <message> to start.
```

### 2. Use it

```
/boost add a settings page with user preferences
```

The extension rewrites your prompt and puts it in the editor for you to review:

```
⚡ Boosted with: Conventions, Co-Change Rules, Known Failure Patterns
   Review the prompt, then press Enter to send. Ctrl+Shift+X to revert.
```

- **Press Enter** to send the boosted prompt
- **Edit the prompt** first if you want to tweak it
- **Press `Ctrl+Shift+X`** to revert to your original prompt

### 3. That's it

The extension learns in the background. It tracks what works, detects fix-after-feature patterns in your commits, and suggests playbook updates over time.

---

## How It Works

```
┌─────────────────────┐
│  /boost <message>   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────────────────────────┐
│  1. Load playbook (.pi/boost/playbook.md)│
│  2. Pick relevant sections for prompt    │
│  3. Inject into system prompt            │
│  4. Restructure user message             │
│  5. Send to AI (normal call, no extra)   │
└─────────────────────────────────────────┘
```

**No extra LLM calls.** The playbook is injected as context into the system prompt the AI already reads. Your normal agent call just has better context — at zero additional cost.

### What the playbook contains

The playbook is a Markdown file at `.pi/boost/playbook.md`. You can read it, edit it, and commit it to git.

| Section | What's in it | Where it comes from |
|---------|-------------|-------------------|
| **Project Identity** | Stack, framework, test runner, key dirs | `package.json`, config files |
| **Prompt Structure** | WHAT / WHERE / CONNECTS / GUARDS / VERIFY | Best practice template |
| **Mandatory Checklist** | Things the AI must not forget | Fix-after-feature commits |
| **Conventions** | Import aliases, linter rules, error handling | Codebase, linter config, `tsconfig.json` paths |
| **Co-Change Rules** | "When you touch X, also update Y" | Git file coupling analysis |
| **Failure Patterns** | Common mistakes in this project | Git fix chains |
| **Anti-Patterns** | Things the AI specifically gets wrong | Session retry analysis |
| **Success Patterns** | What works on the first attempt | Clean commit analysis |

### What gets scanned during setup

| Source | What's extracted |
|--------|-----------------|
| **Codebase** | `package.json`, `tsconfig.json` (including path aliases), directory structure, file patterns |
| **Linter / formatter config** | ESLint, Biome, or Prettier config — so the AI follows your style rules |
| **CI workflows** | `.github/workflows/*.yml`, `.gitlab-ci.yml` — exact verification commands |
| **Environment variables** | Variable names from `.env.example` (names only, never values) |
| **Git history** | Last 200 commits, fix-after-feature chains, file coupling |
| **Past pi sessions** | Prompt patterns, retries, tool errors |
| **Existing AI rules** | CLAUDE.md, .cursorrules, AGENTS.md, Copilot instructions |
| **Project documentation** | CONTRIBUTING.md, ARCHITECTURE.md |

---

## Commands

| Command | What it does |
|---------|-------------|
| `/boost-first-setup` | Scan your project and generate a playbook |
| `/boost <message>` | Rewrite prompt and put in editor for review — Enter to send |
| `/boost-preview <msg>` | See what would be injected without sending |
| `/boost-stats` | View success rates and interaction metrics |
| `/boost-review` | Accept or reject suggested playbook updates |
| `/boost-refresh` | Re-scan your project for new patterns |
| `/boost-reset` | Delete everything and start fresh |

---

## Learning

The extension gets smarter as you work.

**After every session**, it checks:
- How many turns did each task take? (fewer = better)
- Were there tool errors?
- Did you have to retry or rephrase?

**On every session start**, it checks:
- Were there new commits since last time?
- Did any "fix" commits follow a feature commit on the same files?
- If so, it queues a suggestion to update the playbook.

**You stay in control.** Suggestions are never auto-applied. Run `/boost-review` to accept or reject them:

```
⚡ Playbook Update (1/3)
NEW_RULE: known_failure_patterns

When modifying src/server/trpc/routers/payments.ts, also check related files.

Evidence: Commit a1b2c3d fixed same files within 2.5h of feature commit
Confidence: 65%

[Accept] [Reject]
```

---

## Supported Stacks

| Language | Frameworks | ORMs |
|----------|-----------|------|
| TypeScript / JavaScript | Next.js, Nuxt, Remix, Angular, SvelteKit, Vue, React, Express, Fastify, Hono, Astro, SolidJS | Prisma, Drizzle, TypeORM, Sequelize, Knex, Mongoose |
| Python | Django, Flask, FastAPI | SQLAlchemy |
| Rust | Actix, Axum, Rocket | — |
| Go | Gin, Fiber, Echo | — |

Also detects: Tailwind · CSS-in-JS · Sass · Zustand · Redux · Jotai · MobX · Pinia · TanStack Query · Vitest · Jest · Playwright · Cypress · pytest · bun · pnpm · yarn · npm

Works with any project — the playbook starts from whatever the extension can find and grows as you use it.

---

## Privacy & Security

- **`.env.example` only** — the extension reads variable *names* from `.env.example` to know what env vars exist. It never reads `.env`, `.env.local`, or any file containing actual secrets.
- **No git diffs** — git analysis uses only commit metadata (messages, file names, timestamps). It never reads diff content, which could contain removed secrets.
- **Your choice to share** — during setup you choose whether to commit the playbook to git or keep it private.

---

## File Structure

Everything lives inside your project at `.pi/boost/`:

```
.pi/boost/
├── playbook.md           ← The playbook (edit this, commit it, share it)
├── state.json            ← Internal state (last scan hash, counters)
├── pending-updates.json  ← Queued suggestions awaiting review
└── history/
    └── sessions.jsonl    ← Interaction log (not committed)
```

---

## FAQ

**Does this cost extra?**
No. Setup makes one LLM call to generate the playbook. After that, `/boost` adds context to your existing prompt — no additional API calls.

**What if my project has no git history?**
It still works. The playbook generates from your codebase alone. Failure patterns and co-change rules fill in as you accumulate commits.

**Can I edit the playbook?**
Yes. It's a Markdown file you own. Add rules, remove sections, tweak conventions — your edits are preserved across refreshes.

**Can my team use the same playbook?**
Yes. Commit `playbook.md` to git and everyone benefits from the same project knowledge.

**How do I start over?**
Run `/boost-reset` to delete everything, then `/boost-first-setup` to regenerate.

---

## License

MIT
