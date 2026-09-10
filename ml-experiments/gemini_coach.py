#!/usr/bin/env python3
"""
Can a VLM coach from the debug overlay?

The experiment: hand Gemini the annotated video, a legend explaining what
every mark on it means, and the same job the pipeline's own coaching call
does. Then compare.

WHY THE OVERLAY AND NOT RAW FOOTAGE. The overlay carries the pipeline's court
fit, ball track, net band, player identity and pose already drawn in, so the
model does not have to infer geometry that VLMs are weak at. The cost is
circularity: the model cannot catch a wrong homography it is being shown as
ground truth. That is why the legend ends by asking it to report where the
overlay disagrees with the footage -- the disagreements are the part a raw-
footage run could find and this one otherwise could not.

WHAT IS BEING MEASURED. Not "is the coaching good" -- that needs a human.
Three things a script can check:

  1. Does it stay inside what the data supports? The pipeline forbids claims
     about paddle face, path, spin and contact point, because nothing sees the
     paddle. A model that makes them anyway is producing confident fiction,
     and that is disqualifying however well it reads.
  2. Does it agree with the pipeline on checkable facts -- rally count,
     contact count, which player is the subject?
  3. Does it notice when the overlay is wrong?

Usage:
  export GEMINI_API_KEY=...
  python ml-experiments/gemini_coach.py <debug-video.mp4> \
      [--results shot-results/<clip>] \
      [--model <id>] [--out gemini-read.json]
  python ml-experiments/gemini_coach.py --list-models <any.mp4>

Requires: pip install google-genai
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

LEGEND = Path(__file__).with_name("overlay_legend.md")

# Phrases that describe something no part of this pipeline can observe. Kept
# as a list rather than a vibe so the check is reproducible and arguable: if a
# phrase here is wrong, it can be removed and the run redone.
FORBIDDEN = [
    r"\bpaddle face\b", r"\bface (?:was |is )?(?:open|closed|square)\b",
    r"\bpaddle (?:angle|path|swing path)\b",
    r"\btop ?spin\b", r"\bback ?spin\b", r"\bside ?spin\b", r"\bslice\b",
    r"\bsweet spot\b", r"\bcontact point on the (?:face|paddle)\b",
    r"\bgrip\b", r"\bcontinental\b", r"\beastern grip\b",
]

TASK = """
YOUR TASK

You are an expert pickleball coach. Watch the whole clip and write a coaching
read for the player in the GOLD box labelled YOU.

Rules:
- Comment only on what you can actually see. If the footage or the overlay
  does not support a claim, do not make it.
- Prefer patterns that repeat over single moments. Say which rally and roughly
  what time you are talking about.
- Do not restate the overlay back at the reader. Synthesise.
- Keep it focused: 1-2 strengths, one priority fix, 1-2 secondary points.
- Encouraging but honest. Not a hype machine.

Return JSON only, in the schema you were given.

The overlay_audit field is not optional and not a formality: list every place
the drawn overlay disagreed with the footage underneath -- a court outline off
the painted lines, a ball marker where no ball is, a skeleton on the wrong
person, a rally banner while nobody is playing. If you saw none, return an
empty list and say so in data_gaps.
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "strengths": {"type": "array", "items": {"type": "string"}},
        "top_priority_fix": {
            "type": "object",
            "properties": {
                "issue": {"type": "string"},
                "why_it_matters": {"type": "string"},
                "evidence": {"type": "string"},
            },
            "required": ["issue", "why_it_matters", "evidence"],
        },
        "secondary_observations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"issue": {"type": "string"}, "evidence": {"type": "string"}},
                "required": ["issue", "evidence"],
            },
        },
        "drill_recommendation": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "target": {"type": "string"},
                "reps_duration": {"type": "string"},
            },
            "required": ["name", "target", "reps_duration"],
        },
        "observed_counts": {
            "type": "object",
            "description": "What you counted, so it can be checked against the pipeline.",
            "properties": {
                "rallies": {"type": "integer"},
                "contacts_by_you": {"type": "integer"},
                "net_crossings": {"type": "integer"},
            },
            "required": ["rallies", "contacts_by_you", "net_crossings"],
        },
        "overlay_audit": {
            "type": "array",
            "description": "Where the overlay disagreed with the footage.",
            "items": {
                "type": "object",
                "properties": {
                    "at_seconds": {"type": "number"},
                    "what_was_drawn": {"type": "string"},
                    "what_the_footage_shows": {"type": "string"},
                },
                "required": ["at_seconds", "what_was_drawn", "what_the_footage_shows"],
            },
        },
        "data_gaps": {"type": "string"},
    },
    "required": [
        "strengths", "top_priority_fix", "secondary_observations",
        "drill_recommendation", "observed_counts", "overlay_audit", "data_gaps",
    ],
}


