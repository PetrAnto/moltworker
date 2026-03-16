# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-16 (Phase 5.6 complete by Codex)

---

## Current Task: F.2 — Browser tool enhancement (CDP)

### Status
Phase 5.6 is complete. Next priority is F.2 from the remaining roadmap queue.

### Scope
Enhance browser tooling (CDP-backed) to support:
1. Accessibility tree extraction
2. Click/fill/scroll primitives
3. Better deterministic action sequencing for tool calls

### Constraints
- Reuse existing `BROWSER` binding and current browser patterns.
- Keep changes backward compatible with existing browse tool behavior.
- Add targeted tests for new behavior and failure handling.

### Validation
```bash
npm test
npm run typecheck
```

### Remaining Roadmap (Not Started)

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
| 2026-03-16 | Phase 5.6 — Orchestra polish (durationMs, parser, stale cleanup on run) | Codex | Complete |
| 2026-03-16 | Phase 5.4 — Acontext Disk file management (4 tools + hardening) | Codex+Claude | PRs 328-330, 332-334 → compromise |
| 2026-03-16 | Phase 5.3 — Acontext Sandbox `run_code` tool | Codex+Claude | PR 323 → compromise |
