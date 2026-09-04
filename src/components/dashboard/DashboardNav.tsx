"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Home" },
  { href: "/dashboard/library", label: "Library" },
  { href: "/dashboard/practice", label: "Practice" },
  { href: "/dashboard/drills", label: "Drills" },
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
          <Link key={link.href} href={link.href} data-active={active ? "true" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </>
  );
}
