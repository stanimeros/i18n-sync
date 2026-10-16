import test from 'node:test';
import assert from 'node:assert/strict';
import { cost, createUsage, summarizeUsage, formatUsage } from '../src/pricing.js';
import { translateBatch } from '../src/llm/gemini.js';
import { runSync, formatReport, formatEstimate } from '../src/sync.js';
import { normalizeConfig } from '../src/config.js';
import { tmpDir, write, makeConfig } from './helpers.js';

const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

test('cost math: built-ins, override, unknown model', () => {
  approx(cost('gemini-2.5-flash', { input: 1_000_000, output: 1_000_000 }), 2.8);
  approx(cost('claude-opus-5-5', { input: 500_000, output: 100_000 }), 4);
  assert.equal(cost('mystery-model', { input: 1, output: 1 }), null);
  const cfg = { pricing: { 'mystery-model': { input: 1, output: 2 }, 'gemini-2.5-flash': { input: 0, output: 0 } } };
  approx(cost('mystery-model', { input: 1_000_000, output: 1_000_000 }, cfg), 3);
  approx(cost('gemini-2.5-flash', { input: 1_000_000, output: 1_000_000 }, cfg), 0);
});

test('config validates pricing, thinkingLevel and review', () => {
  const base = { files: 'l/{lang}.json', languages: ['en', 'el'] };
  assert.throws(() => normalizeConfig({ ...base, pricing: { m: { input: 1 } } }, '/x'), /pricing\.m/);
  assert.throws(() => normalizeConfig({ ...base, thinkingLevel: 'max' }, '/x'), /thinkingLevel/);
  assert.throws(() => normalizeConfig({ ...base, review: { provider: 'openai' } }, '/x'), /review\.provider/);
  assert.throws(() => normalizeConfig({ ...base, review: { batchSize: 0 } }, '/x'), /review\.batchSize/);
  const cfg = normalizeConfig(base, '/x');
  assert.equal(cfg.model, 'gemini-3.5-flash-lite');
  assert.equal(cfg.thinkingLevel, 'minimal');
  assert.deepEqual([cfg.review.enabled, cfg.review.provider, cfg.review.model, cfg.review.apiKeyEnv], [false, 'gemini', 'gemini-3.6-flash', 'GEMINI_API_KEY']);
  const a = normalizeConfig({ ...base, review: { provider: 'anthropic' } }, '/x');
  assert.deepEqual([a.review.model, a.review.apiKeyEnv, a.review.effort], ['claude-opus-5-5', 'ANTHROPIC_API_KEY', 'medium']);
  assert.equal(normalizeConfig({ ...base, model: 'gemini-2.5-flash' }, '/x').thinkingLevel, null);
  assert.equal(normalizeConfig({ ...base, thinkingLevel: null }, '/x').thinkingLevel, null);
});

function geminiFetch(sink, usage) {
  return async (url, init) => {
    sink.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"0":"x"}' }] } }], usageMetadata: usage }),
    };
  };
}

test('gemini reports usage (thinking billed as output) and sends thinkingLevel', async () => {
  process.env.I18N_SYNC_TEST_KEY = 'k';
  const bodies = [];
  const u = createUsage();
  const cfg = makeConfig(tmpDir(), { apiKeyEnv: 'I18N_SYNC_TEST_KEY' });
  await translateBatch({
    items: [{ id: '0', text: 'Hi' }], sourceLang: 'en', targetLang: 'el', cfg, onUsage: u.add,
    fetchImpl: geminiFetch(bodies, { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 }),
  });
  await translateBatch({
    items: [{ id: '0', text: 'Hi' }], sourceLang: 'en', targetLang: 'el', cfg, onUsage: u.add,
    fetchImpl: geminiFetch(bodies, { promptTokenCount: 10, candidatesTokenCount: 5 }),
  });
  assert.deepEqual([u.totals.input, u.totals.output, u.totals.calls], [110, 55, 2]);
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'minimal');

  const none = makeConfig(tmpDir(), { apiKeyEnv: 'I18N_SYNC_TEST_KEY', thinkingLevel: null });
  const b2 = [];
  await translateBatch({ items: [], sourceLang: 'en', targetLang: 'el', cfg: none, fetchImpl: geminiFetch(b2, {}) });
  assert.equal('thinkingConfig' in b2[0].generationConfig, false);
});

test('usage aggregates across batches and is reported with cost', async () => {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { gitContext: false, batchSize: 1, model: 'gemini-2.5-flash' });
  write(dir, 'locales/en.json', { a: 'A', b: 'B' });
  const translate = async ({ items, onUsage }) => {
    onUsage({ input: 1000, output: 500 });
    return Object.fromEntries(items.map((i) => [i.id, `t ${i.text}`]));
  };
  const report = await runSync(cfg, { translate });
  // 2 languages x 2 keys, batchSize 1 -> 4 calls
  assert.deepEqual([report.usage.phases.translate.input, report.usage.phases.translate.output], [4000, 2000]);
  approx(report.usage.total.cost, (4000 * 0.3 + 2000 * 2.5) / 1e6);
  const lines = formatReport(report);
  assert.ok(lines.some((l) => /^translate: 4,000 in \/ 2,000 out tokens, \$0\.0062 \(gemini-2\.5-flash\)$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^total: 4,000 in \/ 2,000 out tokens, \$0\.0062$/.test(l)));
});

test('unknown model prints a pricing hint', () => {
  const s = summarizeUsage({ translate: { model: 'my-model', input: 10, output: 5 } }, {});
  assert.equal(s.total.cost, null);
  const lines = formatUsage(s);
  assert.match(lines[0], /cost unknown \(no pricing for my-model; set "pricing" in config\)/);
  assert.match(lines[1], /cost unknown/);
});

test('--dry-run and --check include an estimate, review adds a phase', async () => {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { gitContext: false, model: 'gemini-2.5-flash' });
  write(dir, 'locales/en.json', { a: 'Hello world, this is a longer sentence.' });
  for (const opt of [{ dryRun: true }, { check: true }]) {
    const r = await runSync(cfg, opt);
    assert.ok(r.estimate.phases.translate.input > 0 && r.estimate.phases.translate.output > 0);
    assert.equal(r.estimate.phases.review, undefined);
    const lines = formatEstimate(r);
    assert.match(lines.at(-1), /^estimated cost: ~\$\d/);
    assert.match(lines.at(-1), /estimate/);
  }
  const rr = await runSync(cfg, { dryRun: true, review: true });
  assert.ok(rr.estimate.phases.review.input > 0);
  assert.equal(rr.estimate.phases.review.model, 'gemini-3.6-flash');
  const none = await runSync(makeConfig(dir, { gitContext: false }), { check: true });
  assert.ok(none.estimate);
});
