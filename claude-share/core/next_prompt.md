# Next Task for AI Session

> Copy-paste this prompt to start the next AI session.
> After completing, update this file to point to the next task.

**Last Updated:** 2026-03-29 (Wave 7 canonical specs prepared)

---

## Current Task: W7-S1 — Pricing Rewrite (Free/Pro)

### Context

Wave 7 planning docs were deep-reviewed and consolidated. Begin implementation using the canonical execution spec and roadmap.

### Read First (in order)

1. `claude-share/core/geckolife+pricing_update/WAVE7_MASTER_EXECUTION_SPEC.md`
2. `claude-share/core/geckolife+pricing_update/WAVE7_EXECUTION_ROADMAP_V2.md`
3. `claude-share/core/geckolife+pricing_update/W7-S1-pricing-rewrite.md`
4. `claude-share/core/geckolife+pricing_update/pricing-model-v3.md`

### Branch

`claude/w7-s1-pricing-rewrite-<session-id>`

### Hard Requirements

- Remove Deep tier everywhere (logic, validations, webhook mapping, UI).
- Enforce key-availability routing in LLM proxy (no model-prefix paywall checks).
- Run `npm run build && npm test` before handoff.
- Update SYNC_CHECKLIST files and `WAVE7_FOLLOWUP.md` when done.

---

## Recently Completed

| Date | Task | AI | Notes |
|------|------|----|-------|
| 2026-03-29 | Wave 7 deep review + canonical planning docs | Codex (GPT-5.3-Codex) | Added master spec, roadmap v2, follow-up template, and index links under `geckolife+pricing_update/`. |
