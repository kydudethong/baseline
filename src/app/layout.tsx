import type { Metadata, Viewport } from "next";
import "./globals.css";
import { noteRequest } from "@/lib/analysis/idle-sleep";

// Google Fonts are loaded via a runtime <link>, not next/font/google: that
// API fetches fonts from Google's CDN at *build* time, which fails in
// network-restricted build environments (CI runners without egress,
// offline dev). A <link> tag fetches in the browser instead, at render
// time, so it doesn't have that dependency.

export const metadata: Metadata = {
  title: "Baseline — AI pickleball match analysis",
  description:
    "Upload your pickleball game footage and get player tracking, court positioning, and AI coaching insights.",
  // Installed on a phone this is the status-bar treatment; see manifest.ts for
  // why installing is worth caring about.
  appleWebApp: { capable: true, title: "Baseline", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#16A34A",
  // The whole product is used one-handed at the side of a court, and a pinch
  // zoom on the setup canvas is a real gesture people need -- so this sets a
  // sensible initial scale WITHOUT locking zoom out, which would also lock
  // out anyone who needs to make the text bigger.
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // Every page render is a sign somebody is here, which keeps the idle
  // watchdog from stopping the machine underneath them.
  //
  // Known gap, and a deliberate one: this does NOT see API-only traffic, so a
  // dashboard left open polling for a finished run does not count as activity.
  // That case is already covered from the other side -- a run in flight blocks
  // sleep on its own -- and the failure mode for the rest is a cold start on
  // the next click, not lost work. Adding request tracking to every route to
  // close it would be a lot of surface area for that.
  noteRequest();
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- this rule targets pages/_document.js; the App Router root layout is the documented place for a site-wide font <link>. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
