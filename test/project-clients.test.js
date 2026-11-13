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
  + 'c1,AMP,gain_dB,50.8,dB,PASS,TT,27,>=,49.5,sim\n'
  + 'c2,AMP,gain_dB,48.1,dB,FAIL,SS,85,>=,49.5,sim\n'
  + 'c3,ADC,enob,,bit,NATIVE_FAILED,TT,27,,,sim\n';

async function setup(t) {
  const f = await startFixture(t, { legacy: false }), cookie = await f.login('alice');
  await f.request('/api/projects', cookie, json('POST', { id: 'demo', modules: { tasks: true, viewer: true } }));
  const issue = async (scopes, actor) => (await f.request('/api/agent-keys', cookie, json('POST', { label: 'client', actor, scopes, currentPassword: f.password }))).data;
  const key = await issue(['project:read', 'project:write']);
  const dir = path.join(f.dir, 'agent'); fs.mkdirSync(dir);
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, key.token, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'results.csv'), CSV);
  const env = { ...process.env, CLIPTALK_URL: f.base, CLIPTALK_TOKEN_FILE: tokenFile, CLIPTALK_LOCAL_DIR: dir };
  delete env.CLIPTALK_AGENT_NAME;
  return { f, cookie, key, issue, dir, tokenFile, env };
}

test('result files become record/v1 entries', () => {
  const [pass, fail, missing] = parseResults(CSV, 'r.csv', { candidate: 'R1', task_id: 'T1' });
  assert.deepEqual(pass, { schema: 'record/v1', candidate: 'R1', task_id: 'T1', case_id: 'c1', node: 'AMP', metric: 'gain_dB', value: 50.8, unit: 'dB', status: 'PASS',
    conditions: { corner: 'TT', temp_C: 27 }, limit: { op: '>=', value: 49.5 }, run: { tool: 'sim' } });
  assert.equal(fail.status, 'FAIL'); assert.equal(missing.value, undefined);
  assert.equal(parseResults('{"metric":"a","value":1}\n{"metric":"b","value":2}', 'r.jsonl', {}).length, 2);
});

