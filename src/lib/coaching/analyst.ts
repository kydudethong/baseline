/**
 * The analyst: one Gemini call over the overlay video plus what was measured,
 * producing everything the coaching layer used to take two Claude calls and a
 * rally segmenter to produce.
 *
 * WHY ONE CALL AND NOT THREE. The old shape was a coaching read, then a
 * tagging pass over the same facts plus that read, so the two could not
 * contradict each other. A single call cannot contradict itself, and the
 * rallies, shot types and ratings now come out of the same reading of the
 * same video as the prose about them.
 *
 * WHAT IT IS GIVEN, AND WHY THAT MATTERS. Measured facts go in alongside the
 * video, and that is the whole design. Asked from video alone this model
 * invented two rallies past the end of a 101-second clip and missed two real
 * ones; asked to work over an overlay with contact timings supplied it got all
 * seven right. It gets timings it can trust and body measurements it could
 * never take by eye, and decides what they MEAN.
 *
 * WHAT IT IS NOT GIVEN: any rally boundary or shot type this app derived.
 * Those are the answers now being asked for, and the overlay it watches is
 * rendered with --hide-rallies so they are not written across the frame
 * either.
 */

import { generateJSON, uploadVideo, analystModel, deleteFile, type UploadedFile } from "./gemini";
import { planSegments, planSegmentsForWindows, maxSegmentSeconds, isSampled, DEFAULT_MAX_SEGMENT_SECONDS } from "./technique-segments";
import { mapWithConcurrency } from "./concurrency";
import { mergeAnalystOutputs } from "./analyst-merge";
import { SKILLS, COACHING_DIMENSIONS, type CoachingDimension } from "./types";

// The scan's frame rate lives in read-rate.ts, because the OVERLAY RENDERER
// needs the same number and importing this module would drag the Gemini client
// into the vision layer. Re-exported so every existing caller is unchanged.
export { ANALYST_FPS, analystFps } from "./read-rate";
import { analystFps } from "./read-rate";

/**
 * Segment calls in flight at once.
 *
 * Two, not six. Each carries up to 600k tokens of video, so the ceiling is
 * tokens per minute rather than requests per minute -- two in flight is
 * already more than a million tokens of video in the air.
 */
export const ANALYST_CONCURRENCY = 2;

/**
 * Room for the answer, scaled to how much video the call is watching.
 *
 * A FIXED 16,000 FAILED, and the way it failed is the interesting part: the
 * model reported MAX_TOKENS with 9,473 of the budget spent on THINKING before
 * a single character of the answer was written. Thinking tokens count against
 * maxOutputTokens, so the real budget for output was under 7,000 -- and a
 * 13.7-minute clip's scan is a rally object and a shot object for every
 * contact in the game, which is comfortably more than that.
 *
 * So: a fixed allowance for reasoning, plus room that grows with the segment.
 * ~60 tokens per second of footage is generous against a measured rally
 * (~40 tokens) and shot (~60 tokens) at the density a real game produces.
 *
 * This is nearly free. Output tokens are billed on what is GENERATED, not on
 * the ceiling, so a budget that is too large costs nothing and a budget that
 * is too small costs the entire call.
 */
export const THINKING_ALLOWANCE = 14_000;
export const OUTPUT_TOKENS_PER_SECOND = 60;
export const MAX_OUTPUT_TOKENS = 60_000;

export function analystOutputBudget(segmentSeconds: number): number {
  const seconds = Number.isFinite(segmentSeconds) && segmentSeconds > 0 ? segmentSeconds : 120;
  return Math.min(MAX_OUTPUT_TOKENS, Math.round(THINKING_ALLOWANCE + seconds * OUTPUT_TOKENS_PER_SECOND));
}

/**
 * How closely the model looks at each frame of the SCAN.
 *
 * Gemini charges per frame by resolution tier, not by pixel count: roughly 258
 * tokens at high and 66 at low, so this one setting moves the bill by about 4x
 * and nothing else here comes close.
 *
 * LOW, because of what this pass is for. Finding a rally, seeing a ball change
 * direction against a paddle and telling four players apart are all coarse
 * judgements -- they need to know where things are, not what a wrist did.
 * High resolution is spent where it earns its price: the burst pass, on the
 * subject's own shots. Paying high rates across a whole match to read fifteen
 * swings meant most of the bill went on footage nothing was being judged in.
 *
 * HIGH, on the ball alone -- a dozen pixels is the one thing in this footage
 * the coarse tier genuinely loses.
 *
 * It was briefly set to LOW on the theory that a ring drawn around the ball in
 * the overlay would compensate. The ring never drew a pixel: it hung off the
 * ball-trail code, and ball tracking had been removed from the pipeline before
 * it was written. Recorded here because the reasoning was sound and the
 * premise was never checked, which is the more expensive half of that mistake.
 *
 * "medium" IS "low" HERE, and not because of this function. For video Gemini
 * treats the two tiers identically -- about 70 tokens a frame either way,
 * against 280 for high. It is accepted as a value because the API accepts it
 * and because someone reading a config will try it, but it buys nothing: there
 * is no half-price detail setting for video to reach for.
 */
export function analystMediaResolution(): "low" | "medium" | "high" {
  // LOW BY DEFAULT, and the arithmetic is the argument. Gemini charges per
  // frame by tier -- about 258 tokens at high against 66 at low -- so this one
  // setting is a 4x on the largest line in the bill, and at 10fps over a whole
  // twenty-minute game that is the difference between roughly $3.70 and $0.95.
  //
  // What it costs in quality is what this pass is actually asked to see: where
  // people are, who hit the ball, and when it changed direction. Not the
  // paddle -- the prompt says outright that the paddle is invisible here and a
  // separate pass reads technique from close-up bursts. Low resolution was the
  // setting for most of this product's life and the scan was not the weak
  // part; it moved to high during a quality push without anybody costing it.
  //
  // ANALYST_MEDIA_RESOLUTION=high puts it back. If rally detection gets worse
  // after this change, that is the first thing to try -- and worth measuring
  // rather than assuming, because it is a 4x either way.
  const v = (process.env.ANALYST_MEDIA_RESOLUTION ?? "low").toLowerCase();
  return v === "low" ? "low" : v === "medium" ? "medium" : "high";
}

const SHOT_TYPES = [
  "serve", "return", "third_shot_drop", "third_shot_drive", "dink", "drop",
  "reset", "drive", "volley", "speed_up", "overhead", "lob", "block", "unknown",
] as const;

/** A contact the CV layer measured: when it happened, and what the body did. */
export interface MeasuredContact {
  t: number;
  player: string | null;
  hit_from?: { x_ft: number; y_ft: number };
  landed_at?: { x_ft: number; y_ft: number };
  speed_mps?: number | null;
  body?: Record<string, number | string>;
}

/**
 * What the partnership read is scored on.
 *
 * Every one of these is a thing two people DO TOGETHER and a camera can see:
 * where they stand relative to each other, who moves when, who takes the ball
 * in the middle. Nothing here is about either player's technique -- that is
 * what the rest of the read is for, and a "partnership" section that graded
 * the partner's dinks would just be a second individual read on somebody who
 * never asked for one.
 */
export const PARTNERSHIP_DIMENSIONS = [
  "spacing",
  "moving_as_a_unit",
  "middle_balls",
  "transition_together",
  "switches_and_stacking",
  "poaching",
  "style_fit",
  "who_gets_targeted",
  "reset_after_scramble",
  "workload_balance",
] as const;

