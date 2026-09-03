// One-off manual test for the coaching pipeline — exercises the exact same
// code path as POST /api/analyses/[id]/coach (facts.ts + the two Claude
// calls + persistence), just without needing a signed-in browser session.
// Run with real internet access (not the device-bridge sandbox shell,
// which has no egress to Supabase or Google):
//
//   npx tsx scripts/test-coach.ts <analysisId> <selfLabel1,selfLabel2,...>
//
// Example:
//   npx tsx scripts/test-coach.ts 7444cb73-97fe-4102-b503-ea09ce12bef6 player_1,player_9,player_13,player_15

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runCoachingPipeline, CoachingPipelineError } from "../src/lib/coaching/run-coaching";
import type { Database } from "../src/lib/db/types";

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
  const [analysisId, labelsArg] = process.argv.slice(2);
  if (!analysisId || !labelsArg) {
    console.error("Usage: npx tsx scripts/test-coach.ts <analysisId> <label1,label2,...>");
    process.exit(1);
  }
  const selfPlayerLabel = labelsArg
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(",");

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

  // Dev-scale assumption: one signed-up user. Grabs whoever owns this
  // analysis rather than guessing, so it works regardless.
  const { data: analysisRow, error: findError } = await supabase
    .from("analyses")
    .select("user_id, title, status")
    .eq("id", analysisId)
    .maybeSingle();
  if (findError) throw findError;
  if (!analysisRow) {
    console.error(`No analysis found with id ${analysisId}`);
    process.exit(1);
  }
  console.log(`Analysis "${analysisRow.title}" — status: ${analysisRow.status}, user: ${analysisRow.user_id}`);

  console.log(`Tagging self as: ${selfPlayerLabel}`);
  const { error: updateError } = await supabase
    .from("analyses")
    .update({ self_player_label: selfPlayerLabel })
    .eq("id", analysisId);
  if (updateError) throw updateError;

  console.log("Running coaching pipeline (facts assembly + 2 Claude calls)...");
  try {
    await runCoachingPipeline(supabase, analysisRow.user_id, analysisId);
  } catch (err) {
    if (err instanceof CoachingPipelineError) {
      console.error("Pipeline error:", err.message);
    } else {
      console.error("Unexpected error:", err);
    }
    process.exit(1);
  }

  const { data: read, error: readError } = await supabase
    .from("coaching_reads")
    .select("*")
    .eq("analysis_id", analysisId)
    .maybeSingle();
  if (readError) throw readError;

  console.log("\n=== coaching_reads ===");
  console.log(JSON.stringify(read, null, 2));

  const { data: observations } = await supabase
    .from("coaching_observations")
    .select("*")
    .eq("analysis_id", analysisId);
  console.log(`\n=== ${observations?.length ?? 0} coaching_observations ===`);
  console.log(JSON.stringify(observations, null, 2));

  const { data: skills } = await supabase.from("coaching_skill_ratings").select("*").eq("analysis_id", analysisId);
  console.log(`\n=== ${skills?.length ?? 0} coaching_skill_ratings ===`);
  console.log(JSON.stringify(skills, null, 2));

  const { data: rallies } = await supabase.from("coaching_rallies").select("*").eq("analysis_id", analysisId).order("idx");
  console.log(`\n=== ${rallies?.length ?? 0} coaching_rallies ===`);
  console.log(JSON.stringify(rallies, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
