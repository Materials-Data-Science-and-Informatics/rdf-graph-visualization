import { useMemo, useState } from "react";
import { ExternalLink, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SelectedView } from "./NodeDetails";
import { CopyButton } from "./shared";

const PAGE = 50;

/** Member list of a bundle node: count, shared neighbours, filter, first 50 (or all) rows. */
export default function BundleMembers({
  bundle,
  onMakeRoot,
}: {
  bundle: NonNullable<SelectedView["bundle"]>;
  onMakeRoot: (iri: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const q = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q
        ? bundle.members.filter((m) => `${m.label} ${m.iri}`.toLowerCase().includes(q))
        : bundle.members,
    [bundle.members, q]
  );
  const shown = all ? matches : matches.slice(0, PAGE);
  return (
    <>
      <p className="text-muted-foreground text-sm">
        {bundle.members.length.toLocaleString()} nodes with the same class and the same connections,
        shown as one.
        {bundle.links && <span className="block text-xs">{bundle.links}</span>}
      </p>
      {bundle.members.length > PAGE && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter members"
          aria-label="Filter members"
          className="bg-background w-full rounded-md border px-2 py-1 text-xs"
        />
      )}
      <ul className="divide-y text-xs" aria-label="Bundle members">
        {shown.map((m) => (
          <li key={m.iri} className="flex items-center gap-1 py-1">
            <span
              className="line-clamp-2 min-w-0 flex-1 text-xs break-words"
              title={`${m.label}\n${m.iri}`}
            >
              {m.label}
            </span>
            {/^https?:\/\//i.test(m.iri) && (
              <Button variant="ghost" size="icon" className="size-7" asChild>
                <a
                  href={m.iri}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${m.label}`}
                  title="Open"
                >
                  <ExternalLink />
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Make ${m.label} the starting point`}
              title="Make starting point"
              onClick={() => onMakeRoot(m.iri)}
            >
              <Network />
            </Button>
            <CopyButton text={m.iri} />
          </li>
        ))}
      </ul>
      {matches.length > shown.length && (
        <Button variant="outline" size="sm" onClick={() => setAll(true)}>
          Show all {matches.length.toLocaleString()}
        </Button>
      )}
      {q && matches.length === 0 && <p className="text-muted-foreground text-xs">No match</p>}
    </>
  );
}
