# Prompt Playbook

> How to write prompts that execute correctly on the first pass.
> Based on analysis of **678 commits**, 44 skills, and 13 prompt templates.
>
> **Key stat:** 352 of 678 commits (52%) are fixes or refactors. This playbook exists to shrink that number.

---

## The 5-Part Prompt Structure

Every prompt that shipped clean code followed this pattern — implicitly or explicitly:

### 1. WHAT — Clear Deliverable
State exactly what to build. Be specific about the end result, not the process.

❌ *"Add messaging"*
✅ *"Create a conversation list component that shows the user's active conversations, sorted by last message time, with unread count badges"*

### 2. WHERE — File Locations
Name the files to create or modify. This eliminates guesswork.

✅ *"Create `src/components/messaging/conversation-list.tsx` and add the hook in `src/hooks/use-conversations.ts`"*

### 3. CONNECTS — Integration Points
List every system this feature touches. This is the **#1 predictor of success** — missed integration points caused 28 fix commits (8% of all fixes).

✅ *"This connects to the `conversations` tRPC router, the `useMessagingStore` Zustand store, and needs i18n keys in the `messaging` namespace across all 19 locales"*

### 4. GUARDS — Constraints & Edge Cases
State what must NOT happen, validation rules, auth requirements, and error cases.

✅ *"Only show conversations where the user is a participant. Handle empty state (no conversations yet). Show error state if the query fails. Require authenticated session."*

### 5. VERIFY — Definition of Done
Tell me how to confirm the work is complete.

✅ *"Should pass `bun run typecheck && bun run lint`. Write a unit test. Run /ralph before done."*

---

## The Mandatory Checklist — Add to Every UI Prompt

> These 6 items caused **~180 fix commits** when omitted. Copy-paste this into any UI prompt.

```
## Mandatory
- [ ] Use glass constants from `@/lib/utils` (GLASS_SURFACE, GLASS_PANEL, etc.)
- [ ] Test in BOTH light mode AND dark mode before committing
- [ ] Specify mobile layout at 375px with 44px minimum touch targets
- [ ] Add i18n keys to ALL 19 locales (not just en.json)
- [ ] Floating elements (dropdowns, modals, popovers) use Portal + z-index from layer map
- [ ] Update/create skeleton loading states to match the new UI (skeleton-sync)
```

### Why each item matters (from git history):

| Item | Fix commits it would've prevented | Worst example |
|------|----------------------------------|---------------|
| Glass constants | 52 commits across 5 unification passes | Glass design took 52 commits to converge |
| Light + dark mode | 19 commits | 87% of fix chains included a light-mode patch |
| Mobile layout | 22 commits | Desktop-first with no breakpoint specs |
| i18n all 19 locales | 22 commits | Feature popup missed currency i18n |
| Portal + z-index | 16 commits | Listing overlay z-index stacking nightmare (10 commits) |
| Skeleton sync | 30+ test drift commits | Skeleton overhaul broke 21 test suites |

---

## Prompt Templates (Slash Commands)

Use these instead of writing from scratch. Type the command in the chat:

| Command | Use When | Example |
|---------|----------|---------|
| `/component` | Creating a React component | `/component ConversationList` |
| `/feature` | Implementing a multi-file feature | `/feature user notifications system` |
| `/form` | Building a form with validation | `/form CreateListing` |
| `/layout` | Creating a page or layout | `/layout SettingsPage` |
| `/trpc-router` | Creating an API router | `/trpc-router notifications` |
| `/api-route` | Creating a webhook/external API | `/api-route stripe-webhook` |
| `/migration` | Changing database schema | `/migration add conversations table` |
| `/test` | Writing tests | `/test ConversationList` |
| `/bug-fix` | Fixing a bug | `/bug-fix messages not showing unread count` |
| `/i18n-add` | Adding translation keys | `/i18n-add messaging.noConversations "No conversations yet"` |
| `/review` | Reviewing code for issues | `/review focus on auth checks` |
| `/deploy-check` | Pre-deployment verification | `/deploy-check` |
| `/ralph` | Run verification loop | `/ralph` |

