import {
  TimelineSettingsProvider,
  TimelineSettingsButton,
} from "~/app/timeline/_components/timeline-settings";

import { TimelineSchedule } from "~/app/timeline/_components/timeline-schedule";
import { timelineWindows } from "~/app/timeline/_lib/progressive-timeline";
import { auth } from "~/server/auth";
import {
  getCachedTimelineStories,
  getCachedTimelineWindow,
} from "~/server/api/routers/timeline";

export default async function TimelinePage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const now = new Date();
  const scheduleStartDay = now.toISOString().slice(0, 10);
  const windows = timelineWindows(scheduleStartDay);
  const scheduleEndDay = windows.at(-1)!.throughDay;
  const [initialWindow, stories, session] = await Promise.all([
    getCachedTimelineWindow({ scheduleStartDay, index: 0 }),
    getCachedTimelineStories(),
    auth(),
  ]);
  const initialCalendar = {
    today: scheduleStartDay,
    timeZone: "UTC",
  };
  const authError = Boolean((await searchParams)?.error);
  return (
    <TimelineSettingsProvider authError={authError}>
      <main id="main-content" className="timeline-page">
        <header className="timeline-app-bar">
          <span className="timeline-brand-mark" aria-hidden="true" />
          <div className="timeline-app-title">
            <h1>FGO Chronicle</h1>
            <p>Global schedule planner</p>
          </div>
          <TimelineSettingsButton />
        </header>

        <TimelineSchedule
          stories={stories}
          initialWindow={initialWindow}
          scheduleStartDay={scheduleStartDay}
          scheduleEndDay={scheduleEndDay}
          initialCalendar={initialCalendar}
          user={
            session?.user
              ? {
                  id: session.user.id,
                }
              : null
          }
          authError={authError}
        />
      </main>
    </TimelineSettingsProvider>
  );
}
