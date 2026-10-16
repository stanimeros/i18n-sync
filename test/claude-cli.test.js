import test from 'node:test';
import assert from 'node:assert/strict';
import { translateBatch, reviewBatch } from '../src/llm/claude-cli.js';
import { createUsage, summarizeUsage } from '../src/pricing.js';
import { runSync } from '../src/sync.js';
import { tmpDir, write, makeConfig } from './helpers.js';

const cfg = { model: 'claude-opus-5-5', context: '', glossary: {}, tone: {} };

test('claude-cli: sends system prompt + items, parses result, reports CLI cost', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { result: '```json\n{"0":"Hallo"}\n```', total_cost_usd: 0.0123, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } };
  };
  const usage = createUsage();
  const out = await translateBatch({ items: [{ id: '0', text: 'Hello' }], sourceLang: 'en', targetLang: 'de', cfg, onUsage: usage.add, run });
  assert.deepEqual(out, { 0: 'Hallo' });
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.match(calls[0].system, /German/);
  assert.deepEqual(JSON.parse(calls[0].user), [{ id: '0', text: 'Hello' }]);
  assert.deepEqual([usage.totals.input, usage.totals.output, usage.totals.reportedCost], [15, 7, 0.0123]);
  // reported cost wins over the price table
  const s = summarizeUsage({ review: { model: 'claude-opus-5-5', ...usage.totals } }, {});
  assert.equal(s.total.cost, 0.0123);
});

test('claude-cli: review verdicts and errors', async () => {
  const ok = await reviewBatch({ items: [{ id: '0', source: 'a', translation: 'b' }], sourceLang: 'en', targetLang: 'de', cfg, run: async () => ({ result: '{"0":{"ok":true}}' }) });
  assert.deepEqual(ok, { 0: { ok: true } });
  await assert.rejects(reviewBatch({ items: [], sourceLang: 'en', targetLang: 'de', cfg, run: async () => ({ result: '' }) }), /no content/);
});

test('cost above confirmAbove asks; declining aborts before any API call', async () => {
  const dir = tmpDir();
  const c = makeConfig(dir, { gitContext: false, confirmAbove: 0, pricing: { 'gemini-3.5-flash-lite': { input: 1000, output: 1000 } } });
  write(dir, 'locales/en.json', { a: 'Hello world' });
  let translated = 0;
  const translate = async ({ items }) => { translated++; return Object.fromEntries(items.map((i) => [i.id, 'x'])); };
  let asked = null;
  await assert.rejects(runSync(c, { translate, confirm: async (usd) => { asked = usd; return false; } }), /not confirmed/);
  assert.ok(asked > 0);
  assert.equal(translated, 0);
  await runSync(c, { translate, confirm: async () => true });
  assert.ok(translated > 0);
});

test('cost below confirmAbove does not ask', async () => {
  const dir = tmpDir();
  const c = makeConfig(dir, { gitContext: false });
  write(dir, 'locales/en.json', { a: 'Hello' });
  const translate = async ({ items }) => Object.fromEntries(items.map((i) => [i.id, 'x']));
  await runSync(c, { translate, confirm: async () => assert.fail('should not ask') });
});

import { withReviewProvider } from '../src/config.js';

test('--review-with switches provider defaults and enables review', () => {
  const c = makeConfig(tmpDir());
  const r = withReviewProvider(c, 'claude-cli');
  assert.equal(r.review.enabled, true);
  assert.deepEqual([r.review.provider, r.review.model, r.review.batchSize], ['claude-cli', 'claude-opus-5-5', 200]);
  assert.equal(withReviewProvider(c, 'gemini').review.model, 'gemini-3.6-flash');
  assert.throws(() => withReviewProvider(c, 'nope'), /review-with/);
});
