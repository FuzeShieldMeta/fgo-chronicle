"use client";

import {
  sortFeaturedServants,
  type FeaturedServant,
} from "~/shared/featured-servants";
import { timelineLayout } from "../_lib/timeline-layout-config";
import { ServantThumbnail } from "./servant-thumbnail";

type Featured = {
  servant: FeaturedServant & { className: string };
  soloRateUp: boolean;
};

export function FeaturedServantList({
  featured,
}: {
  featured: readonly Featured[];
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
                <li key={servant.id}>
                  <a
                    className="timeline-servant-link"
                    href={`https://apps.atlasacademy.io/db/JP/servant/${servant.id}/skill-1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${servant.name} - Atlas Academy Servant Page (opens in a new tab)`}
                  >
                    <ServantThumbnail
                      url={servant.thumbnailUrl}
                      size={timelineLayout.servantDetailsThumbnailSize}
                    />
                    <div className="timeline-servant-description">
                      <span>{servant.name}</span>
                      <small>{servant.className}</small>
                    </div>
                    <small className="timeline-servant-rate-up">
                      {servant.soloRateUp ? "Solo rate-up" : "Shared rate-up"}
                    </small>
                  </a>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
