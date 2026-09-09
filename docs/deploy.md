# Deploying Baseline

## The one thing that decides everything

`kickOffPipelineV2()` starts a run and lets it continue on the Node event loop
*after* the HTTP response has already been sent. That is fine in a process that
stays alive and fatal on a platform that freezes the process the moment the
response goes back.

So **this does not go on Vercel as it stands.** On Vercel the run would die
part-way through and the row would sit at `processing` until the staleness
window in `process/route.ts` expires (30 min by default), then be restartable
and die again. Serverless also has no ffmpeg, no Python, no torch, and a
request timeout in seconds where a real clip takes minutes.

Deploy it as **one long-lived container** instead. That is the smallest change
from what already works on your laptop, because the code was written for a
process that stays up.

---

## What already lives elsewhere

Nothing to do for these; they are the same in production as in dev.

- **Supabase** — auth, Postgres, RLS. Hosted already.
- **Cloudflare R2** — the video bytes. Hosted already; the browser uploads
  straight to it.
- **Anthropic** — the coaching read, two calls per analysis.
- **Roboflow** — only if you point `BALL_MODEL_ID`/`PADDLE_MODEL_ID` at a
  hosted model. Player detection runs locally off `models/yolov8n.pt`.

## What needs a box

Node 22, Python 3 with ultralytics + opencv + numpy, ffmpeg, and the two
`.pt` weights in `models/`. The `Dockerfile` in the repo root builds exactly
that. Note it installs the **CPU** torch wheel first: let ultralytics pull
torch on its own and you get ~2.5 GB of CUDA you cannot use.

---

## Steps

### 1. Point Supabase at the real URL

Supabase dashboard → Authentication → URL Configuration:
- **Site URL**: `https://your-domain`
- **Redirect URLs**: add `https://your-domain/auth/callback`

Without this, signup confirmation links come back to `localhost:3000`.

### 2. Add the domain to R2's CORS rule

R2 → your bucket → Settings → CORS Policy. Add the deployed origin next to
`http://localhost:3000`, keeping `ExposeHeaders: ["ETag"]` — browser uploads
read the ETag of every part and silently fail without it.

```json
[{ "AllowedOrigins": ["http://localhost:3000", "https://your-domain"],
   "AllowedMethods": ["PUT", "GET"],
   "AllowedHeaders": ["*"],
   "ExposeHeaders": ["ETag"] }]
```

### 3. Make sure the migrations are applied

`supabase/migrations/` through `0010_run_timing.sql`. If the project you deploy
against is the one you have been developing on, everything up to 0009 already
is — but **0010 is newer than the first deploy and has to be run by hand**.

There is no Supabase CLI config in this repo, so the way it has been done is
to open the SQL editor in the Supabase dashboard and paste the file. It is
`create ... if not exists` throughout, so running it twice is harmless.

Skipping it does not take the site down, it takes out one feature: the
processing screen's ETA reads `analyses.started_at` / `finished_at`, and
without those columns `recentRunSamples()` returns nothing. The estimate falls
back to the documented constant and says it is a rough guess, which is the
designed degradation — but no run will ever record its own timing, so it never
improves. Apply it before the deploy and the first finished clip starts
teaching it.

### 4. Unset the settings that are laptop-only

`fly secrets import < .env.local` copies **everything**, including three values
that are paths on Ky's Mac. A Fly secret overrides the Dockerfile's `ENV`, so
these silently win over the correct container values and break things that
otherwise work:

| Variable | Local value | Why it must not reach the server |
|---|---|---|
| `CV_PYTHON` | a macOS CommandLineTools path | The image sets `/opt/venv/bin/python`. Left set, every CV script spawns an interpreter that does not exist and **every analysis fails**. |
| `RALLY_SEG_DIR` | `/Users/kythong/coach/ml` | The image sets `/app/ml`. Left set, `rallySegInstalled()` is false and the setup screen 503s. |
| `RALLY_SEG_DEBUG` | `1` | Renders an annotated debug video per run. Minutes of CPU and hundreds of MB written to a container with no volume. Fine locally, waste in production. |

