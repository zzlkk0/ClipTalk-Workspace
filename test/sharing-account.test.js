'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const io = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'socket.io-client') : 'socket.io-client').io;
const { startFixture, json, macauDate } = require('./fixture');
async function upload(f, cookie, name = 'shared-文件.txt', content = 'file content') {
  const body = new FormData(); body.append('files', new Blob([content]), name);
  const result = await f.request('/upload', cookie, { method: 'POST', body });
  assert.equal(result.status, 200); return result.data.files[0];
}
function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket timeout: ' + event)), 5000);
    socket.once(event, value => { clearTimeout(timer); resolve(value); });
  });
}
async function connect(t, f, cookie) {
  const socket = io(f.base, { autoConnect: false, transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false });
  t.after(() => socket.disconnect()); const ready = once(socket, 'init'); socket.connect(); await ready; return socket;
}

test('sharing permissions: selected users, public links, ownership, permission changes and revocation', async t => {
  const f = await startFixture(t, { legacy: false });
  const alice = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('test_admin');
  const file = await upload(f, alice);
  assert.equal((await f.request('/api/shares', null)).status, 401);
  assert.equal((await f.request('/api/shares', bob, json('POST', { name: file.name, visibility: 'public' }))).status, 404);
  for (const recipients of [[], ['missing'], ['alice']]) assert.equal((await f.request('/api/shares', alice, json('POST', { name: file.name, visibility: 'users', recipients }))).status, 400);
  const created = await f.request('/api/shares', alice, json('POST', { name: file.name, visibility: 'users', recipients: ['bob', 'bob'] }));
  assert.equal(created.status, 201); const url = '/api/shares/' + created.data.token;
  assert.equal(created.data.token.length, 64); assert.deepEqual(created.data.recipients, ['bob']);
  assert.equal((await f.request(url)).status, 401);
  assert.equal((await f.request(url, admin)).status, 404);
  assert.equal((await f.request(url, bob)).status, 200);
  assert.equal((await f.request('/api/shares', admin)).data.length, 0);
  assert.equal((await f.request('/api/shares', bob)).data.length, 1);
  assert.equal((await fetch(f.base + url + '/download', { headers: { Cookie: bob } })).status, 200);
  assert.equal((await fetch(f.base + url + '/download', { headers: { Cookie: bob } })).headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/uploads/' + file.name, bob)).status, 404);
  assert.equal((await f.request(url, bob, json('PATCH', { visibility: 'public' }))).status, 404);
  assert.equal((await f.request(url, bob, { method: 'DELETE' })).status, 404);
  assert.equal((await f.request(url, alice, json('PATCH', { visibility: 'public' }))).status, 200);
  assert.equal((await f.request(url)).status, 200);
  assert.equal(await (await fetch(f.base + url + '/download')).text(), 'file content');
  assert.equal((await f.request('/api/shares', admin)).data.length, 1);
  assert.equal((await f.request(url, alice, json('PATCH', { visibility: 'users', recipients: ['test_admin'] }))).status, 200);
  assert.equal((await f.request(url)).status, 401); assert.equal((await f.request(url, bob)).status, 404);
  assert.equal((await f.request(url, admin)).status, 200);
  assert.equal((await f.request(url, alice, { method: 'DELETE' })).status, 200);
  for (const cookie of [null, alice, bob, admin]) {
    assert.equal((await f.request(url, cookie)).status, 404);
    assert.equal((await f.request(url + '/download', cookie)).status, 404);
  }
});

test('receiving shared and archived files enforces concurrent quota and keeps independent copies', async t => {
  const f = await startFixture(t, { legacy: false });
  const alice = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('test_admin');
  const file = await upload(f, alice, 'payload.txt', 'x'.repeat(600));
  const date = macauDate();
  const archived = await f.request('/api/archives', alice, json('POST', { title: 'file archive', startDate: date, endDate: date, scope: 'both' }));
  assert.equal(archived.status, 201);
  assert.equal((await f.request('/api/share-files', alice)).data[0].name, file.name);
  const share = (await f.request('/api/shares', alice, json('POST', { name: file.name, visibility: 'users', recipients: ['bob'] }))).data;
  const url = '/api/shares/' + share.token;
  await f.request('/api/admin/users/bob/quota', admin, json('PATCH', { quotaBytes: 1000 }));
  const results = await Promise.all([f.request(url + '/import', bob, json('POST', {})), f.request(url + '/import', bob, json('POST', {}))]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 413]);
  const copied = (await f.request('/api/files', bob)).data[0];
  assert.notEqual(copied.name, file.name); assert.equal(copied.originalName, file.originalName);
  assert.equal((await f.request('/api/storage', bob)).data.fileBytes, 600);
  assert.equal(fs.readdirSync(path.join(f.dir, 'uploads')).length, 2);
  const publicShare = (await f.request('/api/shares', alice, json('POST', { name: file.name, visibility: 'public' }))).data;
  assert.equal((await f.request('/api/archives/' + archived.data.id, alice, json('DELETE', { confirm: true }))).status, 200);
  assert.equal((await f.request(url, bob)).status, 200);
  assert.equal((await f.request('/api/drive/files', alice, json('DELETE', { names: [file.name], confirm: true }))).status, 200);
  assert.equal((await f.request(url, bob)).status, 404);
  assert.equal((await f.request('/api/shares/' + publicShare.token)).status, 404);
  assert.equal(await (await fetch(f.base + '/uploads/' + copied.name, { headers: { Cookie: bob } })).text(), 'x'.repeat(600));
});

