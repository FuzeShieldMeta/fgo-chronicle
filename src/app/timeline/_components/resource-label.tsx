import Image from "next/image";
import {
  incomeResourceIcons,
  incomeResourceLabels,
  incomeResourceShortLabels,
} from "../_lib/income-ledger";
import type { ForecastResourceType } from "../_lib/player-forecast";
import { timelineLayout } from "../_lib/timeline-layout-config";

export function ResourceLabel({
  resource,
  compact = false,
}: {
  resource: ForecastResourceType;
  compact?: boolean;
}) {
  return (
    <span className="timeline-resource-label" data-resource={resource}>
      <Image
        src={incomeResourceIcons[resource]}
        alt=""
        width={timelineLayout.incomeResourceIconSize}
        height={timelineLayout.incomeResourceIconSize}
      />
      <span>
        {(compact ? incomeResourceShortLabels : incomeResourceLabels)[resource]}
      </span>
    </span>
  );
}
