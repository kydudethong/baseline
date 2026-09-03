# Phase 2 — Real Computer Vision Pipeline: Deliverables Report

This report covers what was actually built, actually run, and actually found — including what doesn't work well yet. Per the spec's own rules, nothing here is reported as "implemented" without having been exercised, and every limitation below is a real one observed in this session, not a hedge.

## 0. Scope reconciliation (read this first)

The spec assumed a Supabase-backed "Phase 1" (auth, storage, upload, `VisionProvider`/`AnalysisEngine` abstractions with mocks) already existed. It did — but not inside the `coach` app this session had been working in all day. It exists as a separate project, `~/Downloads/pb-analyzer` ("Rally IQ"), with its own `PHASE1.md`. All Phase 2 work in this report was built on top of **that** project, not `coach`. `coach` (SQLite, no auth, Twelve Labs + Gemini) is architecturally unrelated and untouched by this phase.

## 1. Files created / modified

**New — CV layer** (`src/lib/vision/`): `phase2-types.ts`, `court.ts`, `homography.ts`, `roboflow-provider.ts`, `tracker.ts`, `pose.ts`, `movement.ts`, `events.ts`, `provider-v2.ts`, `run-vision-pipeline.ts`, `cv-scripts.ts`.

**New — Python CV scripts** (`scripts/cv/`): `detect_court.py`, `estimate_pose.py`, `audio_events.py`.

**New — pipeline/persistence**: `src/lib/analysis/pipeline-v2.ts`, `src/lib/db/vision.ts`.

**New — DB migration**: `supabase/migrations/0003_phase2_vision.sql` (6 tables + RLS).

**New — UI**: `src/components/dashboard/MovementMetricsPanel.tsx`, `src/app/dashboard/[analysisId]/debug/page.tsx`.

**New — model asset**: `models/yolov8n-pose.pt` (6.8MB, Ultralytics pretrained weights).

**New — benchmark harness** (not part of the app): `scripts/run-benchmark.ts`.

