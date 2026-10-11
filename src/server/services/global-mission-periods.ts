import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import {
  GLOBAL_ANNOUNCEMENT_LIMITS as LIMITS,
  GLOBAL_CAMPAIGN_IDENTITY_LIMITS as IDENTITY,
} from "~/shared/global-reconciliation-config";
import { parsePublisherAnnouncement } from "./global-announcement-parser";

type Node = DefaultTreeAdapterMap["node"];
const skipped = new Set(["script", "style", "template", "noscript"]);
export const officialMissionRowSchema = z
  .object({
    label: z.string().min(1).max(LIMITS.maxContextCharacters),
    missionPeriod: z.string().min(1).max(LIMITS.maxContextCharacters),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    rewards: z
      .array(
        z.object({
          itemType: z.enum([
            "SAINT_QUARTZ",
            "SUMMON_TICKET",
            "SAINT_QUARTZ_FRAGMENT",
            "MANA_PRISM",
            "HOLY_GRAIL",
            "CRYSTALLIZED_LORE",
          ]),
          amount: z.number().int().positive().safe(),
        }),
      )
      .min(1)
      .max(LIMITS.maxPeriodsPerArticle),
  })
  .strict();
export type OfficialMissionRow = z.infer<typeof officialMissionRowSchema>;

function walk(root: Node, stopTables = false) {
  const stack = [root],
    nodes: Node[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if (skipped.has(node.nodeName)) continue;
    nodes.push(node);
    if (nodes.length > LIMITS.maxTreeNodes)
      throw new Error("The mission table exceeds the parser limit.");
    if (stopTables && node !== root && node.nodeName === "table") continue;
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
  }
  return nodes;
}
function attribute(node: Node, name: string) {
  return "attrs" in node
    ? node.attrs.find((attr) => attr.name === name)?.value
    : undefined;
}
function text(root: Node) {
  return walk(root)
    .flatMap((node) =>
      node.nodeName === "#text" && "value" in node
        ? [node.value]
        : ["br", "p", "div"].includes(node.nodeName)
          ? ["\n"]
          : [],
    )
    .join(" ")
    .replace(/[ \t]+/gu, " ")
    .trim();
}
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function trackedMissionRewards(value: string) {
  const rewards: OfficialMissionRow["rewards"] = [];
  const names = [
    ["SAINT_QUARTZ_FRAGMENT", "Saint Quartz Fragments?"],
    ["SAINT_QUARTZ", "Saint Quartz(?! Fragment)"],
    ["SUMMON_TICKET", "Summon Tickets?"],
    ["MANA_PRISM", "Mana Prisms?"],
    ["HOLY_GRAIL", "Holy Grails?"],
    ["CRYSTALLIZED_LORE", "Crystalli[sz]ed Lores?"],
  ] as const;
  for (const [itemType, name] of names) {
    const matches = [
      ...value.matchAll(new RegExp(`${name}\\s*[x×]\\s*(\\d+)\\b`, "giu")),
    ];
    if (!matches.length) continue;
    const amount = matches.reduce((sum, match) => sum + Number(match[1]), 0);
    if (!Number.isSafeInteger(amount) || amount < 1) return [];
    rewards.push({ itemType, amount });
  }
  return rewards.sort((a, b) => a.itemType.localeCompare(b.itemType));
}

