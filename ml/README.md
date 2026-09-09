# Rally segmentation

Turns a match video into precise rally start/end timestamps, with a confidence
score and a stated reason for every boundary it draws.

No language model looks at a frame. Detection is a trained YOLO, tracking is a
Kalman filter, geometry is a court homography, and the rally boundaries come
from a temporal state machine over measured signals. An LLM is a poor and
expensive frame-by-frame detector; it is a good coach, which is what the rest of
the app already uses it for.

```
video ──▶ perception ──▶ feature stream ──▶ segmenter ──▶ rallies.json
          (expensive,      (33 numbers      (cheap,        + debug.mp4
           cached)          per frame)       swappable)
```

---

## What it measures

| signal | how |
|---|---|
| **ball** | YOLO, run on overlapping tiles at native scale, then followed with a small ROI once a track exists |
| **players** | YOLO person detector on a cadence, ByteTrack-style two-stage association in between |
| **court** | white-line mask → Hough segments → outer quad → homography, scored by how much white the *other* court lines land on |
| **bounce / paddle contact** | where the trajectory stops being one parabola — the two are separated by whether the impulse was vertical (the court) or a reversal of travel (a paddle) |
| **out of bounds** | the homography applied to a bounce point. At the instant it bounces the ball really is on the ground plane, so this is a measurement, not an estimate |
| **net contact** | the ball enters the net band, loses most of its speed, drops, and never changes sides |
| **double bounce** | two bounces with no contact between them. In pickleball that is unambiguous: the point is over |
| **serve** | a stretch with no contact and no crossing, a player behind a baseline, then the ball rising and crossing |

---

## Rally starts and ends

A two-threshold state machine with hysteresis, gap tolerance and a confirmation
stage. Five things make it hold up on real footage:

**Evidence is fused with a noisy-OR, not a weighted mean.** A clear serve is
enough on its own; so is a sustained rhythm of net crossings. Averaging and
dividing by the total weight makes every signal individually insufficient, which
in practice means nothing but a serve can ever open a rally.

**Gap tolerance is conditioned on the players.** The ball vanishes constantly —
behind a body, against a bright fence, past the detector on a hard drive. Up to
`max_ball_gap_s` of that is tolerated. But if the ball is gone *and* everyone has
stopped, the much shorter `quiet_ball_gap_s` applies, because that combination is
what the end of a point actually looks like. Ball alone is ambiguous; ball plus
bodies is not.

**Terminating events beat scores, but must be confirmed.** A bounce mapped
outside the sidelines, a ball that dies in the net, a second bounce with no
paddle between, or the next serve starting — each opens a short confirmation
window instead of ending the rally outright. If play visibly resumes inside it,
the event was a false positive and the rally continues with its boundary
unmoved. Nothing is lost by waiting, because the end is always snapped back to
the event itself.

**Re-arming is real hysteresis.** After a rally closes, the start evidence has to
fall away before another can open. Without that, the windowed rates left over
from the rally that just ended are still above the start threshold, so the
machine re-opens on its own exhaust a frame later.

**Measured boundaries and clip boundaries are separate fields.** `start_s`/`end_s`
are the rally; `clip_start_s`/`clip_end_s` add the lead/tail padding you cut on.
Baking padding into the measurement makes every number look half a second wrong
and makes a padding change indistinguishable from an accuracy regression.

Every rally reports `confidence` plus the `end_reason` that produced it, so the
app can surface the uncertain ones for review instead of silently shipping them.

---

## Install

```bash
cd ml
python3 -m venv .venv
.venv/bin/pip install -r requirements-core.txt     # numpy, opencv, scipy, pyyaml
.venv/bin/pip install -r requirements-yolo.txt     # + torch and ultralytics
.venv/bin/pip install -r requirements-dev.txt      # + pytest, to run the tests
```

Python 3.9 or newer.

`requirements-core.txt` alone is enough to run the tests, the court fitter, the
state machine, the eval harness and the debug renderer. The YOLO extras are what
you need to point it at a real match.

ffmpeg is found on `PATH`, or falls back to the `@ffmpeg-installer` binaries the
Next.js app already ships — so on a machine set up for the app, there is nothing
extra to install.

