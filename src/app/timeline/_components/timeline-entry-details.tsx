"use client";
import { useStoryCatalogue } from "./story-catalogue-provider";

import Image from "next/image";
import { FeaturedServantList } from "./featured-servant-list";
import { TimelinePanelHeader } from "./timeline-panel-header";
import { EventRewardSummary } from "./event-reward-summary";
import { englishRewardLabel } from "~/app/timeline/_lib/reward-labels";
import { useState } from "react";

import { PlayerForecastPanel } from "~/app/timeline/_components/player-forecast-panel";
import {
  incomeResourceLabels,
  type IncomeLedgerCell,
} from "~/app/timeline/_lib/income-ledger";
import {
  resolveRewardInclusion,
  type RewardPreferences,
} from "~/app/timeline/_lib/reward-preferences";
import type { PlayerForecastProfile } from "~/app/timeline/_lib/player-forecast";
import {
  formatCalendarDay,
  formatScheduleDate,
} from "~/app/timeline/_lib/schedule-date";
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

function formatType(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function TimelineDetailsPlaceholder({
  profile,
  today,
  onSaveProfile,
  onOpenProfile,
}: {
  profile: PlayerForecastProfile | null;
  today: string;
  onSaveProfile: (profile: PlayerForecastProfile) => void;
  onOpenProfile: () => void;
}) {
  return (
    <aside
      className="timeline-details timeline-details-empty"
      data-empty="true"
      aria-label="Schedule details"
    >
      <div className="timeline-details-empty-content">
        <span className="timeline-type-label">Schedule details</span>
        <h2>Select a timeline entry</h2>
        <p>
          Select an event, summoning campaign, or dated resource change to see
          its source and details.
        </p>
        {profile ? (
          <PlayerForecastPanel
            profile={profile}
            today={today}
            onSave={onSaveProfile}
          />
        ) : (
          <section className="timeline-default-assumption">
            <h3>Enter your balances</h3>
            <p>
              Add your current Quartz, fragments, tickets, and login count to
              calculate your resource forecast.
            </p>
            <button
              type="button"
              className="timeline-tonal-button"
              onClick={onOpenProfile}
            >
              Enter balances
            </button>
          </section>
        )}
      </div>
    </aside>
  );
}

export function TimelineProfileDetails({
  profile,
  today,
  onSaveProfile,
  onClose,
}: {
  profile: PlayerForecastProfile | null;
  today: string;
  onSaveProfile: (profile: PlayerForecastProfile) => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="timeline-details"
      data-empty="false"
      aria-labelledby="timeline-profile-heading"
    >
      <div className="timeline-details-handle" aria-hidden="true" />
      <TimelinePanelHeader
        title="Starting balances"
        headingId="timeline-profile-heading"
        eyebrow="Player forecast"
        onClose={onClose}
        closeLabel="Close starting balances"
      />
      <PlayerForecastPanel
        profile={profile}
        today={today}
        onSave={onSaveProfile}
      />
    </aside>
  );
}

function signedAmount(value: number) {
  if (value > 0) return `+${value.toLocaleString("en")}`;
  if (value < 0) return `−${Math.abs(value).toLocaleString("en")}`;
  return "0";
}

function RewardInclusionControls({
  rewardId,
  label,
  override,
  onSetRewardInclusion,
}: {
  rewardId: string;
  label: string;
  override: boolean | undefined;
  onSetRewardInclusion: (rewardId: string, included: boolean | null) => void;
}) {
  return (
    <div
      className="timeline-reward-decision-actions"
      role="group"
      aria-label={`Choose whether to include ${label}`}
    >
      {([true, false, null] as const).map((choice) => (
        <button
          key={String(choice)}
          type="button"
          data-selected={(override ?? null) === choice ? "true" : undefined}
          aria-pressed={(override ?? null) === choice}
          onClick={() => onSetRewardInclusion(rewardId, choice)}
        >
          {choice === null ? "Use automatic" : choice ? "Include" : "Exclude"}
        </button>
      ))}
    </div>
  );
}

export function TimelineIncomeDetails({
  cell,
  profile,
  rewardPreferences,
  onSetRewardInclusion,
  onOpenProfile,
  onClose,
}: {
  cell: IncomeLedgerCell;
  rewardPreferences: RewardPreferences;
  profile: PlayerForecastProfile | null;
  onSetRewardInclusion: (rewardId: string, included: boolean | null) => void;
  onOpenProfile: () => void;
  onClose: () => void;
}) {
  const excludedCount = cell.contributions.filter(
    (reward) => !reward.included && reward.inclusionResolved,
  ).length;
  const pendingCount = cell.contributions.filter(
    (reward) => !reward.included && !reward.inclusionResolved,
  ).length;
  const summonSpending = cell.sessionChanges
    .filter((change) => change.kind === "SUMMON_SPEND")
    .reduce((total, change) => total + change.amount, 0);
  const fragmentConversion = cell.sessionChanges
    .filter((change) => change.kind === "FRAGMENT_CONVERSION")
    .reduce((total, change) => total + change.amount, 0);
  return (
    <aside
      className="timeline-details"
      data-empty="false"
      aria-labelledby="timeline-details-heading"
    >
      <div className="timeline-details-handle" aria-hidden="true" />
      <TimelinePanelHeader
        title={`${incomeResourceLabels[cell.itemType]} ${signedAmount(cell.delta)}`}
        headingId="timeline-details-heading"
        eyebrow="Resource changes"
        onClose={onClose}
        closeLabel="Close income details"
      />

      <dl className="timeline-detail-facts timeline-resource-facts">
        <div>
          <dt>Date</dt>
          <dd>
            <time dateTime={cell.day}>{formatCalendarDay(cell.day)}</time>
          </dd>
        </div>
        <div>
          <dt>Income</dt>
          <dd>{signedAmount(cell.incomeDelta)}</dd>
        </div>
        <div>
          <dt>Summon spending</dt>
          <dd>{signedAmount(summonSpending)}</dd>
        </div>
        {fragmentConversion !== 0 ? (
          <div>
            <dt>Fragment conversion</dt>
            <dd>{signedAmount(fragmentConversion)}</dd>
          </div>
        ) : null}
        <div data-summary-total="true">
          <dt>Net change</dt>
          <dd>{signedAmount(cell.delta)}</dd>
        </div>
        <div data-summary-total="true">
          <dt>Forecast closing balance</dt>
          <dd>
            {cell.closingBalance?.toLocaleString("en") ?? "Not available"}
          </dd>
        </div>
      </dl>

      <section className="timeline-detail-section">
        <h3>Change breakdown</h3>
        <p>
          {excludedCount === 0
            ? pendingCount === 0
              ? "No rewards are excluded."
              : ""
            : excludedCount === 1
              ? "1 excluded reward is not counted."
              : `${excludedCount} excluded rewards are not counted.`}
          {pendingCount > 0
            ? ` ${pendingCount === 1 ? "1 reward needs" : `${pendingCount} rewards need`} your choice and ${pendingCount === 1 ? "is" : "are"} not counted.`
            : ""}
        </p>
        <ul>
          {cell.contributions.map((contribution) => {
            const needsDecision =
              contribution.nature === "CONDITIONAL" &&
              !contribution.inclusionResolved;

            return (
              <li
                key={contribution.id}
                data-needs-decision={needsDecision ? "true" : undefined}
              >
                <span className="timeline-resource-breakdown-head">
                  <span>
                    {englishRewardLabel(contribution.rewardSource.name)}
                  </span>
                  <strong>{signedAmount(contribution.amount)}</strong>
                </span>
                <small>
                  {formatType(contribution.rewardSource.type)}
                  {` · ${formatType(contribution.nature)}`}
                  {contribution.rewardSource.event
                    ? ` · ${contribution.rewardSource.event.name}`
                    : ""}
                  {contribution.included
                    ? " · Included"
                    : !contribution.inclusionResolved
                      ? " · Needs choice"
                      : " · Excluded"}
                  {contribution.reviewStatus === "NEEDS_REVIEW"
                    ? " · Needs re-review"
                    : contribution.reviewedAt
                      ? ""
                      : " · Unreviewed"}
                </small>
                {needsDecision ? (
                  <small className="timeline-reward-decision-status">
                    Needs your choice. This reward is currently{" "}
                    {contribution.defaultIncluded ? "included" : "excluded"} by
                    default.
                  </small>
                ) : null}
                {contribution.inclusionReason ? (
                  <small>{contribution.inclusionReason}</small>
                ) : null}
                {englishRewardLabel(contribution.rewardSource.name) !==
                contribution.rewardSource.name ? (
                  <details>
                    <summary>Japanese source name</summary>
                    {contribution.rewardSource.name}
                  </details>
                ) : null}
                {contribution.eligibility ? (
                  <small>{englishRewardLabel(contribution.eligibility)}</small>
                ) : null}
                {contribution.assumption ? (
                  <small>Assumption: {contribution.assumption}</small>
                ) : null}
                <a
                  href={contribution.rewardSource.evidenceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View source
                </a>
                {contribution.nature === "CONDITIONAL" ? (
                  <RewardInclusionControls
                    rewardId={contribution.id}
                    label={`${englishRewardLabel(contribution.rewardSource.name)}: ${contribution.amount} ${incomeResourceLabels[contribution.itemType]}`}
                    override={
                      rewardPreferences.includedByRewardId[contribution.id]
                    }
                    onSetRewardInclusion={onSetRewardInclusion}
                  />
                ) : null}
              </li>
            );
          })}
          {cell.sessionChanges.map((change) => (
            <li key={change.id}>
              <span className="timeline-resource-breakdown-head">
                <span>{change.targetName}</span>
                <strong>{signedAmount(change.amount)}</strong>
              </span>
              <small>
                {change.kind === "FRAGMENT_CONVERSION"
                  ? "Fragment conversion"
                  : "Summon spending"}
                {` · ${change.bannerName} · Summon plan`}
              </small>
            </li>
          ))}
        </ul>
      </section>

      {profile ? (
        <p className="timeline-details-message">
          This balance is calculated from your snapshot dated{" "}
          {profile.snapshot.effectiveDate}.
        </p>
      ) : (
        <div className="timeline-details-message">
          <p>
            Add your current balances to calculate an accurate forecast for this
            date.
          </p>
          <button type="button" onClick={onOpenProfile}>
            Enter balances
          </button>
        </div>
      )}
    </aside>
  );
}

export function TimelineEntryDetails({
  entry,
  profile,
  timeZone,
  rewardPreferences,
  onSetRewardInclusion,
  onPlanSummons,
  onSelectRelated,
  searchQuery,
  onBackToSearch,
  onClose,
}: {
  entry: TimelineEntry;
  profile?: PlayerForecastProfile | null;
  timeZone: string;
  rewardPreferences: RewardPreferences;
  onSetRewardInclusion: (rewardId: string, included: boolean | null) => void;
  onPlanSummons?: (servantId?: number) => void;
  searchQuery?: string;
  onBackToSearch?: () => void;
  onSelectRelated?: (
    entry: Pick<TimelineEntry, "key" | "startsAt" | "startsAtPrecision">,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const catalogue = useStoryCatalogue();
  const input =
    entry.kind === "EVENT"
      ? ({ kind: "EVENT", id: entry.id } as const)
      : ({ kind: "BANNER", id: entry.id } as const);
  const details = api.timeline.details.useQuery(input, {
    staleTime: timelineSchedule.detailsStaleTimeMs,
  });
  const data =
    details.data?.id === input.id && details.data.kind === input.kind
      ? details.data
      : undefined;
  const waitingForDetails = !data && !details.isError;
  const [failedArtworkUrl, setFailedArtworkUrl] = useState<string | null>(null);
  const [openingRelated, setOpeningRelated] = useState(false);
  const [relatedError, setRelatedError] = useState(false);

  async function selectRelated(
    related: Pick<TimelineEntry, "key" | "startsAt" | "startsAtPrecision">,
  ) {
    if (!onSelectRelated || openingRelated) return;
    setOpeningRelated(true);
    setRelatedError(false);
    try {
      await onSelectRelated(related);
    } catch {
      setRelatedError(true);
    } finally {
      setOpeningRelated(false);
    }
  }

  const family = data?.family;
  const candidateArtworkUrl = family?.artworkReviewedAt
    ? eventArtworkUrl(family)
    : null;
  const reviewedArtworkUrl = artworkUrlAfterFailure(
    candidateArtworkUrl,
    failedArtworkUrl,
  );
  const hasPlanningAction = data?.kind === "BANNER" && Boolean(onPlanSummons);

  const content = (
    <>
      <div className="timeline-details-handle" aria-hidden="true" />
      <TimelinePanelHeader
        title={entry.name}
        headingId="timeline-details-heading"
        eyebrow={
          entry.category === "INCOME_SOURCE"
            ? "Income source"
            : entry.category === "EVENT"
              ? "Event"
              : "Summoning campaign"
        }
        className="timeline-entry-header"
        onClose={onClose}
        closeLabel="Close schedule details"
        back={
          onBackToSearch
            ? { label: "Back to results", onClick: onBackToSearch }
            : undefined
        }
      />

      <dl className="timeline-detail-facts timeline-entry-facts">
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
            {entry.kind === "EVENT"
              ? ` · ${statusNames[entry.dateConfirmation.startsAt]}`
              : null}
          </dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>
            {formatScheduleDate(entry.endsAt, entry.endsAtPrecision, timeZone)}
            {entry.kind === "EVENT" && entry.dateConfirmation.endsAt
              ? ` · ${statusNames[entry.dateConfirmation.endsAt]}`
              : null}
          </dd>
        </div>
      </dl>

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

      {waitingForDetails ? (
        <p
          className="timeline-details-message"
          data-state="loading"
          role="status"
        >
          Loading details…
        </p>
      ) : null}

      {details.isError ? (
        <div
          className="timeline-details-message"
          data-state="error"
          role="alert"
        >
          <p>
            {data
              ? "Showing the last loaded details. The update failed."
              : "The details could not load."}
          </p>
          <button type="button" onClick={() => details.refetch()}>
            Retry details
          </button>
        </div>
      ) : data && details.isFetching ? (
        <p
          className="timeline-details-message"
          data-state="refreshing"
          role="status"
        >
          Updating details…
        </p>
      ) : null}

      {data?.kind === "BANNER" ? (
        <section className="timeline-detail-section">
          <h3>Featured Servants</h3>
          {data.featured.length > 0 ? (
            <FeaturedServantList
              featured={data.featured}
              searchQuery={searchQuery}
              onPlanSummons={onPlanSummons}
            />
          ) : (
            <p>No featured Servant data is available.</p>
          )}
        </section>
      ) : null}

      {data?.kind === "EVENT" ? (
        <section className="timeline-detail-section">
          <h3>Rewards</h3>
          <EventRewardSummary
            sources={data.rewardSources}
            preferences={rewardPreferences}
            profile={profile}
            catalogue={catalogue}
          />
          {data.rewardSources.length > 0 ? (
            <ul>
              {data.rewardSources.map((source) => (
                <li key={source.id}>
                  <span>{englishRewardLabel(source.name)}</span>
                  <small>{formatType(source.type)}</small>
                  {englishRewardLabel(source.name) !== source.name ? (
                    <details>
                      <summary>Japanese source name</summary>
                      {source.name}
                    </details>
                  ) : null}
                  {source.rewards.length > 0 ? (
                    <ul className="timeline-reward-list">
                      {source.rewards.map((reward) => {
                        const inclusion = resolveRewardInclusion(
                          reward,
                          rewardPreferences,
                          profile,
                          catalogue,
                        );
                        return (
                          <li
                            key={reward.id}
                            data-needs-decision={
                              !inclusion.inclusionResolved ? "true" : undefined
                            }
                          >
                            <span>
                              <span className="timeline-resource-amount">
                                {reward.amount.toLocaleString("en")}
                              </span>{" "}
                              {incomeResourceLabels[reward.itemType]}
                            </span>
                            <small>
                              {inclusion.included
                                ? "Included"
                                : !inclusion.inclusionResolved
                                  ? "Needs choice"
                                  : "Excluded"}
                              {reward.reviewStatus === "NEEDS_REVIEW"
                                ? " · Needs re-review"
                                : reward.reviewedAt
                                  ? ""
                                  : " · Unreviewed"}
                            </small>
                            {!inclusion.inclusionResolved ? (
                              <small className="timeline-reward-decision-status">
                                Needs your choice. Excluded by default.
                              </small>
                            ) : null}
                            {inclusion.inclusionReason ? (
                              <small>{inclusion.inclusionReason}</small>
                            ) : null}
                            {reward.eligibility ? (
                              <small>
                                {englishRewardLabel(reward.eligibility)}
                              </small>
                            ) : null}
                            {!reward.expectedAt ? (
                              <small>No forecast date is available yet.</small>
                            ) : null}
                            {reward.nature === "CONDITIONAL" ? (
                              <RewardInclusionControls
                                rewardId={reward.id}
                                label={`${englishRewardLabel(source.name)}: ${reward.amount} ${incomeResourceLabels[reward.itemType]}`}
                                override={
                                  rewardPreferences.includedByRewardId[
                                    reward.id
                                  ]
                                }
                                onSetRewardInclusion={onSetRewardInclusion}
                              />
                            ) : null}
                          </li>
                        );
                      })}
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

      {data && data.relatedEntries.length > 0 ? (
        <section className="timeline-detail-section">
          <h3>Related schedule</h3>
          {openingRelated ? <p role="status">Loading the timeline…</p> : null}
          {relatedError ? (
            <p role="alert">
              This entry could not open in the timeline. Try again.
            </p>
          ) : null}
          <ul>
            {data.relatedEntries.map((related) => (
              <li key={related.key} className="timeline-related-entry">
                <button
                  type="button"
                  className="timeline-related-entry-button"
                  disabled={
                    !onSelectRelated ||
                    openingRelated ||
                    related.key === entry.key
                  }
                  aria-current={related.key === entry.key ? "true" : undefined}
                  onClick={() => void selectRelated(related)}
                >
                  <span>{related.name}</span>
                  <small>
                    {formatScheduleDate(
                      related.startsAt,
                      related.startsAtPrecision,
                      timeZone,
                    )}{" "}
                    · {formatType(related.category)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="timeline-sources">
        <summary>Sources</summary>
        <div className="timeline-sources-content">
          <dl className="timeline-detail-facts">
            <div>
              <dt>Region</dt>
              <dd>{entry.sourceRegion}</dd>
            </div>
          </dl>
          {data?.kind === "EVENT" && data.globalSourceUrl ? (
            <a
              className="timeline-source-link"
              href={data.globalSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Global game-data source
            </a>
          ) : null}
          {data?.sourceUrl ? (
            <a
              className="timeline-source-link"
              href={data.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View source
            </a>
          ) : null}
        </div>
      </details>
    </>
  );

  return (
    <aside
      className="timeline-details"
      data-empty="false"
      data-has-planning-action={hasPlanningAction ? "true" : undefined}
      aria-labelledby="timeline-details-heading"
    >
      {hasPlanningAction ? (
        <div className="timeline-entry-details-content">{content}</div>
      ) : (
        content
      )}
      {hasPlanningAction ? (
        <div className="timeline-detail-actions">
          <button
            type="button"
            className="timeline-primary-button"
            onClick={() => onPlanSummons?.()}
          >
            Plan summons
          </button>
        </div>
      ) : null}
    </aside>
  );
}
