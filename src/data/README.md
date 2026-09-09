Story and servant display names

The event schedule pipeline discovers canonical main-story wars from the Atlas JP war export, stores them in `StoryChapter`, and maps explicit quest-clear Master Missions to their parent story. The timeline reads that catalogue for its selector and reward decisions. Folders and shortcut duplicates are excluded. Section missions belong to the enclosing story. Unsupported conditions remain manual.

`story-chapters.json` supplies reviewed English display labels and a bootstrap catalogue before the first sync. New stories do not need an entry here: they use their source name until an English label is reviewed. Known identities must still match. Source ordering defines main-story progress; optional stories require separate selections. Existing database identities, ordering and optional status cannot change without review. Missing final-quest details are reported; only an explicit final-quest ID can be mapped in that case.

Source: https://api.atlasacademy.io/export/JP/nice_war_lang_en.json

`atlas-servant-names.json` contains unambiguous English names for playable servants. Regenerate it with `node scripts/refresh-servant-display-names.mjs <downloaded-export.json>`, using the source URL stored in that file. Unknown names retain the source text. Display labels never change reward amounts, dates or curator review status.
