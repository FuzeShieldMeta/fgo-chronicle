import { DEFAULT_VISIBLE_LANES } from "~/app/timeline/_lib/schedule-layout";

export const timelineLayout = {
  dayWidth: 52,
  categoryLabelWidth: 112,
  minimumScheduleCategoryHeight: 144,
  incomeResourceCount: 5,
  incomeResourceIconSize: 24,
  railHorizontalInset: 3,
  railLaneInset: 2,
  maximumInsetLaneCount: 12,
  comfortableLaneCount: DEFAULT_VISIBLE_LANES,
  compactLaneCount: 6,
  minimumEventArtworkRailWidth: 260,
  eventBannerIntrinsicWidth: 456,
  eventBannerIntrinsicHeight: 134,
  eventRailArtworkSizes: "(max-width: 768px) 120px, 160px",
  eventDetailsArtworkSizes: "(max-width: 768px) 100vw, 520px",
  stickyLabelInset: 4,
} as const;

export const timelineSchedule = {
  yearsAhead: 2,
  queryBoundaryPaddingDays: 2,
  detailsStaleTimeMs: 5 * 60 * 1_000,
} as const;
