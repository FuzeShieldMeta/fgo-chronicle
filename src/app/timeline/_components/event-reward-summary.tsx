import { incomeResourceLabels } from "../_lib/income-ledger";
import {
  forecastResourceTypes,
  type ForecastResourceType,
  type PlayerForecastProfile,
} from "../_lib/player-forecast";
import {
  resolveRewardInclusion,
  type RewardPreferences,
} from "../_lib/reward-preferences";
import type { StoryChapter } from "../_lib/story-progress";

type SummaryReward = Parameters<typeof resolveRewardInclusion>[0] & {
  itemType: ForecastResourceType;
  amount: number;
  expectedAt: Date | null;
};
type ResourceTotal = { included: number; notIncluded: number };

export function EventRewardSummary({
  sources,
  preferences,
  profile,
  catalogue,
}: {
  sources: readonly { rewards: readonly SummaryReward[] }[];
  preferences: RewardPreferences;
  profile?: PlayerForecastProfile | null;
  catalogue: StoryChapter[];
}) {
  const dated = new Map<ForecastResourceType, ResourceTotal>();
  const undated = new Map<ForecastResourceType, ResourceTotal>();
  for (const source of sources) {
    for (const reward of source.rewards) {
      const group = reward.expectedAt ? dated : undated;
      let total = group.get(reward.itemType);
      if (!total) {
        total = { included: 0, notIncluded: 0 };
        group.set(reward.itemType, total);
      }
      const { included } = resolveRewardInclusion(
        reward,
        preferences,
        profile,
        catalogue,
      );
      total[included ? "included" : "notIncluded"] += reward.amount;
    }
  }
  if (!dated.size && !undated.size) return null;

  return (
    <div className="timeline-event-reward-summary">
      <p>Totals cover the whole event, not just unclaimed rewards.</p>
      {[
        {
          caption: undated.size ? "Dated rewards" : "Event totals",
          totals: dated,
        },
        { caption: "No forecast date", totals: undated },
      ].map(({ caption, totals }) =>
        totals.size ? (
          <table key={caption}>
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Included</th>
                <th scope="col">Not included</th>
              </tr>
            </thead>
            <tbody>
              {forecastResourceTypes.map((type) => {
                const total = totals.get(type);
                return total ? (
                  <tr key={type}>
                    <th scope="row">{incomeResourceLabels[type]}</th>
                    <td>{total.included.toLocaleString("en")}</td>
                    <td>{total.notIncluded.toLocaleString("en")}</td>
                  </tr>
                ) : null;
              })}
            </tbody>
          </table>
        ) : null,
      )}
    </div>
  );
}
