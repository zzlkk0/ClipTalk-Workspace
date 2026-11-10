'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startFixture, json } = require('./fixture');
const { ContentGuard } = require('../content-guard');
const { parseTaskTable, taskPrompt } = require('../public/task-table');
const io = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'socket.io-client') : 'socket.io-client').io;

const ALL = ['project:read', 'project:write'];
async function key(f, cookie, scopes = ALL, actor) {
  const result = await f.request('/api/agent-keys', cookie, json('POST', { label: 'agent', scopes, actor, currentPassword: f.password }));
  assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
}
// One key can act as several agents; the name comes from X-Agent-Name.
function agent(f, token, name) {
  return (endpoint, options = {}) => f.request('/api/v1/projects' + endpoint, null, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token, ...(name ? { 'X-Agent-Name': name } : {}) } });
}
function browser(f, cookie) { return (endpoint, options = {}) => f.request('/api/projects' + endpoint, cookie, options); }
async function setup(t, modules) {
  const f = await startFixture(t, { legacy: false }), alice = await f.login('alice'), k = await key(f, alice);
  const U = browser(f, alice);
  assert.equal((await U('', json('POST', { id: 'demo', name: 'Demo', modules }))).status, 201);
  return { f, alice, k, U, PC1: agent(f, k.token, 'PC1'), S2: agent(f, k.token, 'server2'), anon: agent(f, k.token) };
}
const graph = (extra = {}) => ({
  schema: 'graph/v1', candidate: 'R1', level: 'block', groups: [{ id: 'A', label: 'Front' }],
  nodes: [{ id: 'IN', group: 'A', kind: 'port' }, { id: 'AMP', group: 'A', kind: 'amp', params: { gain: 20 } }, { id: 'OUT', kind: 'anything_goes' }],
  edges: [{ from: 'IN', to: 'AMP.in' }, { from: 'AMP.out', to: 'OUT', kind: 'data' }], ...extra,
});
const record = (extra = {}) => ({ metric: 'gain_dB', value: 20.1, unit: 'dB', status: 'PASS', node: 'AMP', case_id: 'c1', conditions: { temp_C: 27 }, limit: { op: '>=', value: 19 }, ...extra });

