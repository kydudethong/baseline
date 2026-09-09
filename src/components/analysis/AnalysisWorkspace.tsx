"use client";

import { useMemo, useState } from "react";
import Player from "@/components/breakdown/Player";
import type { AnalysisView, ViewRally, ViewShot } from "@/lib/db/analysis-view";
import type { CoachingObservationRow } from "@/lib/db/types";
import { RallyTimeline } from "./RallyTimeline";
import { ShotSequence } from "./ShotSequence";
import { CoachingInsight } from "./CoachingInsight";
import { MetricCard } from "./MetricCard";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { EmptyState } from "./EmptyState";
import { StatTiles } from "./StatTiles";
import { shotName } from "./ShotBadge";
import { skillName } from "@/lib/coaching/types";

/**
 * One workspace instead of six tabs.
 *
 * The old page put the video on one tab and the coaching on another, so
 * reading why a shot was wrong meant leaving the shot. Everything here shares
 * one selection: pick a rally, the video jumps there and the panel follows;
 * pick a shot, the video jumps to that contact and the panel shows what the
 * pipeline measured about it.
 *
 * Selection lives in client state rather than the URL because it changes on
 * every click and each change was previously a full server round-trip. The
 * data is still fetched server-side and handed down — this component fetches
 * nothing.
 *
 * LAYOUT. Video left, a tabbed reading panel of near-equal width beside it,
 * and the skill breakdown across the full width underneath.
 *
 * The tabs are not a return to the six-tab page this replaced. There the tabs
 * owned the whole screen, so watching a rally meant leaving the video; here
 * the video is persistent and the tabs only switch what you read next to it.
 * That is navigation, not fragmentation.
 *
 * The panel is near-equal width to the video on purpose. A first pass ran it
 * at 0.8fr against 1.75fr and the coaching turned into a tall thin ribbon
 * while the left column ran out of content a few hundred pixels below the
 * video and left a hole. Prose needs a measure; the fix was width, not a
 * different column.
 */
