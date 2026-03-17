# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-17 (F.12 Event-Based Model Scoring COMPLETE)

---

## Current Task: F.7 — Discord Full Integration (read-only → two-way)

### Why

Discord integration is currently read-only (announcements forwarded to Telegram). The next step is to make it two-way: Discord users should be able to interact with the bot directly via DMs and mentions, using the same OpenRouter backend and tool pipeline as Telegram.

### What to Build

1. Discord bot handler that mirrors Telegram handler functionality (message handling, model selection, tool execution)
2. Two-way message flow: Discord users can chat with AI models, use tools, run commands
3. Shared backend: reuse OpenRouter client, tool execution, Durable Objects pipeline
4. Basic commands: `/models`, `/use`, `/pick`, `/help` in Discord slash command format

### Key Files

| File | Change |
|------|--------|
| `src/routes/discord.ts` | Expand from read-only to full handler |
| `src/discord/handler.ts` | New: Discord-specific message/command handling |
| `src/index.ts` | Wire Discord routes |

### Definition of Done

- [ ] Discord bot responds to DMs and mentions with AI responses
- [ ] Tool execution works through Discord (same pipeline as Telegram)
- [ ] Basic slash commands work (/models, /use, /help)
- [ ] All tests pass, typecheck clean

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-17 | F.12 — Event-based model scoring in /orch advise | Claude Opus 4.6 | 1848 tests |
| 2026-03-17 | F.11 — Orchestra observability (R2 events + /orch stats) | Claude Opus 4.6 | 1840 tests |
| 2026-03-17 | F.10 — Enable reasoning for kimidirect | Claude Opus 4.6 | 1831 tests |
| 2026-03-17 | Wire completion stats into /orch advise handler | Claude Opus 4.6 | 1829 tests |
| 2026-03-17 | F.9 — Orchestra hardening (validation, ranking, stall detection) | Claude Opus 4.6 | 1829 tests |
| 2026-03-16 | F.8 — Long-term Memory (fact extraction + injection) | Claude Opus 4.6 | 1826 tests |
| 2026-03-16 | F.5 — Analytics dashboard (API + metrics UI) | Codex+Claude | PRs 343-346 |

---

## Alternative Next Tasks (if above is done or blocked)

1. **F.7 — Discord full integration** (above)
2. **F.1 — ai-hub data feeds** — Blocked on ai-hub `/api/situation/*`
3. **F.6** — Fork to `storia-agent` (private) — when ready for IDE transport
4. **6.3** — Voice messages (Whisper + TTS)
5. **6.4** — Calendar/reminder tools
