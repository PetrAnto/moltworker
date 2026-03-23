# Work Status

> Current sprint status. Updated by every AI agent after every task.

**Last Updated:** 2026-03-22 (F.22 profile enforcement tests — 2020 tests)

---

## Current Sprint: Production Hardening & Quality

**Sprint Goal:** Harden orchestra mode, improve model reliability tracking, ensure API source parity.

**Sprint Duration:** 2026-03-01 → ongoing

---

### Active Tasks

| Task ID | Description | Assignee | Status | Branch |
|---------|-------------|----------|--------|--------|
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

---

### Parallel Work Tracking

| AI Agent | Current Task | Branch | Started |
|----------|-------------|--------|---------|
| Claude | F.22 COMPLETE — enforcement tests (2020 tests) | `claude/review-ai-feedback-Zo8hq` | 2026-03-22 |
| Codex | — | — | — |
| Other | — | — | — |

---

### Next Priorities Queue

> Ordered by priority. Next AI session should pick the top item.

1. **F.1** — ai-hub data feeds (blocked on ai-hub `/api/situation/*`)
2. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
3. **F.7** — Discord full integration (read-only → two-way)
4. **6.3** — Voice messages (Whisper + TTS)
5. **6.4** — Calendar/reminder tools

### Tracked from AI Architecture Reviews (F.20–F.24)

| ID | Task | Source | Priority |
|----|------|--------|----------|
| F.20 | Runtime/diff-based risk classification | GPT/Grok/Gemini | ✅ Complete (2006 tests) |
| F.21 | `pendingChildren` downstream consumers | GPT | Medium |
| F.22 | Tests for profile enforcement behavior | GPT | ✅ Complete (2020 tests) |
| F.23 | Branch-level concurrency mutex | Gemini | ✅ Complete (2041 tests) |
| F.24 | Broader escalation policy (model floor) | GPT | Low-Medium |

---

### Sprint Velocity

| Sprint | Tasks Planned | Tasks Completed | Notes |
|--------|-------------|----------------|-------|
| Sprint 1 (Feb 6-13) | 8 | 64 | Phase 0-4, 5.1+5.2+5.5, Dream Machine, Model Sync, Phase 7 ALL, 12 bugs |
| Sprint 2 (Feb 23-Mar 1) | — | 38 | Phase 8 operational hardening, /simulate endpoint, 1526 tests |
| Sprint 3 (Mar 1-22) | — | 16 | F.2 Browser CDP, F.3 Sandbox in Orchestra, F.4 R2 File Management, F.5 Analytics, F.8 Memory, F.9 Orchestra hardening, F.10 Kimidirect reasoning, F.11 Orchestra observability, F.12 Event-based scoring, F.13 MiniMax M2.7 + death loop fix, F.14 Fuzzy patch + bracket balance, F.15 EOL + path encoding, F.16 Orchestra branch retry, F.17 Sandbox stagnation, F.18 ExecutionProfile, 1982 tests |
