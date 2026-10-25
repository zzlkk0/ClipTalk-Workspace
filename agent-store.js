'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const SCOPES = ['clipboard:read', 'clipboard:write', 'files:read', 'files:upload', 'files:manage', 'files:delete'];
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };

class AgentStore {
  constructor(database, accounts) {
    this.db = database; this.accounts = accounts;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_keys (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
        scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, last_used_at INTEGER,
        window_start INTEGER NOT NULL DEFAULT 0, window_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS agent_keys_owner ON agent_keys(owner_id);
      CREATE TABLE IF NOT EXISTS agent_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_id TEXT NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
        time INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
        status INTEGER NOT NULL, duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_audit_owner ON agent_audit(owner_id, id);
    `);
  }
  publicKey(row) {
    const { token_hash, window_start, window_count, scopes, ...safe } = row;
    return { ...safe, scopes: JSON.parse(scopes) };
  }
  list(owner) { return this.db.prepare('SELECT * FROM agent_keys WHERE owner_id = ? ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC LIMIT 100').all(owner, Date.now()).map(row => this.publicKey(row)); }
  create(owner, input) {
    const { label, scopes, expiresInDays = 30 } = input;
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\x00-\x1f\x7f]/.test(label)) fail('invalid_key_label');
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > SCOPES.length || scopes.some(scope => !SCOPES.includes(scope))) fail('invalid_key_scopes');
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) fail('invalid_key_expiry');
    return this.db.transaction(() => {
      const now = Date.now();
      if (this.db.prepare('SELECT COUNT(*) n FROM agent_keys WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?').get(owner, now).n >= 20) fail('agent_key_limit');
      const token = 'ct_' + randomBytes(32).toString('base64url'), id = randomUUID();
      this.db.prepare(`INSERT INTO agent_keys(id,owner_id,label,token_hash,prefix,scopes,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, owner, label.trim(), createHash('sha256').update(token).digest('hex'), token.slice(0, 11), JSON.stringify([...new Set(scopes)]), now, now + expiresInDays * 86400000);
      return { ...this.publicKey(this.db.prepare('SELECT * FROM agent_keys WHERE id = ?').get(id)), token };
    })();
  }
  revoke(owner, id) {
    const row = this.db.prepare('SELECT id FROM agent_keys WHERE owner_id = ? AND id = ?').get(owner, id);
    if (!row) fail('not_found', 404);
    this.db.prepare('UPDATE agent_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(Date.now(), id);
  }
  authorizeId(id, scope) {
    const row = this.db.prepare('SELECT * FROM agent_keys WHERE id = ?').get(id);
    if (!row || row.revoked_at || row.expires_at <= Date.now()) fail('invalid_agent_key', 401);
    const user = this.accounts.getUserById(row.owner_id);
    if (!user || user.status !== 'active') fail('invalid_agent_key', 401);
    const key = this.publicKey(row);
    if (scope && !key.scopes.includes(scope)) fail('insufficient_scope', 403);
    return key;
  }
  authenticate(header) {
    if (typeof header !== 'string' || !/^Bearer ct_[A-Za-z0-9_-]{43}$/.test(header)) fail('invalid_agent_key', 401);
    const hash = createHash('sha256').update(header.slice(7)).digest('hex');
    const row = this.db.prepare('SELECT id FROM agent_keys WHERE token_hash = ?').get(hash);
    return this.authorizeId(row?.id || '');
  }
  consume(id, limit = 60) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT window_start, window_count FROM agent_keys WHERE id = ?').get(id), now = Date.now();
      const start = now - row.window_start >= 60000 ? now : row.window_start;
      const count = start === row.window_start ? row.window_count : 0;
      if (count >= limit) throw Object.assign(new Error('too_many_requests'), { status: 429, retryAfter: Math.max(1, Math.ceil((start + 60000 - now) / 1000)) });
      this.db.prepare('UPDATE agent_keys SET window_start = ?, window_count = ?, last_used_at = ? WHERE id = ?').run(start, count + 1, now, id);
    })();
  }
  audit(key, action, target, status, duration) {
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM agent_keys WHERE id = ?').get(key.id)) return;
      this.db.prepare('INSERT INTO agent_audit(owner_id,key_id,time,action,target,status,duration_ms) VALUES(?,?,?,?,?,?,?)')
        .run(key.owner_id, key.id, Date.now(), action.slice(0, 200), String(target || '').slice(0, 500), status, duration);
      this.db.prepare('DELETE FROM agent_audit WHERE owner_id = ? AND id NOT IN (SELECT id FROM agent_audit WHERE owner_id = ? ORDER BY id DESC LIMIT 1000)').run(key.owner_id, key.owner_id);
    })();
  }
  history(owner, before) {
    const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('invalid_cursor');
    const rows = this.db.prepare(`SELECT a.id,a.time,a.action,a.target,a.status,a.duration_ms,k.label FROM agent_audit a
      JOIN agent_keys k ON k.id = a.key_id WHERE a.owner_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT 50`).all(owner, cursor);
    return { entries: rows, nextCursor: rows.length === 50 ? rows[49].id : null };
  }
}
module.exports = { AgentStore, SCOPES };
