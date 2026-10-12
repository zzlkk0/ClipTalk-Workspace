'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore, validateArchive } = require('../workspace-store');
const users = [{ id: 'admin', role: 'admin' }, { id: 'alice', role: 'user' }, { id: 'bob', role: 'user' }];
const today = { startDate: '2026-10-12', endDate: '2026-10-12', scope: 'both', title: '研究记录' };
const noon = Date.parse('2026-10-12T04:00:00Z');
function fixture(t, setup = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliptalk-store-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  setup(dir);
  const store = new WorkspaceStore(dir, users);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
function upload(store, owner, name, time = noon) {
  fs.writeFileSync(path.join(store.uploadsDir, name), 'test-content');
  store.addUpload(owner, owner, [{ name, originalName: name, time, size: 12 }]);
}

test('legacy records import once into the admin archive; each active workspace is empty', t => {
  const { store, dir } = fixture(t, dir => {
    fs.writeFileSync(path.join(dir, 'uploads', '123_old.txt'), 'old-file');
    fs.writeFileSync(path.join(dir, 'uploads', '456_unlisted.txt'), 'unlisted');
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
      clipboardText: 'old clipboard', files: [{ name: '123_old.txt', originalName: '旧文件.txt', time: noon }],
      messages: [{ type: 'user', from: 'old-user', text: 'historical message', time: noon },
        { type: 'system', text: 'attachment', time: noon, files: [{ name: '123_old.txt' }] }],
    }));
  });
  for (const user of users) assert.deepEqual(store.snapshot(user.id), { clipboardText: '', messages: [], files: [] });
  assert.equal(store.listArchives('alice').length, 0);
  const archive = store.getArchive('admin', store.listArchives('admin')[0].id);
  assert.equal(archive.title, '升级前共享区');
  assert.equal(archive.clipboard_text, 'old clipboard');
  assert.equal(archive.messages.length, 2);
  assert.equal(archive.files.length, 2);
  assert.equal(archive.messages[1].files[0].originalName, '旧文件.txt');
  assert.equal(store.downloadable('alice', '123_old.txt'), undefined);
  assert.throws(() => store.getArchive('alice', archive.id), /not_found/);
  const original = fs.readFileSync(path.join(dir, 'history.json'), 'utf8');
  store.importLegacy(users);
  assert.equal(store.listArchives('admin').length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'), original);
});

test('account clipboard, chat, files and archives stay isolated', t => {
  const { store } = fixture(t);
  store.setClipboard('alice', 'private clipboard');
  store.addMessage('alice', { text: 'private chat', time: noon, from: 'alice' });
  upload(store, 'alice', 'alice-file');
  assert.deepEqual(store.snapshot('bob'), { clipboardText: '', messages: [], files: [] });
  assert.equal(store.downloadable('bob', 'alice-file'), undefined);
  assert.throws(() => store.deleteFile('bob', 'alice-file'), /not_found/);
  const archive = store.archive('alice', today);
  assert.equal(store.listArchives('bob').length, 0);
  for (const action of [() => store.getArchive('bob', archive.id), () => store.renameArchive('bob', archive.id, 'stolen'), () => store.restoreArchive('bob', archive.id)]) assert.throws(action, /not_found/);
  assert.equal(store.getArchive('alice', archive.id).files.length, 1);
});

test('archive dates include both days in Macau time, with precise midnight boundaries', t => {
  const { store } = fixture(t);
  for (const [text, time] of [
    ['before', '2026-10-11T15:59:59.999Z'], ['first', '2026-10-11T16:00:00Z'],
    ['last', '2026-10-12T15:59:59.999Z'], ['after', '2026-10-12T16:00:00Z'],
  ]) store.addMessage('alice', { text, time: Date.parse(time) });
  const archive = store.archive('alice', { ...today, scope: 'chat' });
  assert.deepEqual(archive.messages.map(message => message.text), ['first', 'last']);
  assert.deepEqual(store.snapshot('alice').messages.map(message => message.text), ['before', 'after']);
  store.renameArchive('alice', archive.id, '<script>研究记录</script>');
  assert.equal(store.getArchive('alice', archive.id).title, '<script>研究记录</script>');
  store.restoreArchive('alice', archive.id);
  assert.deepEqual(store.snapshot('alice').messages.map(message => message.text), ['before', 'first', 'last', 'after']);
  assert.equal(store.listArchives('alice').length, 0);
});

test('date/name/scope validation rejects impossible dates, reversed ranges and empty archives', t => {
  const { store } = fixture(t);
  for (const bad of [
    { startDate: '2026-02-30' }, { startDate: '2026-2-01' }, { endDate: '2026-10-11' },
    { title: '' }, { title: 'x'.repeat(81) }, { title: 'control\nname' }, { scope: 'all' },
  ]) assert.throws(() => validateArchive({ ...today, ...bad }));
  assert.throws(() => store.archive('alice', today), /empty_archive/);
  assert.equal(store.listArchives('alice').length, 0);
});

test('clearing active content preserves archived attachments and never touches other owners', t => {
  const { store } = fixture(t);
  upload(store, 'alice', 'archive-attachment');
  // Upload notices use current time; fix the test fixture to the archive date.
  store.db.prepare('UPDATE messages SET time = ? WHERE owner_id = ?').run(noon, 'alice');
  const archive = store.archive('alice', { ...today, scope: 'chat' });
  upload(store, 'bob', 'bob-file');
  upload(store, 'alice', 'discard-file');
  store.clear('alice', 'files');
  assert.equal(store.snapshot('alice').files.length, 0);
  assert.equal(store.downloadable('alice', 'discard-file'), undefined);
  assert.equal(fs.existsSync(path.join(store.uploadsDir, 'discard-file')), false);
  assert.ok(store.downloadable('alice', 'archive-attachment'));
  assert.equal(store.getArchive('alice', archive.id).messages[0].files.length, 1);
  assert.equal(fs.existsSync(path.join(store.uploadsDir, 'archive-attachment')), true);
  assert.equal(store.snapshot('bob').files.length, 1);
  store.clear('alice', 'chat');
  assert.equal(store.snapshot('alice').messages.length, 0);
  assert.equal(store.getArchive('alice', archive.id).messages.length, 1);
  assert.ok(store.downloadable('alice', 'archive-attachment'));
});

