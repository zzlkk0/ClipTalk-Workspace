'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startFixture, json } = require('./fixture');
const { SCOPES } = require('../agent-store');
const io = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'socket.io-client') : 'socket.io-client').io;
async function key(f, cookie, scopes = SCOPES, extra = {}) {
  const result = await f.request('/api/agent-keys', cookie, json('POST', { label: 'test assistant', scopes, expiresInDays: 30, currentPassword: f.password, ...extra }));
  assert.equal(result.status, 201); return result.data;
}
function call(f, token, endpoint, options = {}, cookie) { return f.request('/api/v1' + endpoint, cookie, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token } }); }
async function upload(f, token, folderId, contents = 'file content') {
  const body = new FormData(); body.append('files', new Blob([contents]), 'report.txt');
  return call(f, token, '/files' + (folderId ? '?folderId=' + folderId : ''), { method: 'POST', body });
}
function once(socket, event) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(event + ' missing')), 5000); socket.once(event, data => { clearTimeout(timer); resolve(data); }); }); }

test('agent keys: scopes, cookie independence, isolation, safe metadata, expiry, revocation and restart persistence', async t => {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('test_admin');
  assert.equal((await f.request('/api/agent-keys')).status, 401);
  assert.equal((await f.request('/api/agent-keys', alice, json('POST', { currentPassword: 'wrong' }))).status, 401);
  for (const extra of [{ scopes: ['admin'] }, { scopes: [] }, { expiresInDays: 0 }, { expiresInDays: 366 }, { label: '' }]) {
    assert.equal((await f.request('/api/agent-keys', alice, json('POST', { currentPassword: f.password, label: 'test', scopes: ['files:read'], ...extra }))).status, 400);
  }
  const readonly = await key(f, alice, ['clipboard:read', 'files:read']), writer = await key(f, alice), b = await key(f, bob);
  assert.match(readonly.token, /^ct_[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request('/api/agent-keys', bob)).data.keys.length, 1);
  assert.equal((await f.request('/api/agent-keys/' + writer.id, bob, { method: 'DELETE' })).status, 404);
  assert.equal((await f.request('/api/v1/clipboard', alice)).status, 401);
  for (const endpoint of ['/api/admin/users', '/api/me', '/api/workspace', '/api/agent-keys']) {
    assert.equal((await f.request(endpoint, null, { headers: { Authorization: 'Bearer ' + writer.token } })).status, 401);
  }
  assert.equal((await call(f, readonly.token, '/clipboard', json('PUT', { text: 'denied' }))).status, 403);
  assert.equal((await upload(f, readonly.token)).status, 403);
  assert.equal((await call(f, readonly.token, '/folders', json('POST', { name: 'denied' }))).status, 403);
  assert.equal((await call(f, readonly.token, '/files', json('DELETE', { names: ['x'], confirm: true }))).status, 403);
  const socket = io(f.base, { autoConnect: false, transports: ['websocket'], extraHeaders: { Cookie: alice } });
  t.after(() => socket.disconnect()); const init = once(socket, 'init'); socket.connect(); await init;
  const updated = once(socket, 'clipboard-update');
  assert.equal((await call(f, writer.token, '/clipboard', json('PUT', { text: 'private clipboard', ownerId: 'bob' }), bob)).status, 200);
  assert.equal(await updated, 'private clipboard');
  assert.equal((await call(f, readonly.token, '/clipboard')).data.text, 'private clipboard');
  assert.equal((await call(f, b.token, '/clipboard')).data.text, '');
  const folder = (await call(f, writer.token, '/folders', json('POST', { name: 'Research', ownerId: 'bob' }))).data;
  const uploaded = await upload(f, writer.token, folder.id); assert.equal(uploaded.status, 200); const file = uploaded.data.files[0];
  assert.equal((await call(f, writer.token, '/drive?folderId=' + folder.id)).data.files[0].name, file.name);
  assert.equal((await call(f, b.token, '/drive?folderId=' + folder.id)).status, 404);
  assert.equal((await call(f, b.token, '/files/' + file.name)).status, 404);
  assert.equal((await call(f, b.token, '/folders/' + folder.id, json('DELETE', { confirm: true }))).status, 404);
  assert.equal((await call(f, writer.token, '/files', json('PATCH', { names: [file.name], folderId: null }))).status, 200);
  assert.equal((await call(f, readonly.token, '/drive')).data.files.length, 1);
  assert.equal((await call(f, writer.token, '/files', json('DELETE', { names: [file.name] }))).status, 400);
  assert.equal((await call(f, writer.token, '/files', json('DELETE', { names: [file.name], confirm: true }))).status, 200);
  assert.equal((await call(f, writer.token, '/storage')).data.fileBytes, 0);
  const listing = (await f.request('/api/agent-keys', alice)).data;
  assert.equal(JSON.stringify(listing).includes(writer.token), false);
  assert.equal(JSON.stringify(listing).includes('token_hash'), false);
  await new Promise(resolve => setTimeout(resolve, 30));
  const history = (await f.request('/api/agent-audit', alice)).data.entries;
  assert.ok(history.some(row => row.action === 'PUT /clipboard' && row.status === 200));
  assert.ok(history.some(row => row.status === 403));
  assert.equal(JSON.stringify(history).includes('private clipboard'), false);
  assert.equal(JSON.stringify(history).includes(writer.token), false);
  assert.equal((await f.request('/api/agent-audit?before=bad', alice)).status, 400);
  assert.equal((await f.request('/api/agent-keys/' + writer.id, alice, { method: 'DELETE' })).status, 200);
  assert.equal((await call(f, writer.token, '/me')).status, 401);
  const database = new Database(path.join(f.dir, 'database/users.db'));
  assert.notEqual(database.prepare('SELECT token_hash FROM agent_keys WHERE id = ?').get(readonly.id).token_hash, readonly.token);
  database.prepare('UPDATE agent_keys SET expires_at = ? WHERE id = ?').run(Date.now() - 1, b.id); database.close();
  assert.equal((await call(f, b.token, '/me')).status, 401);
  await f.restart();
  assert.equal((await call(f, readonly.token, '/clipboard')).data.text, 'private clipboard');
  assert.equal((await call(f, writer.token, '/me')).status, 401);
  assert.equal((await call(f, b.token, '/me')).status, 401);
});

