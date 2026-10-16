import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten, unflatten, load, save } from '../src/formats/json.js';
import { tmpDir, write, readJson, read, makeConfig } from './helpers.js';

test('flatten / unflatten with nesting and arrays', () => {
  const obj = { a: { b: 'x', list: ['one', 'two'] }, n: 3, ok: true, z: 'last', empty: [] };
  const f = flatten(obj);
  assert.deepEqual([...f.values], [['a.b', 'x'], ['a.list.0', 'one'], ['a.list.1', 'two'], ['z', 'last']]);
  assert.deepEqual([...f.extras.keys()], ['n', 'ok', 'empty']);
  assert.deepEqual(f.order, ['a.b', 'a.list.0', 'a.list.1', 'n', 'ok', 'z', 'empty'].sort((x, y) => f.order.indexOf(x) - f.order.indexOf(y)));
  const back = unflatten(f.order.map((k) => [k, f.values.has(k) ? f.values.get(k) : f.extras.get(k)]));
  assert.deepEqual(back, obj);
});

test('unflatten detects conflicts', () => {
  assert.throws(() => unflatten([['a', 'x'], ['a.b', 'y']]));
});

test('load/save single file preserves primary order and non-string leaves', () => {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { languages: ['en', 'el'] });
  write(dir, 'locales/en.json', { z: 'Z', a: 'A', count: 5, arr: ['x', 'y'] });
  write(dir, 'locales/el.json', { a: 'Α' });
  const en = load('en', cfg);
  assert.deepEqual(en.order, ['z', 'a', 'count', 'arr.0', 'arr.1']);
  const el = load('el', cfg);
  const values = new Map([['a', 'Α'], ['z', 'Ζ'], ['arr.0', 'χ'], ['arr.1', 'ψ']]);
  save('el', values, cfg, { order: en.order, extras: en.extras });
  const out = readJson(dir, 'locales/el.json');
  assert.deepEqual(Object.keys(out), ['z', 'a', 'count', 'arr']);
  assert.deepEqual(out.arr, ['χ', 'ψ']);
  assert.equal(out.count, 5);
  const text = read(dir, 'locales/el.json');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('\n  "z"'));
  assert.equal(el.values.get('a'), 'Α');
});

test('missing target file is empty; save creates dirs', () => {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { files: 'deep/dir/{lang}.json', languages: ['en', 'fr'] });
  const fr = load('fr', cfg);
  assert.equal(fr.values.size, 0);
  save('fr', new Map([['a', 'b']]), cfg);
  assert.deepEqual(readJson(dir, 'deep/dir/fr.json'), { a: 'b' });
});

test('namespaces discovered from primary directory', () => {
  const dir = tmpDir();
  const cfg = makeConfig(dir, { files: 'src/locales/{lang}/{ns}.json', languages: ['en', 'el'] });
  write(dir, 'src/locales/en/common.json', { hi: 'Hi', nested: { k: 'v' } });
  write(dir, 'src/locales/en/auth.json', { login: 'Log in' });
  write(dir, 'src/locales/el/common.json', { hi: 'Γεια' });
  const en = load('en', cfg);
  assert.deepEqual([...en.values.keys()].sort(), ['auth:login', 'common:hi', 'common:nested.k']);
  const el = load('el', cfg);
  assert.deepEqual([...el.values.keys()], ['common:hi']);
  save('el', new Map([['common:hi', 'Γεια'], ['common:nested.k', 'τ'], ['auth:login', 'Σύνδεση']]), cfg, { order: en.order });
  assert.deepEqual(readJson(dir, 'src/locales/el/common.json'), { hi: 'Γεια', nested: { k: 'τ' } });
  assert.deepEqual(readJson(dir, 'src/locales/el/auth.json'), { login: 'Σύνδεση' });
});
