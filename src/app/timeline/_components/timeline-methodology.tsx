"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { MethodologyContent } from "~/app/methodology/_components/methodology-content";

const MethodologyContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>({
  open: false,
  setOpen: () => undefined,
});

export function TimelineMethodologyProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <MethodologyContext.Provider value={{ open, setOpen }}>
      {children}
    </MethodologyContext.Provider>
  );
}

export const useTimelineMethodology = () => useContext(MethodologyContext);

export function TimelineMethodologyButton() {
  const { open, setOpen } = useTimelineMethodology();
  return (
    <button
      id="timeline-methodology-button"
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      How the forecast works
    </button>
  );
}

export function TimelineMethodologyDetails({
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <aside
      className="timeline-details timeline-methodology-details"
      aria-label="How the forecast works"
    >
      <div className="timeline-details-header">
        <h3 id="timeline-methodology-heading">How the forecast works</h3>
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
