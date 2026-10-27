// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SummonPlanPanel,
  type SummonPlanSpending,
  type SummonPlanTarget,
} from "~/app/timeline/_components/summon-plan-panel";
import {
  createSummonSession,
  type SummonSession,
} from "~/app/timeline/_lib/summon-session";
import {
  createDefaultPlayerForecastProfile,
  type ForecastBalances,
} from "~/app/timeline/_lib/player-forecast";
import {
  buildIncomeLedger,
  summonSessionBalances,
} from "~/app/timeline/_lib/income-ledger";
import { createRewardPreferences } from "~/app/timeline/_lib/reward-preferences";

const day = "2026-10-28";
const target: SummonPlanTarget = {
  servantId: 1,
  name: "Target",
  startingNp: 0,
  rate: 0.008,
  rateKind: "STANDARD_PRESET",
  rateEvidenceUrl: null,
  guaranteedEligible: true,
  startingGuaranteedCount: 0,
};
const banner = { id: "banner", name: "Pickup", lineupKey: "lineup" };
const initialBalances: ForecastBalances = {
  SAINT_QUARTZ: 300,
  SUMMON_TICKET: 10,
  SAINT_QUARTZ_FRAGMENT: 21,
  HOLY_GRAIL: 0,
  CRYSTALLIZED_LORE: 0,
};
const emptySpending: SummonPlanSpending = {
  multis: 0,
  quartzSingles: 0,
  tickets: 0,
  fragmentsConverted: 0,
  startingBonusCount: 0,
};
afterEach(cleanup);

function PlanForm({
  onSave,
  existing = null,
  balances = initialBalances,
  selectedTarget = target,
}: {
  onSave: (session: SummonSession) => void;
  existing?: SummonSession | null;
  balances?: ForecastBalances;
  selectedTarget?: SummonPlanTarget | null;
}) {
  const [spending, setSpending] = useState<SummonPlanSpending>(() =>
    existing
      ? {
          ...existing.spending,
          startingBonusCount: existing.startingBonusCount,
        }
      : { ...emptySpending },
  );
  return (
    <SummonPlanPanel
      day={day}
      banner={banner}
      target={selectedTarget}
      balances={balances}
      spending={spending}
      onSpendingChange={setSpending}
      onSave={onSave}
      editingSession={existing}
    />
  );
}

describe("mounted summon planning workflow", () => {
  it("saves the values entered through real controls as a planned session", async () => {
    const user = userEvent.setup(),
      save = vi.fn<(session: SummonSession) => void>();
    render(<PlanForm onSave={save} />);
    await user.click(screen.getByRole("button", { name: "+30 SQ multi" }));
    await user.click(screen.getByRole("button", { name: "+1 ticket" }));
    await user.click(screen.getByRole("button", { name: "+3 SQ single" }));
    expect(screen.getByLabelText(/Multis/).getAttribute("value")).toBe("1");
    expect(screen.getByText("33 SQ · 1 tickets")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save plan" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      status: "PLANNED",
      day,
      banner,
      target: { servantId: 1 },
      spending: {
        multis: 1,
        quartzSingles: 1,
        tickets: 1,
        fragmentsConverted: 0,
      },
      result: null,
    });
    expect(save.mock.calls[0]![0].id).not.toBe("");
  });

  it("edits an existing session without changing its identity, result or recorded status", async () => {
    const existing = createSummonSession(
      {
        day,
        status: "SPENT",
        banner,
        target,
        spending: { ...emptySpending, multis: 1 },
        startingGuaranteedCount: 0,
        startingBonusCount: 0,
        result: { targetCopies: 1 },
      },
      { id: "existing", now: "2026-10-27T00:00:00Z" },
    );
    const user = userEvent.setup(),
      save = vi.fn<(session: SummonSession) => void>();
    render(
      <PlanForm
        onSave={save}
        existing={existing}
        balances={{ ...initialBalances, SAINT_QUARTZ: 270 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "+30 SQ multi" }));
    expect(screen.getByText("60 SQ · 0 tickets")).toBeTruthy();
    expect(screen.getByText("240")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Update plan" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      id: existing.id,
      createdAt: existing.createdAt,
      status: "SPENT",
      result: { targetCopies: 1 },
      spending: { multis: 2 },
      banner,
    });
  });

  it("shows validation without saving an empty plan, then clears it after a valid submit", async () => {
    const user = userEvent.setup(),
      save = vi.fn();
    render(<PlanForm onSave={save} />);
    await user.click(screen.getByRole("button", { name: "Save plan" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Add at least one summon.",
    );
    await user.click(screen.getByRole("button", { name: "+1 ticket" }));
    await user.click(screen.getByRole("button", { name: "Save plan" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requires a target even when the user has entered spending", async () => {
    const user = userEvent.setup(),
      save = vi.fn();
    render(<PlanForm onSave={save} selectedTarget={null} />);
    await user.click(screen.getByRole("button", { name: "+1 ticket" }));
    await user.click(screen.getByRole("button", { name: "Save plan" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Select a summoning campaign and target Servant.",
    );
  });

  it("carries a saved fragment-funded plan into the independent balances of a later session", async () => {
    const balances = { ...initialBalances, SAINT_QUARTZ: 29 };
    const user = userEvent.setup(),
      save = vi.fn<(session: SummonSession) => void>();
    render(<PlanForm onSave={save} balances={balances} />);
    await user.click(screen.getByRole("button", { name: "+30 SQ multi" }));
    await user.click(screen.getByRole("button", { name: "+1 ticket" }));
    await user.click(
      screen.getByLabelText("Automatically convert SQ Fragments"),
    );
    expect(screen.getByText("7 fragments → 1 SQ")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save plan" }));
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]![0];
    expect(saved.spending).toEqual({
      multis: 1,
      quartzSingles: 0,
      tickets: 1,
      fragmentsConverted: 7,
    });
    const later = createSummonSession(
      {
        day,
        status: "PLANNED",
        banner,
        target,
        spending: {
          multis: 0,
          quartzSingles: 1,
          tickets: 1,
          fragmentsConverted: 7,
        },
        startingGuaranteedCount: 0,
        startingBonusCount: 0,
        result: null,
      },
      { id: "later", now: "2099-01-01T00:00:00Z" },
    );
    const profile = createDefaultPlayerForecastProfile(day);
    profile.snapshot.balances = balances;
    profile.includeMonthlyManaPrismTickets = false;
    profile.includeWeeklyMasterMissions = false;
    const sessions = [later, saved];
    const cells = buildIncomeLedger(
      [day],
      [],
      profile,
      "UTC",
      createRewardPreferences(),
      undefined,
      sessions,
    );
    const summaries = summonSessionBalances({
      cells,
      sessions,
      profile,
      fromDay: day,
      throughDay: day,
    });
    expect(summaries.get(saved.id)?.after).toMatchObject({
      SAINT_QUARTZ: 0,
      SUMMON_TICKET: 9,
      SAINT_QUARTZ_FRAGMENT: 14,
    });
    expect(summaries.get(later.id)?.before).toMatchObject({
      SAINT_QUARTZ: 0,
      SUMMON_TICKET: 9,
      SAINT_QUARTZ_FRAGMENT: 14,
    });
    expect(summaries.get(later.id)?.after).toMatchObject({
      SAINT_QUARTZ: -2,
      SUMMON_TICKET: 8,
      SAINT_QUARTZ_FRAGMENT: 7,
    });
  });
});
