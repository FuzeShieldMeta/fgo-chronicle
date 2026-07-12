import { api } from "~/trpc/server";

function twoYearsFromNow() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 2);
  return date;
}

export default async function TimelinePage() {
  const banners = await api.banner.upcoming({
    from: new Date(),
    to: twoYearsFromNow(),
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-4xl font-bold">Upcoming banners</h1>

      <div className="mt-8 space-y-4">
        {banners.map((banner) => (
          <article key={banner.id} className="rounded-xl border p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">{banner.name}</h2>

                <p className="mt-1 text-sm text-slate-500">
                  {banner.startsAt.toLocaleDateString()} –{" "}
                  {banner.endsAt?.toLocaleDateString() ?? "Unknown"}
                </p>
              </div>

              <span>{banner.status}</span>
            </div>

            <ul className="mt-4">
              {banner.featured.map(({ servant, soloRateUp }) => (
                <li key={servant.id}>
                  {servant.name} · {servant.className}
                  {soloRateUp ? " · Solo rate-up" : ""}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </main>
  );
}
