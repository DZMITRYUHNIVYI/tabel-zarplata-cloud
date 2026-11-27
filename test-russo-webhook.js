'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('webhook records a reaction once without changing settlements', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabel-reaction-test-'));
  const state = { people: [], projects: [], timesheets: [], invoices: [], settlements: [], telegram: { chats: [{ chatId: '-17', purpose: 'russo' }], inbox: [] } };
  fs.writeFileSync(path.join(tmp, 'tabel-state.json'), JSON.stringify(state));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['tabel-server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp, TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: 'test-secret', OPENAI_API_KEY: '', REQUIRE_OWNER_AUTH: '0' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let available = false;
    for (let i = 0; i < 60; i++) {
      try { available = (await fetch(`${base}/api/health`)).ok; if (available) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(available, 'test server did not start');
    const update = { update_id: 42, message_reaction: { chat: { id: -17 }, message_id: 24, user: { id: 31, is_bot: false }, date: 1795720000, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-secret' }, body: JSON.stringify(update) });
      assert.equal(response.status, 200);
    }
    const result = await (await fetch(`${base}/api/state`)).json();
    assert.equal(result.state.telegram.inbox.length, 1);
    assert.equal(result.state.telegram.inbox[0].reaction.action, 'thumb_added');
    assert.deepEqual(result.state.settlements, []);
  } finally { child.kill(); }
});
