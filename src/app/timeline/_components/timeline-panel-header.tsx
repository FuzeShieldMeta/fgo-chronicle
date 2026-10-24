export function TimelinePanelHeader({
  title,
  headingId,
  eyebrow,
  onClose,
  closeLabel = "Close",
  back,
  className = "",
}: {
  title: string;
  headingId: string;
  eyebrow?: string;
  onClose: () => void;
  closeLabel?: string;
  back?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <header
      className={`timeline-panel-header ${className}`}
      data-has-back={back ? "true" : undefined}
    >
      <div className="timeline-entry-actions">
        {back ? (
          <button
            type="button"
            className="timeline-search-back"
            onClick={back.onClick}
          >
            {back.label}
          </button>
        ) : null}
        <button
          type="button"
          className="timeline-close-button"
          onClick={onClose}
          aria-label={closeLabel}
        >
          Close
        </button>
      </div>
      <div className="timeline-panel-title">
        {eyebrow ? (
          <span className="timeline-type-label">{eyebrow}</span>
        ) : null}
        <h3 id={headingId} tabIndex={-1}>
          {title}
        </h3>
      </div>
    </header>
  );
}
