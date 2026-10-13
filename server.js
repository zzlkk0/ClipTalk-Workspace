const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const multer = require('multer');
const { QuotaStorage } = require('./quota-storage');
const { WorkspaceStore, TIMEZONE } = require('./workspace-store');
const { SharingStore } = require('./sharing-store');
const { randomUUID } = require('crypto');
const db = require('./db');

// ─── 配置 ───────────────────────────────────────
const DATA_DIR = path.resolve(process.env.CLIPTALK_DATA_DIR || __dirname);
const CONFIG_PATH = process.env.CLIPTALK_CONFIG || path.join(DATA_DIR, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = config.port || 8000;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const I18N_DIR = path.join(__dirname, 'i18n');
const MAX_FILE_SIZE = 500 * 1024 * 1024;

// ─── 数据库初始化 ───────────────────────────────
db.init(DATA_DIR);
const workspace = new WorkspaceStore(DATA_DIR, db.listUsers());
const sharing = new SharingStore(workspace, db);
const RELEASE = '20261013-adminroles';

// ── Express & HTTP ────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Helmet ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:  ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc:     ["'self'", "data:"],
      fontSrc:    ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  xFrameOptions: false,            // CSP frame-ancestors 替代
  xXssProtection: false,           // 现代浏览器不再需要
  strictTransportSecurity: false,  // HTTP 模式下不需要
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));

// Let Express choose the content type for HTML, JSON, scripts and downloads.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// API 响应统一加 Cache-Control
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// 静态资源缓存
app.use((req, res, next) => {
  if (req.path.match(/\.(js|css)$/)) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  } else if (req.path.match(/\.(png|svg|ico)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } else if (req.path.match(/\.html$/) || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// ─── 速率限制 ───────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs || 60000,
  max: config.rateLimitMax || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
});
const loginLimiter = rateLimit({
  windowMs: (config.loginWindowMinutes || 15) * 60 * 1000,
  max: config.maxLoginAttempts || 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

app.use(globalLimiter);
app.use(express.json({ limit: '1mb' }));

// ─── Session ────────────────────────────────────
const sessionStore = new session.MemoryStore();
const sessionMiddleware = session({
  store: sessionStore,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, httpOnly: true, sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

// ─── 语言加载 ───────────────────────────────────
function loadLang(lang) {
  try {
    const file = path.join(I18N_DIR, (lang === 'en' ? 'en' : 'zh-CN') + '.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'zh-CN.json'), 'utf8'));
  }
}

function getLang(req) {
  return (req.session && req.session.lang) || 'zh-CN';
}

// ─── 认证中间件 ─────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.getUserById(req.session.userId);
    if (user && user.status === 'active') {
      req.session.role = user.role;
      req.session.username = user.username;
      return next();
    }
  }
  if (req.path.startsWith('/api/') || req.path === '/upload' || req.path.startsWith('/uploads/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.status(403).send('Forbidden');
}

// ─── 页面路由 ───────────────────────────────────
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// ─── i18n API ───────────────────────────────────
app.get('/api/i18n/:lang', (req, res) => {
  const lang = req.params.lang === 'en' ? 'en' : 'zh-CN';
  res.json(loadLang(lang));
});

app.post('/api/lang', (req, res) => {
  const lang = req.body.lang === 'en' ? 'en' : 'zh-CN';
  if (req.session) req.session.lang = lang;
  res.json({ ok: true, lang });
});

// ─── 认证 API ───────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: !username ? 'empty_username' : 'empty_password' });
  }

  const user = db.verifyUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'wrong' });
  }
  if (user.status === 'disabled') {
    return res.status(403).json({ error: 'disabled' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'pending' });
  }

  db.updateLastLogin(user.id);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'server_error' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.lang = user.language || 'zh-CN';
    res.json({ ok: true, role: user.role, redirect: '/' });
  });
});

app.post('/api/logout', (req, res) => {
  io.in('session:' + req.sessionID).disconnectSockets(true);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

function accountInfo(user) {
  const deletionBlockedReason = user.builtin_admin ? 'protected_admin'
    : user.role === 'admin' && db.otherActiveAdmins(user.id) === 0 ? 'last_admin' : null;
  return { ...user, deletionBlockedReason };
}

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json(accountInfo(user));
});

