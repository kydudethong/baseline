import Link from "next/link";
import Image from "next/image";

const LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/coaches", label: "For coaches" },
];

export function SiteNav({ isAuthed, current }: { isAuthed: boolean; current?: string }) {
  return (
    <header className="mk-nav">
      <div className="mk-wrap mk-nav-in">
        <Link href="/" className="logo">
          <Image src="/brand/baseline-mark.png" alt="" width={494} height={420} style={{ height: 26, width: "auto" }} priority />
          <span className="wm">Baseline</span>
        </Link>
        <nav className="mk-links" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={current === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="row g2">
          {isAuthed ? (
            <Link href="/dashboard" className="btn btn-optic btn-sm">Dashboard</Link>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost btn-sm">Log in</Link>
              <Link href="/signup" className="btn btn-optic btn-sm">Start free</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
