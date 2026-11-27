'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBackup, inspectBackup } = require('./backup-bundle');
test('includes originals, records missing files and detects corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabel-backup-test-'));
  fs.writeFileSync(path.join(dir, 'one.jpg'), 'original');
  const state = { people: [{ id: '1' }], telegram: { inbox: [{ source: { localFile: 'one.jpg' } }, { source: { localFile: 'missing.pdf' } }] } };
  const bundle = buildBackup(state, dir);
  assert.deepEqual(inspectBackup(bundle), { attachments: 1, missing: 1 });
  assert.equal(bundle.state.people.length, 1);
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'tabel-restore-test-'));
  for (const file of bundle.attachments) fs.writeFileSync(path.join(restored, file.name), Buffer.from(file.base64, 'base64'));
  assert.equal(fs.readFileSync(path.join(restored, 'one.jpg'), 'utf8'), 'original');
  const changed = structuredClone(bundle);
  changed.state.people[0].id = '2';
  assert.throws(() => inspectBackup(changed), /State integrity/);
  bundle.attachments[0].base64 = Buffer.from('altered').toString('base64');
  assert.throws(() => inspectBackup(bundle), /integrity/);
});
test('reports Telegram files that were never downloaded', () => {
  const result = buildBackup({ telegram: { inbox: [{ id: 'record', source: { fileId: 'telegram-file-id' } }] } }, os.tmpdir());
  assert.equal(result.missing.length, 1);
});
test('rejects paths outside attachments directory', () => {
  assert.throws(() => buildBackup({ telegram: { inbox: [{ source: { localFile: '../secret' } }] } }, os.tmpdir()), /filename/);
});
