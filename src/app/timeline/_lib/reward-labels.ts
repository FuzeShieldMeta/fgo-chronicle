import servants from "~/data/atlas-servant-names.json";
import chapters from "~/data/story-chapters.json";

const servantNames: Record<string, string> = servants.names;
const normalise = (value: string) => value.replace(/\s+/g, " ").trim();

export function englishRewardLabel(original: string): string {
  const rankUp = /^強化クエスト\s+(.+?)(?:\s+(\d+))?$/.exec(original);
  if (rankUp) {
    const name = servantNames[rankUp[1] ?? ""];
    if (name)
      return `${name} — Rank Up Quest${rankUp[2] ? ` ${rankUp[2]}` : ""}`;
  }
  const section = /^『(.+)』の「第(\d+)節」をクリアせよ$/.exec(
    normalise(original),
  );
  if (section) {
    const chapter = chapters.find(
      (chapter) => normalise(chapter.originalName) === section[1],
    );
    if (chapter) return `Clear section ${section[2]} of ${chapter.name}.`;
  }
  const story = /^『(.+)』をクリアせよ$/.exec(normalise(original));
  if (story) {
    const chapter = chapters.find(
      (chapter) => normalise(chapter.originalName) === story[1],
    );
    if (chapter) return `Clear ${chapter.name}.`;
  }
  const clearQuest = /^Clear (.+)\.$/.exec(original);
  if (clearQuest) {
    const translated = englishRewardLabel(clearQuest[1]!);
    if (translated !== clearQuest[1]) return `Complete ${translated}.`;
  }
  return original;
}
