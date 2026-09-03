import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/actions/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy.ts already redirects unauthenticated requests away from
  // /dashboard, but every protected surface re-checks — a proxy is an
  // optimistic fast path, never the only gate on real data access.
  if (!user) redirect("/login?next=/dashboard");

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-slate-900">
            Baseline
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-500">{user.email}</span>
            <form action={logout}>
              <button type="submit" className="font-medium text-slate-600 hover:text-slate-900">
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
