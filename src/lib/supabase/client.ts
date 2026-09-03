"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/types";
import { env } from "@/lib/env";

/**
 * Supabase client for use in Client Components. Safe to call repeatedly —
 * @supabase/ssr reuses a singleton under the hood — but prefer creating it
 * once per component via `useMemo` or module scope in a small wrapper.
 */
export function createClient() {
  return createBrowserClient<Database>(env.supabaseUrl, env.supabaseAnonKey);
}