def upload_and_wait(client, path: Path, timeout_s: float = 600.0):
    """Upload the video and block until Gemini has finished processing it.

    Generating against a file still in PROCESSING fails with an opaque error,
    and video processing is measured in minutes for a long clip -- so this
    polls rather than sleeping a fixed amount and hoping.
    """
    print(f"uploading {path.name} ({path.stat().st_size / 1e6:.1f} MB)…", file=sys.stderr)
    f = client.files.upload(file=str(path))
    started = time.time()
    while getattr(f.state, "name", str(f.state)) == "PROCESSING":
        if time.time() - started > timeout_s:
            raise SystemExit(f"still PROCESSING after {timeout_s:.0f}s — giving up")
        time.sleep(3)
        f = client.files.get(name=f.name)
        print(f"  … {time.time() - started:5.0f}s", file=sys.stderr, end="\r")
    state = getattr(f.state, "name", str(f.state))
    if state != "ACTIVE":
        raise SystemExit(f"upload ended in state {state}, not ACTIVE")
    print(f"\nready after {time.time() - started:.0f}s", file=sys.stderr)
    return f


def usable_models(client) -> list[str]:
    """Models this key can actually call generateContent on.

    Asked of the API rather than hardcoded, because model names move and a
    stale default produces a 404 whose message does not say what to use
    instead. The account's own list is the only authority on this.
    """
    names = []
    try:
        for m in client.models.list():
            actions = getattr(m, "supported_actions", None) or getattr(m, "supported_generation_methods", None) or []
            if not actions or "generateContent" in actions:
                names.append(m.name.replace("models/", ""))
    except Exception as exc:  # pragma: no cover - depends on the SDK version
        return [f"(could not list models: {exc})"]
    return names


def check_forbidden(read: dict) -> list[str]:
    """Claims about things nothing in this pipeline can see."""
    blob = json.dumps(read).lower()
    return [p for p in FORBIDDEN if re.search(p, blob)]


def pipeline_counts(results_dir: Path) -> dict:
    """What the pipeline counted, from the files run-shots.ts actually writes.

    Reads shots.json and ball.json rather than a facts.json, because no
    facts.json is produced -- an earlier version of this asked for one and
    would have reported "could not be checked" forever without ever saying
    the file it wanted does not exist.
    """
    out: dict = {}
    shots_path = results_dir / "shots.json"
    if shots_path.exists():
        shots = json.loads(shots_path.read_text())
        out["shots"] = len(shots)
        # rallyIdx is per-rally, so the distinct count IS the rally count.
        out["rallies"] = len({s.get("rallyIdx") for s in shots if s.get("rallyIdx") is not None})
    ball_path = results_dir / "ball.json"
    if ball_path.exists():
        ball = json.loads(ball_path.read_text())
        out["contacts"] = len(ball.get("contacts", []))
    return out


