'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { startFixture, json } = require('./fixture');
const execute = promisify(execFile);
const io = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'socket.io-client') : 'socket.io-client').io;
const hasOpenssl = (() => { try { execFileSync('openssl', ['version']); return true; } catch { return false; } })();

test('HTTPS on the public port with a private CA; plain HTTP stays on loopback', { skip: hasOpenssl ? false : 'openssl is not installed' }, async t => {
  const f = await startFixture(t, { legacy: false, https: true });
  assert.match(f.base, /^https:/);
  assert.equal((await f.request('/api/health')).data.ok, true);
  assert.equal((await fetch(f.plainBase + '/api/health')).status, 200, 'loopback HTTP still answers');
  await assert.rejects(fetch('http://127.0.0.1:' + f.securePort + '/api/health'), 'the public port does not speak plain HTTP');
  const cookie = await f.login('alice');
  const key = (await f.request('/api/agent-keys', cookie, json('POST', { label: 'tls', scopes: ['clipboard:read'], currentPassword: f.password }))).data;
  const tokenFile = path.join(f.dir, 'token'); fs.writeFileSync(tokenFile, key.token, { mode: 0o600 });
  const ca = path.join(f.dir, 'tls', 'ca.pem');
  const env = { ...process.env, CLIPTALK_URL: f.base, CLIPTALK_TOKEN_FILE: tokenFile };
  const cli = extra => execute(process.execPath, [path.join(__dirname, '../scripts/cliptalk.js'), 'me'], { env: { ...env, ...extra } });
  assert.equal(JSON.parse((await cli({ CLIPTALK_CA_FILE: ca })).stdout).username, 'alice');
  await assert.rejects(cli({}), error => !error.stdout.includes(key.token), 'without the CA the certificate is refused');
  const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
  if (python) {
    const result = await execute('python3', ['-I', path.join(__dirname, '../agent/cliptalk_min.py'), 'me'], { env: { ...env, CLIPTALK_CA_FILE: ca } });
    assert.equal(JSON.parse(result.stdout).username, 'alice');
    await assert.rejects(execute('python3', ['-I', path.join(__dirname, '../agent/cliptalk_min.py'), 'me'], { env }));
  }
  // Realtime sync works over HTTPS and over the loopback HTTP port.
  for (const url of [f.base, f.plainBase]) {
    const socket = io(url, { autoConnect: false, transports: ['websocket'], extraHeaders: { Cookie: cookie }, ca: fs.readFileSync(ca) });
    t.after(() => socket.disconnect());
    const init = await new Promise((resolve, reject) => { socket.once('init', resolve); socket.once('connect_error', reject); socket.connect(); });
    assert.deepEqual(Object.keys(init).sort(), ['clipboardText', 'files', 'messages']);
    socket.disconnect();
  }
});

test('public plain HTTP for browsers refuses the agent API and key creation from other hosts', { skip: hasOpenssl ? false : 'openssl is not installed' }, async t => {
  const f = await startFixture(t, { legacy: false, https: true, httpPublic: true });
  const cookie = await f.login('alice');
  const key = (await f.request('/api/agent-keys', cookie, json('POST', { label: 'tls', scopes: ['clipboard:read'], currentPassword: f.password }))).data;
  const port = new URL(f.plainBase).port, bearer = { Authorization: 'Bearer ' + key.token };
  // From this server itself the plain port keeps working, including the agent API.
  assert.equal((await fetch(f.plainBase + '/api/v1/me', { headers: bearer })).status, 200);
  // From another address (this machine's network IP) browsing works, keys do not.
  const address = Object.values(require('node:os').networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address;
  if (!address) return t.skip('no non-loopback network interface');
  const remote = 'http://' + address + ':' + port;
  assert.equal((await fetch(remote + '/api/health')).status, 200);
  assert.equal((await fetch(remote + '/login.html')).status, 200);
  const refused = await fetch(remote + '/api/v1/me', { headers: bearer });
  assert.equal(refused.status, 403); assert.equal((await refused.json()).error, 'https_required');
  const create = await fetch(remote + '/api/agent-keys', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'x', scopes: ['clipboard:read'], currentPassword: f.password }) });
  assert.equal(create.status, 403);
  assert.equal((await fetch(remote + '/api/agent-keys', { headers: { Cookie: cookie } })).status, 200, 'listing keys (no secret) still works');
  assert.equal((await fetch('https://' + '127.0.0.1:' + f.securePort + '/api/v1/me', { headers: bearer })).status, 200, 'agents use HTTPS');
});
