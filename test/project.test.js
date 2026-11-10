'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startFixture, json } = require('./fixture');
const { ContentGuard } = require('../content-guard');
const { parseTaskTable } = require('../public/task-table');
const io = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'socket.io-client') : 'socket.io-client').io;

const ALL = ['project:read', 'project:write', 'project:circuits'];
async function key(f, cookie, actor, scopes = ALL) {
  const result = await f.request('/api/agent-keys', cookie, json('POST', { label: 'agent ' + (actor || 'none'), scopes, actor, currentPassword: f.password }));
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
function agent(f, token) {
  return (endpoint, options = {}) => f.request('/api/v1/projects' + endpoint, null, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token } });
}
function browser(f, cookie) { return (endpoint, options = {}) => f.request('/api/projects' + endpoint, cookie, options); }
const topology = (extra = {}) => ({
  schema: 'circuit-topology/v1', circuit: 'ble_rx_chain', candidate: 'R60F', level: 'block',
  groups: [{ id: 'RX', label: 'RX front end' }, { id: 'ADC', label: 'SAR ADC' }],
  nodes: [
    { id: 'LNTA_I', group: 'RX', kind: 'lnta', label: 'LNTA (I)', params: { Ibias_uA: 120 } },
    { id: 'MIX_I', group: 'RX', kind: 'mixer' }, { id: 'VGA_I', group: 'RX', kind: 'vga' }, { id: 'ADC_I', group: 'ADC', kind: 'sar_adc' },
  ],
  edges: [{ from: 'LNTA_I.out', to: 'MIX_I.rf', net: 'lnta_i_out', kind: 'signal' }, { from: 'MIX_I.if', to: 'VGA_I.in', kind: 'signal' }, { from: 'VGA_I', to: 'ADC_I', kind: 'signal' }],
  ...extra,
});
const result = (extra = {}) => ({
  schema: 'circuit-result/v1', candidate: 'R60F', task_id: 'M1', case_id: 'm1_tt_27c_g2', node: 'VGA_I', metric: 'gain_dB', value: 50.87, unit: 'dB',
  limit: { op: '>=', value: 49.5, ref: 'SPECS#rx.gain' }, status: 'PASS', conditions: { corner: 'TT', temp_C: 27, vdd_V: 1.2 }, evidence_level: 'L2',
  run: { tool: 'spectre', run_dir: 'runs/m1' }, ...extra,
});

