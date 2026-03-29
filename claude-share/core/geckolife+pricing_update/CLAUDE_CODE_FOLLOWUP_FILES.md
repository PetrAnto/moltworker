# GeckoLife + Pricing Update — Follow-Up Files Pack

Use this checklist pack after each sprint PR to keep Claude Code and humans synchronized.

## 1) Mandatory Follow-Up Updates

After every sprint completion, update:
- `claude-share/core/codex-log.md` (or relevant AI log)
- `claude-share/core/GLOBAL_ROADMAP.md`
- `claude-share/core/WORK_STATUS.md`
- `claude-share/core/next_prompt.md`
- Wave tracking file(s): [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md), [COACHING_FLYWHEEL_ROADMAP.md](./COACHING_FLYWHEEL_ROADMAP.md)

## 2) Sprint PR Attachment Template

Copy this into each PR body:

```md
## Sprint Delivered
- ID: <W7-Sx / Sprint x>
- Branch: <branch>

## Files Changed
- <group by domain>

## Acceptance Criteria
- [x] <criterion 1>
- [x] <criterion 2>
- [ ] <if blocked, include reason>

## Migrations
- <migration ids>
- Rollback strategy: <short note>

## Manual Actions Required (PetrAnto)
- [ ] <dashboard secret/index action>

## Risks / Deviations
- <list or none>
```

## 3) Manual Action Matrix (Consolidated)

### Stripe/Pricing
- Create Pro €5/mo product + price ID.
- Archive Deep Mode product.
- Remove stale deep/yearly/team Stripe secrets.

### Cloudflare Infra
- Create/verify Vectorize indexes needed by current sprint.
- Verify Workers AI binding availability or configure REST fallback secrets.

### Moltworker Deploy
- Upload Lyra media prompt files to R2.
- Run Telegram smoke checks for `/image` and `/video` before marking W7-M3 done.

Reference docs:
- [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)
- [WAVE7_ROADMAP.md](./WAVE7_ROADMAP.md)
- [sprint-0-workers-ai-infra.md](./sprint-0-workers-ai-infra.md)
- [sprint-5-analytics-collective.md](./sprint-5-analytics-collective.md)

## 4) Quality Gates Before Merge

- No residual Deep tier code paths.
- No PII in collective/shared vector metadata.
- No unvalidated request bodies in new APIs.
- No skipped tests/typecheck without documented environment reason.
