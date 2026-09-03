import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/types";
import { env } from "@/lib/env";

/**
 * Supabase client for use in Server Components, Route Handlers, and Server
 * Actions. Create a new one per request — never cache/share across requests.
 *
 * In a Server Component, `cookies().set()` is a no-op (Next.js forbids
 * mutating cookies during render); session refresh there is handled by
 * `src/proxy.ts` instead, which runs before the component tree renders.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render — proxy.ts refreshes the
          // session on the next request instead. Safe to ignore here.
        }
      },
    },
  });
}

/**
 * Privileged client that bypasses Row Level Security using the service role
 * key. Server-only. Use sparingly — only for trusted background work (e.g.
 * the processing pipeline updating a row it doesn't have a user session
 * for), never to serve a request on a user's behalf.
 */
export function createServiceRoleClient() {
  return createServerClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll() {
        // Service role client never manages a user session/cookies.
      },
    },
  });
}