app.patch('/api/preferences', requireAuth, (req, res) => {
  const { theme } = req.body;
  if (!['dark', 'light'].includes(theme)) return res.status(400).json({ error: 'invalid_theme' });
  db.setTheme(req.session.userId, theme);
  io.to(ownerRoom(req.session.userId)).emit('preferences-updated', { theme });
  res.json({ ok: true, theme });
});

async function invalidateSessions(owner, keep) {
  const sessions = await new Promise((resolve, reject) => sessionStore.all((error, rows) => error ? reject(error) : resolve(rows || {})));
  await Promise.all(Object.entries(sessions).filter(([id, value]) => id !== keep && value.userId === owner)
    .map(([id]) => new Promise((resolve, reject) => sessionStore.destroy(id, error => error ? reject(error) : resolve()))));
  const room = io.in(ownerRoom(owner));
  if (keep) room.except('session:' + keep).emit('account-invalidated');
  else room.emit('account-invalidated');
  if (keep) room.except('session:' + keep).disconnectSockets(true);
  else room.disconnectSockets(true);
}

app.patch('/api/account', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, username, newPassword } = req.body;
    const user = db.getUserById(req.session.userId);
    if (typeof currentPassword !== 'string' || !db.verifyUser(user.username, currentPassword)) return res.status(401).json({ error: 'wrong_password' });
    const name = username === undefined ? user.username : username;
    if (user.builtin_admin && name !== user.username) return res.status(409).json({ error: 'protected_admin_name' });
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(name)) return res.status(400).json({ error: 'username_format' });
    if (newPassword !== undefined && (typeof newPassword !== 'string' || newPassword.length < 6)) return res.status(400).json({ error: 'password_short' });
    if (newPassword && Buffer.byteLength(newPassword) > 72) return res.status(400).json({ error: 'password_long' });
    const existing = db.getUserByUsername(name);
    if (existing && existing.id !== user.id) return res.status(409).json({ error: 'username_taken' });
    db.updateAccount(user.id, name, newPassword);
    req.session.username = name;
    await invalidateSessions(user.id, req.sessionID);
    res.json({ ok: true, user: accountInfo(db.getUserById(user.id)) });
  } catch (error) { next(error); }
});

app.delete('/api/account', requireAuth, async (req, res, next) => {
  try {
    const user = db.getUserById(req.session.userId);
    if (req.body.confirm !== true || req.body.username !== user.username) return res.status(400).json({ error: 'confirmation_required' });
    if (typeof req.body.currentPassword !== 'string' || !db.verifyUser(user.username, req.body.currentPassword)) return res.status(401).json({ error: 'wrong_password' });
    workspace.deleteAccount(user.id);
    await invalidateSessions(user.id);
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); });
  } catch (error) { next(error); }
});

// ─── 注册 API ───────────────────────────────────
app.post('/api/register', (req, res) => {
  const regEnabled = db.getSetting('registration_enabled');
  if (regEnabled !== 'true') {
    return res.status(403).json({ error: 'registration_closed' });
  }

  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'empty_username' });
  if (!password) return res.status(400).json({ error: 'empty_password' });
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return res.status(400).json({ error: 'username_format' });
  if (password.length < 6) return res.status(400).json({ error: 'password_short' });

  const existing = db.getUserByUsername(username);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const user = db.createUser(username, password);
  const approvalMode = db.getSetting('approval_mode');
  res.json({
    ok: true,
    status: user.status,
    autoApproved: approvalMode === 'auto'
  });
});

// ─── 管理员 API ─────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(db.listUsers());
});

app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  res.json(db.getStats());
});

app.post('/api/admin/administrators', requireAuth, requireAdmin, (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return res.status(400).json({ error: 'username_format' });
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'password_short' });
  if (Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'password_long' });
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'username_taken' });
  res.status(201).json({ ok: true, user: db.createAdministrator(username, password) });
});

app.post('/api/admin/users/:id/promote', requireAuth, requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (user.status !== 'active') return res.status(400).json({ error: 'inactive_user' });
  db.promoteUser(user.id);
  io.to(ownerRoom(user.id)).emit('account-role-updated', { role: 'admin' });
  res.json({ ok: true, user: db.getUserById(user.id) });
});