def compare_counts(read: dict, results_dir: Path | None) -> list[str]:
    """The model's counts against the pipeline's, where both exist."""
    if not results_dir:
        return ["no --results given, so counts could not be checked"]
    if not results_dir.exists():
        return [f"{results_dir} does not exist — run scripts/run-shots.ts on this clip first"]
    truth = pipeline_counts(results_dir)
    if not truth:
        return [f"{results_dir} has no shots.json or ball.json to compare against"]
    got = read.get("observed_counts", {})
    out = []
    for key, mine in (("rallies", got.get("rallies")), ("contacts", got.get("contacts_by_you"))):
        if key not in truth:
            continue
        n = truth[key]
        # Contacts BY THE SUBJECT are a subset of all contacts, so an exact
        # match is not expected and would be suspicious; what matters is that
        # the model is in the same world, not that it agrees to the unit.
        note = "  (pipeline counts BOTH sides)" if key == "contacts" else ""
        verdict = "MATCH" if mine == n else ("close" if mine is not None and abs(mine - n) <= max(1, n * 0.25) else "DIFFER")
        out.append(f"{key}: model {mine} vs pipeline {n}  {verdict}{note}")
    return out or ["nothing comparable in the results directory"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--results", default=None,
                    help="shot-results/<clip> directory, to check the model's counts "
                         "against what the pipeline found")
    # No default that pretends to know today's model names -- see
    # usable_models(). --list-models prints what this key can call.
    ap.add_argument("--model", default=None,
                    help="model id; omit to use the newest Gemini this key can call")
    ap.add_argument("--list-models", action="store_true",
                    help="print the models this key can call, and exit")
    ap.add_argument("--out", default="gemini-read.json")
    ap.add_argument("--legend", default=str(LEGEND))
    args = ap.parse_args()

    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        print("Set GEMINI_API_KEY (https://aistudio.google.com/apikey)", file=sys.stderr)
        return 2

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        print("pip install google-genai", file=sys.stderr)
        return 2

    video = Path(args.video)
    if not video.exists():
        print(f"no such file: {video}", file=sys.stderr)
        return 2
    legend = Path(args.legend).read_text(encoding="utf-8")

    client = genai.Client(api_key=key)

    if args.list_models:
        for name in usable_models(client):
            print(name)
        return 0

    model = args.model
    if not model:
        # Prefer a Gemini "pro" -- the video reasoning here is not a job for a
        # flash-tier model -- and fall back to whatever exists rather than
        # failing on a name this script guessed.
        names = usable_models(client)
        pro = [n for n in names if "gemini" in n and "pro" in n and "vision" not in n]
        model = sorted(pro)[-1] if pro else (names[0] if names else "")
        if not model:
            print("no usable model found for this key; try --list-models", file=sys.stderr)
            return 2
        print(f"no --model given, using {model}", file=sys.stderr)

    f = upload_and_wait(client, video)

    print(f"asking {model}…", file=sys.stderr)
    started = time.time()
    try:
        resp = client.models.generate_content(
            model=model,
        contents=[f, legend + "\n\n" + TASK],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=SCHEMA,
            ),
        )
    except Exception as exc:
        text = str(exc)
        # A 404 means the model name is wrong, and the API's own message does
        # not say what to use instead. Say it.
        if "404" in text or "NOT_FOUND" in text:
            print(f"\n{model} is not a model this key can call. Available:", file=sys.stderr)
            for name in usable_models(client):
                print(f"  {name}", file=sys.stderr)
            return 2
        # "limit: 0" on a free-tier quota is not rate limiting -- it is a model
        # this key may not call AT ALL without billing. Retrying, at any
        # spacing, will never succeed, and the API's own "please retry in 26s"
        # says the opposite.
        if "RESOURCE_EXHAUSTED" in text or "429" in text:
            zero = "limit: 0" in text
            print(f"\n{model}: quota exhausted." if not zero else
                  f"\n{model} has NO free-tier quota (limit: 0) — it cannot be called "
                  "on this key at all without billing enabled.", file=sys.stderr)
            if zero:
                print("Retrying will not help, whatever the error's 'retry in Ns' says.\n"
                      "Either enable billing at https://aistudio.google.com/apikey, or pick a\n"
                      "model that has free-tier quota — usually a flash tier:", file=sys.stderr)
                for name in usable_models(client):
                    if "flash" in name:
                        print(f"  --model {name}", file=sys.stderr)
            print("\nNOT falling back automatically: which model produced a read is the "
                  "thing being measured,\nand silently swapping it would make the result "
                  "meaningless.", file=sys.stderr)
            return 2
        raise
    elapsed = time.time() - started
    read = json.loads(resp.text)

    Path(args.out).write_text(json.dumps(read, indent=2), encoding="utf-8")

    print(f"\n--- {model} in {elapsed:.0f}s -> {args.out}\n", file=sys.stderr)
    print(f"PRIORITY FIX: {read['top_priority_fix']['issue']}")
    print(f"  evidence:   {read['top_priority_fix']['evidence']}")
    for s in read.get("strengths", []):
        print(f"STRENGTH: {s}")

    audit = read.get("overlay_audit", [])
    print(f"\nOVERLAY DISAGREEMENTS: {len(audit)}")
    for a in audit:
        print(f"  {a['at_seconds']:.1f}s  drawn: {a['what_was_drawn']}")
        print(f"         footage: {a['what_the_footage_shows']}")

    bad = check_forbidden(read)
    print(f"\nUNSUPPORTABLE CLAIMS: {len(bad)}")
    for p in bad:
        print(f"  matched /{p}/  <- nothing in this pipeline can see that")
    if not bad:
        print("  none — it stayed inside what the data supports")

    print("\nCOUNT CHECK")
    for line in compare_counts(read, Path(args.results) if args.results else None):
        print(f"  {line}")

    usage = getattr(resp, "usage_metadata", None)
    if usage:
        print(f"\ntokens: {getattr(usage, 'total_token_count', '?')} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
