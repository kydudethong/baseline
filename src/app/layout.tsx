import type { Metadata } from "next";
import "./globals.css";

// Deliberately not using next/font/google here: it fetches fonts from
// Google's CDN at build time, which fails in network-restricted build
// environments (CI runners without egress, offline dev). The system font
// stack in globals.css looks native on every platform without the
// dependency.

export const metadata: Metadata = {
  title: "Baseline — AI pickleball match analysis",
  description:
    "Upload your pickleball game footage and get player tracking, court positioning, and AI coaching insights.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
