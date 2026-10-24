"use client";

import { MethodologyContent } from "~/app/methodology/_components/methodology-content";
import { TimelinePanelHeader } from "./timeline-panel-header";

export function TimelineMethodologyDetails({
  onClose,
  onBack,
}: {
  onClose: () => void;
  onBack?: () => void;
}) {
  return (
    <aside
      className="timeline-details timeline-methodology-details"
      data-empty="false"
      aria-label="How the forecast works"
    >
      <TimelinePanelHeader
        title="How the forecast works"
        headingId="timeline-methodology-heading"
        onClose={onClose}
        back={
          onBack ? { label: "Back to settings", onClick: onBack } : undefined
        }
      />
      <div className="timeline-methodology-content">
        <MethodologyContent headingLevel={3} />
      </div>
    </aside>
  );
}
