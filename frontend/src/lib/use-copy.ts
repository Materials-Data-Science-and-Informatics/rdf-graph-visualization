import { useState } from "react";

/** Copy `text` to the clipboard; `done` is true for 1.5 s after success. `fallback` runs when the clipboard API fails. */
export function useCopy(fallback?: (text: string) => void) {
  const [done, setDone] = useState(false);
  const copy = (text: string) => {
    const ok = () => {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    };
    if (!navigator.clipboard) return fallback?.(text);
    navigator.clipboard
      .writeText(text)
      .then(ok)
      .catch(() => fallback?.(text));
  };
  return { done, copy };
}
