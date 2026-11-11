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
