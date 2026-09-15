import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { describeError } from "@/lib/analysis/describe-error";

export const runtime = "nodejs";

/**
 * Tick or untick one session or one drill.
 *
 * A TIMESTAMP, NOT A BOOLEAN. "Done" and "done on the 14th" cost the same to
 * store, and the second one is what makes a streak, a "you have done four of
 * eight this month", or a next-month plan that knows which weeks actually
 * happened. A boolean throws that away for nothing.
 *
 * No ownership check in this handler beyond RLS, and that is deliberate rather
 * than an omission: the policies in 0016 scope both tables through their plan
 * to auth.uid(), so a row belonging to someone else simply does not exist for
 * this client. Re-checking in application code would be a second, weaker copy
 * of a rule the database already enforces.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { kind?: string; id?: string; done?: boolean; notes?: string; helped?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (body.kind !== "session" && body.kind !== "drill") {
    return NextResponse.json({ error: 'kind must be "session" or "drill".' }, { status: 400 });
  }

  // The two branches are written out rather than sharing one `table` variable
  // and a loose patch object: the typed client narrows the update shape per
  // table, and collapsing them costs the very type checking that stops a typo
  // in a column name reaching production.
  const completed_at = body.done === false ? null : new Date().toISOString();
  const { error } = body.kind === "session"
    ? await supabase
        .from("practice_sessions")
        .update({
          completed_at,
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          // DID IT HELP. The rarest and most valuable label in the product: it
          // needs somebody to do the drill AND come back and say. Nothing else
          // here connects a prescription to an outcome, and without it the
          // practice plan is advice nobody has ever checked.
          ...(body.helped !== undefined ? { helped: clampHelped(body.helped) } : {}),
        })
        .eq("id", body.id)
    : await supabase
        .from("practice_session_drills")
        .update({ completed_at })
        .eq("id", body.id);

  if (error) return NextResponse.json({ error: describeError(error) }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** -1 didn't help, 0 unsure, 1 helped. Anything else is not an answer. */
function clampHelped(v: unknown): number | null {
  const n = Number(v);
  return n === -1 || n === 0 || n === 1 ? n : null;
}
