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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const TELEGRAM_FILES_DIR = path.join(DATA_DIR, 'telegram-files');
const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;
const AI_PROCESSING = new Set();
const AI_QUEUE = [];
const AI_QUEUED = new Set();
const AI_CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.AI_CONCURRENCY || 2)));
const OPENAI_TIMEOUT_MS = Math.max(30_000, Number(process.env.OPENAI_TIMEOUT_MS || 120_000));

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
  // A stale tab must not silently change the server-side processing result.
  const incomingInbox = new Map((incoming.telegram?.inbox || []).map(item => [String(item.id), item]));
  const inboxStatusChanged = (current.telegram?.inbox || []).some(item => {
    const next = incomingInbox.get(String(item.id));
    return next && (
      String(next.status || '') !== String(item.status || '')
      || String(next.appliedAt || '') !== String(item.appliedAt || '')
      || Boolean(next.autoApplied) !== Boolean(item.autoApplied)
    );
  });
  const destructive = missingExistingRecords
    || inboxStatusChanged
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

function compactName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-ZА-ЯЁ0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function wordSimilarity(left, right) {
  const a = compactName(left).split(' ').filter(Boolean);
  const b = compactName(right).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const common = a.filter(word => b.includes(word)).length;
  return (2 * common) / (a.length + b.length);
}

function editDistance(left, right) {
  const a = compactName(left).replace(/ /g, '');
  const b = compactName(right).replace(/ /g, '');
  if (!a || !b) return Math.max(a.length, b.length);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

function nameSimilarity(left, right) {
  const a = compactName(left).replace(/ /g, '');
  const b = compactName(right).replace(/ /g, '');
  const spelling = a && b ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 0;
  return Math.max(wordSimilarity(left, right), spelling);
}

function projectTokenMatch(left, right) {
  const leftTokens = compactName(left).split(' ').filter(token => token.length >= 4);
  const rightTokens = compactName(right).split(' ').filter(token => token.length >= 4);
  const shared = leftTokens.filter(token => rightTokens.includes(token));
  return {
    count: new Set(shared).size,
    coverage: shared.length / Math.max(1, Math.min(leftTokens.length, rightTokens.length)),
    hasDistinctiveMatch: shared.some(token => token.length >= 8),
  };
}

function matchPerson(people, name) {
  const needle = compactName(name);
  if (!needle) return null;
  const exact = people.find(person => compactName(person.name) === needle);
  if (exact) return { person: exact, confidence: 1 };
  const ranked = people
    .map(person => ({ person, confidence: nameSimilarity(person.name, name) }))
    .sort((a, b) => b.confidence - a.confidence);
  return ranked[0]?.confidence >= 0.8 ? ranked[0] : null;
}

function matchProject(projects, name) {
  const needle = compactName(name);
  if (!needle) return null;
  const namesFor = project => [project.name, ...(Array.isArray(project.telegramAliases) ? project.telegramAliases : [])].filter(Boolean);
  const exact = projects.find(project => namesFor(project).some(projectName => compactName(projectName) === needle));
  if (exact) return { project: exact, confidence: 1 };
  const ranked = projects
    .map(project => {
      const candidates = namesFor(project).map(projectName => ({ confidence: nameSimilarity(projectName, name), tokens: projectTokenMatch(projectName, name) }));
      return { project, ...candidates.sort((a, b) => b.confidence - a.confidence)[0] };
    })
    .sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];
  if (!best) return null;
  if (best.confidence >= 0.75 || (best.tokens.count >= 2 && best.tokens.coverage >= 0.65 && best.tokens.hasDistinctiveMatch)) return best;
  // A city or site marker can be enough when it occurs in exactly one known project.
  const uniqueTokenMatch = best.tokens.count === 1 && best.tokens.coverage >= 0.9
    && namesFor(best.project).some(projectName => {
      const shared = projectTokenMatch(projectName, name);
      const token = compactName(projectName).split(' ').find(value => value.length >= 6 && compactName(name).split(' ').includes(value));
      return shared.count === 1 && token && projects.filter(project => namesFor(project).some(candidate => compactName(candidate).split(' ').includes(token))).length === 1;
    });
  if (uniqueTokenMatch) return { ...best, confidence: Math.max(best.confidence, 0.76) };
  return null;
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '')) ? String(value) : '';
}

