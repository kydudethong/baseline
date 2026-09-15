/**
 * Which of these track ids are the same person?
 *
 * THE PROBLEM. The tracker has no re-identification. Every time it loses
 * somebody behind another player it picks them back up under a new id, so a
 * fourteen-minute doubles game comes back as sixteen tracks for four people --
 * and the user is asked which of sixteen chips is them.
 *
 * WHY A MODEL RATHER THAN AN EMBEDDING. The appearance signature this pipeline
 * already computes is three numbers: the mean hue, saturation and brightness
 * of the torso. Two players in white shirts are identical to it, which is
 * exactly the case that matters. A model watching the clip has hair, hat,
 * shoes, socks, sleeve length, build and gait -- and, far more usefully, it
 * sees WHAT HAPPENED IN BETWEEN. A track that ends behind another player and
 * one that starts a beat later in the same spot is obviously the same person
 * to anything watching, and invisible to anything comparing two crops.
 *
 * WHAT IT WATCHES. Not the full overlay: a purpose-built clip at 2fps and low
 * resolution with ONLY the boxes and their ids on it, labels drawn large
 * enough to survive the model's own downsample. The court, the net, the
 * skeletons and the ball are all noise for this one question, and the clip is
 * cheap enough that rendering it separately costs less than the confusion
 * would.
 *
 * WHAT IT IS NOT TRUSTED WITH. Whether two ids were on court at the same
 * moment. That is arithmetic, it outranks any answer, and mergeTrackGroups
 * enforces it.
 */

import { generateJSON, uploadVideo, analystModel, deleteFile } from "./gemini";

/** Frames a second the identity clip is rendered and read at. */
export const IDENTITY_FPS = 2;

/**
 * Two a second, which is far below what a stroke needs and exactly right here.
 * The question is "is the person who walked off at 2:14 the person who walked
 * back on at 2:16", and that is answered by appearance and position over
 * seconds, not by anything happening inside a third of a second. Two frames a
 * second over a fourteen-minute clip at low resolution is a few cents.
 */
export interface IdentityGroup {
  /** Track ids the model believes are one person. */
  trackIds: string[];
  /** How it told them apart, in its own words -- for the log and for trust. */
  description: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      description:
        "One entry per REAL PERSON in the game. Every track id you saw belongs to exactly one.",
      items: {
        type: "object",
        properties: {
          track_ids: {
            type: "array",
            items: { type: "string" },
            description: "Every id this person appeared under, exactly as written on their box.",
          },
          description: {
            type: "string",
            description:
              "What makes this person recognisable: clothing top and bottom, hat, hair, build, "
              + "which side of the net they play. Enough that a reader could pick them out.",
          },
        },
        required: ["track_ids", "description"],
      },
    },
  },
  required: ["people"],
} as const;

function prompt(ids: string[], expectedPlayers: number): string {
  return [
    "This clip shows a pickleball game with a coloured box drawn around each tracked person,",
    "labelled with that person's track id.",
    "",
    "The tracker CANNOT recognise anyone. Whenever it loses somebody -- behind another player,",
    "at the edge of frame, walking off between points -- it starts a brand new id when they come",
    "back. So the same human being appears under several different ids over the clip.",
    "",
    `The ids you will see are: ${ids.join(", ")}.`,
    `This is a ${expectedPlayers}-player game, so there should be about ${expectedPlayers} real people.`,
    "",
    "Group the ids by PERSON.",
    "",
    "How to tell them apart, in rough order of how much you should trust it:",
    "- WHERE AND WHEN. An id that ends and another that begins a moment later in the same part of",
    "  the court is the same person walking back into view. This is the strongest signal you have.",
    "- Two ids visible AT THE SAME TIME are different people. Always. Nobody is in two places at once.",
    "- Which side of the net they play. Partners stay on their side for a whole game.",
    "- Appearance, and look past the shirt: two players often wear the same colour top. Hat or no hat,",
    "  hair, shorts, shoes, socks, sleeve length, build, how they move.",
    "",
    "Rules:",
    "- Every id you see goes in exactly one group. Do not invent ids you did not see.",
    "- If you genuinely cannot tell two ids apart, leave them as separate people. A wrong merge",
    "  puts two players' shots on one person's report, which is worse than an extra name.",
  ].join("\n");
}

/**
 * Groups track ids by person. Never throws: identity is an improvement on the
 * tag screen, and a run that produced good tracking must not fail because a
 * model was unavailable.
 */
export async function identifyPlayers(opts: {
  clipBytes: Uint8Array;
  clipName: string;
  trackIds: string[];
  expectedPlayers: number;
  clipSeconds: number;
  onLog?: (line: string) => void;
}): Promise<IdentityGroup[]> {
  if (opts.trackIds.length < 2) return [];
  const model = analystModel();
  let file = null;
  try {
    file = await uploadVideo(opts.clipBytes, opts.clipName, "video/mp4", opts.onLog);
    const out = await generateJSON<{ people?: Array<{ track_ids?: string[]; description?: string }> }>({
      model,
      file,
      prompt: prompt(opts.trackIds, opts.expectedPlayers),
      schema: SCHEMA as unknown as Record<string, unknown>,
      video: { fps: IDENTITY_FPS, mediaResolution: "low" },
      // Small answer, but thinking counts against this budget and grouping
      // sixteen ids is genuinely a reasoning task.
      maxOutputTokens: 20_000,
      label: "player identity",
      onLog: opts.onLog,
    });
    const known = new Set(opts.trackIds);
    const groups = (out.people ?? [])
      .map((p) => ({
        // Ids the model invented are dropped rather than trusted: a group
        // naming a track that does not exist tells us nothing about one that
        // does.
        trackIds: [...new Set((p.track_ids ?? []).filter((id) => known.has(id)))],
        description: (p.description ?? "").trim(),
      }))
      .filter((g) => g.trackIds.length > 1);
    opts.onLog?.(
      `identity: ${opts.trackIds.length} track(s) -> ${(out.people ?? []).length} person(s); `
      + `${groups.length} group(s) with something to merge`
    );
    for (const g of groups) {
      opts.onLog?.(`  ${g.trackIds.join(" + ")} — ${g.description || "no description given"}`);
    }
    return groups;
  } catch (err) {
    opts.onLog?.(`identity: skipped — ${(err as Error).message.split("\n")[0]}`);
    return [];
  } finally {
    if (file) await deleteFile(file.name).catch(() => {});
  }
}
