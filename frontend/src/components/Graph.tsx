import * as React from "react";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import ForceGraph3D, {
  GraphData,
  NodeObject,
  LinkObject,
  ForceGraphMethods,
} from "react-force-graph-3d";
import * as THREE from "three";
import Legend from "./Legend.tsx";
import { getGroupColor } from "../config";
import FullScreenButton from "./FullScreenButton.tsx";
import ResetViewButton from "./ResetViewButton.tsx";
import ThemeSwitch from "./ThemeSwitch.tsx";
import { initialViewState, updateSearchKeys } from "../view-state";
import { graphStore } from "../store/use-graph-store";
import { flyCameraPosition, vecDistance } from "../lib/fly-to";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
  /** Optional node activation hook (card C2: select/focus/expand-on-click). */
  onNodeSelect?: (node: NodeObject) => void;
  /**
   * Monotonic store focus token (card E1). A change means "fly to the store's
   * focusId" — the token, not the id, drives the effect so re-focusing the
   * same node re-triggers (card C2 handoff).
   */
  focusSeq: number;
}

// Card E1 fly-to tuning. The transition itself stays well inside the card's
// <500 ms jump budget (the camera starts moving immediately).
const FLY_DISTANCE = 180; // world units from the node (graph spans a few hundred)
const FLY_DURATION_MS = 400;
const POS_RETRY_EVERY_MS = 60; // wait for d3 to assign a fresh node its position
const POS_RETRY_MAX = 6;
const REAIM_EVERY_MS = 300; // re-aim loop cadence while the layout settles
const REAIM_MAX_MS = 2400;
const REAIM_THRESHOLD = 30; // settle when the node is this close to the look-at

