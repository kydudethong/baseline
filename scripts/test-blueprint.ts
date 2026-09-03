// One-off manual test for the practice-plan generator — exercises the same
// code path as POST /api/analyses/[id]/blueprint (drills.ts + blueprint.ts
// + persistence), without needing a signed-in browser session. Run with
// real internet access (not the device-bridge sandbox shell, which has no
// egress to Supabase or Anthropic):
//
//   npx tsx scripts/test-blueprint.ts <analysisId> [observationId]
//
// If observationId is omitted, this picks the first weakness observation
// on that analysis for you — handy since you already have one from
// test-coach.ts's run.

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { BlueprintPipelineError, generateBlueprint } from "../src/lib/coaching/blueprint";
import type { CoachingObservationRow, Database } from "../src/lib/db/types";

function loadEnvLocal(): Record<string, string> {
  const envPath = path.join(__dirname, "..", ".env.local");
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function main() {
  const [analysisId, observationIdArg] = process.argv.slice(2);
  if (!analysisId) {
    console.error("Usage: npx tsx scripts/test-blueprint.ts <analysisId> [observationId]");
    process.exit(1);
  }

  const env = loadEnvLocal();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  if (!env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY in .env.local");
    process.exit(1);
  }
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.CLAUDE_MODEL) process.env.CLAUDE_MODEL = env.CLAUDE_MODEL;
  if (env.ANTHROPIC_WORKSPACE_ID) process.env.ANTHROPIC_WORKSPACE_ID = env.ANTHROPIC_WORKSPACE_ID;

  const supabase = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: analysisRow, error: findError } = await supabase
    .from("analyses")
    .select("user_id, title")
    .eq("id", analysisId)
    .maybeSingle();
  if (findError) throw findError;
  if (!analysisRow) {
    console.error(`No analysis found with id ${analysisId}`);
    process.exit(1);
  }

  let observation: CoachingObservationRow;
  if (observationIdArg) {
    const { data, error } = await supabase
      .from("coaching_observations")
      .select("*")
      .eq("id", observationIdArg)
      .eq("analysis_id", analysisId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      console.error(`No observation ${observationIdArg} on analysis ${analysisId}`);
      process.exit(1);
    }
    observation = data as CoachingObservationRow;
  } else {
    const { data, error } = await supabase
      .from("coaching_observations")
      .select("*")
      .eq("analysis_id", analysisId)
      .eq("valence", "weakness")
      .order("severity", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      console.error(`No weakness observations found on analysis ${analysisId} — run test-coach.ts on it first.`);
      process.exit(1);
    }
    observation = data[0] as CoachingObservationRow;
  }

  console.log(`Building a practice plan for: "${observation.title}" (skill: ${observation.skill_key})`);

  const { data: profile } = await supabase
    .from("profiles")
    .select("skill_level")
    .eq("id", analysisRow.user_id)
    .maybeSingle();

  try {
    const result = await generateBlueprint(supabase, {
      userId: analysisRow.user_id,
      analysisId,
      skillKey: observation.skill_key,
      weaknessTitle: observation.title,
      weaknessDetail: observation.detail,
      level: profile?.skill_level ?? null,
    });
    console.log("\n=== blueprint ===");
    console.log(JSON.stringify(result.blueprint, null, 2));
    console.log(`\n=== ${result.steps.length} steps ===`);
    console.log(JSON.stringify(result.steps, null, 2));
  } catch (err) {
    if (err instanceof BlueprintPipelineError) {
      console.error("Blueprint pipeline error:", err.message);
    } else {
      console.error("Unexpected error:", err);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
