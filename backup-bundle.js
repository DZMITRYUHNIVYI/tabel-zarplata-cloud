'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
function buildBackup(state, directory) {
  const wanted = new Set();
  const missing = [];
  for (const item of state.telegram?.inbox || []) {
    const name = item.source?.localFile;
    if (typeof name !== 'string' || !name) {
      if (item.source?.fileId) missing.push(`telegram-record:${String(item.id || item.source.updateId || 'unknown')}`);
      continue;
    }
    if (path.basename(name) !== name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Invalid source filename');
    wanted.add(name);
  }
  const attachments = [];
  let total = 0;
  for (const name of wanted) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid attachment');
    total += stat.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Attachments exceed backup size limit');
    const bytes = fs.readFileSync(file);
    attachments.push({ name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
  }
  const stateSha256 = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
  return { format: 'tabel-backup-v1', createdAt: new Date().toISOString(), stateSha256, state, attachments, missing };
}

function inspectBackup(bundle) {
  if (bundle?.format !== 'tabel-backup-v1' || !bundle.state || !Array.isArray(bundle.attachments) || !Array.isArray(bundle.missing)) throw new Error('Invalid backup format');
  if (crypto.createHash('sha256').update(JSON.stringify(bundle.state)).digest('hex') !== bundle.stateSha256) throw new Error('State integrity check failed');
  const seen = new Set();
  for (const file of bundle.attachments) {
    if (typeof file.name !== 'string' || path.basename(file.name) !== file.name || /[\\/]/.test(file.name) || seen.has(file.name)) throw new Error('Invalid filename');
    seen.add(file.name);
    if (typeof file.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('Invalid encoding');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Attachment integrity check failed');
  }
  return { attachments: bundle.attachments.length, missing: bundle.missing.length };
}
module.exports = { buildBackup, inspectBackup };
