import { languageName } from '../config.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * @typedef {Object} BatchItem
 * @property {string} id
 * @property {string} text
 * @property {string} [previousSource]
 * @property {string} [currentTranslation]
 * @property {string} [reference]
 * @property {string} [failure]
 *
 * Provider interface: translateBatch({items, sourceLang, targetLang, cfg, note?}) -> Promise<Record<id,string>>
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
 * Build the system prompt.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the JSON object from a Gemini response. */
function parseResponse(data) {
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) {
    const reason = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason ?? 'empty response';
    throw new Error(`Gemini returned no content (${reason})`);
  }
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    throw new Error('Gemini returned invalid JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Gemini returned an unexpected JSON shape');
  return obj;
}

/**
 * @param {{items: BatchItem[], sourceLang: string, targetLang: string, cfg: import('../config.js').Config,
 *   note?: string, fetchImpl?: typeof fetch, baseDelayMs?: number}} args
 * @returns {Promise<Record<string,string>>}
 */
export async function translateBatch({ items, sourceLang, targetLang, cfg, note, fetchImpl = globalThis.fetch, baseDelayMs = 1000 }) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing API key: set the ${cfg.apiKeyEnv} environment variable (or put it in .env).`);
  const body = {
    systemInstruction: { parts: [{ text: buildPrompt({ sourceLang, targetLang, cfg, note }) }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(items) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
  const url = `${ENDPOINT}/${cfg.model}:generateContent`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = new Error(`Network error: ${e.message}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Gemini API error ${res.status}`);
      continue;
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message ?? '';
      } catch { /* ignore */ }
      throw new Error(`Gemini API error ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    try {
      return parseResponse(await res.json());
    } catch (e) {
      lastErr = e; // malformed output: retry
    }
  }
  throw lastErr ?? new Error('Gemini request failed');
}

export const provider = {
  name: 'gemini',
  /** @param {import('../config.js').Config} cfg */
  assertReady(cfg) {
    if (!process.env[cfg.apiKeyEnv]) {
      throw new Error(`Translations are pending but no API key was found.\nSet ${cfg.apiKeyEnv} (environment variable or .env file), or use --check / --dry-run.`);
    }
  },
  translateBatch,
};
