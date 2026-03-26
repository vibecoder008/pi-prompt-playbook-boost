# ⚡ pi-prompt-playbook-boost

**Make your AI coding assistant actually understand your project.**

## What does this do?

When you ask an AI to write code, it doesn't know anything about *your* project — your file structure, your coding style, or the mistakes that keep happening. You end up repeating yourself every time.

This extension fixes that. It scans your project once, builds a cheat sheet (called a **playbook**), and when you use `/boost`, an LLM rewrites your prompt to be clearer and better structured using that playbook knowledge. You see the rewritten prompt and the selected context right in the editor before anything is sent, so you're always in control.

### Before boost

```
You type:  add a payment form with Stripe
AI sees:   just your message — knows nothing about your project
```

### After boost

```
You type:  /boost add a payment form with Stripe

Your editor shows:
  ✦ A rewritten prompt — clearer, better structured, informed by your playbook
  ✦ A visible <boost-context> block with the relevant playbook sections:
      your tech stack, coding rules, linter settings, co-change rules,
      known failure patterns, and anything else that applies

You review everything, tweak if you want, then hit Enter.
```

---

## Install

```bash
pi install https://github.com/vibecoder008/pi-prompt-playbook-boost
```

Restart pi and you're ready to go.

---

## Quick Start

### Step 1: Set up your playbook

Run this command once. It scans your project and creates the playbook:

```
/boost-first-setup
```

This takes about 30 seconds. When it's done, you'll see something like this:

> **This is just an example** — your output will show your actual project info.

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

