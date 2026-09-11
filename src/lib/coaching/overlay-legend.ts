/**
 * What the overlay draws, as the analyst is told it.
 *
 * A TS constant rather than a file read at runtime: the container does not
 * carry ml-experiments/, and a coaching run must not depend on a markdown
 * file being somewhere. ml-experiments/overlay_legend.md stays as the
 * editable copy for the offline harnesses; if they drift, this one is what
 * production uses.
 */
export const OVERLAY_LEGEND = `# What the Baseline debug overlay draws

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
  confirmed crossing, flashed for a third of a second. Not drawn in every
  render: where you are being asked to judge rallies yourself, crossings are
  withheld too, because they are the evidence a rally is built from.

## Players

- **Green box with an id** — a tracked player who survived the court gate.
- **Gold box labelled YOU** — the player this coaching read is for. Only this
  player's technique should be coached; the others are context.
- **Stick figure** — pose, drawn only from keypoints the model actually saw,
  so an incomplete figure means low confidence, not a missing limb. Limb
  colours: torso green, **right arm gold**, **left arm blue**, legs paler
  versions of the same, head grey-blue. The arms are coloured differently on
  purpose — a forehand and a backhand look identical otherwise.

## There is no paddle, and no paddle is drawn

Nothing in this pipeline detects a paddle. Earlier versions drew an estimate
of one, derived from the forearm; that is gone.

So you may say things about **where the arm was, how big the swing was, and
how high the contact was.** You may **NOT** say anything about the paddle's
**face angle, its path through the ball, spin, or where on the face contact
was made.** That information does not exist in this video. If you cannot
tell, say you cannot tell.

## The clock, and what is NOT drawn

- **Bottom bar** — the timestamp, \`t=…s\`.
- Some renders also carry a rally banner and a timeline strip. **If you have
  been asked where the rallies are, they are not drawn** — the bar shows only
  the clock, and you are being asked to judge it yourself. An absent banner
  means "not shown", never "no rally is happening".
- Contacts are not marked on the video either. Where a list of contact
  timestamps is supplied alongside, those are measured moments the ball
  visibly changed direction against a player.

## What this means for how you answer

The overlay is the pipeline's belief. Where it visibly disagrees with the
footage — a court outline off the painted lines, a ball marker where no ball
is, a skeleton on the wrong person — that disagreement is itself a finding,
and more valuable than a coaching point built on top of it. Report it.
`;
