# GraphRenderer contract — positions & state (card D1)

Normative spec for every adapter behind the `GraphRenderer` interface
(`renderer.ts`), for the adapter registry (`registry.ts`), and for the app
code that drives a renderer. Verified by the contract test
(`frontend/scripts/render-contract.test.ts`, run via `npm run test`).

Roles:

- **Store** (`src/store/graph-store.ts`, card C2) — the single source of truth
  for graph _content_: nodes, edges, cursor/page state, selection, and the
  focus token. It never stores positions or camera state.
- **App/React layer** — fetches slices into the store, subscribes to store
  state, and drives the renderer: `set()` on data changes, `focus()` on focus
  changes, `resize()` on container changes. Applies renderer events to the
  store.
- **Renderer (adapter)** — owns all _visual_ state: node positions, layout,
  camera, styling, hit-testing. Consumes data copies; emits node activations.

## 1. Data flow: one-way, copy semantics

1.1 The only data channel into a renderer is `set(graph: RendererGraph)`.
The app passes a full replacement of the visible graph — there is no
diff/patch API. Incremental growth (cursor pages) is the store's
business; the renderer just sees "the current whole graph, again".

1.2 **Ownership transfer.** After `set()`, the renderer OWNS the handed
`nodes[]`/`links[]` objects and may mutate them in place (positions,
engine internals). The app must not keep references to those objects —
they are no longer the app's to read.

1.3 **The store is unaffected.** `GraphStore.toGraphData()` returns fresh
node/link object copies on every call (verified in the contract test),
so renderer-side mutations can never leak back into store state. This is
what makes 1.2 safe.

1.4 `store.toGraphData()` output is directly assignable to `RendererGraph`
(checked at compile time in the contract test). Adapters must not
require extra fields; anything beyond `id/label/group/color/source/target`
is adapter-specific decoration.

## 2. Positions contract

P1. **Ownership.** Node positions belong exclusively to the renderer. The
store does not emit them and never observes them. `x/y/z` fields on
`RendererNode` exist so force-graph-style objects pass through, but
nothing writes positions into the store.

P2. **Incremental stability.** `set()` is a replacement, NOT a relayout
trigger: every node whose `id` survived the previous `set()` call MUST
keep its exact position. This is what makes expand-on-click (C2) smooth —
ingesting the next cursor page must not scatter the graph.

P3. **New-node placement.** Nodes new to the renderer get assigned
positions by the adapter. Deterministic seeding from the node id is
REQUIRED in the stub and RECOMMENDED for real engines (a full reload
should reproduce the layout). New nodes must not be left at an
undefined/NaN position observable through `getPositions()`.

P4. **Removal.** When a node id disappears from the graph, the renderer MUST
release all state for it (position, engine objects, styles). Ghost state
for removed ids must not appear in `getPositions()`.

P5. **Portability.** `getPositions()` returns a snapshot of every held
position. D4 (engine switch) uses it to hand positions to the incoming
adapter, so a switch is a no-refetch / no-relayout / no-lost-selection
operation.

P6. **Dimensionality.** 2D adapters (sigma) omit `z` in `NodePosition`;
3D adapters must fill it. `getPositions()` on a 2D adapter returns
2D positions and callers must not read `z`.

P7. **Position handoff (the receiving side of P5).** When a node arrives in
`set()` with finite `x/y` (and `z`, on a 3D adapter) coordinates, the
adapter MUST adopt those values verbatim — no reseeding. This is how D4's
engine switch carries the outgoing renderer's `getPositions()` snapshot
into the incoming one: a switch becomes a no-refetch / no-relayout /
no-lost-selection operation. Nodes without finite coordinates fall back to
the adapter's deterministic seed (P3). Surviving nodes are unaffected:
P2 still wins over the handed values.

## 3. View (camera) state contract

V1. **Ownership.** Camera position, zoom, and animation state belong to the
renderer. They are never serialized into the store and never passed in
`set()`.

V2. **Focus token protocol.** The store exposes `focusId` plus a MONOTONIC
`focusSequence` that bumps on every `focus()` call (card C2; the store
must NOT reset the token across `replaceSlice()` — see the contract
test "focus token survives store reload"). The app calls
`renderer.focus(id, sequence)` whenever it observes an increased
sequence. The renderer MUST re-trigger the fly-to only when
`sequence` is strictly greater than the last sequence it applied
(stale/duplicate tokens are ignored) and MUST ignore unknown node ids
(a focus on a node that `set()` never delivered is a no-op, not an
error).

V3. **resetView.** Fits all current nodes into view. No token: the app
decides when (the reset-view button).

## 4. Selection contract

S1. Selection is store-owned; the renderer holds none. Node activation is
one-way, renderer → app: `onNodeSelect(nodeId)`. The app applies it to
the store (select + focus + expand-on-click, card C2). The renderer MUST
report the node id only — never a position or a mutated node object
(it owns those and they may be mid-animation).

## 5. Lifecycle

```
create (registry factory) → mount(container) → set/focus/resize/resetView*
                          → onNodeSelect*   → dispose()
```

L1. `mount()` is called exactly once; calling it twice is a programming
error (throw).
L2. `set/focus/resize/resetView` before `mount()` throw (programming error).
L3. After `dispose()`: every method is a SILENT no-op (engines can have
in-flight async callbacks firing after teardown; throwing there would
turn a clean teardown into uncaught errors). `onNodeSelect` delivers no
further callbacks. The renderer MUST cancel in-flight work (layout
ticks, fly-to animations).
L4. `dispose()` is idempotent and releases engine resources (GL contexts,
workers, event listeners).

## 6. Registry

R1. `registerRenderer(id, factory, { isDefault })`: ids are non-empty
strings; duplicate ids THROW (unregister first); a non-function factory
throws.
R2. The registry stores factories, never instances — every `createRenderer`
/ `createDefaultRenderer` call returns a fresh, unmounted renderer
(mounting is per-container).
R3. Default: the first registered renderer becomes the default unless
`isDefault` is set explicitly; later registrations never steal the
default. Unregistering the default falls back to the first remaining
id (insertion order), or `null` when the registry is empty.
R4. `createRenderer(unknown)` and `createDefaultRenderer()` on an empty
registry throw with a message listing what IS available.

## 7. Adapter author checklist (for D2 sigma / D3 cosmos.gl)

- [ ] Implement every `GraphRenderer` method; register via
      `registerRenderer("<id>", factory, { isDefault: true })` for the
      first real adapter.
- [ ] `set()`: copy/adopt nodes, keep surviving positions (P2), adopt
      handed finite x/y(/z) on new nodes (P7) else seed them
      deterministically (P3), release removed (P4).
- [ ] `focus()`: strictly-increasing-sequence gate + unknown-id no-op (V2).
- [ ] `getPositions()`: full snapshot incl. brand-new nodes after `set()` (P5).
- [ ] `dispose()`: cancel animation/layout loops, remove listeners, free GL
      resources (L3/L4).
- [ ] Run the contract test against your adapter: it takes a factory, so
      `registerRenderer` your adapter and point the test's `makeRenderer`
      at it — or copy the test body verbatim with a different factory.