---

## Use

```bash
# rally timestamps
python -m rally_seg segment match.mp4 --weights models/ball_yolo.pt --out rallies.json

# the same run, rendered so you can see why
python -m rally_seg debug match.mp4 --out debug.mp4

# one mp4 per rally, cut on the padded bounds
python -m rally_seg clips match.mp4 --out-dir clips/ --min-confidence 0.5

# check the court fit before committing to a long run
python -m rally_seg court match.mp4 --out court.png --save-points my_court.json

# score against hand-labelled rallies
python -m rally_seg eval match.mp4 --truth labels.json

# tune the thresholds to how you film
python -m rally_seg calibrate --clips a.mp4:a.json b.mp4:b.json --out tuned.yaml
```

Any threshold can be overridden inline — `--set state.max_ball_gap_s=1.4` — or
by environment variable, `RALLYSEG_STATE__MAX_BALL_GAP_S=1.4`.

### Watch the debug video first

Segmentation fails in ways a JSON file cannot show you: the tracker locked onto a
white shoe, the homography is four feet off, the "serve" was someone bouncing the
ball while they waited. Thirty seconds of overlay tells you which. It draws the
ball trail (dashed when the tracker is coasting rather than seeing), player boxes
with track IDs, the projected court and net, the live evidence bars, every event
as it fires, a timeline of the rallies, and a coloured frame border on the exact
cut points.

---

## Calibrating to your footage

The defaults are reasoned, not measured — and they cannot be measured in advance,
because they depend on camera height, distance behind the baseline, 30 vs 60 fps,
and whether you play indoors or on a sunlit court with hard shadows.

Label ten minutes of a real match (`[{"start_s": 12.4, "end_s": 19.8}, …]`), then:

```bash
python -m rally_seg calibrate --clips match.mp4:labels.json --out tuned.yaml
```

This is fast — seconds, not hours — because perception is cached and only the
state machine re-runs. The cache key covers only the config fields that can
change the feature stream, so changing a threshold reuses the cache and changing
the ball detector correctly invalidates it.

The tuning objective weights boundary tightness above raw detection: missing a
rally is recoverable by lowering a threshold, but a systematically late start is
not — it silently ruins every clip the app cuts.

---

## Training the ball detector

A pickleball is 74 mm across. Filmed from behind the baseline at 1080p it is
6–12 px wide, and while travelling it is a motion-blurred smear rather than a
circle.

```bash
python -m rally_seg.train.train_ball_yolo train --data <roboflow-export>/data.yaml
python -m rally_seg.train.train_ball_yolo val --weights runs/ball/train/weights/best.pt --data <...>/data.yaml
```

The defaults in that script are not Ultralytics defaults; `imgsz` is 960 rather
than 640, scale augmentation is reduced and mosaic closes early. The reasoning is
in the file. The other half of accuracy is the dataset, and no hyperparameter
recovers a bad one: **label the blurred smears, not only the crisp balls** — a
detector that has only seen sharp balls fails exactly when the ball is moving,
which is every frame that matters — and include frames with no ball at all as
negatives.

mAP50 ≈ 0.85 and recall ≈ 0.90 on a *held-out match* (not a random frame split,
which leaks) is where detection stops being the bottleneck.

---

## Replacing the rules with a learned model

The state machine is a strong prior, not a ceiling. Both it and the learned model
consume the same `FeatureStream` — a fixed-width vector per frame, defined in
`features.py` — and nothing else. That is what makes them interchangeable, and it
means training data is a byproduct of ordinary inference:

```bash
python -m rally_seg.train.export_dataset --clips a.mp4:a.json b.mp4:b.json --out data.npz
python -m rally_seg.train.train_temporal --dataset data.npz --out models/temporal_tcn.pt
python -m rally_seg segment match.mp4 --set segmenter.kind=temporal
```

The model is a dilated TCN with an ~8 second receptive field and three per-frame
heads: in-rally, start boundary, end boundary. The boundary heads matter —
training only on the in-rally mask gives a model that is right 95% of the time
and vague about exactly where rallies begin, which is the one number this exists
to produce. Splits are grouped by clip, always: consecutive frames from one match
are near-duplicates, and a random frame split reports a number that has nothing
to do with the next video you upload.

