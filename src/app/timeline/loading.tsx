export default function TimelineLoading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="h-10 w-72 animate-pulse rounded bg-slate-200" />

      <div className="mt-8 space-y-4">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-xl bg-slate-100"
          />
        ))}
      </div>
    </main>
  );
}