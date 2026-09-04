import { Ball, Paddle, Net } from "@/components/motifs/Motifs";
import type { ReactNode } from "react";

const FEATURES: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Player & ball tracking",
    body: "Every player and every shot, tracked frame by frame across the court.",
    icon: <Ball size={22} />,
  },
  {
    title: "Court positioning",
    body: "See where you stand during transitions, dinks, and drives — and where you should.",
    icon: <Net width={26} height={16} />,
  },
  {
    title: "Shot & event detection",
    body: "Serves, drives, dinks, and drops identified automatically, timestamped to the video.",
    icon: <Paddle size={20} />,
  },
  {
    title: "Session statistics",
    body: "Rally length, shot mix, and movement patterns, tracked match over match.",
    icon: <Ball size={22} />,
  },
  {
    title: "AI coaching insights",
    body: "Specific, readable takeaways — not a dashboard you need a manual for.",
    icon: <Paddle size={20} />,
  },
  {
    title: "Private by default",
    body: "Your footage is yours. Stored privately and never used to train models on other users' behalf.",
    icon: <Net width={26} height={16} />,
  },
];

export function Features() {
  return (
    <section id="features" style={{ background: "var(--sunk)" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "var(--a7) var(--a5)" }}>
        <div className="stack g2" style={{ maxWidth: "44ch", marginBottom: "var(--a6)" }}>
          <h2 className="d2">What you get</h2>
          <p className="body">Built for players and coaches who want more than a highlight reel.</p>
        </div>
        <div className="grid2">
          {FEATURES.map((f) => (
            <div key={f.title} className="card stack g2">
              <div style={{ color: "var(--ink)" }}>{f.icon}</div>
              <h3 className="h3" style={{ color: "var(--ink)" }}>
                {f.title}
              </h3>
              <p className="sm">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
