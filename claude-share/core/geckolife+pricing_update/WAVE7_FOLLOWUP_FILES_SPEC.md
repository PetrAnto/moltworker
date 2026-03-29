# Wave 7 Follow-Up Files Spec (What Claude Code must update each sprint)

Date: 2026-03-29

## A) Mandatory project coordination files

For every completed sprint task, update all:

1. `claude-share/core/GLOBAL_ROADMAP.md`
   - mark sprint/task status
   - append dated changelog line

2. `claude-share/core/WORK_STATUS.md`
   - active sprint state
   - blockers / notes for other agents

3. `claude-share/core/next_prompt.md`
   - point to next exact sprint prompt file

4. Agent session log
   - Claude: `claude-share/core/claude-log.md`
   - Codex: `claude-share/core/codex-log.md`
   - Other: `claude-share/core/bot-log.md`

Reference checklist: [../SYNC_CHECKLIST.md](../SYNC_CHECKLIST.md)

---

## B) Sprint Artifact Pattern (inside this folder)

For each sprint `W7-Sx`, create or update:

- `W7-Sx-IMPLEMENTATION-REPORT.md`
  - summary of scope delivered
  - acceptance checklist with pass/fail
  - commands run + outputs summary

- `W7-Sx-DECISIONS.md`
  - deviations from prompt (if any)
  - rationale + alternatives rejected

- `W7-Sx-OPEN-ISSUES.md`
  - unresolved blockers
  - owner + target sprint for resolution

This produces deterministic handoff between sessions.

---

## C) PR Body minimum schema

Every sprint PR should include these sections:

1. **Prompt Used** (exact file link)
2. **Scope Completed** (file-level)
3. **Acceptance Criteria** (checkboxes)
4. **Tests/Checks Run** (`build`, `test`, `typecheck`)
5. **Manual Actions Required** (if any)
6. **Next Prompt Pointer**

---

## D) Cross-link rules (connection links required)

Each new sprint artifact must link to:

- the sprint prompt file
- master spec: [WAVE7_MASTER_SPEC_FOR_CLAUDE_CODE.md](./WAVE7_MASTER_SPEC_FOR_CLAUDE_CODE.md)
- roadmap: [WAVE7_COMPREHENSIVE_EXECUTION_ROADMAP.md](./WAVE7_COMPREHENSIVE_EXECUTION_ROADMAP.md)
- tracker: [WAVE7_FOLLOWUP.md](./WAVE7_FOLLOWUP.md)

This ensures Claude Code always has complete context in-file.

---

## E) Quality gate before marking sprint complete

- `npm run build` passes
- `npm test` passes
- `npm run typecheck` passes
- no secrets in staged diff
- deprecated terms removed where applicable (e.g., `deep` tier)
- mandatory coordination files updated

If any fail, sprint status = **Partial** (never Completed).
