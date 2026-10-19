"use client";

import { useEffect, useRef, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { plannerChangesLimits } from "~/shared/planner-changes";

type Servant = RouterOutputs["timeline"]["servants"][number];

export function useServantDetails(ids: readonly number[]) {
  const client = api.useUtils().client;
  const key = JSON.stringify([...new Set(ids)].sort((a, b) => a - b));
  const cache = useRef(new Map<number, Servant | null>());
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    items: Servant[];
    failed: boolean;
  }>({ key: "", items: [], failed: false });
  useEffect(() => {
    const controller = new AbortController();
    const requested = JSON.parse(key) as number[];
    const items = () => requested.flatMap((id) => cache.current.get(id) ?? []);
    const missing = requested.filter((id) => !cache.current.has(id));
    setResult({ key, items: items(), failed: false });
    if (!missing.length) return () => controller.abort();
    void (async () => {
      try {
        for (
          let offset = 0;
          offset < missing.length;
          offset += plannerChangesLimits.servantLookupBatchSize
        ) {
          const batchIds = missing.slice(
            offset,
            offset + plannerChangesLimits.servantLookupBatchSize,
          );
          const batch = await client.timeline.servants.query(
            { ids: batchIds },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          for (const id of batchIds) cache.current.set(id, null);
          for (const servant of batch) cache.current.set(servant.id, servant);
          setResult({ key, items: items(), failed: false });
        }
      } catch {
        if (!controller.signal.aborted)
          setResult({ key, items: items(), failed: true });
      }
    })();
    return () => controller.abort();
  }, [client, key, retry]);
  return {
    items: result.key === key ? result.items : [],
    failed: result.key === key && result.failed,
    retry: () => setRetry((current) => current + 1),
  };
}
