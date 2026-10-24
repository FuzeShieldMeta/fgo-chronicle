"use client";

import {
  sortFeaturedServants,
  servantAtlasUrl,
  type FeaturedServant,
} from "~/shared/featured-servants";
import { timelineLayout } from "../_lib/timeline-layout-config";
import { ServantIdentity } from "./servant-thumbnail";
import { servantMatchesSearch } from "~/shared/timeline-search";

type Featured = {
  servant: FeaturedServant & { className: string };
  soloRateUp: boolean;
};

export function FeaturedServantList({
  featured,
  searchQuery,
  onPlanSummons,
}: {
  featured: readonly Featured[];
  searchQuery?: string;
  onPlanSummons?: (servantId: number) => void;
}) {
  const servants = sortFeaturedServants(
    featured.map((item) => ({ ...item.servant, soloRateUp: item.soloRateUp })),
  );
  const rarities = [...new Set(servants.map((servant) => servant.rarity))];
  return (
    <div className="timeline-featured-servants">
      {rarities.map((rarity) => (
        <div key={rarity ?? "unknown"} className="timeline-servant-group">
          <h5>{rarity === null ? "Other Servants" : `${rarity}★ Servants`}</h5>
          <ul>
            {servants
              .filter((servant) => servant.rarity === rarity)
              .map((servant) => (
                <li
                  key={servant.id}
                  data-plannable={onPlanSummons ? "true" : undefined}
                >
                  <a
                    className="timeline-servant-link"
                    data-search-match={
                      searchQuery && servantMatchesSearch(servant, searchQuery)
                        ? "true"
                        : undefined
                    }
                    href={servantAtlasUrl(servant)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${servant.name} - Atlas Academy Servant Page (opens in a new tab)`}
                  >
                    <ServantIdentity
                      name={servant.name}
                      className={servant.className}
                      thumbnailUrl={servant.thumbnailUrl}
                      size={timelineLayout.servantDetailsThumbnailSize}
                    />
                    {!onPlanSummons ? (
                      <small className="timeline-servant-rate-up">
                        {servant.soloRateUp ? "Solo rate-up" : "Shared rate-up"}
                      </small>
                    ) : null}
                  </a>
                  {onPlanSummons ? (
                    <div className="timeline-servant-actions">
                      <small className="timeline-servant-rate-up">
                        {servant.soloRateUp ? "Solo rate-up" : "Shared rate-up"}
                      </small>
                      <button
                        type="button"
                        className="timeline-tonal-button timeline-servant-plan-button"
                        aria-label={`Plan summons for ${servant.name} (${servant.className})`}
                        onClick={() => onPlanSummons(servant.id)}
                      >
                        <span className="timeline-servant-plan-label-full">
                          Plan summons
                        </span>
                        <span className="timeline-servant-plan-label-short">
                          Plan
                        </span>
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