test('agent requests enforce quota and persistent per-key limits; disabling, password changes and account deletion remove access', async t => {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('test_admin');
  const a = await key(f, alice), b = await key(f, bob);
  await f.request('/api/admin/users/alice/quota', admin, json('PATCH', { quotaBytes: 3 }));
  assert.equal((await call(f, a.token, '/clipboard', json('PUT', { text: 'too large' }))).status, 413);
  assert.equal((await upload(f, a.token)).status, 413);
  assert.equal(fs.readdirSync(path.join(f.dir, 'uploads')).length, 0);
  await f.request('/api/admin/users/alice/status', admin, json('POST', { status: 'disabled' }));
  assert.equal((await call(f, a.token, '/me')).status, 401);
  await f.request('/api/admin/users/alice/status', admin, json('POST', { status: 'active' }));
  assert.equal((await call(f, a.token, '/me')).status, 200);
  for (let i = 0; i < 60; i++) assert.equal((await call(f, b.token, '/me')).status, 200);
  const limited = await call(f, b.token, '/me'); assert.equal(limited.status, 429); assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  assert.equal((await call(f, a.token, '/me')).status, 200);
  await f.restart();
  assert.equal((await call(f, b.token, '/me')).status, 429);
  const renewedAlice = await f.login('alice'), renewedBob = await f.login('bob');
  assert.equal((await f.request('/api/account', renewedAlice, json('PATCH', { currentPassword: f.password, newPassword: 'different-password' }))).status, 200);
  assert.equal((await call(f, a.token, '/me')).status, 401);
  assert.equal((await f.request('/api/account', renewedBob, json('DELETE', { confirm: true, username: 'bob', currentPassword: f.password }))).status, 200);
  assert.equal((await call(f, b.token, '/me')).status, 401);
  const db = new Database(path.join(f.dir, 'database/users.db'));
  for (const table of ['agent_keys', 'agent_audit']) assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE owner_id = ?').get('bob').n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close();
});

test('revoking a key during upload prevents its commit and removes the temporary file', async t => {
  const http = require('node:http'), f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), a = await key(f, alice);
  let request;
  const finished = new Promise((resolve, reject) => {
    request = http.request(f.base + '/api/v1/files', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'multipart/form-data; boundary=test' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write('--test\r\nContent-Disposition: form-data; name="files"; filename="slow.txt"\r\n\r\n' + 'x'.repeat(4096));
  });
  t.after(() => request.destroy());
  for (let i = 0; i < 100 && !fs.readdirSync(path.join(f.dir, 'uploads')).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(path.join(f.dir, 'uploads')).length, 1);
  await f.request('/api/agent-keys/' + a.id, alice, { method: 'DELETE' });
  request.end('\r\n--test--\r\n'); assert.equal(await finished, 401);
  assert.equal(fs.readdirSync(path.join(f.dir, 'uploads')).length, 0);
  assert.equal((await f.request('/api/storage', alice)).data.usedBytes, 0);
});