**Modified**: `src/app/api/analyses/[id]/process/route.ts` (now kicks off the async v2 pipeline by default, `PIPELINE_VERSION=v1` falls back to Phase 1's synchronous mock), `src/lib/db/types.ts` (added Row/Insert/Update types + `Database.Tables` entries for the 6 new tables), `src/lib/video/ffmpeg.ts` (frame extraction rewritten from N sequential `-ss` seeks to a single fps-filtered decode pass — **the old approach took ~5.5 minutes to extract 692 frames from the benchmark video; the new one takes ~22 seconds**, a real bug fix, not just a Phase 2 addition), `src/app/dashboard/[analysisId]/page.tsx` (added the movement section + a link to the debug page), `.env.example`, `.gitignore`.

## 2. Dependencies added

**None at the npm level** — no new Node packages. Roboflow is called via native `fetch`; the homography solver is ~60 lines of hand-rolled linear algebra (no matrix library needed for a 4-point DLT).

**Python, on whatever machine runs the pipeline** (not committed — install locally):
```
pip install ultralytics opencv-python-headless numpy
```
(`torch`/`torchvision` come in as `ultralytics` dependencies.) `ffmpeg`/`ffprobe` were already required by Phase 1.

## 3. Environment variables (see `.env.example`)

| Variable | Purpose | Default |
|---|---|---|
| `ROBOFLOW_API_KEY` | Server-side hosted inference (player detection) | *(required for real runs)* |
| `ROBOFLOW_HOST` / `ROBOFLOW_MODEL_ID` | Override if the classic endpoint moves | `https://detect.roboflow.com` / `coco/50` |
| `VISION_FPS` | Sampling rate run through CV — **never** the source 60fps | `5` |
| `VISION_PROVIDER` | `roboflow` (real) or `mock` (clearly-labeled synthetic) | `mock` |
| `PIPELINE_VERSION` | `v2` (real pipeline, async) or `v1` (Phase 1 mock, sync) | `v2` |

Your `.env.local` (both on your Mac and in my working copy) now has real Supabase + Roboflow credentials wired in, plus `VISION_FPS=5` and `VISION_PROVIDER=roboflow`.

## 4. Database migration

`supabase/migrations/0003_phase2_vision.sql` adds `court_calibrations`, `analysis_frames`, `player_tracks`, `player_keypoints`, `movement_metrics`, `analysis_events` — all hung off `analyses.id`, RLS-scoped via a join back to `analyses.user_id` (read), writable by the service role (the background job). **Not yet applied to your Supabase project** — see §8. Apply it via the Supabase SQL editor or `supabase db push` before running the real pipeline end-to-end.

## 5. CV vendor decisions and rationale

| Capability | Vendor/method | Why |
|---|---|---|
| Player detection | Roboflow hosted, pretrained COCO model (`coco/50`, `person` class) | Zero training needed, callable today with just an API key. `.env.example` already had `ROBOFLOW_*` stubbed in — this was clearly the intended path. Pricing checked live (not assumed): free tier 15 credits/mo, 1 credit ≈ 1,000 single-frame inferences — a 138s clip at `VISION_FPS=5` (≈690 frames) costs well under 1 credit. |
| Tracking | Hand-written IoU + constant-velocity-prediction tracker (TypeScript) | Evaluated Roboflow's hosted ByteTrack Workflow block; chose to implement IoU tracking directly instead because wiring a full custom Workflow adds workspace/account setup for marginal benefit at this frame count, and a local tracker produces the same `PlayerTrack[]` shape — swappable later without touching anything downstream. |
| Pose estimation | YOLOv8n-pose (Ultralytics), local, CPU | Roboflow has **no** ready pretrained hosted human-pose model — only custom-trainable keypoint projects, which would mean collecting/labeling a dataset before shipping anything. YOLOv8n-pose is free, well-validated, and fast enough on 2 CPU cores (~2.6s cold-start, then well under 1s/frame). This is a deliberate vendor split, not an oversight. |
| Court detection | Classical CV (HSV two-band color segmentation + contour geometry), no ML | A pickleball court's playing surface is a large, consistently two-toned quadrilateral, reliably separable by color from a gym floor — no training data existed for a learned corner-keypoint model, and this needed to work today. |
| Contact timestamps (`unknown_shot`) | Audio onset detection (percentile-thresholded energy-envelope peaks) | Far more reliable than inferring "a shot happened" from 5fps-sampled frames; explicitly returns **no shot type**, matching the spec's deferral of shot classification. |

## 6. Exact run commands

```bash
# apply the new migration first (Supabase SQL editor or:)
supabase db push

# install Python deps once
pip install ultralytics opencv-python-headless numpy

npm run dev
# upload the benchmark video through the UI, then POST /api/analyses/{id}/process
# (or use ProcessingControls in the dashboard — same call)
```

Standalone CV-only benchmark (bypasses Supabase entirely, useful for iterating on the CV code):
```bash
npx tsx scripts/run-benchmark.ts
```

## 7. Actual benchmark-video results (this session, real run)

Video: `New Apple iPhone 17 Pro Recording 60fps Pickleball...mp4` — confirmed via `ffprobe`: **1920×1080, 60fps, 138.4s, h264/aac**. Matches the spec's description exactly.

**Important caveat on how this was tested**: this sandbox has no network path to `roboflow.com` or `supabase.co` (confirmed via the egress proxy's own allowlist — `npmjs.org`/`pypi.org`/a few package registries only, nothing else — this is an infrastructure policy, not a code issue). So the benchmark run below used **YOLOv8n-pose's own person-detection boxes as a stand-in for Roboflow's** to exercise the rest of the pipeline (tracking, court transform, movement, pose-linking, events) against real video end-to-end. The Roboflow HTTP call itself is written to Roboflow's documented classic API contract but **has not been exercised against a live response**. Supabase writes are similarly code-complete but untested live. This needs a first real run in an environment (or your own Mac terminal) with normal internet access.

Frame extraction: 692 frames at `VISION_FPS=5` in **~22s** (after the ffmpeg fix — was ~5.5 minutes before it).

Court calibration: tried 5 candidate frames, kept the best — **confidence 0.609** (method: `classical-cv-hsv-contour`). Two of the five candidates scored 0, one reason the multi-candidate approach was added rather than trusting a single frame.

Player detection: mean **1.58 people/frame**, max 2 in any single frame — for a 4-player doubles game. This is a real recall gap (see §9).

Tracking: **10 tracks** produced instead of the true 4 players. Track lengths ranged from 6 points (`player_7`, a likely false-positive/very brief detection) up to 365 points (`player_6`, spanning 36–111s — clearly one real player tracked continuously through a long stretch of play). See §9 for why.

Pose: 1095 pose-frames successfully linked to tracks.

Movement (after court calibration succeeded): every track produced real, non-null distance/speed numbers — e.g. `player_6`: 99.17m (approx) over 73s of continuous tracking, avg speed 0.207 court-units/s. Full numbers in `benchmark-results/result.json` (attached).

Events: **78 `unknown_shot`** (audio onset, after tuning the threshold — see §9) + **4 `possible_split_step`** candidates = 82 total.

Debug overlays (attached, generated from this real run): bounding boxes track real players tightly and correctly distinguish individuals in-frame; the court quadrilateral traces the near court reasonably but overshoots slightly past the true corners into the background on one edge.

## 8. Known limitations (honest, not hedged)

1. **Live Roboflow/Supabase calls are untested in this session** — network-blocked here. Code is contract-correct per documentation but needs a first real run with actual internet access (your own Mac terminal, not this bridge).
2. **The Supabase migration (0003) has not been applied** — same network block.
3. **Tracking fragments real players into multiple IDs.** 10 tracks for 4 real players is the biggest correctness gap. Root cause: the tracker has no re-identification (no appearance embedding) — a player missed for more than ~2s (10 frames at 5fps) gets a new ID when re-detected, and detection itself has real recall gaps (below) that cause exactly that. This is a legitimate limitation of a from-scratch IoU tracker, not a bug to "just fix" — Roboflow's hosted ByteTrack or a proper Kalman-filter tracker with longer memory would likely do meaningfully better; deferred rather than half-solved under time pressure.
4. **Player detection recall is low** — mean 1.58/frame, max 2, for 4 real players. YOLOv8n (nano, smallest model, default 640px inference resize) struggles with small/distant people in a wide gym shot. A larger model (`yolov8s`/`m`) or Roboflow's actual hosted model (once reachable) may do better — this session could not compare them against each other live.
5. **Court calibration is single-frame-fragile.** Confidence swings from 0 to ~0.75 across frames of the *same* video depending on lighting/occlusion/color-mask luck. Mitigated (try 5 candidates, keep best) but not solved — a trained corner-keypoint model would be more robust, appropriately a Phase 3 concern.
6. **Movement-metrics meters are approximate by design** — they assume the calibrated quadrilateral is exactly the near half-court (6.10m × 6.71m), which is a reasonable but unverified assumption about which physical rectangle the classical-CV detector actually found.
7. **The async pipeline is dev-appropriate, not serverless-safe.** `kickOffPipelineV2` relies on the Node process staying alive after the HTTP response returns — correct for `next dev`/`next start`, would silently drop work on a serverless deploy (Vercel) without a real queue (Inngest, per the architecture doc) in front of it.
8. **`unknown_shot` audio thresholding was tuned once, on this one video** — a global-MAD threshold produced a nonsensical ~4.5 events/sec on gym audio (adjacent-court noise); switched to percentile-based thresholding, which produced a plausible 78 events, but this hasn't been validated against ground truth (no dataset of "actual contacts" to check against).
9. **Debug page's SVG overlay math is written but not visually verified through the actual browser** — same network block prevented running `npm run dev` end-to-end in this session; verified instead by generating equivalent overlays with a Python/OpenCV script directly on the real benchmark frames (attached), which use the same coordinate math.

## 9. What works vs. what doesn't (summary)

**Works, verified with real data this session**: video probing/frame extraction (and is now ~15x faster); court detection produces a real, honestly-scored quadrilateral most of the time; pose estimation is accurate and fast; the IoU tracker correctly maintains identity across dozens to hundreds of consecutive frames when detection is present; court-coordinate homography math is exactly correct (unit-tested against known corners); movement metrics compute real, sane numbers once calibration succeeds; audio-based contact detection produces a plausible, non-degenerate event count.

**Doesn't work well yet**: player-count recall (should be ~4, is ~1.6 on average); track fragmentation (should be ~4 IDs, is 10); nothing has been verified against Roboflow's actual hosted model or a live Supabase database, because this environment cannot reach either.

## 10. Recommended Phase 3 (not started)

Per the spec's explicit instruction, no pro-player-dataset/comparison work was started. If/when Phase 3 is taken up, the highest-leverage fixes to do *first* (still within "get the CV right," not yet "add coaching judgment") would be: run this pipeline for real against Roboflow (confirm the untested HTTP contract), compare `coco/50` recall against a larger Roboflow-hosted person model, and replace the from-scratch IoU tracker with either Roboflow's hosted ByteTrack Workflow or a Kalman-filter tracker with longer re-identification memory — in that order, since detection recall is the actual bottleneck feeding both the tracking and movement numbers.
