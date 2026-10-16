import test from 'node:test';
import assert from 'node:assert/strict';
import { load, save } from '../src/formats/arb.js';
import { tmpDir, write, readJson, makeConfig } from './helpers.js';

const mk = (dir) => makeConfig(dir, { format: 'arb', files: 'lib/l10n/app_{lang}.arb', languages: ['en', 'el'] });

test('load separates messages, metadata and ignores @@locale', () => {
  const dir = tmpDir();
  write(dir, 'lib/l10n/app_en.arb', {
    '@@locale': 'en',
    hello: 'Hello {name}',
    '@hello': { placeholders: { name: { type: 'String' } } },
    bye: 'Bye',
  });
  const r = load('en', mk(dir));
  assert.deepEqual([...r.values], [['hello', 'Hello {name}'], ['bye', 'Bye']]);
  assert.deepEqual(r.order, ['hello', 'bye']);
  assert.ok(r.meta.has('hello'));
  assert.equal(r.values.has('@@locale'), false);
});

test('save sets @@locale first, keeps primary order and own metadata only', () => {
  const dir = tmpDir();
  const cfg = mk(dir);
  write(dir, 'lib/l10n/app_en.arb', { '@@locale': 'en', hello: 'Hello {name}', '@hello': { description: 'greeting' }, bye: 'Bye' });
  const en = load('en', cfg);
  save('el', new Map([['bye', 'Αντίο'], ['hello', 'Γεια {name}']]), cfg, { order: en.order, meta: new Map() });
  const el = readJson(dir, 'lib/l10n/app_el.arb');
  assert.deepEqual(Object.keys(el), ['@@locale', 'hello', 'bye']);
  assert.equal(el['@@locale'], 'el');
  save('en', en.values, cfg, { order: en.order, meta: en.meta });
  const en2 = readJson(dir, 'lib/l10n/app_en.arb');
  assert.deepEqual(Object.keys(en2), ['@@locale', 'hello', '@hello', 'bye']);
});

test('target keeps its own existing @key blocks', () => {
  const dir = tmpDir();
  const cfg = mk(dir);
  write(dir, 'lib/l10n/app_el.arb', { '@@locale': 'el', hello: 'Γεια', '@hello': { description: 'mine' } });
  const el = load('el', cfg);
  save('el', new Map([['hello', 'Γεια 2']]), cfg, { order: ['hello'], meta: el.meta });
  assert.deepEqual(readJson(dir, 'lib/l10n/app_el.arb')['@hello'], { description: 'mine' });
});
