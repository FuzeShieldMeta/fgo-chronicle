import superjson from "superjson";

import {
  getCachedTimelineWindow,
  parseTimelineWindowInput,
} from "~/server/api/routers/timeline";

const successCacheControl =
  "public, s-maxage=3600, stale-while-revalidate=86400";
const failureCacheControl = "private, no-store";

type TimelineWindowGetter = typeof getCachedTimelineWindow;

function failure(status: number, message: string) {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": failureCacheControl } },
  );
}

export async function handleTimelineWindowRequest(
  request: Request,
  dependencies: { getWindow?: TimelineWindowGetter } = {},
) {
  const url = new URL(request.url);
  const scheduleStartDay = url.searchParams.get("scheduleStartDay");
  const indexValue = url.searchParams.get("index");

  if (
    scheduleStartDay === null ||
    indexValue === null ||
    !/^\d+$/.test(indexValue)
  ) {
    return failure(400, "The timeline window request is invalid.");
  }

  const parsed = parseTimelineWindowInput({
    scheduleStartDay,
    index: Number(indexValue),
  });
  if (!parsed.success) {
    return failure(400, "The timeline window request is invalid.");
  }

  try {
    const window = await (dependencies.getWindow ?? getCachedTimelineWindow)(
      parsed.data,
    );
    return new Response(superjson.stringify(window), {
      status: 200,
      headers: {
        "cache-control": successCacheControl,
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("Timeline window request failed.", error);
    return failure(500, "The timeline window could not load.");
  }
}
