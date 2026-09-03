import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 renamed `middleware.ts` to `proxy.ts`; the export name and
// `config.matcher` shape are unchanged from the old middleware convention.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every route except static assets and Next.js internals, so the
     * session cookie stays fresh everywhere without a per-route opt-in.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
