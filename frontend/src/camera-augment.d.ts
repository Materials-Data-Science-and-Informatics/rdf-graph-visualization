// Card C3 — the force-graph runtime exposes cameraPosition() WITHOUT
// arguments as a getter (current position + look-at point), but the
// shipped .d.ts only declares the setter overload. Add the getter so the
// URL camera sync in Graph.tsx stays fully typed (no casts).
//
// Matches the force-graph implementation: when called without a position
// it returns { x, y, z, lookAt: { x, y, z } }.
//
// The `import` below makes this file a MODULE — required so the
// `declare module` block below is a genuine declaration AUGMENTATION of
// the real package instead of an ambient module declaration that would
// shadow it.

import "react-force-graph-3d";

declare module "react-force-graph-3d" {
  interface ForceGraphMethods {
    cameraPosition(): {
      x: number;
      y: number;
      z: number;
      lookAt: { x: number; y: number; z: number };
    };
  }
}
