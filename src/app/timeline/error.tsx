"use client";

export default function TimelineError({ reset }: { reset: () => void }) {
  return (
    <main className="timeline-page">
      <header className="timeline-app-bar">
        <span className="timeline-brand-mark" aria-hidden="true" />
        <div className="timeline-app-title">
          <h1>FGO Chronicle</h1>
          <p>Global schedule planner</p>
        </div>
      </header>

      <section className="timeline-empty" role="alert">
        <h2>The schedule could not load</h2>
        <p>Check the connection, then try again.</p>
        <button type="button" className="timeline-retry" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
