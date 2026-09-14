import superjson from "superjson";

import type { TimelineWindowData } from "~/app/timeline/_lib/progressive-timeline";
import type { RouterOutputs } from "~/trpc/react";

type TimelineEntry = RouterOutputs["timeline"]["list"][number];
type TimelineIncomeContribution = RouterOutputs["timeline"]["income"][number];

export type PublicTimelineWindow = TimelineWindowData<
  TimelineEntry,
  TimelineIncomeContribution
>;

export async function fetchTimelineWindow(
  input: { scheduleStartDay: string; index: number },
  options: { request?: typeof fetch; signal?: AbortSignal } = {},
) {
  const search = new URLSearchParams({
    scheduleStartDay: input.scheduleStartDay,
    index: String(input.index),
  });
  const response = await (options.request ?? fetch)(
    `/api/timeline/window?${search}`,
    {
      headers: { accept: "application/json" },
      signal: options.signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Timeline window request failed with status ${response.status}.`,
    );
  }

  return superjson.parse<PublicTimelineWindow>(await response.text());
}