test('project keys: actor identity, scopes, permissions by actor, user-only operations and isolation', async t => {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), bob = await f.login('bob');
  for (const actor of ['user', 'USER', 'ALL', 'TOO-LONG-ACTOR-WITH-DASH', 'A'.repeat(33)]) {
    assert.equal((await f.request('/api/agent-keys', alice, json('POST', { label: 'x', scopes: ALL, actor, currentPassword: f.password }))).status, 400, actor);
  }
  const server = await key(f, alice, 'SERVER'), pc = await key(f, alice, 'PC'), legacy = await key(f, alice, undefined), reader = await key(f, alice, 'PC', ['project:read']);
  const filesOnly = await key(f, alice, 'SERVER', ['files:read']), other = await key(f, bob, 'SERVER');
  const S = agent(f, server.token), P = agent(f, pc.token), L = agent(f, legacy.token), R = agent(f, reader.token), B = agent(f, other.token), U = browser(f, alice);
  assert.equal((await f.request('/api/v1/me', null, { headers: { Authorization: 'Bearer ' + server.token } })).data.actor, 'SERVER');
  assert.equal((await f.request('/api/v1/me', null, { headers: { Authorization: 'Bearer ' + legacy.token } })).data.actor, null);
  assert.equal((await f.request('/api/agent-keys', alice)).data.keys.find(row => row.id === server.id).actor, 'SERVER');
  assert.deepEqual((await f.request('/api/health')).data.features, ['projects']);

  // Projects are created in the browser only; unauthenticated browser calls get JSON 401.
  assert.equal((await f.request('/api/projects')).status, 401);
  assert.equal((await S('', json('POST', { id: 'fyp' }))).status, 403);
  assert.equal((await U('', json('POST', { id: 'Bad Id' }))).status, 400);
  assert.equal((await U('', json('POST', { id: 'fyp', name: 'FYP' }))).status, 201);
  assert.equal((await U('', json('POST', { id: 'fyp' }))).status, 409);
  assert.deepEqual((await S('')).data.projects.map(project => project.id), ['fyp']);
  assert.equal(agent(f, filesOnly.token) && (await agent(f, filesOnly.token)('/fyp/state')).status, 403);

  // Cross-account isolation: another account's key cannot see this project.
  assert.deepEqual((await B('')).data.projects, []);
  for (const endpoint of ['/fyp/state', '/fyp/messages', '/fyp/tasks', '/fyp/events', '/fyp/circuits']) assert.equal((await B(endpoint)).status, 404, endpoint);
  assert.equal((await B('/fyp/messages', json('POST', { to: 'PC', body: 'x' }))).status, 404);

  // Own status only; legacy key without actor and read-only key cannot write.
  assert.equal((await S('/fyp/status/SERVER', json('PUT', { status: { plan: 'T0' }, version: 0 }))).status, 200);
  assert.equal((await S('/fyp/status/PC', json('PUT', { status: { plan: 'fake' }, version: 0 }))).status, 403);
  assert.equal((await L('/fyp/status/SERVER', json('PUT', { status: { plan: 'x' }, version: 1 }))).data.error, 'actor_required');
  assert.equal((await L('/fyp/state')).status, 200);
  assert.equal((await R('/fyp/messages', json('POST', { to: 'SERVER', body: 'x' }))).data.error, 'insufficient_scope');
  assert.equal((await U('/fyp/status/PC', json('PUT', { status: { note: 'set by user' }, version: 0 }))).data.updated_by, 'USER');

  // Sender identity comes from the key, never from the body.
  const message = (await S('/fyp/messages', json('POST', { from: 'PC', sender: 'USER', to: 'PC', type: 'question', task_id: 'I3', body: 'Which ADC codes?' }))).data;
  assert.equal(message.from, 'SERVER'); assert.equal(message.thread, message.id);
  const reply = (await P('/fyp/messages', json('POST', { to: 'SERVER', type: 'answer', thread: message.thread, body: 'Offset binary.' }))).data;
  assert.equal(reply.thread, message.id); assert.equal(reply.from, 'PC');
  assert.equal((await P('/fyp/messages', json('POST', { to: 'SERVER', thread: 'msg-999', body: 'x' }))).status, 404);
  assert.equal((await P('/fyp/messages', json('POST', { to: 'SERVER', body: 'x'.repeat(8001) }))).status, 400);
  assert.equal((await P('/fyp/messages', json('POST', { to: 'SERVER', type: 'order', body: 'x' }))).status, 400);
  assert.equal((await U('/fyp/messages', json('POST', { to: 'ALL', body: 'From the browser' }))).data.from, 'USER');
  assert.deepEqual((await P('/fyp/messages?to=PC')).data.messages.map(row => row.id), [message.id, 'msg-3']);
  assert.deepEqual((await P('/fyp/messages?since=' + message.id)).data.messages.map(row => row.id), [reply.id, 'msg-3']);

  // Tasks: only the browser imports; agents change only status/notes of tasks they own.
  assert.equal((await S('/fyp/tasks/import', json('POST', { tasks: [{ id: 'T0', title: 'x' }] }))).status, 403);
  assert.equal((await U('/fyp/tasks/import', json('POST', { tasks: [{ id: 'T0', title: 'a' }, { id: 'T0', title: 'b' }] }))).data.error, 'duplicate_task_id');
  assert.deepEqual((await U('/fyp/tasks/import', json('POST', { tasks: [
    { id: 'T0', phase: 'T', title: 'Find the 900 s stop', owners: ['SERVER'] }, { id: 'T5', phase: 'T', title: 'SPECS.json', owners: ['PC'] },
  ] }))).data, { created: 2, updated: 0 });
  assert.equal((await S('/fyp/tasks/T0', json('PATCH', { status: 'in_progress', version: 1 }))).data.status, 'in_progress');
  assert.equal((await S('/fyp/tasks/T0', json('PATCH', { status: 'done', version: 1 }))).status, 409);
  assert.equal((await S('/fyp/tasks/T0', json('PATCH', { title: 'renamed', version: 2 }))).data.error, 'field_not_allowed');
  assert.equal((await S('/fyp/tasks/T5', json('PATCH', { status: 'done', version: 1 }))).data.error, 'not_task_owner');
  assert.equal((await U('/fyp/tasks/T5', json('PATCH', { title: 'SPECS.json v2', version: 1 }))).data.version, 2);
  assert.deepEqual((await U('/fyp/tasks/import', json('POST', { tasks: [{ id: 'T0', title: 'Find the 900 s stop (updated)', owners: ['SERVER'] }] }))).data, { created: 0, updated: 1 });
  assert.equal((await S('/fyp/tasks/T0')).data.status, 'in_progress', 'import keeps progress');

  // Decisions: agents raise, only the browser answers.
  const decision = (await S('/fyp/decisions', json('POST', { task_id: 'T2', question: 'Ask the admin about Genus?', options: ['A', 'B'], recommendation: 'A', blocking: true }))).data;
  assert.equal(decision.status, 'open'); assert.equal(decision.raised_by, 'SERVER');
  assert.equal((await S('/fyp/decisions/' + decision.id + '/answer', json('POST', { answer: 'A' }))).status, 403);
  assert.equal((await S('/fyp/state')).data.blocking_decisions, 1);
  assert.equal((await U('/fyp/decisions/' + decision.id + '/answer', json('POST', { answer: 'A: contact the admin' }))).data.status, 'answered');
  assert.equal((await P('/fyp/decisions?status=open')).data.decisions.length, 0);

  // Switches and protected documents belong to the person.
  assert.equal((await S('/fyp/state', json('PUT', { switches: { PLL_PAUSED: false }, version: 1 }))).status, 403);
  assert.equal((await U('/fyp/state', json('PUT', { switches: { PLL_PAUSED: true }, version: 1 }))).data.switches_version, 2);
  assert.equal((await U('/fyp/state', json('PUT', { switches: { PLL_PAUSED: false }, version: 1 }))).status, 409);
  assert.equal((await S('/fyp/state')).data.switches.PLL_PAUSED, true);
  for (const name of ['05_SHARED_INTERFACE', 'SPECS', 'WORKFLOW_PC']) assert.equal((await S('/fyp/docs/' + name, json('PUT', { content: 'x', version: 0 }))).status, 403, name);
  assert.equal((await S('/fyp/docs/WORKFLOW_SERVER', json('PUT', { content: '# Server workflow', version: 0 }))).data.version, 1);
  assert.equal((await U('/fyp/docs/SPECS', json('PUT', { content: '{"rx":{}}', version: 0 }))).data.updated_by, 'USER');

  // Memory: write own only, everyone reads, versions are kept.
  assert.equal((await P('/fyp/memory/SERVER', json('PUT', { content: 'fake', version: 0 }))).status, 403);
  assert.equal((await S('/fyp/memory/SERVER', json('PUT', { content: 'Units: dB, Hz.', version: 0 }))).status, 200);
  assert.equal((await S('/fyp/memory/SERVER', json('PUT', { content: 'Units: dB, Hz. libpsf crashes on big PSF.', version: 1 }))).data.version, 2);
  assert.equal((await P('/fyp/memory/SERVER')).data.content.includes('libpsf'), true);
  assert.equal((await P('/fyp/memory/SERVER?version=1')).data.content, 'Units: dB, Hz.');
  assert.deepEqual((await P('/fyp/memory/SERVER/history')).data.history.map(row => row.version), [2, 1]);
  assert.equal((await S('/fyp/memory/SERVER', json('PUT', { content: 'x'.repeat(64 * 1024 + 1), version: 2 }))).status, 413);

  // Deleting anything is browser-only and needs confirmation.
  assert.equal((await S('/fyp/messages/' + message.id, json('DELETE', { confirm: true }))).status, 403);
  assert.equal((await S('/fyp', json('DELETE', { confirm: true }))).status, 403);
  assert.equal((await U('/fyp/messages/' + message.id, json('DELETE', {}))).status, 400);
  assert.equal((await U('/fyp/messages/' + message.id, json('DELETE', { confirm: true }))).status, 200);
  assert.equal((await P('/fyp/messages')).data.messages.some(row => row.id === message.id), false);

  // Audit records routes and ids, never the content.
  await new Promise(resolve => setTimeout(resolve, 30));
  const audit = JSON.stringify((await f.request('/api/agent-audit', alice)).data.entries);
  assert.ok(audit.includes('POST /:project/messages')); assert.ok(audit.includes('fyp/msg-1'));
  assert.equal(audit.includes('Which ADC codes'), false); assert.equal(audit.includes('libpsf'), false);
});

