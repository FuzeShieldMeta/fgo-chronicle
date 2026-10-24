"use client";

import { MethodologyContent } from "~/app/methodology/_components/methodology-content";

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
      aria-label="How the forecast works"
    >
      <div className="timeline-details-header">
        <div>
          {onBack ? (
            <button
              type="button"
              className="timeline-search-back"
              onClick={onBack}
            >
              Back to settings
            </button>
          ) : null}
          <h3 id="timeline-methodology-heading">How the forecast works</h3>
        </div>
        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="timeline-methodology-content">
        <MethodologyContent />
      </div>
    </aside>
  );
}