```bash
fly secrets unset CV_PYTHON RALLY_SEG_DIR RALLY_SEG_DEBUG
```

`RALLY_SEGMENTER=rally_seg` **does** carry over now that `ml/` ships in the
image. It did not before, which is the whole reason the first deploy came up
without automatic court setup.

Everything else in `.env.local` carries over as-is, except `NEXT_PUBLIC_SITE_URL`,
which becomes the real domain.

### 5. Deploy the container

```bash
npm run deploy          # or: npm run deploy -- -n   to see what it would run
```

`scripts/deploy.sh` reads the three `NEXT_PUBLIC_*` build args out of
`.env.local`, refuses to deploy while any laptop-only secret is still set on
the server, and checks the site answers 200 afterwards. The long-hand below is
what it runs, kept because it is what to fall back to when the script is in the
way.

`--ha=false` is NOT needed on a routine deploy, contrary to what the fly.toml
comment used to imply. It applies when an app is first created or has been
scaled to zero; an app already running one Machine keeps running one.

```bash
fly launch --no-deploy          # once; it reads fly.toml
```

Then the secrets. `NEXT_PUBLIC_*` values are inlined **at build time**, so
they go in as build args, not only as runtime secrets:

```bash
fly secrets set \
  NEXT_PUBLIC_SUPABASE_URL=... \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  NEXT_PUBLIC_SITE_URL=https://your-domain \
  SUPABASE_SERVICE_ROLE_KEY=... \
  R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
  ANTHROPIC_API_KEY=... \
  ROBOFLOW_API_KEY=...

fly deploy --ha=false \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  --build-arg NEXT_PUBLIC_SITE_URL=https://your-domain
```

Non-secret runtime settings (`VISION_PROVIDER=roboflow`, `PLAYER_DETECTION=local`,
`VISION_FPS`, `BALL_MODEL_PATH`, `NET_RALLIES`, `RALLY_SEG_DEBUG`…) can go in
the `[env]` block of `fly.toml` instead, where you can read them in a diff.

**Railway / Render** are the same picture: point them at the Dockerfile, set
the same variables, and make sure the service is a always-on web service
rather than something that scales to zero.

### 6. Check it end to end

Sign up on the deployed domain, upload a short clip, run it. Watch
`fly logs` — the pipeline logs every stage. The first run downloads nothing
(the weights are in the image), so if it stalls it is ffmpeg, Python or
memory, and the log says which.

---

## What to expect, honestly

**Speed.** Same code, so the same order of magnitude as your laptop, adjusted
for CPU. A `performance-2x` (2 vCPU) is slower than an M-series laptop.
Ball detection dominates; `BALL_FPS_CAP` is the dial that actually moves it.

**Cost.** One always-on `performance-2x` on Fly is roughly $25–30/month. R2
charges for storage but not egress, which is why the video lives there — the
pipeline re-downloads the full clip on every run. Anthropic is a fraction of
a cent per analysis on Haiku. Supabase free tier is fine until you have real
users.

**GPU.** Not worth it yet. It would cut ball detection substantially, but you
would be paying for an idle GPU between uploads, and the honest bottleneck
right now is ball coverage (~26% of frames on your footage), which is a model
and camera problem, not a compute one.

---

## Known limitations of this deploy

1. **One machine only** — and Fly will try to give you two. It creates a
   second for high availability on first deploy unless you pass `--ha=false`.
   A run lives in one process's memory and writes its overlay to that
   machine's disk, so with two machines requests round-robin and about half
   the overlay requests hit the machine that never rendered it. Check with
   `fly status`; fix with `fly scale count 1`. Scale UP (bigger VM), never
   out, until there is a queue.
2. **A redeploy kills runs in flight.** They land back at `processing` and are
   restartable after the staleness window. Deploy when nothing is running.
3. **Overlays and setup frames do not survive a redeploy.** Both regenerate on
   the next run. The proper fix is uploading them to R2;
   `src/lib/vision/debug-video-store.ts` was written so that is a one-file
   change.
4. **No queue.** The right next step when this stops being enough is moving
   `runPipelineV2()` behind a durable queue and running the worker as a
   separate process — the call signature is already the right shape for it.
