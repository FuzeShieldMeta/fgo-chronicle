import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist } from "next/font/google";

import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  applicationName: "FGO Chronicle",
  title: "FGO Chronicle",
  description: "Plan around the Fate/Grand Order Global schedule.",
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
    <html lang="en" className={`${geist.variable}`}>
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
