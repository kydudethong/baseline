# Phase 3 — Coaching Layer Merge: Deliverables Report

This report covers what was actually built, actually run, and actually found in this phase — merging Baseline's original coaching-narrative app onto Rally IQ's real CV pipeline, swapping the LLM provider mid-phase, and building the UI that makes the whole thing usable end to end. Per the same rule Phase 2 followed: nothing here is reported as "working" without having been exercised for real, and every limitation below is observed, not hedged.

## 0. Scope

Two previously separate apps are now one: Rally IQ's Supabase-backed CV pipeline (auth, upload, court/player/pose tracking, movement metrics, audio-contact detection — Phases 1–2) is the fact source; Baseline's original coaching layer (a SQLite app that used Twelve Labs' video-language extraction + an LLM to write coaching reads) supplied the schema shape, prompt structure, and drill library, all ported onto Rally IQ's CV facts instead of Twelve Labs. Twelve Labs is gone entirely. The merged app is now branded **Baseline** throughout (was Rally IQ).

The coaching framework is deliberately **three dimensions, not five**: `ready_position_split_step`, `paddle_position_proxy`, `footwork_court_movement`. Baseline's original `shot_mechanics` and `shot_selection_strategy` dimensions are not ported — Rally IQ's CV pipeline cannot classify shot type (no ball tracking, no shot-type model), and relabeling similar-sounding dimensions to fit would misrepresent what the data actually supports. This was a deliberate, repeated design constraint through every part of this phase — schema, prompts, and UI copy all honor it (the landing page's original copy claiming "shot selection" analysis was corrected during the rebrand pass, §5).

## 1. Files created / modified

**New — DB migration**: `supabase/migrations/0005_coaching_layer.sql` (7 new tables: `coaching_rallies`, `coaching_reads`, `coaching_observations`, `coaching_skill_ratings`, `coaching_drills` (seeded with 12 drills), `coaching_blueprints`, `coaching_blueprint_steps`, `coaching_chat_messages` (unused so far, see §7); RLS on all of them; new columns on `profiles` and `analyses`). Applied to the real Supabase project and verified working.

**New — facts assembly** (`src/lib/coaching/`): `facts.ts` (turns raw CV output into the honesty-scored facts payload the LLM reads — rally segmentation from audio-onset clustering, stance/paddle-proxy from pose keypoints, contact-side attribution from motion energy, multi-label self-tagging merge for tracker fragmentation), `types.ts` (shared shapes + the 15-skill library + 3-dimension framework), `prompts.ts` (the two coaching prompts + schemas, and the not-yet-wired blueprint/chat prompts), `run-coaching.ts` (orchestrates: load CV facts → build facts payload → 2 LLM calls → persist).

**New — LLM client**: `src/lib/coaching/claude.ts` — replaced an initial Gemini-based client (`gemini.ts`, since deleted) mid-phase; see §3 for why.

**New — practice-plan generator**: `src/lib/coaching/drills.ts` (drill-library lookup with a same-skill-group fallback — see §6), `src/lib/coaching/blueprint.ts` (generates + persists a 5-session plan for one tagged weakness, drills always retrieved from the library, never invented by the model).

**New — API routes**: `src/app/api/analyses/[id]/coach/route.ts` (tags a player + runs the coaching pipeline), `src/app/api/analyses/[id]/blueprint/route.ts` (builds a practice plan from one weakness observation).

**New — DB read helpers**: `src/lib/db/profiles.ts`, `src/lib/db/coaching.ts`, `src/lib/db/blueprints.ts` (mirror the existing `vision.ts` pattern: one function, one round trip of parallel queries, RLS does the access control).

**New — UI**: `src/components/dashboard/PlayerTagPicker.tsx` (multi-select "which player is you" picker — shows 3 frames spread across the clip with colored/labeled tracking boxes, since the tracker's fragmentation means you may be a different color at different points), `CoachingReadPanel.tsx` (renders the coaching read: strengths, top priority fix, secondary observations, drill recommendation, skill ratings, tagged observations), `BuildBlueprintButton.tsx` + `BlueprintPanel.tsx` (trigger + display for practice plans), `src/lib/vision/player-colors.ts` (player→color mapping shared between the debug page and the tag picker, so a track is the same color everywhere it's drawn).

**New — manual test scripts** (bypass the browser/auth, for exercising real Supabase + Claude from a real terminal — see §8): `scripts/test-coach.ts`, `scripts/test-blueprint.ts`.

**Modified**: `src/lib/db/types.ts` (added Row/Insert/Update types + `Database.Tables` entries for all 8 new tables), `src/app/dashboard/[analysisId]/page.tsx` (added the whole Coaching section), `src/app/dashboard/[analysisId]/debug/page.tsx` (refactored to share `colorForPlayer` instead of its own copy), `src/lib/analysis/pipeline-v2.ts` (a silent `catch {}` around debug-frame Storage upload now logs the real error instead of swallowing it — found while chasing an unrelated issue, fixed since a silent failure there is exactly what let a real Storage MIME-type rejection go unnoticed for a whole run), `.env.example` (Gemini vars replaced with `ANTHROPIC_API_KEY`/`CLAUDE_MODEL`/`ANTHROPIC_WORKSPACE_ID`).

**Rebrand** (Rally IQ → Baseline, user-facing text and page titles only — see §5): `src/app/layout.tsx`, `src/app/dashboard/layout.tsx`, `src/app/dashboard/page.tsx`, `src/app/dashboard/new/page.tsx`, `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/components/landing/Nav.tsx`, `Hero.tsx`, `Footer.tsx`.

## 2. Dependencies added

**None at the npm level**, in both the original Gemini client and its Claude replacement — both are hand-rolled `fetch` calls against the provider's REST API, consistent with this app's existing no-SDK philosophy (same reasoning as Phase 2's Roboflow integration).

## 3. Provider switch: Gemini → Claude (mid-phase)

The coaching layer originally shipped against Gemini (`gemini-3.6-flash`, auto-selected). Real end-to-end testing hit Gemini's **free-tier cap of 20 requests/minute** twice in a row — once from a transient "high demand" 503, once from the quota itself, the second partly caused by the first failure's own retries burning through the budget. Rather than just add a longer wait, the retry logic was fixed to honor the server's actual suggested delay (`retryDelay` in Gemini's 429 body) instead of a blind fixed backoff — and then, at your request, the whole client was swapped to Anthropic's Claude API instead, since Claude has no free-tier throttling at this scale and its cost here is trivial (a compact facts JSON in, a short narrative out, twice per analysis — fractions of a cent even on Haiku).

The swap: `gemini.ts` → `claude.ts`, same exported interface (`generateJSON`/`generateText`/`textPart`/`resolveModel`) so `run-coaching.ts` needed only an import-path change. The two JSON schemas in `prompts.ts` were converted from Gemini's dialect (uppercase `"OBJECT"`/`"STRING"` types, `nullable: true`) to standard JSON Schema (lowercase types, `additionalProperties: false` added by hand on every object node since there's no SDK to do it automatically, nullable fields as `["string", "null"]` type arrays) to match Claude's native structured-outputs feature (`output_config.format`, JSON Schema, GA as of Feb 2026). Retry logic now honors Claude's standard `retry-after` header on ordinary rate-limit 429s. Default model: `claude-haiku-4-5-20251001`, overridable via `CLAUDE_MODEL`. An optional `ANTHROPIC_WORKSPACE_ID` env var was added and is sent as the `anthropic-workspace-id` header when set — required for an identity-linked/multi-workspace API key (the one used for testing needed it; a key already scoped to one workspace doesn't).

## 4. Player self-tagging & the tracker-fragmentation problem

Real-world testing surfaced a genuine product bug: the same real player showed up as 4 different tracked IDs (`player_1`, `player_9`, `player_13`, `player_15`) across one clip. Root cause, confirmed in `tracker.ts`'s own code comments: the from-scratch IoU tracker has no re-identification — any gap over ~2 seconds (10 missed frames at 5fps) resumes the same person under a brand-new ID, and this was a known, documented limitation carried over from Phase 2 (§9 there), not a new bug.

Rather than patch around it superficially, the self-tagging data model was redesigned to accept and merge a **set** of labels, not one: `facts.ts`'s `mergeSelfFragments()` concatenates every fragment's tracked points into one synthetic `__self__` track before any grouping or attribution logic runs. Stored as a comma-separated string in `analyses.self_player_label` (no schema change needed), parsed to an array at the application layer. `PlayerTagPicker.tsx` reflects this directly — it's a multi-select, and shows 3 frames spread across the clip rather than one, since the fragmentation means you may not be the same color at every point in the video.

This doesn't fix the tracker itself (still a real limitation — see §9), but it means the coaching layer now scores the whole real player correctly despite it, which is what actually mattered for producing a usable read.

## 5. Rebrand: Rally IQ → Baseline

All user-facing surfaces (page `<title>`s, the nav/header brand name on the landing page/dashboard/login/signup, the footer copyright line, and the landing page's hero copy) now say Baseline. Internal code comments that refer to "Rally IQ" as the name of the CV pipeline/tracker specifically (e.g. "Rally IQ's own CV facts", "Rally IQ's tracker has no re-identification") were deliberately left alone — that's an accurate technical reference to a real, distinct piece of code, not a branding decision, and rewriting it would blur a real distinction rather than clarify one. `PHASE1.md`/`PHASE2_DELIVERABLES.md` are historical records and weren't rewritten either.

One correction made in passing: the landing page's hero copy claimed Baseline breaks down "positioning, shot selection, and patterns" — but shot selection is exactly the thing this pipeline cannot assess (§0). Changed to "positioning, footwork, and readiness patterns," which is what the data actually supports.

## 6. Drill library & practice-plan generator

`coaching_drills` was seeded with 12 real drills (ported from Baseline's original library) covering 9 of the 15 skill keys in `SKILLS`. Rather than fail closed for the other 6 (`volleys`, `defense`, `positioning`, `offense`, `iq`, `consistency` — some of which, particularly `positioning`, are exactly the skills this pipeline can most realistically rate), `getDrillsForSkill()` falls back to the skill's `SKILLS` group before giving up — e.g. `positioning` (group "Movement") falls back to `transition`'s drills, `iq`/`consistency` (group "Decisions") fall back to `selection`'s. Verified with a standalone logic sanity check (fake Supabase client, no network): exact match, group fallback, no-drill-anywhere, and unrecognized-skill-key cases all behave correctly. **`offense` is the one skill with no coverage at all** — it's alone in its `SKILLS` group with no sibling drill to fall back to, so a weakness tagged `offense` will cleanly refuse to generate a plan (`BlueprintPipelineError`) rather than inventing one.

`blueprint.ts` hands the model a closed list of real drills (never lets it invent one — matches Baseline's original design) and re-validates the response before persisting: any `drill_slug` the model returns that isn't in the supplied list is treated as a model mistake and coerced to a "Re-test" step, rather than risking a foreign-key failure on insert. Blueprints are triggered per-weakness from a "Build a 5-session practice plan" button on each weakness observation in `CoachingReadPanel.tsx`, and once one exists for a given skill on that analysis, the button is hidden rather than inviting a duplicate.

## 7. Not built this phase (explicitly out of scope)

- **In-app coach chat.** `coachPrompt()` and the `coaching_chat_messages` table exist (ported from Baseline's schema/prompts) but nothing calls them — no chat UI was requested or built.
- **Marking a practice-plan step done.** `coaching_blueprint_steps.done_at` exists in the schema and `BlueprintPanel.tsx` renders it (a step shows as complete if it's set), but nothing in the UI sets it yet — steps are display-only for now.
- **Cross-analysis skill trends / progress page.** `coaching_skill_ratings` accumulates per-analysis, but nothing aggregates it across a player's history yet (Baseline's original `stats.ts` recency-weighting logic wasn't ported).

## 8. Testing this session (what's actually verified vs. not)

**Verified end-to-end, against the real Supabase project and real analysis data**, via `scripts/test-coach.ts` run in a real terminal (the device-bridge sandbox shell has no network path to Supabase or any LLM provider, so this couldn't run through the automated bridge — see Phase 2's §7 note about the same constraint): multi-label self-tagging across 4 fragmented tracks, full facts assembly, both Claude calls, and persistence into all 4 coaching tables. Confirmed a second time live in the browser — `PlayerTagPicker` and `CoachingReadPanel` both render correctly against that same real data.

**Not yet run against real data**: the practice-plan generator (`blueprint.ts`/`scripts/test-blueprint.ts`). Its logic was verified in isolation (the drill-fallback sanity check in §6, plus a full typecheck/lint/production build with the feature wired into the live page), but `generateBlueprint()` has never actually been executed against the real Supabase project or a real Claude call — same network constraint. Run `npx tsx scripts/test-blueprint.ts <analysisId>` in a real terminal to close this gap; it defaults to the first weakness observation on that analysis if you don't pass one explicitly.

## 9. Known limitations (honest, not hedged)

1. **Player-tracker fragmentation is mitigated, not fixed.** Multi-label self-tagging (§4) means a fragmented real player still gets scored correctly, but the tracker itself still produces the wrong number of tracks for a real clip — the actual fix (re-identification / a longer-memory tracker) is Phase 2's recommended next step, still not done.
2. **Court-boundary detection accuracy is unfixed.** User-reported and confirmed as a real weak spot in the classical HSV-contour court detector (Phase 2 §9's known limitation) — out of scope for this phase, which was about the coaching layer, not the CV pipeline.
3. **The `offense` skill has no drill coverage at all** (§6) — a weakness tagged there cleanly fails to generate a plan rather than producing one.
4. **The blueprint/practice-plan feature is code-complete and build-verified but not yet run against live data** (§8) — the one piece of this phase not actually exercised end-to-end.
5. **No git history existed on the working copy before this phase.** Every file this session (and the prior CV-pipeline session) was synced by hand, one `SendUserFile` + device-commit round trip at a time — workable, but with no diff/rollback safety net. A git repository was initialized on the real working copy as part of this report (`git init` + an initial commit capturing the full current state, secrets excluded via the existing `.gitignore`) so future changes are tracked from here on. No remote was configured — that's your call whenever you want one (GitHub, etc.).

## 10. Recommended next steps

In rough priority order: run `scripts/test-blueprint.ts` for real and click through the practice-plan UI in the browser (closes the one untested piece of this phase); decide whether the in-app coach chat or step-completion tracking (§7) are worth building next; if you want real version history going forward, push the newly-initialized local git repo to a remote of your choice. The CV-pipeline-level issues (tracker fragmentation, court-boundary accuracy) remain the highest-leverage fixes if data quality becomes the bottleneck again, per Phase 2's own recommendation.
