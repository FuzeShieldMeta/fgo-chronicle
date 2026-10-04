"use client";

import { useState } from "react";
import { api, type RouterInputs } from "~/trpc/react";

type Choices = RouterInputs["curator"]["previewGlobalEvent"];
const labels: Record<string, string> = {
  name: "Name",
  startsAt: "Start",
  endsAt: "End",
  itemType: "Reward item",
  amount: "Amount",
  expectedAt: "Reward date",
  nature: "Reward type",
  eligibility: "Eligibility",
  defaultIncluded: "Default inclusion",
};
function formatValue(value: unknown): string {
  if (value instanceof Date)
    return value.toISOString().replace("T", " ").replace("Z", " UTC");
  if (value === null) return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return "Not set";
}
function FieldValues({
  field,
}: {
  field: { current: unknown; source: unknown; next: unknown };
}) {
  return (
    <dl className="curator-preview-values">
      <dt>Current</dt>
      <dd>{formatValue(field.current)}</dd>
      <dt>Global source</dt>
      <dd>{formatValue(field.source)}</dd>
      <dt>Proposed</dt>
      <dd>{formatValue(field.next)}</dd>
    </dl>
  );
}

export function CuratorGlobalPreview({ candidateId }: { candidateId: string }) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Choices>({
    candidateId,
    useGlobalEventFields: [],
    useGlobalRewardFields: [],
  });
  const preview = api.curator.previewGlobalEvent.useQuery(choices, {
    enabled: open,
  });
  const data = preview.data;
  return (
    <details
      className="curator-global-preview"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Preview Global values</summary>
      <p>
        This preview does not save changes. Only this event is affected, not
        other family members or summon banners.
      </p>
      <div aria-busy={preview.isFetching}>
        {preview.isPending ? <p role="status">Loading preview…</p> : null}
        {preview.error ? (
          <p role="alert">
            {preview.error.message}{" "}
            <button type="button" onClick={() => void preview.refetch()}>
              Retry preview
            </button>
          </p>
        ) : null}
        {data ? (
          <>
            {data.problems.length ? (
              <div role="alert">
                <p>This assessment cannot be published:</p>
                <ul>
                  {data.problems.map((problem) => (
                    <li key={problem}>
                      {problem.toLowerCase().replaceAll("_", " ")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p>
              Date status after approval:{" "}
              {data.confirmation.status.toLowerCase()}. Start:{" "}
              {data.confirmation.startsAt.toLowerCase()}. End:{" "}
              {data.confirmation.endsAt?.toLowerCase() ?? "not dated"}.
            </p>
            {data.hidden ? <p>This event stays hidden.</p> : null}
            {data.fields.map((field) => (
              <section key={field.field} className="curator-preview-field">
                <h4>{labels[field.field]}</h4>
                <FieldValues field={field} />
                {field.owned ? (
                  <label className="curator-checkbox">
                    <input
                      type="checkbox"
                      checked={!field.keepCorrection}
                      disabled={preview.isFetching}
                      onChange={(event) =>
                        setChoices((current) => ({
                          ...current,
                          useGlobalEventFields: event.target.checked
                            ? [
                                ...(current.useGlobalEventFields ?? []),
                                field.field,
                              ]
                            : current.useGlobalEventFields?.filter(
                                (value) => value !== field.field,
                              ),
                        }))
                      }
                    />
                    Use Global source value instead of the curator correction
                  </label>
                ) : (
                  <p>Uses the Global source value.</p>
                )}
              </section>
            ))}
            <h4>Rewards</h4>
            <p>
              Reward amount differences before player inclusion choices:{" "}
              {Object.entries(data.resourceDelta)
                .map(
                  ([item, amount]) =>
                    `${item.toLowerCase().replaceAll("_", " ")}: ${amount > 0 ? "+" : ""}${amount}`,
                )
                .join(", ") || "None"}
              . Conditional rewards are not guaranteed income.
            </p>
            <p>{data.coverageWarning}</p>
            <ul className="curator-global-records">
              {data.rewards.map((reward) => (
                <li key={reward.id}>
                  <details>
                    <summary>
                      {formatValue(reward.current.itemType)}:{" "}
                      {reward.current.amount} → {reward.next.amount} ·{" "}
                      {reward.matched ? "Source matched" : "Unchanged"}
                    </summary>
                    <p>
                      Reward ID stays {reward.id}. Current date:{" "}
                      {formatValue(reward.current.expectedAt)}. Proposed date:{" "}
                      {formatValue(reward.next.expectedAt)}.
                    </p>
                    {reward.warning ? (
                      <p>{reward.warning.toLowerCase().replaceAll("_", " ")}</p>
                    ) : null}
                    {reward.fields.map((field) => (
                      <section
                        key={field.field}
                        className="curator-preview-field"
                      >
                        <h5>{labels[field.field]}</h5>
                        <FieldValues field={field} />
                        {field.owned ? (
                          <label className="curator-checkbox">
                            <input
                              type="checkbox"
                              checked={!field.keepCorrection}
                              disabled={preview.isFetching}
                              onChange={(event) =>
                                setChoices((current) => {
                                  const selections =
                                    current.useGlobalRewardFields ?? [];
                                  const fields =
                                    selections.find(
                                      (value) => value.rewardId === reward.id,
                                    )?.fields ?? [];
                                  const next = event.target.checked
                                    ? [...fields, field.field]
                                    : fields.filter(
                                        (value) => value !== field.field,
                                      );
                                  return {
                                    ...current,
                                    useGlobalRewardFields: [
                                      ...selections.filter(
                                        (value) => value.rewardId !== reward.id,
                                      ),
                                      { rewardId: reward.id, fields: next },
                                    ],
                                  };
                                })
                              }
                            />
                            Use Global source value instead of the curator
                            correction
                          </label>
                        ) : null}
                      </section>
                    ))}
                  </details>
                </li>
              ))}
            </ul>
            {data.unmatchedGlobalRewards.length ? (
              <details>
                <summary>
                  Unmatched Global rewards ({data.unmatchedGlobalRewards.length}
                  )
                </summary>
                <ul>
                  {data.unmatchedGlobalRewards.map((key) => (
                    <li key={key}>{key}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <p>
              JP source evidence is retained. Family associations, reward IDs
              and player selections stay unchanged.
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}
