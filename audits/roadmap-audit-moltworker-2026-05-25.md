# Roadmap Audit (moltworker) — 2026-05-25

> Audit only. No code changes, no deploys. Every claim carries a `file:line` or commit-SHA pointer.
> Four-level taxonomy: `scaffolded` → `wired` → `validated` → `complete`.

## Executive Summary

The ai-hub tracker's claim that moltworker sprints **W7-M1, M2, M3 are NOT STARTED (as of 2026-03-29)** is **stale and incorrect**. The Lyra media extension landed on `main` via **PR #501 (merge `2f2f47c`, 2026-04-26)** and is real, wired end-to-end, and covered by tests: image/video brief types, type guards, four new commands, argument parsing, renderers, and ~50+ targeted tests. The full suite is green at **3416 tests / 111 files** (baseline was 2083 → **+1333**), and `npm run typecheck` is clean.

However, the sprints are **not "complete" against the spec as written**. Three W7-M1 gaps remain: (1) no Lyra `SKILL.md` was created — command docs live only in `DEPLOY_CHECKLIST_M1.md`; (2) the **Crex Lyrae persona + narrative-paragraph format** directive is absent — prompts identify the agent as "Lyra, a creative director AI" and emit JSON, with "Crex" appearing only in code comments; (3) `/storyboard` is **mis-wired** — the spec requires a *sequence of image_briefs*, but it routes to the `video` subcommand and yields a single `video_brief`. For W7-M3, the **R2 bucket cleanup ritual is NOT in the pre-deploy checklist**, and the spec's R2 prompt paths (`moltbot-data/skills/lyra/{image,video}-system.md`) are not referenced anywhere; the implementation instead bundles prompts in code with a single optional override at a different path.

**Biggest risk right now:** deploying without the R2 bucket purge (recurring config-corruption issue) — see the prominent reminder in the W7-M3 section.

---

## Repo Baseline

