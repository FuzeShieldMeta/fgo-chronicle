"use client";

import Image from "next/image";
import { useState } from "react";

import { formatScheduleDate } from "~/app/timeline/_lib/schedule-date";
import {
  timelineLayout,
  timelineSchedule,
} from "~/app/timeline/_lib/timeline-layout-config";
import {
  artworkUrlAfterFailure,
  eventArtworkUrl,
} from "~/app/timeline/_lib/timeline-rail-artwork";
import { api, type RouterOutputs } from "~/trpc/react";

type TimelineEntry = RouterOutputs["timeline"]["list"][number];

const statusNames = {
  OFFICIAL: "Official",
  CURATED: "Curated",
  PROJECTED: "Projected",
} as const;

const itemTypeNames = {
  SAINT_QUARTZ: "Saint Quartz",
  SAINT_QUARTZ_FRAGMENT: "Saint Quartz Fragments",
  SUMMON_TICKET: "Summon Tickets",
  CRYSTALLIZED_LORE: "Crystallized Lores",
  HOLY_GRAIL: "Holy Grails",
} as const;

function formatType(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function TimelineDetailsPlaceholder() {
  return (
    <aside
      className="timeline-details timeline-details-empty"
      data-empty="true"
      aria-label="Schedule details"
    >
      <div className="timeline-details-empty-content">
        <span className="timeline-type-label">Schedule details</span>
        <h3>Select a timeline entry</h3>
        <p>
          Select an event, summoning campaign, or income source to inspect its
          dates, source, rewards, and related schedule entries.
        </p>
      </div>
    </aside>
  );
}

export function TimelineEntryDetails({
  entry,
  timeZone,
  onClose,
}: {
  entry: TimelineEntry;
  timeZone: string;
  onClose: () => void;
}) {
  const input =
    entry.kind === "EVENT"
      ? ({ kind: "EVENT", id: entry.id } as const)
      : ({ kind: "BANNER", id: entry.id } as const);
  const details = api.timeline.details.useQuery(input, {
    staleTime: timelineSchedule.detailsStaleTimeMs,
  });
  const [failedArtworkUrl, setFailedArtworkUrl] = useState<string | null>(null);

  const family = details.data?.family;
  const candidateArtworkUrl = family?.artworkReviewedAt
    ? eventArtworkUrl(family)
    : null;
  const reviewedArtworkUrl = artworkUrlAfterFailure(
    candidateArtworkUrl,
    failedArtworkUrl,
  );

  return (
    <aside
      className="timeline-details"
      data-empty="false"
      aria-labelledby="timeline-details-heading"
    >
      <div className="timeline-details-handle" aria-hidden="true" />
      <div className="timeline-details-header">
        <div>
          <span className="timeline-type-label">
            {entry.category === "INCOME_SOURCE"
              ? "Income source"
              : entry.category === "EVENT"
                ? "Event"
                : "Summoning campaign"}
          </span>
          <h3 id="timeline-details-heading">{entry.name}</h3>
        </div>

        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
          aria-label="Close schedule details"
        >
          Close
        </button>
      </div>

      {reviewedArtworkUrl && family ? (
        <figure className="timeline-artwork-card">
          <div className="timeline-artwork">
            <Image
              className="timeline-artwork-image"
              src={reviewedArtworkUrl}
              alt={family.artworkAlt ?? `${family.name} event artwork`}
              fill
              sizes={timelineLayout.eventDetailsArtworkSizes}
              loading="lazy"
              onError={() => setFailedArtworkUrl(reviewedArtworkUrl)}
            />
          </div>
          <figcaption>{family.name}</figcaption>
        </figure>
      ) : null}

      <dl className="timeline-detail-facts">
        <div>
          <dt>Status</dt>
          <dd>
            <span className="timeline-status-chip" data-status={entry.status}>
              {statusNames[entry.status]}
            </span>
          </dd>
        </div>
        <div>
          <dt>Starts</dt>
          <dd>
            {formatScheduleDate(
              entry.startsAt,
              entry.startsAtPrecision,
              timeZone,
            )}
          </dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>
            {formatScheduleDate(entry.endsAt, entry.endsAtPrecision, timeZone)}
          </dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>{entry.sourceRegion}</dd>
        </div>
      </dl>

      {details.isLoading ? (
        <p className="timeline-details-message" role="status">
          Loading details…
        </p>
      ) : null}

      {details.isError ? (
        <div className="timeline-details-message" role="alert">
          <p>The details could not load.</p>
          <button type="button" onClick={() => details.refetch()}>
            Try again
          </button>
        </div>
      ) : null}

      {details.data?.kind === "BANNER" ? (
        <section className="timeline-detail-section">
          <h4>Featured Servants</h4>
          {details.data.featured.length > 0 ? (
            <ul>
              {details.data.featured.map(({ servant, soloRateUp }) => (
                <li key={servant.id}>
                  <span>{servant.name}</span>
                  <small>
                    {servant.className}
                    {soloRateUp ? " · Solo rate-up" : " · Shared rate-up"}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No featured Servant data is available.</p>
          )}
        </section>
      ) : null}

      {details.data?.kind === "EVENT" ? (
        <section className="timeline-detail-section">
          <h4>Rewards</h4>
          {details.data.rewardSources.length > 0 ? (
            <ul>
              {details.data.rewardSources.map((source) => (
                <li key={source.id}>
                  <span>{source.name}</span>
                  <small>{formatType(source.type)}</small>
                  {source.rewards.length > 0 ? (
                    <ul className="timeline-reward-list">
                      {source.rewards.map((reward) => (
                        <li key={reward.id}>
                          {reward.amount.toString()}{" "}
                          {itemTypeNames[reward.itemType]}
                          {reward.reviewedAt ? "" : " · Unreviewed"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>Reward data is not available for this event.</p>
          )}
        </section>
      ) : null}

      {details.data && details.data.relatedEntries.length > 0 ? (
        <section className="timeline-detail-section">
          <h4>Related schedule</h4>
          <ul>
            {details.data.relatedEntries.map((related) => (
              <li key={related.key}>
                <span>{related.name}</span>
                <small>
                  {formatScheduleDate(
                    related.startsAt,
                    related.startsAtPrecision,
                    timeZone,
                  )}{" "}
                  · {formatType(related.category)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {details.data?.sourceUrl ? (
        <a
          className="timeline-source-link"
          href={details.data.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          View source
        </a>
      ) : null}
    </aside>
  );
}
