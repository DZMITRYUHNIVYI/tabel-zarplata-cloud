const http = require('http');
const fs = require('fs');
const path = require('path');

const portArg = process.argv.find(arg => arg.startsWith('--port='));
const PORT = Number(process.env.PORT || (portArg ? portArg.split('=')[1] : 8765));
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const APP_FILE = path.join(ROOT, 'tabel-zarplata-app.html');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'tabel-state.json');
const SEED_STATE_FILE = path.join(ROOT, 'data', 'tabel-state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'tabel-state.backup.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const TEMP_FILE = path.join(DATA_DIR, 'tabel-state.tmp.json');
const MAX_BODY_SIZE = 500 * 1024 * 1024;
const HISTORY_KEEP = 500;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureSeedState() {
  if (fs.existsSync(STATE_FILE) || !fs.existsSync(SEED_STATE_FILE)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(SEED_STATE_FILE, STATE_FILE);
  console.log('Initialized persistent data from the packaged state');
}

function totalHours(state) {
  return (state?.timesheets || []).reduce((sum, sheet) => {
    return sum + (sheet.entries || []).reduce((rowSum, entry) => {
      return rowSum + (entry.hours || []).reduce((hourSum, hour) => hourSum + (Number(hour) || 0), 0);
    }, 0);
  }, 0);
}

function stateStats(state) {
  return {
    people: (state?.people || []).length,
    projects: (state?.projects || []).length,
    timesheets: (state?.timesheets || []).length,
    entries: (state?.timesheets || []).reduce((sum, sheet) => sum + (sheet.entries || []).length, 0),
    monthlyHours: (state?.monthlyHours || []).length,
    invoices: (state?.invoices || []).length,
    settlements: (state?.settlements || []).length,
    advances: (state?.advances || []).length,
    expenses: (state?.expenses || []).length,
    telegramInbox: (state?.telegram?.inbox || []).length,
    hours: Number(totalHours(state).toFixed(2)),
  };
}

function score(stats) {
  return stats.people * 1000 + stats.projects * 1000 + stats.timesheets * 80 + stats.entries * 10 + stats.monthlyHours * 10 + stats.invoices * 10 + stats.settlements + stats.advances + stats.expenses + stats.telegramInbox + stats.hours / 100;
}

function idsMissing(current = [], incoming = []) {
  const incomingIds = new Set(incoming.map(item => item.id).filter(Boolean));
  return current.some(item => item.id && !incomingIds.has(item.id));
}

function sheetEntriesMissing(current = [], incoming = []) {
  const incomingSheets = new Map(incoming.map(sheet => [sheet.id, sheet]));
  return current.some(sheet => {
    const nextSheet = incomingSheets.get(sheet.id);
    if (!nextSheet) return true;
    const nextPeople = new Set((nextSheet.entries || []).map(entry => entry.personId));
    return (sheet.entries || []).some(entry => entry.personId && !nextPeople.has(entry.personId));
  });
}

function revisionOf(state) {
  return state?._serverRevision || null;
}

function cleanClientState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy._clientBaseRevision;
  return copy;
}

function stampState(state, previousRevision) {
  state._serverRevision = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state._savedAt = new Date().toISOString();
  state._previousRevision = previousRevision || null;
  return state;
}

function readState() {
  ensureSeedState();
  if (!fs.existsSync(STATE_FILE)) return { empty: true, state: null, revision: null, stats: stateStats(null) };
  const state = readJson(STATE_FILE);
  return { empty: false, state, revision: revisionOf(state), savedAt: state._savedAt || null, stats: stateStats(state) };
}

function healthState() {
  const payload = readState();
  return {
    ok: true,
    empty: payload.empty,
    revision: payload.revision,
    savedAt: payload.savedAt,
    stats: payload.stats,
    dataDir: DATA_DIR,
  };
}

function copyHistorySnapshot() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(STATE_FILE, path.join(HISTORY_DIR, `tabel-state-${stamp}.json`));
  const historyFiles = fs.readdirSync(HISTORY_DIR).filter(name => name.endsWith('.json')).sort().reverse();
  historyFiles.slice(HISTORY_KEEP).forEach(name => fs.unlinkSync(path.join(HISTORY_DIR, name)));
}

function validateIncomingState(current, incoming, clientBaseRevision) {
  if (!current) return { ok: true };
  const currentRevision = revisionOf(current);
  const stale = currentRevision ? clientBaseRevision !== currentRevision : false;
  if (!stale) return { ok: true };
  const before = stateStats(current);
  const after = stateStats(incoming);
  const missingExistingRecords = idsMissing(current.people, incoming.people)
    || idsMissing(current.projects, incoming.projects)
    || idsMissing(current.timesheets, incoming.timesheets)
    || idsMissing(current.monthlyHours, incoming.monthlyHours)
    || idsMissing(current.invoices, incoming.invoices)
    || idsMissing(current.settlements, incoming.settlements)
    || idsMissing(current.advances, incoming.advances)
    || idsMissing(current.expenses, incoming.expenses)
    || idsMissing(current.telegram?.inbox, incoming.telegram?.inbox)
    || sheetEntriesMissing(current.timesheets, incoming.timesheets);
  const destructive = missingExistingRecords
    || after.people < before.people
    || after.projects < before.projects
    || after.timesheets < before.timesheets
    || after.entries < before.entries
    || after.monthlyHours < before.monthlyHours
    || after.invoices < before.invoices
    || after.advances < before.advances
    || after.expenses < before.expenses
    || after.telegramInbox < before.telegramInbox
    || after.hours + 0.01 < before.hours
    || score(after) + 0.01 < score(before);
  if (!destructive) return { ok: true };
  return {
    ok: false,
    reason: 'stale_destructive_write',
    message: 'Данные на сервере новее. Старая вкладка не может перезаписать часы или удалить записи.',
    currentStats: before,
    incomingStats: after,
  };
}