export interface AnalystInput {
  clipSeconds: number;
  subjectPlayerId: string | null;
  /**
   * The partner's track label, when one was tagged on the setup frame.
   *
   * Null means no partnership read -- not a guessed one. On a doubles court
   * the other player on your side is one of three candidates, and a model
   * asked to infer it will infer something rather than decline.
   */
  partnerPlayerId: string | null;
  ballCoverage: number | null;
  courtConfidence: number | null;
  contacts: MeasuredContact[];
  skillLevel: string | null;
  focusArea: string | null;
  /** Slugs that exist, so a cited drill resolves to a real one. */
  drillCatalogue: Array<{ slug: string; name: string; skill: string }>;
  knownLimitations: string[];
}

export interface PartnershipRead {
  compatibility: number;
  summary: string;
  dimensions: Array<{
    key: typeof PARTNERSHIP_DIMENSIONS[number];
    rating: number;
    basis: string;
  }>;
  works_well: Array<{ pattern: string; why_it_works: string; evidence: string; at_s: number | null }>;
  friction: Array<{ pattern: string; cost: string; fix: string; evidence: string; at_s: number | null }>;
  role_split: { you: string; partner: string; imbalance: string | null };
  fix_together: { change: string; how_to_practise: string; at_s: number | null };
}

export interface AnalystOutput {
  rallies: Array<{
    idx: number; start_s: number; end_s: number;
    end_reason: string; winner: string | null; confidence: number;
  }>;
  shots: Array<{
    t: number; rally_idx: number; player: string;
    type: typeof SHOT_TYPES[number]; confidence: number;
    /** Roughly where the ball landed. Null when it was not seen to land. */
    landing_depth?: string | null;
    landing_side?: string | null;
  }>;
  playstyle: { summary: string; tendencies: string[]; under_pressure: string };
  /** rating is 1-5, matching coaching_skill_ratings.raw — NOT 1-10. */
  skills: Array<{ skill_key: string; rating: number; basis: string }>;
  coaching: {
    headline: string;
    summary: string;
    strengths: string[];
    /**
     * `at_s` is the moment in the clip this criticism is about.
     *
     * THE HEADLINE CRITICISM COULD NOT BE CHECKED. The observations further
     * down the page each carry a cut clip and play where they sit; the top
     * priority fix, which is the thing a reader actually acts on, carried only
     * a sentence of prose -- "seen in your clip: your drops kept floating" --
     * pointing nowhere. The claim with the most weight on the page was the one
     * with the least ability to be disagreed with.
     */
    top_priority_fix: { issue: string; why_it_matters: string; evidence: string; at_s: number | null };
    secondary: Array<{ issue: string; evidence: string; at_s: number | null }>;
  };
  observations: Array<{
    rally_idx: number | null;
    shot_t: number | null;
    skill_key: string;
    coaching_dimension: CoachingDimension;
    valence: "strength" | "weakness";
    title: string;
    detail: string;
    severity: number;
    why_it_matters: string | null;
    what_to_change: string | null;
    drill_slug: string | null;
  }>;
  drills: Array<{ slug: string | null; name: string; targets: string; reps_or_duration: string }>;
  /**
   * Absent when no partner was tagged, or when the pair was never on court
   * together long enough to say anything. Not required in the schema for that
   * reason: a model forced to fill this in on a singles clip would invent it.
   */
  partnership?: PartnershipRead | null;
  data_gaps: string | null;
}

export function analystSchema(): Record<string, unknown> {
  const num = { type: "number" };
  const str = { type: "string" };
  // Nullable rather than optional: a criticism the model genuinely cannot
  // place in time must say so, not quietly omit the field and look the same
  // as one that simply forgot.
  const numOrNull = { type: "number", nullable: true };
  return {
    type: "object",
    properties: {
      rallies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            idx: { type: "integer" }, start_s: num, end_s: num,
            end_reason: str, winner: { type: "string", nullable: true }, confidence: num,
          },
          required: ["idx", "start_s", "end_s", "end_reason", "confidence"],
        },
      },
      shots: {
        type: "array",
        items: {
          type: "object",
          properties: {
            t: num, rally_idx: { type: "integer" }, player: str,
            type: { type: "string", enum: [...SHOT_TYPES] }, confidence: num,
            // Zones, not coordinates. A model asked for a landing POINT will
            // produce a decimal that looks like a measurement and is not one;
            // a model asked which third of the court it landed in is being
            // asked something it can actually see, and "kitchen / mid / deep"
            // is the resolution coaching is written at anyway.
            landing_depth: {
              type: "string", nullable: true,
              description: "kitchen | mid | deep | out | net — where the ball landed, or null if not seen to land",
            },
            landing_side: {
              type: "string", nullable: true,
              description: "left | middle | right from the hitter's view, or null",
            },
          },
          required: ["t", "rally_idx", "player", "type", "confidence"],
        },
      },
      playstyle: {
        type: "object",
        properties: {
          summary: str, tendencies: { type: "array", items: str }, under_pressure: str,
        },
        required: ["summary", "tendencies", "under_pressure"],
      },
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            skill_key: { type: "string", enum: SKILLS.map((s) => s.key) },
            rating: num, basis: str,
          },
          required: ["skill_key", "rating", "basis"],
        },
      },
      coaching: {
        type: "object",
        properties: {
          headline: str, summary: str,
          strengths: { type: "array", items: str },
          top_priority_fix: {
            type: "object",
            properties: { issue: str, why_it_matters: str, evidence: str, at_s: numOrNull },
            required: ["issue", "why_it_matters", "evidence", "at_s"],
          },
          secondary: {
            type: "array",
            items: {
              type: "object",
              properties: { issue: str, evidence: str, at_s: numOrNull },
              required: ["issue", "evidence", "at_s"],
            },
          },
        },
        required: ["headline", "summary", "strengths", "top_priority_fix", "secondary"],
      },
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rally_idx: { type: "integer", nullable: true },
            shot_t: { type: "number", nullable: true },
            skill_key: { type: "string", enum: SKILLS.map((s) => s.key) },
            coaching_dimension: { type: "string", enum: COACHING_DIMENSIONS },
            valence: { type: "string", enum: ["strength", "weakness"] },
            title: str, detail: str, severity: num,
            why_it_matters: { type: "string", nullable: true },
            what_to_change: { type: "string", nullable: true },
            drill_slug: { type: "string", nullable: true },
          },
          required: ["skill_key", "coaching_dimension", "valence", "title", "detail", "severity"],
        },
      },
      drills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slug: { type: "string", nullable: true },
            name: str, targets: str, reps_or_duration: str,
          },
          required: ["name", "targets", "reps_or_duration"],
        },
      },
      partnership: {
        type: "object",
        nullable: true,
        properties: {
          compatibility: num,
          summary: str,
          dimensions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", enum: [...PARTNERSHIP_DIMENSIONS] },
                rating: num, basis: str,
              },
              required: ["key", "rating", "basis"],
            },
          },
          works_well: {
            type: "array",
            items: {
              type: "object",
              properties: { pattern: str, why_it_works: str, evidence: str, at_s: numOrNull },
              required: ["pattern", "why_it_works", "evidence", "at_s"],
            },
          },
          friction: {
            type: "array",
            items: {
              type: "object",
              properties: { pattern: str, cost: str, fix: str, evidence: str, at_s: numOrNull },
              required: ["pattern", "cost", "fix", "evidence", "at_s"],
            },
          },
          role_split: {
            type: "object",
            properties: { you: str, partner: str, imbalance: { type: "string", nullable: true } },
            required: ["you", "partner", "imbalance"],
          },
          fix_together: {
            type: "object",
            properties: { change: str, how_to_practise: str, at_s: numOrNull },
            required: ["change", "how_to_practise", "at_s"],
          },
        },
        required: ["compatibility", "summary", "dimensions", "works_well", "friction", "role_split", "fix_together"],
      },
      data_gaps: { type: "string", nullable: true },
    },
    // partnership is NOT required: most clips have no tagged partner, and a
    // required field on a singles read is an invitation to invent one.
    required: ["rallies", "shots", "playstyle", "skills", "coaching", "observations", "drills"],
  };
}

