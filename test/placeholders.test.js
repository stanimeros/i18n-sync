import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslation, extractMustache, extractIcuArgs, extractTags } from '../src/placeholders.js';

test('extractors', () => {
  assert.deepEqual(extractMustache('Hi {{ name }} and {{count}}'), ['{{name}}', '{{count}}']);
  assert.deepEqual(extractIcuArgs('Hi {name}, {n, plural, one{# {thing}} other{# things}}'), ['name', 'n']);
  assert.deepEqual(extractIcuArgs('{{x}} and {y}'), ['y']);
  assert.deepEqual(extractTags('<b>Hi</b><br/> <A href="x">l</A>'), ['b', '/b', 'br', 'a', '/a']);
});

test('accepts valid translations', () => {
  assert.equal(validateTranslation('Hello {{name}}', 'Γεια {{ name }}').ok, true);
  assert.equal(validateTranslation('<b>Hi</b> {n}', '<b>Γεια</b> {n}').ok, true);
  assert.equal(validateTranslation('{n, plural, one{# item} other{# items}}', '{n, plural, one{# στοιχείο} other{# στοιχεία}}').ok, true);
  assert.equal(validateTranslation('a  b\n', 'α  β\n').ok, true);
});

test('rejects broken translations', () => {
  assert.equal(validateTranslation('Hello {{name}}', 'Γεια {{nam}}').ok, false);
  assert.equal(validateTranslation('Hello {{name}}', 'Γεια').ok, false);
  assert.equal(validateTranslation('Hello {name}', 'Γεια {nom}').ok, false);
  assert.equal(validateTranslation('<b>Hi</b>', 'Γεια').ok, false);
  assert.equal(validateTranslation('<b>Hi</b>', '<i>Γεια</i>').ok, false);
  assert.equal(validateTranslation('Hi', '').ok, false);
  assert.equal(validateTranslation('Hi', '   ').ok, false);
  assert.equal(validateTranslation('Hi', 42).ok, false);
  assert.equal(validateTranslation('{{a}}', '{{a}} {{a}}').ok, false);
});
