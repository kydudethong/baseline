#!/usr/bin/env python3
"""
Gemini as the analyst: rallies, shot types, playstyle, skill ratings,
coaching and drills — from the overlay plus what the CV layer measured.

THE DIVISION OF LABOUR THIS TESTS. The CV pipeline keeps the things it can
measure and a model cannot: where the court is, where the players are, where
the ball is frame by frame, WHEN a contact happened (a real direction change
in the ball's flight) and what the body did at that instant (knee angle,
wrist speed, shoulder rotation, in the player's own shoulder widths).

Everything that is a judgment rather than a measurement moves here: which
rally a contact belongs to, what kind of shot it was, how the player plays,
how good they are at each skill, and what to practise.

WHY THE MEASURED JSON GOES IN TOO. Asked from video alone this model invented
two rallies past the end of a 101-second clip. Asked to critique an overlay it
got all seven right. The difference was scaffolding, so it gets scaffolding:
contact timestamps it can trust, positions in court coordinates, and body
measurements it could never take by eye. It decides what they MEAN.

Deliberately NOT given: our rally boundaries or our shot types. Those are the
answers under test -- handing them over would produce agreement rather than a
second opinion.

Usage:
  python ml-experiments/gemini_analyst.py <overlay.mp4> --results shot-results/<clip> \\
      [--self player_2] [--model gemini-3.8-flash] [--out analyst.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

SKILLS = ["dinking", "kitchen", "hands", "volleys", "resets", "defense",
          "transition", "positioning", "serve", "return", "thirdshot",
          "offense", "selection", "iq", "consistency"]

SHOT_TYPES = ["serve", "return", "third_shot_drop", "third_shot_drive", "dink",
              "drop", "reset", "drive", "volley", "speed_up", "overhead",
              "lob", "block", "unknown"]


# The pipeline stores court positions NORMALISED 0-1, not in feet: x across
# the court, y along it with the NEAR baseline at 1 and the far at 0, netY at
# 0.5 (shots.ts courtFrameFor "full"). Converted here rather than described,
# because a coach reads "3 feet behind the baseline" and cannot do anything
# with 0.79 -- and because an earlier version of this file claimed the stored
# numbers were already feet, which would have made every distance the model
# stated wrong by a factor of twenty.
COURT_W_FT = 20.0
COURT_L_FT = 44.0


def to_feet(p: dict | None) -> dict | None:
    if not p or p.get("x") is None or p.get("y") is None:
        return None
    return {
        "x_ft": round(float(p["x"]) * COURT_W_FT, 1),
        # Flipped so y grows AWAY from the camera, which is how anyone
        # describes a court: 0 at the near baseline, 44 at the far one.
        "y_ft": round((1.0 - float(p["y"])) * COURT_L_FT, 1),
    }


def measured_facts(results: Path, self_id: str | None) -> dict:
    """What the CV layer measured, with our judgments stripped out.

    rallyIdx and type are REMOVED from every contact on purpose. They are the
    two things being asked for; leaving them in would be handing over the
    answer sheet and calling the agreement a result.
    """
    shots = json.loads((results / "shots.json").read_text())
    quality = json.loads((results / "quality.json").read_text())
    ball = json.loads((results / "ball.json").read_text())

    contacts = []
    for s in sorted(shots, key=lambda x: x.get("t") or 0):
        c = {
            "t": round(float(s["t"]), 2),
            "player": s.get("playerId"),
            "hit_from": to_feet(s.get("hitCourt")),
            "landed_at": to_feet(s.get("landingCourt")),
            "speed_mps": s.get("speedMpsApprox"),
            "bounced_before": s.get("bouncedBefore"),
        }
        m = s.get("mechanics")
        if m:
            # Only the fields a coach can act on. samples/missing/confidence
            # are for our own honesty accounting, not for the read.
            c["body"] = {k: v for k, v in m.items()
                         if k not in ("samples", "missing") and v is not None}
        contacts.append({k: v for k, v in c.items() if v is not None})

    q = quality.get("quality", {})
    return {
        "clip_seconds": round(float(ball.get("durationSeconds", 0)), 1),
        "subject_player": self_id,
        "ball_coverage": q.get("ballCoverage"),
        "court_confidence": q.get("courtCalibrationConfidence"),
        "players_tracked": q.get("tracksProduced"),
        "contacts": contacts,
        "units": {
            "hit_from / landed_at": (
                "FEET. x runs across the court, 0 to 20. y runs away from the camera: "
                "0 is the near baseline (closest to the camera), 22 is the net, 44 is the "
                "far baseline. The kitchen line is 7ft either side of the net, so y=15 "
                "and y=29. Values slightly outside 0-44 mean the ball was struck or "
                "landed just past a baseline."
            ),
            "knee_angle_deg": "180 is a straight leg, 140 a real bend",
            "contact_height_torsos": "0 at the shoulder line, negative below",
            "reach_backswing_followthrough": "the player's own shoulder widths",
            "wrist_speed": "shoulder widths per second, over the 0.15s before contact",
        },
    }


PROMPT = """
You are an expert pickleball coach with a computer-vision assistant.

