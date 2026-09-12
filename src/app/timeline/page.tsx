import { TimelineSchedule } from "~/app/timeline/_components/timeline-schedule";
import { timelineSchedule } from "~/app/timeline/_lib/timeline-layout-config";
import { auth } from "~/server/auth";
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

export default async function TimelinePage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const now = new Date();
  const range = paddedTwoYearWindow(now);
  const [entries, incomeContributions, stories, session] = await Promise.all([
    api.timeline.list(range),
    api.timeline.income(range),
    api.timeline.stories(),
    auth(),
  ]);
  const initialCalendar = {
    today: now.toISOString().slice(0, 10),
    timeZone: "UTC",
  };
  const authError = Boolean((await searchParams)?.error);

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

      <TimelineSchedule
        stories={stories}
        entries={entries}
        incomeContributions={incomeContributions}
        initialCalendar={initialCalendar}
        user={
          session?.user
            ? {
                id: session.user.id,
                name: session.user.name ?? null,
                email: session.user.email ?? null,
              }
            : null
        }
        authError={authError}
      />
    </main>
  );
}