const Graph: React.FC<GraphProps> = ({ graphData, width, height, onNodeSelect, focusSeq }) => {
  // Fullscreen state for graph container
  const [isFullScreen, setIsFullScreen] = useState(false);
  // Separate width/height state to allow fullscreen to override parent dimensions
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);
  // Theme toggle: dark mode (default) vs light mode. Card C3: initial value
  // comes from the opened URL; changes are written back (replaceState).
  const [switchOn, setSwitchOn] = useState<boolean>(initialViewState.theme === "light");

  useEffect(() => {
    updateSearchKeys({ theme: switchOn ? "light" : null });
  }, [switchOn]);

  // Card C0 S4: drive the Tailwind dark variant from the same state — the
  // CSS-variable theme in index.css (:root vs .dark) follows the toggle.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", !switchOn);
  }, [switchOn]);

  // Reference to ForceGraph3D instance for camera control
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  // Always-current graph data for the fly-to loops (they outlive the render
  // that scheduled them; the force engine mutates these node objects in
  // place, so their x/y/z are live).
  const graphDataRef = useRef(graphData);
  graphDataRef.current = graphData;
  // Cache materials by color to avoid recreating same materials on each render
  const materialCacheRef = useRef<Map<string, THREE.Material>>(new Map());
  // Label color changes based on theme: black on white background, white on dark
  const labelColor = switchOn ? "#000000" : "#ffffff";

  // ------------------------------------------------------- card E1: fly-to

  // Pending fly-to work (position retries / re-aim interval) for the current
  // focus request; null when no fly is in flight.
  const flyRef = useRef<{ id: string; timer: number | null; interval: number | null } | null>(null);

  const cancelFly = useCallback(() => {
    const fly = flyRef.current;
    if (!fly) return;
    if (fly.timer !== null) window.clearTimeout(fly.timer);
    if (fly.interval !== null) window.clearInterval(fly.interval);
    flyRef.current = null;
  }, []);

  /**
   * Re-aim the camera while the force layout settles around a freshly merged
   * node (a /api/expand merge re-heats the simulation, so the node drifts
   * after the first jump). Re-aims at most REAIM_MAX_MS, stops as soon as the
   * node sits within REAIM_THRESHOLD of the camera's look-at point.
   */
  const startReaim = useCallback(
    (id: string) => {
      const startedAt = Date.now();
      const interval = window.setInterval(() => {
        const fly = flyRef.current;
        if (!fly || fly.id !== id) return; // cancelled or superseded
        if (Date.now() - startedAt >= REAIM_MAX_MS) {
          cancelFly();
          return;
        }
        const fg = fgRef.current;
        const node = graphDataRef.current.nodes.find((n) => n.id === id);
        if (!fg || !node || node.x === undefined || node.y === undefined || node.z === undefined) {
          cancelFly();
          return;
        }
        const look = fg.cameraPosition().lookAt;
        if (
          vecDistance({ x: node.x, y: node.y, z: node.z }, { x: look.x, y: look.y, z: look.z }) <
          REAIM_THRESHOLD
        ) {
          cancelFly();
          return; // settled — landed on the node
        }
        const cam = fg.camera().position;
        const pos = flyCameraPosition(
          { x: node.x, y: node.y, z: node.z },
          { x: cam.x, y: cam.y, z: cam.z },
          FLY_DISTANCE
        );
        fg.cameraPosition(
          { x: pos.x, y: pos.y, z: pos.z },
          { x: node.x, y: node.y, z: node.z },
          250
        );
      }, REAIM_EVERY_MS);
      flyRef.current = { id, timer: null, interval };
    },
    [cancelFly]
  );

  /**
   * Begin the jump to `id`: once the node has live coordinates, move the
   * camera FLY_DISTANCE away from it (along the current view direction) in
   * FLY_DURATION_MS, then re-aim while the layout settles. A node that has
   * no coordinates yet (freshly merged, d3 has not ticked it) is retried for
   * up to POS_RETRY_MAX * POS_RETRY_EVERY_MS. A node missing from the view
   * entirely (filtered out) gets no jump — there is nothing to land on.
   */
  const attemptFly = useCallback(
    (id: string, attempt: number) => {
      const fg = fgRef.current;
      if (!fg) return; // engine not mounted yet
      const node = graphDataRef.current.nodes.find((n) => n.id === id);
      if (!node) return; // not in the (filtered) view
      const x = node.x;
      const y = node.y;
      const z = node.z;
      if (
        x === undefined ||
        y === undefined ||
        z === undefined ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
      ) {
        if (attempt < POS_RETRY_MAX) {
          flyRef.current = {
            id,
            timer: window.setTimeout(() => attemptFly(id, attempt + 1), POS_RETRY_EVERY_MS),
            interval: null,
          };
        }
        return;
      }
      const cam = fg.camera().position;
      const pos = flyCameraPosition({ x, y, z }, { x: cam.x, y: cam.y, z: cam.z }, FLY_DISTANCE);
      fg.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x, y, z }, FLY_DURATION_MS);
      startReaim(id);
    },
    [startReaim]
  );

  // Fly-to trigger: the monotonic focus token (card C2). A token change means
  // a new focus request — node clicks, search picks (card E1) and the C3 URL
  // selection restore all land here.
  const lastFocusSeqRef = useRef(-1);
  useEffect(() => {
    if (focusSeq === lastFocusSeqRef.current) return;
    lastFocusSeqRef.current = focusSeq;
    const id = graphStore.focusId;
    if (!id) return;
    cancelFly();
    attemptFly(id, 0);
  }, [focusSeq, cancelFly, attemptFly]);

  // No orphaned timers/intervals after unmount.
  useEffect(() => cancelFly, [cancelFly]);

  // Copy node ID to clipboard when clicked and hand the node to the store
  // (select + focus + expand-on-click, card C2)
  const handleClick = useCallback(
    (node: NodeObject) => {
      if (!node || node.x === undefined || node.y === undefined || node.z === undefined) return;
      navigator.clipboard.writeText((node.id ?? "").toString()).catch(console.error);
      onNodeSelect?.(node);
    },
    [onNodeSelect]
  );

  // Update dimensions when fullscreen or parent dimensions change
  useEffect(() => {
    if (isFullScreen) {
      setGraphWidth(window.innerWidth);
      setGraphHeight(window.innerHeight);
    } else {
      setGraphWidth(width);
      setGraphHeight(height);
    }
  }, [isFullScreen, width, height]);

  // Reset camera to fit all nodes in view
  const handleResetView = useCallback(() => {
    if (!fgRef.current || !graphData?.nodes?.length) return;
    // A manual reset supersedes any in-flight fly-to / re-aim (card E1).
    cancelFly();

    // Calculate bounding box of all nodes to determine camera position
    const nodes = graphData.nodes;
    const minX = Math.min(...nodes.map((node) => node.x ?? 0));
    const maxX = Math.max(...nodes.map((node) => node.x ?? 0));
    const minY = Math.min(...nodes.map((node) => node.y ?? 0));
    const maxY = Math.max(...nodes.map((node) => node.y ?? 0));
    const minZ = Math.min(...nodes.map((node) => node.z ?? 0));
    const maxZ = Math.max(...nodes.map((node) => node.z ?? 0));

    // Calculate the center of the bounding box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;

    // Calculate the size of the bounding box
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;

    // Set distance based on the largest dimension of the bounding box
    const distance = Math.max(sizeX, sizeY, sizeZ) * 1.25;

    // Position camera at calculated distance from center, looking at center
    fgRef.current.cameraPosition(
      { x: centerX, y: centerY, z: centerZ + distance },
      { x: centerX, y: centerY, z: centerZ },
      3000 // duration of the transition (in ms)
    );
  }, [graphData, cancelFly]);

  // ----------------------------------------------------------------- card C3

  const hasNodes = graphData.nodes.length > 0;
  // One-shot: apply the camera captured in the opened URL once the engine
  // has its first data (transitionMs 0 = immediate, no fly animation).
  const restoredCameraRef = useRef(false);
  useEffect(() => {
    if (restoredCameraRef.current || !fgRef.current || !hasNodes) return;
    if (!initialViewState.camera) return;
    restoredCameraRef.current = true;
    const look = initialViewState.look ?? { x: 0, y: 0, z: 0 };
    fgRef.current.cameraPosition(initialViewState.camera, look, 0);
  }, [hasNodes]);

  // Card C3: keep the URL's cam/look keys in step with the live camera
  // (polled; only writes when a rounded value actually changed).
  useEffect(() => {
    if (!hasNodes) return;
    let lastCam = "";
    let lastLook = "";
    const id = window.setInterval(() => {
      const fg = fgRef.current;
      if (!fg) return;
      const pos = fg.camera().position;
      const controls = fg.controls() as unknown as {
        target?: { x: number; y: number; z: number };
      };
      // OrbitControls keeps the true orbit pivot in controls.target; fall
      // back to the engine's derived look-at point when it is absent.
      const look = controls?.target ?? fg.cameraPosition().lookAt;
      const cam = `${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}`;
      const lookAt = `${look.x.toFixed(3)},${look.y.toFixed(3)},${look.z.toFixed(3)}`;
      if (cam !== lastCam || lookAt !== lastLook) {
        lastCam = cam;
        lastLook = lookAt;
        updateSearchKeys({ cam, look: lookAt });
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [hasNodes]);

  // Memoize node 3D objects to avoid recreating geometries and materials on each render
  // Box geometry for nodes without group (default), sphere for grouped nodes
  // Materials are cached by color to prevent memory leaks and improve performance
  const nodeThreeObject = useMemo(() => {
    const boxGeometry = new THREE.BoxGeometry(8, 8, 8);
    const sphereGeometry = new THREE.SphereGeometry(5);

    return (node: NodeObject) => {
      const group = (node as NodeObject<{ group?: string }>).group ?? "";
      const geometry = group === "" ? boxGeometry : sphereGeometry;
      const color = getGroupColor(group);

      // Check cache for existing material of this color
      let material = materialCacheRef.current.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
        materialCacheRef.current.set(color, material);
      }

      return new THREE.Mesh(geometry, material);
    };
  }, []);

  // Node tooltip label with theme-aware text color
  const nodeLabel = useCallback(
    (node: NodeObject) => `<span style="color: ${labelColor}">${node.label || node.id}</span>`,
    [labelColor]
  );

  // Link tooltip label with theme-aware text color
  const linkLabel = useCallback(
    (d: LinkObject) => `<span style="color: ${labelColor}">${d.label}</span>`,
    [labelColor]
  );

  // Stable callbacks for child components to prevent unnecessary re-renders
  const setIsFullScreenCallback = useCallback((val: boolean) => setIsFullScreen(val), []);
  const setSwitchOnCallback = useCallback((val: boolean) => setSwitchOn(val), []);

  return (
    <div
      style={{ width: isFullScreen ? "100vw" : width, height: isFullScreen ? "100vh" : height }}
      className={isFullScreen ? "fixed inset-0 z-[9999]" : "relative"}
    >
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        width={graphWidth}
        height={graphHeight}
        nodeLabel={nodeLabel}
        linkLabel={linkLabel}
        linkDirectionalArrowLength={7}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.3}
        linkOpacity={0.5}
        linkWidth={5}
        backgroundColor={switchOn ? "#ffffff" : "#000000"}
        nodeThreeObject={nodeThreeObject}
        onNodeClick={handleClick}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        enableNodeDrag={true}
        enableNavigationControls={true}
        showNavInfo={false}
      />
      <FullScreenButton isFullScreen={isFullScreen} setIsFullScreen={setIsFullScreenCallback} />
      <ResetViewButton resetView={handleResetView} />
      <ThemeSwitch switchOn={switchOn} setSwitchOn={setSwitchOnCallback} />
      <Legend />
    </div>
  );
};

export default Graph;
