'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRussoReaction } = require('./russo-reactions');
function update(old_reaction = [], new_reaction = [{ type: 'emoji', emoji: '👍' }]) {
  return { update_id: 42, message_reaction: { chat: { id: -17 }, message_id: 24, user: { id: 31, is_bot: false }, date: 1795720000, old_reaction, new_reaction } };
}
test('records thumbs-up on a configured Russo message without executing payment', () => {
  assert.equal(parseRussoReaction(update(), ['-17']).action, 'thumb_added');
  assert.equal(parseRussoReaction(update(), ['-17']).status, 'needs_review');
  assert.equal(parseRussoReaction(update(), ['-18']), null);
});
test('records removal separately and ignores hearts, bot and anonymous reactions', () => {
  const thumb = [{ type: 'emoji', emoji: '👍' }];
  assert.equal(parseRussoReaction(update(thumb, []), ['-17']).action, 'thumb_removed');
  assert.equal(parseRussoReaction(update([], [{ type: 'emoji', emoji: '❤' }]), ['-17']), null);
  const bot = update(); bot.message_reaction.user.is_bot = true;
  assert.equal(parseRussoReaction(bot, ['-17']), null);
  const anonymous = update(); delete anonymous.message_reaction.user;
  assert.equal(parseRussoReaction(anonymous, ['-17']), null);
});
