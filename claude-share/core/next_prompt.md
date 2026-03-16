# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (Phase 5 COMPLETE, 5.6 merged, all 6 sub-phases done)

---

## Phase 5 — COMPLETE

All Phase 5 tasks are done (5.1-5.6). 1785 tests passing.

---

## Next Task Candidates

Pick based on what's unblocked and highest value. Recommended order:

### Option A: F.2 — Browser Tool Enhancement (CDP)
**Best for: Claude Code (design-heavy, touches multiple files)**

Enhance the existing `browse_url` tool with Cloudflare Browser Rendering CDP protocol:
- Add a11y tree extraction (structured page content without full HTML)
- Add click/fill/scroll actions for interactive pages
- Add screenshot capture as tool output

**Why next:** `BROWSER` binding already exists. The current `browse_url` is fetch-based (no JS rendering). CDP would unlock real browser automation — form filling, SPA navigation, login flows. High user value.

**Key files:**
- `src/openrouter/tools.ts` — current `browse_url` tool (fetch-based)
- `src/gateway/process.ts` — sandbox container management
- `wrangler.jsonc` — `BROWSER` binding already configured
- `src/durable-objects/task-processor.ts` — tool context wiring

**Effort:** 4-6h | **Codex-friendly:** Partially (core CDP client yes, UX design no)

---

### Option B: F.8 — Long-term Memory (MEMORY.md + fact extraction)
**Best for: Claude Code (architectural, extends existing learnings system)**

Add persistent user memory beyond the current session-scoped learnings:
- Extract facts from conversations (preferences, project context, recurring topics)
- Store in per-user `MEMORY.md` in R2
- Inject relevant memories into system prompt based on conversation topic
- Add `/memory` command to view/edit/clear memories

**Why next:** Extends the existing Phase 3.1 compound learning system. Would make the bot genuinely personalized across sessions.

**Key files:**
- `src/openrouter/storage.ts` — existing R2 learning storage
- `src/durable-objects/task-processor.ts` — learning extraction (lines 3865-3880)
- `src/telegram/handler.ts` — command handling

**Effort:** 8-12h | **Codex-friendly:** Partially (storage yes, extraction prompts no)

---

### Option C: F.5 — Observability Dashboard Enhancement
**Best for: Codex (self-contained frontend + API work)**

Enhance the admin dashboard with:
- Acontext session replay (view tool calls, model responses, timing)
- Success/failure rates per model
- Cost breakdown charts
- Orchestra task timeline view

**Key files:**
- `src/client/App.tsx` — existing admin dashboard
- `src/routes/admin.ts` — admin API routes

**Effort:** 4-6h | **Codex-friendly:** Yes (mostly frontend + API)

---

### Option D: F.1 — ai-hub Data Feeds
**Status: BLOCKED** on ai-hub `/api/situation/*` endpoints being live.

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-16 | Phase 5.6 — Orchestra polish (durationMs, parsing, stale cleanup) | Codex+Claude | PRs 337-339 → compromise |
| 2026-03-16 | Phase 5.4 — Acontext Disk file management (4 tools + hardening) | Codex+Claude | PRs 328-330, 332-334 → compromise |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 → compromise |
| 2026-03-14 | Orchestra gating fix | Claude Opus 4.6 | Commit d28fcb1 |
| 2026-03-10 | Orchestra diffs PR merged | Claude Opus 4.6 | Commit a888455 |
| 2026-03-08 | Post-execution extraction verifier | Claude Opus 4.6 | Commit 675ef49 |
| 2026-02-23 | 5.1: Multi-Agent Review (1458 tests) | Claude Opus 4.6 | Phase 5.1 complete |
| 2026-02-23 | Phase 7 ALL 10 tasks complete (1411 tests) | Claude Opus 4.6 | Phase 7 complete |
| 2026-03-01 | Phase 8 Operational Hardening (1526 tests) | Claude Opus 4.6 | 38 tasks |