test('append-only records, idempotency, validation, content blocking, quota and live events', async t => {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), admin = await f.login('test_admin');
  const server = await key(f, alice, 'SERVER'), pc = await key(f, alice, 'PC');
  const S = agent(f, server.token), P = agent(f, pc.token), U = browser(f, alice);
  await U('', json('POST', { id: 'fyp' }));

  // Handoffs append; corrections reference the old record.
  const handoff = { task_id: 'I3', to: 'PC', status: 'PASS', summary: 'Codes match within 1 LSB', evidence_level: 'L2',
    conditions: { corner: 'TT', temp_C: 27 }, files: [{ name: 'codes.csv', location: 'SERVER:/runs/i3/codes.csv', sha256: 'a'.repeat(64), format_note: 'offset binary' }],
    limitations: ['ideal ADC reference'], next_action: 'Run RTL comparison' };
  const first = (await S('/fyp/handoffs', json('POST', handoff))).data;
  assert.equal(first.from, 'SERVER'); assert.equal(first.id, 'ho-1');
  assert.equal((await S('/fyp/handoffs', json('POST', { ...handoff, files: [{ name: 'x', location: 'y', sha256: 'bad' }] }))).data.error, 'invalid_sha256');
  const correction = (await S('/fyp/handoffs', json('POST', { ...handoff, summary: 'Corrected: 2 LSB', supersedes: first.id }))).data;
  assert.equal(correction.supersedes, first.id);
  assert.equal((await P('/fyp/handoffs/' + first.id)).data.superseded_by, correction.id);
  assert.equal((await S('/fyp/handoffs/' + first.id, json('PATCH', { summary: 'edit' }))).status, 404);
  assert.equal((await S('/fyp/messages/msg-1', json('PUT', { body: 'edit' }))).status, 404);

  // Idempotency: same key + same body replays; same key + different body is refused.
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'm1-case-1' };
  const body = JSON.stringify({ to: 'PC', body: 'Results uploaded' });
  const once = await S('/fyp/messages', { method: 'POST', headers, body }), twice = await S('/fyp/messages', { method: 'POST', headers, body });
  assert.equal(once.status, 201); assert.equal(twice.status, 201); assert.deepEqual(twice.data, once.data);
  assert.equal(twice.response.headers.get('idempotent-replayed'), 'true');
  assert.equal((await P('/fyp/messages')).data.messages.filter(row => row.body === 'Results uploaded').length, 1);
  assert.equal((await S('/fyp/messages', { method: 'POST', headers, body: JSON.stringify({ to: 'PC', body: 'other' }) })).data.error, 'idempotency_key_reused');
  assert.equal((await P('/fyp/messages', { method: 'POST', headers, body })).status, 201, 'keys are scoped per API key');

  // Topology validation and versions.
  assert.equal((await S('/fyp/circuits/ble_rx_chain/topology', json('PUT', topology({ schema: 'v0' })))).data.error, 'invalid_topology');
  assert.equal((await S('/fyp/circuits/ble_rx_chain/topology', json('PUT', topology({ circuit: 'other' })))).status, 400);
  const bad = [
    topology({ nodes: [{ id: 'A', kind: 'nch_lvt' }] }), topology({ nodes: [{ id: 'A', kind: 'lnta' }, { id: 'A', kind: 'vga' }] }),
    topology({ edges: [{ from: 'LNTA_I.out', to: 'MISSING.in' }] }), topology({ nodes: [{ id: 'A', kind: 'lnta', params: { W: [1] } }] }),
    topology({ nodes: [{ id: 'A', kind: 'lnta', group: 'NOPE' }] }), topology({ level: 'gate' }),
  ];
  for (const item of bad) assert.equal((await S('/fyp/circuits/ble_rx_chain/topology', json('PUT', item))).status, 400, JSON.stringify(item).slice(0, 80));
  const many = topology({ nodes: Array.from({ length: 2001 }, (_, index) => ({ id: 'N' + index, kind: 'res' })), edges: [] });
  assert.equal((await S('/fyp/circuits/ble_rx_chain/topology', json('PUT', many))).status, 413);
  assert.equal((await S('/fyp/circuits/ble_rx_chain/topology', json('PUT', topology()))).data.version, 1);
  assert.equal((await S('/fyp/circuits/ble_rx_chain/topology', json('PUT', topology({ candidate: 'R61' })))).data.version, 2);
  assert.equal((await P('/fyp/circuits/ble_rx_chain/topology?version=1')).data.topology.candidate, 'R60F');
  assert.equal((await P('/fyp/circuits/ble_rx_chain/topology')).data.version, 2);
  assert.deepEqual((await P('/fyp/circuits/ble_rx_chain/topologies')).data.versions.map(row => row.version), [2, 1]);

  // Result validation, batch limit and filtering.
  for (const item of [result({ schema: 'x' }), result({ status: 'OK' }), result({ status: 'BLOCKED' }), result({ value: 'high' }), result({ evidence_level: 'L9' }), result({ limit: { op: '~', value: 1 } })]) {
    assert.equal((await S('/fyp/circuits/ble_rx_chain/results', json('POST', { results: [item] }))).status, 400, JSON.stringify(item).slice(0, 60));
  }
  assert.equal((await S('/fyp/circuits/ble_rx_chain/results', json('POST', { results: Array.from({ length: 501 }, () => result()) }))).status, 413);
  const batch = [result(), result({ case_id: 'm1_ss', metric: 'nf_dB', value: 7.2, limit: { op: '<=', value: 6 }, status: 'FAIL' }),
    result({ node: 'ADC_I', case_id: 'm3', metric: 'enob', value: undefined, status: 'NATIVE_FAILED', task_id: 'M3' }), result({ node: 'MIX_I', metric: 'iip3_dBm', value: -10, status: 'NO_LIMIT', limit: undefined })];
  const added = (await S('/fyp/circuits/ble_rx_chain/results', json('POST', { results: batch }))).data;
  assert.equal(added.count, 4);
  assert.equal((await P('/fyp/circuits/ble_rx_chain/results?task=M1&metric=gain_dB')).data.results.length, 1);
  assert.equal((await P('/fyp/results?task=M3')).data.results[0].value, undefined);
  assert.equal((await P('/fyp/circuits/ble_rx_chain/results?since=' + added.ids[1])).data.results.length, 2);
  let summary = (await P('/fyp/circuits/ble_rx_chain/summary')).data.nodes;
  assert.equal(summary.VGA_I.state, 'FAIL'); assert.equal(summary.ADC_I.state, 'INCOMPLETE'); assert.equal(summary.MIX_I.state, 'NO_LIMIT');
  await S('/fyp/circuits/ble_rx_chain/results', json('POST', [result({ case_id: 'm1_ss', metric: 'nf_dB', value: 5.8, limit: { op: '<=', value: 6 }, status: 'PASS', supersedes: added.ids[1] })]));
  summary = (await P('/fyp/circuits/ble_rx_chain/summary')).data.nodes;
  assert.equal(summary.VGA_I.state, 'PASS', 'a correction replaces the superseded result');
  assert.equal((await P('/fyp/circuits')).data.circuits[0].results, 5);

  // Content blocking: obvious model, library and PDK text is refused without echoing it.
  const blocked = [
    ['/fyp/messages', 'POST', { to: 'PC', body: 'Here it is:\n.model nch_lvt nmos level=54 vth0=0.4' }],
    ['/fyp/messages', 'POST', { to: 'PC', body: 'model nch bsim4 type=n\n+ toxe=2e-9 vth0=0.4 k1=0.5 u0=0.03 vsat=8e4 dvt0=2 nfactor=1' }],
    ['/fyp/memory/SERVER', 'PUT', { content: 'include "/eda/pdk/models/spectre/toplevel.scs" section=tt', version: 0 }],
    ['/fyp/docs/WORKFLOW_SERVER', 'PUT', { content: 'library (cells) {\n cell (NAND2) {\n  pin (A) { }', version: 0 }],
    ['/fyp/handoffs', 'POST', { ...handoff, limitations: ['MACRO NAND2\n  CLASS CORE ;\n  SITE core ;'] }],
    ['/fyp/circuits/ble_rx_chain/results', 'POST', [result({ run: { run_dir: '/home/me/tsmc65/models/x' } })]],
    ['/fyp/circuits/ble_rx_chain/topology', 'PUT', topology({ notes: '.lib "/opt/pdk/hspice/models.lib" TT' })],
  ];
  for (const [endpoint, method, item] of blocked) {
    const response = await S(endpoint, json(method, item));
    assert.equal(response.status, 422, endpoint); assert.equal(response.data.error, 'sensitive_content_blocked');
    assert.equal(JSON.stringify(response.data).includes('nch'), false); assert.equal(JSON.stringify(response.data).includes('NAND2'), false);
  }
  const fine = [
    ['/fyp/messages', 'POST', { to: 'PC', body: '| metric | value |\n|---|---|\n| gain_dB | 50.9 |\nThe model of the LNTA includes a cell with pin A. Library cell timing is fine.' }],
    ['/fyp/memory/SERVER', 'PUT', { content: '# Notes\n- include the run directory in every handoff\n- model parameters live on the server only', version: 0 }],
  ];
  for (const [endpoint, method, item] of fine) assert.ok([200, 201].includes((await S(endpoint, json(method, item))).status), endpoint);

  // Custom keywords apply without restart.
  const rules = path.join(f.dir, 'project-content-rules.json');
  const config = JSON.parse(fs.readFileSync(rules, 'utf8')); config.keywords = ['secret-lab-codename'];
  fs.writeFileSync(rules, JSON.stringify(config));
  assert.equal((await S('/fyp/messages', json('POST', { to: 'PC', body: 'about SECRET-LAB-CODENAME' }))).status, 422);

  // Project text counts toward the account quota.
  const before = (await f.request('/api/storage', alice)).data.textBytes;
  await S('/fyp/messages', json('POST', { to: 'PC', body: 'q'.repeat(1000) }));
  assert.ok((await f.request('/api/storage', alice)).data.textBytes >= before + 1000);
  await f.request('/api/admin/users/alice/quota', admin, json('PATCH', { quotaBytes: before + 1100 }));
  assert.equal((await S('/fyp/messages', json('POST', { to: 'PC', body: 'q'.repeat(2000) }))).status, 413);
  await f.request('/api/admin/users/alice/quota', admin, json('PATCH', { quotaBytes: 1024 ** 3 }));

  // Event stream: cursor, immediate return, long-poll wake-up and timeout, socket notification.
  const all = (await P('/fyp/events?since=0')).data;
  assert.ok(all.events.length > 5); assert.equal(all.cursor, all.events[all.events.length - 1].id);
  assert.deepEqual((await P('/fyp/events?since=' + all.cursor)).data.events, []);
  const timeoutStart = Date.now(), timedOut = (await P('/fyp/events?since=' + all.cursor + '&wait=1')).data;
  assert.ok(Date.now() - timeoutStart >= 900); assert.deepEqual(timedOut.events, []); assert.equal(timedOut.cursor, all.cursor);
  const socket = io(f.base, { autoConnect: false, transports: ['websocket'], extraHeaders: { Cookie: alice } });
  t.after(() => socket.disconnect());
  await new Promise((resolve, reject) => { socket.once('init', resolve); socket.once('connect_error', reject); socket.connect(); });
  const pushed = new Promise(resolve => socket.on('project-updated', payload => payload.type === 'message' && resolve(payload)));
  const waitStart = Date.now(), waiting = P('/fyp/events?since=' + all.cursor + '&wait=20');
  setTimeout(() => S('/fyp/messages', json('POST', { to: 'PC', type: 'handoff_notice', body: 'New handoff' })), 200);
  const woke = (await waiting).data;
  assert.ok(Date.now() - waitStart < 5000); assert.equal(woke.events[0].type, 'message'); assert.equal(woke.events[0].actor, 'SERVER');
  assert.deepEqual(Object.keys(await pushed).sort(), ['event', 'id', 'project', 'type']);
  assert.equal((await P('/fyp/events?since=999999')).data.reset, true);
  assert.equal((await P('/fyp/events?since=abc')).status, 400);
});

