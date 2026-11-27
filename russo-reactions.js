'use strict';

// Transform a Telegram reaction update into an auditable event; never mark payments here.
function parseRussoReaction(update, allowedChatIds) {
  const reaction = update?.message_reaction;
  if (!reaction || !Array.isArray(allowedChatIds) || !allowedChatIds.map(String).includes(String(reaction.chat?.id))) return null;
  if (!Number.isSafeInteger(reaction.message_id) || !Number.isSafeInteger(update.update_id)) return null;
  const userId = reaction.user?.id;
  if (!Number.isSafeInteger(userId) || reaction.user?.is_bot) return null;
  const hasThumb = reactions => Array.isArray(reactions) && reactions.some(item => item?.type === 'emoji' && item.emoji === '👍');
  const before = hasThumb(reaction.old_reaction);
  const after = hasThumb(reaction.new_reaction);
  if (before === after) return null;
  return {
    updateId: String(update.update_id), chatId: String(reaction.chat.id), messageId: reaction.message_id,
    actorId: String(userId), occurredAt: Number.isFinite(reaction.date) && Math.abs(reaction.date) <= 8640000000000 ? new Date(reaction.date * 1000).toISOString() : null,
    action: after ? 'thumb_added' : 'thumb_removed', status: 'needs_review'
  };
}
module.exports = { parseRussoReaction };
