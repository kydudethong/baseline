import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAnalysis, listAnalysesForUser } from "@/lib/db/analyses";

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const analyses = await listAnalysesForUser(supabase, user.id);
  return NextResponse.json({ analyses });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A title is required." }, { status: 400 });
  }

  const analysis = await createAnalysis(supabase, user.id, parsed.data.title);
  return NextResponse.json({ analysis }, { status: 201 });
}