test('agent names, owner-only actions, broad agent permissions and isolation', async t => {
  const { f, alice, k, U, PC1, S2, anon } = await setup(t, { tasks: true, handoffs: true, viewer: true });
  for (const name of ['USER', 'all', 'bad name', 'x'.repeat(33)]) {
    assert.equal((await agent(f, k.token, name)('/demo/messages', json('POST', { to: 'ALL', body: 'x' }))).status, 400, name);
  }
  assert.equal((await anon('/demo/messages', json('POST', { to: 'ALL', body: 'x' }))).data.error, 'agent_name_required');
  assert.equal((await anon('/demo/state')).status, 200, 'reading needs no name');
  const named = await key(f, alice, ALL, 'server9');
  assert.equal((await agent(f, named.token)('/demo/messages', json('POST', { to: 'ALL', body: 'default name' }))).data.from, 'server9');
  assert.equal((await agent(f, named.token, 'PC7')('/demo/messages', json('POST', { to: 'ALL', body: 'override' }))).data.from, 'PC7');
  const reader = await key(f, alice, ['project:read']);
  assert.equal((await agent(f, reader.token, 'PC1')('/demo/messages', json('POST', { to: 'ALL', body: 'x' }))).data.error, 'insufficient_scope');
  assert.equal((await f.request('/api/agent-keys', alice, json('POST', { label: 'x', scopes: ['project:circuits'], currentPassword: f.password }))).status, 400, 'scope removed');

  // Owner-only: creating and deleting projects, answering decisions, editing RULES.md.
  assert.equal((await PC1('', json('POST', { id: 'other' }))).data.error, 'owner_only');
  assert.equal((await PC1('/demo', json('DELETE', { confirm: true }))).data.error, 'owner_only');
  assert.equal((await PC1('/demo/files/content', json('PUT', { path: 'RULES.md', content: 'no rules' }))).data.error, 'owner_only');
  assert.equal((await U('/demo/files/content', json('PUT', { path: 'RULES.md', content: '# rules v2' }))).status, 200);

  // Members join automatically; the owner can add more.
  assert.equal((await U('/demo/members/server1', json('PUT', { role: 'Cadence server' }))).status, 200);
  await PC1('/demo/messages', json('POST', { to: 'server1', type: 'question', body: 'hello' }));
  const state = (await PC1('/demo/state')).data;
  assert.deepEqual(state.members.map(member => member.name).sort(), ['PC1', 'PC7', 'server1', 'server9']);
  assert.equal(state.members.find(member => member.name === 'server1').role, 'Cadence server');

  // Broad permissions: agents may edit messages, other members' status and summary.
  const message = (await S2('/demo/messages', json('POST', { to: 'PC1', body: 'original' }))).data;
  assert.equal((await PC1('/demo/messages/' + message.id, json('PATCH', { body: 'edited by PC1' }))).data.body, 'edited by PC1');
  assert.equal((await PC1('/demo/status/server2', json('PUT', { status: { note: 'set by PC1' }, version: 0 }))).data.updated_by, 'PC1');
  assert.equal((await S2('/demo/summary', json('PUT', { text: 'Half done', version: 0 }))).data.version, 1);
  assert.equal((await PC1('/demo/summary', json('PUT', { text: 'stale', version: 0 }))).status, 409);
  assert.equal((await PC1('/demo/switches', json('PUT', { switches: { PAUSED: true }, version: 1 }))).status, 200);

  // Tasks proposed by agents wait for the owner's approval.
  const proposed = (await PC1('/demo/tasks', json('POST', { id: 'T1', title: 'Measure gain', owners: ['PC1'] }))).data;
  assert.equal(proposed.status, 'proposed'); assert.match(proposed.approval, /^dec-/);
  assert.equal((await PC1('/demo/tasks/T1', json('PATCH', { status: 'todo', version: 1 }))).data.error, 'approval_required');
  assert.equal((await PC1('/demo/decisions/' + proposed.approval + '/answer', json('POST', { answer: 'approve' }))).data.error, 'owner_only');
  assert.equal((await PC1('/demo/decisions/' + proposed.approval, json('DELETE', { confirm: true }))).data.error, 'approval_required');
  assert.equal((await U('/demo/decisions/' + proposed.approval + '/answer', json('POST', { answer: 'approve' }))).data.status, 'answered');
  assert.equal((await PC1('/demo/tasks/T1')).data.status, 'todo');
  assert.equal((await PC1('/demo/tasks/T1', json('PATCH', { status: 'in_progress', version: 2 }))).data.status, 'in_progress');
  const second = (await S2('/demo/tasks', json('POST', { id: 'T2', title: 'Something else' }))).data;
  await U('/demo/decisions/' + second.approval + '/answer', json('POST', { answer: 'reject: not now' }));
  assert.equal((await PC1('/demo/tasks/T2')).data.status, 'rejected');
  assert.equal((await U('/demo/tasks', json('POST', { id: 'T3', title: 'By the owner' }))).data.status, 'todo');
  assert.equal((await PC1('/demo/tasks/import', json('POST', { tasks: [{ id: 'X', title: 'x' }] }))).data.error, 'owner_only');

  // Decisions: agents raise and edit; only the owner answers.
  const decision = (await PC1('/demo/decisions', json('POST', { question: 'Buy more disk?', options: ['yes', 'no'], blocking: true }))).data;
  assert.equal((await S2('/demo/decisions/' + decision.id, json('PATCH', { question: 'Buy more disk now?', options: ['yes', 'no'] }))).data.question, 'Buy more disk now?');
  await U('/demo/decisions/' + decision.id + '/answer', json('POST', { answer: 'no' }));
  assert.equal((await S2('/demo/decisions/' + decision.id, json('PATCH', { question: 'again?' }))).data.error, 'decision_answered');

  // Handoffs can be edited; deletion by agents needs confirmation.
  const handoff = (await PC1('/demo/handoffs', json('POST', { task_id: 'T1', to: 'server1', status: 'PASS', summary: 'gain 20.1 dB', files: [{ name: 'g.csv', location: 'project:deliverables/T1/g.csv' }] }))).data;
  assert.equal((await S2('/demo/handoffs/' + handoff.id, json('PUT', { task_id: 'T1', to: 'server1', status: 'PASS', summary: 'gain 20.2 dB' }))).data.summary, 'gain 20.2 dB');
  assert.equal((await S2('/demo/messages/' + message.id, json('DELETE', {}))).status, 400);
  assert.equal((await S2('/demo/messages/' + message.id, json('DELETE', { confirm: true }))).status, 200);

  // Another account sees nothing.
  const bob = await f.login('bob'), other = await key(f, bob);
  assert.deepEqual((await agent(f, other.token, 'PC1')('')).data.projects, []);
  for (const endpoint of ['/demo/state', '/demo/messages', '/demo/files', '/demo/events']) assert.equal((await agent(f, other.token, 'PC1')(endpoint)).status, 404, endpoint);

  // Audit keeps routes and ids, not content.
  await new Promise(resolve => setTimeout(resolve, 30));
  const audit = JSON.stringify((await f.request('/api/agent-audit', alice)).data.entries);
  assert.ok(audit.includes('POST /:project/messages')); assert.equal(audit.includes('Measure gain'), false);
});