test('Node CLI acts as the named agent: status, summary, files, tasks, records, events', async t => {
  const { f, cookie, dir, env, key } = await setup(t);
  async function cli(...args) {
    const result = await execute(process.execPath, [path.join(__dirname, '../scripts/cliptalk.js'), 'project', ...args], { env, cwd: dir });
    assert.equal(result.stdout.includes(key.token), false); return JSON.parse(result.stdout);
  }
  await assert.rejects(cli('send', 'demo', '--to', 'ALL', '--body', 'x'), /agent_name_required/);
  assert.equal((await cli('send', 'demo', '--as', 'PC1', '--to', 'server1', '--type', 'question', '--body', 'hello', '--ref', 'task:T1')).from, 'PC1');
  assert.equal((await cli('set-status', 'demo', '--as', 'PC1', '--json', '{"plan":"T1"}')).version, 1);
  assert.equal((await cli('set-status', 'demo', '--as', 'PC1', '--json', '{"plan":"T1 again"}')).version, 2, 'version read automatically');
  assert.equal((await cli('summary', 'demo', '--as', 'PC1', '--text', 'Going well')).version, 1);
  assert.equal((await cli('modules', 'demo', '--as', 'PC1', '--enable', 'handoffs', '--title', 'Results')).modules.handoffs, true);
  assert.equal((await cli('member-set', 'demo', '--as', 'PC1', 'server1', '--role', 'lab server')).role, 'lab server');
  fs.writeFileSync(path.join(dir, 'intro.md'), '# PC1\nRuns analysis.');
  assert.equal((await cli('file-put', 'demo', '--as', 'PC1', 'agents/PC1.md', '--file', 'intro.md')).path, 'agents/PC1.md');
  assert.match((await cli('file-get', 'demo', 'agents/PC1.md')).content, /Runs analysis/);
  assert.match((await cli('file-get', 'demo', 'RULES.md')).content, /RULES/);
  await assert.rejects(cli('file-put', 'demo', '--as', 'PC1', 'RULES.md', '--text', 'x'), /owner_only/);
  assert.equal((await cli('upload', 'demo', '--as', 'PC1', 'deliverables/T1', 'results.csv')).files[0].path, 'deliverables/T1/results.csv');
  assert.ok((await cli('files', 'demo', 'deliverables', '--recursive')).files.some(file => file.path === 'deliverables/T1/results.csv'));
  assert.equal((await cli('download', 'demo', 'deliverables/T1/results.csv', 'copy.csv')).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'copy.csv'), 'utf8'), CSV);
  const task = await cli('task-add', 'demo', '--as', 'PC1', 'T1', '--title', 'Measure', '--owner', 'PC1');
  assert.equal(task.status, 'proposed');
  await f.request('/api/projects/demo/decisions/' + task.approval + '/answer', cookie, json('POST', { answer: 'approve' }));
  assert.equal((await cli('update-task', 'demo', '--as', 'PC1', 'T1', '--status', 'in_progress')).status, 'in_progress');
  const asked = await cli('ask', 'demo', '--as', 'PC1', '--question', 'Use corner SS?', '--option', 'yes', '--option', 'no');
  const proxied = await cli('answer', 'demo', '--as', 'server1', asked.id, '--body', 'yes');
  assert.equal(proxied.status, 'proxy'); assert.equal(proxied.answered_by, 'server1');
  assert.equal((await cli('decisions', 'demo', '--status', 'proxy')).decisions.length, 1);
  const first = await cli('records-push', 'demo', '--as', 'PC1', 'amp', '--file', 'results.csv', '--candidate', 'R1', '--task', 'T1');
  const again = await cli('records-push', 'demo', '--as', 'PC1', 'amp', '--file', 'results.csv', '--candidate', 'R1', '--task', 'T1');
  assert.equal(first.count, 3); assert.deepEqual(again.ids, first.ids, 'retry replays instead of duplicating');
  assert.equal((await cli('records-get', 'demo', 'amp', '--status', 'FAIL')).records.length, 1);
  const events = await cli('events', 'demo', '--cursor-file', 'state/cursor');
  assert.ok(events.events.length >= 5); assert.equal(fs.readFileSync(path.join(dir, 'state/cursor'), 'utf8').trim(), String(events.cursor));
  assert.deepEqual((await cli('events', 'demo', '--cursor-file', 'state/cursor')).events, []);
});