test('account updates require the current password, preserve content and sign other devices out', async t => {
  const f = await startFixture(t, { legacy: false });
  const alice = await f.login('alice'), otherDevice = await f.login('alice'), bob = await f.login('bob');
  const socket = await connect(t, f, alice), otherSocket = await connect(t, f, otherDevice);
  const file = await upload(f, alice);
  const share = (await f.request('/api/shares', bob, json('POST', { name: (await upload(f, bob)).name, visibility: 'users', recipients: ['alice'] }))).data;
  assert.equal((await f.request('/api/account', alice, json('PATCH', { currentPassword: 'wrong', username: 'new_alice' }))).status, 401);
  assert.equal((await f.request('/api/account', alice, json('PATCH', { currentPassword: f.password, username: 'bob' }))).status, 409);
  assert.equal((await f.request('/api/account', alice, json('PATCH', { currentPassword: f.password, newPassword: '短' .repeat(30) }))).status, 400);
  assert.equal((await f.request('/api/me', otherDevice)).status, 200);
  const disconnected = once(otherSocket, 'disconnect');
  const updated = await f.request('/api/account', alice, json('PATCH', { currentPassword: f.password, username: 'new_alice', newPassword: 'new-test-password' }));
  assert.equal(updated.status, 200); assert.equal(updated.data.user.id, 'alice'); await disconnected;
  assert.equal((await f.request('/api/me', otherDevice)).status, 401);
  assert.equal((await f.request('/api/me', alice)).data.username, 'new_alice');
  assert.equal((await f.request('/api/files', alice)).data[0].name, file.name);
  assert.equal((await f.request('/api/shares/' + share.token, alice)).status, 200);
  const message = once(socket, 'chat-message'); socket.emit('chat-message', { text: 'after rename' });
  assert.equal((await message).from, 'new_alice');
  assert.equal((await f.request('/api/login', null, json('POST', { username: 'new_alice', password: f.password }))).status, 401);
  assert.equal((await f.request('/api/login', null, json('POST', { username: 'new_alice', password: 'new-test-password' }))).status, 200);
});

test('self deletion removes all owned data and shares, invalidates devices and protects the last admin', async t => {
  const f = await startFixture(t, { legacy: false });
  const alice = await f.login('alice'), alice2 = await f.login('alice'), bob = await f.login('bob'), admin = await f.login('test_admin');
  const socket = await connect(t, f, alice2), file = await upload(f, alice);
  const share = (await f.request('/api/shares', alice, json('POST', { name: file.name, visibility: 'users', recipients: ['bob'] }))).data;
  const url = '/api/shares/' + share.token;
  assert.equal((await f.request(url + '/import', bob, json('POST', {}))).status, 201);
  const date = macauDate();
  await f.request('/api/archives', alice, json('POST', { title: 'delete archive', scope: 'both', startDate: date, endDate: date }));
  await f.request('/api/admin/users/alice/quota', admin, json('PATCH', { quotaBytes: 5000 }));
  assert.equal((await f.request('/api/account', admin, json('DELETE', { confirm: true, username: 'test_admin', currentPassword: f.password }))).data.error, 'last_admin');
  assert.equal((await f.request('/api/account', alice, json('DELETE', { username: 'alice', currentPassword: f.password }))).status, 400);
  assert.equal((await f.request('/api/account', alice, json('DELETE', { confirm: true, username: 'alice', currentPassword: 'wrong' }))).status, 401);
  const disconnected = once(socket, 'disconnect');
  assert.equal((await f.request('/api/account', alice, json('DELETE', { confirm: true, username: 'alice', currentPassword: f.password }))).status, 200);
  await disconnected;
  for (const cookie of [alice, alice2]) assert.equal((await f.request('/api/me', cookie)).status, 401);
  assert.equal((await f.request(url, bob)).status, 404);
  assert.equal(fs.existsSync(path.join(f.dir, 'uploads', file.name)), false);
  assert.equal((await f.request('/api/files', bob)).data.length, 1);
  const records = new Database(path.join(f.dir, 'database', 'workspace.db'));
  for (const table of ['assets', 'files', 'messages', 'archives', 'quotas', 'workspaces', 'file_shares']) assert.equal(records.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE owner_id = ?').get('alice').n, 0);
  records.close();
  const accounts = new Database(path.join(f.dir, 'database', 'users.db'));
  assert.equal(accounts.prepare('SELECT id FROM users WHERE id = ?').get('alice'), undefined); accounts.close();
});

test('site naming is admin-only, survives in settings and remains available before login', async t => {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), admin = await f.login('test_admin');
  const name = '<img src=x onerror=alert(1)> 私人工作站';
  assert.equal((await f.request('/api/admin/settings', alice, json('POST', { site_name: name }))).status, 403);
  assert.equal((await f.request('/api/admin/settings', admin, json('POST', { site_name: name }))).status, 200);
  assert.equal((await f.request('/api/site')).data.siteName, name);
  for (const site_name of ['a'.repeat(81), 'bad\nname', 100]) assert.equal((await f.request('/api/admin/settings', admin, json('POST', { site_name }))).status, 400);
  assert.equal((await f.request('/api/site')).data.siteName, name);
  const database = new Database(path.join(f.dir, 'database', 'users.db'));
  assert.equal(database.prepare("SELECT value FROM settings WHERE key = 'site_name'").get().value, name); database.close();
});
