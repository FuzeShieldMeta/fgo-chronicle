"use client";

import { useEffect, useRef, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { plannerChangesLimits } from "~/shared/planner-changes";

export type RewardChoiceDetails =
  RouterOutputs["timeline"]["rewardChoices"][number];

export function useRewardChoiceDetails(ids: string[]) {
  const client = api.useUtils().client;
  const key = JSON.stringify([...ids].sort());
  const [retry, setRetry] = useState(0);
  const cache = useRef(new Map<string, RewardChoiceDetails | null>());
  const [result, setResult] = useState<{
    key: string;
    items: RewardChoiceDetails[];
    status: "loading" | "ready" | "error";
  }>({ key: "", items: [], status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const requested = JSON.parse(key) as string[];
    const items = () =>
      [...cache.current.values()].filter(
        (item): item is RewardChoiceDetails => item !== null,
      );
    const missing = requested.filter((id) => !cache.current.has(id));
    setResult({
      key,
      items: items(),
      status: missing.length ? "loading" : "ready",
    });
    if (!missing.length) return () => controller.abort();
    void (async () => {
      try {
        // Sequential bounded batches avoid a burst of queries for large imports.
        for (
          let offset = 0;
          offset < missing.length;
          offset += plannerChangesLimits.rewardLookupBatchSize
        ) {
          const ids = missing.slice(
            offset,
            offset + plannerChangesLimits.rewardLookupBatchSize,
          );
          const batch = await client.timeline.rewardChoices.query(
            {
              ids,
            },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          // Remember successful misses too (for example, local recurring IDs).
          for (const id of ids) cache.current.set(id, null);
          for (const item of batch) cache.current.set(item.id, item);
          setResult({ key, items: items(), status: "loading" });
        }
        if (!controller.signal.aborted)
          setResult({ key, items: items(), status: "ready" });
      } catch {
        if (!controller.signal.aborted)
          setResult({ key, items: items(), status: "error" });
      }
    })();
    return () => controller.abort();
  }, [client, key, retry]);
  const selectedIds = new Set(ids);
  return {
    items: result.items.filter((item) => selectedIds.has(item.id)),
    status: !ids.length
      ? ("ready" as const)
      : result.key === key
        ? result.status
        : ("loading" as const),
    retry: () => setRetry((current) => current + 1),
  };
}