**What does "200 commits analyzed" mean?**
By default, the setup scans your last 200 git commits to find patterns. If you want to scan *every* commit in your project, use `/boost-full-scan` after setup (see [Commands](#commands)).

**What are "fix-after-feature chains"?**
These are times when someone made a commit and then had to quickly fix it within 24 hours. For example: you add a new feature, then 2 hours later you commit a "fix typo" or "oops forgot to update X". The extension finds these patterns so the AI can avoid making the same mistakes.

### Step 2: Use it

Just add `/boost` before any message:

```
/boost add a settings page with user preferences
```

The extension makes a quick LLM call to rewrite your prompt using playbook knowledge. Then it puts the result in your editor so you can review it before sending:

```
⚡ Boosted with: Conventions, Co-Change Rules, Known Failure Patterns
   Review the prompt, then press Enter to send. Ctrl+Shift+X to revert.
```

Here's what your editor might look like after boosting:

```
Create a user preferences settings page at src/app/settings/page.tsx.
Use the existing AppLayout wrapper and follow the form pattern in
src/components/forms/. Validate inputs with zod. Use the AppError class
for error handling. Run `npm test` before considering it done.

<boost-context>
## Conventions
- Use `@/` import aliases
- All errors go through the `AppError` class
- Forms use zod for validation

## Co-Change Rules
- When adding a new page, also update src/app/routes.ts

## Known Failure Patterns
- Settings pages often forget to handle the "loading" state
</boost-context>
```

The rewritten prompt at the top is what the LLM produced from your original message plus the playbook. The `<boost-context>` block shows exactly which playbook sections were included. Both are visible and editable.

- **Press Enter** — send the boosted prompt
- **Edit it first** — tweak the rewritten prompt or the context before sending
- **Press `Ctrl+Shift+X`** — go back to your original prompt

### Step 3: That's it

The extension learns in the background as you work. It watches for new patterns and suggests playbook updates over time.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/boost-first-setup` | **First-time setup.** Scans your project and creates a playbook. Run this once. |
| `/boost <message>` | **Boost a prompt.** Rewrites your message with project knowledge. |
| `/boost-preview <msg>` | **Preview only.** See what would be added to your prompt without sending it. |
| `/boost-full-scan` | **Deep scan.** Scans ALL commits in your project (not just the last 200). Use this if you want the most complete analysis. Can take a while on big projects. |
| `/boost-refresh` | **Update.** Re-scans your project for new patterns since last scan (last 500 commits). |
| `/boost-stats` | **Stats.** Shows how well your boosted prompts are working. |
| `/boost-review` | **Review suggestions.** Accept or reject playbook changes the extension has found. |
| `/boost-config` | **Settings.** Configure boost behavior (e.g., auto-send mode). |
| `/boost-history` | **History.** See your recent boosted prompts. |
| `/boost-reset` | **Start over.** Deletes everything so you can re-do setup from scratch. |

---

## How It Works

```
┌─────────────────────┐
│  /boost <message>   │
└─────────┬───────────┘
          │
          ▼
┌───────────────────────────────────────────────────────┐
│  1. Load your playbook                                │
│  2. LLM rewrites your prompt using playbook knowledge │
│  3. Rewritten prompt + <boost-context> shown in editor│
│  4. You review, edit if needed, then send             │
└───────────────────────────────────────────────────────┘
```

### What's in the playbook?

The playbook is a file at `.pi/boost/playbook.md`. You can open it, edit it, and share it with your team. Here's what each section means:

| Section | What it means (in plain English) |
|---------|--------------------------------|
| **Project Identity** | "This project uses React, Prisma, and Tailwind. Tests are in `/tests`." |
| **Conventions** | "We use `@/` import aliases. Errors go through the `AppError` class." |
| **Co-Change Rules** | "When you change `schema.prisma`, you also need to update `types.ts`." |
| **Failure Patterns** | "People keep forgetting to add error handling in API routes." |
| **Anti-Patterns** | "Don't use `any` type. Don't skip validation." |
| **Success Patterns** | "Things that worked on the first try — follow these approaches." |
| **Mandatory Checklist** | "Always run `npm test` before committing. Always check types." |

### What gets scanned during setup?

| What | Details |
|------|---------|
| **Your code** | `package.json`, `tsconfig.json`, folder structure, config files |
| **Linter / formatter** | ESLint, Biome, or Prettier settings — so the AI follows your style |
| **CI/CD** | GitHub Actions, GitLab CI — so the AI knows how to verify its work |
| **Git history** | Last 200 commit messages, which files changed together, fix patterns (**no actual code from diffs**) |
| **Past pi sessions** | How previous prompts went — retries, errors, what worked |
| **Existing AI rules** | `CLAUDE.md`, `.cursorrules`, `AGENTS.md` — rules you already wrote |
| **Project docs** | `CONTRIBUTING.md`, `ARCHITECTURE.md` |
| **Env variable names** | Names only from `.env.example` (like `STRIPE_KEY`) — **never the actual secret values** |

---

## Learning — How It Gets Smarter

The extension improves over time without you doing anything.

### After every session

It checks:
- How many back-and-forth turns did each task take? (fewer = the AI got it right faster)
- Were there tool errors?
- Did you have to rephrase or retry?

### On every session start

It checks:
- Are there new git commits since last time?
- Did anyone commit a quick fix right after a feature? (a "fix-after-feature chain")
- If yes, it queues a suggestion to update the playbook

### You stay in control

Suggestions are **never auto-applied**. Run `/boost-review` to see them and accept or reject each one:

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

This works with most popular tech stacks:

| Language | Frameworks | ORMs |
|----------|-----------|------|
| TypeScript / JavaScript | Next.js, Nuxt, Remix, Angular, SvelteKit, Vue, React, Express, Fastify, Hono, Astro, SolidJS | Prisma, Drizzle, TypeORM, Sequelize, Knex, Mongoose |
| Python | Django, Flask, FastAPI | SQLAlchemy |
| Rust | Actix, Axum, Rocket | — |
| Go | Gin, Fiber, Echo | — |

Also detects: Tailwind · CSS-in-JS · Sass · Zustand · Redux · Jotai · MobX · Pinia · TanStack Query · Vitest · Jest · Playwright · Cypress · pytest · bun · pnpm · yarn · npm

**Don't see your stack?** It still works — the playbook starts from whatever the extension can find and grows as you use it.

---

## Privacy — What Gets Sent to the AI

When you run `/boost-first-setup`, the extension sends project info to your AI provider (the same one pi already uses) to generate the playbook. **No other services are involved.**

### What the AI receives

| Data | What this reveals about your project |
|------|--------------------------------------|
| Git commit messages | What your team has been working on, who works on what |
| Config files (`package.json`, `tsconfig.json`, etc.) | Your tech stack, dependencies, project structure |
| CI/CD workflow files | How you test and deploy |
| Existing AI rules (`CLAUDE.md`, etc.) | Your coding conventions |
| Project docs (`CONTRIBUTING.md`, etc.) | Internal architecture and guidelines |
| Env variable **names** from `.env.example` | Which services you use (e.g., Stripe, AWS) |

### What is NOT sent

- ❌ **No secret values** — only reads `.env.example`, never `.env` or `.env.local`
- ❌ **No source code** — git analysis uses commit messages only, never code diffs
- ❌ **No data to third parties** — everything goes to your existing pi AI provider

---

## File Structure

Everything the extension creates lives in `.pi/boost/` inside your project:

```
.pi/boost/
├── playbook.md           ← Your playbook (you can edit and commit this)
├── state.json            ← Internal tracking (last scan hash, counters)
├── pending-updates.json  ← Suggestions waiting for your review
└── history/
    └── sessions.jsonl    ← Log of your boosted prompts
```

---

## FAQ

**Does this cost extra money?**
A little. Setup makes one LLM call to create the playbook. Each `/boost` makes one additional LLM call to rewrite your prompt. These rewrite calls are short and cheap — typically just a few hundred tokens — but they're not free. For most usage, the cost is negligible.

**My project has no git history. Does it still work?**
Yes. It builds the playbook from your code and config files alone. Git patterns fill in as you make commits.

**Can I edit the playbook myself?**
Yes! It's just a Markdown file. Add your own rules, remove sections, change anything. Your edits are kept when you run `/boost-refresh`.

**Can my whole team use the same playbook?**
Yes. During setup it asks if you want to share with your team. If yes, commit `playbook.md` to git and everyone gets the same project knowledge.

**I want to scan all commits, not just 200.**
Run `/boost-full-scan`. It scans every commit in your project history. This gives you the most complete analysis but takes longer on big repos.

**How do I start over?**
Run `/boost-reset` to delete everything, then `/boost-first-setup` to start fresh.

---

## License

MIT