---

## Skill References — When to Cite Which

Mentioning relevant skills in your prompt tells the agent to load detailed patterns. Use this lookup:

### UI & Frontend
| Building... | Cite |
|------------|------|
| Any component | `baseline-ui`, `ui-conventions` |
| Glass surfaces | `ui-conventions` (MANDATORY — all UI uses glass constants) |
| Animations/transitions | `emilkowal-animations` |
| Loading/skeleton states | `skeleton-sync` |
| Accessibility fixes | `fixing-accessibility` |
| Metadata/SEO | `fixing-metadata` |
| React performance | `vercel-react-best-practices` |

### API & Backend
| Building... | Cite |
|------------|------|
| tRPC routers | `trpc-patterns` |
| Input validation | `zod-validation` |
| Database queries | `prisma-patterns` |
| Caching | `redis-caching` |
| Authentication | `nextauth-patterns` |
| Payments | `stripe-best-practices` |

### Quality & Security
| Doing... | Cite |
|----------|------|
| Code review | `tob-differential-review` |
| Security audit | `tob-security-audit`, `tob-insecure-defaults` |
| Timing attacks | `tob-constant-time` |
| Writing tests | `testing-patterns` |
| Code health | `desloppify` |

### Cross-Cutting
| Doing... | Cite |
|----------|------|
| Translations | `i18n-patterns` |
| Next.js patterns | `next-best-practices` |
| Project conventions | `code-conventions` |

---

## Scope Management Rules

Based on analysis of all 678 commits:

### The One-Axis Rule

> **File count does NOT predict risk. Number of concerns does.**

A 168-file commit changing borders everywhere landed clean. A 51-file profile rebuild needed 8 follow-up fixes. The difference: one axis of change vs. many.

| Change Type | Example | Clean Rate |
|------------|---------|------------|
| **One thing, many files** | Standardize borders across 168 files | ~95% |
| **Many things, one area** | Rebuild profile: layout + auth + theme + animation | ~40% |
| **Backend only** | New tRPC router, Prisma query, Redis cache | ~100% |
| **Admin/internal tooling** | Admin panel features (single viewport) | ~100% |
| **Additive UI** | New component that doesn't touch existing UI | ~90% |
| **UI redesign** | Rewrite of existing visual component | ~50% |

### Scope Sizing

| Scope Size | Strategy | Clean Rate |
|-----------|----------|------------|
| **Small** (1-5 files) | Single prompt, no special structure needed | ~99% |
| **Medium** (5-15 files) | Use the 5-part structure + mandatory checklist | ~95% |
| **Large** (15-25 files) | Break into phases by concern, each verified independently | ~75% |
| **Very Large** (30+ files) | Planning prompt first, then phased execution | ~40-50% |

### For Large Features — Phase by Concern, Not by Layer

❌ Bad phasing (layer-based — mixes concerns within each phase):
```
Phase 1: "All backend"
Phase 2: "All frontend"
Phase 3: "All tests"
```

✅ Good phasing (concern-based — one axis per phase):
```
Phase 1: "Prisma schema + migration for conversations"
Phase 2: "tRPC router with CRUD + integration tests"
Phase 3: "Conversation list UI + skeleton + i18n keys"
Phase 4: "Message thread UI + real-time Socket.IO"
Phase 5: "Mobile responsive pass (375px) + dark/light mode verification"
```

### Pattern Matching Wins

When a feature mirrors an existing one, **reference the pattern source**:

✅ *"Add PayPal payments following the same pattern as Stripe in `src/server/trpc/routers/payments.ts`"*

This landed a 29-file change clean because the architecture was already proven.

---

## Fix-After-Feat Hall of Shame

> Learn from the features that generated the most follow-up fixes.

### 🏆 Profile Page — 35+ fix commits, 4 full rebuilds
**What went wrong:** Each rebuild tried to change layout + auth + theming + animation + PII handling simultaneously. Cross-cutting visual redesigns touching 5+ concerns always fail.

