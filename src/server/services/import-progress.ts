import { randomUUID } from "node:crypto";
import { IMPORT_EXECUTION_LIMITS } from "~/shared/global-reconciliation-config";

type Stage =
  | "jp_fandom"
  | "atlas_global"
  | "publisher_download"
  | "publisher_matching"
  | "publisher_assessments"
  | "official_family";
type Counters = {
  attempt?: number;
  index?: number;
  total?: number;
  timeoutMs?: number;
  inserted?: number;
  publishedCount?: number;
  publicationFailures?: number;
};

export function importFailureCategory(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "P2028") {
    if (/start a transaction|acquir|queue|unable to start/i.test(message))
      return "TRANSACTION_ACQUISITION";
    if (/expired|timeout|timed out/i.test(message))
      return "TRANSACTION_EXPIRED";
    return "TRANSACTION_ERROR";
  }
  if (code === "P2034") return "TRANSACTION_CONFLICT";
  if (typeof code === "string" && /^P\d{4}$/.test(code))
    return "DATABASE_ERROR";
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return "ACCESS_DENIED";
  if (error instanceof Error && /^(AbortError|TimeoutError)$/.test(error.name))
    return "SOURCE_TIMEOUT";
  return "IMPORT_ERROR";
}

export function createImportProgress() {
  const runId = randomUUID();
  const startedAt = Date.now();
  const emit = (
    stage: Stage,
    state: string,
    elapsedMs: number,
    counters: Counters,
    error?: unknown,
  ) => {
    const entry = {
      event: "import_progress",
      runId,
      stage,
      state,
      elapsedMs,
      runElapsedMs: Date.now() - startedAt,
      ...counters,
      ...(error === undefined
        ? {}
        : { category: importFailureCategory(error) }),
    };
    (state === "failed" ? console.warn : console.info)(JSON.stringify(entry));
  };
  return {
    runId,
    event(
      stage: Stage,
      state: "transaction_acquired" | "retry",
      counters: Counters = {},
    ) {
      emit(stage, state, 0, counters);
    },
    async stage<T>(
      stage: Stage,
      work: () => Promise<T>,
      counters: Counters = {},
    ): Promise<T> {
      const start = Date.now();
      emit(stage, "started", 0, counters);
      const timer = setInterval(
        () => emit(stage, "running", Date.now() - start, counters),
        IMPORT_EXECUTION_LIMITS.heartbeatMs,
      );
      timer.unref();
      try {
        const result = await work();
        emit(stage, "completed", Date.now() - start, counters);
        return result;
      } catch (error) {
        emit(stage, "failed", Date.now() - start, counters, error);
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  };
}

export type ImportProgress = ReturnType<typeof createImportProgress>;