- **Test count:** **3416** passing (111 files) — `npm test`, full run, exit 0. Baseline 2083 → **delta +1333**. (Note: `DEPLOY_CHECKLIST_M1.md:5` claims "All 2677 tests pass" — itself now stale; more work merged since.)
- **Typecheck:** clean — `npm run typecheck`, exit 0.
- **Last deploy:** unknown (no deploy timestamp discoverable in repo logs/scripts). `DEPLOY_CHECKLIST_M1.md` is the deploy artifact for this sprint.
- **Open `claude/*` branches (remote):** only `origin/claude/intelligent-pascal-HPxPM` (this audit branch). No other unmerged `claude/*` work branches present on the remote.
- **Merges since 2026-03-01 (first-parent `main`):** the most recent first-parent merge on `main` is **`2f2f47c` (PR #501, 2026-04-26)**, which is where Lyra media (`media-types.ts`, `media-prompts.ts`) was added to `main` (`git log --diff-filter=A` resolves the add to this merge). The broader `--all` history shows a long run of PRs #502–#552 on side branches (audit-command-button, research-openclaw, compare-cloudflare-aws-lambda, fix-bot-skill-error) but these are not on `main`'s first-parent line. **The Lyra media sprint (M1/M2/M3 deliverables) corresponds to PR #501.**

---

## W7-M1 Lyra Media Extension

| Deliverable | Verdict | Evidence | Gap |
|---|---|---|---|
| `image_brief` / `video_brief` SkillResult kinds | **validated** | Union: `src/skills/types.ts:75-76`. Interfaces: `src/skills/lyra/media-types.ts:70-80` (`ImageBrief`), `:143-152` (`VideoBrief`). Guards: `isImageBrief` `media-types.ts:159`, `isVideoBrief` `:211`. Tests `media.test.ts:106-235`. | None — structured schemas (title, platform, dimensions/specs, style, script, tags) match spec. |
| Telegram commands `/image`, `/imagine`, `/video`, `/storyboard` | **wired** (storyboard divergent) | `src/skills/command-map.ts:37-40`. Dispatch reaches `handleLyra` via `telegram/handler.ts:1024,1039` + `skills/init.ts:23`. | **`/storyboard` mis-wired**: spec §2 requires "a *sequence* of `image_brief` results", but `command-map.ts:40` maps it to `defaultSubcommand: 'video'` → single `video_brief` (`lyra.ts:392`). Test `media.test.ts:297` codifies the divergent behavior. |
| Argument parsing (`--for`, `--duration`) | **validated** | `parseFlags` `command-map.ts:82-101`. `--for`→platform `lyra.ts:327,401`; `--duration`→`parseInt` w/ NaN guard `lyra.ts:408,410`. Tests `media.test.ts:367,437`. | Invalid platform / out-of-range duration **silently fall back to defaults** (`lyra.ts:331-334,405-408`) rather than erroring — no validation rejection (see W7-M2 negative-path gap). |
| Lyra skill extension (no regression to `/write`,`/rewrite`,`/headline`,`/repurpose`) | **complete** | Existing handlers intact: `executeWrite` `lyra.ts:69`, `executeRewrite:144`, `executeHeadline:202`, `executeRepurpose:250`. New `executeImage:318`, `executeVideo:392` added alongside. All tests green. | None. |
| `SKILL.md` documentation updated | **missing** | No Lyra `SKILL.md` exists — only `skills/cloudflare-browser/SKILL.md`. New commands documented instead in `DEPLOY_CHECKLIST_M1.md:51-58` and post-deploy test block. README has no `/image`/`/video` docs. | Spec deliverable #5 ("SKILL.md updated") **not met as written**. Docs exist, just not in a `SKILL.md`. |
| Crex Lyrae persona (creative-direction tone, narrative-paragraph format) | **missing / not met** | Prompts identify agent as "You are Lyra, a creative director AI" (`media-prompts.ts:14,43`) and "a specialist content creator AI persona" (`prompts.ts:7`). "Crex" appears **only in code comments** (`lyra.ts:2`, `prompts.ts:2`, `media-types.ts:2`). Output is **JSON**, not narrative-paragraph (`media-prompts.ts:19-37,48-85`). | No "Crex Lyrae" persona string and **no narrative-paragraph directive**. Spec deliverable #6 not met. |

**Overall W7-M1 verdict:** **validated** for the core type/command/render/test machinery, but **NOT complete vs spec** — three deliverables unmet (SKILL.md, Crex persona/narrative format, `/storyboard` sequence semantics).

---

## W7-M2 Integration Tests

| Deliverable | Verdict | Evidence | Gap |
|---|---|---|---|
| `image_brief` / `video_brief` parsing & serialization tests | **validated** | `src/skills/lyra/__tests__/media.test.ts` (50 `it` blocks): guard tests `:106-235`, handler shape tests `:347-466`, renderer JSON-envelope `:510-532`. Renderer suite `src/skills/renderers/__tests__/media-renderers.test.ts`. | None. |
| New command routing tests | **validated** | `media.test.ts:281-305` (`/image`,`/imagine`,`/video`,`/storyboard` routing); e2e routing `lyra-media.test.ts:100-262`. | Routing tests assert the divergent `/storyboard`→video behavior (see M1). |
| End-to-end test with mock ai-hub API consumer | **partial / wired** | `src/routes/__tests__/lyra-media.test.ts` runs `handleLyra` → renderers with a mock LLM; web-renderer contract shape asserted `:166,242`. | **No dedicated "mock ai-hub API consumer" test.** The web-renderer envelope test is the closest proxy for the ai-hub BYOK contract; an explicit consumer-side test is absent. |
| Negative-path tests (missing args, invalid platform, invalid duration) | **partial** | Missing args ✓: empty-text errors `media.test.ts:361,431`, `lyra-media.test.ts:264,273`. Non-JSON fallback ✓ `lyra-media.test.ts:282`. | **Invalid platform ✗** and **invalid duration ✗** — no tests; code silently defaults instead of rejecting, and that fallback path is itself untested for bad input. |
| Existing 2083 tests intact + new count | **validated** | Full suite **3416 passed / 111 files**, exit 0. None of the prior suite broke. Net new ≈ +1333 (includes other sprints' tests merged since the 2083 mark). | None. |

**Overall W7-M2 verdict:** **validated** for parsing/routing/regression; **partial** on the ai-hub-consumer mock and the invalid-platform/invalid-duration negative paths.

---

## W7-M3 Deploy Prep

| Deliverable | Verdict | Evidence | Gap |
|---|---|---|---|
| R2 prompts at `moltbot-data/skills/lyra/{image,video}-system.md` | **missing / divergent** | No reference to `skills/lyra/image-system.md` or `video-system.md` anywhere in repo. Prompts are bundled in code (`media-prompts.ts:14,43`). `DEPLOY_CHECKLIST_M1.md:42-44` documents a **different, optional** single override at `moltbot-data/prompts/lyra/system.md`. | Spec path/scheme not implemented. Per-submode R2 system prompts at the spec'd paths do **not** exist as source files or upload targets. |
| `wrangler.jsonc` updated (no provider SDK secrets) | **complete** | `wrangler.jsonc` reviewed: existing bindings only — `MOLTBOT_BUCKET` (R2) `:71-75`, `NEXUS_KV` `:81-86`, `TASK_PROCESSOR`/`Sandbox`/`DreamBuildProcessor` DOs `:25-39`, `BROWSER` `:90-92`. **No new bindings, no image/video provider SDK secrets** added — matches "moltworker does NOT call providers directly." `DEPLOY_CHECKLIST_M1.md:21` corroborates. | None. |
| Deploy documentation updated | **wired** | `DEPLOY_CHECKLIST_M1.md` (97 lines) covers bindings, changed files, manual actions, Telegram + `/simulate` test commands, API contract. | No standalone `DEPLOY.md`; the checklist serves the purpose. Acceptable. |
| Pre-deploy R2 bucket cleanup ritual referenced | **missing** | `DEPLOY_CHECKLIST_M1.md` contains **no mention** of clearing the `moltbot-data` R2 bucket before deploy. | **Critical reminder absent from the checklist** — see boxed note below. |

**Overall W7-M3 verdict:** **wired** — deployable in principle and binding-clean, but **NOT complete**: the R2 cleanup ritual is missing from the checklist and the spec'd R2 prompt paths are not implemented.

---

## 🚨 Pre-Deploy Reminder (do NOT skip)

**Before ANY moltbot deployment, the R2 bucket contents MUST be deleted manually.** This is a recurring config-corruption issue and is currently **not captured** in `DEPLOY_CHECKLIST_M1.md`.

Bucket: https://dash.cloudflare.com/5200b896d3dfdb6de35f986ef2d7dc6b/r2/default/buckets/moltbot-data

Recommend adding this as the first item of the pre-deploy checklist before the next moltworker deploy.

---

## Cross-Sprint Sanity Checks

- **Blocking TODOs:** **none** in the new W7-M1 code paths — `grep TODO/FIXME/XXX` across `src/skills/lyra/`, `src/skills/renderers/telegram.ts`, `src/skills/command-map.ts` returned nothing.
- **Feature flags:** **none.** Commands are always-on via the static `COMMAND_SKILL_MAP` (`command-map.ts:37-40`); no flag gating, no default-off state.
- **Orchestra / GraphFlow changes for new SkillResult kinds:** **not required, none made.** Dispatch is generic — `runSkill` resolves via the registry (`skills/init.ts:23`, `skills/runtime.ts`), and renderers switch on `kind` (`renderers/telegram.ts:101-105`). New kinds slot in without DO/state-machine edits.
- **F.18.1 → F.1b regression check:** **pass.** Existing Lyra text submodes intact (`lyra.ts:69-312`); full suite green (3416/3416). No evidence of regression in shipped features.

---

## Manual Prerequisites (verify outside the repo)

| Item | State | Evidence |
|---|---|---|
| `nexus-cache` KV namespace | **Not present by that name.** A KV namespace `NEXUS_KV` exists. | `wrangler.jsonc:81-86` (`NEXUS_KV`, id `09914b62…`). No binding literally named `nexus-cache`. Confirm whether the spec means `NEXUS_KV` or a genuinely missing namespace. |
| New env vars for Lyra media | **None required.** Uses existing `OPENROUTER_API_KEY` via `callSkillLLM`. | `DEPLOY_CHECKLIST_M1.md:6,21-22`; no new `env.*` reads in `lyra.ts`. |
| R2 bucket (`moltbot-data`) contents pre-deploy | **MANUAL — must verify/clear.** Cannot be checked from repo. | See Pre-Deploy Reminder above. |
| Optional Lyra hot-prompt override | Optional, manual. | `DEPLOY_CHECKLIST_M1.md:42-44` → `moltbot-data/prompts/lyra/system.md`. |

---

## Recommended Next Steps (moltworker only, ordered)

1. **Add R2 bucket-cleanup step to `DEPLOY_CHECKLIST_M1.md`** (~15 min) — first checklist item; prevents the recurring config corruption. Highest priority, lowest effort.
2. **Decide `/storyboard` semantics** (~1–2h) — either implement the spec'd *sequence of image_briefs* (new `executeStoryboard` producing N `image_brief` results) or formally amend the spec to "storyboard = video brief". Currently code and spec disagree.
3. **Create Lyra `SKILL.md`** (~1h) — document `/image`,`/imagine`,`/video`,`/storyboard`, flags (`--for`,`--style`,`--duration`), and the brief schemas; satisfies M1 deliverable #5.
4. **Add invalid-platform / invalid-duration negative-path tests** (~1h) — assert the intended fallback-vs-reject behavior; closes the M2 gap. Decide whether bad input should default silently or error.
5. **Apply Crex Lyrae persona + narrative-paragraph directive** (~1–2h) — if still desired per mode-gecko spec; currently only JSON output with comment-level "Crex" labeling.
6. **Reconcile R2 prompt-path strategy** (~30 min) — either implement the spec paths (`skills/lyra/{image,video}-system.md`) or update the spec to the bundled-prompt + single-override approach actually shipped.
7. **Add an explicit mock-ai-hub-consumer e2e test** (~1h) — validate the web-renderer envelope against the ai-hub BYOK contract shape.

---

## For Cross-Reference with ai-hub Audit

The ai-hub session should propose updating `WAVE7-TRACKER.md` to reflect ground truth:

- **W7-M1 (Lyra Media Extension):** tracker says **NOT STARTED**; reality is **validated / largely implemented** (merged PR #501, `2f2f47c`, 2026-04-26). Recommend status → **"Mostly done — 3 spec gaps: SKILL.md, Crex persona/narrative format, /storyboard sequence semantics."**
- **W7-M2 (Integration Tests):** tracker says **NOT STARTED**; reality is **validated** with two partials (no mock-ai-hub-consumer test; invalid-platform/duration negative paths absent). Recommend status → **"Done (minor coverage gaps)."**
- **W7-M3 (Deploy Prep):** tracker says **NOT STARTED**; reality is **wired** but **not complete** — R2 cleanup ritual missing from the checklist; spec'd R2 prompt paths not implemented. Recommend status → **"In progress — checklist + R2 prompt paths outstanding."**
- The tracker's `2083 tests` reference (and `DEPLOY_CHECKLIST_M1.md:5`'s `2677`) are both stale; current is **3416**.

---

## Open Questions for PetrAnto

1. **`/storyboard`** — should it produce a *sequence of image_briefs* (per spec) or remain a single video brief (as shipped)? This drives whether item #2 above is a bug fix or a spec amendment.
2. **Crex Lyrae persona** — still a requirement, or has the direction shifted to the current "Lyra creative director + JSON output" approach? Affects M1 closure.
3. **R2 prompt paths** — adopt the spec'd per-submode paths (`skills/lyra/{image,video}-system.md`), or formally bless the bundled-prompt + single-override scheme already in place?
4. **`nexus-cache` KV** — is this meant to be `NEXUS_KV` (present), or a separate namespace that still needs provisioning?
5. **Invalid input handling** — for unknown `--for` platform or non-numeric `--duration`, is silent fallback to defaults the desired UX, or should the bot reject with a usage error?
