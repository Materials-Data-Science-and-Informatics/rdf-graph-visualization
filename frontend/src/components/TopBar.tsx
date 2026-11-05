import SearchBox, { type GraphControl } from "./SearchBox";
import type { GraphGroupConfig } from "@/lib/api";
import InfoDialog from "./InfoDialog";
import ThemeToggle from "./ThemeToggle";

export default function TopBar({
  groups,
  control,
}: {
  groups: GraphGroupConfig[];
  control: React.RefObject<GraphControl | null>;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <img
        src="/branding/hkg-logo.png"
        alt="Helmholtz Knowledge Graph"
        className="size-7 object-contain dark:brightness-0 dark:invert"
      />
      <h1 className="text-sm font-semibold">HKG Graph Explorer</h1>
      <div className="mx-auto flex w-full max-w-md justify-center" data-slot="search">
        <SearchBox groups={groups} control={control} />
      </div>
      <InfoDialog />
      <ThemeToggle />
    </header>
  );
}