test('modules, project folder in the drive, files, viewer data and validation', async t => {
  const { f, alice, U, PC1, S2 } = await setup(t);
  const state = (await PC1('/demo/state')).data;
  assert.deepEqual(state.modules, { tasks: false, messages: true, decisions: true, handoffs: false, viewer: false, files: true });
  assert.equal((await PC1('/demo/tasks', json('POST', { id: 'T1', title: 'x' }))).data.error, 'module_disabled');
  assert.equal((await PC1('/demo/views/v/graph', json('PUT', graph()))).status, 409);
  const enabled = (await PC1('/demo/modules', json('PUT', { modules: { tasks: true, viewer: true, handoffs: true }, version: state.modules_version, viewer_title: 'Results' }))).data;
  assert.equal(enabled.viewer_title, 'Results');
  assert.equal((await PC1('/demo/modules', json('PUT', { modules: { nonsense: true }, version: enabled.modules_version }))).status, 400);

  // The project folder lives in the owner's drive with templates and subfolders.
  const folders = (await f.request('/api/drive/folders', alice)).data;
  const root = folders.find(folder => folder.name === '项目协同' && folder.parentId === null);
  const projectFolder = folders.find(folder => folder.parentId === root.id && folder.name === 'Demo');
  assert.ok(projectFolder && projectFolder.id === state.project.folder_id);
  const drive = (await f.request('/api/drive?folderId=' + projectFolder.id, alice)).data;
  assert.deepEqual(drive.files.map(file => file.originalName).sort(), ['GUIDE.md', 'RULES.md']);
  assert.deepEqual(drive.folders.map(folder => folder.name).sort(), ['agents', 'deliverables', 'docs', 'memory']);
  assert.match((await PC1('/demo/files/content?path=GUIDE.md')).data.content, /X-Agent-Name/);
  assert.equal((await f.request('/api/workspace', alice)).data.files.length, 0, 'project files do not appear in the chat file list');

  // Text files: create, replace with etag, conflict, nested folders created on demand.
  const created = (await PC1('/demo/files/content', json('PUT', { path: 'memory/PC1.md', content: '# PC1 memory' }))).data;
  assert.equal((await S2('/demo/files/content?path=memory/PC1.md')).data.content, '# PC1 memory');
  const replaced = (await PC1('/demo/files/content', json('PUT', { path: 'memory/PC1.md', content: '# PC1 memory v2', etag: created.etag }))).data;
  assert.equal((await S2('/demo/files/content', json('PUT', { path: 'memory/PC1.md', content: 'stale', etag: created.etag }))).status, 409);
  assert.equal((await PC1('/demo/files/content', json('PUT', { path: 'deliverables/T1/sub/report.md', content: 'ok' }))).status, 200);
  for (const bad of ['../x', '/abs', 'a/../b', 'a\\b']) assert.equal((await PC1('/demo/files/content', json('PUT', { path: bad, content: 'x' }))).status, 400, bad);
  const listing = (await PC1('/demo/files?recursive=1')).data;
  assert.ok(listing.files.some(file => file.path === 'deliverables/T1/sub/report.md'));
  assert.equal(listing.files.filter(file => file.path === 'memory/PC1.md').length, 1, 'a rewrite replaces the old file');
  assert.equal(listing.files.find(file => file.path === 'memory/PC1.md').etag, replaced.etag);

  // Binary uploads and downloads.
  const body = new FormData(); body.append('files', new Blob(['a,b\n1,2\n']), 'data.csv');
  const uploaded = await f.request('/api/v1/projects/demo/files/upload?path=deliverables/T1', null, { method: 'POST', body, headers: { Authorization: 'Bearer ' + (await key(f, alice)).token, 'X-Agent-Name': 'PC1' } });
  assert.equal(uploaded.status, 201); assert.equal(uploaded.data.files[0].path, 'deliverables/T1/data.csv');
  const raw = await f.request('/api/projects/demo/files/raw?path=' + encodeURIComponent('deliverables/T1/data.csv'), alice);
  assert.equal(raw.status, 200);
  assert.equal((await U('/demo/files', json('DELETE', { path: 'deliverables/T1/data.csv', confirm: true }))).status, 200);
  assert.equal((await U('/demo/files/content?path=deliverables/T1/data.csv')).status, 404);

  // Viewer data: generic graphs (any kind) and records (any short status).
  assert.equal((await PC1('/demo/views/v1/graph', json('PUT', graph()))).data.version, 1);
  assert.equal((await PC1('/demo/views/v1/graph', json('PUT', graph({ candidate: 'R2' })))).data.version, 2);
  for (const bad of [graph({ schema: 'x' }), graph({ nodes: [{ id: 'A' }, { id: 'A' }] }), graph({ edges: [{ from: 'IN', to: 'NOPE' }] }), graph({ nodes: [{ id: 'A', group: 'missing' }] }), graph({ nodes: [{ id: 'A', params: { p: [1] } }] })]) {
    assert.equal((await PC1('/demo/views/v1/graph', json('PUT', bad))).data.error, 'invalid_graph');
  }
  const added = (await PC1('/demo/views/v1/records', json('POST', { records: [record(), record({ case_id: 'c2', value: 17, status: 'FAIL' }), record({ metric: 'custom', value: undefined, status: 'TODO_LATER' })] }))).data;
  assert.equal(added.count, 3);
  for (const bad of [record({ status: 'has space' }), record({ value: 'x' }), record({ status: 'BLOCKED' }), record({ limit: { op: '~', value: 1 } })]) {
    assert.equal((await PC1('/demo/views/v1/records', json('POST', { records: [bad] }))).data.error, 'invalid_record');
  }
  assert.equal((await PC1('/demo/views/v1/summary')).data.nodes.AMP.state, 'FAIL');
  await PC1('/demo/views/v1/records', json('POST', [record({ case_id: 'c2', value: 19.5, supersedes: added.ids[1] })]));
  assert.equal((await PC1('/demo/views/v1/summary')).data.nodes.AMP.state, 'PASS');
  assert.equal((await PC1('/demo/records?metric=gain_dB&current=1')).data.records.length, 2);
  assert.equal((await PC1('/demo/views')).data.views[0].records, 4);
});

