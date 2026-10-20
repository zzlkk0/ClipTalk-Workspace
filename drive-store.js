'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
function fail(code, status = 400) { throw Object.assign(new Error(code), { status }); }

class DriveStore {
  constructor(workspace) {
    this.workspace = workspace;
    this.db = workspace.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drive_folders (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT REFERENCES drive_folders(id),
        name TEXT NOT NULL, created_at INTEGER NOT NULL, source_archive_id TEXT
      );
      CREATE TABLE IF NOT EXISTS drive_files (
        name TEXT PRIMARY KEY REFERENCES assets(name) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, folder_id TEXT REFERENCES drive_folders(id)
      );
      CREATE INDEX IF NOT EXISTS drive_parent ON drive_folders(owner_id, parent_id);
      CREATE UNIQUE INDEX IF NOT EXISTS drive_folder_names ON drive_folders(owner_id, COALESCE(parent_id, ''), name);
      CREATE INDEX IF NOT EXISTS drive_contents ON drive_files(owner_id, folder_id);
      CREATE TRIGGER IF NOT EXISTS drive_new_asset AFTER INSERT ON assets BEGIN
        INSERT INTO drive_files(name, owner_id) VALUES (NEW.name, NEW.owner_id);
      END;
    `);
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM meta WHERE key = 'drive_imported'").get()) return;
      const folders = new Map();
      for (const row of this.db.prepare(`SELECT a.name, a.owner_id, f.archive_id, ar.title FROM assets a
        LEFT JOIN files f ON f.name = a.name LEFT JOIN archives ar ON ar.id = f.archive_id`).all()) {
        let folder = null;
        if (row.archive_id) {
          if (!folders.has(row.archive_id)) {
            const base = (row.title || 'Archive').replace(/[\\/\x00-\x1f\x7f]/g, ' ').trim() || 'Archive';
            let name = base, suffix = 1;
            while (this.db.prepare('SELECT 1 FROM drive_folders WHERE owner_id = ? AND parent_id IS NULL AND name = ?').get(row.owner_id, name)) name = base + ' (' + suffix++ + ')';
            const id = randomUUID();
            this.db.prepare('INSERT INTO drive_folders VALUES (?, ?, NULL, ?, ?, ?)').run(id, row.owner_id, name, Date.now(), row.archive_id);
            folders.set(row.archive_id, id);
          }
          folder = folders.get(row.archive_id);
        }
        this.db.prepare('INSERT OR IGNORE INTO drive_files VALUES (?, ?, ?)').run(row.name, row.owner_id, folder);
      }
      this.db.prepare("INSERT INTO meta VALUES ('drive_imported', '1')").run();
    })();
    workspace.drive = this;
  }

  folder(owner, id) {
    if (id === null || id === undefined || id === '') return null;
    if (typeof id !== 'string') fail('invalid_folder');
    const row = this.db.prepare('SELECT * FROM drive_folders WHERE owner_id = ? AND id = ?').get(owner, id);
    if (!row) fail('not_found', 404);
    return row;
  }

  name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\\/\x00-\x1f\x7f]/.test(value) || ['.', '..'].includes(value.trim())) fail('invalid_folder_name');
    return value.trim();
  }

  folders(owner) {
    return this.db.prepare('SELECT id, parent_id AS parentId, name FROM drive_folders WHERE owner_id = ? ORDER BY name, id').all(owner);
  }

  list(owner, id = null) {
    const folder = this.folder(owner, id);
    const folderId = folder?.id || null, breadcrumbs = [];
    for (let current = folder; current; current = this.folder(owner, current.parent_id)) {
      breadcrumbs.unshift({ id: current.id, name: current.name });
    }
    return {
      folderId, breadcrumbs,
      folders: this.db.prepare('SELECT id, name FROM drive_folders WHERE owner_id = ? AND parent_id IS ? ORDER BY name, id').all(owner, folderId),
      files: this.db.prepare(`SELECT a.* FROM drive_files d JOIN assets a ON a.name = d.name
        WHERE d.owner_id = ? AND d.folder_id IS ? ORDER BY a.time DESC, a.name`).all(owner, folderId).map(row => this.workspace.fileInfo(row)),
    };
  }

  createFolder(owner, input) {
    return this.db.transaction(() => {
      const parent = this.folder(owner, input.parentId);
      const name = this.name(input.name);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM drive_folders WHERE owner_id = ?').get(owner).n >= 1000) fail('folder_limit');
      this.validateDestination(owner, null, parent?.id || null, name);
      const id = randomUUID();
      this.db.prepare('INSERT INTO drive_folders VALUES (?, ?, ?, ?, ?, NULL)').run(id, owner, parent?.id || null, name, Date.now());
      return { id, name, parentId: parent?.id || null };
    })();
  }

  descendants(owner, id) {
    return this.db.prepare(`WITH RECURSIVE tree(id, depth) AS (
      SELECT id, 0 FROM drive_folders WHERE owner_id = ? AND id = ?
      UNION ALL SELECT f.id, t.depth + 1 FROM drive_folders f JOIN tree t ON f.parent_id = t.id WHERE f.owner_id = ?
    ) SELECT * FROM tree`).all(owner, id, owner);
  }

  validateDestination(owner, id, parentId, name) {
    let depth = 1;
    for (let current = this.folder(owner, parentId); current; current = this.folder(owner, current.parent_id)) {
      if (current.id === id) fail('folder_cycle');
      depth++;
    }
    const subtree = id ? this.descendants(owner, id) : [];
    if (depth + Math.max(0, ...subtree.map(row => row.depth)) > 32) fail('folder_depth');
    const duplicate = this.db.prepare('SELECT id FROM drive_folders WHERE owner_id = ? AND parent_id IS ? AND name = ?').get(owner, parentId, name);
    if (duplicate && duplicate.id !== id) fail('folder_exists', 409);
  }

  updateFolder(owner, id, input) {
    return this.db.transaction(() => {
      const current = this.folder(owner, id);
      if (!current) fail('invalid_folder');
      const name = input.name === undefined ? current.name : this.name(input.name);
      const parentId = input.parentId === undefined ? current.parent_id : this.folder(owner, input.parentId)?.id || null;
      this.validateDestination(owner, id, parentId, name);
      this.db.prepare('UPDATE drive_folders SET name = ?, parent_id = ? WHERE id = ? AND owner_id = ?').run(name, parentId, id, owner);
      return { id, name, parentId };
    })();
  }

  selected(owner, names) {
    if (!Array.isArray(names) || !names.length || names.length > 100 || names.some(name => typeof name !== 'string')) fail('invalid_files');
    const unique = [...new Set(names)];
    for (const name of unique) {
      if (!this.db.prepare('SELECT 1 FROM drive_files WHERE owner_id = ? AND name = ?').get(owner, name)) fail('not_found', 404);
    }
    return unique;
  }

  moveFiles(owner, names, folderId) {
    this.db.transaction(() => {
      const folder = this.folder(owner, folderId);
      for (const name of this.selected(owner, names)) {
        this.db.prepare('UPDATE drive_files SET folder_id = ? WHERE owner_id = ? AND name = ?').run(folder?.id || null, owner, name);
      }
    })();
  }

  addUpload(owner, username, files, folderId) {
    return this.db.transaction(() => {
      const folder = this.folder(owner, folderId);
      const message = this.workspace.addUpload(owner, username, files);
      for (const file of files) this.db.prepare('UPDATE drive_files SET folder_id = ? WHERE owner_id = ? AND name = ?').run(folder?.id || null, owner, file.name);
      return message;
    })();
  }

  removeRecords(owner, names) {
    for (const name of names) {
      this.db.prepare('DELETE FROM message_assets WHERE asset_name = ?').run(name);
      this.db.prepare('DELETE FROM files WHERE owner_id = ? AND name = ?').run(owner, name);
      this.db.prepare('DELETE FROM assets WHERE owner_id = ? AND name = ?').run(owner, name);
    }
  }

  removeBodies(names) {
    for (const name of names) {
      try { fs.rmSync(path.join(this.workspace.uploadsDir, name), { force: true }); }
      catch (error) { console.error('Drive file cleanup deferred:', error.code || 'file_error'); }
    }
  }

  deleteFiles(owner, names) {
    const selected = this.db.transaction(() => {
      const selected = this.selected(owner, names);
      this.removeRecords(owner, selected);
      return selected;
    })();
    this.removeBodies(selected);
  }

  deleteFolder(owner, id) {
    const removed = this.db.transaction(() => {
      if (!this.folder(owner, id)) fail('invalid_folder');
      const descendants = this.descendants(owner, id).sort((a, b) => b.depth - a.depth);
      const names = descendants.flatMap(row => this.db.prepare('SELECT name FROM drive_files WHERE owner_id = ? AND folder_id = ?').all(owner, row.id).map(file => file.name));
      this.removeRecords(owner, names);
      for (const row of descendants) this.db.prepare('DELETE FROM drive_folders WHERE owner_id = ? AND id = ?').run(owner, row.id);
      return names;
    })();
    this.removeBodies(removed);
  }
}
module.exports = { DriveStore };