Migration path: ship rules → collect labels → train → run
`segmenter.kind=ensemble` at `ensemble_alpha=0.5` while the model is unproven →
walk alpha to 1.0 once `eval` says to. The app never changes.

---

## Using it from the app

`src/lib/rallyVision.ts` runs the pipeline and returns rallies in the app's own
shape. It never throws: every failure returns `null` so the caller falls back to
the audio segmenter in `src/lib/segment.ts`.

```ts
import { segmentWithVision, visionOwnsBoundaries } from "@/lib/rallyVision";

const vision = await segmentWithVision(videoPath, {
  contactTimes,                       // from the audio pass, used as an extra channel
  onProgress: (line) => setStatus(sessionId, "segmenting", line),
});

const rallies = visionOwnsBoundaries(vision) ? vision!.rallies : audioRallies;
```

The two are complementary rather than competing. Audio is genuinely good at
counting paddle contacts and genuinely bad at deciding when a point ends, because
that is inferred from silence and wind destroys silence. Vision answers the
boundary question directly. `visionOwnsBoundaries` hands the job back when the
court could not be fitted, the ball was barely seen, or too many rallies came out
low-confidence.

Check it on a machine before trusting a long upload:

```bash
npm run check-vision -- data/videos/<file>.mp4
```

---

## Tests

```bash
cd ml && .venv/bin/python -m pytest
```

61 tests, about half a second. The state-machine tests build feature streams
directly rather than going through a video, so they test the temporal logic
instead of the detector — including cases that are hard to film on purpose, like
a ball occluded for exactly 0.7 seconds while the players keep running.

`tests/make_synthetic.py` renders a court, four players and a physically
simulated ball with known-exact rally boundaries, plus a detection stream that
behaves like a well-trained but imperfect YOLO (8% misses, 1.5% false positives,
sub-pixel noise). The integration test runs the whole stack against it. Current
numbers, which the test asserts as regression guards:

| | |
|---|---|
| rallies found | 7 / 7, no splits, no merges |
| F1 | 1.00 |
| mean IoU | 0.81 |
| start error (median) | 0.18 s |
| end error (median) | 0.53 s |
| boundary F1 @ ±1 s | 0.93 |

Synthetic footage cannot tell you whether the ball detector generalises — only a
real match can. What it can do, and real footage cannot do cheaply, is give the
temporal logic exact ground truth.

---

## Layout

```
rally_seg/
  config.py       every threshold in the system, and nothing else has one
  schema.py       the versioned JSON contract
  video.py        ffprobe metadata, cv2 and ffmpeg readers, h264 writer
  detect/
    ball.py       YOLO (tiled + ROI), motion fallback, replay-from-JSON
    players.py    YOLO person detector, motion fallback
    court.py      homography: canonical court, classical fit, optional keypoint model
  track/
    ball_track.py Kalman + physical gating + competing hypotheses
    bytetrack.py  player tracking, two-stage association
  events.py       bounce, contact, crossing, net contact, out, double bounce, serve
  features.py     the feature stream — the seam the whole design hangs on
  models/
    base.py       the segmenter interface and shared post-processing
    rule_based.py the state machine
    temporal.py   the TCN, the ensemble, and the factory
  pipeline.py     orchestration and the perception cache
  debug_video.py  the overlay
  evaluate.py     boundary-aware metrics
  calibrate.py    coordinate descent over the thresholds
  cli.py          segment | debug | clips | eval | calibrate | court | features
```

### Where to look when something is wrong

| symptom | look at |
|---|---|
| rallies far too long, ending on `low_activity` | terminating events are not firing — check the debug video for bounces |
| one rally reported as two | `state.max_ball_gap_s`, `state.merge_gap_s` |
| two rallies reported as one | end evidence too weak; check whether the court was fitted |
| starts consistently late | `state.lead_s` is for clips only — a late `start_s` means the serve was missed |
| everything low-confidence | `ball_detection_rate` in the output; below ~0.2 the boundaries lean on player activity |
| no out-of-bounds calls ever | the court was not fitted — run `court` and set `court.manual_points_path` |