test('idempotency, content blocking, quotas, disk guard and live events', async t => {
  const { f, alice, k, U, PC1, S2 } = await setup(t);
  const admin = await f.login('test_admin');
  // Idempotency per key: same body replays, different body is refused.
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'once-1' };
  const body = JSON.stringify({ to: 'ALL', body: 'Uploaded' });
  const first = await PC1('/demo/messages', { method: 'POST', headers, body }), again = await PC1('/demo/messages', { method: 'POST', headers, body });
  assert.deepEqual(again.data, first.data); assert.equal(again.response.headers.get('idempotent-replayed'), 'true');
  assert.equal((await PC1('/demo/messages', { method: 'POST', headers, body: JSON.stringify({ to: 'ALL', body: 'other' }) })).data.error, 'idempotency_key_reused');

  // Content blocking applies to messages and files alike.
  for (const [endpoint, method, item] of [
    ['/demo/messages', 'POST', { to: 'ALL', body: '.model nch nmos level=54 vth0=0.4' }],
    ['/demo/files/content', 'PUT', { path: 'docs/lib.md', content: 'library (x) {\n cell (NAND2) {' }],
    ['/demo/files/content', 'PUT', { path: 'docs/paths.md', content: 'libs in /data/pdk/models/x.scs' }],
  ]) assert.equal((await PC1(endpoint, json(method, item))).data.error, 'sensitive_content_blocked', endpoint);
  assert.equal((await PC1('/demo/messages', json('POST', { to: 'ALL', body: '| metric | value |\n|---|---|\n| gain | 20 |\nThe model includes a cell.' }))).status, 201);

  // Project collaboration ceiling (per account) and server disk reserve.
  assert.equal((await f.request('/api/admin/settings', admin, json('POST', { project_quota_mb: 0 }))).status, 400);
  assert.equal((await f.request('/api/admin/settings', admin, json('POST', { project_quota_mb: 1 }))).status, 200);
  assert.equal((await PC1('/demo/files/content', json('PUT', { path: 'deliverables/big1.txt', content: 'x'.repeat(600 * 1024) }))).status, 200);
  assert.equal((await PC1('/demo/files/content', json('PUT', { path: 'deliverables/big2.txt', content: 'x'.repeat(600 * 1024) }))).data.error, 'project_quota_exceeded');
  assert.equal((await PC1('/demo/files/content', json('PUT', { path: 'deliverables/big1.txt', content: 'small' }))).status, 200, 'replacing a file frees its old size');
  assert.ok((await PC1('/demo/state')).data.usage.limitBytes === 1024 * 1024);
  await f.request('/api/admin/settings', admin, json('POST', { project_quota_mb: 200 }));
  const disk = (await f.request('/api/disk', admin)).data;
  assert.ok(disk.totalBytes > 0 && disk.freeBytes > 0 && disk.reserveBytes === 1024 * 1024 * 1024);
  assert.deepEqual(Object.keys((await f.request('/api/disk', alice)).data).sort(), ['full', 'low'], 'non-admins see no numbers');
  assert.equal((await f.request('/api/admin/settings', admin, json('POST', { disk_reserve_mb: 1048576 }))).status, 200);
  assert.equal((await f.request('/api/disk', admin)).data.full, true);
  assert.equal((await PC1('/demo/messages', json('POST', { to: 'ALL', body: 'blocked by disk' }))).status, 507);
  const upload = new FormData(); upload.append('files', new Blob(['x']), 'x.txt');
  assert.equal((await f.request('/upload', alice, { method: 'POST', body: upload })).status, 507);
  const bodies = fs.readdirSync(path.join(f.dir, 'uploads')).filter(name => !name.startsWith('.')).length;
  assert.equal(bodies, 3, 'templates and big1.txt only; the refused upload left nothing behind');
  await f.request('/api/admin/settings', admin, json('POST', { disk_reserve_mb: 0 }));
  assert.equal((await PC1('/demo/messages', json('POST', { to: 'ALL', body: 'disk ok again' }))).status, 201);

  // Events: cursor, long-poll wake-up, socket push.
  const all = (await S2('/demo/events?since=0')).data;
  assert.ok(all.events.length >= 3);
  const socket = io(f.base, { autoConnect: false, transports: ['websocket'], extraHeaders: { Cookie: alice } });
  t.after(() => socket.disconnect());
  await new Promise((resolve, reject) => { socket.once('init', resolve); socket.once('connect_error', reject); socket.connect(); });
  const pushed = new Promise(resolve => socket.on('project-updated', payload => payload.type === 'message' && resolve(payload)));
  const waiting = S2('/demo/events?since=' + all.cursor + '&wait=20'), started = Date.now();
  setTimeout(() => PC1('/demo/messages', json('POST', { to: 'server2', body: 'wake up' })), 200);
  const woke = (await waiting).data;
  assert.ok(Date.now() - started < 5000); assert.equal(woke.events[0].actor, 'PC1');
  assert.equal((await pushed).project, 'demo');
  assert.equal((await S2('/demo/events?since=999999')).data.reset, true);
});

