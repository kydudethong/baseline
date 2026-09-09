# One image with everything a run needs: Node for the app, Python for the CV
# scripts, ffmpeg for audio and frame extraction, and the YOLO weights.
#
# WHY ONE CONTAINER AND NOT VERCEL. src/lib/analysis/pipeline-v2.ts kicks the
# run off and lets it continue on the Node event loop after the HTTP response
# has already gone back. That is fine in a process that stays alive and fatal
# on a platform that freezes the process the moment the response is sent: the
# run would die part-way and the row would sit at "processing" until the
# staleness window in the process route expires. Serverless also has no
# ffmpeg, no python, no torch and a request timeout measured in seconds, while
# a real clip takes minutes. So: a long-lived container.

# ---- deps ----------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ---------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* values are inlined at build time, so they have to be present
# here, not only at runtime. Pass them with --build-arg.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build

# ---- runtime -------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
# HOSTNAME=0.0.0.0 is REQUIRED, not cosmetic. Next's standalone server.js
# binds to whatever HOSTNAME says and defaults to localhost, which means it
# only accepts connections from inside the container — Fly's proxy is outside
# it, so every request times out while the machine sits there reporting
# "started". This is the standard container footgun for `output: standalone`.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ffmpeg \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# A venv rather than --break-system-packages, so CV_PYTHON points at one
# interpreter that definitely has the packages. cv-scripts.ts warns about
# exactly this ambiguity.
ENV VIRTUAL_ENV=/opt/venv CV_PYTHON=/opt/venv/bin/python
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# CPU-only torch first, or ultralytics drags in ~2.5GB of CUDA wheels that a
# CPU box cannot use and that blow past most image size limits.
#
# pip is upgraded FIRST and that line is not optional. Debian ships pip 23.x,
# which mis-compares the wheel name "typing_extensions" against the requested
# "typing-extensions", decides the wheel is wrong, and falls back to building
# the sdist — whose build backend (flit_core) does not exist on the PyTorch
# index, because --index-url REPLACES PyPI rather than adding to it. The build
# then dies on "No matching distribution found for flit_core". A current pip
# matches the normalised name, takes the wheel, and never needs a build
# backend at all.
#
# Adding --extra-index-url https://pypi.org/simple would also silence it, and
# would be a mistake: pip would then be free to pick PyPI's `torch`, which is
# the CUDA build, and the CUDA bloat this avoids comes straight back.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && pip install --no-cache-dir -r requirements.txt

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/cv ./scripts/cv
COPY --from=build /app/models ./models

# rally_seg, the pipeline behind the setup screen's automatic court fit and
# player detection. It used to live outside this repo (~/coach/ml on the
# laptop), which is why the first deploy came up without it: RALLY_SEG_DIR
# defaulted to a path under $HOME that exists on Ky's machine and nowhere
# else, rallySegInstalled() returned false, and /api/analyses/[id]/setup-frame
# answered 503 on every upload.
#
# RALLY_SEG_PYTHON is not optional either. pythonBin() looks for a .venv
# inside RALLY_SEG_DIR and falls back to bare `python3` when there isn't one —
# and in this image `python3` is the system interpreter, which has none of the
# packages. Point it at the same venv everything else uses.
COPY --from=build /app/ml ./ml
ENV RALLY_SEG_DIR=/app/ml RALLY_SEG_PYTHON=/opt/venv/bin/python

# yt-dlp is installed into the venv, which is on PATH here — but naming it
# explicitly means the route does not depend on PATH order inside whatever
# shell Node happens to spawn. ffmpeg is already installed above, which
# yt-dlp needs for --download-sections to cut on exact timestamps.
ENV YTDLP_PATH=/opt/venv/bin/yt-dlp

# Written at runtime. Mount a volume here if you want overlays and setup
# frames to survive a redeploy; without one they regenerate on the next run.
RUN mkdir -p public/rally-debug public/setup-frames

EXPOSE 3000
CMD ["node", "server.js"]