**Prevention:** Break redesigns into phases: (1) layout only, (2) auth/data, (3) theming, (4) animation, (5) mobile pass.

### 🥈 CTA Cards — 18 iterations
**What went wrong:** No design spec. Built → looked at it → tweaked → repeat. Star icon alone took 5 commits (opacity, size, overflow, style, position).

**Prevention:** Finalize a design spec (even rough) before coding. "Build and see" loops waste commits.

### 🥉 Feature Popup — 16 commits
**What went wrong:** Calendar styling, currency formatting, i18n keys, slot selection UX, promo code input — each discovered as missing after the initial build.

**Prevention:** List every interactive element and its states (empty, loading, error, disabled, selected) in the prompt.

### Listing Overlay — 10 commits
**What went wrong:** z-index stacking with auth modal, share dialog, and backdrop. Portals weren't used. History pollution from modal open/close.

**Prevention:** Always specify z-index layer for floating UI. Use Portals. Test modal-on-modal interactions.

### Security Hardening — 6 audit rounds, PII found 3 times
**What went wrong:** Security bolted on after features. Parallel branches overwrote fixes. PII exposure re-discovered in rounds 2, 5, and 8.

**Prevention:** Include security constraints in the original feature prompt. Never merge feature branches that skip security middleware.

---

## Common Anti-Patterns to Avoid

### ❌ Vague scope
*"Improve the messaging feature"*
→ Which part? UI? Performance? Add a feature? Fix a bug?

### ❌ Missing integration points
*"Add a reviews component"*
→ Which router? Which store? What auth level? What i18n namespace?

### ❌ Implicit constraints
*"Create a payment form"*
→ Must specify: Stripe integration, PCI compliance, error handling, currency format, refund flow?

### ❌ No verification step
*"Build the admin dashboard"*
→ How do I know it's done? What should pass?

### ❌ Multiple unrelated tasks in one prompt
*"Fix the auth bug and also add the new listing form and update the footer"*
→ Three separate prompts. Each gets a clean commit.

### ❌ "Redesign X" without decomposition
*"Rebuild the profile page"*
→ This prompt caused 35+ fix commits. Break into: layout, data, theming, mobile, animation.

### ❌ Build-and-see design iteration
*"Make the CTA card look better"*
→ 18 commits of tweaking. Provide a spec: dimensions, colors, hover state, icon, typography.

### ❌ Security as afterthought
*"Add the feature now, we'll secure it later"*
→ PII exposure was found in 6 separate audit rounds. Include auth + sanitization in the feature prompt.

---

## Hydration & SSR Rules

> 17 commits fixed hydration mismatches. These rules prevent them.

| Scenario | Fix | Example Commits |
|----------|-----|-----------------|
| Radix UI components with dynamic content | Wrap in `dynamic(() => import(...), { ssr: false })` | `e633504e`, `7dc54ba9` |
| `localStorage`/`window` access | Guard with `typeof window !== 'undefined'` or use `useEffect` | `2739e5f3` |
| Framer Motion `AnimatePresence` | Use `LazyMotion` or CSS animations instead | `e7ca786b`, `36ea04b7` |
| Theme-dependent rendering | Use `next-themes` `useTheme()` with `mounted` check | `2739e5f3` |
| Date/time formatting | Use `suppressHydrationWarning` or format client-side only | — |
| Dropdown/select open state | Radix triggers layout shift → add `overflow-anchor: none` | `7dc54ba9`, `88d92ba6` |

**Rule:** Any component that reads browser state (viewport, localStorage, theme, scroll position) must either be `"use client"` with `useEffect` or `dynamic()` with `ssr: false`.

---

## Docker & Turbopack Gotchas

> 27 commits fixed Docker/Turbopack issues. Avoid them.