test('MCP adapter uses CLIPTALK_AGENT_NAME and exposes write tools only with a name', async t => {
  const { f, cookie, issue, tokenFile, env } = await setup(t);
  const connect = async extraEnv => {
    const client = new Client({ name: 'project-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '../scripts/cliptalk-mcp.js')], env: { ...env, ...extraEnv }, stderr: 'pipe' }));
    return client;
  };
  const mcp = await connect({ CLIPTALK_AGENT_NAME: 'server3' });
  const tools = (await mcp.listTools()).tools, names = tools.map(tool => tool.name);
  for (const name of ['project_state', 'project_read_file', 'project_write_file', 'project_send_message', 'project_add_task', 'project_set_summary', 'project_push_records']) assert.ok(names.includes(name), name);
  assert.ok(tools.find(tool => tool.name === 'project_state').description.includes('RULES.md'));
  const value = result => JSON.parse(result.content[0].text);
  assert.equal(value(await mcp.callTool({ name: 'project_send_message', arguments: { project: 'demo', to: 'ALL', body: 'From MCP', idempotencyKey: 'm1' } })).from, 'server3');
  assert.equal(value(await mcp.callTool({ name: 'project_write_file', arguments: { project: 'demo', path: 'memory/server3.md', content: '# notes' } })).path, 'memory/server3.md');
  assert.match(value(await mcp.callTool({ name: 'project_read_file', arguments: { project: 'demo', path: 'memory/server3.md' } })).content, /notes/);
  assert.equal(value(await mcp.callTool({ name: 'project_push_records', arguments: { project: 'demo', view: 'v', records: [{ metric: 'm', value: 1 }] } })).count, 1);
  const conflict = await mcp.callTool({ name: 'project_set_status', arguments: { project: 'demo', status: { plan: 'x' }, version: 5 } });
  assert.equal(conflict.isError, true); assert.equal(value(conflict).error, 'version_conflict');
  assert.equal((await f.request('/api/projects/demo/messages', cookie)).data.messages[0].from, 'server3');
  // Without a name the adapter offers read tools only.
  const reader = await connect({});
  const readerTools = (await reader.listTools()).tools.map(tool => tool.name);
  assert.ok(readerTools.includes('project_messages')); assert.equal(readerTools.includes('project_send_message'), false);
  // A key with a default name works without the environment variable.
  const named = await issue(['project:read', 'project:write'], 'PC2'); fs.writeFileSync(tokenFile, named.token);
  const withDefault = (await (await connect({})).listTools()).tools.map(tool => tool.name);
  assert.ok(withDefault.includes('project_send_message'));
});

const python = (() => { try { execFileSync('python3', ['--version']); return 'python3'; } catch { return null; } })();
test('Python standard-library client and connectivity check', { skip: python ? false : 'python3 is not installed' }, async t => {
  const { f, dir, env, key } = await setup(t);
  async function py(script, ...args) {
    const result = await execute(python, ['-I', path.join(__dirname, '..', script), ...args], { env, cwd: dir });
    assert.equal(result.stdout.includes(key.token), false); assert.equal(result.stderr.includes(key.token), false);
    return result.stdout;
  }
  const run = async (...args) => JSON.parse(await py('agent/cliptalk_min.py', ...args));
  assert.equal((await run('project', 'state', 'demo')).project.id, 'demo');
  await assert.rejects(run('project', 'send', 'demo', '--to', 'ALL', '--body', 'x'), error => error.stderr.includes('agent_name_required'));
  assert.equal((await run('project', 'send', 'demo', '--as', 'server1', '--to', 'PC1', '--type', 'question', '--body', 'from python')).from, 'server1');
  assert.equal((await run('project', 'set-status', 'demo', '--as', 'server1', '--json', '{"plan":"T0"}')).version, 1);
  assert.equal((await run('project', 'summary', 'demo', '--as', 'server1', '--text', 'Python says hi')).version, 1);
  assert.equal((await run('project', 'file-put', 'demo', '--as', 'server1', 'agents/server1.md', '--text', '# server1')).path, 'agents/server1.md');
  assert.equal((await run('project', 'upload', 'demo', '--as', 'server1', 'deliverables/T0', 'results.csv')).files[0].path, 'deliverables/T0/results.csv');
  assert.equal((await run('project', 'download', 'demo', 'deliverables/T0/results.csv', 'copy.csv')).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'copy.csv'), 'utf8'), CSV);
  await assert.rejects(run('project', 'send', 'demo', '--as', 'server1', '--to', 'PC1', '--body', '.model n1 nmos level=1'), error => error.stderr.includes('sensitive_content_blocked'));
  // Python and Node derive the same idempotency keys for the same file.
  const viaPython = await run('project', 'records-push', 'demo', '--as', 'server1', 'amp', '--file', 'results.csv', '--candidate', 'R1', '--task', 'T1');
  const viaNode = JSON.parse((await execute(process.execPath, [path.join(__dirname, '../scripts/cliptalk.js'), 'project', 'records-push', 'demo', '--as', 'server1', 'amp', '--file', 'results.csv', '--candidate', 'R1', '--task', 'T1'], { env, cwd: dir })).stdout);
  assert.equal(viaPython.count, 3); assert.deepEqual(viaNode.ids, viaPython.ids);
  const events = await run('project', 'events', 'demo', '--cursor-file', 'cursor');
  assert.equal(fs.readFileSync(path.join(dir, 'cursor'), 'utf8').trim(), String(events.cursor));
  assert.match(await py('agent/cliptalk_min.py', '--help'), /records-push/);
  const report = await py('scripts/check-connectivity.py', '--project', 'demo', '--json');
  for (const step of ['dns', 'tcp', 'health', 'read']) assert.match(report, new RegExp('\\[OK\\] ' + step));
});
