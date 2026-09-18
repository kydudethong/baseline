/**
 * What the overlay draws, as the analyst is told it.
 *
 * A TS constant rather than a file read at runtime: the container does not
 * carry ml-experiments/, and a coaching run must not depend on a markdown
 * file being somewhere. ml-experiments/overlay_legend.md stays as the
 * editable copy for the offline harnesses; if they drift, this one is what
 * production uses.
 *
 * THIS FILE IS A PROMISE ABOUT PIXELS, so it has to be edited in the same
 * change as the renderer. It has twice described things that were no longer
 * drawn -- a ball path after ball tracking was removed, and player boxes after
 * they were taken off the overlay -- and a legend that describes absent marks
 * is worse than no legend: the model goes looking for them, fails to find
 * them, and reports that as a finding about the footage.
 */
export const OVERLAY_LEGEND = `# What the Baseline overlay draws

You are watching a pickleball match with a computer-vision overlay drawn on
top. The overlay is not part of the footage — it is what an automated pipeline
MEASURED while analysing this clip. The footage underneath is the evidence;
the overlay is a claim about it, and it is sometimes wrong.

## Who you are coaching

You are told this **twice, by two independent sources**, and the disagreement
between them is information.

1. **A still image is supplied alongside this video.** One frame from this clip
   with ONE player marked — a magenta ring, a chevron above their head, the
   word YOU. That is the subject.
2. **The video carries a box on each tracked player**, labelled with their
   role; the subject's says "You".

The boxes come from the pipeline's own identity tracking, which uses three
things: the colours of a player's head, shirt and legs; their body proportions
taken from the skeleton; and a court gate that excludes anyone standing outside
the lines. It is good. It is not infallible, and it fails in a specific place —
when two players on the same side are close together, overlapping, or one is
hidden behind the other.

So: **trust the still over the boxes when they conflict.** If the player ringed
in the still is clearly not the one wearing the "You" box in a stretch of
footage, the tracker has swapped them, and that is worth reporting as a finding
in its own right — it tells the reader which parts of this read to doubt.

Two things follow:

- **Say so if you lose them.** If the subject is off screen, hidden behind
  another player, or the labels look wrong for a stretch, say that about that
  stretch instead of guessing. An honest gap is worth more than a coaching
  point attached to the wrong person.
- **Only the subject's technique is coached.** The other three are context:
  where they stood, what they did to create the situation. Do not write
  coaching for them.

## Court and net

- **Bright blue outline** — the court, from four corners the player marked
  themselves before the analysis ran. If it does not sit on the painted lines
  the marking was wrong, every spatial claim below it is wrong, and you should
  say so rather than work around it.
- **Magenta band labelled NET** — the net as a surface, not a line: a base on
  the ground, the tape above it with its real sag, and a shaded face between.
  From behind a baseline the net stands between the camera and the far court,
  so the band marks where side-of-net is genuinely undecidable from the image.

## Players

- **Green box with a role name** — a tracked player. At most four exist: the
  roster takes the player count from the sport rather than discovering it, so a
  fifth person on screen is a spectator and is never boxed.
- **Gold box labelled "You"** — the subject, according to the tracker. Cross-
  check it against the marked still, as above.
- **Nobody outside the court lines is boxed.** Anyone whose feet fall outside
  the court is treated as a spectator or a player from the next court and is
  excluded before tracking starts. If somebody clearly on your court is never
  boxed, the court outline is wrong, and that is worth saying.
- **Stick figure** — pose, drawn only from keypoints the model actually saw, so
  an incomplete figure means low confidence, not a missing limb. Limb colours:
  torso green, **right arm gold**, **left arm blue**, legs paler versions of
  the same, head grey-blue. The arms are coloured differently on purpose — a
  forehand and a backhand look identical otherwise.

## There is no ball, and no paddle

Nothing in this pipeline tracks the ball. There is no ball marker, no ball
path, and no mark where the ball crossed the net — their absence carries no
information at all. Where the ball went is yours to read off the footage.

Nothing detects a paddle either. Earlier versions drew an estimate of one,
derived from the forearm; that is gone.

So you may say things about **where the arm was, how big the swing was, and
how high the contact was.** You may **NOT** say anything about the paddle's
**face angle, its path through the ball, spin, or where on the face contact
was made.** That information does not exist in this video. If you cannot tell,
say you cannot tell.

## The clock, and what is NOT drawn

- **Bottom bar** — the timestamp, \`t=…s\`.
- **There is no rally banner and no timeline strip.** Rally boundaries are not
  drawn because nothing upstream computes them: you are the only thing in this
  system that decides where a rally starts and ends.
- Contacts are not marked on the video. Where a list of contact timestamps is
  supplied alongside, those come from each player's own wrist accelerating
  sharply — a swing seen in the arm, not in the ball — so the times are
  approximate and the list can contain a fake or a practice swing.

## What this means for how you answer

The overlay is the pipeline's belief. Where it visibly disagrees with the
footage — a court outline off the painted lines, a skeleton on nobody — that
disagreement is itself a finding, and more valuable than a coaching point built
on top of it. Report it.
`;
