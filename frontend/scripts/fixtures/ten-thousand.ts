// Card D2 S3 — deterministic 10,000-node fixture for the sigma 10k
// interactive check (scripts/render-scale.test.ts).
//
// Same generator as the shared 2k fixture (cosmos-two-thousand.ts — the ring
// + deterministic cross-link builder is already parameterised by node
// count), just the scale factor below. No randomness: the check must be
// reproducible, like every other fixture. The 2k fixture itself is left
// untouched so the D2/D3 cards' comparable results stand.

import type { RendererGraph } from "../../src/render/renderer";
import { makeTwoThousandNodeGraph } from "./cosmos-two-thousand";

/** Scale factor applied to the shared generator: 2,000 → 10,000 nodes. */
export const TEN_THOUSAND_SCALE = 5;

export function makeTenThousandNodeGraph(): RendererGraph {
  return makeTwoThousandNodeGraph(2000 * TEN_THOUSAND_SCALE);
}
