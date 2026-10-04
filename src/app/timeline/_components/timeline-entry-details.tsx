"use client";
import { useStoryCatalogue } from "./story-catalogue-provider";

import Image from "next/image";
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
  CRYSTALLIZED_LORE: "Crystallised Lores",
  HOLY_GRAIL: "Holy Grails",
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
        <h3>Select a timeline entry</h3>
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
            <h4>Enter your balances</h4>
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
      <div className="timeline-details-header">
        <div>
          <span className="timeline-type-label">Player forecast</span>
          <h3 id="timeline-profile-heading">Starting balances</h3>
        </div>
        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
          aria-label="Close starting balances"
        >
          Close
        </button>
      </div>
      <PlayerForecastPanel
        profile={profile}
        today={today}
        onSave={onSaveProfile}
      />
    </aside>
  );
}

function signedAmount(value: number) {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
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
    (reward) => !reward.included,
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
      <div className="timeline-details-header">
        <div>
          <span className="timeline-type-label">Resource changes</span>
          <h3 id="timeline-details-heading">
            {incomeResourceLabels[cell.itemType]} {signedAmount(cell.delta)}
          </h3>
        </div>
        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
          aria-label="Close income details"
        >
          Close
        </button>
      </div>

      <dl className="timeline-detail-facts">
        <div>
          <dt>Date</dt>
          <dd>{cell.day}</dd>
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
        <div>
          <dt>Net change</dt>
          <dd>{signedAmount(cell.delta)}</dd>
        </div>
        <div>
          <dt>Forecast closing balance</dt>
          <dd>{cell.closingBalance ?? "Not available"}</dd>
        </div>
      </dl>

      <section className="timeline-detail-section">
        <h4>Change breakdown</h4>
        <p>
          Net resource change: {signedAmount(cell.delta)}.{" "}
          {excludedCount === 0
            ? "No rewards are excluded."
            : excludedCount === 1
              ? "1 excluded reward is not counted."
              : `${excludedCount} excluded rewards are not counted.`}
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
                <span>
                  {signedAmount(contribution.amount)} ·{" "}
                  {englishRewardLabel(contribution.rewardSource.name)}
                </span>
                <small>
                  {formatType(contribution.rewardSource.type)}
                  {` · ${formatType(contribution.nature)}`}
                  {contribution.rewardSource.event
                    ? ` · ${contribution.rewardSource.event.name}`
                    : ""}
                  {contribution.included ? " · Included" : " · Excluded"}
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
            <li key={change.id} data-session-status={change.status}>
              <span>
                {signedAmount(change.amount)} · {change.targetName}
              </span>
              <small>
                {change.kind === "FRAGMENT_CONVERSION"
                  ? "Fragment conversion"
                  : "Summon spending"}
                {` · ${change.bannerName} · ${change.status === "PLANNED" ? "Planned" : "Spent"}`}
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
  onClose,
}: {
  entry: TimelineEntry;
  profile?: PlayerForecastProfile | null;
  timeZone: string;
  rewardPreferences: RewardPreferences;
  onSetRewardInclusion: (rewardId: string, included: boolean | null) => void;
  onPlanSummons?: () => void;
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
          {onPlanSummons ? (
            <button
              type="button"
              className="timeline-primary-button"
              onClick={onPlanSummons}
            >
              Plan summons
            </button>
          ) : null}
        </section>
      ) : null}

      {details.data?.kind === "EVENT" ? (
        <section className="timeline-detail-section">
          <h4>Rewards</h4>
          {details.data.rewardSources.length > 0 ? (
            <ul>
              {details.data.rewardSources.map((source) => (
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
                              {reward.amount} {itemTypeNames[reward.itemType]}
                            </span>
                            <small>
                              {inclusion.included ? "Included" : "Excluded"}
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
                                label={`${englishRewardLabel(source.name)}: ${reward.amount} ${itemTypeNames[reward.itemType]}`}
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

      {details.data?.kind === "EVENT" && details.data.globalSourceUrl ? (
        <a
          className="timeline-source-link"
          href={details.data.globalSourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          Global game-data source
        </a>
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
