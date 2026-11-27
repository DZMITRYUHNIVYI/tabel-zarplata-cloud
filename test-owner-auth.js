'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { createOwnerAuth } = require('./owner-auth');

function passwordHash(password) {
  const salt = Buffer.alloc(16, 7);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

test('invalid configuration never grants access', () => {
  const auth = createOwnerAuth({ passwordHash: '' });
  assert.equal(auth.configured, false);
  assert.equal(auth.authenticate('anything', 'client'), null);
  assert.equal(auth.session({ headers: {} }), false);
});

test('valid password creates a protected expiring session', () => {
  let now = 1000;
  const auth = createOwnerAuth({ passwordHash: passwordHash('correct horse battery'), now: () => now });
  assert.equal(auth.authenticate('wrong', 'client'), null);
  const token = auth.authenticate('correct horse battery', 'client');
  assert.ok(token);
  const cookie = auth.cookie(token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const req = { headers: { cookie } };
  assert.equal(auth.session(req), true);
  now += 8 * 60 * 60 * 1000;
  assert.equal(auth.session(req), false);
});

test('logout invalidates session and repeated failures are limited', () => {
  const auth = createOwnerAuth({ passwordHash: passwordHash('correct horse battery') });
  const token = auth.authenticate('correct horse battery', 'a');
  const req = { headers: { cookie: auth.cookie(token) } };
  auth.logout(req);
  assert.equal(auth.session(req), false);
  for (let i = 0; i < 8; i++) assert.equal(auth.authenticate('wrong', 'b'), null);
  assert.equal(auth.authenticate('correct horse battery', 'b'), null);
});

test('accepts a PBKDF2 hash from the local password setup form', () => {
  const salt = Buffer.alloc(16, 3);
  const key = crypto.pbkdf2Sync('a sufficiently long password', salt, 600000, 32, 'sha256');
  const hash = `pbkdf2-sha256-600000$${salt.toString('hex')}$${key.toString('hex')}`;
  const auth = createOwnerAuth({ passwordHash: hash });
  assert.equal(auth.configured, true);
  assert.ok(auth.authenticate('a sufficiently long password', 'client'));
});
