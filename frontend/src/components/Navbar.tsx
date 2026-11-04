import { ExternalLink } from "lucide-react";

interface NavbarProps {
  onInfoClick: () => void;
  onConfigClick: () => void;
}

const navLinkClasses =
  "inline-flex items-center rounded-[6px] border border-white px-3 py-1 font-bold text-white " +
  "text-base md:text-xl";

const Navbar = ({ onInfoClick, onConfigClick }: NavbarProps) => {
  return (
    <header className="mb-4 bg-[#3eb8fc] px-4 py-3 md:px-8">
      <div className="flex flex-col items-start justify-between gap-4 lg:flex-row lg:items-center">
        <img
          src="https://github.com/Materials-Data-Science-and-Informatics/Logos/blob/main/HelmholtzKG/Logo_HelmholtzKG_notext_brightback.png?raw=true"
          alt="Logo"
          className="h-12 cursor-pointer"
          onClick={() => window.location.reload()}
        />
        <h1 className="text-lg font-bold text-white/90 md:text-xl">RDF Graph Visualization</h1>
        <nav className="flex w-full flex-col gap-4 items-stretch sm:flex-row sm:items-center lg:w-auto">
          <a
            href="#info"
            className={navLinkClasses}
            onClick={(e) => {
              e.preventDefault();
              onInfoClick();
            }}
          >
            Info
          </a>
          <a
            href="#config"
            className={navLinkClasses}
            onClick={(e) => {
              e.preventDefault();
              onConfigClick();
            }}
          >
            Config
          </a>
          <a
            href="https://www.helmholtz.de/en/"
            target="_blank"
            rel="noreferrer"
            className={navLinkClasses}
          >
            HMC <ExternalLink aria-hidden className="ml-0.5" />
          </a>
        </nav>
      </div>
    </header>
  );
};

export default Navbar;