test('upgrading an older database keeps old keys working and project tables are created', async t => {
  const f = await startFixture(t, { legacy: true }), alice = await f.login('alice');
  const old = (await f.request('/api/agent-keys', alice, json('POST', { label: 'old', scopes: ['clipboard:read', 'clipboard:write', 'files:read'], currentPassword: f.password }))).data;
  await f.request('/api/v1/clipboard', null, { method: 'PUT', headers: { Authorization: 'Bearer ' + old.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'kept' }) });
  await f.restart(() => {
    // Recreate the pre-project schema: no actor column, no project tables.
    const users = new Database(path.join(f.dir, 'database/users.db')); users.exec('ALTER TABLE agent_keys DROP COLUMN actor'); users.close();
    const workspace = new Database(path.join(f.dir, 'database/workspace.db'));
    for (const { name } of workspace.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'project%'").all()) workspace.exec('DROP TABLE ' + name);
    workspace.close();
  });
  const headers = { Authorization: 'Bearer ' + old.token };
  assert.equal((await f.request('/api/v1/clipboard', null, { headers })).data.text, 'kept');
  assert.equal((await f.request('/api/v1/me', null, { headers })).data.actor, null);
  assert.equal((await f.request('/api/v1/projects', null, { headers })).status, 403, 'old keys have no project scope');
  assert.equal((await f.request('/api/workspace', alice)).status, 401, 'sessions are in memory');
  const renewed = await f.login('alice');
  assert.equal((await f.request('/api/archives', renewed)).data.length >= 0, true);
  assert.equal((await f.request('/api/projects', renewed, json('POST', { id: 'fyp' }))).status, 201);
  const users = new Database(path.join(f.dir, 'database/users.db'));
  assert.ok(users.pragma('table_info(agent_keys)').some(column => column.name === 'actor')); users.close();
});

