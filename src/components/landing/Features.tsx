import { Ball, Paddle, Net } from "@/components/motifs/Motifs";
import type { ReactNode } from "react";

/**
 * Written to sound like the person who built it, because the person who built
 * it is the only one who can say these things.
 *
 * The previous copy was six cards of identical length, identical shape, an
 * em-dash in every one, and not a single number. That is what generated
 * marketing text reads like, and on a page whose entire pitch is "this tool
 * does not make things up", it was the worst possible voice: fluent, parallel,
 * and unfalsifiable.
 *
 * So: real mechanisms by name, real figures where there are any, uneven
 * lengths, and the limits stated flatly instead of spun. Anyone who knows
 * pickleball can check every claim here against their own footage, which is
 * the point.
 */
const FEATURES: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Rallies, found three ways",
    body:
      "The ball crossing the net and coming back is the definition, so that is the first test. When the ball is lost, paddle contacts on both sides carry it. A rally stays open while contacts keep alternating sides, and ends when the ball bounces twice on one side, which is the actual rule of the game.",
    icon: <Net width={26} height={16} />,
  },
  {
    title: "Audio, but only when the ball agrees",
    body:
      "A paddle strike is a sharp transient, and a microphone hears the courts either side of you just as well as yours. Every sound is checked against the ball: if it did not turn or change pace at that instant, the sound was not yours. On our test clip that took 76 candidate hits down to 26.",
    icon: <Ball size={22} />,
  },
  {
    title: "Shot types with the rule attached",
    body:
      "Dink, drive, drop, serve, reset, lob. Each one shows the rule that fired and the numbers it fired on, so you can disagree with it.",
    icon: <Paddle size={20} />,
  },
  {
    title: "Body position at contact",
    body:
      "Knee angle, how high you met the ball, how far out in front, backswing, shoulder turn. Measured in your own shoulder widths rather than pixels, so being at the far end of the court does not change the numbers.",
    icon: <Ball size={22} />,
  },
  {
    title: "No paddle tracking",
    body:
      "Nothing here sees your paddle, so nothing here will tell you about your grip, your paddle face or its path. Plenty of tools claim it from this camera angle. It is not in the footage.",
    icon: <Paddle size={20} />,
  },
  {
    title: "Missing is missing",
    body:
      "Ball coverage varies a lot with the footage, and the analysis tells you what it was. Anything that could not be measured says so instead of quietly showing zero.",
    icon: <Net width={26} height={16} />,
  },
];

export function Features() {
  return (
    <section id="features" style={{ background: "var(--sunk)" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "var(--a7) var(--a5)" }}>
        <div className="stack g2" style={{ maxWidth: "52ch", marginBottom: "var(--a6)" }}>
          <h2 className="d2">What you get</h2>
          <p className="body">
            One fixed camera behind the baseline, one game per clip. Here is what comes
            back, and what does not.
          </p>
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
