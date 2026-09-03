# Rally IQ — Phase 1: Application Foundation & Upload Pipeline

Status: **builds and runs.** `npx tsc --noEmit`, `npx eslint .`, and `npx next build` all pass clean.

## 1. Files created

```
supabase/migrations/
  0001_init.sql              profiles, analyses, videos, state machine, RLS
  0002_storage.sql           private `videos` storage bucket + storage RLS

src/proxy.ts                 Next.js 16 proxy (session refresh + route guard)
src/lib/
  env.ts                     centralised env var access (throws helpfully, not at import time)
  supabase/
    client.ts                browser Supabase client
    server.ts                server Supabase client (Server Components/Actions/Routes) + service-role client
    proxy.ts                 session-refresh logic used by src/proxy.ts
  db/
    types.ts                 hand-written Database types (Row/Insert/Update per table)
    analyses.ts               data-access functions (list/get/create/attach/update)
  video/
    validation.ts             shared client+server upload validation (type/size)
    ffmpeg.ts                  ffprobe/ffmpeg process wrappers
    processor.ts                VideoProcessor abstraction
  vision/
    types.ts                    VisionProvider abstraction + CV data shapes
    mock-provider.ts             MockVisionProvider (labeled placeholder data)
    index.ts                     provider factory
  analysis/
    types.ts                     AnalysisEngine abstraction + result shape
    mock-engine.ts                MockAnalysisEngine (labeled placeholder data)
    pipeline.ts                   orchestrates VideoProcessor + VisionProvider + AnalysisEngine
    index.ts                      engine factory
  auth/schema.ts                zod schemas for signup/login

src/app/
  page.tsx                      landing page
  layout.tsx                    root layout
  globals.css                   Tailwind v4 + system font stack
  login/page.tsx, signup/page.tsx
  actions/auth.ts               server actions: signup, login, logout
  auth/callback/route.ts        email-confirmation link handler
  dashboard/
    layout.tsx                  auth-gated layout + logout
    page.tsx                    analysis list
    new/page.tsx                upload flow
    [analysisId]/page.tsx       analysis detail: status, metadata, result
  api/analyses/
    route.ts                    POST create analysis, GET list
    [id]/video/route.ts         POST attach uploaded video's metadata
    [id]/process/route.ts       POST run the pipeline

src/components/
  landing/{Nav,Hero,HowItWorks,Features,Footer}.tsx
  auth/AuthForm.tsx
  upload/VideoUploader.tsx      resumable (TUS) upload UI
  dashboard/{StatusBadge,ProcessingControls,AnalysisResultPanel}.tsx

.env.example
```

Modified from the `create-next-app` scaffold: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `.gitignore` (un-ignore `.env.example`).

## 2. Database schema

Three tables, all UUID-keyed, all RLS-enabled (`supabase/migrations/0001_init.sql`):

- **`profiles`** — one row per `auth.users` row, created automatically by a trigger on signup.
- **`analyses`** — the parent record for one uploaded-game analysis. Carries the state machine (`status: uploaded | queued | processing | completed | failed`), an `error_message`, and a `result jsonb` column holding the `AnalysisEngine` output (always `{"source": "mock", ...}` in Phase 1).
- **`videos`** — metadata for the single file backing an analysis (`analysis_id` is `unique`, so it's a strict 1:1). Bytes live in Storage; this row only has the pointer (`storage_path`) plus probed metadata (duration, resolution, fps, codec).

`0002_storage.sql` creates a **private** `videos` bucket (2 GiB limit, video MIME types only) and storage RLS policies scoped by the first path segment (`${userId}/...`), so a user can only read/write their own objects.

Relationship: **user → analysis → video**, exactly as specified. `videos` and `analyses` both carry `user_id` directly (denormalized) so RLS policies stay simple single-column checks instead of subqueries.

## 3. Environment variables

See `.env.example`. Required to run:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY     (server-only; reserved for future background-job use, not on the request path yet)
NEXT_PUBLIC_SITE_URL          (defaults to http://localhost:3000)
```

Nothing is hard-coded. `src/lib/env.ts` throws a clear, actionable error if a value is read and missing — but only at request time, so `next build` succeeds even with no `.env.local` present.

## 4. Commands

```bash
npm install

# 1. Create a Supabase project, then run the migrations against it:
#    paste supabase/migrations/0001_init.sql and 0002_storage.sql into
#    the SQL editor, in order (or `supabase db push` if you use the CLI)

cp .env.example .env.local   # fill in your project's URL + anon key + service role key

npm run dev                  # http://localhost:3000
npm run build && npm start   # production build

npx tsc --noEmit             # typecheck
npx eslint .                 # lint
```

## 5. What works

- Landing page with the specified primary/secondary CTAs, not gated behind auth.
- Sign up (email confirmation aware), log in, log out, protected `/dashboard/*` (both an optimistic `proxy.ts` redirect and a real `supabase.auth.getUser()` check in the layout — belt and suspenders, per Next's own auth guidance).
- Dashboard lists a user's analyses with live status badges; empty state prompts the first upload.
- Upload flow: client-side type/size validation → resumable (TUS) upload straight to a private Supabase Storage bucket (progress bar + cancel button, both wired to the real upload, not simulated) → server-side re-validation → analysis record created and linked.
- Processing: real `ffprobe` metadata extraction, real validation (duration/resolution gates), real `ffmpeg` frame sampling — all through `VideoProcessor`. The state machine moves `uploaded → queued → processing → completed/failed` and is visible on the detail page, which polls while a run is in flight.
- CV and AI-analysis stages run through `MockVisionProvider` / `MockAnalysisEngine`. Their output is structurally identical to what a real provider would return, and every result is stamped `source: "mock"` — the UI shows an explicit "development data" banner rather than presenting it as real.
- RLS verified structurally (every table and the storage bucket scope to `auth.uid()`); not yet exercised against a live project since none is linked to this sandbox.

## 6. What is intentionally not implemented yet

- **Real computer vision.** `RoboflowVisionProvider` doesn't exist — `VisionProvider` is the seam it will slot into (same for `detectObjects`/`trackObjects`/`analyzeFrame`).
- **Real AI analysis/coaching.** Same story for `AnalysisEngine` — an LLM coaching pass is a later phase.
- **Background job queue.** `runPipeline()` runs synchronously inside the `POST /api/analyses/[id]/process` request. That's fine for Phase 1's ffprobe + a handful of sampled frames, but a real CV pass on a full match will need a worker/queue (Supabase Edge Functions, a queue table + cron, or an external worker) — `createServiceRoleClient()` in `server.ts` already exists for that future without a session in the request.
- **Payments, social features, mobile app** — per the brief, not started.
- **Custom-trained CV model** — not started; `RoboflowVisionProvider` is expected to call a hosted Roboflow workflow, not a self-trained model.
- **Realtime status updates.** The detail page polls every 3s while `queued`/`processing`; a Supabase Realtime subscription would remove the polling but wasn't necessary for a synchronous Phase-1 pipeline.

## 7. Recommended next phase

Wire `RoboflowVisionProvider` behind the existing `VisionProvider` interface (real `detectObjects`/`trackObjects` against a Roboflow workflow), and move `runPipeline()` off the request thread into a background job so a multi-minute CV pass on a full match doesn't sit inside an HTTP request. Everything downstream — the DB schema, the state machine, the detail page, `AnalysisEngine`'s interface — should not need to change shape, only get real implementations behind the seams Phase 1 built.
