import type { VisionAnalysis } from "@/lib/vision/types";
import type { AnalysisContext, AnalysisEngine, AnalysisResult } from "./types";

/**
 * Placeholder AnalysisEngine. Turns (mock) CV output into a result shaped
 * exactly like a real one, so the dashboard/detail UI can be built and
 * tested now. `source: "mock"` is set unconditionally — see the comment
 * below for why this must never be spoofed as real.
 */
export class MockAnalysisEngine implements AnalysisEngine {
  readonly name = "mock";

  async analyze(vision: VisionAnalysis, context: AnalysisContext): Promise<AnalysisResult> {
    const rallyCount = Math.max(1, Math.round((context.durationSeconds ?? 60) / 45));
    const ballTrack = vision.tracks.find((t) => t.class === "ball");

    return {
      // Never change this without also changing the real engine's source
      // identifier — the UI uses this field to decide whether to show the
      // "development data" banner. See AnalysisResult in ./types.ts.
      source: "mock",
      generatedAt: new Date().toISOString(),
      statistics: {
        estimatedRallies: rallyCount,
        trackedObjects: vision.tracks.length,
        framesAnalyzed: vision.perFrame.length,
        ballTrackPoints: ballTrack?.points.length ?? 0,
      },
      events: vision.perFrame.slice(0, 3).map((frame, i) => ({
        type: "placeholder_event",
        timestampSeconds: frame.timestampSeconds,
        description: `Mock event ${i + 1} — real shot/rally detection lands in a later phase.`,
      })),
      insights: [
        `This is placeholder analysis for "${context.title}". No real computer vision or coaching model has run yet.`,
        "Once RoboflowVisionProvider and a real AnalysisEngine are implemented, this section will reflect what actually happened in your match.",
      ],
      recommendations: [
        "Nothing to act on yet — this is development data, not coaching advice.",
      ],
    };
  }
}
