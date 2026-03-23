# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-23 (F.1 ai-hub data feeds — 2073 tests)

---

## Current Task: Pick next from alternatives below

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-23 | F.1 — ai-hub data feeds integration | Claude Opus 4.6 | fetchAiHubRss + fetchAiHubMarket wired into /brief, graceful degradation, 11 new tests (2073 total) |
| 2026-03-23 | F.21+F.24+taskForStorage — Review cleanup batch | Claude Opus 4.6 | pendingChildren consumers (resume caps + display), model floor with paid escalation suggestion, post-aggressive storage verification. 8 new tests (2062 total) |
| 2026-03-23 | F.26 — Smart resume truncation | Claude Opus 4.6 | Tool-type-aware truncation, file read deduplication, structured summaries. 10 new tests (2054 total) |
| 2026-03-23 | F.25 — Byte counting + extraction escalation + context decoupling | Claude Opus 4.6 | taskForStorage() uses TextEncoder byte length, extraction failure escalates to reasoning model, extractionMeta persisted for resume resilience. 3 new tests (2044 total) |
| 2026-03-23 | F.23 — Branch-level concurrency mutex | Claude Opus 4.6 | R2-based repo-level lock with 45-min TTL. Acquire before dispatch, release on all terminal paths. 21 new tests (2041 total) |
| 2026-03-22 | F.22 — Profile enforcement regression tests | Claude Opus 4.6 | 14 tests: promptTierOverride (4), sandbox tool-level gating (5), forceEscalation (5). 2020 total |
| 2026-03-22 | F.20 — Runtime/diff-based risk classification | Claude Opus 4.6 | RuntimeRiskProfile: file tracking (16 config patterns), scope expansion, error accumulation, drift detection. Integrated into DO loop + RunHealth. 24 new tests (2006 total) |
| 2026-03-22 | F.18.1 — ExecutionProfile authoritative enforcement | Claude Opus 4.6 | promptTierOverride, sandbox tool-level gating, forceEscalation auto-upgrade. F.20–F.24 tracked from reviewer feedback |
| 2026-03-22 | F.18 — OrchestraExecutionProfile | Claude Opus 4.6 | Centralized task classification: sandbox gate, resume cap modulation, force-escalation. 8 tests (1982 total) |
| 2026-03-22 | F.17 — Sandbox stagnation detection + run health | Claude Opus 4.6 | detectSandboxStagnation(), sandboxStalled/prefetch404Count signals |
| 2026-03-22 | Architecture review prompt | Claude Opus 4.6 | 5 architectural decisions documented for external AI review |
| 2026-03-21 | F.16 — Orchestra branch retry fix | Claude Opus 4.6 | Root cause from PR #108: "retry with different branch" loses prior commits. Updated 5 prompt locations |
| 2026-03-21 | F.15 — EOL normalization + GitHub path encoding | Claude Opus 4.6 | 1911 tests. applyFuzzyPatch dominant EOL detection, encodeGitHubPath on all 7 API URLs, 9 new tests |
| 2026-03-21 | Docs sync — roadmap, future-integrations, claude-log | Claude Opus 4.6 | Marked 6 completed features in future-integrations.md, added brainstorming cross-refs to roadmap |
| 2026-03-19 | F.4 — R2 File Management Tools | Claude Opus 4.6 | 1890 tests. R2-backed save/read/list/delete (primary, Acontext fallback), per-user scoping `files/{userId}/`, 10MB quota + 100 file limit, /files Telegram command, 25 new tests |
| 2026-03-19 | F.3 — Code Execution Sandbox in Orchestra | Claude Opus 4.6 | 1865 tests. sandbox_exec in DO via capability-aware filtering, 15-call safety limit, /simulate/sandbox-test endpoint, orchestra prompts inject verification step |
| 2026-03-19 | F.14 — Fuzzy patch fallback + bracket balance pre-commit | Claude Opus 4.6 | 1861 tests |
| 2026-03-19 | F.13 — MiniMax M2.7 upgrade + death loop fix | Claude Opus 4.6 | 1848 tests |
| 2026-03-18 | Orchestra gate bypass for proven models (event history) | Claude Opus 4.6 | 1848 tests |
| 2026-03-18 | Prompt dedup fix + Fix Proceed button loop | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.12 — Event-based model scoring in /orch advise | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.11 — Orchestra observability (R2 events + /orch stats) | Claude Opus 4.6 | 1840 tests |

---

## Alternative Next Tasks

1. **F.1b** — ai-hub proactive alerts (wire `/api/situation/alerts` to cron trigger)
4. **F.7** — Discord full integration (read-only → two-way)
5. **6.3** — Voice messages (Whisper + TTS)
6. **Slack integration** — Two-way Slack bot support
