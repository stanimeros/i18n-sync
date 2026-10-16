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

import { matchWhitespace, checkGlossary } from '../src/placeholders.js';

test('matchWhitespace restores leading/trailing whitespace of the source', () => {
  assert.equal(matchWhitespace('From idea to launch. ', 'Von der Idee zum Launch.'), 'Von der Idee zum Launch. ');
  assert.equal(matchWhitespace(' x\n', '  y  '), ' y\n');
  assert.equal(matchWhitespace('a', ' b '), 'b');
});

test('checkGlossary enforces fixed renderings on word boundaries', () => {
  const g = { AI: 'AI', Acme: { de: 'Acme GmbH' } };
  assert.equal(checkGlossary('AI automation', 'automatisation par IA', g, 'fr').ok, false);
  assert.equal(checkGlossary('AI automation', 'automatisation par AI', g, 'fr').ok, true);
  assert.equal(checkGlossary('MAIN menu', 'menu principal', g, 'fr').ok, true); // no word-boundary match
  assert.equal(checkGlossary('Acme rocks', 'Acme rockt', g, 'de').ok, false);
  assert.equal(checkGlossary('Acme rocks', 'Acme rocks', g, 'fr').ok, true); // no rendering for fr
});