function validDate(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : fallback;
}

function nextMonth(date) {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 7);
}

function receivedDate(record) {
  return String(record.receivedAt || new Date().toISOString()).slice(0, 10);
}

function isoWeekStart(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const start = new Date(jan4);
  start.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1) * 7);
  return start;
}

function inferredMonth(analysis, fallbackDate) {
  const direct = validMonth(analysis.month);
  if (direct) return direct;
  const periodStart = validDate(analysis.periodStart, '');
  if (periodStart) return periodStart.slice(0, 7);
  const week = Number(analysis.weekNumber);
  if (Number.isInteger(week) && week >= 1 && week <= 53) {
    const year = Number(String(fallbackDate).slice(0, 4)) || new Date().getUTCFullYear();
    return isoWeekStart(year, week).toISOString().slice(0, 7);
  }
  return '';
}

async function downloadTelegramAttachment(record) {
  const source = record.source || {};
  if (!source.fileId) return null;
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Не задан токен Telegram-бота.');
  if (Number(source.size || 0) > TELEGRAM_FILE_LIMIT) throw new Error('Файл больше 20 МБ.');
  const metaResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(source.fileId)}`);
  const meta = await metaResponse.json();
  if (!metaResponse.ok || !meta.ok || !meta.result?.file_path) throw new Error(meta.description || 'Telegram не отдал файл.');
  const fileResponse = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`);
  if (!fileResponse.ok) throw new Error('Не удалось скачать файл из Telegram.');
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  if (bytes.length > TELEGRAM_FILE_LIMIT) throw new Error('Файл больше 20 МБ.');
  fs.mkdirSync(TELEGRAM_FILES_DIR, { recursive: true });
  const extension = path.extname(source.fileName || meta.result.file_path || '').slice(0, 12) || '.bin';
  const filePath = path.join(TELEGRAM_FILES_DIR, `${record.id}${extension}`);
  fs.writeFileSync(filePath, bytes);
  return { bytes, filePath, mimeType: source.mimeType || fileResponse.headers.get('content-type') || 'application/octet-stream' };
}

function responseText(payload) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const fragments = [];
  for (const output of payload.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === 'string') fragments.push(content.text);
    }
  }
  return fragments.join('\n');
}

