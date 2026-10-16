import type { PersonalChangeMarker } from "../_lib/planner-change-markers";

export function personalChangeDescription(marker?: PersonalChangeMarker) {
  return [
    marker?.reward ? "Saved reward choice" : "",
    marker?.summon ? "Summon plan or recorded spending" : "",
  ]
    .filter(Boolean)
    .join(". ");
}

export function PersonalChangeMarkers({
  marker,
}: {
  marker?: PersonalChangeMarker;
}) {
  if (!marker?.reward && !marker?.summon) return null;
  return (
    <span
      className="timeline-personal-markers"
      role="img"
      aria-label={personalChangeDescription(marker)}
    >
      {marker.reward ? <i data-change="reward" /> : null}
      {marker.summon ? <i data-change="summon" /> : null}
    </span>
  );
}