test('deleting an account removes its projects', async t => {
  const f = await startFixture(t, { legacy: false }), bob = await f.login('bob');
  const b = await key(f, bob, 'SERVER');
  await f.request('/api/projects', bob, json('POST', { id: 'fyp' }));
  await agent(f, b.token)('/fyp/messages', json('POST', { to: 'PC', body: 'hello' }));
  assert.equal((await f.request('/api/account', bob, json('DELETE', { confirm: true, username: 'bob', currentPassword: f.password }))).status, 200);
  const database = new Database(path.join(f.dir, 'database/workspace.db'));
  for (const table of ['projects', 'project_messages', 'project_events', 'project_idempotency']) assert.equal(database.prepare('SELECT COUNT(*) n FROM ' + table + " WHERE owner_id = 'bob'").get().n, 0, table);
  database.close();
});

test('content guard rules and the 05 task table parser', () => {
  const guard = new ContentGuard(null);
  assert.throws(() => guard.check({ nested: ['ok', { deeper: '.MODEL q1 npn (bf=100)' }] }), /sensitive_content_blocked/);
  assert.doesNotThrow(() => guard.check({ schema: 'circuit-topology/v1', nodes: [{ id: 'M1', kind: 'nmos', params: { W_um: 2, L_um: 0.06, nf: 4 } }] }));
  assert.doesNotThrow(() => guard.check('Run directory: runs/m1_tt_27c, libpsf version 3.2; see /home/me/results/m1.csv'));
  const markdown = [
    '| ID | 任务 | 负责 | 前置 | 完成标准 | 交给谁 |', '|---|---|---|---|---|---|',
    '| W0-S | 核对 `WORKFLOW_SERVER.md` | 服务器 | — | 无空白 | PC、用户 |',
    '| A1 | 非整数比 IF 对比 | 服务器出码值，PC 分析 | M3 | 曲线 | 论文 |',
    '| I3 | ADC 码→RTL | 两边 | M5a、I1 | 量化量级 | 两边 |',
    '| W2 | 论文初稿 | PC 起草，用户定稿 | W1 | 8 章齐全 | 用户 |',
    '| W2 | 重复的 ID | 用户 | — | — | — |',
  ].join('\n');
  const parsed = parseTaskTable(markdown);
  assert.deepEqual(parsed.tasks.map(task => task.id), ['W0-S', 'A1', 'I3', 'W2', 'W2']);
  assert.deepEqual(parsed.tasks[0].owners, ['SERVER']); assert.equal(parsed.tasks[0].phase, 'W');
  assert.deepEqual(parsed.tasks[1].owners, ['SERVER', 'PC']); assert.deepEqual(parsed.tasks[2].owners, ['SERVER', 'PC']);
  assert.deepEqual(parsed.tasks[3].owners, ['PC', 'USER']); assert.equal(parsed.tasks[0].depends, '');
  assert.equal(parsed.tasks[0].title, '核对 WORKFLOW_SERVER.md');
  assert.deepEqual(parsed.duplicates, ['W2']);
});
