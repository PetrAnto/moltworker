# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (Phase 5.3+5.4 complete, 5.6 scoped for Codex)

---

## Current Task: 5.6 — Orchestra Mode Polish (Codex)

### Status

Most original 5.6 items are already implemented. Three focused fixes remain.

### Already Done (do NOT redo)

- ✅ REDO mode type — `mode: 'init' | 'run' | 'redo'` exists, stored correctly, tests exist
- ✅ Roadmap parsing — handles `###`, `## Phase/Step/Sprint`, numbered lists, indented checkboxes, flat checklists (6 tests)
- ✅ Stale task cleanup — `cleanupStaleTasks()` exists, called from `/orch history` (5 tests)
- ✅ History UX — shows model, duration, PR link, REDO tag, summary

### Remaining Fixes (Codex prompt ready)

**Prompt file:** `claude-share/core/codex-prompts/codex-prompt-5.6-orchestra-polish.md`

1. **Populate `durationMs`** — Field exists in type + rendering but never stored in `task-processor.ts`
2. **Extend `parseRoadmapPhases`** — Add `## Header` (no prefix) and `# Phase N:` matching
3. **Wire `cleanupStaleTasks` into `/orch run`** — Currently only on `/orch history`

### Future (not for this Codex run)

- Progress reporting — wire into 7B.5 streaming feedback
- INIT quality — structured output for roadmap generation
- Integration-level tests across handler → orchestra → task-processor

---

## Completed Codex Tasks

| Phase | Task | Status |
|-------|------|--------|
| 5.3 | Acontext Sandbox for code execution (`run_code` tool) | ✅ Merged 2026-03-16 |
| 5.4 | Acontext Disk for file management (4 saved file tools) | ✅ Merged 2026-03-16 |

---

## Remaining Roadmap (Not Started)

> For the next session after 5.6 is done. Copy this table forward.

| ID | Task | Effort | Notes |
|----|------|--------|-------|
| **F.1** | ai-hub data feeds (RSS, market, proactive notifications) | 6-8h | **BLOCKED** on ai-hub `/api/situation/*` endpoints |
| **F.2** | Browser tool enhancement (CDP) — a11y tree, click/fill/scroll | 4-6h | `BROWSER` binding exists, Peekaboo pattern |
| **F.5** | Observability dashboard enhancement | 4-6h | Acontext session replay, success rates |
| **F.8** | Long-term memory (MEMORY.md + fact extraction) | 8-12h | Extends Phase 3.1 learnings |
| **6.3** | Voice messages (Whisper + TTS) | High | New capability |
| **6.4** | Calendar/reminder tools | Medium | Cron-based |
| **6.5** | Email integration | Medium | Cloudflare Email Workers |
| **6.6** | WhatsApp integration | High | WhatsApp Business API |

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-16 | Phase 5.4 — Acontext Disk file management (4 tools + hardening) | Codex+Claude | PRs 328-330, 332-334 → compromise |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 → compromise |
| 2026-03-14 | Orchestra gating fix — gate auto-synced models without orchestraReady flag | Claude Opus 4.6 | Commit d28fcb1 |
| 2026-03-10 | Orchestra diffs PR merged | Claude Opus 4.6 | Commit a888455 |
| 2026-03-08 | Post-execution extraction verifier for orchestra | Claude Opus 4.6 | Commit 675ef49 |
| 2026-02-23 | 5.1: Multi-Agent Review (1458 tests) | Claude Opus 4.6 | Phase 5.1 complete |
| 2026-02-23 | Phase 7 ALL 10 tasks complete (1411 tests) | Claude Opus 4.6 | Phase 7 complete |
| 2026-03-01 | Phase 8 Operational Hardening (1526 tests) | Claude Opus 4.6 | 38 tasks |
