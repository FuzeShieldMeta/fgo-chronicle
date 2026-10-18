import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS,
  MAINTENANCE_SOURCE_LIMITS as MAINTENANCE,
  GLOBAL_CAMPAIGN_IDENTITY_LIMITS,
} from "~/shared/global-reconciliation-config";
import { parsePublisherAnnouncement } from "./global-announcement-parser";

type Node = DefaultTreeAdapterMap["node"];
export type MaintenanceNotice = {
  region: "JP" | "NA";
  url: string;
  contentHash: string;
  startsAt: string;
  endsAt: string;
  distributionStartsAt: string;
  amount: number;
  recipients: string;
  launchNames: string[];
};

function walk(root: Node) {
  const nodes: Node[] = [],
    stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (["script", "style", "template", "noscript"].includes(node.nodeName))
      continue;
    nodes.push(node);
    if (nodes.length > LIMITS.maxTreeNodes)
      throw Error("Maintenance document exceeds the node limit.");
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
  }
  return nodes;
}
function text(root: Node) {
  return walk(root)
    .flatMap((n) => (n.nodeName === "#text" && "value" in n ? [n.value] : []))
    .join(" ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}
function attr(node: Node, name: string) {
  return "attrs" in node
    ? node.attrs.find((a) => a.name === name)?.value
    : undefined;
}
export function jpMaintenanceUrl(value: string) {
  const url = new URL(value, "https://news.fate-go.jp");
  if (
    url.origin !== "https://news.fate-go.jp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.length > LIMITS.maxArticlePathCharacters ||
    !/^\/(?:maintenance\/(?:page\/[1-9]\d*\/)?)$|^\/20\d{2}\/(?:\d{2}\/)?[a-zA-Z0-9_-]+\/$/.test(
      url.pathname,
    )
  )
    throw Error("Unsupported JP maintenance source URL.");
  return url.href;
}
export function jpMaintenanceLinks(body: string, sourceUrl: string) {
  jpMaintenanceUrl(sourceUrl);
  return [
    ...new Set(
      walk(parse(body)).flatMap((node) => {
        if (node.nodeName !== "a") return [];
        // Archive cards use an empty overlay anchor with a sibling title.
        const label =
          "parentNode" in node && node.parentNode?.nodeName === "li"
            ? node.parentNode
            : node;
        if (!text(label).includes("メンテナンス終了")) return [];
        try {
          const url = jpMaintenanceUrl(
            new URL(attr(node, "href") ?? "", sourceUrl).href,
          );
          return /\/20\d{2}\//.test(url) ? [url] : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}
function jst(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
) {
  const jstOffsetMs = GLOBAL_CAMPAIGN_IDENTITY_LIMITS.jstOffsetMinutes * 60_000;
  const value = new Date(
    Date.UTC(year, month - 1, day, hour, minute) - jstOffsetMs,
  );
  const local = new Date(value.getTime() + jstOffsetMs);
  return local.getUTCFullYear() === year &&
    local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day &&
    local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute
    ? value.toISOString()
    : null;
}
export function parseMaintenanceNotice(
  body: string,
  url: string,
  region: "JP" | "NA",
): MaintenanceNotice | null {
  if (Buffer.byteLength(body) > LIMITS.maxBodyBytes)
    throw Error("Maintenance document exceeds the body limit.");
  if (region === "JP") jpMaintenanceUrl(url);
  const nodes = walk(parse(body));
  const title = text(nodes.find((n) => n.nodeName === "title") ?? parse(""));
  if (
    region === "JP"
      ? !title.includes("メンテナンス終了") || /臨時|緊急/.test(title)
      : !/Scheduled Maintenance Completion Notice/i.test(title) ||
        /Unscheduled/i.test(title)
  )
    return null;
  const value = text(parse(body));
  let startsAt: string | null = null,
    endsAt: string | null = null,
    distributionStartsAt: string | null = null,
    recipients = "",
    reward = "",
    launchText = "";
  if (region === "JP") {
    const time =
      /日時\s*(20\d{2})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})\s*[~〜～]\s*(\d{1,2}):(\d{2})/.exec(
        value,
      );
    if (!time) return null;
    const [, y, m, d, h, min, eh, em] = time;
    startsAt = jst(+y!, +m!, +d!, +h!, +min!);
    endsAt = jst(+y!, +m!, +d!, +eh!, +em!);
    const apology = value.split("メンテナンスのお詫び").at(-1) ?? "";
    recipients = /【対象】\s*([^]*?)\s*【対応内容】/.exec(apology)?.[1] ?? "";
    reward = /【対応内容】\s*([^]*?)\s*【配布方法】/.exec(apology)?.[1] ?? "";
    launchText =
      value
        .split(/▼ゲームの更新/)[1]
        ?.split(/▼ゲームの改修|▼不具合|メンテナンスのお詫び/)[0] ?? "";
    // Placement is intentionally the event opening, not the JP collection deadline.
    distributionStartsAt = endsAt;
  } else {
    const article = parsePublisherAnnouncement(body, url, new Date());
    const period = article.periods.find((p) => /Date & Time/i.test(p.context));
    // The general announcement parser does not classify maintenance as an
    // event. Its context warning is expected here; date/time warnings are not.
    if (
      !period?.startsAt ||
      !period.endsAt ||
      period.issues.some((issue) => issue !== "UNRESOLVED_PERIOD_CONTEXT")
    )
      return null;
    startsAt = period.startsAt;
    endsAt = period.endsAt;
    recipients =
      /Applies to:\s*([^]*?)\s*(?:Compensation )?Details:/i.exec(value)?.[1] ??
      "";
    reward =
      /(?:Compensation )?Details:\s*([^]*?)\s*Distribution Method:/i.exec(
        value,
      )?.[1] ?? "";
    const distribution =
      /Distribution Period:\s*([^]*?)(?:We sincerely|Thank you|$)/i.exec(
        value,
      )?.[1] ?? "";
    if (/^After maintenance\b/i.test(distribution))
      distributionStartsAt = endsAt;
    else {
      const candidate = article.periods.find((p) =>
        /Distribution Period/i.test(p.context),
      );
      if (candidate?.issues.length === 0)
        distributionStartsAt = candidate.startsAt;
    }
    launchText =
      value
        .split(/\*?\s*Contents\s*/i)[1]
        ?.split(/Improvements:|Bug Fixes:|As an apology/i)[0] ?? "";
  }
  const amounts = [
    ...reward.matchAll(
      region === "JP"
        ? /聖晶石\s*(\d+)個/g
        : /Saint Quartz(?! Fragment)\s*[x×]\s*(\d+)\b/gi,
    ),
  ];
  if (
    amounts.length !== 1 ||
    !startsAt ||
    !endsAt ||
    !distributionStartsAt ||
    Date.parse(endsAt) <= Date.parse(startsAt) ||
    !recipients ||
    recipients.length > LIMITS.maxContextCharacters
  )
    return null;
  const amount = Number(amounts[0]![1]);
  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > MAINTENANCE.maxQuartz
  )
    return null;
  const launchNames =
    region === "JP"
      ? [...launchText.matchAll(/「([^」]+)」の(?:開始|開幕|開催)/g)].map(
          (m) => m[1]!,
        )
      : [...launchText.matchAll(/Commencement of\s*"([^"]+)"/gi)].map(
          (m) => m[1]!,
        );
  if (!launchNames.length) return null;
  return {
    region,
    url,
    contentHash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    startsAt,
    endsAt,
    distributionStartsAt,
    amount,
    recipients,
    launchNames: [...new Set(launchNames)],
  };
}

export async function fetchJpMaintenanceHtml(
  url: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const checked = jpMaintenanceUrl(url);
  const response = await fetchFn(checked, {
    redirect: "manual",
    credentials: "omit",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(LIMITS.fetchTimeoutMs)])
      : AbortSignal.timeout(LIMITS.fetchTimeoutMs),
  });
  if (
    !response.ok ||
    response.redirected ||
    !response.headers.get("content-type")?.startsWith("text/html") ||
    !response.body
  )
    throw Error("Unsupported JP maintenance response.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    body = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > LIMITS.maxBodyBytes)
        throw Error("Maintenance document exceeds the body limit.");
      body += decoder.decode(part.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