app.post('/api/admin/users/:id/demote', requireAuth, requireAdmin, (req, res, next) => {
  try {
    const user = db.demoteAdministrator(req.params.id, req.session.userId);
    io.to(ownerRoom(user.id)).emit('account-role-updated', { role: 'user' });
    res.json({ ok: true, user });
  } catch (error) { next(error); }
});

app.post('/api/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const r = db.approveUser(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const r = db.rejectUser(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/status', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const r = db.setUserStatus(req.params.id, status);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user || user.role === 'admin') return res.status(404).json({ error: 'not_found' });
  workspace.deleteAccount(user.id);
  invalidateSessions(user.id).then(() => res.json({ ok: true })).catch(error => res.status(500).json({ error: 'server_error' }));
});

// 修改管理员密码
app.post('/api/admin/change-password', requireAuth, requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'empty_fields' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'password_short' });
  }
  const user = db.getUserById(req.session.userId);
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(currentPassword, db.getUserByUsername(user.username)?.password_hash || '')) {
    return res.status(401).json({ error: 'wrong_password' });
  }
  db.changePassword(req.session.userId, newPassword);
  res.json({ ok: true });
});

// 系统设置
app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({
    approval_mode: db.getSetting('approval_mode'),
    registration_enabled: db.getSetting('registration_enabled'),
    site_name: db.getSetting('site_name'),
  });
});

app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const { approval_mode, registration_enabled, site_name } = req.body;
  if (site_name !== undefined) {
    if (typeof site_name !== 'string' || site_name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(site_name)) return res.status(400).json({ error: 'invalid_site_name' });
    db.setSetting('site_name', site_name.trim());
    io.emit('site-updated', { siteName: site_name.trim() });
  }
  if (approval_mode && ['auto', 'manual'].includes(approval_mode)) {
    db.setSetting('approval_mode', approval_mode);
  }
  if (registration_enabled !== undefined) {
    db.setSetting('registration_enabled', registration_enabled ? 'true' : 'false');
  }
  res.json({ ok: true });
});

app.get('/api/site', (req, res) => res.json({ siteName: db.getSetting('site_name') || '' }));

// Every workspace API derives the owner from the authenticated session.
app.get('/api/health', (req, res) => res.json({ ok: true, release: RELEASE }));
app.get('/api/storage', requireAuth, (req, res) => res.json(workspace.storage(req.session.userId)));
app.get('/api/admin/storage', requireAuth, requireAdmin, (req, res) => {
  res.json(db.listUsers().map(user => ({ id: user.id, username: user.username, ...workspace.storage(user.id) })));
});
app.patch('/api/admin/users/:id/quota', requireAuth, requireAdmin, (req, res) => {
  if (!db.getUserById(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const storage = workspace.setQuota(req.params.id, req.body.quotaBytes);
  emitStorage(req.params.id);
  res.json({ ok: true, ...storage });
});
app.get('/api/workspace', requireAuth, (req, res) => {
  res.json({ ...workspace.snapshot(req.session.userId), timezone: TIMEZONE });
});

function ownerRoom(owner) { return 'user:' + owner; }
function emitStorage(owner) { io.to(ownerRoom(owner)).emit('storage-updated', workspace.storage(owner)); }
function emitSnapshot(owner) {
  io.to(ownerRoom(owner)).emit('workspace-updated', workspace.snapshot(owner));
  emitStorage(owner);
}
function emitArchives(owner) { io.to(ownerRoom(owner)).emit('archives-updated'); }

app.post('/api/workspace/clear', requireAuth, (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: 'confirmation_required' });
  workspace.clear(req.session.userId, req.body.scope);
  emitSnapshot(req.session.userId);
  res.json({ ok: true });
});
app.get('/api/archives', requireAuth, (req, res) => res.json(workspace.listArchives(req.session.userId)));
app.post('/api/archives', requireAuth, (req, res) => {
  const archive = workspace.archive(req.session.userId, req.body);
  emitSnapshot(req.session.userId);
  emitArchives(req.session.userId);
  res.status(201).json(archive);
});
app.get('/api/archives/:id', requireAuth, (req, res) => res.json(workspace.getArchive(req.session.userId, req.params.id)));
app.patch('/api/archives/:id', requireAuth, (req, res) => {
  workspace.renameArchive(req.session.userId, req.params.id, req.body.title);
  emitArchives(req.session.userId);
  res.json({ ok: true });
});
app.delete('/api/archives/:id', requireAuth, (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: 'confirmation_required' });
  workspace.deleteArchive(req.session.userId, req.params.id);
  emitSnapshot(req.session.userId);
  emitArchives(req.session.userId);
  res.json({ ok: true });
});
app.post('/api/archives/:id/restore', requireAuth, (req, res) => {
  workspace.restoreArchive(req.session.userId, req.params.id);
  emitSnapshot(req.session.userId);
  emitArchives(req.session.userId);
  res.json({ ok: true });
});

