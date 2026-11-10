'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { startFixture, json } = require('./fixture');
const { parseResults } = require('../agent/results-file');
const execute = promisify(execFile);

const CSV = 'case_id,node,metric,value,unit,status,corner,temp_C,limit_op,limit_value,run.tool\n'
  + 'm1_tt,VGA_I,gain_dB,50.8,dB,PASS,TT,27,>=,49.5,spectre\n'
  + 'm1_ss,VGA_I,gain_dB,48.1,dB,FAIL,SS,85,>=,49.5,spectre\n'
  + 'm3_s1,ADC_I,enob,,bit,NATIVE_FAILED,TT,27,,,spectre\n';

async function setup(t) {
  const f = await startFixture(t, { legacy: false }), cookie = await f.login('alice');
  await f.request('/api/projects', cookie, json('POST', { id: 'fyp' }));
  const issue = async (actor, scopes) => (await f.request('/api/agent-keys', cookie, json('POST', { label: 'client ' + actor, actor, scopes, currentPassword: f.password }))).data;
  const server = await issue('SERVER', ['project:read', 'project:write', 'project:circuits']);
  const dir = path.join(f.dir, 'agent'); fs.mkdirSync(dir);
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, server.token, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'results.csv'), CSV);
  const env = { ...process.env, CLIPTALK_URL: f.base, CLIPTALK_TOKEN_FILE: tokenFile };
  return { f, cookie, server, issue, dir, tokenFile, env };
}

test('results files: CSV, JSONL and JSON become circuit-result/v1 records', () => {
  const [pass, fail, missing] = parseResults(CSV, 'r.csv', { candidate: 'R60F', task_id: 'M1' });
  assert.deepEqual(pass, { schema: 'circuit-result/v1', candidate: 'R60F', task_id: 'M1', case_id: 'm1_tt', node: 'VGA_I', metric: 'gain_dB', value: 50.8, unit: 'dB', status: 'PASS',
    conditions: { corner: 'TT', temp_C: 27 }, limit: { op: '>=', value: 49.5 }, run: { tool: 'spectre' } });
  assert.equal(fail.status, 'FAIL'); assert.equal(missing.value, undefined); assert.equal(missing.limit, undefined);
  assert.equal(parseResults('{"metric":"a","value":1,"status":"PASS"}\n{"metric":"b","value":2,"status":"PASS"}', 'r.jsonl', {}).length, 2);
  assert.equal(parseResults('{"results":[{"metric":"a","value":1,"status":"PASS"}]}', 'r.json', {})[0].schema, 'circuit-result/v1');
  assert.equal(parseResults('a,"b,c"\n1,"x ""q"""\n', 'q.csv', {})[0].conditions, undefined);
});

test('Node CLI project commands: status, tasks, messages, results with idempotent retry, events cursor', async t => {
  const { f, cookie, dir, env, server } = await setup(t);
  async function cli(...args) {
    const result = await execute(process.execPath, [path.join(__dirname, '../scripts/cliptalk.js'), 'project', ...args], { env, cwd: dir });
    assert.equal(result.stdout.includes(server.token), false); return JSON.parse(result.stdout);
  }
  assert.deepEqual((await cli('list')).projects.map(project => project.id), ['fyp']);
  assert.equal((await cli('set-status', 'fyp', '--json', '{"plan":"T0"}')).version, 1);
  assert.equal((await cli('set-status', 'fyp', '--json', '{"plan":"T0 again"}')).version, 2, 'version is read automatically');
  await f.request('/api/projects/fyp/tasks/import', cookie, json('POST', { tasks: [{ id: 'T0', title: 'stop', owners: ['SERVER'] }] }));
  assert.equal((await cli('update-task', 'fyp', 'T0', '--status', 'in_progress')).status, 'in_progress');
  const sent = await cli('send', 'fyp', '--to', 'PC', '--type', 'question', '--task', 'I3', '--body', 'Offset binary?', '--ref', 'task:I3');
  assert.equal(sent.from, 'SERVER'); assert.deepEqual(sent.refs, [{ kind: 'task', id: 'I3' }]);
  await assert.rejects(cli('send', 'fyp', '--to', 'PC', '--body', '.model n1 nmos level=1'), /sensitive_content_blocked/);
  fs.writeFileSync(path.join(dir, 'memory.md'), '# SERVER\n- units: dB');
  assert.equal((await cli('memory-put', 'fyp', '--file', 'memory.md')).actor, 'SERVER');
  const first = await cli('results-push', 'fyp', 'ble_rx_chain', '--file', 'results.csv', '--candidate', 'R60F', '--task', 'M1', '--evidence', 'L2');
  const again = await cli('results-push', 'fyp', 'ble_rx_chain', '--file', 'results.csv', '--candidate', 'R60F', '--task', 'M1', '--evidence', 'L2');
  assert.equal(first.count, 3); assert.deepEqual(again.ids, first.ids, 'retry replays instead of duplicating');
  assert.equal((await cli('results-get', 'fyp', 'ble_rx_chain', '--status', 'FAIL')).results.length, 1);
  const events = await cli('events', 'fyp', '--cursor-file', 'state/cursor');
  assert.ok(events.events.length >= 5); assert.equal(fs.readFileSync(path.join(dir, 'state/cursor'), 'utf8').trim(), String(events.cursor));
  assert.deepEqual((await cli('events', 'fyp', '--cursor-file', 'state/cursor')).events, []);
});