You are given a video with the assistant's overlay drawn on it, and a JSON
record of what it MEASURED. Read the legend carefully — the overlay marks the
court, the ball, the players and their skeletons, and the gold box labelled
YOU is the player you are coaching.

WHAT THE MEASUREMENTS ARE, AND ARE NOT

The contacts list is every moment the ball visibly changed direction against a
player — a real, timed observation, not a guess. Positions are in court FEET.
The `body` block on a contact was measured from dense pose sampling around
that instant, in the player's own shoulder widths so a shot at the far
baseline is directly comparable with one near the camera.

The assistant did NOT decide which rally a contact belongs to, or what kind of
shot it was. That is your job, and it is why you have the video.

YOUR JOB

1. RALLIES. Group the clip into points actually being played. A rally starts
   at the serve and ends when the ball stops being played — not when the
   players stop moving. Walking about and retrieving the ball between points
   is not a rally. Use the video for this; the contact timestamps tell you
   when the ball was struck, which is strong evidence about where a point is.

2. SHOTS. Assign every contact a type from: %(types)s. Say which rally it
   belongs to. If you cannot tell, say unknown rather than guessing — an
   unknown is a correct answer and a wrong label is not.

3. PLAYSTYLE of the subject. How do they actually play? Aggressive or patient,
   where do they win and lose points, what do they reach for under pressure.
   Describe, do not flatter.

4. SKILL RATINGS, 1-10, for whichever of these the clip supports: %(skills)s.
   Rate only what you saw. Omit a skill rather than inventing a number for it,
   and say in `basis` what the rating rests on.

5. COACHING READ. One priority fix, 1-2 strengths, 1-2 secondary points.
   Every one of them must cite evidence: a rally, a time, a measured number.

6. DRILLS. What to practise, tied to the priority fix, with reps or duration.

RULES THAT MATTER MORE THAN COMPLETENESS

- Nothing here sees the PADDLE. You may discuss where the arm was, how big the
  swing was, how high the contact was. You may NOT claim anything about the
  paddle's face angle, its path through the ball, spin, or where on the face
  contact was made.
- Prefer patterns over single shots. Three dinks taken with straight legs is a
  coaching point; one is noise.
- Where a measured number supports you, use it. "Knees at 172 degrees on all
  four of those dinks" beats "you stood too upright".
- If the footage does not support something, say so in data_gaps rather than
  filling the space.
