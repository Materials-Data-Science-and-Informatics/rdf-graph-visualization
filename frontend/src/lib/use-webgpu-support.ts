import { useEffect, useState } from "react";
import { detectWebGpu } from "@/engine/webgpu";

/** The dimension to render: null while WebGPU support is still being checked. */
export function effectiveDim(
  requested: 2 | 3,
  webgpu: boolean | null,
  engineFailed: boolean
): 2 | 3 | null {
  if (requested === 2 || engineFailed || webgpu === false) return 2;
  return webgpu === null ? null : 3;
}

/** WebGPU availability (null until checked) plus a flag the 3D engine sets when it fails to start. */
export function useWebGpuSupport(requested: 2 | 3) {
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [engineFailed, setEngineFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void detectWebGpu().then((ok) => live && setWebgpu(ok));
    return () => {
      live = false;
    };
  }, []);
  const unavailable = webgpu === false || engineFailed;
  const shownDim = effectiveDim(requested, webgpu, engineFailed);
  return { shownDim, unavailable, setEngineFailed };
}
