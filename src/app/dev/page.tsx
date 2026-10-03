import type { Metadata } from "next";
import Link from "next/link";

import { auth } from "~/server/auth";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function DevPage() {
  const session = await auth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-950 to-indigo-950 px-6 text-white">
      <div className="flex max-w-3xl flex-col items-center gap-8 text-center">
        <div className="space-y-4">
          <p className="text-sm font-semibold tracking-[0.3em] text-indigo-300 uppercase">
            Fate/Grand Order resource planning
          </p>
          <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">
            FGO Chronicle
          </h1>
          <p className="mx-auto max-w-2xl text-lg leading-8 text-slate-300">
            Plan upcoming banners, project Saint Quartz income, and track your
            summon goals across the Global schedule.
          </p>
        </div>

        {session?.user ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-slate-300">
              Signed in as {session.user.name ?? session.user.email}
            </p>
            <Link
              href="/api/auth/signout"
              className="rounded-full border border-white/20 px-6 py-3 font-semibold transition hover:bg-white/10"
            >
              Sign out
            </Link>
          </div>
        ) : (
          <Link
            href="/api/auth/signin"
            className="rounded-full bg-indigo-500 px-7 py-3 font-semibold shadow-lg shadow-indigo-950/40 transition hover:bg-indigo-400"
          >
            Continue with Google
          </Link>
        )}
      </div>
    </main>
  );
}