""".strip()


def schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "rallies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "idx": {"type": "integer"},
                        "start_s": {"type": "number"},
                        "end_s": {"type": "number"},
                        "end_reason": {"type": "string"},
                        "winner": {"type": "string", "nullable": True},
                        "confidence": {"type": "number"},
                    },
                    "required": ["idx", "start_s", "end_s", "end_reason", "confidence"],
                },
            },
            "shots": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "t": {"type": "number"},
                        "rally_idx": {"type": "integer"},
                        "player": {"type": "string"},
                        "type": {"type": "string", "enum": SHOT_TYPES},
                        "confidence": {"type": "number"},
                    },
                    "required": ["t", "rally_idx", "player", "type", "confidence"],
                },
            },
            "playstyle": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "tendencies": {"type": "array", "items": {"type": "string"}},
                    "under_pressure": {"type": "string"},
                },
                "required": ["summary", "tendencies", "under_pressure"],
            },
            "skills": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "skill": {"type": "string", "enum": SKILLS},
                        "rating": {"type": "number"},
                        "basis": {"type": "string"},
                    },
                    "required": ["skill", "rating", "basis"],
                },
            },
            "coaching": {
                "type": "object",
                "properties": {
                    "headline": {"type": "string"},
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
                    "secondary": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"issue": {"type": "string"},
                                           "evidence": {"type": "string"}},
                            "required": ["issue", "evidence"],
                        },
                    },
                },
                "required": ["headline", "strengths", "top_priority_fix", "secondary"],
            },
            "drills": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "targets": {"type": "string"},
                        "reps_or_duration": {"type": "string"},
                    },
                    "required": ["name", "targets", "reps_or_duration"],
                },
            },
            "data_gaps": {"type": "string"},
        },
        "required": ["rallies", "shots", "playstyle", "skills", "coaching", "drills", "data_gaps"],
    }


FORBIDDEN = [
    "paddle face", "face was open", "face is open", "paddle angle", "paddle path",
    "topspin", "top spin", "backspin", "back spin", "sidespin", "slice",
    "sweet spot", "grip", "continental",
]


def audit(out: dict, facts: dict) -> list[str]:
    """Checks a script can make. Not "is the coaching good" -- that needs a
    person -- but "is it talking about this clip"."""
    problems = []
    duration = facts["clip_seconds"]
    for r in out.get("rallies", []):
        if r["end_s"] > duration + 0.5 or r["start_s"] < 0 or r["end_s"] <= r["start_s"]:
            problems.append(f"rally {r['idx']} at {r['start_s']:.1f}-{r['end_s']:.1f}s "
                            f"is outside a {duration:.1f}s clip")

    times = {round(c["t"], 2) for c in facts["contacts"]}
    invented = [s for s in out.get("shots", []) if round(s["t"], 2) not in times]
    if invented:
        problems.append(f"{len(invented)} shot(s) at timestamps that are not measured contacts "
                        f"(e.g. {invented[0]['t']}s)")
    missing = len(times) - (len(out.get("shots", [])) - len(invented))
    if missing > 0:
        problems.append(f"{missing} measured contact(s) were given no shot type")

    blob = json.dumps(out).lower()
    for phrase in FORBIDDEN:
        if phrase in blob:
            problems.append(f"claims something nothing here can see: {phrase!r}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="the overlay mp4")
    ap.add_argument("--results", required=True, help="shot-results/<clip>")
    ap.add_argument("--self", dest="self_id", default=None)
    ap.add_argument("--model", default="gemini-3.8-flash")
    ap.add_argument("--out", default="analyst.json")
    ap.add_argument("--max-output-tokens", type=int, default=32000)
    args = ap.parse_args()

    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        print("Set GEMINI_API_KEY", file=sys.stderr)
        return 2
    from google import genai
    from google.genai import types

    results = Path(args.results)
    facts = measured_facts(results, args.self_id)
    legend = (Path(__file__).with_name("overlay_legend.md")).read_text(encoding="utf-8")
    prompt = (legend + "\n\n" + PROMPT % {"types": ", ".join(SHOT_TYPES), "skills": ", ".join(SKILLS)}
              + "\n\nMEASURED FACTS:\n" + json.dumps(facts))

    print(f"{len(facts['contacts'])} measured contacts, "
          f"{sum(1 for c in facts['contacts'] if 'body' in c)} with body measurements", file=sys.stderr)

    client = genai.Client(api_key=key)
    print("uploading…", file=sys.stderr)
    f = client.files.upload(file=args.video)
    while getattr(f.state, "name", str(f.state)) == "PROCESSING":
        time.sleep(3)
        f = client.files.get(name=f.name)

    started, delay, resp = time.time(), 5.0, None
    for attempt in range(1, 5):
        try:
            resp = client.models.generate_content(
                model=args.model, contents=[f, prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=schema(),
                    max_output_tokens=args.max_output_tokens,
                ),
            )
            break
        except Exception as exc:
            msg = str(exc)
            if attempt == 4 or not any(k in msg for k in ("503", "UNAVAILABLE", "500")):
                print(f"\n{args.model}: {msg[:400]}", file=sys.stderr)
                return 3
            print(f"  busy (attempt {attempt}/4) — retrying in {delay:.0f}s", file=sys.stderr)
            time.sleep(delay)
            delay *= 3

    out = json.loads(resp.text)
    Path(args.out).write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\n{args.model} in {time.time() - started:.0f}s -> {args.out}\n", file=sys.stderr)

    print(f"RALLIES ({len(out['rallies'])})")
    for r in out["rallies"]:
        w = f" · {r['winner']}" if r.get("winner") else ""
        print(f"  {r['idx']:>2}  {r['start_s']:6.1f}-{r['end_s']:6.1f}s  {r['end_reason']}{w}")

    types_seen: dict[str, int] = {}
    for s in out["shots"]:
        types_seen[s["type"]] = types_seen.get(s["type"], 0) + 1
    print(f"\nSHOTS ({len(out['shots'])}): "
          + ", ".join(f"{k} {v}" for k, v in sorted(types_seen.items(), key=lambda kv: -kv[1])))

    print(f"\nPLAYSTYLE\n  {out['playstyle']['summary']}")
    for t in out["playstyle"]["tendencies"]:
        print(f"  · {t}")
    print(f"  under pressure: {out['playstyle']['under_pressure']}")

    print(f"\nSKILLS ({len(out['skills'])} rated)")
    for s in sorted(out["skills"], key=lambda x: -x["rating"]):
        print(f"  {s['skill']:<12} {s['rating']:>4.1f}  {s['basis'][:70]}")

    c = out["coaching"]
    print(f"\nCOACHING — {c['headline']}")
    print(f"  FIX: {c['top_priority_fix']['issue']}")
    print(f"       {c['top_priority_fix']['evidence']}")
    for s in c["strengths"]:
        print(f"  +    {s}")
    for s in c["secondary"]:
        print(f"  ~    {s['issue']}")

    print(f"\nDRILLS")
    for d in out["drills"]:
        print(f"  {d['name']} — {d['reps_or_duration']} ({d['targets']})")

    if out.get("data_gaps"):
        print(f"\nDATA GAPS\n  {out['data_gaps']}")

    problems = audit(out, facts)
    print(f"\nAUDIT: {len(problems)} problem(s)")
    for p in problems:
        print(f"  ✗ {p}")
    if not problems:
        print("  every rally inside the clip, every shot on a measured contact, "
              "nothing claimed that cannot be seen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
