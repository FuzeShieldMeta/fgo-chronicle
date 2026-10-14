import { createHash } from "node:crypto";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import {
  servantAssets,
  isServantThumbnailPath,
} from "../../shared/servant-assets-config.mjs";
import {
  servantThumbnailBucket,
  storedServantThumbnailUrl,
  servantStorageOrigin,
} from "./servant-storage-config.mjs";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export async function readServantPng(response: Response) {
  if (!response.ok || !response.body)
    throw new Error("Thumbnail download failed.");
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > servantAssets.maxBytes) {
    await response.body.cancel();
    throw new Error("Thumbnail exceeds the byte limit.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > servantAssets.maxBytes)
        throw new Error("Thumbnail exceeds the byte limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new Error("Invalid servant PNG.");
  const image = sharp(bytes, {
    limitInputPixels: servantAssets.maxDimension ** 2,
  });
  const metadata = await image.metadata();
  if (
    metadata.format !== "png" ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > servantAssets.maxDimension ||
    metadata.height > servantAssets.maxDimension ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error("Invalid servant PNG.");
  // Decode as well as inspect the header, so corrupt/truncated files cannot be published.
  await image.raw().toBuffer();
  return bytes;
}

export async function downloadServantFace(faceId: number, fetcher = fetch) {
  if (!Number.isSafeInteger(faceId) || faceId <= 0)
    throw new Error("Invalid face ID.");
  return readServantPng(
    await fetcher(`https://static.atlasacademy.io/JP/Faces/f_${faceId}.png`, {
      redirect: "error",
      signal: AbortSignal.timeout(servantAssets.timeoutMs),
    }),
  );
}

export type ServantImageStore = {
  prepare?: () => Promise<void>;
  upload: (path: string, bytes: Buffer) => Promise<{ reused: boolean }>;
};

// This module belongs only to server services; clients receive public URLs, never this key.
export function createServantImageStore(
  settings: {
    SUPABASE_URL?: string;
    SUPABASE_SECRET_KEY?: string;
  } = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  },
): ServantImageStore | null {
  if (!settings.SUPABASE_URL || !settings.SUPABASE_SECRET_KEY) return null;
  const origin = servantStorageOrigin(settings.SUPABASE_URL)!;
  const timedFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(servantAssets.timeoutMs),
    });
  const client = createClient(origin, settings.SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: timedFetch },
  });
  const bucket = client.storage.from(servantThumbnailBucket);
  let ready: Promise<void> | undefined;
  const prepare = () =>
    (ready ??= (async () => {
      const { data, error } = await client.storage.getBucket(
        servantThumbnailBucket,
      );
      if (error || !data?.public)
        throw new Error("Public thumbnail bucket is unavailable.");
    })());
  return {
    prepare,
    async upload(path, bytes) {
      if (!isServantThumbnailPath(path))
        throw new Error("Invalid thumbnail object path.");
      await prepare();
      const { error } = await bucket.upload(path, bytes, {
        contentType: "image/png",
        cacheControl: String(servantAssets.cacheSeconds),
        upsert: false,
      });
      if (!error) return { reused: false };
      if (
        !("statusCode" in error) ||
        !["409", "400"].includes(String(error.statusCode))
      )
        throw new Error("Thumbnail Storage upload failed.");
      // A retry may find the object left by an earlier successful upload. Verify it.
      const existing = await readServantPng(
        await timedFetch(
          storedServantThumbnailUrl(origin, path)!,
        ),
      );
      if (!existing.equals(bytes))
        throw new Error("Existing thumbnail object does not match.");
      return { reused: true };
    },
  };
}

export function servantImagePath(faceId: number, bytes: Buffer) {
  return `faces/${faceId}/${createHash("sha256").update(bytes).digest("hex")}.png`;
}
