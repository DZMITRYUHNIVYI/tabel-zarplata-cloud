'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isObviousTelegramNoise } = require('./telegram-noise');

test('recognizes only whole, obvious conversational messages', () => {
  for (const text of ['тест', 'ТЕСТ!', 'ку-ку', 'Спасибо', 'ok', 'Доброе утро']) assert.equal(isObviousTelegramNoise(text, false), true, text);
  for (const text of ['тест 10 часов', 'Привет, аванс 100', 'Дима 10 часов', '100', '12345678901234567890123456', 'оплатил', '']) assert.equal(isObviousTelegramNoise(text, false), false, text);
});
test('never discards documents or photos even with a test caption', () => {
  assert.equal(isObviousTelegramNoise('тест', true), false);
});
