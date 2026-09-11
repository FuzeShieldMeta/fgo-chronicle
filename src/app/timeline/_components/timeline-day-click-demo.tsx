export function TimelineDayClickDemo() {
  return (
    <span className="timeline-day-click-demo" aria-hidden="true">
      <span className="timeline-day-click-demo-ring" />
      <svg
        className="timeline-day-click-demo-cursor"
        viewBox="0 0 28 32"
        focusable="false"
      >
        <path d="M3 2.5v23.2l6-5.2 4.4 8.7 4-2-4.3-8.4h8.4L3 2.5Z" />
      </svg>
    </span>
  );
}
