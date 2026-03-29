# Wave 7 Follow-Up & Governance Pack

> Standardizes handoff quality, PR evidence, and post-sprint governance for each Wave 7 sprint.
> Date: 2026-03-29

---

## 1) Mandatory Coordination File Updates (After Every Sprint)

Update ALL of these after each sprint completion:

1. `claude-share/core/GLOBAL_ROADMAP.md` — mark sprint status + append dated changelog line
2. `claude-share/core/WORK_STATUS.md` — active sprint state + blockers/notes for other agents
3. `claude-share/core/next_prompt.md` — point to next exact sprint prompt file
4. Agent session log:
   - Claude: `claude-share/core/claude-log.md`
   - Codex: `claude-share/core/codex-log.md`
5. Wave tracker: [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)
6. Coaching sub-roadmap: [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md) (if flywheel sprint)

Reference checklist: [../SYNC_CHECKLIST.md](../SYNC_CHECKLIST.md) (if available)

---

## 2) Sprint PR Body Template

Copy this into each PR body:

```md
## Sprint Delivered
- ID: <W7-Sx / W7-Mx>
- Repo: <ai-hub / moltworker>
- Branch: <branch>
- Prompt used: <exact file link>

## Files Changed
- <group by domain: pricing/flywheel/projects/moltworker>

## Acceptance Criteria
- [x] <criterion 1 — copied from sprint spec>
- [x] <criterion 2>
- [ ] <if blocked, include reason>

## Evidence Commands
- `npm run build` — <pass/fail>
- `npm test` — <pass/fail + test count>
- `npm run typecheck` — <pass/fail>
- Targeted grep: <e.g., "no deep-tier references found">

## Migrations
- <migration IDs or "not applicable">
- Rollback strategy: <short note>

## Manual Actions Required (PetrAnto)
- [ ] <dashboard secret/index action>
- <or "None">

## Risks / Deviations
- <list or "None">

## Spec Decision Notes
- <any ambiguity resolution with file references, or "None">

## Next Prompt Pointer
- Next sprint: <W7-Sx+1>
- Branch seed: <pattern>
- Blockers: <list or "None">
```

---

## 3) Per-Sprint Artifact Pattern

For each completed sprint, optionally create in this folder:

- `W7-Sx-IMPLEMENTATION-REPORT.md` — summary of scope delivered, acceptance checklist with pass/fail, commands run + output summary
- `W7-Sx-DECISIONS.md` — deviations from prompt (if any), rationale + alternatives rejected
- `W7-Sx-OPEN-ISSUES.md` — unresolved blockers, owner + target sprint for resolution

This produces deterministic handoff between sessions.

---

## 4) Manual Action Matrix (Consolidated from WAVE7_FOLLOWUP.md)

### Stripe / Pricing (Owner: PetrAnto)
- [ ] Create Pro EUR 5/mo product + get `STRIPE_PRO_MONTHLY_PRICE_ID`
- [ ] Archive Deep Mode product in Stripe dashboard
- [ ] Delete stale secrets: `STRIPE_DEEP_MODE_MONTHLY_PRICE_ID`, `STRIPE_PRO_YEARLY_PRICE_ID`, `STRIPE_TEAM_MONTHLY_PRICE_ID`

### Cloudflare Infra (Owner: PetrAnto)
- [ ] Create/verify Vectorize indexes (personal + shared)
- [ ] Add wrangler bindings after index creation
- [ ] Verify Workers AI binding availability or configure REST fallback secrets
- [ ] Configure PostHog dashboard (after Sprint 5)

### Moltworker Deploy (Owner: PetrAnto)
- [ ] Upload Lyra media prompt files to R2 (`moltbot-data/skills/lyra/`)
- [ ] Run Telegram smoke checks for `/image` and `/video` before marking M3 done
- [ ] Verify KV namespace exists for Nexus cache
- [ ] R2 bucket cleanup before deploy

### Post-Wave 7 (Owner: PetrAnto)
- [ ] Update `storia-dashboard-v4.jsx` (last updated Feb 23)
- [ ] Verify all Stripe webhooks work with new tier mapping
- [ ] Test full flow: free user -> hits vault ceiling -> upgrade -> Pro features unlock

---

## 5) Quality Gates Before Marking Sprint Complete

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] No secrets in staged diff
- [ ] Deprecated terms removed where applicable (e.g., `deep` tier)
- [ ] No residual Deep tier code paths
- [ ] No PII in collective/shared vector metadata (if applicable)
- [ ] No unvalidated request bodies in new APIs
- [ ] All mandatory coordination files updated

If any fail, sprint status = **Partial** (never Completed).

---

## 6) Cross-Link Requirements

Each new sprint artifact must link to:
- The sprint prompt file used
- Master spec: [W7_CANONICAL_SPEC.md](./W7_CANONICAL_SPEC.md)
- Connection matrix: [W7_CONNECTION_LINKS.md](./W7_CONNECTION_LINKS.md)
- Execution roadmap: [W7_EXECUTION_ROADMAP.md](./W7_EXECUTION_ROADMAP.md)
- Tracker: [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)

This ensures Claude Code always has complete context in-file.