export function analystPrompt(
  input: AnalystInput,
  legend: string,
  /**
   * The window this call is watching, when the clip was too long for one.
   * Null means the call sees the whole thing and no windowing note is needed.
   */
  segment: { startSeconds: number; endSeconds: number } | null,
  /**
   * Whether a marked still is actually attached to this call.
   *
   * PASSED, NOT ASSUMED. The prompt used to describe the gold box that marked
   * the subject, and kept describing it for a while after the boxes were taken
   * off the overlay -- so the model went looking for a mark that was not there
   * and reported its absence as a finding about the footage. The same mistake
   * is available here the moment a player is untagged or the frame fails to
   * render, so the prompt is told which of the two situations it is in.
   *
   * NO DEFAULT, deliberately. A default is a silent answer, and either value
   * is wrong somewhere: defaulting to true claims a mark that may not exist,
   * defaulting to false throws away the subject on a call that had one. Making
   * it required means a new caller cannot forget it -- the compiler asks.
   */
  hasReferenceFrame: boolean,
  /**
   * Whether a PARTNER mark was actually drawn on that still.
   *
   * SEPARATE FROM input.partnerPlayerId, and that distinction is the whole
   * point: having tagged a partner and having a cyan ring on this particular
   * frame are different facts, because the frame is chosen for holding the
   * most players rather than all of them. Describing a mark that is not there
   * is precisely the bug that produced the gold-box episode -- the model went
   * looking for it and reported its absence as a finding about the footage.
   *
   * Defaulted, unlike hasReferenceFrame, because false is the honest answer
   * for every existing caller: none of them mark a partner.
   */
  hasPartnerMark = false
): string {
  const contacts = input.contacts.length;
  const withBody = input.contacts.filter((c) => c.body).length;
  // WHY THE WINDOW IS SPELLED OUT. Gemini's startOffset trims the video, and a
  // model handed a trimmed video reports times from the start of what it was
  // given -- so a rally 40 seconds into segment three comes back as 40s rather
  // than 520s, and every downstream join on timestamps silently lands on the
  // wrong moment. Telling it the offset and asking for absolute times is the
  // cheap fix; the merge in analyst-merge.ts depends on times meaning the same
  // thing in every segment.
  const window = segment
    ? `\n\nYOU ARE WATCHING ONE STRETCH of a longer match: ${segment.startSeconds.toFixed(0)}s to `
      + `${segment.endSeconds.toFixed(0)}s of a ${input.clipSeconds.toFixed(0)}s video. Every time you `
      + `report -- rally start_s and end_s, shot t, observation shot_t -- must be in SOURCE video `
      + `seconds, so the first thing you see is around ${segment.startSeconds.toFixed(0)}s and not 0. `
      + `Number rallies from 1 within this stretch; they are renumbered across the whole match `
      + `afterwards. A point that is already underway when this stretch begins, or still going when it `
      + `ends, is a partial rally -- say so in end_reason rather than inventing the part you did not see.`
    : "";
  return `${legend}${window}

You are an expert pickleball coach with a computer-vision assistant.

You have the assistant's overlay drawn on the footage and a JSON record of what
it MEASURED.

${hasPartnerMark
  ? `\nAND WHO THEIR PARTNER IS. The same still carries a SECOND mark in CYAN,\nlabelled PARTNER — that player is the subject's doubles partner, on the\nsubject's own side of the net. The two people across the net are opponents and\nare not marked. Everything in the partnership section is about the magenta\nplayer and the cyan player TOGETHER.\n\nThe marks are on one frame. Players move, and after a switch the subject may\nbe on the other side of their own court — follow the PEOPLE, not the positions\nthey held on the still.\n`
  : ""}
${hasReferenceFrame
  ? `WHO YOU ARE COACHING, said twice. One still frame is attached to this\nrequest, taken from this clip, with ONE player marked — a magenta ring, a\nchevron above their head, the word YOU. The video ALSO carries a box on each\ntracked player, the subject's labelled "You".\n\nThe boxes come from the pipeline's identity tracking, which is good and is not\ninfallible; it fails where two players on the same side overlap. The still is\nfixed and cannot drift. So TRUST THE STILL when they conflict, and report the\nconflict — a stretch where the "You" box is clearly on the wrong person tells\nthe reader which parts of this read to doubt, which is worth more than quietly\npicking one. If you lose the subject entirely, say so for that stretch rather\nthan guessing.`
  : `NO STILL WAS SUPPLIED. The video's boxes are the only claim about who is\nwho, and they carry a role name rather than a confirmed identity — nobody has\nconfirmed which player this read is for. Treat the "You" box as the pipeline's\nbest guess and say so: attribute what you describe to "the player the tracker\nmarks as you", and do not write as though the subject were established.`}

WHAT THE MEASUREMENTS ARE

${contacts === 0
  ? "NO contacts were measured for this clip, and that is the normal case: nothing in this pipeline\ntracks the ball. Every contact in your answer comes from you watching the footage. Do not treat\nthe empty list as evidence that nothing was hit."
  : `${contacts} contacts, ${withBody} of them with body measurements. A contact is a moment a\nplayer's hand accelerated sharply — a paddle swing seen in their own arm, not in the ball, which\nnothing here tracks. The TIME is approximate (to about a tenth of a second) and a hard fake or a\npractice swing between points can appear in the list. The BODY MEASUREMENTS at each one are exact.\nUse the list for the angles; use the footage for what the shot actually was.`}
Positions are in court FEET: x runs 0-20 across, y runs away from the
camera with 0 at the near baseline, 22 at the net, 44 at the far baseline. The
kitchen lines are at y=15 and y=29. Body measurements are in the player's own
shoulder widths, so a shot at the far baseline compares directly with one near
the camera; knee angle is degrees, where 180 is a straight leg.

THE BODY MEASUREMENTS ARE MEASURED, NOT ESTIMATED. They come from a pose model
that located seventeen joints per player per frame. Where one is present, USE
THE NUMBER and say it — "your shoulders were 12 degrees from square at contact"
is worth more to a player than "your preparation looked late", and it is the
difference between a claim they can check and one they can dismiss. Where a
field is absent the joint was not visible: say nothing about it rather than
filling the gap from the video, because a sentence that sounds measured and is
not is worse than no sentence.

What they mean:
  shoulderTurnDeg             0 = shoulders facing the net, 90 = fully side-on.
  hipShoulderSeparationDeg    shoulders minus hips: the coil. Big is a loaded
                              drive; near zero is a player turning as one block.
  rotationLeadSeconds         how long before contact the turn started. This is
                              what "late preparation" actually means.
  contactHeightRatio          hip = 0, shoulder = 1. Negative is below the hip.
  contactAheadShoulderWidths  how far in front of the LEAD FOOT contact was.
                              Negative means the ball was struck behind them.
  paddleElbowDeg              180 is a straight, reaching arm; ~90 is a block.
  stanceWidthRatio            ankle spread in shoulder widths. ~1.5 is athletic.
  driftTowardNetTorsosPerSec  positive is moving in, negative is backing off.
  readyPaddleHeightRatio      resting paddle height between shots, same scale.
  readyKneeFlexionDeg         knee angle while waiting. 180 is standing upright.
  resetSeconds                how long they took to get back to their own ready
                              position. Absent means they had not by the next ball.

The SWING ITSELF, from the hitting wrist, all in the player's shoulder widths:
  backswingShoulders          how far the wrist got from the body in the wind-up.
                              Big is a full take-back; small is a compact block
                              or punch. Neither is wrong -- it is wrong for the
                              shot: a big take-back on a dink or a block is the
                              classic cause of a pop-up.
  wristSpeedIntoContact       hand speed into the ball, shoulder widths/second.
                              Compare shots of the same type: a drive slower
                              than their own dinks is a decelerating swing.
  followThroughShoulders      how far the wrist travelled AFTER contact. This IS
                              the follow-through. Short on a drive or a drop
                              means they stopped at the ball ("jabbing"); long
                              on a dink or a reset means they swung through a
                              shot that wanted a soft, short finish.
  shoulderRotationDeg         how far the shoulders turned from wind-up to
                              contact -- the body in the swing versus all arm.
  contactHeightTorsos         wrist height at contact: 0 = shoulders, -1 = hips.
  contactReachShoulders       how far from the body contact was. Large means
                              reaching; they were late or out of position.

The assistant did NOT decide which rally a contact belongs to, or what kind of
shot it was, and the overlay does not show rallies or net crossings. Those are
your judgments to make, and they are why you have the video.

YOUR JOB

1. RALLIES — points actually being played, serve to the moment the ball stops
   being played. Walking about and retrieving the ball between points is not a
   rally. Number them from 1.
   THE TWO WAYS THIS GOES WRONG, both of which lose real points:
   - ENDING A RALLY EARLY. A point is still live while the ball is out of
     shot, while it is being dinked slowly over the net, and while the players
     are barely moving. A kitchen exchange is four people standing almost
     still moving only their hands, and it is where most points are decided —
     it is NOT dead time, and it is not the end of the previous rally. Only
     end a rally where you can see the point actually finish: the ball lands
     out, goes into the net, bounces twice, or the players visibly reset for a
     serve. If you cannot see the ending, say so in end_reason and keep the
     rally running to where the players break up.
   - MISSING A RALLY ENTIRELY. A quiet point is still a point. If people are
     on court in ready position and the ball is in play, that is a rally even
     if nobody sprints. Do not skip a stretch because it is undramatic.
   Between two points somebody has to fetch the ball, walk back and serve, so
   two rallies less than about two seconds apart are almost certainly one
   rally you split in half. If you are unsure whether a lull is the end of a
   point or a pause within one, treat it as within one and say so.
2. SHOTS — every paddle contact in the clip: WHEN it happened, WHO hit it,
   what kind of shot it was, and roughly where it landed. You find these by
   watching. Nothing else in this pipeline detects the ball, so a contact you
   do not report is a contact that does not exist as far as this product is
   concerned — the rally lengths, the shot counts and the contact totals shown
   to the player are all counted from this list.
   Report EVERY contact by both players' sides, not only the subject's: a
   rally of nine shots where you list four reads to the player as a four-shot
   rally. "unknown" is a correct answer for a type you cannot tell, and a
   wrong label is not.
3. PLAYSTYLE of the subject — how they actually play, where they win and lose
   points, what they reach for under pressure. Describe, do not flatter.
4. SKILL RATINGS 1-5, for the skills this footage lets you judge. 1 is a clear
   weakness, 3 is competent, 5 is a strength at this player's level. Say what
   each rating rests on.
   RATE EVERY SKILL YOU SAW EVIDENCE FOR, and be generous about what counts as
   evidence: a player who dinked four times has shown you their dinking. Omit a
   skill you genuinely did not see -- do not invent a number for a shot they
   never played -- but returning no ratings at all means the player is shown no
   ratings at all, which is the wrong answer for any clip with a rally in it.
   If you are watching one stretch of a longer match, rate what THIS stretch
   showed; the ratings are averaged across stretches afterwards.
5. COACHING — a headline, a short summary, 1-2 strengths, one priority fix,
   1-2 secondary points.
   EVERY CRITICISM MUST NAME THE MOMENT IT IS ABOUT, in at_s: the second in
   the clip where a reader can watch the thing you are describing happen. It
   has to be a real moment you saw, close to one of the contact timestamps you
   were given, and inside a rally you reported. This is not decoration -- the
   player is shown those seconds of their own footage beside your sentence, so
   a time that shows nothing makes the criticism look invented even when it is
   right. If a point is about a pattern with no single best example, pick the
   clearest instance of it. If you truly cannot place it, set at_s to null and
   say in evidence why -- that is honest, and it is better than a number that
   sends somebody to the wrong four seconds.
6. OBSERVATIONS — the same findings as structured records, one per finding,
   each tagged with a skill and a coaching dimension, severity 1-5 (5 being
   the most costly), and where it is about one identifiable moment, the
   shot_t of that contact -- which must be one of the contact timestamps you
   were given, not a time you chose.
7. DRILLS — what to practise, tied to the priority fix. Where one of the
   catalogue drills fits, cite its slug; otherwise leave slug null and name it.

RULES THAT MATTER MORE THAN COMPLETENESS

- THE LIMITS, and they are hard. You are watching compressed video of people
  forty feet away. These things are NOT visible and must never appear in your
  answer, however confident you feel:
    * the GRIP — continental, eastern, how the hand sits on the handle
    * SPIN of any kind, on any shot
    * ball speed in MILES PER HOUR, or any other number you did not measure
    * reaction time in milliseconds, or any timing you did not measure
  Ball quality is described in WORDS the footage supports — "floated above net
  height", "landed deep", "took the pace off", "sat up" — and never in figures.
  A sentence that sounds measured and is not is worse than no sentence, because
  the reader cannot tell which of your sentences are which.
${input.partnerPlayerId ? `
THE PARTNERSHIP SECTION

Fill in \`partnership\`. It is about the subject AND THE PLAYER MARKED PARTNER
as a pair — not two individual reads side by side, and not a report card on the
partner, who did not ask for one. Everything in it must be something two people
did together that this camera can see.

Score \`compatibility\` 0-10: how well this pair FUNCTIONS, which is not how
good they are. Two 3.0 players who move as one and never leave the middle open
are a better partnership than two 4.0s who both chase every ball.

\`dimensions\` — rate each 0-10 with the evidence in \`basis\`. Skip any you did
not see enough of; a dimension you rate on one rally is worth less than one you
leave out.
  spacing               The gap between them. Too wide opens the middle; too
                        narrow leaves a whole sideline. Say roughly how many
                        feet apart they played and whether it held under
                        pressure.
  moving_as_a_unit      When one goes up, across or back, does the other go
                        with them? A pair joined by a rope, or two players
                        sharing a court.
  middle_balls          The ball down the centre. Who takes it, do both leave
                        it, do both go for it. Count what actually happened
                        rather than describing the principle.
  transition_together   After the return, do BOTH reach the kitchen line, or
                        does one arrive and the other get stranded mid-court?
                        A pair split front-and-back is the single most
                        attackable shape in doubles.
  switches_and_stacking Lobs over one player, poaches, any deliberate stacking.
                        Do they switch cleanly and recover, or end up in each
                        other's half?
  poaching              Does either cut across to take a ball that was not
                        theirs, does it work, and does the other cover behind?
  style_fit             Do their games complement or duplicate? Two bangers, or
                        one who resets and one who speeds up. Say which, and
                        whether it helps them.
  who_gets_targeted     Opponents pick a target. Say who was attacked more and
                        whether the pair adjusted to protect them.
  reset_after_scramble  After a scramble, do they get back to a shape together
                        or trickle back one at a time?
  workload_balance      Share of balls struck. A large imbalance is worth
                        naming either way — being hidden from and taking
                        everything are both partnership facts.

\`works_well\` and \`friction\`: concrete repeated PATTERNS, each anchored with
\`at_s\` to a moment it happened. "You both backed off the kitchen on every lob"
is a pattern; "good communication" is not — you cannot hear them, so do not
write about talking, calling balls or who said what. What you can see is
hesitation, two players stopping, or both swinging.

\`role_split\`: what each of them actually did in this pair, in a sentence each,
and in \`imbalance\` whether the split was lopsided in a way that cost them.
Null when it was even.

\`fix_together\`: the ONE change that would help them most as a pair, and how to
practise it together. Addressed to both of them, not to the subject alone.

If they were rarely on court at the same time, or you could not reliably keep
the two apart, set partnership to null and say why in data_gaps. A partnership
read built on a pair you kept losing is worse than none.
` : `
NO PARTNER WAS TAGGED for this clip, so OMIT \`partnership\` entirely. Do not
guess which player is the subject's partner: on a doubles court that is a
one-in-three choice, and a confident section about the wrong person is the
worst outcome available here.
`}
- TECHNIQUE COMES FROM THE MEASUREMENTS, AND IT IS YOUR JOB. You are
  watching at ${analystFps()} frames per second, so you cannot see the PADDLE
  itself -- a swing lasts about a third of a second -- so never describe the
  paddle's face, its angle, its
  path or spin. But you do not need to see it: the body measurements above
  were taken from a pose model at every contact, and they describe the swing
  exactly -- the take-back, the hand speed, the follow-through, the turn, the
  contact point, the knees. Nobody else writes technique for this read; if
  you leave it out, the player gets none.

  So technique is at least a THIRD of your observations, whenever contacts
  with body measurements exist. Cover, where the numbers support it:
    follow-through      short and stopped at the ball, or swinging through a
                        soft shot -- say which shot types, and the number.
    swing size          take-back too big for dinks and blocks, or too small
                        to drive with.
    preparation         turn started late (rotationLeadSeconds), or all arm
                        with no shoulder turn.
    contact point       behind the lead foot, too low, reaching.
    base and balance    straight legs at contact, narrow stance, drifting
                        backwards through the ball.
    ready position      paddle dropped between shots, slow to reset.
  Each one names the SHOT TYPE it happens on and quotes the measurement --
  "your follow-through on third-shot drops averaged 0.4 shoulder widths, about
  half your dinks" beats "follow through more". Compare a player with
  themselves across shot types; that is what the numbers are best at.

  Where no body measurements exist for a shot, say nothing about its
  mechanics rather than inventing them from the video.
- WRITE IT THE WAY YOU WOULD SAY IT ON A COURT. No abbreviations the reader
  has to decode: say "the kitchen line", never "NVZ" or "the NVZ line"; say
  "the non-volley zone" only if you have already said kitchen. Same for any
  other initialism -- if a club player would not say it out loud to a partner
  mid-game, do not write it. A reader who has to look up a term stops reading,
  and being precise is not the same as being technical.
- Prefer patterns over single shots. Three dinks taken with straight legs is a
  coaching point; one is noise.
- WHAT TO LOOK AT, so a read is not four versions of one thought. These are
  prompts, not a form to fill in: cover what this footage actually shows and
  say nothing about the rest.
    Body mechanics — how they turned, whether they were balanced at contact,
      whether weight went forward or they hit off the back foot, how high and
      how far in front of themselves they made contact, whether the arm
      finished the stroke or stopped at the ball, and where the hand rested
      between shots. Use the measured numbers for all of this; they are exact
      and they are listed above.
    Ball quality — for the balls they hit: deep or short, low over the net or
      floating, where it landed, whether the opponent could attack it. In
      WORDS. See the limits below.
    Shot selection — not just what they hit but whether it was the right
      choice, and what the better option was. "You drove a ball at ankle
      height from two feet behind the kitchen line; that ball is a reset, and
      driving it gave them the attack" is the shape. A shot list without
      judgement is a scoreboard.
    Court IQ and decisions — did they recognise a high ball and attack it, did
      they speed up from a position that gave them an advantage or one that
      gave it away, did they create an opening or hit into strength.
    Positioning and footwork — did they get to the kitchen line and stay
      there, did they move their feet or reach, did they recover to neutral
      after a scramble, where were they when the ball was struck.
    Defense — blocking and resetting under pressure, handling speed-ups,
      whether the paddle was up and in front, how they got back to neutral.
    Offense — speed-ups, drives, third-shot drops, fifth shots, attacking the
      feet, attacking the backhand.
    Kitchen game — crosscourt and straight-ahead dinks, height over the net,
      depth, placement, patience through an exchange, changing direction,
      speeding up off a dink, protecting the middle.
- ONE FAULT, ONE OBSERVATION. Writing the same correction four times in
  different words is not four findings and does not read as thorough -- it
  reads as a system with one thing to say. If the player stands too upright,
  say so once, at the moment it cost them most, and move on. "Knees too
  straight at the kitchen", "straight-leg posture on low contact" and
  "straight-legged exchanges" are one observation, not three.
- THEN GO LOOKING FOR SOMETHING ELSE. Posture is the easiest thing to see in a
  skeleton and it is not the only thing that decides points. Before you finish,
  ask what you can say about each of these, and include the ones the footage
  supports: where they stood between shots and whether they got to the kitchen
  line; their shot choice, and the balls they attacked that they should have
  reset; how they moved -- feet, or reaching from a planted stance; what they
  did under pressure; what they do well, which is not a courtesy but half of a
  useful read. A read in which every point is about knee angle has not looked
  at the match, it has looked at one joint.
- A player can act on about three corrections. Prefer three different ones over
  six versions of the same one.
- Use the measured numbers where they support you. "Knees at 172° on all four
  of those dinks" beats "you stood too upright".
- Where the footage does not support something, say so in data_gaps rather
  than filling the space.

Player's stated level: ${input.skillLevel ?? "not stated"}
Focus they asked for: ${input.focusArea ?? "none stated"}
${input.knownLimitations.length ? `\nKNOWN LIMITATIONS OF THIS DATA:\n${input.knownLimitations.map((l) => `- ${l}`).join("\n")}` : ""}

DRILL CATALOGUE (cite slugs from here only):
${input.drillCatalogue.map((d) => `${d.slug} — ${d.name} (${d.skill})`).join("\n") || "(none available)"}

MEASURED FACTS:
${JSON.stringify({
  clip_seconds: input.clipSeconds,
  subject_player: input.subjectPlayerId,
  ball_coverage: input.ballCoverage,
  court_confidence: input.courtConfidence,
  contacts: input.contacts,
})}`;
}

/** Phrases describing something nothing in this pipeline can observe. */
/**
 * Two lists now, because "can you see the paddle" stopped having one answer.
 *
 * At 10fps the model CAN see the paddle on the subject's own shots -- that is
 * the whole reason the technique fields exist on a shot rather than in a
 * separate pass. So paddle-face language is legitimate THERE and nowhere else:
 * the coaching prose, the observations and the playstyle are generalisations
 * across a match, and a generalisation about paddle angle is not something
 * this camera angle supports even at 10fps.
 *
 * NEVER_VISIBLE is the stricter list and applies everywhere including the
 * technique fields. Spin and contact point on the face are not observable from
 * a side-on phone camera at any frame rate this pipeline can afford -- a model
 * reporting them is reporting what a shot of that type usually has, which is a
 * prior dressed as an observation.
 */
const NEVER_VISIBLE = [
  "topspin", "top spin", "backspin", "back spin", "sidespin", "slice",
  "sweet spot", "continental grip",
];

const NOT_OUTSIDE_TECHNIQUE = [
  "paddle face", "face was open", "face is open", "paddle angle", "paddle path",
];

/**
 * Claims about what the pair SAID.
 *
 * New with the partnership section, and the most tempting sentence in doubles
 * coaching: "communicate more" is the note every rec player has been given,
 * so a model writing about a pair reaches for it by default.
 *
 * It is unsupportable twice over. The overlay never carried audio, and the
 * client-side transcode now discards the audio track outright -- so the file
 * the model watches is silent, and a claim about calling the ball is a claim
 * about a prior. What IS visible is the behaviour: two players stopping, two
 * players swinging, somebody hesitating. That is what the brief asks for.
 *
 * ONLY PHRASINGS THAT CAN ONLY BE CLAIMS. "call the ball" was in this list and
 * had to come out: as ADVICE it is the single most useful thing a partnership
 * fix can say, and flagging it would have made the audit fire on the best
 * sentence in the section. Telling somebody to call the middle is a
 * recommendation about the future; "you called it late" is a claim about a
 * sound. The list holds the second kind.
 */
const NOT_AUDIBLE = [
  "communicat", "shouted", "yelled", "talked", "talking to each other",
  "verbal", "you can hear", "audible", "said \"mine\"", "called \"mine\"",
  // The past tense of calling a ball. Split out from the bare verb on purpose:
  // "whoever is cross-court calls the ball" is advice and must stay clean,
  // while all of these assert that a sound did or did not happen.
  "called it late", "called it early", "called it too", "never called",
  "did not call", "didn't call", "no call from", "called for it",
];

/**
 * What a program can check. Not "is the coaching good" — that needs a person —
 * but "is it talking about this clip". Returns problems, empty when clean.
 */
/**
 * How far a shot the model read off the video may sit from the nearest
 * measured contact before it counts as unsupported.
 *
 * A QUARTER OF A SECOND, and every part of that number is a sampling fact
 * rather than a preference. Pose runs at VISION_FPS, so wrist speed is sampled
 * every 200ms and the peak can only ever land on one of those samples -- a
 * contact halfway between two is reported up to 100ms early or late before any
 * other error. The model reading the video has its own tenth of a second of
 * slack. Tighter than this and correct shots are flagged; looser and a genuine
 * invention half a second from anything real slips through.
 */
const SHOT_CONTACT_TOLERANCE_S = 0.25;

/**
 * The shortest believable gap between two points, in seconds.
 *
 * Somebody has to retrieve the ball, walk back and serve. Anything under this
 * is far more likely to be one rally reported as two -- which inflates the
 * rally count and makes every per-rally average wrong.
 */
const MIN_GAP_BETWEEN_RALLIES_S = 1.5;

/** Longer than this and it is probably two points with a missed serve between. */
const MAX_PLAUSIBLE_RALLY_S = 60;

/** How far outside a rally a swing may sit and still be counted as part of it. */
const RALLY_EDGE_TOLERANCE_S = 1.0;

/**
 * The share of measured swings allowed to fall outside every rally.
 *
 * Not zero, on purpose. Practice swings and warm-up hits between points are
 * exactly what a wrist-speed detector finds in dead time, so a handful of
 * orphans is the healthy case. A third of them is a different claim: whole
 * points are missing from the boundaries.
 */
const ORPHAN_CONTACT_SHARE = 0.33;

/**
 * How far a cited criticism moment may sit from a measured swing.
 *
 * Wider than the shot check, because a criticism is often about a passage
 * rather than an instant -- "you backed off the kitchen line here" covers a
 * couple of seconds of movement, not one contact. Wide enough to allow that,
 * narrow enough that the clip cut around the cited second still contains the
 * shot being described.
 */
const CRITICISM_EVIDENCE_TOLERANCE_S = 2.5;

export function auditAnalysis(out: AnalystOutput, input: AnalystInput): string[] {
  const problems: string[] = [];

  for (const r of out.rallies ?? []) {
    if (r.start_s < 0 || r.end_s > input.clipSeconds + 0.5 || r.end_s <= r.start_s) {
      problems.push(
        `rally ${r.idx} at ${r.start_s.toFixed(1)}-${r.end_s.toFixed(1)}s is outside a ${input.clipSeconds.toFixed(1)}s clip`
      );
    }
  }

  // RALLIES, CHECKED AGAINST EVIDENCE THE MODEL NEVER SAW.
  //
  // Rally boundaries are the one major output with nothing independent behind
  // them. Identity has three cues that can be cross-examined; a rally is one
  // model's reading of the footage, and if it is wrong nothing downstream
  // knows -- the rally count, the shot counts and every "your third shot"
  // claim are all counted off it.
  //
  // The wrist-speed contacts are the independent witness. They come from the
  // pose stream, computed before the model ever saw the clip, and the model is
  // told explicitly that their timing is approximate and that fakes appear in
  // them -- so it does not use them to place boundaries. That makes them a
  // real check rather than a restatement: a cluster of arms swinging in a
  // stretch the model called dead time is a contradiction, and so is a rally
  // with no arm movement in it at all.
  const rallies = [...(out.rallies ?? [])].sort((a, b) => a.start_s - b.start_s);
  for (let i = 1; i < rallies.length; i++) {
    const prev = rallies[i - 1];
    const cur = rallies[i];
    if (cur.start_s < prev.end_s - 0.05) {
      problems.push(
        `rallies ${prev.idx} and ${cur.idx} overlap (${prev.start_s.toFixed(1)}-${prev.end_s.toFixed(1)}s `
        + `and ${cur.start_s.toFixed(1)}-${cur.end_s.toFixed(1)}s) — a ball cannot be in two points at once`
      );
    } else if (cur.start_s - prev.end_s < MIN_GAP_BETWEEN_RALLIES_S) {
      // Between two points somebody has to retrieve the ball, walk back and
      // serve. Under a second and a half means one rally was almost certainly
      // cut in half at a moment the ball went out of frame.
      problems.push(
        `only ${(cur.start_s - prev.end_s).toFixed(1)}s between rallies ${prev.idx} and ${cur.idx} — `
        + "too short to retrieve and serve, so this may be one rally split in two"
      );
    }
  }
  for (const r of rallies) {
    if (r.end_s - r.start_s > MAX_PLAUSIBLE_RALLY_S) {
      problems.push(
        `rally ${r.idx} runs ${(r.end_s - r.start_s).toFixed(0)}s, longer than a rec-level point usually lasts — `
        + "this may be two points merged across a serve that was missed"
      );
    }
  }
  if (input.contacts.length > 0 && rallies.length > 0) {
    const inSomeRally = (t: number) =>
      rallies.some((r) => t >= r.start_s - RALLY_EDGE_TOLERANCE_S && t <= r.end_s + RALLY_EDGE_TOLERANCE_S);
    const orphaned = input.contacts.filter((c) => !inSomeRally(c.t));
    // A few is normal and expected -- practice swings between points are
    // exactly what a wrist-speed detector picks up in dead time. A large
    // share is not: it means whole points were missed.
    const share = orphaned.length / input.contacts.length;
    if (share > ORPHAN_CONTACT_SHARE) {
      problems.push(
        `${orphaned.length} of ${input.contacts.length} measured swings (${Math.round(share * 100)}%) `
        + `fall outside every rally (e.g. ${orphaned[0].t.toFixed(1)}s) — either points were missed, `
        + "or these boundaries do not match where the arms were moving"
      );
    }
    const empty = rallies.filter(
      (r) => !input.contacts.some((c) => c.t >= r.start_s - RALLY_EDGE_TOLERANCE_S && c.t <= r.end_s + RALLY_EDGE_TOLERANCE_S)
    );
    if (empty.length) {
      problems.push(
        `${empty.length} rally/rallies contain no measured swing at all (e.g. rally ${empty[0].idx} at `
        + `${empty[0].start_s.toFixed(1)}s) — a point in which nobody's arm moved is unlikely to be a point`
      );
    }
  }

  const contactTimes = input.contacts.map((c) => c.t).sort((a, b) => a - b);

  // A CRITICISM THAT POINTS AT NOTHING.
  //
  // The narrative read is what a player acts on, and the moment it names is
  // now shown to them as their own footage beside the sentence. That makes a
  // wrong timestamp worse than no timestamp: four seconds showing nothing
  // makes a correct criticism look invented, and the player's reasonable
  // conclusion is that the whole read is guesswork.
  const cited: Array<{ what: string; at: number | null }> = [
    { what: "the priority fix", at: out.coaching?.top_priority_fix?.at_s ?? null },
    ...(out.coaching?.secondary ?? []).map((sec, i) => ({
      what: `secondary point ${i + 1}`, at: sec.at_s ?? null,
    })),
  ];
  for (const c of cited) {
    if (c.at === null) continue;
    if (c.at < 0 || c.at > input.clipSeconds + 0.5) {
      problems.push(`${c.what} cites ${c.at.toFixed(1)}s, outside a ${input.clipSeconds.toFixed(1)}s clip`);
      continue;
    }
    if (contactTimes.length > 0
        && !contactTimes.some((t) => Math.abs(t - c.at!) <= CRITICISM_EVIDENCE_TOLERANCE_S)) {
      problems.push(
        `${c.what} cites ${c.at.toFixed(1)}s, where no swing was measured — `
        + "the clip shown beside it will not contain the shot it describes"
      );
    }
  }

  // Shots should land NEAR a measured contact -- and "near" is doing the work.
  //
  // THE HISTORY MATTERS, because this check has now been wrong in both
  // directions. It was written when the ball detector found contacts and the
  // model only had to label them: a shot at a time nothing observed was
  // invented, and exact equality to 10ms was the right test because both sides
  // were the same timestamps. Then ball tracking was removed, there were no
  // contacts at all, and the check inverted -- every shot the model correctly
  // FOUND was flagged as invented and the "contacts given no shot type" count
  // became the size of an empty set.
  //
  // Contacts exist again, from wrist-speed peaks in the pose stream, and
  // restoring the old test verbatim would have been the third wrong version.
  // The two sides are no longer the same timestamps: the model reads a shot
  // off the video, while a wrist peak is sampled at VISION_FPS and is good to
  // roughly a tenth of a second. Exact equality would flag almost every real
  // shot. So the test is proximity, at a tolerance that matches what the
  // measurement can actually resolve.
  //
  // AND THE SECOND CHECK IS GONE FOR GOOD. A contact with no shot against it
  // used to mean the model skipped a ball it was shown. From wrist speed it
  // usually means a hard fake, a practice swing between points, or one stroke
  // sampled either side of its peak -- all expected, none a fault of the
  // model's. Reporting them as problems would train a reader to ignore this
  // list, which is the one thing a grounding report must never do.
  if (contactTimes.length > 0) {
    const invented = (out.shots ?? []).filter(
      (s) => !contactTimes.some((t) => Math.abs(t - s.t) <= SHOT_CONTACT_TOLERANCE_S)
    );
    if (invented.length) {
      problems.push(
        `${invented.length} shot(s) more than ${SHOT_CONTACT_TOLERANCE_S}s from any measured `
        + `contact (e.g. ${invented[0].t}s)`
      );
    }
  }

  const slugs = new Set(input.drillCatalogue.map((d) => d.slug));
  for (const d of out.drills ?? []) {
    if (d.slug && !slugs.has(d.slug)) problems.push(`drill slug "${d.slug}" is not in the catalogue`);
  }
  for (const o of out.observations ?? []) {
    if (o.drill_slug && !slugs.has(o.drill_slug)) {
      problems.push(`observation cites drill slug "${o.drill_slug}", which does not exist`);
    }
  }

  // Phrased for a reader, not a log line. "claims something nothing here can
  // see: \"paddle face\"" is precise and meaningless to the person it is shown
  // to; it reads like an internal assertion leaking into the product, which is
  // what it was. The fact worth conveying is WHY the claim cannot be checked.
  // ONE BLOB AGAIN, because technique left this pass. When the scan carried
  // technique fields there were two standards -- paddle language was legitimate
  // on an individual shot and not in the prose -- and the audit had to split
  // the output to apply them. The scan now runs at 5fps and low resolution and
  // cannot see a paddle anywhere, so every phrase below is forbidden
  // everywhere in it. The burst pass is audited on its own terms.
  const everything = JSON.stringify(out).toLowerCase();

  for (const phrase of NEVER_VISIBLE) {
    if (everything.includes(phrase)) {
      problems.push(
        `The read mentions "${phrase}". Spin and contact point on the paddle face are not visible from ` +
          "this camera angle at any frame rate — a claim about them is what a shot of that type usually " +
          "has, not what this one did. Take that part as a guess rather than something observed."
      );
    }
  }
  for (const phrase of NOT_OUTSIDE_TECHNIQUE) {
    if (everything.includes(phrase)) {
      problems.push(
        `The read mentions "${phrase}". This pass watches at ${analystFps()} frames per second and low resolution — ` +
          "enough to see where people are and when the ball changed direction, and nowhere near enough " +
          "to see a paddle. Take that part as a guess rather than something observed."
      );
    }
  }
  for (const phrase of NOT_AUDIBLE) {
    if (everything.includes(phrase)) {
      problems.push(
        `The read mentions "${phrase}". The footage has no sound — the audio track is discarded before ` +
          "upload — so nothing about what the players said to each other was observed. Take that part as " +
          "a guess rather than something seen."
      );
    }
  }

  // THE PARTNERSHIP SECTION, CHECKED THE SAME WAY AS THE REST.
  //
  // A section about two people is the easiest place in this output to write
  // fluent nonsense: "you complement each other well" is true of almost any
  // pair, costs nothing to say, and cannot be wrong. The checks below are the
  // ones a program can make -- is it about a partner who exists, is it anchored
  // to moments inside this clip, are the numbers on the scale they claim.
  const pship = out.partnership;
  if (pship) {
    if (!input.partnerPlayerId) {
      problems.push(
        "The read includes a partnership section, but nobody was tagged as your partner for this clip — " +
        "so whoever it is about was chosen by the model, not by you. Treat that whole section as a guess."
      );
    }
    const scale = (label: string, v: number) => {
      if (!Number.isFinite(v) || v < 0 || v > 10) {
        problems.push(`partnership ${label} is ${v}, which is not a 0-10 rating`);
      }
    };
    scale("compatibility", pship.compatibility);
    const seen = new Set<string>();
    for (const d of pship.dimensions ?? []) {
      scale(d.key, d.rating);
      // A repeated key is two ratings for one thing, and whichever the UI
      // renders second silently wins.
      if (seen.has(d.key)) problems.push(`partnership rates "${d.key}" twice`);
      seen.add(d.key);
    }
    // Every anchor, from every list that carries one. A partnership claim
    // pointing outside the clip is pointing at nothing, exactly like a rally.
    const anchors: Array<{ what: string; at: number | null }> = [
      ...(pship.works_well ?? []).map((w) => ({ what: `works_well "${w.pattern}"`, at: w.at_s })),
      ...(pship.friction ?? []).map((f) => ({ what: `friction "${f.pattern}"`, at: f.at_s })),
      { what: "fix_together", at: pship.fix_together?.at_s ?? null },
    ];
    for (const a of anchors) {
      if (a.at === null) continue;
      if (a.at < 0 || a.at > input.clipSeconds + 0.5) {
        problems.push(
          `partnership ${a.what} points at ${a.at.toFixed(1)}s, outside a ${input.clipSeconds.toFixed(1)}s clip`
        );
      }
    }
  }

  return problems;
}

