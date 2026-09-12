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
  return (
    <div className="timeline-account">
      <button id="timeline-account-button" type="button" onClick={onOpen}>
        {user ? "Account" : "Sync"}
      </button>
    </div>
  );
}
