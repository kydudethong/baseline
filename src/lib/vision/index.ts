import { MockVisionProvider } from "./mock-provider";
import type { VisionProvider } from "./types";

export type { VisionProvider, VisionInput, VisionAnalysis } from "./types";

/**
 * Returns the active VisionProvider. Phase 1 only has the mock. When
 * `RoboflowVisionProvider` is built, switch on `process.env.VISION_PROVIDER`
 * here — nothing else in the app should need to change.
 */
export function getVisionProvider(): VisionProvider {
  return new MockVisionProvider();
}
