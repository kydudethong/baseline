import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/actions/auth";
import { DashboardNav } from "@/components/dashboard/DashboardNav";
import { getProfile } from "@/lib/db/profiles";

/**
 * The app shell: a fixed left rail, everything else in the remaining width.
 *
 * This replaced a topbar. The rail holds more destinations without crowding
 * them, keeps them in one scannable column, and hands the page its full width
 * back — which the analysis workspace wanted anyway.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy.ts already redirects unauthenticated requests away from
  // /dashboard, but every protected surface re-checks — a proxy is an
  // optimistic fast path, never the only gate on real data access.
  if (!user) redirect("/login?next=/dashboard");

  // The rail greets you by name, like the rest of the app — an email address
  // in the corner is an account identifier, not a person.
  const profile = await getProfile(supabase, user.id);
  const name = firstName(profile?.display_name, user.email);
  const initial = (name[0] ?? "?").toUpperCase();

  return (
    <div className="shell">
      <aside className="rail">
        <Link href="/dashboard" className="rail-brand">
{/* The DARK mark. There are two files and the choice is not cosmetic:
          baseline-mark.png is a white B with a white speed-trail, so on the
          light ground it is white on near-white and only the green ball
          survives. The dark variant recolours exactly the achromatic pixels
          and leaves the ball untouched, so it is the same logo rather than a
          second one. White stays on the landing hero, which is still dark. */}
          <Image src="/brand/baseline-mark-dark.png" alt="" width={494} height={420} priority />
          <span className="wm">Baseline</span>
        </Link>

        <nav className="rail-nav">
          <DashboardNav />
        </nav>

        <div className="rail-foot">
          <Link href="/dashboard/new" className="btn btn-optic btn-sm">
            + Analyze a game
          </Link>
          <div className="rail-user">
            <span className="rail-av">{initial}</span>
            <span className="who">
              <span className="nm">{name}</span>
              <form action={logout}>
                <button type="submit" className="sub" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit", font: "inherit" }}>
                  Log out
                </button>
              </form>
            </span>
          </div>
        </div>
      </aside>

      <div className="shell-main">
        <main className="shell-page">{children}</main>
      </div>
    </div>
  );
}

/** Their name if they gave one, otherwise the readable part of the email.
 * Same rule as the greeting on Home, so the two never disagree. */
function firstName(displayName: string | null | undefined, email: string | undefined): string {
  if (displayName?.trim()) return displayName.trim().split(/\s+/)[0];
  const local = (email ?? "").split("@")[0] ?? "";
  const word = local.split(/[.\-_+]/)[0] ?? "";
  return word ? word[0].toUpperCase() + word.slice(1) : "You";
}
