'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const TIMEZONE = 'Asia/Macau';
const DAY = 86400000;
const DEFAULT_QUOTA = 1024 * 1024 * 1024;

function fail(code, status = 400) {
  const error = new Error(code);
  error.status = status;
  throw error;
}

function dateStart(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid_date');
  const utc = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== value) fail('invalid_date');
  return utc - 8 * 60 * 60 * 1000;
}

function validateArchive(input) {
  if (!input || typeof input !== 'object') fail('invalid_archive');
  const { startDate, endDate, scope } = input;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) fail('invalid_title');
  if (!['chat', 'files', 'both'].includes(scope)) fail('invalid_scope');
  const start = dateStart(startDate), end = dateStart(endDate) + DAY;
  if (end <= start) fail('invalid_date_range');
  return { title, scope, startDate, endDate, start, end };
}

class WorkspaceStore {
  constructor(dataDir, users) {
    this.dataDir = dataDir;
    this.uploadsDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'database'), { recursive: true });
    this.db = new Database(path.join(dataDir, 'database', 'workspace.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (
        owner_id TEXT PRIMARY KEY, clipboard_text TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS quotas (owner_id TEXT PRIMARY KEY, limit_bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archives (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL,
        scope TEXT NOT NULL, start_date TEXT, end_date TEXT,
        created_at INTEGER NOT NULL, clipboard_text TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS assets (
        name TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
        original_name TEXT NOT NULL, size INTEGER NOT NULL, time INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        name TEXT PRIMARY KEY REFERENCES assets(name), owner_id TEXT NOT NULL,
        archive_id TEXT REFERENCES archives(id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL,
        archive_id TEXT REFERENCES archives(id), type TEXT NOT NULL,
        text TEXT NOT NULL, sender TEXT, time INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_assets (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        asset_name TEXT NOT NULL REFERENCES assets(name),
        PRIMARY KEY (message_id, asset_name)
      );
      CREATE INDEX IF NOT EXISTS messages_owner ON messages(owner_id, archive_id, time);
      CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id, archive_id);
      CREATE INDEX IF NOT EXISTS archives_owner ON archives(owner_id, created_at);
      CREATE INDEX IF NOT EXISTS asset_references ON message_assets(asset_name);
    `);
    try { this.importLegacy(users); }
    catch (error) { this.db.close(); throw error; }
  }

  importLegacy(users) {
    if (this.db.prepare("SELECT value FROM meta WHERE key = 'legacy_imported'").get()) return;
    const historyFile = path.join(this.dataDir, 'history.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : {};
    if (!history || typeof history !== 'object' || Array.isArray(history)) fail('invalid_legacy_history', 500);
    if (history.messages !== undefined && !Array.isArray(history.messages)) fail('invalid_legacy_history', 500);
    if (history.files !== undefined && !Array.isArray(history.files)) fail('invalid_legacy_history', 500);
    const legacyFiles = new Map();
    for (const entry of fs.readdirSync(this.uploadsDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const stat = fs.statSync(path.join(this.uploadsDir, entry.name));
      const old = (history.files || []).find(file => file.name === entry.name);
      const match = entry.name.match(/^\d+_(.+)$/);
      legacyFiles.set(entry.name, {
        name: entry.name, originalName: old?.originalName || match?.[1] || entry.name,
        size: stat.size, time: Number.isFinite(old?.time) ? old.time : stat.mtimeMs,
      });
    }
    const messages = history.messages || [];
    const clipboard = typeof history.clipboardText === 'string' ? history.clipboardText : '';
    this.db.transaction(() => {
      if (messages.length || legacyFiles.size || clipboard) {
        const admin = users.find(user => user.role === 'admin');
        if (!admin) fail('legacy_admin_missing', 500);
        const archiveId = randomUUID();
        this.db.prepare(`INSERT INTO archives
          (id, owner_id, title, scope, created_at, clipboard_text)
          VALUES (?, ?, ?, 'legacy', ?, ?)`).run(archiveId, admin.id, '升级前共享区', Date.now(), clipboard);
        for (const file of legacyFiles.values()) this.insertFile(admin.id, file, archiveId);
        for (const message of messages) {
          if (!message || typeof message.text !== 'string') fail('invalid_legacy_message', 500);
          this.insertMessage(admin.id, {
            ...message, time: Number.isFinite(message.time) ? message.time : Date.now(),
            files: (message.files || []).filter(file => legacyFiles.has(file.name)),
          }, archiveId);
        }
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('legacy_imported', '1')").run();
    })();
  }

  fileInfo(row) {
    return { name: row.name, originalName: row.original_name, size: row.size, time: row.time };
  }

  messages(owner, archiveId = null) {
    const rows = this.db.prepare(`SELECT * FROM messages WHERE owner_id = ? AND archive_id IS ?
      ORDER BY time, id`).all(owner, archiveId);
    const attachments = this.db.prepare(`SELECT a.* FROM message_assets ma JOIN assets a
      ON a.name = ma.asset_name WHERE ma.message_id = ? AND a.owner_id = ? ORDER BY a.time, a.name`);
    return rows.map(row => {
      const message = { id: row.id, type: row.type, text: row.text, time: row.time };
      if (row.sender) message.from = row.sender;
      const files = attachments.all(row.id, owner).map(asset => this.fileInfo(asset));
      if (files.length) message.files = files;
      return message;
    });
  }

  files(owner, archiveId = null) {
    return this.db.prepare(`SELECT a.* FROM files f JOIN assets a ON a.name = f.name
      WHERE f.owner_id = ? AND f.archive_id IS ? ORDER BY a.time DESC, a.name`).all(owner, archiveId)
      .map(row => this.fileInfo(row));
  }

  snapshot(owner) {
    return {
      clipboardText: this.db.prepare('SELECT clipboard_text FROM workspaces WHERE owner_id = ?').get(owner)?.clipboard_text || '',
      messages: this.messages(owner), files: this.files(owner),
    };
  }

  storage(owner) {
    const fileBytes = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM assets WHERE owner_id = ?').get(owner).n;
    const messageBytes = this.db.prepare('SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM messages WHERE owner_id = ?').get(owner).n;
    const clipboardBytes = this.db.prepare('SELECT COALESCE(SUM(length(CAST(clipboard_text AS BLOB))), 0) AS n FROM workspaces WHERE owner_id = ?').get(owner).n;
    const legacyBytes = this.db.prepare('SELECT COALESCE(SUM(length(CAST(clipboard_text AS BLOB))), 0) AS n FROM archives WHERE owner_id = ?').get(owner).n;
    const quotaBytes = this.db.prepare('SELECT limit_bytes FROM quotas WHERE owner_id = ?').get(owner)?.limit_bytes ?? DEFAULT_QUOTA;
    const textBytes = messageBytes + clipboardBytes + legacyBytes;
    return { usedBytes: fileBytes + textBytes, quotaBytes, fileBytes, textBytes, availableBytes: Math.max(0, quotaBytes - fileBytes - textBytes) };
  }

  setQuota(owner, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 ** 4) fail('invalid_quota');
    this.db.prepare(`INSERT INTO quotas (owner_id, limit_bytes) VALUES (?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET limit_bytes = excluded.limit_bytes`).run(owner, limit);
    return this.storage(owner);
  }

  enforceQuota(owner, additionalBytes) {
    if (additionalBytes <= 0) return;
    const { usedBytes, quotaBytes } = this.storage(owner);
    if (usedBytes + additionalBytes + (this.pendingBytes?.(owner) || 0) > quotaBytes) fail('quota_exceeded', 413);
  }

  setClipboard(owner, text) {
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT clipboard_text FROM workspaces WHERE owner_id = ?').get(owner)?.clipboard_text || '';
      this.enforceQuota(owner, Buffer.byteLength(text) - Buffer.byteLength(old));
      this.db.prepare(`INSERT INTO workspaces (owner_id, clipboard_text) VALUES (?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET clipboard_text = excluded.clipboard_text`).run(owner, text);
    })();
  }

  insertMessage(owner, message, archiveId = null) {
    const result = this.db.prepare(`INSERT INTO messages (owner_id, archive_id, type, text, sender, time)
      VALUES (?, ?, ?, ?, ?, ?)`).run(owner, archiveId, message.type || 'user', message.text, message.from || null, message.time);
    const id = Number(result.lastInsertRowid);
    for (const file of message.files || []) {
      if (this.db.prepare('SELECT name FROM assets WHERE name = ? AND owner_id = ?').get(file.name, owner)) {
        this.db.prepare('INSERT OR IGNORE INTO message_assets VALUES (?, ?)').run(id, file.name);
      }
    }
    return { ...message, id };
  }

  addMessage(owner, message) {
    return this.db.transaction(() => {
      this.enforceQuota(owner, Buffer.byteLength(message.text));
      return this.insertMessage(owner, message);
    })();
  }

  insertFile(owner, file, archiveId = null) {
    this.db.prepare('INSERT INTO assets (name, owner_id, original_name, size, time) VALUES (?, ?, ?, ?, ?)')
      .run(file.name, owner, file.originalName, file.size, file.time);
    this.db.prepare('INSERT INTO files (name, owner_id, archive_id) VALUES (?, ?, ?)').run(file.name, owner, archiveId);
  }

  addUpload(owner, username, files) {
    return this.db.transaction(() => {
      const text = '📎 ' + files.map(file => file.originalName).join(', ');
      this.enforceQuota(owner, files.reduce((bytes, file) => bytes + file.size, 0) + Buffer.byteLength(text));
      for (const file of files) this.insertFile(owner, file);
      return this.insertMessage(owner, {
        type: 'system', text,
        from: username, time: Date.now(), files,
      });
    })();
  }

  downloadable(owner, name) {
    return this.db.prepare(`SELECT a.* FROM assets a WHERE a.owner_id = ? AND a.name = ?
      AND (EXISTS (SELECT 1 FROM files f WHERE f.name = a.name)
        OR EXISTS (SELECT 1 FROM message_assets ma WHERE ma.asset_name = a.name))`).get(owner, name);
  }

  cleanupAssets(owner) {
    const unused = this.db.prepare(`SELECT name FROM assets a WHERE a.owner_id = ?
      AND NOT EXISTS (SELECT 1 FROM files f WHERE f.name = a.name)
      AND NOT EXISTS (SELECT 1 FROM message_assets ma WHERE ma.asset_name = a.name)`).all(owner);
    for (const { name } of unused) {
      try {
        fs.rmSync(path.join(this.uploadsDir, name), { force: true });
        this.db.prepare('DELETE FROM assets WHERE name = ? AND owner_id = ?').run(name, owner);
      } catch (error) {
        console.error('File cleanup deferred:', error.code || 'file_error');
      }
    }
  }

  clear(owner, scope) {
    if (!['chat', 'files'].includes(scope)) fail('invalid_scope');
    this.db.transaction(() => {
      if (scope === 'chat') this.db.prepare('DELETE FROM messages WHERE owner_id = ? AND archive_id IS NULL').run(owner);
      else {
        // Archived conversations keep their attachments when the active file list is cleared.
        this.db.prepare(`DELETE FROM message_assets WHERE message_id IN
          (SELECT id FROM messages WHERE owner_id = ? AND archive_id IS NULL)
          AND asset_name IN (SELECT name FROM files WHERE owner_id = ? AND archive_id IS NULL)`).run(owner, owner);
        this.db.prepare('DELETE FROM files WHERE owner_id = ? AND archive_id IS NULL').run(owner);
      }
    })();
    this.cleanupAssets(owner);
  }

  deleteFile(owner, name) {
    if (!this.db.prepare('SELECT name FROM files WHERE owner_id = ? AND name = ? AND archive_id IS NULL').get(owner, name)) fail('not_found', 404);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM message_assets WHERE asset_name = ? AND message_id IN
        (SELECT id FROM messages WHERE owner_id = ? AND archive_id IS NULL)`).run(name, owner);
      this.db.prepare('DELETE FROM files WHERE owner_id = ? AND name = ? AND archive_id IS NULL').run(owner, name);
    })();
    this.cleanupAssets(owner);
  }

  archive(owner, input) {
    const range = validateArchive(input);
    const id = randomUUID();
    this.db.transaction(() => {
      const messageCount = range.scope === 'files' ? 0 : this.db.prepare(`SELECT COUNT(*) AS n FROM messages
        WHERE owner_id = ? AND archive_id IS NULL AND time >= ? AND time < ?`).get(owner, range.start, range.end).n;
      const fileCount = range.scope === 'chat' ? 0 : this.db.prepare(`SELECT COUNT(*) AS n FROM files f JOIN assets a ON a.name = f.name
        WHERE f.owner_id = ? AND f.archive_id IS NULL AND a.time >= ? AND a.time < ?`).get(owner, range.start, range.end).n;
      if (!messageCount && !fileCount) fail('empty_archive');
      this.db.prepare(`INSERT INTO archives (id, owner_id, title, scope, start_date, end_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, owner, range.title, range.scope, range.startDate, range.endDate, Date.now());
      if (messageCount) this.db.prepare(`UPDATE messages SET archive_id = ?
        WHERE owner_id = ? AND archive_id IS NULL AND time >= ? AND time < ?`).run(id, owner, range.start, range.end);
      if (fileCount) this.db.prepare(`UPDATE files SET archive_id = ? WHERE owner_id = ? AND archive_id IS NULL
        AND name IN (SELECT name FROM assets WHERE time >= ? AND time < ?)`).run(id, owner, range.start, range.end);
    })();
    return this.getArchive(owner, id);
  }

  listArchives(owner) {
    return this.db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM messages m WHERE m.archive_id = a.id) AS message_count,
      (SELECT COUNT(*) FROM files f WHERE f.archive_id = a.id) AS file_count
      FROM archives a WHERE a.owner_id = ? ORDER BY a.created_at DESC, a.id`).all(owner);
  }

  getArchive(owner, id) {
    const archive = this.db.prepare('SELECT * FROM archives WHERE id = ? AND owner_id = ?').get(id, owner);
    if (!archive) fail('not_found', 404);
    return { ...archive, messages: this.messages(owner, id), files: this.files(owner, id) };
  }

  renameArchive(owner, id, title) {
    this.getArchive(owner, id);
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle || cleanTitle.length > 80 || /[\x00-\x1f\x7f]/.test(cleanTitle)) fail('invalid_title');
    this.db.prepare('UPDATE archives SET title = ? WHERE id = ? AND owner_id = ?').run(cleanTitle, id, owner);
  }

  restoreArchive(owner, id) {
    this.getArchive(owner, id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE messages SET archive_id = NULL WHERE owner_id = ? AND archive_id = ?').run(owner, id);
      this.db.prepare('UPDATE files SET archive_id = NULL WHERE owner_id = ? AND archive_id = ?').run(owner, id);
      // Keep a legacy archive that contains the old clipboard; never overwrite the user's current clipboard.
      const row = this.db.prepare('SELECT clipboard_text FROM archives WHERE owner_id = ? AND id = ?').get(owner, id);
      if (!row.clipboard_text) this.db.prepare('DELETE FROM archives WHERE owner_id = ? AND id = ?').run(owner, id);
    })();
  }

  deleteArchive(owner, id) {
    this.getArchive(owner, id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE owner_id = ? AND archive_id = ?').run(owner, id);
      this.db.prepare('DELETE FROM files WHERE owner_id = ? AND archive_id = ?').run(owner, id);
      this.db.prepare('DELETE FROM archives WHERE owner_id = ? AND id = ?').run(owner, id);
    })();
    this.cleanupAssets(owner);
  }

  deleteAccount(owner) {
    // Account and workspace records are removed together. File bodies are
    // cleaned only after the database transaction has committed.
    if (!this.db.pragma('database_list').some(database => database.name === 'accounts')) {
      this.db.prepare('ATTACH DATABASE ? AS accounts').run(path.join(this.dataDir, 'database', 'users.db'));
    }
    const files = this.db.transaction(() => {
      const user = this.db.prepare('SELECT role FROM accounts.users WHERE id = ?').get(owner);
      if (!user) fail('not_found', 404);
      if (user.role === 'admin' && this.db.prepare("SELECT COUNT(*) AS n FROM accounts.users WHERE role = 'admin' AND status = 'active' AND id != ?").get(owner).n === 0) fail('last_admin', 409);
      const names = this.db.prepare('SELECT name FROM assets WHERE owner_id = ?').all(owner);
      this.db.prepare('DELETE FROM share_recipients WHERE user_id = ?').run(owner);
      this.db.prepare('DELETE FROM file_shares WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM messages WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM files WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM archives WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM assets WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM workspaces WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM quotas WHERE owner_id = ?').run(owner);
      this.db.prepare('DELETE FROM accounts.users WHERE id = ?').run(owner);
      return names;
    })();
    for (const { name } of files) {
      try { fs.rmSync(path.join(this.uploadsDir, name), { force: true }); }
      catch (error) { console.error('Account file cleanup deferred:', error.code || 'file_error'); }
    }
  }

  close() { this.db.close(); }
}

module.exports = { WorkspaceStore, validateArchive, TIMEZONE, DEFAULT_QUOTA };
