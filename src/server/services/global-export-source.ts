import { GLOBAL_EXPORT_LIMITS } from "~/shared/global-reconciliation-config";
import {
  GLOBAL_EVENT_EXPORTS,
  loadGlobalEventExport,
} from "../../../scripts/lib/global-event-candidates.mjs";

export function boundedGlobalExportLoader(
  dependencies: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    maxBodyBytes?: number;
  } = {},
): typeof loadGlobalEventExport {
  const signal =
    dependencies.signal ??
    AbortSignal.timeout(GLOBAL_EXPORT_LIMITS.collectionTimeoutMs);
  const maximum =
    dependencies.maxBodyBytes ?? GLOBAL_EXPORT_LIMITS.maxBodyBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new RangeError("The export size limit must be positive.");
  const fetchFn: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!Object.values(GLOBAL_EVENT_EXPORTS).includes(url))
      throw new Error("Unsupported Global export URL.");
    signal.throwIfAborted();
    const response = await (dependencies.fetchFn ?? fetch)(url, {
      ...init,
      signal,
      redirect: "manual",
      credentials: "omit",
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (
      !response.ok ||
      response.redirected ||
      !response.body ||
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > maximum
    ) {
      await response.body?.cancel();
      throw new Error("Atlas returned an unsupported export response.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximum)
          throw new Error("The Atlas export exceeds the size limit.");
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return new Response(chunks.join(""), {
      headers: { "content-type": "application/json" },
    });
  };
  return (region, options = {}) => {
    if (options.sourceFile)
      throw new Error(
        "File inputs are not supported by the scheduled collector.",
      );
    return loadGlobalEventExport(region, options, { fetchFn });
  };
}
