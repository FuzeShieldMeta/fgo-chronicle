/**
 * Extract balanced MediaWiki templates by name. Nested templates are retained
 * in each template body.
 * @param {string} wikitext
 * @param {string} expectedName
 */
export function extractTemplates(wikitext, expectedName) {
  const results = [];
  const expected = expectedName.trim().toLowerCase();

  for (let index = 0; index < wikitext.length - 1; index += 1) {
    if (wikitext.slice(index, index + 2) !== "{{") continue;

    let depth = 1;
    let cursor = index + 2;
    for (; cursor < wikitext.length - 1 && depth > 0; cursor += 1) {
      const pair = wikitext.slice(cursor, cursor + 2);
      if (pair === "{{") {
        depth += 1;
        cursor += 1;
      } else if (pair === "}}") {
        depth -= 1;
        cursor += 1;
      }
    }
    if (depth !== 0) break;

    const raw = wikitext.slice(index + 2, cursor - 2);
    const name = raw.split("|", 1)[0]?.trim().toLowerCase();
    if (name === expected) results.push(raw);
    index = cursor - 1;
  }

  return results;
}

/**
 * Extract matching templates even when they are nested inside a parser
 * function or another template.
 * @param {string} wikitext
 * @param {string} expectedName
 */
export function extractNestedTemplates(wikitext, expectedName) {
  const results = [];
  const expected = expectedName.trim().toLowerCase();

  for (let index = 0; index < wikitext.length - 1; index += 1) {
    if (wikitext.slice(index, index + 2) !== "{{") continue;

    let depth = 1;
    let cursor = index + 2;
    for (; cursor < wikitext.length - 1 && depth > 0; cursor += 1) {
      const pair = wikitext.slice(cursor, cursor + 2);
      if (pair === "{{") {
        depth += 1;
        cursor += 1;
      } else if (pair === "}}") {
        depth -= 1;
        cursor += 1;
      }
    }
    if (depth !== 0) break;

    const raw = wikitext.slice(index + 2, cursor - 2);
    const name = raw.split("|", 1)[0]?.trim().toLowerCase();
    if (name === expected) results.push(raw);
  }

  return results;
}

/** @param {string} templateBody */
export function parseTemplateParameters(templateBody) {
  const values = new Map();
  let depth = 0;
  let segment = "";
  const segments = [];

  for (let index = 0; index < templateBody.length; index += 1) {
    const pair = templateBody.slice(index, index + 2);
    if (pair === "{{" || pair === "[[") {
      depth += 1;
      segment += pair;
      index += 1;
    } else if (pair === "}}" || pair === "]]") {
      depth = Math.max(0, depth - 1);
      segment += pair;
      index += 1;
    } else if (templateBody[index] === "|" && depth === 0) {
      segments.push(segment);
      segment = "";
    } else {
      segment += templateBody[index];
    }
  }
  segments.push(segment);

  let positional = 1;
  for (const value of segments.slice(1)) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      values.set(String(positional), value.trim());
      positional += 1;
      continue;
    }
    values.set(
      value.slice(0, separator).trim().toLowerCase(),
      value.slice(separator + 1).trim(),
    );
  }
  return values;
}

/** @param {string} value */
export function plainWikitext(value) {
  return value
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\{\{!\}\}/g, "|")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]+\}\}/g, "")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} value */
export function normaliseScheduleName(value) {
  return plainWikitext(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\b(?:jp|na|us)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** @param {string} value */
export function stableSlug(value) {
  return normaliseScheduleName(value).replace(/\s+/g, "-") || "untitled";
}
