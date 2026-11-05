import { X } from "lucide-react";
import { useState } from "react";
import { WEBGPU_NOTICE } from "@/engine/webgpu";

/** Dismissible note shown when 3D is unavailable and the 2D view is displayed instead. */
export default function WebGpuNotice({ show }: { show: boolean }) {
  const [open, setOpen] = useState(true);
  if (!show || !open) return null;
  return (
    <div
      role="status"
      className="bg-background/90 text-muted-foreground absolute bottom-3 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-2 text-xs shadow"
    >
      <span>{WEBGPU_NOTICE}. Showing the 2D view.</span>
      <button type="button" aria-label="Dismiss" onClick={() => setOpen(false)}>
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
