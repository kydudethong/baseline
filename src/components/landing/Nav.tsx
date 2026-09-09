import Link from "next/link";
import Image from "next/image";

export function Nav({ isAuthed }: { isAuthed: boolean }) {
  return (
    <header className="topbar" style={{ position: "static", borderBottom: 0, background: "transparent", backdropFilter: "none", maxWidth: 1180, margin: "0 auto", width: "100%" }}>
      <Link href="/" className="logo">
        <Image src="/brand/baseline-mark.png" alt="" width={494} height={420} style={{ height: 26, width: "auto" }} priority />
        <span className="wm">Baseline</span>
      </Link>
      <nav className="topnav" style={{ marginLeft: "var(--a6)", marginRight: "auto" }}>
        <a href="#how-it-works">How it works</a>
        <a href="#features">What you get</a>
      </nav>
      <div className="row g3">
        {isAuthed ? (
          <Link href="/dashboard" className="btn btn-optic btn-sm">
            Dashboard
          </Link>
        ) : (
          <>
            <Link href="/login" className="btn btn-ghost btn-sm">
              Log in
            </Link>
            <Link href="/signup" className="btn btn-optic btn-sm">
              Get started
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
