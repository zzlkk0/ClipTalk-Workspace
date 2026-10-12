'use strict';
const { randomBytes } = require('crypto');

function fail(code, status = 400) { throw Object.assign(new Error(code), { status }); }

class SharingStore {
  constructor(workspace, accounts) {
    this.workspace = workspace;
    this.db = workspace.db;
    this.accounts = accounts;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_shares (
        token TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
        asset_name TEXT NOT NULL REFERENCES assets(name) ON DELETE CASCADE,
        visibility TEXT NOT NULL CHECK(visibility IN ('public', 'users')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS share_recipients (
        share_token TEXT NOT NULL REFERENCES file_shares(token) ON DELETE CASCADE,
        user_id TEXT NOT NULL, PRIMARY KEY(share_token, user_id)
      );
      CREATE INDEX IF NOT EXISTS shares_owner ON file_shares(owner_id);
      CREATE INDEX IF NOT EXISTS shares_asset ON file_shares(asset_name);
      CREATE INDEX IF NOT EXISTS recipients_user ON share_recipients(user_id);
    `);
  }

  permissions(owner, input) {
    if (!['public', 'users'].includes(input?.visibility)) fail('invalid_visibility');
    if (input.visibility === 'public') return { visibility: 'public', recipients: [] };
    if (!Array.isArray(input.recipients) || !input.recipients.length || input.recipients.length > 100) fail('recipients_required');
    const recipients = [...new Set(input.recipients)].map(username => {
      if (typeof username !== 'string') fail('invalid_recipient');
      const user = this.accounts.getUserByUsername(username);
      if (!user || user.status !== 'active' || user.id === owner) fail('invalid_recipient');
      return user.id;
    });
    return { visibility: 'users', recipients };
  }

  row(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('not_found', 404);
    const row = this.db.prepare(`SELECT s.*, a.original_name, a.size, a.time FROM file_shares s
      JOIN assets a ON a.name = s.asset_name WHERE s.token = ?`).get(token);
    if (!row || this.accounts.getUserById(row.owner_id)?.status !== 'active') fail('not_found', 404);
    return row;
  }

  access(token, viewer) {
    const row = this.row(token);
    if (row.visibility !== 'public' && viewer !== row.owner_id && !this.db.prepare('SELECT 1 FROM share_recipients WHERE share_token = ? AND user_id = ?').get(token, viewer || '')) {
      fail(viewer ? 'not_found' : 'unauthorized', viewer ? 404 : 401);
    }
    return row;
  }

  info(row, viewer) {
    const result = {
      token: row.token, originalName: row.original_name, size: row.size,
      visibility: row.visibility, createdAt: row.created_at,
      owner: this.accounts.getUserById(row.owner_id)?.username || '',
      isOwner: viewer === row.owner_id,
    };
    if (result.isOwner) {
      result.recipients = this.db.prepare('SELECT user_id FROM share_recipients WHERE share_token = ?').all(row.token)
        .map(recipient => this.accounts.getUserById(recipient.user_id)?.username).filter(Boolean);
    }
    return result;
  }

  list(viewer) {
    return this.db.prepare(`SELECT s.*, a.original_name, a.size FROM file_shares s JOIN assets a ON a.name = s.asset_name
      WHERE s.owner_id = ? OR s.visibility = 'public' OR EXISTS
        (SELECT 1 FROM share_recipients r WHERE r.share_token = s.token AND r.user_id = ?)
      ORDER BY s.created_at DESC, s.token`).all(viewer, viewer)
      .filter(row => this.accounts.getUserById(row.owner_id)?.status === 'active')
      .map(row => this.info(row, viewer));
  }

  availableFiles(owner) {
    return this.db.prepare(`SELECT a.* FROM assets a WHERE a.owner_id = ? AND
      (EXISTS(SELECT 1 FROM files f WHERE f.name = a.name) OR EXISTS(SELECT 1 FROM message_assets ma WHERE ma.asset_name = a.name))
      ORDER BY a.time DESC`).all(owner).map(row => this.workspace.fileInfo(row));
  }

  create(owner, input) {
    if (!this.workspace.downloadable(owner, input?.name)) fail('not_found', 404);
    const permissions = this.permissions(owner, input);
    const token = randomBytes(32).toString('hex');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO file_shares VALUES (?, ?, ?, ?, ?)').run(token, owner, input.name, permissions.visibility, Date.now());
      for (const id of permissions.recipients) this.db.prepare('INSERT INTO share_recipients VALUES (?, ?)').run(token, id);
    })();
    return this.info(this.row(token), owner);
  }

  update(owner, token, input) {
    if (this.row(token).owner_id !== owner) fail('not_found', 404);
    const permissions = this.permissions(owner, input);
    this.db.transaction(() => {
      this.db.prepare('UPDATE file_shares SET visibility = ? WHERE token = ? AND owner_id = ?').run(permissions.visibility, token, owner);
      this.db.prepare('DELETE FROM share_recipients WHERE share_token = ?').run(token);
      for (const id of permissions.recipients) this.db.prepare('INSERT INTO share_recipients VALUES (?, ?)').run(token, id);
    })();
    return this.info(this.row(token), owner);
  }

  revoke(owner, token) {
    if (this.row(token).owner_id !== owner) fail('not_found', 404);
    this.db.prepare('DELETE FROM file_shares WHERE token = ? AND owner_id = ?').run(token, owner);
  }
}
module.exports = { SharingStore };
