import InfoDialog from "./InfoDialog";
import ThemeToggle from "./ThemeToggle";
import { version } from "../../package.json";

export default function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <img src="/favicon.ico" alt="" className="size-6" />
      <h1 className="text-sm font-semibold">HKG Graph Explorer</h1>
      <div className="mx-auto flex w-full max-w-md justify-center" data-slot="search">
        <span className="text-muted-foreground text-xs">Search (coming soon)</span>
      </div>
      <span className="text-muted-foreground hidden text-xs sm:inline">v{version}</span>
      <InfoDialog />
      <ThemeToggle />
    </header>
  );
}
