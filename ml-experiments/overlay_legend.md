# What the Baseline debug overlay draws

This file IS the prompt fragment sent to the model. Edit it here; the harness
reads it at run time so the wording can be iterated without touching code.

---

You are watching a pickleball match with a computer-vision overlay drawn on
top. The overlay is not part of the footage — it is what an automated pipeline
BELIEVED while analysing this clip. The footage underneath is the evidence;
the overlay is a claim about it, and it is sometimes wrong.

## Court and net

- **Bright blue outline** — the court the pipeline fitted. Four corners, one
  quadrilateral. If this does not sit on the painted lines, every spatial
  claim below it is wrong and you should say so.
- **Dim grey-mauve outline** — the "ball gate": the airspace a ball belonging
  to THIS court may occupy. Balls outside it are treated as another court's.
- **Magenta band labelled NET** — the net as a surface, not a line: a base on
  the ground, the tape above it with its real sag, and a shaded face between.
  A ball inside this band **cannot be assigned to a side** — from behind a
  baseline the net stands between the camera and the far court — so the band
  is exactly where the crossing test declines to guess.

## Ball

- **Orange line** — the ball's path over roughly the last second.
- **Amber circle, FILLED** — the ball was actually detected in this frame.
- **Amber circle, HOLLOW** — interpolated. The detector did **not** see the
  ball; the position is inferred between two real observations. Treat a hollow
  circle as a guess, and do not build a claim about ball position on one.
- **Magenta banner across the top: "BALL CROSSED NET → far / near"** — a
  confirmed crossing, flashed for a third of a second.

## Players

- **Green box with an id** — a tracked player who survived the court gate.
- **Gold box labelled YOU** — the player this coaching read is for. Only this
  player's technique should be coached; the others are context.
- **Stick figure** — pose, drawn only from keypoints the model actually saw,
  so an incomplete figure means low confidence, not a missing limb. Limb
  colours: torso green, **right arm gold**, **left arm blue**, legs paler
  versions of the same, head grey-blue. The arms are coloured differently on
  purpose — a forehand and a backhand look identical otherwise.

## Paddle — read this twice

- **Pink handle-and-ellipse shape labelled "paddle (from arm)"** — this is
  **NOT a detected paddle.** No paddle is detected anywhere in this pipeline.
  It is drawn one paddle-length from the wrist along the forearm, at the
  forearm's angle, scaled by the player's shoulder width.
- You may therefore say things about **where the arm was, how big the swing
  was, and how high the contact was.**
- You may **NOT** say anything about the paddle's **face angle, its path
  through the ball, spin, or where on the face contact was made.** That
  information does not exist in this video. If you cannot tell, say you
  cannot tell.
- **"no paddle found here"** means the arm was not readable at that moment,
  not that the player had no paddle.

## Contacts and rallies

- **Bright green circle + "CONTACT (audio+ball)"** — a paddle strike both
  heard in the audio and agreed with by the ball's trajectory. These are the
  most reliable contact markers in the video.
- **Bottom bar** — `RALLY n  start–end s   t=…s`, with a green dot while a
  rally is live and grey when the clip is between points ("no rally").
- **Thin strip above the bar** — every rally across the whole clip in green,
  with a white playhead showing where you are.

## What this means for how you answer

The overlay is the pipeline's belief. Where it visibly disagrees with the
footage — a court outline off the painted lines, a ball marker where no ball
is, a skeleton on the wrong person — that disagreement is itself a finding,
and more valuable than a coaching point built on top of it. Report it.