| Issue | Symptom | Fix |
|-------|---------|-----|
| **Turbopack cache corruption** | Stale UI, old code still running | `rm -rf .next` and restart |
| **ENOSPC on `.next` tmpfs** | Build fails with disk space error | Cache watchdog or increase tmpfs size |
| **WSL2 file watching** | Changes not detected in Docker | Enable `WATCHPACK_POLLING=true` |
| **Prisma + Turbopack** | Module resolution fails | Add `@prisma/client` to `serverExternalPackages` |
| **New npm packages** | Container has stale `node_modules` | Restart container after `bun install` |
| **Pi extension cache (jiti)** | Old extension code runs after edits | Clear jiti cache: `rm -rf node_modules/.cache/jiti` |
| **HMR blocked by CSP** | Hot reload stops working | Add `ws:` to CSP `connect-src` directive |

**Rule:** After any config change (`next.config.ts`, `prisma/schema.prisma`, `docker-compose.yml`), restart the dev container.

---

## i18n Checklist

> 22 commits fixed i18n gaps. Use this checklist for any feature with user-facing text.

1. **Add keys to ALL 19 locale files** — not just `en.json`
2. **Register new namespaces** in `CLIENT_MESSAGE_PATHS` (in `src/i18n/request.ts`) for client components
3. **Use the correct hook** — `useTranslations('namespace')` client-side, `getTranslations('namespace')` server-side
4. **Pluralization** — use ICU `{count, plural, one {# item} other {# items}}` format
5. **Currency & dates** — use `useFormatter()` from next-intl, never hardcode formats
6. **Verify** — run `/i18n-check` before committing

---

## Security-in-Feature Checklist

> 42 commits (12% of all fixes) were security remediation. Build security in, don't bolt it on.

For **every** feature prompt, include whichever apply:

- [ ] **Auth level**: `publicProcedure` or `protectedProcedure`? Check `ctx.session?.user?.id` in mutations
- [ ] **Input sanitization**: Use `sanitizeHTML()` for any user-provided HTML/text
- [ ] **PII handling**: Encrypt PII at rest with `encryptPII()`. Never log PII. Use explicit Prisma `select` (no `select *`)
- [ ] **Rate limiting**: All state-changing endpoints need rate limits
- [ ] **CSRF**: Non-tRPC state-changing routes need `requireCSRF`
- [ ] **Error messages**: Never leak internal errors to the client — use generic messages

### PII Persistent Offenders
PII exposure was found in **6 separate audit rounds**. The pattern: a new feature query joins a table with email/phone and returns the full object without explicit `select`. Always use:
```typescript
select: { id: true, username: true, image: true } // explicit fields only
```

---

## Test Impact Rules

> 30 commits (8.5%) fixed tests broken by feature changes. These rules prevent test drift.

1. **After changing >5 files**, run `bun run test` — typecheck alone won't catch stale mocks
2. **After changing component props/structure**, update colocated `*.test.tsx` files
3. **After changing tRPC router responses**, update router test mocks in `tests/integration/`
4. **After changing Prisma schema**, update seed fixtures and test factories
5. **After changing skeleton/loading states**, update skeleton test assertions
6. **After security hardening**, expect broken tests — plan 1-2 follow-up commits for test updates

**The cascade pattern:** Security audit → 20-50 findings → 3-5 fix commits → 10-30 broken tests → 2-3 more commits. Budget for it.

---

## Glass Design System — Always Mention for UI Work

> This was the single most-violated convention: **52 fix commits** across **5 unification passes**.

Every UI prompt **must** include:

> *"Use glass design constants from `@/lib/utils`"*

Quick reference:
- `GLASS_SURFACE` — cards, headers, footers, sidebars, panels, tabs, alerts, filter panels
- `GLASS_PANEL` — modals, dialogs, popovers, dropdowns, sheets
- `GLASS_OVERLAY` — backdrops behind popups
- `GLASS_INNER` — nested cards, chat bubbles (no blur)
- `rounded-xl` everywhere (except `rounded-full` for avatars/pills)

**Never use:** `bg-background`, `bg-popover`, `bg-card`, `bg-white`, or inline `backdrop-blur` classes. These were the root cause of 52 unification commits.

---

## AI-Generated Debt Patterns

> Explicitly called out in commit messages — patterns the agent produces that create cleanup work.

