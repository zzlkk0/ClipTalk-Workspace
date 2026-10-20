'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore } = require('../workspace-store');
const { DriveStore } = require('../drive-store');
const { startFixture, json, macauDate } = require('./fixture');

async function upload(f, cookie, folderId, name = 'report.txt') {
  const body = new FormData(); body.append('files', new Blob(['private content']), name);
  return f.request('/upload' + (folderId ? '?folderId=' + folderId : ''), cookie, { method: 'POST', body });
}

test('drive migration preserves all old records and bodies; archived files become folders exactly once', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliptalk-drive-'));
  const users = [{ id: 'alice', role: 'admin' }, { id: 'bob', role: 'user' }];
  let workspace = new WorkspaceStore(dir, users);
  t.after(() => { workspace.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function add(name, owner = 'alice') {
    fs.writeFileSync(path.join(dir, 'uploads', name), 'payload');
    workspace.addUpload(owner, owner, [{ name, originalName: name, size: 7, time: Date.now() }]);
  }
  add('archived.txt');
  const today = macauDate();
  const archived = workspace.archive('alice', { title: '研究资料', scope: 'both', startDate: today, endDate: today });
  add('current.txt'); add('other.txt', 'bob');
  const tables = ['workspaces', 'quotas', 'archives', 'assets', 'files', 'messages', 'message_assets'];
  const before = tables.map(table => workspace.db.prepare('SELECT * FROM ' + table).all());
  const quota = workspace.storage('alice');
  const drive = new DriveStore(workspace);
  assert.deepEqual(tables.map(table => workspace.db.prepare('SELECT * FROM ' + table).all()), before);
  assert.deepEqual(workspace.storage('alice'), quota);
  const root = drive.list('alice');
  assert.equal(root.folders[0].name, '研究资料');
  assert.equal(root.files[0].name, 'current.txt');
  assert.equal(drive.list('alice', root.folders[0].id).files[0].name, 'archived.txt');
  assert.equal(drive.list('bob').folders.length, 0);
  drive.moveFiles('alice', ['archived.txt'], null);
  workspace.close(); workspace = new WorkspaceStore(dir, users);
  const restarted = new DriveStore(workspace);
  assert.equal(restarted.list('alice').folders.length, 1);
  assert.equal(restarted.list('alice').files.length, 2);
  workspace.deleteArchive('alice', archived.id);
  assert.ok(workspace.downloadable('alice', 'archived.txt'));
  assert.equal(fs.readFileSync(path.join(dir, 'uploads/archived.txt'), 'utf8'), 'payload');
  assert.equal(workspace.db.pragma('foreign_key_check').length, 0);
});

test('drive API: owned folders, atomic moves, validation, nested deletion, shares and account cleanup', async t => {
  const f = await startFixture(t, { legacy: false });
  const a = await f.login('alice'), b = await f.login('bob'), admin = await f.login('test_admin');
  const make = async (cookie, name, parentId = null) => {
    const result = await f.request('/api/drive/folders', cookie, json('POST', { name, parentId, ownerId: 'bob' }));
    assert.equal(result.status, 201); return result.data;
  };
  assert.equal((await f.request('/api/drive')).status, 401);
  const root = await make(a, 'Root'), child = await make(a, 'Child', root.id), foreign = await make(b, 'Bob');
  assert.deepEqual((await f.request('/api/drive/folders', b)).data.map(row => row.id), [foreign.id]);
  for (const cookie of [b, admin]) {
    assert.equal((await f.request('/api/drive?folderId=' + root.id, cookie)).status, 404);
    assert.equal((await f.request('/api/drive/folders/' + root.id, cookie, json('PATCH', { name: 'stolen' }))).status, 404);
    assert.equal((await f.request('/api/drive/folders/' + root.id, cookie, json('DELETE', { confirm: true }))).status, 404);
  }
  for (const name of ['..', 'a/b', 'a\\b', 'bad\nname', '', 'x'.repeat(121)]) {
    assert.equal((await f.request('/api/drive/folders', a, json('POST', { name }))).status, 400);
  }
  assert.equal((await f.request('/api/drive/folders', a, json('POST', { name: 'Root' }))).status, 409);
  assert.equal((await f.request('/api/drive/folders', a, json('POST', { name: 'bad parent', parentId: foreign.id }))).status, 404);
  assert.equal((await f.request('/api/drive/folders/' + root.id, a, json('PATCH', { parentId: child.id }))).data.error, 'folder_cycle');
  assert.equal((await f.request('/api/drive/folders/' + child.id, a, json('PATCH', { name: 'Renamed' }))).status, 200);
  assert.deepEqual((await f.request('/api/drive?folderId=' + child.id, a)).data.breadcrumbs.map(row => row.name), ['Root', 'Renamed']);
  assert.equal((await upload(f, a, foreign.id)).status, 404);
  const uploaded = await upload(f, a, child.id); assert.equal(uploaded.status, 200);
  const file = uploaded.data.files[0];
  assert.equal((await f.request('/api/drive', a)).data.files.length, 0);
  const used = (await f.request('/api/storage', a)).data.usedBytes;
  const share = (await f.request('/api/shares', a, json('POST', { name: file.name, visibility: 'public' }))).data;
  for (const [names, folderId, status] of [
    [[file.name], foreign.id, 404], [[file.name, 'missing'], root.id, 404], [[], root.id, 400],
  ]) assert.equal((await f.request('/api/drive/files', a, json('PATCH', { names, folderId }))).status, status);
  assert.equal((await f.request('/api/drive?folderId=' + child.id, a)).data.files.length, 1);
  assert.equal((await f.request('/api/drive/files', b, json('PATCH', { names: [file.name], folderId: foreign.id }))).status, 404);
  assert.equal((await f.request('/api/drive/files', a, json('PATCH', { names: [file.name], folderId: root.id }))).status, 200);
  assert.equal((await f.request('/api/drive?folderId=' + root.id, a)).data.files[0].name, file.name);
  assert.equal((await f.request('/api/storage', a)).data.usedBytes, used);
  assert.equal(await (await fetch(f.base + '/api/shares/' + share.token + '/download')).text(), 'private content');
  const today = macauDate();
  const archive = (await f.request('/api/archives', a, json('POST', { title: 'Chat', scope: 'chat', startDate: today, endDate: today }))).data;
  assert.equal((await f.request('/api/drive/folders/' + root.id, a, json('DELETE', {}))).status, 400);
  assert.equal((await f.request('/api/drive/folders/' + root.id, a, json('DELETE', { confirm: true }))).status, 200);
  assert.equal((await f.request('/api/drive/folders', a)).data.length, 0);
  assert.equal((await f.request('/api/storage', a)).data.fileBytes, 0);
  assert.equal((await f.request('/api/shares/' + share.token)).status, 404);
  const archivedMessages = (await f.request('/api/archives/' + archive.id, a)).data.messages;
  assert.equal(archivedMessages.length, 1);
  assert.equal((archivedMessages[0].files || []).length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'uploads', file.name)), false);
  assert.equal((await f.request('/api/drive/folders', b)).data.length, 1);
  const another = await make(a, 'New'); await make(a, 'Nested', another.id); await upload(f, a, another.id);
  assert.equal((await f.request('/api/account', a, json('DELETE', { confirm: true, username: 'alice', currentPassword: f.password }))).status, 200);
  const Database = require('better-sqlite3'), db = new Database(path.join(f.dir, 'database/workspace.db'));
  for (const table of ['drive_folders', 'drive_files']) assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE owner_id = ?').get('alice').n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close();
});

