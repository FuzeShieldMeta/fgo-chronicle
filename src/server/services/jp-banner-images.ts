import { createHash } from "node:crypto";

export const JP_BANNER_IMAGE_LIMITS = {
  maxInspections: 10,
  maxBytes: 8 * 1_024 * 1_024,
  maxPixels: 16_000_000,
  maxDimension: 8_192,
  requestTimeoutMs: 10_000,
} as const;

export function jpBannerImageUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== "https://news.fate-go.jp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/wp-content/uploads/") ||
    !/\.(png|jpe?g|gif|webp)$/iu.test(url.pathname)
  )
    throw new Error("Unsupported JP image URL.");
  return url.href;
}

/** Download original evidence only. No resizing, OCR, model request or storage write. */
export async function inspectJpBannerImage(
  sourceUrl: string,
  fetchFn: typeof fetch = fetch,
  parentSignal?: AbortSignal,
) {
  const url = jpBannerImageUrl(sourceUrl);
  const timeout = AbortSignal.timeout(JP_BANNER_IMAGE_LIMITS.requestTimeoutMs);
  const signal = parentSignal
    ? AbortSignal.any([timeout, parentSignal])
    : timeout;
  signal.throwIfAborted();
  const response = await fetchFn(url, {
    signal,
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
  });
  const mime = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const formats: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  const length = Number(response.headers.get("content-length") ?? 0);
  if (
    response.status !== 200 ||
    response.redirected ||
    !response.body ||
    !mime ||
    !formats[mime] ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > JP_BANNER_IMAGE_LIMITS.maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Unsupported JP image response.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > JP_BANNER_IMAGE_LIMITS.maxBytes)
        throw new Error("JP image size limit exceeded.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const original = Buffer.concat(chunks);
  signal.throwIfAborted();
  const { default: sharp } = await import("sharp");
  const image = sharp(original, {
    limitInputPixels: JP_BANNER_IMAGE_LIMITS.maxPixels,
    failOn: "warning",
  });
  const metadata = await image.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.format !== formats[mime] ||
    metadata.width > JP_BANNER_IMAGE_LIMITS.maxDimension ||
    metadata.height > JP_BANNER_IMAGE_LIMITS.maxDimension ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error("Unsupported JP schedule image.");
  // Force decoding: a valid header alone does not establish intact evidence.
  await image.stats();
  signal.throwIfAborted();
  return {
    url,
    contentHash: createHash("sha256").update(original).digest("hex"),
    bytes,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  };
}

export function jpBannerImageEvidence(
  articleHash: string,
  references: readonly { url: string }[],
  results: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof inspectJpBannerImage>> | null
  >,
) {
  const images = [...new Set(references.map((reference) => reference.url))]
    .sort()
    .map((url) => {
      const result = results.get(url);
      return result
        ? { url, status: "INSPECTED" as const, evidence: result }
        : {
            url,
            status: results.has(url)
              ? ("FAILED" as const)
              : ("NOT_INSPECTED" as const),
            evidence: null,
          };
    });
  const candidateReadsComplete =
    images.length > 0 && images.every((image) => image.status === "INSPECTED");
  return {
    scope: "LABELLED_SCHEDULE_IMAGE_REFERENCES" as const,
    candidateReadsComplete,
    // Order/context duplicates are irrelevant; original content changes are not.
    evidenceFingerprint: candidateReadsComplete
      ? createHash("sha256")
          .update(
            JSON.stringify([
              articleHash,
              images.map((image) => [image.url, image.evidence.contentHash]),
            ]),
          )
          .digest("hex")
      : null,
    images,
    interpretation: "UNINTERPRETED" as const,
    publicationAllowed: false as const,
  };
}