// Static access to uploads would expose other accounts' data. Always check ownership.
app.get('/uploads/:name', requireAuth, (req, res, next) => {
  const name = req.params.name;
  if (path.basename(name) !== name) return res.status(404).json({ error: 'not_found' });
  const asset = workspace.downloadable(req.session.userId, name);
  if (!asset) return res.status(404).json({ error: 'not_found' });
  res.download(path.join(UPLOADS_DIR, asset.name), asset.original_name, error => {
    if (error && !res.headersSent) next(Object.assign(new Error('not_found'), { status: 404 }));
  });
});

const storage = new QuotaStorage(workspace);
workspace.pendingBytes = owner => storage.pending.get(owner) || 0;
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: 10 } });
app.post('/upload', requireAuth, (req, res, next) => {
  req.once('aborted', () => storage.release(req));
  upload.array('files', 10)(req, res, error => {
    storage.release(req);
    if (error) return next(error);
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'no_files' });
    const uploaded = req.files.map(file => ({
      name: file.filename,
      originalName: path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f]/g, '') || 'file',
      size: file.size, time: Date.now(),
    }));
    try {
      // Recheck authorization after a potentially long upload.
      const user = db.getUserById(req.session.userId);
      if (!user || user.status !== 'active') throw Object.assign(new Error('unauthorized'), { status: 401 });
      const message = workspace.addUpload(user.id, user.username, uploaded);
      io.to(ownerRoom(user.id)).emit('files-updated', workspace.files(user.id));
      io.to(ownerRoom(user.id)).emit('chat-message', message);
      emitStorage(user.id);
      res.json({ ok: true, files: uploaded });
    } catch (failure) {
      for (const file of req.files) fs.rmSync(file.path, { force: true });
      next(failure);
    }
  });
});
app.get('/api/files', requireAuth, (req, res) => res.json(workspace.files(req.session.userId)));
app.delete('/api/files/:name', requireAuth, (req, res) => {
  workspace.deleteFile(req.session.userId, req.params.name);
  emitSnapshot(req.session.userId);
  res.json({ ok: true });
});

// Sharing is an explicit permission grant. The original /uploads endpoint
// remains owner-only, even for recipients of a shared file.
app.get('/api/share-users', requireAuth, (req, res) => res.json(db.listUsers()
  .filter(user => user.status === 'active' && user.id !== req.session.userId).map(user => ({ username: user.username }))));