test('uploads recheck a deleted destination and clean partial files after cancellation', async t => {
  const http = require('node:http');
  const f = await startFixture(t, { legacy: false }), a = await f.login('alice');
  const folder = (await f.request('/api/drive/folders', a, json('POST', { name: 'temporary' }))).data;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (check()) return; await pause(20); }
    assert.fail('Upload state did not settle');
  }
  const bodies = () => fs.readdirSync(path.join(f.dir, 'uploads'));
  function begin(folderId) {
    let request;
    const complete = new Promise((resolve, reject) => {
      request = http.request(f.base + '/upload' + (folderId ? '?folderId=' + folderId : ''), {
        method: 'POST', headers: { Cookie: a, 'Content-Type': 'multipart/form-data; boundary=drive-test' },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', error => error.code === 'ECONNRESET' ? resolve(0) : reject(error));
      request.write('--drive-test\r\nContent-Disposition: form-data; name="files"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\n' + 'x'.repeat(4096));
    });
    t.after(() => request.destroy());
    return { request, complete };
  }
  const slow = begin(folder.id);
  await waitFor(() => bodies().length === 1);
  assert.equal((await f.request('/api/drive/folders/' + folder.id, a, json('DELETE', { confirm: true }))).status, 200);
  slow.request.end('\r\n--drive-test--\r\n');
  assert.equal(await slow.complete, 404);
  await waitFor(() => bodies().length === 0);
  const cancelled = begin();
  await waitFor(() => bodies().length === 1);
  cancelled.request.destroy(); await cancelled.complete;
  await waitFor(() => bodies().length === 0);
  assert.equal((await f.request('/api/storage', a)).data.usedBytes, 0);
  assert.equal((await upload(f, a)).status, 200);
});
