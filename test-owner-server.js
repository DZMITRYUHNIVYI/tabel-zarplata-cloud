'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('owner gate protects data, writes, files and leaves webhook protected separately', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabel-owner-test-'));
  fs.writeFileSync(path.join(tmp, 'tabel-state.json'), JSON.stringify({ people: [], projects: [], timesheets: [], invoices: [], telegram: { chats: [], inbox: [] } }));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const salt = Buffer.alloc(16, 9);
  const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync('example-password', salt, 64).toString('hex')}`;
  const child = spawn(process.execPath, ['tabel-server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp, TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: 'test-secret', OPENAI_API_KEY: '', PUBLIC_BASE_URL: base, REQUIRE_OWNER_AUTH: '1', OWNER_PASSWORD_HASH: hash, OWNER_INSECURE_LOCAL_COOKIE: '1' }, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready);
    const mode = await fetch(`${base}/api/auth-mode`, { headers: { origin: 'null' } });
    assert.equal(mode.headers.get('access-control-allow-origin'), '*');
    assert.equal((await mode.json()).ownerLoginRequired, true);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/telegram/source/test`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: 'https://elsewhere.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'example-password' }) })).status, 403);
    assert.equal((await fetch(`${base}/api/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'example-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST', headers: { cookie, origin: 'https://elsewhere.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, origin: base } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 401);
  } finally { child.kill(); }
});
