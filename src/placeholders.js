/**
 * Placeholder / markup validation of translations against their source text.
 */

const MUSTACHE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const HTML_TAG = /<(\/?)([a-zA-Z][\w-]*)\b[^<>]*>/g;

/**
 * `{{name}}` placeholders (whitespace-normalized), in order.
 * @param {string} s
 * @returns {string[]}
 */
export function extractMustache(s) {
  return [...s.matchAll(MUSTACHE)].map((m) => `{{${m[1]}}}`);
}

/**
 * Names of ICU arguments at the top level of the message (`{name}`, `{n, plural, ...}`).
 * Arguments nested inside plural/select branches are not collected.
 * @param {string} s
 * @returns {string[]}
 */
export function extractIcuArgs(s) {
  const text = s.replace(MUSTACHE, '');
  const names = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let j = i + 1;
      let depth = 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const inner = text.slice(i + 1, j - 1);
      const name = inner.split(',')[0].trim();
      if (name) names.push(name);
      i = j;
    } else {
      i++;
    }
  }
  return names;
}

/**
 * HTML tag names, with a leading "/" for closing tags.
 * @param {string} s
 * @returns {string[]}
 */
export function extractTags(s) {
  return [...s.matchAll(HTML_TAG)].map((m) => `${m[1]}${m[2].toLowerCase()}`);
}

/** @param {string[]} a @param {string[]} b */
function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** @param {string[]} a @param {string[]} b */
function diffMessage(a, b) {
  const rest = [...b];
  const missing = [];
  for (const v of a) {
    const idx = rest.indexOf(v);
    if (idx === -1) missing.push(v);
    else rest.splice(idx, 1);
  }
  const parts = [];
  if (missing.length) parts.push(`missing ${missing.join(', ')}`);
  if (rest.length) parts.push(`unexpected ${rest.join(', ')}`);
  return parts.join('; ');
}

/**
 * Validate a translation against its source.
 * @param {string} source
 * @param {unknown} translated
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateTranslation(source, translated) {
  if (typeof translated !== 'string') return { ok: false, reason: 'result is not a string' };
  if (source.trim() !== '' && translated.trim() === '') return { ok: false, reason: 'result is empty' };
  const checks = [
    ['{{placeholders}}', extractMustache],
    ['ICU arguments', extractIcuArgs],
    ['HTML tags', extractTags],
  ];
  for (const [label, fn] of checks) {
    const a = fn(source);
    const b = fn(translated);
    if (!sameMultiset(a, b)) return { ok: false, reason: `${label} differ (${diffMessage(a, b)})` };
  }
  return { ok: true };
}

/**
 * Give `translated` exactly the leading/trailing whitespace of `source`. Models tend to trim, and
 * strings that are concatenated in the UI ("Hello " + name) depend on it.
 * @param {string} source @param {string} translated
 */
export function matchWhitespace(source, translated) {
  const lead = source.match(/^\s*/)[0];
  const trail = source.trim() === '' ? '' : source.match(/\s*$/)[0];
  return lead + translated.trim() + trail;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasTerm = (text, term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'u').test(text);

/**
 * Glossary terms present in the source must appear with their fixed rendering in the translation.
 * @param {string} source @param {string} translated
 * @param {Record<string, string | Record<string,string>>} glossary @param {string} targetLang
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkGlossary(source, translated, glossary, targetLang) {
  for (const [term, v] of Object.entries(glossary ?? {})) {
    const rendering = typeof v === 'string' ? v : v?.[targetLang];
    if (rendering === undefined || !hasTerm(source, term)) continue;
    if (!hasTerm(translated, rendering)) return { ok: false, reason: `glossary: "${term}" must appear as "${rendering}"` };
  }
  return { ok: true };
}
