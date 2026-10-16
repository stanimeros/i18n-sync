import test from 'node:test';
import assert from 'node:assert/strict';
import { translateBatch, reviewBatch } from '../src/llm/anthropic.js';
import { buildPrompt, buildReviewPrompt } from '../src/llm/prompts.js';
import { runSync } from '../src/sync.js';
import { tmpDir, write, readJson, makeConfig } from './helpers.js';

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => (calls.push(req), response) } },
  };
}

const ok = (text, extra = {}) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 11, output_tokens: 7 }, stop_reason: 'end_turn', ...extra });

test('anthropic request shape for a model that supports effort and fallbacks', async () => {
  const client = fakeClient(ok('```json\n{"0":"Hallo"}\n```'));
  const cfg = makeConfig(tmpDir(), { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' });
  cfg._anthropicClient = client;
  let usage;
  const out = await translateBatch({ items: [{ id: '0', text: 'Hi' }], sourceLang: 'en', targetLang: 'de', cfg, onUsage: (u) => (usage = u) });
  assert.deepEqual(out, { 0: 'Hallo' });
  assert.deepEqual(usage, { input: 11, output: 7 });
  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.max_tokens, 16000);
  assert.deepEqual(req.output_config, { effort: 'high' });
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal('thinking' in req, false);
  assert.equal('temperature' in req, false);
  assert.equal(req.system, buildPrompt({ sourceLang: 'en', targetLang: 'de', cfg }));
  assert.deepEqual(req.messages, [{ role: 'user', content: JSON.stringify([{ id: '0', text: 'Hi' }]) }]);
});

test('anthropic omits effort and fallbacks for other models', async () => {
  const client = fakeClient(ok('{"0":{"ok":true}}'));
  const cfg = makeConfig(tmpDir(), { provider: 'anthropic', model: 'claude-haiku-4-5' });
  const out = await reviewBatch({ items: [{ id: '0', source: 'Hi', translation: 'Hallo' }], sourceLang: 'en', targetLang: 'de', cfg: { ...cfg, _anthropicClient: client } });
  assert.deepEqual(out, { 0: { ok: true } });
  const req = client.calls[0];
  assert.equal('output_config' in req, false);
  assert.equal('betas' in req, false);
  assert.equal('fallbacks' in req, false);
  assert.equal(req.system, buildReviewPrompt({ sourceLang: 'en', targetLang: 'de', cfg }));
});

test('anthropic refusal becomes an error (usage still reported)', async () => {
  const client = fakeClient({ content: [], usage: { input_tokens: 5, output_tokens: 0 }, stop_reason: 'refusal', stop_details: { category: 'cyber' } });
  const cfg = makeConfig(tmpDir(), { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  cfg._anthropicClient = client;
  let usage;
  await assert.rejects(
    () => translateBatch({ items: [], sourceLang: 'en', targetLang: 'de', cfg, onUsage: (u) => (usage = u) }),
    /refused.*cyber/,
  );
  assert.deepEqual(usage, { input: 5, output: 0 });
});

test('anthropic as translation provider through runSync (injected client factory)', async () => {
  const dir = tmpDir();
  const client = fakeClient(ok('{"0":"Speichern"}'));
  const cfg = makeConfig(dir, { provider: 'anthropic', gitContext: false, languages: ['en', 'de'] });
  assert.equal(cfg.model, 'claude-sonnet-5-5');
  assert.equal(cfg.apiKeyEnv, 'ANTHROPIC_API_KEY');
  write(dir, 'locales/en.json', { b: 'Save' });
  const translate = (args) => translateBatch({ ...args, clientFactory: () => client });
  const report = await runSync(cfg, { translate });
  assert.equal(readJson(dir, 'locales/de.json').b, 'Speichern');
  assert.deepEqual([report.usage.phases.translate.input, report.usage.phases.translate.output], [11, 7]);
});

test('missing SDK gives an install hint', async () => {
  process.env.I18N_SYNC_TEST_KEY = 'k';
  const cfg = makeConfig(tmpDir(), { provider: 'anthropic', apiKeyEnv: 'I18N_SYNC_TEST_KEY' });
  try {
    await import('@anthropic-ai/sdk');
    return; // SDK is installed; nothing to assert
  } catch { /* expected */ }
  await assert.rejects(() => translateBatch({ items: [], sourceLang: 'en', targetLang: 'de', cfg }), /npm i -D @anthropic-ai\/sdk/);
});
