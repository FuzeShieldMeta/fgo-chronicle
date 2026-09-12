"use client";

import { useEffect, useRef, useState } from "react";

import {
  hashPlannerState,
  hasMeaningfulPlannerData,
  loadPlannerSyncMarker,
  reconcilePlannerCopies,
  savePlannerSyncMarker,
  type PlannerCloudSnapshot,
  type PlannerStatePayload,
  type PlannerSyncMarker,
} from "~/app/timeline/_lib/planner-state";
import { api } from "~/trpc/react";

export type PlannerSyncStatus =
  "LOCAL" | "LOADING" | "SAVING" | "SAVED" | "LOCAL_ONLY" | "CONFLICT";

export type PlannerSyncConflict = {
  cloud: PlannerCloudSnapshot;
  open: boolean;
};

function isConflictError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    (error as { data?: { code?: unknown } }).data?.code === "CONFLICT"
  );
}

export function usePlannerStateSync({
  userId,
  localReady,
  payload,
  replaceLocal,
}: {
  userId: string | null;
  localReady: boolean;
  payload: PlannerStatePayload;
  replaceLocal: (payload: PlannerStatePayload) => void;
}) {
  const [status, setStatus] = useState<PlannerSyncStatus>(
    userId ? "LOADING" : "LOCAL",
  );
  const [conflict, setConflict] = useState<PlannerSyncConflict | null>(null);
  const reconciledUserRef = useRef<string | null>(null);
  const lastSyncedRef = useRef<PlannerSyncMarker | null>(null);
  const payloadRef = useRef(payload);
  const replaceLocalRef = useRef(replaceLocal);
  payloadRef.current = payload;
  replaceLocalRef.current = replaceLocal;

  const cloudQuery = api.plannerState.get.useQuery(undefined, {
    enabled: Boolean(userId && localReady),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const saveMutation = api.plannerState.save.useMutation();

  async function rememberSnapshot(
    activeUserId: string,
    snapshot: PlannerCloudSnapshot,
  ) {
    const marker = {
      version: 1,
      userId: activeUserId,
      revision: snapshot.revision,
      payloadHash: await hashPlannerState(snapshot.payload),
    } as const;
    savePlannerSyncMarker(window.localStorage, marker);
    lastSyncedRef.current = marker;
  }

  async function showLatestConflict() {
    try {
      const result = await cloudQuery.refetch();
      if (result.isError || !result.data) {
        setStatus("LOCAL_ONLY");
        return;
      }
      setConflict({ cloud: result.data, open: true });
      setStatus("CONFLICT");
    } catch {
      setStatus("LOCAL_ONLY");
    }
  }

  async function saveCloud(
    activeUserId: string,
    localPayload: PlannerStatePayload,
    expectedRevision: number | null,
  ) {
    setStatus("SAVING");
    try {
      const saved = await saveMutation.mutateAsync({
        payload: localPayload,
        expectedRevision,
      });
      await rememberSnapshot(activeUserId, saved);
      setConflict(null);
      setStatus("SAVED");
    } catch (error) {
      if (isConflictError(error)) {
        await showLatestConflict();
      } else {
        setStatus("LOCAL_ONLY");
      }
    }
  }
  const saveCloudRef = useRef(saveCloud);
  saveCloudRef.current = saveCloud;

  useEffect(() => {
    if (!userId) {
      reconciledUserRef.current = null;
      lastSyncedRef.current = null;
      setConflict(null);
      setStatus("LOCAL");
      return;
    }
    if (!localReady || !cloudQuery.isSuccess) {
      if (cloudQuery.isError) setStatus("LOCAL_ONLY");
      else setStatus("LOADING");
      return;
    }
    if (reconciledUserRef.current === userId) return;
    reconciledUserRef.current = userId;

    let cancelled = false;
    void (async () => {
      const localPayload = payloadRef.current;
      const cloud = cloudQuery.data;
      const localHash = await hashPlannerState(localPayload);
      const cloudHash = cloud ? await hashPlannerState(cloud.payload) : null;
      const marker = loadPlannerSyncMarker(window.localStorage, userId);
      if (cancelled) return;
      lastSyncedRef.current = marker;

      const decision = reconcilePlannerCopies({
        localMeaningful: hasMeaningfulPlannerData(localPayload),
        localHash,
        cloud,
        cloudHash,
        marker,
      });

      if (decision.action === "IDLE") {
        setStatus("SAVED");
      } else if (decision.action === "ACCEPT_CLOUD") {
        if (cloud) await rememberSnapshot(userId, cloud);
        if (!cancelled) setStatus("SAVED");
      } else if (decision.action === "USE_CLOUD") {
        if (!cloud) return;
        replaceLocalRef.current(cloud.payload);
        await rememberSnapshot(userId, cloud);
        if (!cancelled) setStatus("SAVED");
      } else if (decision.action === "UPLOAD") {
        await saveCloudRef.current(
          userId,
          localPayload,
          decision.expectedRevision,
        );
      } else if (cloud) {
        setConflict({ cloud, open: true });
        setStatus("CONFLICT");
      }
    })().catch(() => {
      if (!cancelled) setStatus("LOCAL_ONLY");
    });

    return () => {
      cancelled = true;
    };
  }, [
    cloudQuery.data,
    cloudQuery.dataUpdatedAt,
    cloudQuery.isError,
    cloudQuery.isSuccess,
    localReady,
    userId,
  ]);

  useEffect(() => {
    if (!userId || !localReady || status !== "SAVED") return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const localPayload = payloadRef.current;
        const localHash = await hashPlannerState(localPayload);
        const marker = lastSyncedRef.current;
        if (marker?.payloadHash === localHash) return;
        if (!marker && !hasMeaningfulPlannerData(localPayload)) return;
        await saveCloudRef.current(
          userId,
          localPayload,
          marker?.revision ?? null,
        );
      })().catch(() => {
        if (!cancelled) setStatus("LOCAL_ONLY");
      });
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [localReady, payload, status, userId]);

  async function keepCloudCopy() {
    if (!userId || !conflict) return;
    try {
      replaceLocalRef.current(conflict.cloud.payload);
      await rememberSnapshot(userId, conflict.cloud);
      setConflict(null);
      setStatus("SAVED");
    } catch {
      setStatus("LOCAL_ONLY");
    }
  }

  async function keepDeviceCopy() {
    if (!userId || !conflict) return;
    await saveCloud(userId, payloadRef.current, conflict.cloud.revision);
  }

  return {
    status,
    conflict,
    dismissConflict: () =>
      setConflict((current) => (current ? { ...current, open: false } : null)),
    openConflict: () =>
      setConflict((current) => (current ? { ...current, open: true } : null)),
    keepCloudCopy,
    keepDeviceCopy,
  };
}
