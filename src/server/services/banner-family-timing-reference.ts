import { createHash } from "node:crypto";
import {
  jpBannerLaunchHour,
  projectJpBannerBoundary,
} from "./jp-banner-projection";

type SourceEvent = {
  id: string;
  familyId: string | null;
  sourceKey: string;
  type: string;
  sourceRegion: string;
  sourceUrl: string | null;
  sourceStartsAt: Date | null;
  sourceStartsAtPrecision: string | null;
};

/** Source identity excludes mutable Global dates and unrelated export changes. */
export function bannerAnchorSourceFactsHash(event: SourceEvent) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        eventId: event.id,
        familyId: event.familyId,
        sourceKey: event.sourceKey,
        type: event.type,
        sourceRegion: event.sourceRegion,
        sourceUrl: event.sourceUrl,
        sourceStartsAt: event.sourceStartsAt?.toISOString() ?? null,
        sourceStartsAtPrecision: event.sourceStartsAtPrecision,
      }),
    )
    .digest("hex");
}

/** Reproject the original JP window, then shift from the accepted event start. */
export function bannerWindowFromEventStart(
  window: { sourceStartsAt: Date; sourceEndsAt: Date | null },
  anchor: { jpResetDay: Date; naResetDay: Date; referenceStartsAt: Date },
  sourceAnchorStartsAt: Date,
  effectiveStartsAt: Date,
) {
  const clocks = [
    window.sourceStartsAt,
    anchor.jpResetDay,
    anchor.naResetDay,
    anchor.referenceStartsAt,
    sourceAnchorStartsAt,
    effectiveStartsAt,
    ...(window.sourceEndsAt ? [window.sourceEndsAt] : []),
  ];
  if (
    clocks.some((value) => !Number.isFinite(value.getTime())) ||
    (window.sourceEndsAt && window.sourceEndsAt <= window.sourceStartsAt)
  )
    return null;
  const jpDay = anchor.jpResetDay.toISOString().slice(0, 10);
  const naDay = anchor.naResetDay.toISOString().slice(0, 10);
  const launchHour = jpBannerLaunchHour(sourceAnchorStartsAt.toISOString());
  const start = projectJpBannerBoundary(
    window.sourceStartsAt.toISOString(),
    jpDay,
    naDay,
    "START",
    launchHour,
  );
  const end = window.sourceEndsAt
    ? projectJpBannerBoundary(
        window.sourceEndsAt.toISOString(),
        jpDay,
        naDay,
        "END",
        launchHour,
      )
    : null;
  if (
    start.issues.length ||
    !start.projectedAt ||
    end?.issues.length ||
    (end && !end.projectedAt)
  )
    return null;
  const delta =
    effectiveStartsAt.getTime() - anchor.referenceStartsAt.getTime();
  const startsAt = new Date(Date.parse(start.projectedAt) + delta);
  const endsAt = end?.projectedAt
    ? new Date(Date.parse(end.projectedAt) + delta)
    : null;
  if (
    !Number.isFinite(startsAt.getTime()) ||
    (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt < startsAt))
  )
    return null;
  return { startsAt, endsAt };
}