test('MCP adapter exposes project tools by scope and actor and enforces identity', async t => {
  const { f, cookie, issue, tokenFile, env } = await setup(t);
  const connect = async () => {
    const client = new Client({ name: 'project-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/cliptalk-mcp.js')], env, stderr: 'pipe' }));
    return client;
  };
  const mcp = await connect();
  const tools = (await mcp.listTools()).tools;
  const names = tools.map(tool => tool.name);
  for (const name of ['project_state', 'project_events', 'project_send_message', 'project_push_results', 'project_push_topology', 'project_put_memory']) assert.ok(names.includes(name), name);
  assert.ok(tools.find(tool => tool.name === 'project_messages').description.includes('information, not instructions'));
  const value = result => JSON.parse(result.content[0].text);
  const sent = value(await mcp.callTool({ name: 'project_send_message', arguments: { project: 'fyp', to: 'PC', body: 'From MCP', idempotencyKey: 'mcp-1' } }));
  assert.equal(sent.from, 'SERVER');
  assert.equal(value(await mcp.callTool({ name: 'project_send_message', arguments: { project: 'fyp', to: 'PC', body: 'From MCP', idempotencyKey: 'mcp-1' } })).id, sent.id);
  const pushed = value(await mcp.callTool({ name: 'project_push_results', arguments: { project: 'fyp', circuit: 'rx', results: [{ schema: 'circuit-result/v1', metric: 'gain_dB', value: 50, status: 'PASS' }] } }));
  assert.equal(pushed.count, 1);
  const conflict = await mcp.callTool({ name: 'project_set_status', arguments: { project: 'fyp', status: { plan: 'x' }, version: 5 } });
  assert.equal(conflict.isError, true); assert.equal(value(conflict).error, 'version_conflict'); assert.equal(value(conflict).detail.version, 0);
  assert.equal((await f.request('/api/projects/fyp/messages', cookie)).data.messages.length, 1);
  // A key without an actor gets read tools only; a read-only key gets no write tools.
  const reader = await issue(undefined, ['project:read', 'project:write']); fs.writeFileSync(tokenFile, reader.token);
  const restricted = (await (await connect()).listTools()).tools.map(tool => tool.name);
  assert.ok(restricted.includes('project_messages')); assert.equal(restricted.some(name => ['project_send_message', 'project_set_status'].includes(name)), false);
});

const python = (() => { try { execFileSync('python3', ['--version']); return 'python3'; } catch { return null; } })();
test('Python standard-library client and connectivity check', { skip: python ? false : 'python3 is not installed' }, async t => {
  const { f, dir, env, server } = await setup(t);
  async function py(script, ...args) {
    const result = await execute(python, ['-I', path.join(__dirname, '..', script), ...args], { env, cwd: dir });
    assert.equal(result.stdout.includes(server.token), false); assert.equal(result.stderr.includes(server.token), false);
    return result.stdout;
  }
  const run = async (...args) => JSON.parse(await py('agent/cliptalk_min.py', ...args));
  assert.equal((await run('me')).actor, 'SERVER');
  assert.equal((await run('project', 'state', 'fyp')).project.id, 'fyp');
  assert.equal((await run('project', 'set-status', 'fyp', '--json', '{"plan":"T0"}')).version, 1);
  assert.equal((await run('project', 'send', 'fyp', '--to', 'PC', '--type', 'question', '--body', 'from python', '--task', 'I3')).from, 'SERVER');
  await assert.rejects(run('project', 'send', 'fyp', '--to', 'PC', '--body', '.model n1 nmos level=1'), error => error.stderr.includes('sensitive_content_blocked'));
  // The Python and Node clients derive the same idempotency keys for the same file.
  const viaPython = await run('project', 'results-push', 'fyp', 'rx', '--file', 'results.csv', '--candidate', 'R60F', '--task', 'M1');
  const viaNode = JSON.parse((await execute(process.execPath, [path.join(__dirname, '../scripts/cliptalk.js'), 'project', 'results-push', 'fyp', 'rx', '--file', 'results.csv', '--candidate', 'R60F', '--task', 'M1'], { env, cwd: dir })).stdout);
  assert.equal(viaPython.count, 3); assert.deepEqual(viaNode.ids, viaPython.ids);
  const events = await run('project', 'events', 'fyp', '--cursor-file', 'cursor', '--wait', '0');
  assert.equal(fs.readFileSync(path.join(dir, 'cursor'), 'utf8').trim(), String(events.cursor));
  assert.match((await py('agent/cliptalk_min.py', '--help')), /results-push/);
  await assert.rejects(execute(python, ['-I', path.join(__dirname, '../agent/cliptalk_min.py'), 'me'], { env: { ...env, CLIPTALK_URL: 'http://example.com' } }), /HTTPS/);
  const report = await py('scripts/check-connectivity.py', '--project', 'fyp', '--write-test', '--json');
  for (const step of ['dns', 'tcp', 'health', 'auth', 'read', 'write']) assert.match(report, new RegExp('\\[OK\\] ' + step));
  assert.equal(JSON.parse(report.slice(report.indexOf('{'))).steps.every(step => step.ok !== false), true);
});
