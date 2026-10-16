import { buildPrompt, buildReviewPrompt, parseJsonObject } from './prompts.js';

const BETAS = ['server-side-fallback-2026-07-01'];
/** Models that accept `output_config.effort` and server-side fallbacks. */
const ADVANCED = /^claude-(opus-5|sonnet-5-5|fable-5)/;

/** Load the optional SDK on demand. */
async function loadSdk() {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return mod.default ?? mod.Anthropic;
  } catch {
    throw new Error('Install @anthropic-ai/sdk to use the anthropic provider: npm i -D @anthropic-ai/sdk');
  }
}

/**
 * @param {import('../config.js').Config & {_anthropicClient?: any}} cfg
 * @param {(cfg: any) => any} [clientFactory]
 */
async function getClient(cfg, clientFactory) {
  if (clientFactory) return clientFactory(cfg);
  if (cfg._anthropicClient) return cfg._anthropicClient;
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing API key: set the ${cfg.apiKeyEnv} environment variable (or put it in .env).`);
  const Anthropic = await loadSdk();
  return new Anthropic({ apiKey, maxRetries: 3 }); // retries are handled by the SDK
}

/** Send one request and return the parsed JSON object. */
async function generate({ system, user, cfg, onUsage, clientFactory }) {
  const client = await getClient(cfg, clientFactory);
  const req = { model: cfg.model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] };
  if (ADVANCED.test(cfg.model)) {
    req.output_config = { effort: cfg.effort ?? 'medium' };
    req.betas = BETAS;
    req.fallbacks = 'default';
  }
  const response = await client.beta.messages.create(req);
  if (response.usage && onUsage) {
    onUsage({ input: response.usage.input_tokens ?? 0, output: response.usage.output_tokens ?? 0 });
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude refused the request (${response.stop_details?.category ?? 'unknown'})`);
  }
  const text = (response.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!text.trim()) throw new Error(`Claude returned no content (${response.stop_reason ?? 'empty response'})`);
  return parseJsonObject(text, 'Claude');
}

/**
 * @param {{items: import('./prompts.js').BatchItem[], sourceLang: string, targetLang: string, cfg: import('../config.js').Config,
 *   note?: string, onUsage?: import('./prompts.js').OnUsage, clientFactory?: (cfg: any) => any}} args
 * @returns {Promise<Record<string,string>>}
 */
export async function translateBatch({ items, sourceLang, targetLang, cfg, note, ...rest }) {
  return generate({ system: buildPrompt({ sourceLang, targetLang, cfg, note }), user: JSON.stringify(items), cfg, ...rest });
}

/**
 * @param {{items: import('./prompts.js').ReviewItem[], sourceLang: string, targetLang: string, cfg: import('../config.js').Config,
 *   onUsage?: import('./prompts.js').OnUsage, clientFactory?: (cfg: any) => any}} args
 * @returns {Promise<Record<string, import('./prompts.js').ReviewVerdict>>}
 */
export async function reviewBatch({ items, sourceLang, targetLang, cfg, ...rest }) {
  return generate({ system: buildReviewPrompt({ sourceLang, targetLang, cfg }), user: JSON.stringify(items), cfg, ...rest });
}

export const provider = {
  name: 'anthropic',
  /** @param {import('../config.js').Config} cfg */
  assertReady(cfg) {
    if (!process.env[cfg.apiKeyEnv]) {
      throw new Error(`Translations are pending but no API key was found.\nSet ${cfg.apiKeyEnv} (environment variable or .env file), or use --check / --dry-run.`);
    }
  },
  translateBatch,
  reviewBatch,
};
