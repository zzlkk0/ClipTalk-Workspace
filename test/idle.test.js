'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startFixture, json } = require('./fixture');
const { io } = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'socket.io-client') : 'socket.io-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function once(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Missing event ' + event)), timeout);
    socket.once(event, value => { clearTimeout(timer); resolve(value); });
  });
}
async function connect(t, f, cookie) {
  const socket = io(f.base, { autoConnect: false, transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  t.after(() => socket.disconnect());
  const ready = once(socket, 'init'); socket.connect(); await ready; return socket;
}

test('idle policy: admin validation, persistence, live changes, per-device activity and explicit reconnection', async t => {
  const f = await startFixture(t, { legacy: false });
  const a = await f.login('alice'), admin = await f.login('test_admin');
  assert.equal((await f.request('/api/admin/settings', admin)).data.idle_timeout_seconds, 1800);
  assert.equal((await f.request('/api/admin/settings', a, json('POST', { idle_timeout_seconds: 5 }))).status, 403);
  for (const value of [null, true, '5', 0, 4, 5.5, 86401]) {
    assert.equal((await f.request('/api/admin/settings', admin, json('POST', { idle_timeout_seconds: value, site_name: 'must not change' }))).status, 400);
  }
  assert.notEqual((await f.request('/api/site')).data.siteName, 'must not change');
  const idle = await connect(t, f, a), active = await connect(t, f, a);
  const changed = once(idle, 'connection-policy');
  assert.equal((await f.request('/api/admin/settings', admin, json('POST', { idle_timeout_seconds: 5 }))).status, 200);
  assert.equal((await changed).idle_timeout_seconds, 5);
  const accounts = new Database(path.join(f.dir, 'database/users.db'));
  assert.equal(accounts.prepare("SELECT value FROM settings WHERE key = 'idle_timeout_seconds'").get().value, '5'); accounts.close();
  let received = 0; idle.on('chat-message', () => received++);
  const heartbeat = setInterval(() => active.emit('chat-message', { text: 'active device' }), 600);
  t.after(() => clearInterval(heartbeat));
  const notice = once(idle, 'idle-disconnect'), disconnected = once(idle, 'disconnect');
  await notice; assert.equal(await disconnected, 'io server disconnect');
  assert.ok(received > 2); assert.equal(active.connected, true);
  await delay(1200); assert.equal(idle.connected, false);
  assert.equal((await f.request('/api/me', a)).status, 200);
  // HTTP uploads remain usable while realtime is paused.
  const form = new FormData(); form.append('files', new Blob(['still allowed']), 'after-idle.txt');
  assert.equal((await f.request('/upload', a, { method: 'POST', body: form })).status, 200);
  const resumed = once(idle, 'init'); idle.connect(); assert.ok((await resumed).messages.length > 2);
  assert.equal(idle.connected, true);
  await f.request('/api/admin/settings', admin, json('POST', { idle_timeout_seconds: 30 }));
  clearInterval(heartbeat);
  await delay(5200); assert.equal(idle.connected, true); assert.equal(active.connected, true);
  const reduced = once(idle, 'disconnect');
  await f.request('/api/admin/settings', admin, json('POST', { idle_timeout_seconds: 5 }));
  assert.equal(await reduced, 'io server disconnect');
});
