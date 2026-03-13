# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-13 (Phase 9 complete — 1708 tests)

---

## Current Task: Choose Next Direction

### Context

**Phase 9 (Runtime Stability & Orchestra Hardening) is COMPLETE!** 57 non-merge commits across DO stability, orchestra mode, and model scoring. All previous phases (0-8, DM, MS) also done.

Completed since last update:
- Phase 8 (38 tasks) ✅ — Operational hardening, /simulate endpoint
- Phase 9 (20 tasks) ✅ — DO runtime stability, orchestra hardening, model scoring unification
- Phase 5.6 Orchestra ✅ — Full INIT/RUN/REDO with guardrails

Total: 1708 tests, all passing.

### Remaining Open Work (by priority)

| Priority | Task | Phase | Effort | Notes |
|----------|------|-------|--------|-------|
| **1** | **Rate limiting per user** | Tech Debt | Medium (3h) | No per-user rate limiting exists — critical for multi-user scenarios |
| **2** | **Integration tests for Telegram handler** | Tech Debt | Medium (4h) | Only partially covered by /simulate |
| **3** | **Error tracking (Sentry/PostHog)** | Tech Debt | Low (2h) | No external error tracking |
| **4** | **5.3 Acontext Sandbox** — code execution | 5 | High | Requires Acontext setup |
| **5** | **5.4 Acontext Disk** — file management | 5 | High | Requires Acontext setup |
| **6** | **F.2 Browser tool enhancement** — a11y tree, click/fill/scroll | Future | Medium (4-6h) | CDP binding exists but underused |
| **7** | **F.8 Long-term memory** — MEMORY.md + fact extraction | Future | High (8-12h) | Extends learnings + sessions |
| **8** | **6.3 Voice Messages** — Whisper + TTS | 6 | High | |
| **9** | **6.4 Calendar/Reminders** — cron-based | 6 | Medium | |
| **10** | **6.5 Email Integration** — CF Email Workers | 6 | Medium | |
| **11** | **6.6 WhatsApp Integration** — Business API | 6 | High | |

### Pending Human Checkpoints

| ID | Description | Status |
|----|-------------|--------|
| 1.6 | Test parallel tool execution with real APIs | PENDING |
| 2.6 | Review cost tracking vs. OpenRouter billing | PENDING |
| 3.5 | Review learning data quality after 20+ tasks | PENDING |
| 7A.6 | Review CoVe verification results after 10+ tasks | PENDING |
| 7B.6 | Benchmark before/after latency on 5 tasks | PENDING |
| 8.2 | Test /simulate with production models | PENDING |

### Recommendation

**Priority 1: Technical debt.** The system is feature-rich but has gaps in operational safety:
- **Rate limiting** is the highest-risk gap — a runaway user can exhaust API credits
- **Error tracking** would catch production issues before users report them
- **Integration tests** would prevent regressions in the Telegram handler

**Priority 2: Browser tool (F.2)** is the highest-ROI new capability — the CDP binding already exists, just needs a11y tree, click/fill/scroll actions.

**Priority 3: Long-term memory (F.8)** would make the bot significantly more useful for returning users.

**Priority 4: Platform expansion (Phase 6)** — voice, calendar, email, WhatsApp — only when current features are production-hardened.

---

## Recently Completed

| Date | Task | Tests |
|------|------|-------|
| 2026-03-12 | 9C.3: /model search + Top 20 diversification | 1708 |
| 2026-03-11 | 9C.1-2: Unified scoring, AA benchmarks | ~1700 |
| 2026-03-10 | 9B.3-5: Orchestra guardrails (extraction verifier, cross-file scanner) | ~1690 |
| 2026-03-09 | 9A.5-6: Workspace persistence + context saturation fix | ~1670 |
| 2026-03-08 | 9A.2: Stream splitting + 9B.1: Agentic ranking | ~1650 |
| 2026-03-07 | 9A.3: Storage hardening + 9B.7: github_push_files | ~1630 |
| 2026-03-06 | 9A.1: CPU budget yield + 9A.4: Rate limit handling | ~1600 |
| 2026-03-01 | Phase 8: Operational hardening (38 tasks) | 1526 |
