/**
 * Root presets: the Helmholtz Association and its 18 centres (ROR IDs and display names
 * from api.ror.org, favicons as used by the unhide search UI, helmholtz-kg/ui
 * `INSTITUTE_ROR_LOGOS`).
 */
export interface RootPreset {
  iri: string;
  short: string;
  name: string;
  favicon: string;
}

export const HELMHOLTZ: RootPreset = {
  iri: "https://ror.org/0281dp749",
  short: "Helmholtz",
  name: "Helmholtz Association of German Research Centres",
  favicon:
    "https://www.helmholtz.de/_assets/4e25df9997048755bbe02d1d413588ee/Frontend/Build/assets/icons/favicons/icon-192x192.png",
};

/** The 18 Helmholtz centres, sorted by short name. */
export const CENTERS: readonly RootPreset[] = [
  {
    iri: "https://ror.org/032e6b942",
    short: "AWI",
    name: "Alfred-Wegener-Institut Helmholtz-Zentrum für Polar- und Meeresforschung",
    favicon: "https://www.awi.de/_assets/978631966794c5093250775de182779d/Images/AWI/favicon.ico",
  },
  {
    iri: "https://ror.org/02njgxr09",
    short: "CISPA",
    name: "Helmholtz Center for Information Security",
    favicon: "https://cispa.de/dist/images/cispa-logo-on-bright.svg",
  },
  {
    iri: "https://ror.org/01js2sh04",
    short: "DESY",
    name: "Deutsches Elektronen-Synchrotron DESY",
    favicon: "https://www.desy.de/++resource++desy/images/desy_logo_3c_web.svg",
  },
  {
    iri: "https://ror.org/04cdgtt98",
    short: "DKFZ",
    name: "German Cancer Research Center",
    favicon:
      "https://www.dkfz.de/_assets/5bd5aaeffedb0553dcc3d3be99b60d08/Frontend/Images/Favicon/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/04bwf3e34",
    short: "DLR",
    name: "Deutsches Zentrum für Luft- und Raumfahrt e. V. (DLR)",
    favicon: "https://www.dlr.de/icon.svg",
  },
  {
    iri: "https://ror.org/043j0f473",
    short: "DZNE",
    name: "German Center for Neurodegenerative Diseases",
    favicon:
      "https://www.dzne.de/_assets/aa513461c0883a6d6d4fabc5c9a63fe8/AppIcons/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/02nv7yv05",
    short: "FZJ",
    name: "Forschungszentrum Jülich",
    favicon: "https://www.fz-juelich.de/icon.svg",
  },
  {
    iri: "https://ror.org/02h2x0161",
    short: "GEOMAR",
    name: "GEOMAR Helmholtz Centre for Ocean Research Kiel",
    favicon:
      "https://www.geomar.de/typo3conf/ext/geomar_provider/Resources/Public/Graphics/favicon/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/04z8jg394",
    short: "GFZ",
    name: "GFZ Helmholtz Centre for Geosciences",
    favicon: "https://www.gfz.de/_assets/addb558b1d0e21da17cab6423afccec8/Icons/favicon.ico",
  },
  {
    iri: "https://ror.org/02k8cbn47",
    short: "GSI",
    name: "GSI Helmholtz Centre for Heavy Ion Research",
    favicon: "https://www.gsi.de/favicon.ico",
  },
  {
    iri: "https://ror.org/00cfam450",
    short: "Helmholtz Munich",
    name: "Helmholtz Munich",
    favicon:
      "https://www.helmholtz-munich.de/_assets/a92153751098915699a1afa17e77f864/Static/Icons/Favicons/helmholtz-munich/favicon.ico",
  },
  {
    iri: "https://ror.org/03qjp1d79",
    short: "Hereon",
    name: "Helmholtz-Zentrum Hereon",
    favicon: "https://hereon.de/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/02aj13c28",
    short: "HZB",
    name: "Helmholtz-Zentrum Berlin für Materialien und Energie",
    favicon: "https://www.helmholtz-berlin.de/favicon.ico",
  },
  {
    iri: "https://ror.org/01zy2cs03",
    short: "HZDR",
    name: "Helmholtz-Zentrum Dresden-Rossendorf",
    favicon: "https://www.hzdr.de/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/03d0p2685",
    short: "HZI",
    name: "Helmholtz Centre for Infection Research",
    favicon:
      "https://www.helmholtz-hzi.de/_assets/ae8a1fe32f30b295243325c1db1b8058/Icons/Favicons/HZI/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/04t3en479",
    short: "KIT",
    name: "Karlsruhe Institute of Technology",
    favicon: "https://www.kit.edu/img/intern/favicon.ico",
  },
  {
    iri: "https://ror.org/04p5ggc03",
    short: "MDC",
    name: "Max Delbrück Center",
    favicon: "https://www.mdc-berlin.de/sites/default/files/favicons/favicon-16x16.png",
  },
  {
    iri: "https://ror.org/000h6jb29",
    short: "UFZ",
    name: "Helmholtz Centre for Environmental Research",
    favicon: "https://www.ufz.de/static/custom/weblayout/DefaultInternetLayout/img/favicon.ico",
  },
];

/** Dropdown order: the Association first, then the centres. */
export const ROOT_PRESETS: readonly RootPreset[] = [HELMHOLTZ, ...CENTERS];

export const findPreset = (iri: string): RootPreset | undefined =>
  ROOT_PRESETS.find((p) => p.iri === iri);
