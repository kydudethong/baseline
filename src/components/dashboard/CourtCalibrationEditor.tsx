"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { courtSegments } from "@/lib/vision/court-model";
import { useDialog } from "@/components/ui/Dialog";

export interface CornerPx {
  x: number;
  y: number;
}
export interface FullCourtCorners {
  topLeft: CornerPx;
  topRight: CornerPx;
  bottomLeft: CornerPx;
  bottomRight: CornerPx;
}

type CornerKey = keyof FullCourtCorners;
const KEYS: CornerKey[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
const LABEL: Record<CornerKey, string> = {
  topLeft: "Far baseline, left",
  topRight: "Far baseline, right",
  bottomLeft: "Near baseline, left",
  bottomRight: "Near baseline, right",
};

/**
 * Drag the four baseline corners onto the painted lines. The full court
 * model (net, both kitchen lines, centre lines) is projected live through
 * the homography those corners define, so a wrong corner is obvious — the
 * net line drifts off the real net. Saving stores a manual, full-court
 * calibration and rebuilds movement + shots from the data already on file.
 */
export function CourtCalibrationEditor({
  analysisId,
  imageUrl,
  width,
  height,
  initial,
  source,
}: {
  analysisId: string;
  imageUrl: string;
  width: number;
  height: number;
  initial: FullCourtCorners;
  /** Where the starting corners came from — so the copy can say "auto-detected, check it" vs "you set this". */
  source: "auto" | "manual" | "none";
}) {
  const router = useRouter();
  const dialog = useDialog();
  const svgRef = useRef<SVGSVGElement>(null);
  const [corners, setCorners] = useState<FullCourtCorners>(initial);
  const [drag, setDrag] = useState<CornerKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Court model in "full" units: x 0..1 across (20 ft), y 0 = far baseline, 1 = near baseline (44 ft).
  // Same geometry as the setup canvas, from the same module.
  //
  // This used to be its own normalized 0..1 court with the kitchen at 7/44 and
  // the net as a flat line -- a second coordinate system for the same court,
  // and one that could not show the net's HEIGHT. The segmenter decides which
  // side of the net the ball is on using that height, so an editor that hides
  // it lets someone confirm a court whose net band is wrong.
  //
  // Corner order differs between the two: this editor names them by image
  // position (top/bottom), the model wants them in court order starting at the
  // near baseline. Converting here rather than changing either convention.
  const model = useMemo(() => {
    const inCourtOrder = [
      corners.bottomLeft,  // nearLeft
      corners.bottomRight, // nearRight
      corners.topRight,    // farRight
      corners.topLeft,     // farLeft
    ];
    const segs = courtSegments(inCourtOrder, "full");
    if (segs.length === 0) return null;
    return {
      lines: segs.filter((sg) => sg.role !== "net" && sg.role !== "net-post"),
      net: segs.filter((sg) => sg.role === "net" || sg.role === "net-post"),
    };
  }, [corners]);

  function toImage(e: React.PointerEvent): CornerPx | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: Math.max(0, Math.min(width, pt.x)), y: Math.max(0, Math.min(height, pt.y)) };
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyses/${analysisId}/calibration`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ corners }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save the court.");
      router.refresh();
      dialog?.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the court.");
    } finally {
      setBusy(false);
    }
  }

  const handleR = Math.max(9, width / 110);

  return (
    <div className="stack g4">
      <p className="sm measure">
        {source === "manual"
          ? "You set these corners. Drag any of them if the lines have drifted off the court."
          : source === "auto"
            ? "Baseline found the court automatically — check it. Drag the four corners until the yellow lines sit on the painted baselines and sidelines; the net line should land on the net."
            : "Drag the four corners onto the court's baseline corners. Every distance, zone and shot type is measured against these lines."}
      </p>

      <div className="frame" style={{ aspectRatio: `${width} / ${height}`, touchAction: "none" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = toImage(e);
            if (p) setCorners((c) => ({ ...c, [drag]: p }));
          }}
          onPointerUp={() => setDrag(null)}
          onPointerLeave={() => setDrag(null)}
        >
          <image href={imageUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="xMidYMid meet" />
          {model ? (
            <g fill="none" strokeLinecap="round">
              {model.lines.map((l, i) => (
                <line key={i} x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} stroke="#CFE23A" strokeWidth={Math.max(2, width / 480)} />
              ))}
              {/* The net, drawn at its real height: floor line, sagging tape,
                  and both posts. Four segments where there was one. */}
              {model.net.map((n, i) => (
                <line
                  key={`net-${i}`}
                  x1={n.a[0]} y1={n.a[1]} x2={n.b[0]} y2={n.b[1]}
                  stroke="#FF4FD8"
                  strokeWidth={Math.max(2.5, width / 400)}
                  strokeDasharray={n.role === "net-post" ? undefined : `${width / 80} ${width / 160}`}
                />
              ))}
            </g>
          ) : null}
          {KEYS.map((k) => (
            <g key={k} style={{ cursor: "grab" }} onPointerDown={(e) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(k); }}>
              <circle cx={corners[k].x} cy={corners[k].y} r={handleR * 2.2} fill="rgba(207,226,58,.18)" />
              <circle cx={corners[k].x} cy={corners[k].y} r={handleR} fill="#CFE23A" stroke="#1B1E06" strokeWidth={Math.max(1.5, width / 900)} />
            </g>
          ))}
        </svg>
      </div>

      <div className="row g3" style={{ justifyContent: "space-between" }}>
        <span className="xs">
          {KEYS.map((k) => `${LABEL[k]}: ${Math.round(corners[k].x)}, ${Math.round(corners[k].y)}`).join(" · ")}
        </span>
      </div>

      <div className="row g3" style={{ alignItems: "center" }}>
        <button type="button" className="btn btn-optic" onClick={() => void save()} disabled={busy}>
          {busy ? "Recomputing…" : "Save court & recompute"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCorners(initial)} disabled={busy}>
          Reset
        </button>
        {error ? <span className="xs" style={{ color: "var(--bad)" }}>{error}</span> : null}
      </div>
      {busy ? (
        <span className="status-line">
          <span className="dot" />
          Rebuilding movement and shots from the stored tracks — a few seconds.
        </span>
      ) : (
        <p className="xs">After saving, regenerate your coaching read so it uses the corrected court.</p>
      )}
    </div>
  );
}
