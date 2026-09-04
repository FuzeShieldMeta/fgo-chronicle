export default function TimelineLoading() {
  return (
    <main className="timeline-page" aria-busy="true">
      <header className="timeline-app-bar">
        <span className="timeline-brand-mark" aria-hidden="true" />
        <div className="timeline-app-title">
          <h1>FGO Chronicle</h1>
          <p>Global schedule planner</p>
        </div>
      </header>

      <section className="timeline-preparing">
        <div className="timeline-progress" aria-hidden="true" />
        <p>Loading schedule…</p>
      </section>
    </main>
  );
}