test('older databases upgrade in place and keep working', async t => {
  const f = await startFixture(t, { legacy: true }), alice = await f.login('alice');
  const old = await key(f, alice, ['clipboard:read', 'clipboard:write']);
  await f.request('/api/v1/clipboard', null, { method: 'PUT', headers: { Authorization: 'Bearer ' + old.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'kept' }) });
  await f.request('/api/projects', alice, json('POST', { id: 'kept' }));
  await f.restart(() => {
    const users = new Database(path.join(f.dir, 'database/users.db')); users.exec('ALTER TABLE agent_keys DROP COLUMN actor'); users.close();
    const workspace = new Database(path.join(f.dir, 'database/workspace.db'));
    // Back to the first project release: no members table and none of the newer columns.
    workspace.exec('DROP TABLE project_members');
    for (const [table, column] of [['projects', 'modules'], ['projects', 'modules_version'], ['projects', 'summary'], ['projects', 'summary_version'], ['projects', 'summary_updated_at'], ['projects', 'summary_updated_by'], ['projects', 'folder_id'], ['projects', 'viewer_title'], ['project_messages', 'edited_at'], ['project_handoffs', 'edited_at'], ['project_decisions', 'kind'], ['project_decisions', 'ref'], ['project_decisions', 'edited_at']]) {
      workspace.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    workspace.close();
  });
  assert.equal((await f.request('/api/v1/clipboard', null, { headers: { Authorization: 'Bearer ' + old.token } })).data.text, 'kept');
  const renewed = await f.login('alice');
  const state = (await f.request('/api/projects/kept/state', renewed)).data;
  assert.equal(state.modules.messages, true);
  assert.ok(state.project.folder_id === null || typeof state.project.folder_id === 'string');
  assert.equal((await f.request('/api/projects/kept/files', renewed)).status, 200, 'the folder is created on first use');
  assert.equal((await f.request('/api/projects/kept/files/content?path=RULES.md', renewed)).status, 200);
});

