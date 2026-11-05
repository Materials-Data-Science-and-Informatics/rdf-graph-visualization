import { LINKS } from "@/lib/links";
import { version } from "../../package.json";

const A = ({ href, children }: { href: string; children: string }) => (
  <a
    href={href}
    {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    className="hover:text-foreground underline-offset-2 hover:underline"
  >
    {children}
  </a>
);

const Dot = () => <span aria-hidden>&middot;</span>;

export default function Footer() {
  const row = "flex flex-wrap items-center justify-center gap-x-2";
  return (
    <footer className="text-muted-foreground grid shrink-0 gap-y-0.5 border-t px-3 py-1 text-xs md:min-h-7 md:grid-cols-[1fr_auto_1fr] md:items-center md:gap-x-4 md:py-0">
      <p className={`${row} md:justify-start`}>
        <a href={LINKS.hmc} target="_blank" rel="noopener noreferrer" className="shrink-0">
          {/* white logo: darkened in the light theme */}
          <img
            src="/branding/hmc-logo.png"
            alt="Helmholtz Metadata Collaboration"
            className="h-3.5 w-auto invert dark:invert-0"
          />
        </a>
        <Dot />
        <A href={LINKS.search}>Helmholtz Knowledge Graph</A>
      </p>
      <p className={row}>
        <span>HKG Graph Explorer</span>
        <Dot />
        <span>Version {version}</span>
        <Dot />
        <span>{`© ${new Date().getFullYear()} Helmholtz Metadata Collaboration`}</span>
      </p>
      <nav aria-label="Legal" className={`${row} md:justify-end`}>
        <A href={LINKS.privacy}>Privacy protection</A>
        <Dot />
        <A href={LINKS.legal}>Legal information</A>
        <Dot />
        <A href={LINKS.accessibility}>Accessibility</A>
        <Dot />
        <A href={LINKS.contact}>Contact</A>
      </nav>
    </footer>
  );
}
