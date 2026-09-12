export type TimelineAccountUser = {
  id: string;
};

export function TimelineAccountMenu({
  user,
  onOpen,
}: {
  user: TimelineAccountUser | null;
  onOpen: () => void;
}) {
  const label = user ? "Account" : "Sync";

  return (
    <button
      id="timeline-account-button"
      type="button"
      className="timeline-tonal-button timeline-toolbar-action"
      aria-label={label}
      onClick={onOpen}
    >
      <span
        className="timeline-toolbar-action-label"
        data-short-label={label}
        aria-hidden="true"
      >
        <span>{label}</span>
      </span>
    </button>
  );
}
