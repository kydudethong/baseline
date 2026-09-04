# Ball detection & shot classification

Shot types (serve, return, third-shot drop/drive, dink, volley, speed-up,
drive, overhead, drop, reset, block, lob) are produced by
`src/lib/vision/shots.ts` from three inputs: the ball's track
(`scripts/cv/detect_ball.py` → `src/lib/vision/ball.ts`), the players'
positions (existing tracker) and the court homography (existing
calibration). Everything is a rule over physical quantities — where the
shot was hit from, its speed in m/s, its arc, where it landed, whether it
bounced first, what came before it — so a wrong label traces back to a
wrong number, not a black box. Thresholds live in `THRESHOLDS` in
`shots.ts`.

## 1. Pick a ball model (Roboflow Universe)

1. On Roboflow Universe, search **pickleball ball detection**. Prefer a
   project with (a) thousands of images, (b) a fixed behind-the-baseline
   camera like yours, (c) a single `ball` class, (d) a trained model with
   mAP ≥ 0.8 on its own test set.
2. Open the model → **Deploy** → copy the model id (`workspace/project/N`).
3. `.env.local`:
   ```
   BALL_MODEL_ID=workspace/project/N
   BALL_INFERENCE=local
   ```
4. `pip install inference` on the machine that runs processing. First run
   downloads the weights with your `ROBOFLOW_API_KEY`; after that it's
   offline and free per frame.

## 2. Measure before believing

```
npx tsx scripts/run-shots.ts path/to/game.mp4
```
writes `shot-results/<clip>/shots.json`, `quality.json` and `labels.csv`.
Open `labels.csv`, watch the clip, fill the `truth` column for ~100–200
shots (type keys are printed at the end of the run), then:
```
npx tsx scripts/eval-shots.ts shot-results/<clip>/labels.csv
```
You get overall accuracy, accuracy on confident shots, per-type
precision/recall and the most common confusions. That output — not a
feeling — is what "extreme accuracy" means here.

## 3. Where accuracy comes from, in order

1. **Ball coverage** (`quality.json` → `ball.coverage`). Under ~0.5 nothing
   downstream can be great. Fix by forking the Universe dataset, adding
   200–400 labelled frames from *your* camera (include blurred and
   half-hidden balls), retraining at image size 1280, and pointing
   `BALL_MODEL_ID` at your version.
2. **Court calibration** (`courtCalibrationConfidence`). Landing zones and
   speeds depend on it. Whole court in frame, camera fixed, no players on
   the far corners at the start of the clip.
3. **Player attribution**. A shot with `playerId = null` couldn't be
   attributed. More stable player tracks (VISION_FPS 8–10) help.
4. **Thresholds**. Once 1–3 are good, tune `THRESHOLDS` against
   `eval-shots.ts` — the confusion list tells you which boundary to move.

## 4. What the coach gets

When shots exist, `facts.ts` adds a `shot_sequence` to every rally and a
`shot_summary` (kitchen game, serve & return, offense, defense) and the
prompts unlock five extra coaching dimensions. When they don't, the
prompts say so and the coach stays inside stance/paddle/movement — it
never guesses a shot type it didn't see.
