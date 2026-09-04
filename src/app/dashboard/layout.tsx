import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/actions/auth";
import { Ball } from "@/components/motifs/Motifs";

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
    <div className="min-h-screen" style={{ background: "var(--paper)" }}>
      <header className="topbar">
        <Link href="/dashboard" className="logo">
          <Ball size={26} />
          <span className="wm">Baseline</span>
        </Link>
        <nav className="topnav">
          <span className="xs">{user.email}</span>
          <form action={logout}>
            <button type="submit" className="btn btn-ghost btn-sm">
              Log out
            </button>
          </form>
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
