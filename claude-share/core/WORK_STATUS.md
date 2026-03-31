# Work Status

> Current sprint status. Updated by every AI agent after every task.

**Last Updated:** 2026-03-31 (SEC-P1 fixes + upstream sync — PRs #456 + #457 merged)

---

## Current Sprint: Gecko Skills (Sprint 4)

**Sprint Goal:** Implement specialist skill personas (Lyra, Spark, Nexus) with shared runtime, command routing, and transport-neutral rendering.

**Sprint Duration:** 2026-03-25 → ongoing

**Previous Sprint:** Production Hardening & Quality (Sprint 3, 2026-03-01 → 2026-03-23, 22 tasks, 2083 tests)

---

### Active Tasks

| Task ID | Description | Assignee | Status | Branch |
|---------|-------------|----------|--------|--------|
| S0 | Gecko Skills shared runtime (10 sub-tasks) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QN3rA` / PR #415 |
| S1 | Lyra — Crex Content Creator (5 sub-tasks) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QN3rA` / PR #415 |
| S2 | Spark — Tach Brainstorm (6 sub-tasks) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QN3rA` |
| S3 | Nexus — Omni Research (10/10 sub-tasks, incl S3.7 DO) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QN3rA` |
| ST | E2E Coding Agent Smoke Tests (3 sub-tasks) | — | 🔲 Next | — |

### Recently Completed (Sprint 3, for reference)

<details>
<summary>Sprint 3 tasks (22 completed, 2083 tests at sprint end)</summary>

| Task ID | Description | Assignee | Status | Branch |
|---------|-------------|----------|--------|--------|
| F.1 | ai-hub data feeds (RSS + market in /brief) | Claude Opus 4.6 | ✅ Complete | `claude/review-ai-feedback-Zo8hq` |
| F.26 | Smart resume truncation | Claude Opus 4.6 | ✅ Complete | `claude/review-ai-feedback-Zo8hq` |
| F.25 | Byte counting fix + extraction escalation + context decoupling | Claude Opus 4.6 | ✅ Complete | `claude/review-ai-feedback-Zo8hq` |
| F.18.1 | ExecutionProfile authoritative enforcement (reviewer feedback) | Claude Opus 4.6 | ✅ Complete | `claude/review-ai-feedback-Zo8hq` |
| F.18 | OrchestraExecutionProfile — centralized task classification | Claude Opus 4.6 | ✅ Complete | `claude/review-ai-feedback-Zo8hq` |
| F.17 | Sandbox stagnation detection + run health scoring | Claude Opus 4.6 | ✅ Complete | `claude/review-ai-feedback-Zo8hq` |
| F.16 | Orchestra "retry with different branch" fix | Claude Opus 4.6 | ✅ Complete | `claude/add-minimax-model-support-Otzqt` |
| F.15 | EOL normalization + GitHub path encoding | Claude Opus 4.6 | ✅ Complete | `claude/add-minimax-model-support-Otzqt` |
| F.4 | R2 file management tools | Claude Opus 4.6 | ✅ Complete | `claude/add-minimax-model-support-Otzqt` |
| F.3 | Code execution sandbox in Orchestra (DO) | Claude Opus 4.6 | ✅ Complete | `claude/add-minimax-model-support-Otzqt` |
| F.14 | Fuzzy patch fallback + bracket balance pre-commit | Claude Opus 4.6 | ✅ Complete | `claude/add-minimax-model-support-Otzqt` |
| F.13 | MiniMax M2.7 upgrade + death loop fix | Claude Opus 4.6 | ✅ Complete | `claude/add-minimax-model-support-Otzqt` |
| F.12 | Event-based model scoring in /orch advise | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QW3Qh` |
| F.11 | Orchestra observability (R2-persisted events + /orch stats) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QW3Qh` |
| F.10 | Enable reasoning for kimidirect (Kimi K2.5) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QW3Qh` |
| F.9 | Orchestra hardening (validation, ranking, stall detection, /status) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QW3Qh` |
| F.8 | Long-term Memory (fact extraction + injection + /memory) | Claude Opus 4.6 | ✅ Complete | `claude/execute-next-prompt-QW3Qh` |
| F.5 | Analytics dashboard (API + metrics UI) | Codex+Claude | ✅ Complete | PRs 343-346 |
| F.2 | Browser CDP (a11y tree, click/fill/scroll, sessions) | Claude Opus 4.6 | ✅ Complete | PR 342 |

</details>

---

### Parallel Work Tracking

| AI Agent | Current Task | Branch | Started |
|----------|-------------|--------|---------|
| Claude | SEC-P1 done + upstream sync. Transient error classifier, abort checkpoint, gateway reliability. 2732 tests. | `claude/sync-upstream-changes-X8IrX` | 2026-03-31 |
| Codex | Wave 7 deep-review + 4 PR proposals (#443-#446) — cherry-picked by Claude | `work` (PRs open) | 2026-03-29 |
| Other | — | — | — |

---

### Notes for Other Agents

- Wave 7 planning canon now lives in `claude-share/core/geckolife+pricing_update/W7_CANONICAL_SPEC.md` with companion roadmap, connection links, and governance files.
- Use `W7_FOLLOWUP_AND_GOVERNANCE.md` when closing each Wave 7 sprint PR to keep sync artifacts consistent.
- Before starting any W7 coding sprint, read `W7_CANONICAL_SPEC.md` as top-level context to avoid prompt drift.

### Next Priorities Queue

> Ordered by priority. Next AI session should pick the top item.

1. ~~**S0** — Gecko Skills shared runtime~~ — ✅ Complete
2. ~~**S1** — Lyra (Crex Content Creator)~~ — ✅ Complete
3. ~~**S2** — Spark (Tach Brainstorm)~~ — ✅ Complete
4. ~~**S3** — Nexus (Omni Research)~~ — ✅ Complete (incl S3.7 DO extension)
5. **ST** — E2E Coding Agent Smoke Tests (see `claude-share/core/archive/Coding_Agent_Smoke_Tests.md`)
6. ~~**SEC-P1** — Transient error classifier + auto model rotation~~ — ✅ Complete (2026-03-31)
7. ~~**SEC-P1** — Tool-call abort checkpoint/resume pattern~~ — ✅ Complete (2026-03-31)
8. ~~**SEC-P2** — Telegram done-reaction UX~~ — ✅ Complete (2026-03-31)
9. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
10. **F.7** — Discord full integration (read-only → two-way)
11. **6.3** — Voice messages (Whisper + TTS)
12. **6.4** — Calendar/reminder tools

### Deferred / Monitor Items

> These require an external trigger (upstream release, platform availability) before work can start.
> **Review these at the start of each sprint** to check if the trigger condition is met.

| ID | Item | Trigger Condition | Source | Est. Effort |
|----|------|-------------------|--------|-------------|
| MON-1 | Workers AI image generation provider abstraction | FLUX.2 [dev] + [klein] stable on Workers AI | Upstream triage CF-1/CF-2 | ~2-3h (integration) or ~4-8h (with full abstraction) |
| MON-2 | SecretRef auth pattern for BYOK vault | BYOK vault integration from ai-hub Wave 7 ported to moltworker | Upstream triage #8 | ~1h |
| MON-3 | Separate R2 bucket for backup/restore | Optional — currently shares `moltbot-data` with app storage | PR #456 audit point #3 | ~1h (wrangler config + migrate keys) |

### Tracked from AI Architecture Reviews (F.20–F.24)

| ID | Task | Source | Priority |
|----|------|--------|----------|
| F.20 | Runtime/diff-based risk classification | GPT/Grok/Gemini | ✅ Complete (2006 tests) |
| F.21 | `pendingChildren` downstream consumers | GPT | ✅ Complete (2062 tests) |
| F.22 | Tests for profile enforcement behavior | GPT | ✅ Complete (2020 tests) |
| F.23 | Branch-level concurrency mutex | Gemini | ✅ Complete (2041 tests) |
| F.24 | Broader escalation policy (model floor) | GPT | ✅ Complete (2062 tests) |
| F.25 | Byte counting fix + extraction escalation + context decoupling | Gemini/GPT | ✅ Complete (2044 tests) |
| F.26 | Smart resume truncation | GPT | ✅ Complete (2054 tests) |

---

### Sprint Velocity

| Sprint | Tasks Planned | Tasks Completed | Notes |
|--------|-------------|----------------|-------|
| Sprint 1 (Feb 6-13) | 8 | 64 | Phase 0-4, 5.1+5.2+5.5, Dream Machine, Model Sync, Phase 7 ALL, 12 bugs |
| Sprint 2 (Feb 23-Mar 1) | — | 38 | Phase 8 operational hardening, /simulate endpoint, 1526 tests |
| Sprint 3 (Mar 1-23) | — | 22 | F.1 ai-hub data feeds + F.1b proactive alerts, F.2 Browser CDP, F.3 Sandbox in Orchestra, F.4 R2 File Management, F.5 Analytics, F.8 Memory, F.9 Orchestra hardening, F.10 Kimidirect reasoning, F.11 Orchestra observability, F.12 Event-based scoring, F.13 MiniMax M2.7 + death loop fix, F.14 Fuzzy patch + bracket balance, F.15 EOL + path encoding, F.16 Orchestra branch retry, F.17 Sandbox stagnation, F.18 ExecutionProfile, F.20 Runtime risk, F.22 Profile enforcement tests, F.23 Branch mutex, F.25 Byte counting + extraction escalation, F.26 Smart resume truncation, 2073 tests |
| Sprint 4 (Mar 25-) | 34 | 31 | S0 (10) + S1 Lyra (5) + S2 Spark (6) + S3 Nexus (10, incl S3.7 DO) complete. Next: ST smoke tests (3). 2573 tests. |
