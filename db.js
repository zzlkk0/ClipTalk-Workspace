const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');

let db;

function init(dataDir = __dirname) {
  fs.mkdirSync(path.join(dataDir, 'database'), { recursive: true });
  db = new Database(path.join(dataDir, 'database', 'users.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      language TEXT DEFAULT 'zh-CN',
      created_at INTEGER NOT NULL,
      last_login INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 默认设置
  const defaults = {
    approval_mode: 'manual',
    registration_enabled: 'true',
    site_name: '',
  };
  for (const [key, value] of Object.entries(defaults)) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }

  // 检查是否有管理员，没有则创建初始管理员
  const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin');
  if (adminCount.c === 0) {
    const password = crypto.randomBytes(18).toString('base64url');
    const hash = bcrypt.hashSync(password, 12);
    const id = 'admin-' + crypto.randomBytes(8).toString('hex');
    db.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at)
      VALUES (?, ?, ?, 'admin', 'active', ?)`).run(id, 'admin', hash, Date.now());
    console.log('══════════════════════════════════════════');
    console.log('  初始管理员账号已创建');
    console.log('  用户名: admin');
    console.log('  密码:   ' + password);
    console.log('  请登录后立即修改密码！');
    console.log('══════════════════════════════════════════');
  }

  return db;
}

// ─── 用户操作 ───────────────────────────────────

function createUser(username, password) {
  const hash = bcrypt.hashSync(password, 12);
  const id = 'u-' + crypto.randomBytes(12).toString('hex');
  const approvalMode = db.prepare('SELECT value FROM settings WHERE key = ?').get('approval_mode');
  const status = approvalMode.value === 'auto' ? 'active' : 'pending';
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at)
    VALUES (?, ?, ?, 'user', ?, ?)`).run(id, username, hash, status, now);
  return { id, username, status };
}

function verifyUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return user;
}

function getUserById(id) {
  return db.prepare('SELECT id, username, role, status, language, created_at, last_login FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function updateLastLogin(id) {
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), id);
}

function listUsers() {
  return db.prepare('SELECT id, username, role, status, language, created_at, last_login FROM users ORDER BY created_at DESC').all();
}

function getPendingUsers() {
  return db.prepare('SELECT id, username, created_at FROM users WHERE status = ? ORDER BY created_at ASC').all('pending');
}

function approveUser(id) {
  return db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending'").run(id);
}

function rejectUser(id) {
  return db.prepare("DELETE FROM users WHERE id = ? AND status = 'pending'").run(id);
}

function setUserStatus(id, status) {
  if (!['active', 'disabled'].includes(status)) return { changes: 0 };
  return db.prepare('UPDATE users SET status = ? WHERE id = ? AND role != ?').run(status, id, 'admin');
}

function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(id, 'admin');
}

function changePassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 12);
  return db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
}

function updateAccount(id, username, password) {
  return db.transaction(() => {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    if (password) changePassword(id, password);
  })();
}

// ─── 设置 ───────────────────────────────────────

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get();
  const active = db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").get();
  const pending = db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'pending'").get();
  return { total: total.c, active: active.c, pending: pending.c };
}

module.exports = {
  init,
  createUser,
  verifyUser,
  getUserById,
  getUserByUsername,
  updateLastLogin,
  listUsers,
  getPendingUsers,
  approveUser,
  rejectUser,
  setUserStatus,
  deleteUser,
  changePassword,
  updateAccount,
  getSetting,
  setSetting,
  getStats,
};