function writeState(payload) {
  ensureSeedState();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
  const incoming = cleanClientState(payload);
  const clientBaseRevision = payload._clientBaseRevision || null;
  const validation = validateIncomingState(current, incoming, clientBaseRevision);
  if (!validation.ok) return { ok: false, status: 409, ...validation, current };
  const previousRevision = revisionOf(current);
  const nextState = stampState(incoming, previousRevision);
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, BACKUP_FILE);
    copyHistorySnapshot();
  }
  fs.writeFileSync(TEMP_FILE, JSON.stringify(nextState, null, 2), 'utf8');
  fs.copyFileSync(TEMP_FILE, STATE_FILE);
  fs.unlinkSync(TEMP_FILE);
  return { ok: true, revision: revisionOf(nextState), savedAt: nextState._savedAt, stats: stateStats(nextState) };
}

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, 'Not found');
    send(res, 200, data, type);
  });
}

function writeSystemState(nextState) {
  ensureSeedState();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
  const next = stampState(nextState, revisionOf(current));
  if (current) {
    fs.copyFileSync(STATE_FILE, BACKUP_FILE);
    copyHistorySnapshot();
  }
  fs.writeFileSync(TEMP_FILE, JSON.stringify(next, null, 2), 'utf8');
  fs.copyFileSync(TEMP_FILE, STATE_FILE);
  fs.unlinkSync(TEMP_FILE);
  return next;
}

function telegramAttachment(message) {
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  const document = message.document || null;
  if (photo) return { fileId: photo.file_id, fileName: 'Фото табеля', mimeType: 'image/jpeg', size: photo.file_size || 0 };
  if (document) return { fileId: document.file_id, fileName: document.file_name || 'Документ', mimeType: document.mime_type || '', size: document.file_size || 0 };
  return null;
}

function messageKind(state, chatId) {
  const config = (state.telegram?.chats || []).find(chat => String(chat.chatId) === String(chatId));
  return ['timesheet', 'salary_advance', 'company_funds', 'advance', 'receipt', 'compensation'].includes(config?.purpose) ? config.purpose : 'unconfigured';
}

function appendTelegramIncoming(update) {
  const message = update.message || update.channel_post;
  if (!message || !message.chat) return { ignored: true };
  ensureSeedState();
  const current = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : { people: [], projects: [], timesheets: [], invoices: [], monthlyHours: [], settlements: [], advances: [], expenses: [], telegram: { chats: [], inbox: [] } };
  current.telegram = current.telegram && typeof current.telegram === 'object' ? current.telegram : {};
  current.telegram.chats = Array.isArray(current.telegram.chats) ? current.telegram.chats : [];
  current.telegram.inbox = Array.isArray(current.telegram.inbox) ? current.telegram.inbox : [];
  const updateId = String(update.update_id || `${message.chat.id}-${message.message_id}`);
  if (current.telegram.inbox.some(item => String(item.source?.updateId) === updateId)) return { duplicate: true };
  const attachment = telegramAttachment(message);
  const caption = String(message.caption || message.text || '').trim();
  if (!attachment && !caption) return { ignored: true };
  const record = {
    id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: messageKind(current, message.chat.id),
    status: 'received',
    receivedAt: new Date().toISOString(),
    source: {
      updateId,
      chatId: String(message.chat.id),
      chatTitle: message.chat.title || message.chat.username || 'Telegram',
      messageId: message.message_id,
      caption,
      ...attachment,
    },
    ai: {},
  };
  current.telegram.inbox.unshift(record);
  writeSystemState(current);
  return { record };
}

async function registerTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !PUBLIC_BASE_URL) {
    console.log('Telegram webhook: not configured');
    return;
  }
  const webhookUrl = `${PUBLIC_BASE_URL}/api/telegram/webhook`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'channel_post']
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram rejected the webhook');
    console.log(`Telegram webhook: ${webhookUrl}`);
  } catch (error) {
    console.error(`Telegram webhook setup failed: ${error.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, JSON.stringify(readState()), 'application/json; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      return send(res, 200, JSON.stringify(healthState()), 'application/json; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/state') {
      const payload = JSON.parse(await readBody(req));
      if (!payload || typeof payload !== 'object') return send(res, 400, 'Bad state');
      const result = writeState(payload);
      if (!result.ok) {
        return send(res, result.status || 409, JSON.stringify(result), 'application/json; charset=utf-8');
      }
      return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
      if (!TELEGRAM_WEBHOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== TELEGRAM_WEBHOOK_SECRET) {
        return send(res, 403, 'Forbidden');
      }
      const update = JSON.parse(await readBody(req));
      const result = appendTelegramIncoming(update);
      return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/tabel-zarplata-app.html')) {
      return serveFile(res, APP_FILE, 'text/html; charset=utf-8');
    }

    return send(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return send(res, 500, 'Server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tabel app server: http://localhost:${PORT}/tabel-zarplata-app.html`);
  void registerTelegramWebhook();
});