export function AnalysisWorkspace({
  view, videoUrl, drillNames, heroObservationId = null,
}: {
  view: AnalysisView;
  videoUrl: string;
  /** slug → human name, so an insight can name its drill. */
  drillNames: Record<string, string>;
  /**
   * The top-priority observation, which leads the read BELOW this workspace.
   * Skipped here so the same paragraph is not printed twice on one page; a
   * one-line pointer takes its place when it belongs to the selected rally.
   */
  heroObservationId?: string | null;
}) {
  const [rallyIdx, setRallyIdx] = useState<number | null>(view.rallies[0]?.idx ?? null);
  const [shot, setShot] = useState<ViewShot | null>(null);
  const [seek, setSeek] = useState<{ t: number; nonce: number } | null>(null);

  const rally = useMemo(
    () => view.rallies.find((r) => r.idx === rallyIdx) ?? null,
    [view.rallies, rallyIdx]
  );

  const selectRally = (r: ViewRally) => {
    setRallyIdx(r.idx);
    setShot(null);
    setSeek({ t: r.startS, nonce: Date.now() });
  };

  const selectShot = (s: ViewShot) => {
    setShot(s);
    // A little before the contact: landing exactly on it means the strike has
    // already happened by the first painted frame, and the swing is the part
    // worth seeing.
    setSeek({ t: Math.max(0, s.t - 1.2), nonce: Date.now() });
  };

  const observations = view.coaching?.observations ?? [];
  // One note per rally for the video timeline's tooltips: the first observation
  // that names it. The panel shows all of them; this is just the hover.
  const observationsByRally = new Map<number, string>();
  for (const o of observations) {
    if (o.rally_idx !== null && !observationsByRally.has(o.rally_idx)) {
      observationsByRally.set(o.rally_idx, o.title);
    }
  }
  // Player predates the view model and takes the database's snake_case shape.
  // Converting here rather than changing Player keeps its proven timeline and
  // keyboard handling untouched.
  const rallyMarks = view.rallies.map((r) => ({
    idx: r.idx,
    start_s: r.startS,
    end_s: r.endS,
    shots: r.shots.length || r.contactCount,
    note: observationsByRally.get(r.idx) ?? null,
  }));
  const rallyObservations = rally
    ? observations.filter((o) => o.rally_idx === rally.idx && o.id !== heroObservationId)
    : [];
  const heroIsHere = Boolean(
    rally && heroObservationId
    && observations.some((o) => o.id === heroObservationId && o.rally_idx === rally.idx)
  );
  const skills = view.coaching?.skills ?? [];
  // Every drill the coach actually pointed at, once each, with the point it
  // was prescribed for. Not the whole catalogue — that is its own page.
  const prescribed = observations.filter((o) => o.drill_slug);

  const TABS = [
    { key: "overview", label: "Overview", count: observations.length },
    { key: "rally", label: "Rally", count: rally ? rally.shots.length || rally.contactCount : 0 },
    { key: "technique", label: "Technique", count: null },
    { key: "drills", label: "Drills", count: prescribed.length },
  ] as const;
  type TabKey = (typeof TABS)[number]["key"];
  const [tab, setTab] = useState<TabKey>("overview");

  // Picking a shot is a request to see what was measured about it, so the
  // panel follows the click instead of making the user find the tab.
  const selectShotAndShow = (sh: ViewShot) => {
    selectShot(sh);
    setTab("technique");
  };

  return (
    <div className="stack g5">
      {/* Above the split, full width. These are the numbers that qualify
          everything below them — how much of the clip was live, how many
          shots got measured, how often the ball was actually visible — so
          they belong where they are read first, not in a footnote at the
          bottom of the technical tab. */}
      <StatTiles view={view} />

      <div className="ws">
        <div className="ws-main">
          <div className="ws-video">
            <Player
              videoUrl={videoUrl}
              rallies={rallyMarks}
              durationS={view.video?.durationSeconds ?? 0}
              seekRequest={seek}
            />
          </div>

          {view.rallies.length > 0 ? (
            <section>
              <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                <p className="eyebrow">
                  {view.rallies.length} rall{view.rallies.length === 1 ? "y" : "ies"}
                </p>
                {view.ralliesAreReDerived ? (
                  <span className="caveat">
                    <span className="caveat-mk">i</span>
                    Boundaries re-derived from contact timing — this clip was analysed
                    before rally tracking was recorded directly.
                  </span>
                ) : null}
              </div>
              <RallyTimeline rallies={view.rallies} selectedIdx={rallyIdx} onSelect={selectRally} />
            </section>
          ) : (
            <EmptyState
              title="No rallies were found in this clip"
              body="The ball has to cross the net and come back for a rally to count. If this
                    was a real game, the ball may not have been tracked well enough — the
                    tracking overlay on the technical view shows what the system saw."
            />
          )}

          {view.quality ? <QualityNote view={view} /> : null}
        </div>

        <section className="panel">
          <div className="panel-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                {t.count ? <span className="cnt">{t.count}</span> : null}
              </button>
            ))}
          </div>

          <div className="panel-body">
            {tab === "overview" ? <Overview view={view} observations={observations} /> : null}

            {tab === "rally" ? (
              rally ? (
                <>
                  <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                    <h3 className="h3" style={{ margin: 0 }}>Rally {rally.idx}</h3>
                    <span className="xs num">
                      {rally.startS.toFixed(1)}s – {rally.endS.toFixed(1)}s
                    </span>
                  </div>
                  <RallyFacts rally={rally} />
                  <ShotSequence rally={rally} selectedShot={shot} onSelectShot={selectShotAndShow} />
                  {rallyObservations.length > 0 || heroIsHere ? (
                    <>
                      <p className="eyebrow">Coaching on this rally</p>
                      {heroIsHere ? (
                        <p className="caveat">
                          <span className="caveat-mk">i</span>
                          Your top priority fix was seen in this rally — it leads the read
                          below, so it is not repeated here.
                        </p>
                      ) : null}
                      {rallyObservations.map((o: CoachingObservationRow) => (
                        <CoachingInsight
                          key={o.id}
                          observation={o}
                          drillName={o.drill_slug ? drillNames[o.drill_slug] : null}
                        />
                      ))}
                    </>
                  ) : null}
                </>
              ) : (
                <p className="sm">Pick a rally on the left to see how it played out.</p>
              )
            ) : null}

            {tab === "technique" ? (
              shot ? <ShotDetail shot={shot} /> : (
                <p className="sm">
                  Pick a contact in the Rally tab and this shows what your body was doing
                  at it — knee bend, contact height, reach and shoulder turn, measured in
                  your own shoulder widths.
                </p>
              )
            ) : null}

            {tab === "drills" ? (
              prescribed.length > 0 ? (
                <div className="stack g4">
                  {prescribed.map((o) => (
                    <div key={o.id} className="insight-drill" style={{ alignItems: "flex-start" }}>
                      <span className="stack" style={{ gap: 3, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, color: "var(--ink)" }}>
                          {drillNames[o.drill_slug!] ?? o.drill_slug}
                        </span>
                        <span className="xs">For: {o.title}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="sm">
                  No drill was prescribed for this clip. A drill is only attached where the
                  coach could name a specific fix — a strength has nothing to practise.
                </p>
              )
            ) : null}
          </div>
        </section>
      </div>

      {skills.length > 0 ? (
        <section className="sec">
          <div className="sec-head">
            <h2 className="h2">Breakdown</h2>
            <span className="xs">Rated 1&ndash;5 from this clip, with what each rating rests on</span>
          </div>
          <div className="breakdown">
            {skills.map((sk) => (
              <div
                key={sk.id}
                className={`bd-card${sk.raw >= 4 ? " strong" : sk.raw <= 2 ? " weak-rating" : ""}`}
              >
                <span className="bd-score">
                  <span className="n">{sk.raw}</span>
                  <span className="of">/5</span>
                </span>
                <span className="bd-name">{skillName(sk.skill_key)}</span>
                {sk.basis ? <span className="bd-basis">{sk.basis}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );

}

/**
 * Key takeaways for the whole clip.
 *
 * A chip carries the verdict — a strength, a priority, something worth
 * fixing — so the list can be scanned without reading every line. There is
 * deliberately no headline score above it: nothing in this pipeline computes
 * a composite rating, and a number in that slot would be invented.
 */
function Overview({ view, observations }: { view: AnalysisView; observations: CoachingObservationRow[] }) {
  if (observations.length === 0) {
    return (
      <p className="sm">
        No coaching read yet for this clip. Tag which player is you and Baseline
        will write one.
      </p>
    );
  }
  const coverage = view.quality?.ball_coverage ?? null;
  return (
    <>
      <p className="eyebrow">Key takeaways</p>
      <div className="stack g4">
        {observations.slice(0, 6).map((o) => {
          const tone = o.valence === "strength" ? "good" : o.severity >= 4 ? "bad" : "warn";
          return (
            <div className="take" key={o.id}>
              <span className={`take-ic ${tone}`}>{o.valence === "strength" ? "\u2713" : "!"}</span>
              <span>
                <span className="take-t">{o.title}</span>
                <span className="take-d">{o.what_to_change ?? o.detail}</span>
              </span>
            </div>
          );
        })}
      </div>
      {coverage !== null ? (
        <p className="caveat" style={{ marginTop: "auto" }}>
          <span className="caveat-mk">i</span>
          Read from footage where the ball was visible in {Math.round(coverage * 100)}% of
          frames. Everything above rests on that.
        </p>
      ) : null}
    </>
  );
}

/** The evidence behind a rally's boundaries, in plain words. */
function RallyFacts({ rally }: { rally: ViewRally }) {
  const bits: string[] = [];
  if (rally.crossingCount !== null) {
    bits.push(`${rally.crossingCount} net crossing${rally.crossingCount === 1 ? "" : "s"}`);
  }
  bits.push(`${rally.contactCount} contact${rally.contactCount === 1 ? "" : "s"}`);
  if (rally.extendedSeconds > 0) {
    // Worth saying out loud: this rally would have been cut short before.
    bits.push(`held open ${rally.extendedSeconds.toFixed(1)}s through continued back-and-forth`);
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <p className="sm" style={{ margin: 0 }}>{bits.join(" · ")}</p>
      {rally.endReason ? <p className="xs" style={{ margin: 0 }}>Ended: {rally.endReason}</p> : null}
      {rally.verdict && rally.verdict !== "unknown" && rally.verdictReason ? (
        <p className="xs" style={{ margin: 0 }}>
          {rally.verdictReason}
          <ConfidenceIndicator value={rally.verdictConfidence} label="Verdict" className="mla" />
        </p>
      ) : null}
    </div>
  );
}

/**
 * What was measured about one shot.
 *
 * Mechanics are shown only when they exist, and each individual field falls
 * back to "Not available" rather than zero. `features.why` is the classifier's
 * own rule, shown verbatim: the user should be able to see why the system
 * called it a dink rather than take it on faith.
 */
function ShotDetail({ shot }: { shot: ViewShot }) {
  const m = shot.mechanics;
  const why = typeof (shot.features?.why) === "string" ? shot.features.why as string : null;
  return (
    <section className="card stack g3">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <h3 className="h3" style={{ margin: 0 }}>
          {shotName(shot.type)} <span className="xs num">at {shot.t.toFixed(1)}s</span>
        </h3>
        <ConfidenceIndicator value={shot.confidence} label="Classification" />
      </div>

      {why ? <p className="xs" style={{ margin: 0 }}>Classified because: {why}</p> : null}

      {m ? (
        <>
          <p className="eyebrow">Your body at contact</p>
          <div className="metrics">
            <MetricCard label="Knee angle" value={m.knee_angle_at_contact_deg} unit="°"
              note="180° is a straight leg" />
            <MetricCard label="Contact height" value={m.contact_height_torsos} decimals={2} unit="×"
              note="torsos above the shoulder line" />
            <MetricCard label="Reach" value={m.contact_reach_shoulders} decimals={2} unit="×"
              note="shoulder widths from the body" />
            <MetricCard label="Backswing" value={m.backswing_shoulders} decimals={2} unit="×" />
            <MetricCard label="Swing speed" value={m.wrist_speed_into_contact} decimals={2}
              note="shoulder widths per second" />
            <MetricCard label="Follow-through" value={m.follow_through_shoulders} decimals={2} unit="×" />
            <MetricCard label="Shoulder turn" value={m.shoulder_rotation_deg} unit="°" />
          </div>
          <p className="caveat">
            <span className="caveat-mk">i</span>
            Measured from body position, in your own shoulder widths — no paddle is
            tracked, so nothing here describes the paddle face or its path.
          </p>
        </>
      ) : (
        <p className="sm" style={{ margin: 0 }}>
          Body position was not measured at this contact.
        </p>
      )}
    </section>
  );
}

/** How much of this analysis to trust, from what the pipeline recorded. */
function QualityNote({ view }: { view: AnalysisView }) {
  const q = view.quality!;
  const coverage = q.ball_coverage;
  const limitations = q.limitations ?? [];
  if (coverage === null && limitations.length === 0) return null;
  return (
    <details className="card">
      <summary className="sm" style={{ cursor: "pointer" }}>
        How reliable is this analysis?
        {coverage !== null ? ` · ball seen in ${Math.round(coverage * 100)}% of frames` : ""}
      </summary>
      <div className="stack g2" style={{ marginTop: 12 }}>
        {limitations.map((l, i) => (
          <p key={i} className="xs" style={{ margin: 0 }}>· {l}</p>
        ))}
      </div>
    </details>
  );
}
