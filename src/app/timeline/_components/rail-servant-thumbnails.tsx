"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  fitServantThumbnails,
  sortFeaturedServants,
  type FeaturedServant,
} from "~/shared/featured-servants";
import { timelineLayout } from "../_lib/timeline-layout-config";
import { ServantThumbnail } from "./servant-thumbnail";

// One passive scroll listener per viewport, rather than one per campaign.
const viewportMeasurements = new WeakMap<
  HTMLElement,
  {
    callbacks: Map<Element, () => void>;
    visible: Set<Element>;
    observer: IntersectionObserver;
    resizeObserver: ResizeObserver;
    listener: () => void;
    frame: number | null;
  }
>();

function subscribeViewport(
  viewport: HTMLElement,
  rail: Element,
  measure: () => void,
) {
  let entry = viewportMeasurements.get(viewport);
  if (!entry) {
    const callbacks = new Map<Element, () => void>();
    const visible = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const change of entries) {
          if (change.isIntersecting) {
            visible.add(change.target);
            callbacks.get(change.target)?.();
          } else visible.delete(change.target);
        }
      },
      { root: viewport },
    );
    const record = {
      callbacks,
      visible,
      observer,
      resizeObserver: new ResizeObserver(() => record.listener()),
      frame: null as number | null,
      listener: () => {
        if (record.frame !== null) return;
        record.frame = requestAnimationFrame(() => {
          record.frame = null;
          for (const element of visible) callbacks.get(element)?.();
        });
      },
    };
    entry = record;
    viewportMeasurements.set(viewport, entry);
    viewport.addEventListener("scroll", entry.listener, { passive: true });
    entry.resizeObserver.observe(viewport);
  }
  const subscribed = entry;
  subscribed.callbacks.set(rail, measure);
  subscribed.observer.observe(rail);
  return () => {
    subscribed.callbacks.delete(rail);
    subscribed.visible.delete(rail);
    subscribed.observer.unobserve(rail);
    if (!subscribed.callbacks.size) {
      viewport.removeEventListener("scroll", subscribed.listener);
      if (subscribed.frame !== null) cancelAnimationFrame(subscribed.frame);
      subscribed.observer.disconnect();
      subscribed.resizeObserver.disconnect();
      viewportMeasurements.delete(viewport);
    }
  };
}

export function RailServantThumbnails({
  servants,
  trackRef,
  titleRef,
}: {
  servants: readonly FeaturedServant[];
  trackRef: RefObject<HTMLSpanElement | null>;
  titleRef: RefObject<HTMLSpanElement | null>;
}) {
  const sorted = useMemo(() => sortFeaturedServants(servants), [servants]);
  const [space, setSpace] = useState<{
    count: number;
    mountedCount: number;
    size: number;
  }>({
    count: 0,
    mountedCount: 0,
    size: timelineLayout.servantThumbnailSize,
  });
  // The track is an ancestor owned by Rail: its ref attaches after child
  // layout effects. Start observation after the full commit instead.
  useEffect(() => {
    const track = trackRef.current;
    const title = titleRef.current;
    const viewport = track?.closest<HTMLElement>(".timeline-scroll");
    if (!track || !title || !viewport) return;
    const rail = track.closest(".timeline-rail") ?? track;
    const measure = () => {
      // Avoid measuring content in offscreen rails.
      const viewportBounds = viewport.getBoundingClientRect();
      const railBounds = rail.getBoundingClientRect();
      if (
        railBounds.right <= viewportBounds.left ||
        railBounds.left >= viewportBounds.right
      )
        return;
      const size =
        Math.floor(track.clientHeight) -
        timelineLayout.servantThumbnailVerticalPadding * 2;
      const bounds = track.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      const freeWidth =
        Math.min(bounds.right, viewportBounds.right) -
        Math.max(bounds.left, viewportBounds.left, titleBounds.left) -
        titleBounds.width -
        timelineLayout.servantThumbnailLabelPadding;
      const count =
        size < timelineLayout.servantThumbnailMinimumSize
          ? 0
          : fitServantThumbnails({
              count: sorted.length,
              freeWidth,
              size,
              gap: timelineLayout.servantThumbnailGap,
              overflowWidth: timelineLayout.servantThumbnailOverflowWidth,
            });
      setSpace((previous) => {
        const fittedSize = count > 0 ? size : previous.size;
        return previous.count === count && previous.size === fittedSize
          ? previous
          : {
              count,
              size: fittedSize,
              mountedCount: Math.max(previous.mountedCount, count),
            };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    observer.observe(title);
    const unsubscribe = subscribeViewport(viewport, rail, measure);
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [sorted.length, trackRef, titleRef]);
  if (!space.mountedCount) return null;
  return (
    <span
      className="timeline-rail-servants"
      hidden={space.count === 0}
      aria-hidden="true"
      style={{ gap: timelineLayout.servantThumbnailGap }}
    >
      {sorted.slice(0, space.mountedCount).map((servant, index) => (
        <span
          key={servant.id}
          hidden={index >= space.count}
          className="timeline-rail-servant-slot"
        >
          <ServantThumbnail url={servant.thumbnailUrl} size={space.size} />
        </span>
      ))}
      {sorted.length > space.count ? (
        <span
          className="timeline-rail-servants-more"
          style={{ minWidth: timelineLayout.servantThumbnailOverflowWidth }}
        >
          +{sorted.length - space.count}
        </span>
      ) : null}
    </span>
  );
}