app.get('/api/share-files', requireAuth, (req, res) => res.json(sharing.availableFiles(req.session.userId)));
app.get('/api/shares', requireAuth, (req, res) => res.json(sharing.list(req.session.userId)));
app.post('/api/shares', requireAuth, (req, res) => res.status(201).json(sharing.create(req.session.userId, req.body)));
app.patch('/api/shares/:token', requireAuth, (req, res) => res.json(sharing.update(req.session.userId, req.params.token, req.body)));
app.delete('/api/shares/:token', requireAuth, (req, res) => {
  sharing.revoke(req.session.userId, req.params.token);
  emitStorage(req.session.userId);
  res.json({ ok: true });
});
function shareViewer(req) {
  const user = req.session?.userId && db.getUserById(req.session.userId);
  return user?.status === 'active' ? user.id : null;
}
app.get('/api/shares/:token', (req, res) => res.json(sharing.info(sharing.access(req.params.token, shareViewer(req)), shareViewer(req))));
app.get('/api/shares/:token/download', (req, res, next) => {
  const share = sharing.access(req.params.token, shareViewer(req));
  res.download(path.join(UPLOADS_DIR, share.asset_name), share.original_name, error => {
    if (error && !res.headersSent) next(Object.assign(new Error('not_found'), { status: 404 }));
  });
});
app.post('/api/shares/:token/import', requireAuth, async (req, res, next) => {
  let destination;
  try {
    const owner = req.session.userId;
    const share = sharing.access(req.params.token, owner);
    if (share.owner_id === owner) return res.status(400).json({ error: 'already_owned' });
    storage.reserve(req, share.size + Buffer.byteLength('📎 ' + share.original_name));
    const name = Date.now() + '_' + randomUUID();
    destination = path.join(UPLOADS_DIR, name);
    await fs.promises.copyFile(path.join(UPLOADS_DIR, share.asset_name), destination, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(destination, 0o600);
    const user = db.getUserById(owner);
    if (req.aborted || !user || user.status !== 'active') throw Object.assign(new Error('unauthorized'), { status: 401 });
    sharing.access(req.params.token, owner); // A revoked share cannot finish an in-flight import.
    storage.release(req);
    workspace.addUpload(owner, user.username, [{ name, originalName: share.original_name, size: share.size, time: Date.now() }]);
    destination = null;
    emitSnapshot(owner);
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
  finally {
    storage.release(req);
    if (destination) await fs.promises.rm(destination, { force: true }).catch(() => {});
  }
});

app.get('/sharing.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'sharing.html')));
app.get('/share/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'share.html')));

app.use(express.static(path.join(__dirname, 'public')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error instanceof multer.MulterError ? 400 : 500);
  const code = status === 500 ? 'server_error' : error.message;
  if (status === 500) console.error('Request failed:', error.code || error.message);
  res.status(status).json({ error: code });
});

const io = new Server(server, {
  cors: { origin: false }, maxHttpBufferSize: 1e6, connectTimeout: 10000,
});
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const user = db.getUserById(socket.request.session?.userId || '');
  if (user && user.status === 'active') return next();
  next(new Error('unauthorized'));
});
io.on('connection', socket => {
  const owner = socket.request.session.userId;
  socket.join(ownerRoom(owner));
  socket.join('session:' + socket.request.sessionID);
  socket.emit('init', workspace.snapshot(owner));
  emitStorage(owner);
  const user = db.getUserById(owner);
  socket.emit('user-info', { username: user.username, role: user.role, lang: socket.request.session.lang || 'zh-CN' });

  // A logged-out or disabled account cannot keep using an existing socket.
  socket.use((packet, next) => {
    socket.request.session.reload(error => {
      const user = !error && db.getUserById(owner);
      if (error || socket.request.session.userId !== owner || !user || user.status !== 'active') {
        socket.disconnect(true);
        return next(new Error('unauthorized'));
      }
      next();
    });
  });
  socket.on('clipboard-update', text => {
    if (typeof text !== 'string' || text.length > 500000) return;
    try {
      workspace.setClipboard(owner, text);
      socket.to(ownerRoom(owner)).emit('clipboard-update', text);
      emitStorage(owner);
    } catch (error) {
      socket.emit('clipboard-update', workspace.snapshot(owner).clipboardText);
      socket.emit('workspace-error', { error: error.status ? error.message : 'server_error' });
    }
  });
  socket.on('chat-message', (message, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!message || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 10000) return reply({ ok: false, error: 'invalid_message' });
    try {
      const saved = workspace.addMessage(owner, { type: 'user', text: message.text, time: Date.now(), from: db.getUserById(owner).username });
      io.to(ownerRoom(owner)).emit('chat-message', saved);
      emitStorage(owner); reply({ ok: true });
    } catch (error) {
      const code = error.status ? error.message : 'server_error';
      reply({ ok: false, error: code });
      if (typeof acknowledge !== 'function') socket.emit('workspace-error', { error: code });
    }
  });
  socket.on('refresh-files', () => socket.emit('files-updated', workspace.files(owner)));
});

server.listen(PORT, process.env.CLIPTALK_HOST || '0.0.0.0', () => {
  console.log('ClipTalk ' + RELEASE + ' listening on port ' + PORT + ' (per-account workspaces)');
});
process.on('SIGTERM', () => {
  io.close(() => { workspace.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 4000).unref();
});
