'use strict';

const crypto = require('crypto');

// Password hashes use scrypt$salt-hex$derived-key-hex. Sessions expire on restart.
function createOwnerAuth({ passwordHash, secureCookie = true, now = () => Date.now() }) {
  const parts = String(passwordHash || '').split('$');
  const validConfig = parts.length === 3 && /^[a-f0-9]{32}$/i.test(parts[1])
    && ((parts[0] === 'scrypt' && /^[a-f0-9]{128}$/i.test(parts[2]))
      || (parts[0] === 'pbkdf2-sha256-600000' && /^[a-f0-9]{64}$/i.test(parts[2])));
  const sessions = new Map();
  const attempts = new Map();
  const lifetime = 8 * 60 * 60 * 1000;

  function authenticate(password, client) {
    const time = now();
    const previous = attempts.get(client) || [];
    const recent = previous.filter(value => time - value < 15 * 60 * 1000);
    if (recent.length >= 8) return null;
    if (!validConfig || typeof password !== 'string' || password.length > 1024) return null;
    const actual = parts[0] === 'scrypt'
      ? crypto.scryptSync(password, Buffer.from(parts[1], 'hex'), 64)
      : crypto.pbkdf2Sync(password, Buffer.from(parts[1], 'hex'), 600000, 32, 'sha256');
    const expected = Buffer.from(parts[2], 'hex');
    if (!crypto.timingSafeEqual(actual, expected)) {
      recent.push(time);
      attempts.set(client, recent);
      return null;
    }
    attempts.delete(client);
    for (const [token, expires] of sessions) if (expires <= time) sessions.delete(token);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, time + lifetime);
    return token;
  }

  function session(req) {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)tabel_owner=([a-f0-9]{64})(?:;|$)/);
    if (!match) return false;
    const expires = sessions.get(match[1]);
    if (!expires || expires <= now()) { sessions.delete(match[1]); return false; }
    return true;
  }

  function cookie(token) {
    return `tabel_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}${secureCookie ? '; Secure' : ''}`;
  }

  function logout(req) {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)tabel_owner=([a-f0-9]{64})(?:;|$)/);
    if (match) sessions.delete(match[1]);
  }

  return { configured: validConfig, authenticate, session, cookie, logout };
}

module.exports = { createOwnerAuth };