function jsonFromAi(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('ИИ вернул ответ не в формате JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function aiInstructions(record) {
  const purpose = record.kind;
  const timesheetRules = purpose === 'timesheet'
    ? `\n\nЭТО ТАБЕЛЬ. Это главная задача: внимательно прочитай КАЖДУЮ строку сотрудника и КАЖДУЮ колонку с датой. Обязательно заполни entries для всех людей, у которых есть ЯВНО УКАЗАННЫЕ ЧИСЛА часов. В dailyHours указывай только реальные часы напротив календарного дня; пустую ячейку считай 0. Не подменяй часы недельным итогом. Если у строки есть итог, добавь totalHours и сверь его с суммой dailyHours: при расхождении не придумывай часы. ВАЖНО: X, галочка, крестик, точка или иной знак присутствия БЕЗ числа часов не означает 8 часов и не должен становиться dailyHours. В таком случае поставь attendanceOnly: true, перечисли имена в excludedPeople и не придумывай часы. Если в шапке указана неделя, заполни weekNumber, periodStart и periodEnd. Если видны только даты без года, определи год по документу, подписи или дате отправки. Не исключай человека только потому, что он не известен программе: запиши его имя в entries, а также добавь в excludedPeople.\n\nДобавь поля weekNumber (номер недели или 0), periodStart (YYYY-MM-DD или пустая строка), periodEnd (YYYY-MM-DD или пустая строка), attendanceOnly (true, если есть только отметки присутствия без численных часов). Для каждой записи entries при видимом итоге добавь totalHours.`
    : '';
  return `Ты извлекаешь данные для программы учёта рабочих часов и выплат. Язык документа может быть русским, немецким, польским, украинским или английским.\n\nТип входящего чата: ${purpose}.\n\nВерни ТОЛЬКО корректный JSON без Markdown. Используй поля:\n{\n  "documentType": "timesheet|salary_advance|company_advance|receipt|compensation|unknown",\n  "confidence": 0.0,\n  "summary": "кратко по-русски",\n  "projectName": "название объекта или пустая строка",\n  "month": "YYYY-MM или пустая строка",\n  "weekNumber": 0,\n  "periodStart": "YYYY-MM-DD или пустая строка",\n  "periodEnd": "YYYY-MM-DD или пустая строка",\n  "date": "YYYY-MM-DD или пустая строка",\n  "personName": "ФАМИЛИЯ ИМЯ или пустая строка",\n  "amount": 0,\n  "currency": "EUR",\n  "category": "топливо|инструмент|материалы|билет|другое",\n  "notes": "что куплено или за что деньги",\n  "entries": [{"personName":"ФАМИЛИЯ ИМЯ", "dailyHours":[{"day":1,"hours":8}]}],\n  "excludedPeople": ["люди в документе, которых нельзя уверенно сопоставить"]\n}\n\nПравила: не выдумывай значения. В чате рабочих денег отличи выдачу денег сотруднику от чека за уже выданные средства. В чате компенсаций это личные деньги сотрудника, которые фирма должна вернуть. При неопределённости укажи documentType unknown и низкую confidence.${timesheetRules}`;
}

async function askOpenAi(record, attachment) {
  if (!OPENAI_API_KEY) throw new Error('Не задан ключ OpenAI API.');
  const content = [{ type: 'input_text', text: `${aiInstructions(record)}\n\nПодпись к сообщению: ${record.source?.caption || 'нет'}` }];
  if (attachment) {
    const dataUrl = `data:${attachment.mimeType};base64,${attachment.bytes.toString('base64')}`;
    if (attachment.mimeType.startsWith('image/')) content.push({ type: 'input_image', image_url: dataUrl, detail: 'high' });
    else content.push({ type: 'input_file', filename: record.source?.fileName || 'telegram-file', file_data: dataUrl });
  }
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('ИИ не ответил вовремя. Документ можно обработать повторно.'));
    }, OPENAI_TIMEOUT_MS);
  });
  try {
    const request = fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, input: [{ role: 'user', content }], temperature: 0 }),
      signal: controller.signal,
    });
    const response = await Promise.race([request, timeout]);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || 'OpenAI не принял документ.');
    return jsonFromAi(responseText(payload));
  } catch (error) {
    if (timedOut || error.name === 'AbortError') throw new Error('ИИ не ответил вовремя. Документ можно обработать повторно.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildAiDraft(state, record, analysis) {
  const received = receivedDate(record);
  const purpose = record.kind;
  const defaultType = purpose === 'timesheet' ? 'timesheet' : purpose === 'salary_advance' ? 'salary_advance' : purpose === 'compensation' ? 'compensation' : 'unknown';
  const documentType = purpose === 'company_funds'
    ? ['company_advance', 'receipt'].includes(analysis.documentType) ? analysis.documentType : 'unknown'
    : defaultType;
  const personMatch = matchPerson(state.people || [], analysis.personName);
  const projectMatch = matchProject(state.projects || [], analysis.projectName);
  const draft = {
    documentType,
    confidence: Math.max(0, Math.min(1, Number(analysis.confidence) || 0)),
    summary: String(analysis.summary || ''),
    personName: String(analysis.personName || ''),
    personId: personMatch?.person.id || '',
    projectName: String(analysis.projectName || ''),
    projectId: projectMatch?.project.id || '',
    month: inferredMonth(analysis, received),
    weekNumber: Number(analysis.weekNumber) || 0,
    periodStart: validDate(analysis.periodStart, ''),
    periodEnd: validDate(analysis.periodEnd, ''),
    date: validDate(analysis.date, received),
    amount: Math.max(0, Number(analysis.amount) || 0),
    currency: String(analysis.currency || 'EUR').toUpperCase() === 'EUR' ? '€' : String(analysis.currency || '€'),
    category: String(analysis.category || 'Другое'),
    notes: String(analysis.notes || ''),
    attendanceOnly: Boolean(analysis.attendanceOnly),
    excludedPeople: Array.isArray(analysis.excludedPeople) ? analysis.excludedPeople.map(String).filter(Boolean).slice(0, 50) : [],
  };
  draft.reimbursementMonth = nextMonth(draft.date);
  if (documentType === 'timesheet') {
    const dayCount = draft.month ? new Date(Number(draft.month.slice(0, 4)), Number(draft.month.slice(5, 7)), 0).getDate() : 31;
    const entries = [];
    for (const row of Array.isArray(analysis.entries) ? analysis.entries : []) {
      const match = matchPerson(state.people || [], row?.personName);
      if (!match) {
        if (row?.personName) draft.excludedPeople.push(String(row.personName));
        continue;
      }
      const hours = Array.from({ length: dayCount }, () => 0);
      for (const item of Array.isArray(row.dailyHours) ? row.dailyHours : []) {
        const day = Number(item?.day);
        const hoursValue = Number(item?.hours);
        if (day >= 1 && day <= dayCount && Number.isFinite(hoursValue) && hoursValue >= 0 && hoursValue <= 24) hours[day - 1] = hoursValue;
      }
      const statedTotal = Number(row?.totalHours) || 0;
      const extractedTotal = hours.reduce((total, value) => total + value, 0);
      if (statedTotal > 0 && Math.abs(statedTotal - extractedTotal) > 0.1) {
        draft.excludedPeople.push(String(row.personName));
        continue;
      }
      entries.push({ personId: match.person.id, personName: match.person.name, hours });
    }
    draft.entries = entries;
    const recognized = new Set(entries.map(entry => compactName(entry.personName)));
    draft.excludedPeople = [...new Set(draft.excludedPeople.filter(name => {
      if (recognized.has(compactName(name))) return false;
      return !matchPerson(state.people || [], name);
    }))];
  }
  return draft;
}

function isReadyDraft(record) {
  const draft = record.ai || {};
  const spansMonths = draft.periodStart && draft.periodEnd && draft.periodStart.slice(0, 7) !== draft.periodEnd.slice(0, 7);
  if (record.kind === 'timesheet') return !spansMonths && !draft.attendanceOnly && Boolean(draft.projectId && draft.month && draft.entries?.length);
  if (record.kind === 'company_funds' && !['company_advance', 'receipt'].includes(draft.documentType)) return false;
  return Boolean(draft.personId && Number(draft.amount) > 0);
}

function serverUid() {
  return `srv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function daysInMonth(month) {
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
}

function autoApplyTimesheet(state, record) {
  const draft = record.ai || {};
  if (record.kind !== 'timesheet' || draft.attendanceOnly || !isReadyDraft(record)) return false;
  if (state.telegram?.autoApplyTimesheets === false) return false;
  const dayCount = daysInMonth(draft.month);
  const sourceAlreadyUsed = (state.timesheets || []).some(sheet => sheet.sourceIncomingId === record.id || (sheet.sourceIncomingIds || []).includes(record.id));
  if (sourceAlreadyUsed) return false;
  const knownPeople = new Set((state.people || []).map(person => person.id));
  const project = (state.projects || []).find(item => item.id === draft.projectId);
  if (project && draft.projectName) {
    const aliases = Array.isArray(project.telegramAliases) ? project.telegramAliases : [];
    if (!aliases.some(alias => compactName(alias) === compactName(draft.projectName)) && compactName(project.name) !== compactName(draft.projectName)) {
      project.telegramAliases = [...aliases, draft.projectName];
    }
  }
  const entries = (draft.entries || [])
    .filter(entry => knownPeople.has(entry.personId))
    .map(entry => ({
      personId: entry.personId,
      hours: Array.from({ length: dayCount }, (_, index) => Number(entry.hours?.[index]) || 0),
    }));
  if (!entries.length) return false;

  let sheet = (state.timesheets || []).find(item => item.projectId === draft.projectId && validMonth(item.month || item.weekStart?.slice(0, 7)) === draft.month);
  if (!sheet) {
    sheet = {
      id: serverUid(),
      projectId: draft.projectId,
      month: draft.month,
      weekStart: `${draft.month}-01`,
      notes: '',
      photo: '',
      photos: [],
      entries: [],
      sourceIncomingIds: [],
      status: 'draft',
    };
    state.timesheets = Array.isArray(state.timesheets) ? state.timesheets : [];
    state.timesheets.push(sheet);
  }
  sheet.entries = Array.isArray(sheet.entries) ? sheet.entries : [];
  for (const incoming of entries) {
    let target = sheet.entries.find(entry => entry.personId === incoming.personId);
    if (!target) {
      target = { personId: incoming.personId, hours: Array.from({ length: dayCount }, () => 0) };
      sheet.entries.push(target);
    }
    target.hours = Array.from({ length: dayCount }, (_, index) => {
      const incomingHours = Number(incoming.hours?.[index]) || 0;
      return incomingHours > 0 ? incomingHours : Number(target.hours?.[index]) || 0;
    });
  }
  const origin = `Telegram: ${record.source?.chatTitle || 'Табели'}`;
  if (!String(sheet.notes || '').includes(origin)) sheet.notes = [sheet.notes, origin].filter(Boolean).join('\n');
  sheet.sourceIncomingIds = [...new Set([...(sheet.sourceIncomingIds || []), record.id])];
  record.status = 'applied';
  record.autoApplied = true;
  record.appliedAt = new Date().toISOString();
  return true;
}

function stateBeforeTimesheetApplication(recordId) {
  if (!fs.existsSync(HISTORY_DIR)) return null;
  const files = fs.readdirSync(HISTORY_DIR).filter(name => name.endsWith('.json')).sort().reverse();
  for (const file of files) {
    try {
      const snapshot = readJson(path.join(HISTORY_DIR, file));
      const record = snapshot?.telegram?.inbox?.find(item => item.id === recordId);
      if (record && record.status !== 'applied' && !record.autoApplied) return snapshot;
    } catch {
      // A corrupted historical snapshot must not stop the live queue.
    }
  }
  return null;
}

function rollbackTimesheetApplication(state, record) {
  const draft = record.ai || {};
  const before = stateBeforeTimesheetApplication(record.id);
  const sheet = (state.timesheets || []).find(item => item.projectId === draft.projectId && validMonth(item.month || item.weekStart?.slice(0, 7)) === draft.month);
  const previousSheet = before?.timesheets?.find(item => item.id === sheet?.id)
    || before?.timesheets?.find(item => item.projectId === draft.projectId && validMonth(item.month || item.weekStart?.slice(0, 7)) === draft.month);
  if (!before || !sheet) return false;
  for (const sourceEntry of draft.entries || []) {
    const target = (sheet.entries || []).find(entry => entry.personId === sourceEntry.personId);
    if (!target) continue;
    const prior = (previousSheet?.entries || []).find(entry => entry.personId === sourceEntry.personId);
    target.hours = Array.from({ length: Math.max(target.hours?.length || 0, sourceEntry.hours?.length || 0) }, (_, index) => {
      const currentValue = Number(target.hours?.[index]) || 0;
      const appliedValue = Number(sourceEntry.hours?.[index]) || 0;
      if (appliedValue > 0 && currentValue === appliedValue) return Number(prior?.hours?.[index]) || 0;
      return currentValue;
    });
  }
  sheet.entries = (sheet.entries || []).filter(entry => entry.hours?.some(value => Number(value) > 0) || (previousSheet?.entries || []).some(item => item.personId === entry.personId));
  sheet.sourceIncomingIds = (sheet.sourceIncomingIds || []).filter(id => id !== record.id);
  record.autoApplied = false;
  delete record.appliedAt;
  record.retractedAt = new Date().toISOString();
  return true;
}

async function processTelegramIncoming(recordId) {
  if (AI_PROCESSING.has(recordId)) return { queued: true };
  AI_PROCESSING.add(recordId);
  try {
    const current = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
    const record = current?.telegram?.inbox?.find(item => item.id === recordId);
    if (!record) throw new Error('Сообщение не найдено.');
    if (record.kind === 'unconfigured') throw new Error('Сначала назначьте этому чату тип.');
    record.status = 'processing';
    record.processingStartedAt = new Date().toISOString();
    delete record.error;
    writeSystemState(current);
    const attachment = await downloadTelegramAttachment(record);
    const latest = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
    const latestRecord = latest?.telegram?.inbox?.find(item => item.id === recordId);
    if (!latest || !latestRecord) throw new Error('Сообщение изменилось во время обработки.');
    const analysis = await askOpenAi(latestRecord, attachment);
    if (latestRecord.autoApplied && !rollbackTimesheetApplication(latest, latestRecord)) {
      throw new Error('Не удалось безопасно откатить предыдущий автоматический расчёт этого табеля.');
    }
    latestRecord.ai = buildAiDraft(latest, latestRecord, analysis);
    latestRecord.status = isReadyDraft(latestRecord) ? 'ready' : 'needs_review';
    const autoApplied = autoApplyTimesheet(latest, latestRecord);
    latestRecord.processedAt = new Date().toISOString();
    if (attachment) latestRecord.source.localFile = path.basename(attachment.filePath);
    writeSystemState(latest);
    return { ok: true, status: latestRecord.status, autoApplied, record: latestRecord };
  } catch (error) {
    const current = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
    const record = current?.telegram?.inbox?.find(item => item.id === recordId);
    if (record) {
      record.status = 'failed';
      record.error = error.message || 'Ошибка обработки ИИ.';
      writeSystemState(current);
    }
    return { ok: false, error: error.message || 'Ошибка обработки ИИ.' };
  } finally {
    AI_PROCESSING.delete(recordId);
  }
}

function queueTelegramProcessing(recordId) {
  if (AI_PROCESSING.has(recordId) || AI_QUEUED.has(recordId)) return;
  AI_QUEUE.push(recordId);
  AI_QUEUED.add(recordId);
  drainAiQueue();
}

function drainAiQueue() {
  while (AI_PROCESSING.size < AI_CONCURRENCY && AI_QUEUE.length) {
    const recordId = AI_QUEUE.shift();
    AI_QUEUED.delete(recordId);
    void processTelegramIncoming(recordId)
      .catch(error => console.error(`Telegram AI processing failed: ${error.message}`))
      .finally(drainAiQueue);
  }
}

function recoverInterruptedAiProcessing() {
  if (!fs.existsSync(STATE_FILE)) return;
  const current = readJson(STATE_FILE);
  const interrupted = (current.telegram?.inbox || []).filter(item => item.status === 'processing');
  if (!interrupted.length) return;
  interrupted.forEach(item => {
    item.status = 'received';
    item.error = 'Обработка восстановлена после перезапуска сервера.';
  });
  writeSystemState(current);
  interrupted.forEach(item => queueTelegramProcessing(item.id));
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
      if (result.record?.kind && result.record.kind !== 'unconfigured') queueTelegramProcessing(result.record.id);
      return send(res, 200, JSON.stringify({ ok: true, ...result }), 'application/json; charset=utf-8');
    }

    const telegramProcessMatch = url.pathname.match(/^\/api\/telegram\/process\/([^/]+)$/);
    if (req.method === 'POST' && telegramProcessMatch) {
      const result = await processTelegramIncoming(decodeURIComponent(telegramProcessMatch[1]));
      return send(res, result.ok ? 200 : 422, JSON.stringify(result), 'application/json; charset=utf-8');
    }

    const telegramSourceMatch = url.pathname.match(/^\/api\/telegram\/source\/([^/]+)$/);
    if (req.method === 'GET' && telegramSourceMatch) {
      const current = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) : null;
      const record = current?.telegram?.inbox?.find(item => item.id === decodeURIComponent(telegramSourceMatch[1]));
      const fileName = path.basename(record?.source?.localFile || '');
      const filePath = fileName ? path.join(TELEGRAM_FILES_DIR, fileName) : '';
      if (!record || !fileName || !filePath.startsWith(`${TELEGRAM_FILES_DIR}${path.sep}`) || !fs.existsSync(filePath)) return send(res, 404, 'Источник не найден');
      return serveFile(res, filePath, record.source?.mimeType || 'application/octet-stream');
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
  recoverInterruptedAiProcessing();
  void registerTelegramWebhook();
});
