import { buildPrompt, buildReviewPrompt, parseJsonObject } from './prompts.js';

export { buildPrompt };

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the JSON object from a Gemini response. */
function parseResponse(data) {
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) {
    const reason = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason ?? 'empty response';
    throw new Error(`Gemini returned no content (${reason})`);
  }
  return parseJsonObject(text, 'Gemini');
}

/** Report token usage of a response. Thinking tokens are billed as output. */
function reportUsage(data, onUsage) {
  const u = data?.usageMetadata;
  if (!u || !onUsage) return;
  onUsage({
    input: u.promptTokenCount ?? 0,
    output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  });
}

/**
 * Send one system prompt + user payload with retries; returns the parsed JSON object.
 * @param {{system: string, user: string, cfg: import('../config.js').Config, fetchImpl?: typeof fetch,
 *   baseDelayMs?: number, onUsage?: import('./prompts.js').OnUsage}} args
 */
async function generate({ system, user, cfg, fetchImpl = globalThis.fetch, baseDelayMs = 1000, onUsage }) {
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing API key: set the ${cfg.apiKeyEnv} environment variable (or put it in .env).`);
  const generationConfig = { responseMimeType: 'application/json' };
  if (cfg.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: cfg.thinkingLevel };
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
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
      const data = await res.json();
      reportUsage(data, onUsage);
      return parseResponse(data);
    } catch (e) {
      lastErr = e; // malformed output: retry
    }
  }
  throw lastErr ?? new Error('Gemini request failed');
}

/**
 * @param {{items: import('./prompts.js').BatchItem[], sourceLang: string, targetLang: string, cfg: import('../config.js').Config,
 *   note?: string, fetchImpl?: typeof fetch, baseDelayMs?: number, onUsage?: import('./prompts.js').OnUsage}} args
 * @returns {Promise<Record<string,string>>}
 */
export async function translateBatch({ items, sourceLang, targetLang, cfg, note, ...rest }) {
  return generate({ system: buildPrompt({ sourceLang, targetLang, cfg, note }), user: JSON.stringify(items), cfg, ...rest });
}

/**
 * @param {{items: import('./prompts.js').ReviewItem[], sourceLang: string, targetLang: string, cfg: import('../config.js').Config,
 *   fetchImpl?: typeof fetch, baseDelayMs?: number, onUsage?: import('./prompts.js').OnUsage}} args
 * @returns {Promise<Record<string, import('./prompts.js').ReviewVerdict>>}
 */
export async function reviewBatch({ items, sourceLang, targetLang, cfg, ...rest }) {
  return generate({ system: buildReviewPrompt({ sourceLang, targetLang, cfg }), user: JSON.stringify(items), cfg, ...rest });
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
  reviewBatch,
};