test('an archived file remains available through clear and restore', t => {
  const { store } = fixture(t);
  upload(store, 'alice', 'keep-file');
  const archive = store.archive('alice', { ...today, scope: 'files' });
  store.clear('alice', 'files'); store.clear('alice', 'chat');
  assert.ok(store.downloadable('alice', 'keep-file'));
  store.restoreArchive('alice', archive.id);
  assert.equal(store.snapshot('alice').files[0].name, 'keep-file');
});

test('SQLite state persists independently of the old shared JSON history', t => {
  const { store, dir } = fixture(t);
  store.setClipboard('alice', 'saved');
  store.addMessage('alice', { text: 'persisted', time: noon });
  const second = new WorkspaceStore(dir, users);
  assert.equal(second.snapshot('alice').clipboardText, 'saved');
  assert.equal(second.snapshot('alice').messages[0].text, 'persisted');
  second.close();
});

test('malformed legacy input fails without claiming a successful migration', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliptalk-malformed-'));
  fs.writeFileSync(path.join(dir, 'history.json'), '{invalid');
  assert.throws(() => new WorkspaceStore(dir, users));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ clipboardText: 'recovered' }));
  const store = new WorkspaceStore(dir, users);
  assert.equal(store.listArchives('admin').length, 1);
  store.close(); fs.rmSync(dir, {recursive:true, force:true});
});

test('default 1 GB quota counts UTF-8 text, all files and archives without double counting', t => {
  const { store } = fixture(t);
  assert.equal(store.storage('alice').quotaBytes, 1024 ** 3);
  store.setQuota('alice', 100);
  store.setClipboard('alice', '中文');
  store.addMessage('alice', { text: '字符', time: noon });
  assert.equal(store.storage('alice').textBytes, 12);
  const archive = store.archive('alice', { ...today, scope: 'chat' });
  assert.equal(store.storage('alice').textBytes, 12);
  assert.throws(() => store.addMessage('alice', { text: 'x'.repeat(89), time: noon }), /quota_exceeded/);
  assert.throws(() => store.setClipboard('alice', 'x'.repeat(95)), /quota_exceeded/);
  assert.equal(store.snapshot('alice').clipboardText, '中文');
  assert.equal(store.snapshot('alice').messages.length, 0);
  store.deleteArchive('alice', archive.id);
  assert.equal(store.storage('alice').textBytes, 6);
  store.setClipboard('alice', '');
  assert.equal(store.storage('alice').usedBytes, 0);
});

test('quota reduction keeps existing data, blocks growth and permits cleanup', t => {
  const { store } = fixture(t);
  store.setClipboard('alice', 'x'.repeat(100));
  store.setQuota('alice', 50);
  assert.equal(store.snapshot('alice').clipboardText.length, 100);
  assert.throws(() => store.addMessage('alice', { text: 'x', time: noon }), /quota_exceeded/);
  store.setClipboard('alice', 'x'.repeat(60));
  assert.equal(store.storage('alice').usedBytes, 60);
  store.setClipboard('alice', '');
  store.addMessage('alice', { text: 'now allowed', time: noon });
  assert.equal(store.storage('alice').usedBytes, 11);
  for (const invalid of [0,-1,1.5,'100',null,2**41]) assert.throws(() => store.setQuota('alice', invalid), /invalid_quota/);
});

test('deleting an archive releases its unreferenced files and stays within the owner', t => {
  const { store } = fixture(t);
  upload(store, 'alice', 'alice-archive');
  upload(store, 'bob', 'bob-archive');
  store.db.prepare('UPDATE messages SET time = ?').run(noon);
  const archive = store.archive('alice', today);
  const used = store.storage('alice').usedBytes;
  assert.ok(used >= 12);
  assert.throws(() => store.deleteArchive('bob', archive.id), /not_found/);
  store.deleteArchive('alice', archive.id);
  assert.equal(store.storage('alice').usedBytes, 0);
  assert.equal(store.downloadable('alice', 'alice-archive'), undefined);
  assert.equal(fs.existsSync(path.join(store.uploadsDir, 'alice-archive')), false);
  assert.equal(store.snapshot('bob').files.length, 1);
});

test('in-flight reservations enforce one shared quota across concurrent devices', t => {
  const { store } = fixture(t);
  const { QuotaStorage } = require('../quota-storage');
  const storage = new QuotaStorage(store);
  store.setQuota('alice', 100);
  const a={session:{userId:'alice'}},b={session:{userId:'alice'}},other={session:{userId:'bob'}};
  storage.reserve(a,60);
  assert.throws(()=>storage.reserve(b,41), /quota_exceeded/);
  storage.reserve(b,40);storage.reserve(other,1000);
  assert.equal(storage.pending.get('alice'),100);
  storage.release(a);storage.release(a);
  assert.equal(storage.pending.get('alice'),40);
  storage.reserve(b,60);
  storage.release(b);storage.release(other);
  assert.equal(storage.pending.size,0);
  assert.throws(()=>storage.reserve(a,1),/upload_aborted/);
});
