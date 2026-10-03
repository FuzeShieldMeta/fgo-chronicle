import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How the forecast works",
  description:
    "How FGO Chronicle projects the Fate/Grand Order Global schedule, records rewards, and calculates personal resource forecasts.",
  alternates: {
    canonical: "/methodology",
  },
  openGraph: {
    url: "/methodology",
    title: "How the forecast works",
    description:
      "How FGO Chronicle projects the Global schedule and calculates resource forecasts.",
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
        <p className="content-lead">
          FGO Chronicle uses Japanese release dates to estimate the next two
          years of the Global schedule. Dates and rewards may change before
          Global release.
        </p>

        <section>
          <h2>Schedule dates</h2>
          <p>
            Projected dates are two calendar years after the Japanese release.
            The calculation accounts for leap years. Dates that a source has
            already projected for Global do not receive another two-year shift.
          </p>
          <p>
            The timeline labels confirmed Global dates and Japanese projections
            separately. Global can change campaign dates, names, and order.
          </p>
        </section>

        <section>
          <h2>Rewards and resource income</h2>
          <p>
            The forecast includes Saint Quartz, fragments, Summon Tickets, Holy
            Grails, and Crystallised Lores from the available event and mission
            data. Some rewards may be missing or still need review.
          </p>
          <p>
            Your story progress and reward choices determine which rewards count
            towards your balance. Open a reward in the timeline to check its
            source and inclusion settings.
          </p>
        </section>

        <section>
          <h2>Personal forecasts</h2>
          <p>
            Enter your current balances and login progress, then add summon
            plans on the dates you intend to spend. The forecast adds income and
            deducts spending in date order. Automatic fragment conversion, when
            selected, exchanges seven fragments for one Saint Quartz.
          </p>
          <p>
            Your planner saves in this browser. Clearing site data can remove
            it. Optional Google sign-in saves a copy to your account and syncs
            changes across browsers and devices.
          </p>
        </section>

        <section>
          <h2>Data sources</h2>
          <ul className="content-source-list">
            <li>
              <a href="https://atlasacademy.io/" rel="noreferrer">
                Atlas Academy
              </a>{" "}
              provides game data for events, quests, missions, and Servants.
            </li>
            <li>
              <a
                href="https://fategrandorder.fandom.com/wiki/Fate/Grand_Order_Wikia"
                rel="noreferrer"
              >
                Fate/Grand Order Wiki
              </a>{" "}
              provides campaign details and rewards missing from the game data.
            </li>
          </ul>
          <p>
            Events and rewards link to their sources where available. An
            automated daily check updates the schedule. Imported rewards that
            still need review carry an Unreviewed label.
          </p>
        </section>

        <aside className="content-note">
          FGO Chronicle is an unofficial fan project. It is not affiliated with
          TYPE-MOON, Aniplex, Lasengle, or the source sites listed above.
        </aside>
      </article>
    </main>
  );
}