| Pattern | Commits to Clean | Prevention |
|---------|-----------------|------------|
| **Verbose JSDoc on every function** | 38+ removals | Don't add JSDoc to obvious functions. Only document non-obvious behavior. |
| **Redundant auth checks** in `protectedProcedure` | 50 removals | `protectedProcedure` already validates auth. Don't re-check `ctx.session`. |
| **Speculative exports** (`export` on internal helpers) | 62 dead-code commits | Only export what's imported elsewhere. Default to non-exported. |
| **Section separator comments** (`// ========`) | 30+ removals | Never add ASCII art dividers or section separators. |
| **Barrel re-exports** (`index.ts` that just re-exports) | 12 dead barrel removals | Only create barrels for public API surfaces with 5+ consumers. |
| **`console.error` in catch blocks** | 15 removals | Use proper error handling. Log server-side only with structured logger. |

---

## Example: Well-Structured Prompt

```
Create a review submission form for marketplace listings.

## Scope
- Create: `src/components/reviews/review-form.tsx`
- Create: `src/lib/validation/review-schema.ts`
- Modify: `src/server/trpc/routers/reviews.ts` (add `create` mutation)
- Modify: `messages/en.json` + all 18 other locales (reviews namespace)

## Integration Points
- tRPC: `reviews.create` protectedProcedure
- Auth: requires authenticated user, cannot review own listing
- i18n: `reviews` namespace, keys for labels + validation errors
- Database: uses existing `Review` model in Prisma schema

## Constraints
- Rating: 1-5 stars, required
- Comment: 10-1000 chars, sanitize with sanitizeHTML()
- One review per user per listing (enforce in mutation)
- Show server errors inline (duplicate review, listing not found)
- PII: explicit `select` on user join — id, username, image only

## Mandatory
- [ ] Glass constants from `@/lib/utils` (form card = GLASS_SURFACE)
- [ ] Light mode AND dark mode tested
- [ ] Mobile layout at 375px, 44px touch targets on stars and submit
- [ ] i18n keys in ALL 19 locales
- [ ] Skeleton loading state matching form layout
- [ ] No verbose JSDoc, no section separators, no barrel exports

## Skills to Use
- zod-validation, trpc-patterns, baseline-ui, fixing-accessibility, i18n-patterns

## Verify
- bun run typecheck && bun run lint
- bun run test (check for stale mocks)
- Write unit test for the form component
- Write integration test for the tRPC mutation
- /ralph before done
```

---

## Changelog

> Auto-updated by the commit skill. Each entry captures a learning from fix-after-feat patterns.

| Date | Learning | Source Commits |
|------|----------|---------------|
| 2026-03-25 | Initial playbook created from analysis of 150 commits, 44 skills, 13 templates | — |
| 2026-03-25 | **Full 678-commit analysis.** Added: Mandatory Checklist (6 items preventing ~180 fixes), Fix-After-Feat Hall of Shame (profile 35+ fixes, CTA 18, feature-popup 16, overlay 10, security 6 rounds), One-Axis Rule (file count ≠ risk; concern count = risk), Hydration/SSR Rules (17 fix commits), Docker/Turbopack Gotchas (27 fix commits), i18n Checklist (22 fix commits), Security-in-Feature Checklist (42 fix commits, PII found 6 times), Test Impact Rules (30 fix commits), AI-Generated Debt Patterns (6 patterns creating ~150 cleanup commits). Updated scope management with real clean-rate data. | All 678 commits analyzed |
| 2026-03-25 | **WebSocket auth flow must be tested end-to-end.** Socket.IO client accepted credentials via `getSocketClient(options)` but no component ever passed them — the socket was never created. Also, `overflow-hidden` on a wrapper must be audited against absolutely-positioned children (reaction bar clipped). When adding real-time features: (1) verify the full credential flow from session → provider → socket init → server auth, (2) verify CSS overflow constraints don't clip floating UI elements. | `99fbde4a` → `4d238b0b` |

---

*Last updated: 2026-03-25 — Based on analysis of all 678 commits in this project's git history.*
