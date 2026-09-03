import { MockAnalysisEngine } from "./mock-engine";
import type { AnalysisEngine } from "./types";

export type { AnalysisEngine, AnalysisResult, AnalysisContext } from "./types";

/**
 * Returns the active AnalysisEngine. Phase 1 only has the mock. When a real
 * engine (Roboflow CV output + an LLM coaching pass) is built, switch on
 * `process.env.ANALYSIS_ENGINE` here.
 */
export function getAnalysisEngine(): AnalysisEngine {
  return new MockAnalysisEngine();
}
