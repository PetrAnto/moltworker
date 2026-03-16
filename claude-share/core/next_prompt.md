# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (F.2 + F.5 COMPLETE, choosing next task)

---

## Next Task Candidates

### Option A: F.8 — Long-term Memory (MEMORY.md + fact extraction)
**Best for: Claude Code | Effort: 8-12h | Highest strategic value**

Add persistent user memory across sessions:
- Extract facts from conversations (preferences, project context, recurring topics)
- Store in per-user R2 (`memory/{userId}/memory.json`)
- Inject relevant memories into system prompt based on conversation topic
- Add `/memory` command to view/edit/clear memories

**Why next:** Extends the existing Phase 3.1 compound learning system (50 learnings + 20 sessions in R2). Currently the bot remembers *what tools worked* but not *what the user cares about*. Memory would make it genuinely personalized.

**Key files:**
| File | Purpose |
|------|---------|
| `src/openrouter/learnings.ts` | Existing learning system — extend with memory extraction |
| `src/openrouter/storage.ts` | R2 storage patterns — add memory read/write |
| `src/durable-objects/task-processor.ts:3865-3880` | Post-task learning extraction — add memory extraction here |
| `src/telegram/handler.ts` | Add `/memory` command |

---

### Option B: 6.4 — Calendar/Reminder Tools
**Best for: Claude Code | Effort: Medium**

Add time-based reminders and scheduled messages:
- `/remind 2h Check deployment` — one-shot reminder
- `/remind daily 9am Morning briefing` — recurring
- Use Durable Object alarms for scheduling
- Telegram message delivery on trigger

---

### Option C: 6.5 — Email Integration
**Best for: Claude Code | Effort: Medium**

Add email as input/output channel via Cloudflare Email Workers.

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346 → compromise, 1800 tests |
| 2026-03-16 | F.2 — Browser CDP (a11y tree, click/fill/scroll, sessions) | Claude Opus 4.6 | PR 342, 14 tests |
| 2026-03-16 | Phase 5.6 — Orchestra polish (durationMs, parsing, stale cleanup) | Codex+Claude | PRs 337-339 → compromise |
| 2026-03-16 | Phase 5.4 — Acontext Disk file management (4 tools) | Codex+Claude | PRs 328-334 |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 |
| 2026-03-14 | Orchestra gating fix | Claude Opus 4.6 | Commit d28fcb1 |
