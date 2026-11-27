'use strict';

// Only unambiguous conversational messages are ignored; attachments always pass.
function isObviousTelegramNoise(text, hasAttachment) {
  if (hasAttachment) return false;
  const normalized = String(text || '').normalize('NFKC').toLocaleLowerCase('ru-RU')
    .trim().replace(/[.!?,…\s]+$/u, '').trim();
  return /^(?:тест|test|тестовое сообщение|проверка связи|ку-ку|куку|привет|здравствуйте|добрый день|доброе утро|добрый вечер|спасибо|благодарю|ок|окей|okay|ok)$/u.test(normalized);
}

module.exports = { isObviousTelegramNoise };
