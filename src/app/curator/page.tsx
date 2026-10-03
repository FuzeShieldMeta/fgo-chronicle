import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { auth } from "~/server/auth";
import { hasCuratorAccess } from "~/server/auth/curator";
import { db } from "~/server/db";
import { CuratorDashboard } from "./_components/curator-dashboard";
import "./curator.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Curator dashboard",
  robots: { index: false, follow: false },
};

export default async function CuratorPage() {
  const session = await auth();
  if (!session?.user?.id || !(await hasCuratorAccess(db, session.user.id)))
    notFound();
  return (
    <main className="curator-page">
      <header className="curator-header">
        <div>
          <h1>Curator dashboard</h1>
          <p>Schedule corrections and reward review</p>
        </div>
        <Link href="/timeline">Open timeline</Link>
      </header>
      <CuratorDashboard />
    </main>
  );
}
