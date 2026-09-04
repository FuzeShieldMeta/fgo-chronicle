import { TimelineSchedule } from "~/app/timeline/_components/timeline-schedule";
import { timelineSchedule } from "~/app/timeline/_lib/timeline-layout-config";
import { api } from "~/trpc/server";

function paddedTwoYearWindow(now: Date) {
  const from = new Date(now);
  from.setUTCDate(
    from.getUTCDate() - timelineSchedule.queryBoundaryPaddingDays,
  );
  from.setUTCHours(0, 0, 0, 0);

  const to = new Date(from);
  to.setUTCFullYear(to.getUTCFullYear() + timelineSchedule.yearsAhead);
  to.setUTCDate(
    to.getUTCDate() + timelineSchedule.queryBoundaryPaddingDays * 2,
  );
  to.setUTCHours(23, 59, 59, 999);

  return { from, to };
}

export default async function TimelinePage() {
  const now = new Date();
  const entries = await api.timeline.list(paddedTwoYearWindow(now));
  const initialCalendar = {
    today: now.toISOString().slice(0, 10),
    timeZone: "UTC",
  };

  return (
    <main id="main-content" className="timeline-page">
      <header className="timeline-app-bar">
        <span className="timeline-brand-mark" aria-hidden="true" />
        <div className="timeline-app-title">
          <h1>FGO Chronicle</h1>
          <p>Global schedule planner</p>
        </div>

        <p className="timeline-intro">
          Events, summoning campaigns, and dated rewards for the next two years.
        </p>
      </header>

      <TimelineSchedule entries={entries} initialCalendar={initialCalendar} />
    </main>
  );
}
