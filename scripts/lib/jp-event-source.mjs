import { readFile } from "node:fs/promises";

import {
  ATLAS_JP_EVENT_EXPORT_URL,
  parseAtlasEventExport,
} from "./jp-event-sync.mjs";

/**
 * @param {string | undefined} value
 * @param {{name: string, defaultValue: number, allowZero?: boolean}} options
 */
export function parseIntegerSetting(value, options) {
  const parsed = value === undefined ? options.defaultValue : Number(value);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `${options.name} must be ${options.allowZero ? "a non-negative" : "a positive"} integer.`,
    );
  }
  return parsed;
}

/**
 * @param {string} url
 * @param {{
 *   attempts?: number,
 *   fetchFn?: (url: string, init: Record<string, any>) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>,
 *   delayFn?: (milliseconds: number) => Promise<void>,
 *   timeoutSignal?: () => AbortSignal | undefined
 * }} [options]
 */
export async function fetchTextWithRetry(url, options = {}) {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("Retry attempts must be a positive integer.");
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const delayFn =
    options.delayFn ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutSignal =
    options.timeoutSignal ?? (() => AbortSignal.timeout(60_000));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: timeoutSignal(),
      });
      if (!response.ok) {
        throw new Error(`Atlas returned HTTP ${response.status}.`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delayFn(attempt * 1_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Atlas retrieval failed: ${String(lastError)}`);
}

/** @param {string} body @param {number} minimumRecords */
export function parseAndValidateAtlasSource(body, minimumRecords) {
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("Atlas returned invalid JSON.", { cause: error });
  }

  const events = parseAtlasEventExport(value);
  if (events.length < minimumRecords) {
    throw new Error(
      `Atlas returned ${events.length} events. The safety minimum is ${minimumRecords}.`,
    );
  }

  const ids = new Set();
  for (const event of events) {
    if (ids.has(event.id)) {
      throw new Error(`Atlas returned a duplicate event id: ${event.id}.`);
    }
    ids.add(event.id);
  }
  return events;
}

/**
 * @param {{sourceFile: string | null}} options
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchFn?: (url: string, init: Record<string, any>) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>,
 *   readFileFn?: (path: string, encoding: "utf8") => Promise<string>,
 *   delayFn?: (milliseconds: number) => Promise<void>,
 *   timeoutSignal?: () => AbortSignal | undefined
 * }} [dependencies]
 */
export async function loadJpEventSource(options, dependencies = {}) {
  if (options.sourceFile) {
    return (dependencies.readFileFn ?? readFile)(options.sourceFile, "utf8");
  }

  const env = dependencies.env ?? process.env;
  const url = env.ATLAS_JP_EVENT_EXPORT_URL?.trim();
  return fetchTextWithRetry(url || ATLAS_JP_EVENT_EXPORT_URL, dependencies);
}
