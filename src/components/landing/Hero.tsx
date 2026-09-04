import Link from "next/link";
import { CourtWatermark } from "@/components/motifs/Motifs";

export function Hero({ analyzeHref }: { analyzeHref: string }) {
  return (
    <section style={{ borderBottom: "1px solid var(--line)", position: "relative", overflow: "hidden" }}>
      <CourtWatermark opacity={0.05} />
      <div
        className="row"
        style={{
          position: "relative",
          maxWidth: 1140,
          margin: "0 auto",
          padding: "88px var(--a5) 96px",
          gap: "var(--a7)",
          alignItems: "center",
        }}
      >
        <div className="stack g4" style={{ flex: "1 1 420px", minWidth: 0 }}>
          <span className="eyebrow" style={{ color: "var(--optic)" }}>
            Now in early access
          </span>
          <h1 className="d1" style={{ maxWidth: "14ch" }}>
            Turn game footage into a real coaching session.
          </h1>
          <p className="body measure" style={{ maxWidth: "42ch" }}>
            Upload a recording of your match. Baseline breaks down your positioning, footwork, and readiness
            patterns — the way a coach would, without waiting a week for the video review.
          </p>
          <div className="row g3" style={{ marginTop: "var(--a2)" }}>
            <Link href={analyzeHref} className="btn btn-optic">
              Analyze your game
            </Link>
            <a href="#how-it-works" className="btn btn-soft">
              See how it works
            </a>
          </div>
          <span className="xs">Free while in early access. No credit card required.</span>
        </div>

        <div style={{ flex: "1 1 380px", minWidth: 0 }}>
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div className="row g2" style={{ padding: "var(--a3) var(--a4)", borderBottom: "1px solid var(--line)" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--bad)" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--warn)" }} />
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--good)" }} />
              <span className="xs" style={{ marginLeft: "var(--a2)" }}>
                match_09-14.mp4 — processing
              </span>
            </div>
            <div className="stack g3" style={{ padding: "var(--a4)" }}>
              <div style={{ aspectRatio: "16 / 9", borderRadius: "var(--r2)", background: "var(--night)" }} />
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="sm" style={{ fontWeight: 600, color: "var(--ink)" }}>
                  Status
                </span>
                <span className="pill p-live">
                  <span className="dot" />
                  Processing
                </span>
              </div>
              <div className="track">
                <div className="fill" style={{ width: "66%" }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
