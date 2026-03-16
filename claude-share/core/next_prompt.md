# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (F.2 COMPLETE, F.5 Codex prompt ready, choosing next Claude task)

---

## Parallel: F.5 — Observability Dashboard (Codex)

**Prompt file:** `claude-share/core/codex-prompts/codex-prompt-F5-dashboard.md`

Adds analytics API endpoints + recharts-powered metrics dashboard to the admin UI.
Aggregates existing R2 learnings/orchestra data. Self-contained Codex task.

---

## Next Claude Task Candidates

### Option A: F.8 — Long-term Memory (MEMORY.md + fact extraction)
**Effort: 8-12h | High strategic value**

Add persistent user memory across sessions:

**What it does:**
- Extract facts from conversations (preferences, project context, recurring topics)
- Store in per-user `MEMORY.md` in R2 (`memory/{userId}/memory.json`)
- Inject relevant memories into system prompt based on conversation topic
- Add `/memory` command to view/edit/clear memories

**Why next:** Extends the existing Phase 3.1 compound learning system (50 learnings + 20 sessions in R2). Currently the bot remembers *what tools worked* but not *what the user cares about*. Memory would make it genuinely personalized.

**Key design decisions:**
1. **Extraction method** — Use a small/fast model (flash) to extract facts after each task, or embed extraction in the system prompt for the task model itself?
2. **Memory format** — Structured JSON facts vs freeform markdown?
3. **Injection strategy** — Include all memories? Top-K by relevance scoring? Category-based filtering?
4. **Privacy** — Should memories be auto-extracted or require user opt-in?

**Key files:**
| File | Purpose |
|------|---------|
| `src/openrouter/learnings.ts` | Existing learning system — extend with memory extraction |
| `src/openrouter/storage.ts` | R2 storage patterns — add memory read/write |
| `src/durable-objects/task-processor.ts:3865-3880` | Post-task learning extraction — add memory extraction here |
| `src/telegram/handler.ts` | Add `/memory` command |

---

### Option B: 6.4 — Calendar/Reminder Tools
**Effort: Medium | User-facing utility**

Add time-based reminders and scheduled messages:
- `/remind 2h Check deployment` — one-shot reminder
- `/remind daily 9am Morning briefing` — recurring
- Use Durable Object alarms for scheduling
- Telegram message delivery on trigger

**Key files:** `src/durable-objects/task-processor.ts` (alarm system exists), `src/telegram/handler.ts`

---

### Option C: 6.5 — Email Integration
**Effort: Medium | New channel**

Add email as an input/output channel via Cloudflare Email Workers:
- Receive emails → process with AI → reply
- Send email summaries of long-running tasks
- Email-to-Telegram forwarding

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-16 | F.2 — Browser CDP (a11y tree, click/fill/scroll, session persistence) | Claude Opus 4.6 | PR #342, 14 new tests, 1798 total |
| 2026-03-16 | Phase 5.6 — Orchestra polish (durationMs, parsing, stale cleanup) | Codex+Claude | PRs 337-339 → compromise |
| 2026-03-16 | Phase 5.4 — Acontext Disk file management (4 tools + hardening) | Codex+Claude | PRs 328-330, 332-334 |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 |
| 2026-03-14 | Orchestra gating fix | Claude Opus 4.6 | Commit d28fcb1 |
