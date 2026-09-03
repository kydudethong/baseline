import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAnalysisForUser } from "@/lib/db/analyses";
import { getProfile } from "@/lib/db/profiles";
import { BlueprintPipelineError, generateBlueprint } from "@/lib/coaching/blueprint";
import type { CoachingObservationRow } from "@/lib/db/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface BlueprintRequestBody {
  /** Which tagged weakness (coaching_observations.id) to build a plan for — never raw skill/title text from the client, so the plan is always tied to something the coaching pipeline actually said. */
  observationId?: string;
}

/**
 * Builds a five-session practice plan from one weakness observation — see
 * blueprint.ts. coaching_blueprints/_steps grant insert to the user's own
 * session directly (0005_coaching_layer.sql's insert_own policy), unlike
 * coaching_reads/_observations which only the service role can write, so
 * this route doesn't need the service-role client the /coach route does.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analysis = await getAnalysisForUser(supabase, user.id, id);
  if (!analysis) return NextResponse.json({ error: "Analysis not found" }, { status: 404 });

  let body: BlueprintRequestBody;
  try {
    body = (await request.json()) as BlueprintRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.observationId) {
    return NextResponse.json({ error: "observationId is required." }, { status: 400 });
  }

  const { data: observationData, error: observationError } = await supabase
    .from("coaching_observations")
    .select("*")
    .eq("id", body.observationId)
    .eq("analysis_id", id)
    .maybeSingle();
  if (observationError) return NextResponse.json({ error: observationError.message }, { status: 500 });
  const observation = observationData as CoachingObservationRow | null;
  if (!observation) return NextResponse.json({ error: "Observation not found." }, { status: 404 });
  if (observation.valence !== "weakness") {
    return NextResponse.json({ error: "A practice plan only makes sense for a weakness, not a strength." }, { status: 400 });
  }

  const profile = await getProfile(supabase, user.id);

  try {
    const result = await generateBlueprint(supabase, {
      userId: user.id,
      analysisId: id,
      skillKey: observation.skill_key,
      weaknessTitle: observation.title,
      weaknessDetail: observation.detail,
      level: profile?.skill_level ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof BlueprintPipelineError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Could not build a practice plan.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
