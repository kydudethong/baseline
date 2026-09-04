"use client";

import type { CoachingSkillRatingRow } from "@/lib/db/types";
import { SKILLS } from "@/lib/coaching/types";

const GROUP_ORDER = ["Kitchen", "Movement", "Serve & return", "Offense", "Decisions", "Defense"];
const GROUP_COLOR: Record<string, string> = {
  Kitchen: "#8B5CF6",
  Movement: "#06B6D4",
  "Serve & return": "#EC4899",
  Offense: "#F97316",
  Decisions: "#EAB308",
  Defense: "#3B82F6",
};

interface GroupScore {
  group: string;
  avg: number | null;
  count: number;
}

function groupScores(skills: CoachingSkillRatingRow[]): GroupScore[] {
  const byGroup = new Map<string, number[]>();
  for (const s of skills) {
    const meta = SKILLS.find((k) => k.key === s.skill_key);
    if (!meta) continue;
    const list = byGroup.get(meta.group) ?? [];
    list.push(s.raw);
    byGroup.set(meta.group, list);
  }
  return GROUP_ORDER.map((group) => {
    const values = byGroup.get(group);
    return {
      group,
      avg: values && values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
      count: values?.length ?? 0,
    };
  });
}

/**
 * A hexagon radar of the six skill groups (see SKILLS in coaching/types.ts)
 * plus a headline "single game" number — the shape of read Ky asked to
 * match from another pickleball app's skill-rating screen, adapted so the
 * chart still means something: each vertex's radius is the actual 1-5
 * average for that group (a real value, unlike a decorative equal-wedge
 * pie), and a group with no rated skills this analysis sits at the center
 * with a "—" label rather than implying a score of zero.
 */
export function SkillRadar({ skills }: { skills: CoachingSkillRatingRow[] }) {
  const groups = groupScores(skills);
  const rated = skills.filter((s) => Number.isFinite(s.raw));
  const overall = rated.length > 0 ? rated.reduce((a, b) => a + b.raw, 0) / rated.length : null;

  const size = 220;
  const center = size / 2;
  const maxR = size / 2 - 34;
  const n = groups.length;

  const pointFor = (i: number, value: number) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const r = (Math.max(0, Math.min(5, value)) / 5) * maxR;
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)] as const;
  };
  const labelPointFor = (i: number) => {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const r = maxR + 20;
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)] as const;
  };

  const polygonPoints = groups.map((g, i) => pointFor(i, g.avg ?? 0)).map(([x, y]) => `${x},${y}`).join(" ");
  const gridRings = [1, 2, 3, 4, 5];

  return (
    <div className="stack g5">
      <div className="row g6" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <div className="stack g1">
          <span className="eyebrow">Single analysis</span>
          <span className="eyebrow" style={{ letterSpacing: ".09em" }}>Skill rating</span>
          <span className="d1" style={{ lineHeight: 1 }}>{overall !== null ? overall.toFixed(2) : "—"}</span>
        </div>

        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: "none" }}>
          {gridRings.map((ring) => {
            const pts = groups
              .map((_, i) => pointFor(i, ring))
              .map(([x, y]) => `${x},${y}`)
              .join(" ");
            return <polygon key={ring} points={pts} fill="none" stroke="var(--line)" strokeWidth={1} />;
          })}
          {groups.map((_, i) => {
            const [x, y] = pointFor(i, 5);
            return <line key={i} x1={center} y1={center} x2={x} y2={y} stroke="var(--line)" strokeWidth={1} />;
          })}
          <polygon points={polygonPoints} fill="var(--blue)" fillOpacity={0.22} stroke="var(--blue)" strokeWidth={2} />
          {groups.map((g, i) => {
            const [x, y] = pointFor(i, g.avg ?? 0);
            return g.avg !== null ? (
              <circle key={g.group} cx={x} cy={y} r={4.5} fill={GROUP_COLOR[g.group]} stroke="#fff" strokeWidth={1.5} />
            ) : null;
          })}
          {groups.map((g, i) => {
            const [x, y] = labelPointFor(i);
            return (
              <text
                key={g.group}
                x={x}
                y={y}
                fontSize={10.5}
                fontFamily="var(--ui)"
                fontWeight={600}
                fill="var(--ink-3)"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {g.group}
              </text>
            );
          })}
        </svg>
      </div>

      <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        {groups.map((g) => (
          <div
            key={g.group}
            className="card"
            style={{
              boxShadow: "none",
              border: `1px solid ${GROUP_COLOR[g.group]}33`,
              background: `${GROUP_COLOR[g.group]}0f`,
              padding: "var(--a3) var(--a4)",
            }}
          >
            <p className="xs" style={{ color: GROUP_COLOR[g.group], fontWeight: 700 }}>{g.group}</p>
            <p className="h2" style={{ marginTop: 2 }}>{g.avg !== null ? g.avg.toFixed(2) : "—"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