test('deleting an account removes its projects', async t => {
  const f = await startFixture(t, { legacy: false }), bob = await f.login('bob'), b = await key(f, bob);
  await f.request('/api/projects', bob, json('POST', { id: 'demo' }));
  await agent(f, b.token, 'PC1')('/demo/messages', json('POST', { to: 'ALL', body: 'hello' }));
  assert.equal((await f.request('/api/account', bob, json('DELETE', { confirm: true, username: 'bob', currentPassword: f.password }))).status, 200);
  const database = new Database(path.join(f.dir, 'database/workspace.db'));
  for (const table of ['projects', 'project_messages', 'project_members', 'project_events', 'assets']) assert.equal(database.prepare('SELECT COUNT(*) n FROM ' + table + " WHERE owner_id = 'bob'").get().n, 0, table);
  database.close();
});

test('content guard rules and the Markdown task table parser', () => {
  const guard = new ContentGuard(null);
  assert.throws(() => guard.check({ nested: ['ok', { deeper: '.MODEL q1 npn (bf=100)' }] }), /sensitive_content_blocked/);
  assert.doesNotThrow(() => guard.check({ nodes: [{ id: 'M1', kind: 'nmos', params: { W_um: 2, L_um: 0.06 } }] }));
  const markdown = [
    '| ID | 阶段 | 任务 | 负责 | 前置 | 完成标准 | 交给谁 |', '|---|---|---|---|---|---|---|',
    '| T1 | 准备 | 搭环境 `env` | PC1、server2 | — | 能跑通 | 用户 |',
    '| T2 | 准备 | 写报告 | 两边 | T1 | 8 章 | 用户 |',
    '| T3 | | 定稿 | 用户 | T2 | 通过 | — |',
    '| T3 | | 重复 | pc1 | | | |',
  ].join('\n');
  const parsed = parseTaskTable(markdown, ['PC1', 'server2']);
  assert.deepEqual(parsed.tasks.map(task => task.id), ['T1', 'T2', 'T3', 'T3']);
  assert.deepEqual(parsed.tasks[0].owners, ['PC1', 'server2']); assert.equal(parsed.tasks[0].phase, '准备'); assert.equal(parsed.tasks[0].title, '搭环境 env');
  assert.deepEqual(parsed.tasks[1].owners, ['PC1', 'server2']); assert.deepEqual(parsed.tasks[2].owners, ['USER']);
  assert.equal(parsed.tasks[2].phase, 'T'); assert.deepEqual(parsed.tasks[3].owners, ['PC1']);
  assert.deepEqual(parsed.duplicates, ['T3']);
  assert.match(taskPrompt(['PC1']), /PC1/);
});
