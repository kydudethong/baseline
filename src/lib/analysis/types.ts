import type { VisionAnalysis } from "@/lib/vision/types";

/**
 * The AI-analysis abstraction boundary. `MockAnalysisEngine` (mock-engine.ts)
 * is the only implementation in Phase 1 — it takes CV output and returns a
 * clearly-labeled placeholder result. A future engine (Roboflow CV output +
 * an LLM coaching pass) implements the same interface.
 */
export interface AnalysisResult {
  /** 'mock' in Phase 1. Never overwritten to look like a real result. */
  source: "mock" | "roboflow+llm";
  generatedAt: string;
  statistics: Record<string, number | string>;
  events: Array<{
    type: string;
    timestampSeconds: number;
    description: string;
  }>;
  insights: string[];
  recommendations: string[];
}

export interface AnalysisContext {
  title: string;
  durationSeconds: number | null;
}

export interface AnalysisEngine {
  readonly name: string;
  analyze(vision: VisionAnalysis, context: AnalysisContext): Promise<AnalysisResult>;
}
