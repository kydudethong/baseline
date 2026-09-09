"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Line icons at a common 18px, stroked in currentColor so the active item's
 * dark-on-green inverts with the label instead of staying stuck one colour. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const LINKS: Array<{ href: string; label: string; icon: ReactNode }> = [
  { href: "/dashboard", label: "Home", icon: <Icon><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></Icon> },
  { href: "/dashboard/new", label: "New analysis", icon: <Icon><rect x="2.5" y="6" width="14" height="12" rx="2.5" /><path d="m16.5 12 5-3v9l-5-3" /></Icon> },
  { href: "/dashboard/library", label: "Library", icon: <Icon><path d="M4 5v14" /><path d="M8.5 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-11" /><path d="M8.5 4v16" /></Icon> },
  { href: "/dashboard/practice", label: "Practice", icon: <Icon><path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M21 19H3" /></Icon> },
  { href: "/dashboard/drills", label: "Drills", icon: <Icon><path d="M6.5 6.5 17.5 17.5" /><rect x="2.5" y="9.5" width="5" height="5" rx="1.4" transform="rotate(-45 5 12)" /><rect x="16.5" y="9.5" width="5" height="5" rx="1.4" transform="rotate(-45 19 12)" /></Icon> },
];

/** Client component only because usePathname needs it -- everything else in
 * the dashboard shell (DashboardLayout) stays a server component. Active
 * match: "/dashboard" only matches exactly (it's also a prefix of every
 * other link here), the rest match by prefix so a page like
 * /dashboard/library/[id] (if that ever exists) still highlights Library. */
export function DashboardNav() {
  const pathname = usePathname();

  return (
    <>
      {LINKS.map((link) => {
        const active = link.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(link.href);
        return (
          <Link key={link.href} href={link.href} data-active={active ? "true" : undefined} title={link.label}>
            {link.icon}
            <span>{link.label}</span>
          </Link>
        );
      })}
    </>
  );
}
