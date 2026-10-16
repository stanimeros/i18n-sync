import { languageName } from '../config.js';

/**
 * @typedef {Object} BatchItem
 * @property {string} id
 * @property {string} text
 * @property {string} [previousSource]
 * @property {string} [currentTranslation]
 * @property {string} [reference]
 * @property {string} [failure]
 *
 * @typedef {Object} ReviewItem
 * @property {string} id
 * @property {string} source        text in the source language of this translation
 * @property {string} translation
 * @property {string} [reference]   same text in the primary language, when it differs from `source`
 *
 * @typedef {{ok: true} | {ok: false, issue: string, fixed: string}} ReviewVerdict
 * @typedef {(usage: {input: number, output: number}) => void} OnUsage
 *
 * Provider interface (shared prompts live here, providers only transport):
 *   translateBatch({items, sourceLang, targetLang, cfg, note?, onUsage?}) -> Promise<Record<id,string>>
 *   reviewBatch({items, sourceLang, targetLang, cfg, onUsage?}) -> Promise<Record<id,ReviewVerdict>>
 */

/** Glossary entries relevant to a target language. */
function glossaryLines(cfg, targetLang) {
  const lines = [];
  for (const [term, v] of Object.entries(cfg.glossary ?? {})) {
    const rendering = typeof v === 'string' ? v : v[targetLang];
    if (rendering === undefined) continue;
    lines.push(rendering === term
      ? `- "${term}": never translate, keep exactly as written`
      : `- "${term}": always render as "${rendering}"`);
  }
  return lines;
}

/**
 * Build the translation system prompt.
 * @param {{sourceLang: string, targetLang: string, cfg: import('../config.js').Config, note?: string}} p
 */
export function buildPrompt({ sourceLang, targetLang, cfg, note }) {
  const parts = [];
  parts.push(
    `You are a professional software localizer. Translate UI strings from ${languageName(sourceLang)} (${sourceLang}) ` +
      `into ${languageName(targetLang)} (${targetLang}).`,
  );
  if (cfg.context) parts.push(`Product context: ${cfg.context}`);
  if (cfg.tone?.[targetLang]) parts.push(`Tone for ${languageName(targetLang)}: ${cfg.tone[targetLang]}.`);
  const gl = glossaryLines(cfg, targetLang);
  if (gl.length) parts.push(`Glossary:\n${gl.join('\n')}`);
  if (note) parts.push(`Change note from version control (why the source changed): ${note}`);
  parts.push(
    [
      'Rules:',
      '- Preserve placeholders such as {{name}} exactly (do not translate or rename them).',
      '- Preserve ICU MessageFormat syntax: {name}, and plural/select structures. Keep keywords (plural, select, one, other, =0 ...) and argument names in English; translate only the human text inside branches, and use the plural categories valid for the target language.',
      '- Preserve HTML tags and markdown exactly; translate only the text between them.',
      '- Preserve leading/trailing whitespace and newlines (\\n) exactly.',
      '- End the translation the way the source ends: add no final period or other punctuation the source does not have.',
      '- Keep the meaning, length and register suitable for a UI. Do not add explanations.',
      '- If an item has "currentTranslation" and "previousSource": the source text changed from previousSource to text. Make the MINIMAL edit to currentTranslation that reflects this change and keep all unchanged wording as is.',
      '- If an item has "reference", it is the same text in the project\'s primary language; use it only to disambiguate meaning.',
      '- If an item has "failure", your previous answer was rejected for that reason; fix it.',
      '',
      'Input is a JSON array of items {id, text, ...}. Return ONLY a JSON object mapping each id to its translated string, nothing else.',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/**
 * Build the review system prompt.
 * @param {{sourceLang: string, targetLang: string, cfg: import('../config.js').Config}} p
 */
export function buildReviewPrompt({ sourceLang, targetLang, cfg }) {
  const parts = [];
  parts.push(
    `You are a senior localization reviewer. You review UI translations from ${languageName(sourceLang)} (${sourceLang}) ` +
      `into ${languageName(targetLang)} (${targetLang}) produced by a translator.`,
  );
  if (cfg.context) parts.push(`Product context: ${cfg.context}`);
  if (cfg.tone?.[targetLang]) parts.push(`Tone for ${languageName(targetLang)}: ${cfg.tone[targetLang]}.`);
  const gl = glossaryLines(cfg, targetLang);
  if (gl.length) parts.push(`Glossary:\n${gl.join('\n')}`);
  parts.push(
    [
      'Check each translation for:',
      '- meaning accuracy against the source;',
      '- omissions or additions;',
      '- fluency and naturalness in the target language;',
      '- tone and register (see the tone above);',
      '- glossary compliance;',
      '- consistency of terminology;',
      '- placeholders ({{name}}, ICU {name}, plural/select) and HTML tags preserved exactly.',
      '',
      'Only flag REAL problems. Do NOT rewrite a translation for mere style preference; if it is acceptable, mark it ok.',
      'When you flag a problem, make the MINIMAL change that fixes it and keep leading/trailing whitespace, placeholders and HTML exactly as in the source.',
      'If an item has "reference", it is the same text in the project\'s primary language; use it only to disambiguate meaning.',
      '',
      'Input is a JSON array of items {id, source, translation, reference?}. Return ONLY a JSON object mapping each id to either',
      '{"ok": true} or {"ok": false, "issue": "short reason", "fixed": "corrected translation"}. No other text.',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/**
 * Parse a model's JSON object answer (tolerates ``` fences).
 * @param {string} text
 * @param {string} label  provider name for error messages
 * @returns {Record<string, any>}
 */
export function parseJsonObject(text, label) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${label} returned an unexpected JSON shape`);
  return obj;
}
