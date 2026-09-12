"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const mobileDetailsQuery = "(max-width: 900px)";
const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);

    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

export function TimelineDetailsLayer({
  active,
  labelledBy,
  selectionKey,
  returnFocusId,
  onClose,
  children,
}: {
  active: boolean;
  labelledBy: string;
  selectionKey: string;
  returnFocusId?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const isMobile = useMediaQuery(mobileDetailsQuery);
  const isModal = active && isMobile;

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isModal) return;

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusId = returnFocusId;
    const page = document.querySelector<HTMLElement>(".timeline-page");
    const previousOverflow = document.body.style.overflow;

    if (page) page.inert = true;
    document.body.style.overflow = "hidden";

    return () => {
      if (page) page.inert = false;
      document.body.style.overflow = previousOverflow;
      window.setTimeout(() => {
        const target = focusId
          ? (document.getElementById(focusId) ??
            document.querySelector<HTMLElement>(".timeline-day"))
          : opener;
        if (target?.isConnected) target.focus();
      }, 0);
    };
  }, [isModal, returnFocusId]);

  useEffect(() => {
    if (!isModal) return;

    const frame = window.requestAnimationFrame(() => {
      layerRef.current
        ?.querySelector<HTMLElement>(".timeline-close-button")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isModal, selectionKey]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRef.current();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter(
      (element) =>
        !element.hidden && element.getAttribute("aria-hidden") !== "true",
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!isModal) return children;

  return createPortal(
    <div
      ref={layerRef}
      className="timeline-details-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