export async function runAnalyst(opts: {
  videoBytes: Uint8Array;
  videoName: string;
  /**
   * Stretches worth watching, from the player tracks. Omit to watch the whole
   * clip -- which is correct and just more expensive.
   */
  activeWindows?: Array<{ startSeconds: number; endSeconds: number }>;
  input: AnalystInput;
  legend: string;
  /**
   * One frame of this clip with the subject marked, as inline image data.
   *
   * THIS IS HOW THE MODEL KNOWS WHO IT IS COACHING, and the only way. The
   * overlay carries no boxes, names or highlights on anybody. Null means the
   * player was never tagged or the frame could not be built, and the prompt
   * says so rather than letting the model pick somebody.
   */
  referenceFrame?: { mimeType: string; dataBase64: string; markedPartner?: boolean } | null;
  onLog?: (line: string) => void;
}): Promise<{ output: AnalystOutput; problems: string[]; model: string; file: UploadedFile | null }> {
  const model = analystModel();
  const file = await uploadVideo(opts.videoBytes, opts.videoName, "video/mp4", opts.onLog);
  try {
    // Only the stretches where somebody was moving, when the caller could work
    // that out from the player tracks it already has. Falls back to the whole
    // clip, which is what every caller got before and what a clip with no
    // usable tracks still gets.
    const fps = analystFps();
    const resolution = analystMediaResolution();
    // ONE PASS WHEN THE WHOLE CLIP FITS, gating or no gating.
    //
    // Motion gating exists to stop the model being charged to watch people
    // walk between points, and on a long clip that is the largest lever there
    // is. On a clip that already fits inside one call it buys nothing: the
    // call is billed for the frames it is sent either way, and cutting the
    // clip into three windows costs three round trips AND throws away the
    // continuity that makes "your third drop got lower each time" sayable at
    // all. So the windows are only honoured when the clip is too long to watch
    // in one go.
    const fitsInOnePass = opts.input.clipSeconds > 0
      && opts.input.clipSeconds <= maxSegmentSeconds(fps, resolution);
    const useWindows = !fitsInOnePass && opts.activeWindows && opts.activeWindows.length > 0;
    const segments = useWindows
      ? planSegmentsForWindows(opts.activeWindows!, fps, resolution)
      : planSegments(opts.input.clipSeconds, fps, resolution);
    // A clip shorter than one segment is ONE call over the whole thing, which
    // is the shape this is meant to have. Segments are what a long clip gets
    // instead of a failure: at 10fps and high media resolution a second of
    // video is ~2,580 tokens, so a 1M context holds a little under four
    // minutes and a 20-minute match is physically not one request.
    const plan = segments.length > 0 ? segments : [{ startSeconds: 0, endSeconds: opts.input.clipSeconds }];
    // The timekeeping warning, said out loud rather than enforced silently.
    // Past roughly two minutes in one call the model has been measured losing
    // the clock and reporting rallies past the end of the clip. Those are
    // dropped at merge, so the failure is contained -- but a run stretched
    // beyond that length should say so, because the symptom downstream is
    // "some rallies went missing" and the cause is here.
    const longest = Math.max(...plan.map((s) => s.endSeconds - s.startSeconds));
    if (longest > DEFAULT_MAX_SEGMENT_SECONDS + 1) {
      opts.onLog?.(
        `analyst: segments run to ${Math.round(longest)}s, past the ${DEFAULT_MAX_SEGMENT_SECONDS}s the model has been `
        + `measured keeping time over — rallies reported outside the clip will be dropped`
      );
    }
    opts.onLog?.(
      plan.length === 1
        ? `analyst: one pass over the whole clip at ${fps}fps, ${resolution} resolution`
        : `analyst: ${plan.length} segments at ${fps}fps, ${resolution} resolution `
          + `(a 1M context holds about ${Math.round(maxSegmentSeconds(fps, resolution) / 60 * 10) / 10} min at this rate)`
          + (isSampled(opts.input.clipSeconds, fps, resolution)
            ? " — too long to watch end to end, so segments are spread across it"
            : "")
    );

    const parts = await mapWithConcurrency(plan, ANALYST_CONCURRENCY, async (segment, i) => {
      const out = await generateJSON<AnalystOutput>({
        model,
        file,
        prompt: analystPrompt(
          opts.input, opts.legend, plan.length > 1 ? segment : null,
          Boolean(opts.referenceFrame),
          Boolean(opts.referenceFrame?.markedPartner)
        ),
        schema: analystSchema(),
        // THE SAME STILL ON EVERY SEGMENT. A long match is several calls, and
        // each one is a fresh context that has never seen the subject -- so
        // sending the marked frame only with the first would leave every
        // segment after it coaching whoever the model decided to follow.
        image: opts.referenceFrame ?? null,
        video: {
          fps,
          startOffsetSeconds: segment.startSeconds,
          endOffsetSeconds: segment.endSeconds,
          mediaResolution: resolution,
        },
        maxOutputTokens: analystOutputBudget(segment.endSeconds - segment.startSeconds),
        label: `scan segment ${i + 1}/${plan.length}`,
        onLog: opts.onLog,
      });
      opts.onLog?.(`analyst: segment ${i + 1}/${plan.length} read`);
      return out;
    });

    const output = mergeAnalystOutputs(parts, opts.input.clipSeconds, opts.onLog);
    const problems = auditAnalysis(output, opts.input);
    for (const p of problems) opts.onLog?.(`analyst audit: ${p}`);
    // The upload handle goes back too, so the burst technique pass can point
    // at the SAME uploaded file rather than sending a second copy. On a 500MB
    // clip that is a minute of wall clock saved on every run, and it removes
    // any chance of the two passes watching different videos.
    return { output, problems, model, file };
  } catch (err) {
    // Only released on the failure path now. On success the caller owns it --
    // the burst pass needs the same upload -- and releases it when done. A
    // leaked handle expires on Gemini's side in 48h, which is the reason this
    // is allowed to be best-effort at all.
    await deleteFile(file.name).catch(() => {});
    throw err;
  }
}

/** Release an upload the caller was handed by runAnalyst. Best-effort. */
export async function releaseAnalystFile(file: UploadedFile | null): Promise<void> {
  if (!file) return;
  await deleteFile(file.name).catch(() => {});
}
