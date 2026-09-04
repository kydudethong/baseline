import type { Metadata } from "next";
import "./globals.css";

// Google Fonts are loaded via a runtime <link>, not next/font/google: that
// API fetches fonts from Google's CDN at *build* time, which fails in
// network-restricted build environments (CI runners without egress,
// offline dev). A <link> tag fetches in the browser instead, at render
// time, so it doesn't have that dependency.

export const metadata: Metadata = {
  title: "Baseline — AI pickleball match analysis",
  description:
    "Upload your pickleball game footage and get player tracking, court positioning, and AI coaching insights.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- this rule targets pages/_document.js; the App Router root layout is the documented place for a site-wide font <link>. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
