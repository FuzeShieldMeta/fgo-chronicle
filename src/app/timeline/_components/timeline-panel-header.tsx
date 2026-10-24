"use client";

import { useLayoutEffect, useRef } from "react";

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
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const scroller = header?.closest<HTMLElement>(
      ".timeline-entry-details-content, .timeline-details",
    );
    if (!header || !scroller) return;
    const property = "--timeline-panel-header-height";
    const previous = scroller.style.getPropertyValue(property);
    const update = () =>
      scroller.style.setProperty(
        property,
        `${header.getBoundingClientRect().height + 12}px`,
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      if (previous) scroller.style.setProperty(property, previous);
      else scroller.style.removeProperty(property);
    };
  }, []);
  return (
    <header
      ref={headerRef}
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
        <h2 id={headingId} tabIndex={-1}>
          {title}
        </h2>
      </div>
    </header>
  );
}
