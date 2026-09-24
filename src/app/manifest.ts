import type { MetadataRoute } from "next";

/**
 * The web app manifest, so this installs on a phone.
 *
 * WHY IT IS WORTH THE TWENTY LINES. The whole loop happens on a phone: film
 * the game on it, upload from it, read the coaching on it at the side of the
 * court. A browser tab that has to be found again through a search bar loses
 * to an icon on a home screen, and the icon is the cheapest retention there
 * is. Installed, it also opens without the address bar, which is the
 * difference between "a website I used once" and "the app I use after games".
 *
 * Next generates the link tag from this file; nothing has to be added to the
 * layout.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Baseline — pickleball coaching from your own games",
    short_name: "Baseline",
    description:
      "Film a game, tag yourself, and get a coaching read with the footage behind every point.",
    start_url: "/dashboard",
    display: "standalone",
    orientation: "portrait",
    background_color: "#EDF1F7",
    theme_color: "#16A34A",
    // BOTH FROM public/, because src/app/icon.png is served at a hashed route
    // that this file cannot name. A manifest pointing at a 404 installs an
    // icon-less app, which looks broken on a home screen.
    // GENERATED WITH A MARGIN AND A BACKGROUND rather than pointing at the
    // logo file. Android crops an installed icon to whatever shape the
    // launcher uses, so a transparent 494x420 mark comes out as a fragment of
    // itself; these are square, padded into the safe zone, and opaque.
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
