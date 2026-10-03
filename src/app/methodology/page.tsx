import type { Metadata } from "next";
import Link from "next/link";
import { MethodologyContent } from "./_components/methodology-content";

export const metadata: Metadata = {
  title: "How the forecast works",
  description:
    "Where FGO Chronicle gets its dates and rewards, and how it calculates your resource balance.",
  alternates: {
    canonical: "/methodology",
  },
  openGraph: {
    url: "/methodology",
    title: "How the forecast works",
    description:
      "Where the schedule dates and rewards come from, and how your balance is calculated.",
  },
};

export default function MethodologyPage() {
  return (
    <main className="content-page">
      <header className="content-app-bar">
        <Link
          className="content-brand"
          href="/"
          aria-label="FGO Chronicle home"
        >
          <span className="timeline-brand-mark" aria-hidden="true" />
          <span>FGO Chronicle</span>
        </Link>
        <Link className="content-back-link" href="/">
          Open planner
        </Link>
      </header>

      <article className="content-main">
        <h1>How the forecast works</h1>
        <MethodologyContent />
      </article>
    </main>
  );
}
