const BAD_BRIEFING_OPENER_PATTERN =
  /^(This file|This change|This PR|Adds|Import|Declare|Build|Expose)\b/i;
const BAD_TITLE_OPENER_PATTERN = /^(Import|Declare|Build|Expose|Adds)\b/i;
const META_GROUPING_PATTERN = /\b(these files belong together|this stack groups)\b/i;
const DIRECTIVE_PATTERN = /\b(review this|inspect next)\b/i;
const WHAT_WHY_LABEL_PATTERN = /\bWhat:\s|\bWhy:\s/i;

const TITLE_PLUS_MAX_WORDS = 20;
const TITLE_PLUS_OVERLAP_RATIO = 0.75;

export function collectBriefingTextErrors(
  text,
  { label, title = null, stackBriefing = false } = {},
) {
  const errors = [];
  if (!isNonEmptyString(text)) {
    return errors;
  }

  const trimmed = stripMarkdown(text).trim();
  if (BAD_BRIEFING_OPENER_PATTERN.test(trimmed)) {
    errors.push(
      `${label} must not open with file-meta or code narration (This file, Adds, Import, Declare, Build, Expose).`,
    );
  }
  if (WHAT_WHY_LABEL_PATTERN.test(trimmed)) {
    errors.push(`${label} must not use What: or Why: labels.`);
  }
  if (DIRECTIVE_PATTERN.test(trimmed)) {
    errors.push(
      `${label} must not include review directives such as "review this" or "inspect next".`,
    );
  }
  if (stackBriefing && META_GROUPING_PATTERN.test(trimmed)) {
    errors.push(`${label} must state the shared outcome, not meta-grouping language.`);
  }
  if (isNonEmptyString(title) && isTitlePlusViolation(title, trimmed)) {
    errors.push(
      `${label} must add information the title cannot carry alone (title-plus violation).`,
    );
  }

  return errors;
}

export function collectTitleTextErrors(text, { label } = {}) {
  const errors = [];
  if (!isNonEmptyString(text)) {
    return errors;
  }

  const trimmed = stripMarkdown(text).trim();
  if (BAD_TITLE_OPENER_PATTERN.test(trimmed)) {
    errors.push(
      `${label} must name the reviewer question, not the code verb (Import, Declare, Build, Expose, Adds).`,
    );
  }

  return errors;
}

export function appendBriefingTextErrors(errors, text, options) {
  errors.push(...collectBriefingTextErrors(text, options));
}

export function appendTitleTextErrors(errors, text, options) {
  errors.push(...collectTitleTextErrors(text, options));
}

function isTitlePlusViolation(title, briefing) {
  const briefingWords = tokenize(briefing);
  if (briefingWords.length === 0 || briefingWords.length > TITLE_PLUS_MAX_WORDS) {
    return false;
  }

  const sentenceCount = briefing
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
  if (sentenceCount > 1) {
    return false;
  }

  const titleWords = tokenize(title);
  if (titleWords.length === 0) {
    return false;
  }

  const overlapCount = titleWords.filter((word) => briefingWords.includes(word)).length;
  return overlapCount / titleWords.length >= TITLE_PLUS_OVERLAP_RATIO;
}

function tokenize(text) {
  return stripMarkdown(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stripMarkdown(text) {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^Reviewer attention:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
