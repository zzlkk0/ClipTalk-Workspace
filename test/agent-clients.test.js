'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { ClipTalkClient } = require('../agent/client');
const { startFixture, json } = require('./fixture');
const execute = promisify(execFile);

test('CLI and official MCP client: scoped discovery, clipboard, streamed files, local path boundary, revoke and errors', async t => {
  const f = await startFixture(t, { legacy: false }), cookie = await f.login('alice');
  const issue = async scopes => {
    const result = await f.request('/api/agent-keys', cookie, json('POST', { label: 'client test', currentPassword: f.password, scopes }));
    assert.equal(result.status, 201); return result.data;
  };
  const key = await issue(['clipboard:read', 'clipboard:write', 'files:read', 'files:upload', 'files:manage', 'files:delete']);
  const tokenFile = path.join(f.dir, 'token'), localDir = path.join(f.dir, 'local'); fs.mkdirSync(localDir);
  fs.writeFileSync(tokenFile, key.token, { mode: 0o600 }); fs.writeFileSync(path.join(localDir, 'report.txt'), 'client file body');
  const env = { ...process.env, CLIPTALK_URL: f.base, CLIPTALK_TOKEN_FILE: tokenFile, CLIPTALK_LOCAL_DIR: localDir };
  async function cli(...args) {
    const result = await execute(process.execPath, [path.join(__dirname, '../scripts/cliptalk.js'), ...args], { env });
    assert.equal(result.stderr, ''); assert.equal(result.stdout.includes(key.token), false); return JSON.parse(result.stdout);
  }
  assert.equal((await cli('me')).username, 'alice');
  await cli('clipboard', 'set', '--text', 'CLI summary'); assert.equal((await cli('clipboard', 'get')).text, 'CLI summary');
  const folder = await cli('mkdir', 'Reports');
  const uploaded = await cli('upload', 'report.txt', '--folder', folder.id); const file = uploaded.files[0];
  assert.equal((await cli('list', '--folder', folder.id)).files[0].name, file.name);
  await cli('download', file.name, 'download.txt');
  assert.equal(fs.readFileSync(path.join(localDir, 'download.txt'), 'utf8'), 'client file body');
  await assert.rejects(cli('download', file.name, 'download.txt'), /EEXIST/);
  await assert.rejects(cli('delete', file.name), /requires --confirm/);
  await cli('rename-folder', folder.id, 'Renamed'); await cli('move', file.name);
  assert.equal((await cli('list')).files[0].name, file.name);
  const mcp = new Client({ name: 'cliptalk-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/cliptalk-mcp.js')], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', data => { stderr += data; });
  t.after(() => mcp.close()); await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('read_clipboard')); assert.ok(tools.includes('delete_files'));
  async function call(name, args = {}) { return mcp.callTool({ name, arguments: args }); }
  const value = result => JSON.parse(result.content[0].text);
  assert.equal(value(await call('read_clipboard')).text, 'CLI summary');
  assert.equal((await call('write_clipboard', { text: 'MCP summary' })).isError, undefined);
  assert.equal((await cli('clipboard', 'get')).text, 'MCP summary');
  assert.equal((await call('upload_file', { localPath: '../token' })).isError, true);
  fs.symlinkSync(tokenFile, path.join(localDir, 'secret-link'));
  assert.equal((await call('upload_file', { localPath: 'secret-link' })).isError, true);
  assert.equal((await call('download_file', { name: file.name, localPath: '../outside' })).isError, true);
  assert.equal(fs.existsSync(path.join(f.dir, 'outside')), false);
  assert.equal((await call('download_file', { name: file.name, localPath: 'secret-link' })).isError, true);
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), key.token);
  const mcpUpload = value(await call('upload_file', { localPath: 'report.txt' }));
  await call('download_file', { name: mcpUpload.files[0].name, localPath: 'mcp-download.txt' });
  assert.equal(fs.readFileSync(path.join(localDir, 'mcp-download.txt'), 'utf8'), 'client file body');
  assert.equal((await call('download_file', { name: 'missing', localPath: 'missing.txt' })).isError, true);
  assert.equal(fs.existsSync(path.join(localDir, 'missing.txt')), false);
  const noConfirm = await call('delete_files', { names: [file.name] }); assert.equal(noConfirm.isError, true);
  assert.equal((await call('delete_files', { names: [file.name], confirm: true })).isError, undefined);
  await f.request('/api/agent-keys/' + key.id, cookie, { method: 'DELETE' });
  assert.equal(value(await call('read_clipboard')).status, 401);
  assert.equal(stderr.includes(key.token), false);
  const readKey = await issue(['clipboard:read']); fs.writeFileSync(tokenFile, readKey.token);
  const restricted = new Client({ name: 'restricted', version: '1.0.0' });
  t.after(() => restricted.close());
  await restricted.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/cliptalk-mcp.js')], env, stderr: 'pipe' }));
  assert.deepEqual((await restricted.listTools()).tools.map(tool => tool.name).sort(), ['connection_info', 'read_clipboard']);
});

test('agent clients require encrypted remote origins and refuse redirects with credentials', async t => {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice');
  const created = (await f.request('/api/agent-keys', alice, json('POST', { label: 'redirect test', scopes: ['files:read'], currentPassword: f.password }))).data;
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'file:///tmp']) {
    assert.throws(() => new ClipTalkClient({ CLIPTALK_URL: url, CLIPTALK_TOKEN: created.token }));
  }
  const http = require('node:http'); let redirected = false;
  const target = http.createServer((req, res) => { redirected = true; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => target.close(resolve)));
  const source = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:' + target.address().port }); res.end(); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => source.close(resolve)));
  const client = new ClipTalkClient({ CLIPTALK_URL: 'http://127.0.0.1:' + source.address().port, CLIPTALK_TOKEN: created.token });
  await assert.rejects(client.json('/me')); assert.equal(redirected, false);
});
