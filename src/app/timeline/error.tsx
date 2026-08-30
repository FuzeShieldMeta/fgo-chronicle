"use client";

export default function TimelineError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="p-8">
      <h1>Unable to load the timeline</h1>

      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