// Only labelled mission tables qualify. A shared Period cell belongs to its
// explicit rowspan, never the next row or an article-wide claim deadline.
export function parseOfficialMissionRows(
  body: string,
  url: string,
): OfficialMissionRow[] {
  if (Buffer.byteLength(body) > LIMITS.maxBodyBytes)
    throw new Error("The mission source exceeds the body limit.");
  const article = walk(parse(body)).find((node) =>
    attribute(node, "class")?.split(/\s+/u).includes("article"),
  );
  if (!article) return [];
  const result: OfficialMissionRow[] = [];
  for (const table of walk(article).filter(
    (node) => node.nodeName === "table",
  )) {
    let columns: { mission: number; rewards: number; period: number } | null =
      null;
    const carried = new Map<number, { node: Node; remaining: number }>();
    const rows = walk(table, true).filter((node) => node.nodeName === "tr");
    for (const row of rows) {
      const cells: Node[] = [];
      for (const [index, entry] of carried) {
        cells[index] = entry.node;
        if (--entry.remaining === 0) carried.delete(index);
      }
      let index = 0;
      for (const cell of "childNodes" in row
        ? row.childNodes.filter((n) => ["td", "th"].includes(n.nodeName))
        : []) {
        while (cells[index]) index++;
        if (
          index >= IDENTITY.maxMissionTableColumns ||
          (attribute(cell, "colspan") ?? "1") !== "1"
        ) {
          columns = null;
          break;
        }
        const spanText = attribute(cell, "rowspan") ?? "1";
        const span = /^\d+$/u.test(spanText) ? Number(spanText) : NaN;
        if (
          !Number.isSafeInteger(span) ||
          span < 1 ||
          span > LIMITS.maxPeriodsPerArticle
        ) {
          columns = null;
          break;
        }
        cells[index] = cell;
        if (span > 1) carried.set(index, { node: cell, remaining: span - 1 });
        index++;
      }
      const values = cells.map(text);
      if (!columns) {
        const headings = values.map((value) =>
          value.toLowerCase().replace(/\s+/gu, " ").trim(),
        );
        const mission = headings.findIndex((value) =>
          /^(?:mission|mission name)$/u.test(value),
        );
        const rewards = headings.findIndex((value) =>
          /^(?:mission rewards?|rewards?)$/u.test(value),
        );
        const period = headings.findIndex((value) => value === "period");
        if ([mission, rewards, period].every((value) => value >= 0))
          columns = { mission, rewards, period };
        continue;
      }
      const label = values[columns.mission],
        rewardText = values[columns.rewards],
        periodText = values[columns.period];
      if (!label || !rewardText || !periodText) continue;
      const mission =
        /(?:^|\n)\s*Mission Period\s*:\s*([^]*?)(?=Rewards Claimable Period\s*:|$)/iu
          .exec(periodText)?.[1]
          ?.trim();
      if (!mission) continue;
      const parsed = parsePublisherAnnouncement(
        `<div class="article"><p>Event Period: ${escape(mission)}</p></div>`,
        url,
        new Date(0),
      );
      const period = parsed.periods.length === 1 ? parsed.periods[0] : null;
      const candidate = officialMissionRowSchema.safeParse({
        label,
        missionPeriod: mission,
        startsAt: period?.startsAt,
        endsAt: period?.endsAt,
        rewards: trackedMissionRewards(rewardText),
      });
      if (!candidate.success || !period || period.issues.length) continue;
      result.push(candidate.data);
      if (result.length > LIMITS.maxPeriodsPerArticle)
        throw new Error("The article contains too many mission rows.");
    }
  }
  return result;
}

const roman: Record<string, number> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};
export function normaliseMissionName(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /\b(part|call|chapter)\s+([ivxlcdm]+)\b/giu,
      (_, prefix: string, digits: string) => {
        const numbers = [...digits.toUpperCase()].map((digit) => roman[digit]!);
        const number = numbers.reduce(
          (sum, digit, index) =>
            sum + (digit < (numbers[index + 1] ?? 0) ? -digit : digit),
          0,
        );
        return `${prefix} ${number}`;
      },
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function missionSignature(label: string, chapterName: string) {
  const tag = /^\s*(?:\[([^\]]+)\]|【([^】]+)】)/u.exec(label);
  if (!tag) return null;
  const scope = normaliseMissionName(tag[1] ?? tag[2]!);
  const chapter = normaliseMissionName(chapterName.split(":")[0]!);
  if (!chapter || !scope.startsWith(`${chapter} `)) return null;
  const part = /\bpart (\d+)\b/u.exec(scope)?.[1];
  if (!part) return null;
  const body = normaliseMissionName(label.slice(tag[0].length));
  const subtitle = normaliseMissionName(chapterName.split(",").at(-1)!);
  const identifiesChapter =
    body.includes(chapter) ||
    (subtitle.length >= IDENTITY.minMissionSubtitleCharacters &&
      body.includes(subtitle));
  const progress =
    /^(?:clear|complete) (\d+) (?:arrows?|main quest progress nodes?)\b/u.exec(
      body,
    );
  if (progress) {
    const upTo = /\bup to part (\d+)\b/u.exec(body)?.[1];
    if (
      !identifiesChapter ||
      (upTo !== undefined && upTo !== part) ||
      !/\b(?:arc|part) 1\b/u.test(body) ||
      !/\b(?:arc|part) 2\b/u.test(body) ||
      !/\bprologue\b/u.test(body)
    )
      return null;
    const count = Number(progress[1]);
    if (!Number.isSafeInteger(count) || count < 1) return null;
    return `part:${part}:main-quest-progress:${count}`;
  }
  const full = normaliseMissionName(chapterName);
  if (
    /^clear\b/u.test(body) &&
    /\bpart (\d+)\b/u.exec(body)?.[1] === part &&
    (body.includes(full) ||
      (subtitle.length >= IDENTITY.minMissionSubtitleCharacters &&
        body.includes(subtitle)))
  )
    return `part:${part}:chapter-clear`;
  return null;
}
