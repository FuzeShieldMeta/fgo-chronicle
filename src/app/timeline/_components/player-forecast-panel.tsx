"use client";

import { useId, useState, type FormEvent } from "react";

import { incomeResourceLabels } from "~/app/timeline/_lib/income-ledger";
import {
  emptyForecastBalances,
  forecastResourceTypes,
  playerForecastProfileSchema,
  type PlayerForecastProfile,
} from "~/app/timeline/_lib/player-forecast";
import { useStoryCatalogue } from "./story-catalogue-provider";
import { recurringIncomeRules } from "~/app/timeline/_lib/recurring-income-rules";

export function PlayerForecastPanel({
  profile,
  today,
  onSave,
}: {
  profile: PlayerForecastProfile | null;
  today: string;
  onSave: (profile: PlayerForecastProfile) => void;
}) {
  const catalogue = useStoryCatalogue();
  const mainStoryChapters = catalogue.filter((chapter) => !chapter.optional);
  const optionalStoryChapters = catalogue.filter((chapter) => chapter.optional);
  const [selectedOptionalStories, setSelectedOptionalStories] = useState(
    profile?.storyProgress?.optionalWarIds ?? [],
  );
  const allOptionalSelected = optionalStoryChapters.every((chapter) =>
    selectedOptionalStories.includes(chapter.warId),
  );
  const [editing, setEditing] = useState(profile === null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fieldId = useId();
  const fieldAttributes = (name: string) => ({
    "aria-invalid": fieldErrors[name] ? true : undefined,
    "aria-describedby": fieldErrors[name]
      ? `${fieldId}-${name}-error`
      : undefined,
  });
  const fieldError = (name: string) =>
    fieldErrors[name] ? (
      <span
        id={`${fieldId}-${name}-error`}
        className="timeline-field-error"
        role="alert"
      >
        {fieldErrors[name]}
      </span>
    ) : null;

  if (profile && !editing) {
    return (
      <section className="timeline-profile-summary">
        <h4>Forecast starting point</h4>
        <p>
          Balances are counted from{" "}
          <time>{profile.snapshot.effectiveDate}</time>.
        </p>
        <button
          type="button"
          onClick={() => {
            setSelectedOptionalStories(
              profile.storyProgress?.optionalWarIds ?? [],
            );
            setEditing(true);
          }}
        >
          Edit starting balances
        </button>
      </section>
    );
  }

  return (
    <form
      className="timeline-profile-form"
      onInvalid={(event) => {
        const input = event.target;
        if (!(
          input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement
        ))
          return;
        if (input.name)
          setFieldErrors((current) => ({
            ...current,
            [input.name]: input.validationMessage,
          }));
      }}
      onChange={(event) => {
        const input = event.target;
        if (!(
          input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement
        ))
          return;
        if (fieldErrors[input.name])
          setFieldErrors((current) => {
            const next = { ...current };
            delete next[input.name];
            return next;
          });
        setError(null);
      }}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const balances = { ...emptyForecastBalances };

        for (const itemType of forecastResourceTypes) {
          balances[itemType] = Number(data.get(itemType));
        }

        const consecutiveLoginValue = data.get("consecutiveLoginDay");
        const consecutiveLoginEntry =
          typeof consecutiveLoginValue === "string"
            ? consecutiveLoginValue.trim()
            : "";
        const result = playerForecastProfileSchema.safeParse({
          version: 2,
          storyProgress: {
            mainWarId: data.get("mainStory")
              ? Number(data.get("mainStory"))
              : null,
            optionalWarIds: data.getAll("optionalStory").map(Number),
          },
          snapshot: { effectiveDate: today, balances },
          cumulativeLoginCount: Number(data.get("cumulativeLoginCount")),
          consecutiveLoginDay: consecutiveLoginEntry
            ? Number(consecutiveLoginEntry)
            : null,
          includeMonthlyManaPrismTickets: data.has(
            "includeMonthlyManaPrismTickets",
          ),
          includeWeeklyMasterMissions: data.has("includeWeeklyMasterMissions"),
        });

        if (!result.success) {
          const errors: Record<string, string> = {};
          for (const issue of result.error.issues) {
            const name =
              issue.path[0] === "snapshot"
                ? String(issue.path[2])
                : issue.path[0] === "storyProgress"
                  ? issue.path[1] === "mainWarId"
                    ? "mainStory"
                    : "optionalStory"
                  : String(issue.path[0]);
            errors[name] ??= issue.message;
          }
          setFieldErrors(errors);
          setError("Check the highlighted fields.");
          const control = event.currentTarget.elements.namedItem(
            Object.keys(errors)[0] ?? "",
          );
          if (control instanceof HTMLElement) control.focus();
          return;
        }

        onSave(result.data);
        setError(null);
        setFieldErrors({});
        setEditing(false);
      }}
    >
      <div>
        <p>
          Enter the resources you have today to replace the default zero
          balances.
        </p>
        <small>These balances will be saved as current for {today}.</small>
      </div>

      <fieldset className="timeline-form-group">
        <legend>Resources</legend>
        <div className="timeline-balance-fields">
          {forecastResourceTypes.map((itemType) => (
            <label key={itemType}>
              {incomeResourceLabels[itemType]}
              <input
                type="number"
                name={itemType}
                required
                min="0"
                step="1"
                inputMode="numeric"
                defaultValue={profile?.snapshot.balances[itemType] ?? 0}
                {...fieldAttributes(itemType)}
              />
              {fieldError(itemType)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="timeline-story-progress">
        <legend>Story progress</legend>
        <label>
          Main story completed through
          <select
            name="mainStory"
            defaultValue={profile?.storyProgress?.mainWarId ?? ""}
            {...fieldAttributes("mainStory")}
          >
            <option value="">Not set</option>
            {mainStoryChapters.map((chapter) => (
              <option key={chapter.warId} value={chapter.warId}>
                {chapter.name}
              </option>
            ))}
          </select>
          {fieldError("mainStory")}
        </label>
        <small>Earlier main stories are included.</small>
        <details>
          <summary>Other completed stories</summary>
          <button
            type="button"
            onClick={() =>
              setSelectedOptionalStories(
                allOptionalSelected
                  ? []
                  : optionalStoryChapters.map((chapter) => chapter.warId),
              )
            }
          >
            {allOptionalSelected ? "Clear all" : "Select all"}
          </button>
          {optionalStoryChapters.map((chapter) => (
            <label className="timeline-profile-checkbox" key={chapter.warId}>
              <input
                type="checkbox"
                name="optionalStory"
                value={chapter.warId}
                checked={selectedOptionalStories.includes(chapter.warId)}
                onChange={(event) =>
                  setSelectedOptionalStories((current) =>
                    event.target.checked
                      ? [...current, chapter.warId]
                      : current.filter((id) => id !== chapter.warId),
                  )
                }
              />
              {chapter.name}
            </label>
          ))}
        </details>
        {fieldError("optionalStory")}
      </fieldset>

      <fieldset className="timeline-form-group">
        <legend>Login progress</legend>
        <label>
          Total login count <small>Rewards start at day 100</small>
          <input
            type="number"
            name="cumulativeLoginCount"
            min="0"
            step="1"
            inputMode="numeric"
            required
            defaultValue={profile?.cumulativeLoginCount ?? 100}
            {...fieldAttributes("cumulativeLoginCount")}
          />
          {fieldError("cumulativeLoginCount")}
        </label>

        <label>
          Current consecutive login day
          <small>
            Optional. Without this, the seven-day cycle is estimated from your
            total login count.
          </small>
          <input
            type="number"
            name="consecutiveLoginDay"
            min="1"
            max="7"
            step="1"
            inputMode="numeric"
            defaultValue={profile?.consecutiveLoginDay ?? ""}
            placeholder="1–7"
            {...fieldAttributes("consecutiveLoginDay")}
          />
          {fieldError("consecutiveLoginDay")}
        </label>
      </fieldset>

      <fieldset className="timeline-form-group">
        <legend>Recurring income</legend>
        <label className="timeline-profile-checkbox">
          <input
            type="checkbox"
            name="includeMonthlyManaPrismTickets"
            defaultChecked={profile?.includeMonthlyManaPrismTickets ?? true}
          />
          <span>
            Include all{" "}
            {recurringIncomeRules.monthlyManaPrismExchange.maximumTickets}{" "}
            monthly Mana Prism tickets
            <small>
              {" "}
              Costs{" "}
              {recurringIncomeRules.monthlyManaPrismExchange.maximumTickets *
                recurringIncomeRules.monthlyManaPrismExchange
                  .manaPrismCostEach}{" "}
              Mana Prisms in total.
            </small>
          </span>
        </label>

        <label className="timeline-profile-checkbox">
          <input
            type="checkbox"
            name="includeWeeklyMasterMissions"
            defaultChecked={profile?.includeWeeklyMasterMissions ?? true}
          />
          Include all weekly Master Mission fragments
        </label>
      </fieldset>

      {error ? (
        <p className="timeline-form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="timeline-form-actions">
        <button type="submit">Save starting point</button>
        {profile ? (
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
