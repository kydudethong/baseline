import Link from "next/link";
import { Ball } from "@/components/motifs/Motifs";

export function Nav({ isAuthed }: { isAuthed: boolean }) {
  return (
    <header className="topbar" style={{ position: "static", borderBottom: "1px solid var(--line)" }}>
      <Link href="/" className="logo">
        <Ball size={24} />
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
              Sign up
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
