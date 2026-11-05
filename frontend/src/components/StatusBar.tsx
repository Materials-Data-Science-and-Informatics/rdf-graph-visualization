export default function StatusBar({ text }: { text?: string }) {
  return (
    <div className="bg-background/70 text-muted-foreground pointer-events-none absolute inset-x-0 bottom-0 px-3 py-1 text-xs backdrop-blur">
      {text ?? "Ready"}
    </div>
  );
}
