/** Root entity of the initial view; override at build time with VITE_ROOT_IRI. */
export const DEFAULT_ROOT_IRI: string =
  (import.meta.env.VITE_ROOT_IRI as string | undefined) || "https://ror.org/0281dp749";
