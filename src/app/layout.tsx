import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";

import { siteUrl } from "~/app/_lib/site";
import { appearanceBootstrap } from "~/app/_lib/appearance";
import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  applicationName: "FGO Chronicle",
  metadataBase: siteUrl,
  title: {
    default: "FGO Global Schedule and Saint Quartz Planner | FGO Chronicle",
    template: "%s | FGO Chronicle",
  },
  description:
    "View upcoming Fate/Grand Order Global events and banners. Estimate Saint Quartz income and plan summons over the next two years.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "FGO Chronicle",
    title: "FGO Chronicle | Global schedule and Saint Quartz planner",
    description:
      "View upcoming FGO Global events and banners, estimate your income, and plan summons.",
  },
  twitter: {
    card: "summary_large_image",
    title: "FGO Chronicle | Global schedule and Saint Quartz planner",
    description:
      "View upcoming FGO Global events and banners, estimate your income, and plan summons.",
  },
  icons: {
    icon: [
      {
        url: "/chronicle-mark.svg",
        type: "image/svg+xml",
        sizes: "any",
      },
    ],
    shortcut: "/chronicle-mark.svg",
  },
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootstrap }} />
      </head>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
        <Analytics />
      </body>
    </html>
  );
}
