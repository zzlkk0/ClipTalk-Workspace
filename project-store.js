'use strict';
// Project collaboration: modular, shared state for any number of agents
// (named by themselves, e.g. PC1, server3) and the signed-in owner (USER).
// Each project owns a drive folder for files. Agents may change almost
// everything; the project's RULES.md tells them what not to do. Only the
// owner answers decisions, edits RULES.md, creates and deletes projects.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createHash, randomUUID } = require('crypto');

const LIMITS = {
  projects: 20, message: 8000, status: 16 * 1024, handoff: 64 * 1024, summary: 4000, text: 1024 * 1024, textWrite: 900 * 1024,
  graph: 512 * 1024, graphNodes: 2000, recordBatch: 500, events: 200, eventsKept: 20000, wait: 25, members: 50,
};
const MODULES = ['tasks', 'messages', 'decisions', 'handoffs', 'viewer', 'files'];
const DEFAULT_MODULES = { tasks: false, messages: true, decisions: true, handoffs: false, viewer: false, files: true };
const MESSAGE_TYPES = ['info', 'question', 'answer', 'blocker', 'handoff_notice'];
const TASK_STATUS = ['proposed', 'todo', 'in_progress', 'blocked', 'review', 'done', 'dropped', 'rejected'];
const REF_KINDS = ['handoff', 'record', 'graph', 'decision', 'message', 'task', 'file', 'view'];
const ROOT_FOLDER = '项目协同';
const SUBFOLDERS = ['agents', 'memory', 'docs', 'deliverables'];
const PROTECTED_FILES = ['RULES.md'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const NODE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const KIND = /^[A-Za-z0-9_.:-]{1,40}$/;
const PREFIX = { message: 'msg', handoff: 'ho', decision: 'dec', record: 'res' };
const TEMPLATES = path.join(__dirname, 'project-templates');

function fail(code, status = 400, detail) { throw Object.assign(new Error(code), { status, ...(detail === undefined ? {} : { detail }) }); }
const iso = ms => ms === null || ms === undefined ? null : new Date(ms).toISOString();
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pubId = (kind, n) => PREFIX[kind] + '-' + n;
const reserved = name => ['USER', 'ALL'].includes(String(name).toUpperCase());
function parseId(kind, value, code = 'not_found', status = 404) {
  const match = new RegExp('^(?:' + PREFIX[kind] + '-)?(\\d{1,15})$').exec(String(value ?? ''));
  if (!match) fail(code, status);
  return Number(match[1]);
}
function cursor(value) {
  if (value === undefined || value === '') return 0;
  const match = /^(?:[a-z]+-)?(\d{1,15})$/.exec(String(value));
  if (!match) fail('invalid_cursor');
  return Number(match[1]);
}
function text(value, max, code, { optional = false, allowEmpty = false } = {}) {
  if (value === undefined || value === null) { if (optional) return null; fail(code); }
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(code);
  return value;
}
function line(value, max, code, options) {
  const result = text(value, max, code, options);
  if (result !== null && /[\x00-\x1f\x7f]/.test(result)) fail(code);
  return result === null ? null : result.trim();
}
function recipient(value) {
  if (typeof value !== 'string' || !(AGENT.test(value))) fail('invalid_recipient');
  return reserved(value) ? value.toUpperCase() : value;
}
function primitives(value, code, maxKeys = 50) {
  if (value === undefined || value === null) return {};
  if (!isObject(value) || Object.keys(value).length > maxKeys) fail(code);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) fail(code);
    if (!['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)) || (typeof item === 'string' && item.length > 500)) fail(code);
  }
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('version_required');
  return value;
}

class ProjectStore {
  constructor(workspace, { drive, guard, onEvent, settings } = {}) {
    this.workspace = workspace; this.db = workspace.db; this.drive = drive; this.guard = guard; this.onEvent = onEvent || (() => {});
    this.settings = settings || (() => null);
    this.bus = new EventEmitter(); this.bus.setMaxListeners(0);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
        switches TEXT NOT NULL DEFAULT '{}', switches_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, UNIQUE(owner_id, slug)
      );
      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', added_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER,
        PRIMARY KEY (project_id, name)
      );
      CREATE TABLE IF NOT EXISTS project_status (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        actor TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
        PRIMARY KEY (project_id, actor)
      );
      CREATE TABLE IF NOT EXISTS project_tasks (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        task_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, owners TEXT NOT NULL DEFAULT '[]',
        owner_label TEXT NOT NULL DEFAULT '', depends TEXT NOT NULL DEFAULT '', done_when TEXT NOT NULL DEFAULT '',
        deliver_to TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', notes TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS project_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, thread TEXT NOT NULL, task_id TEXT,
        type TEXT NOT NULL, body TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
        body TEXT NOT NULL, supersedes INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, raised_by TEXT NOT NULL, task_id TEXT, question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
        recommendation TEXT NOT NULL DEFAULT '', blocking INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
        answer TEXT, answered_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_topologies (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        circuit TEXT NOT NULL, version INTEGER NOT NULL, candidate TEXT, level TEXT NOT NULL, body TEXT NOT NULL,
        node_count INTEGER NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
        PRIMARY KEY (project_id, circuit, version)
      );
      CREATE TABLE IF NOT EXISTS project_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, circuit TEXT NOT NULL, task_id TEXT, candidate TEXT, case_id TEXT, node TEXT,
        metric TEXT NOT NULL, value REAL, unit TEXT, status TEXT NOT NULL, body TEXT NOT NULL, supersedes INTEGER,
        created_at INTEGER NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, type TEXT NOT NULL, object_id TEXT NOT NULL, actor TEXT NOT NULL,
        time INTEGER NOT NULL, summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_idempotency (
        key_id TEXT NOT NULL, idem_key TEXT NOT NULL, owner_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        status INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (key_id, idem_key)
      );
      CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
      CREATE INDEX IF NOT EXISTS project_messages_project ON project_messages(project_id, id);
      CREATE INDEX IF NOT EXISTS project_handoffs_project ON project_handoffs(project_id, task_id, id);
      CREATE INDEX IF NOT EXISTS project_decisions_project ON project_decisions(project_id, status, id);
      CREATE INDEX IF NOT EXISTS project_results_project ON project_results(project_id, circuit, id);
      CREATE INDEX IF NOT EXISTS project_results_task ON project_results(project_id, task_id, id);
      CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id, id);
      CREATE INDEX IF NOT EXISTS project_idempotency_time ON project_idempotency(created_at);
    `);
    // Columns added after the first release; older databases are upgraded in place.
    const add = (table, column, definition) => {
      if (!this.db.pragma('table_info(' + table + ')').some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    add('projects', 'modules', "TEXT NOT NULL DEFAULT '" + JSON.stringify(DEFAULT_MODULES) + "'");
    add('projects', 'modules_version', 'INTEGER NOT NULL DEFAULT 1');
    add('projects', 'summary', "TEXT NOT NULL DEFAULT ''");
    add('projects', 'summary_version', 'INTEGER NOT NULL DEFAULT 0');
    add('projects', 'summary_updated_at', 'INTEGER');
    add('projects', 'summary_updated_by', 'TEXT');
    add('projects', 'folder_id', 'TEXT');
    add('projects', 'viewer_title', "TEXT NOT NULL DEFAULT ''");
    add('project_messages', 'edited_at', 'INTEGER');
    add('project_handoffs', 'edited_at', 'INTEGER');
    add('project_decisions', 'kind', "TEXT NOT NULL DEFAULT 'question'");
    add('project_decisions', 'ref', 'TEXT');
    add('project_decisions', 'edited_at', 'INTEGER');
    // Proxy answers: an agent may answer on the owner's behalf; the owner confirms or overrides.
    add('project_decisions', 'answered_by', 'TEXT');
    add('project_decisions', 'confirmed_at', 'INTEGER');
    workspace.extraTextBytes = owner => this.textBytes(owner);
    (workspace.accountCleanup ||= []).push(owner => this.deleteOwner(owner));
  }

  // ─── Helpers ──────────────────────────────────
  textBytes(owner) {
    const sum = (table, columns) => this.db.prepare(`SELECT COALESCE(SUM(${columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ')}), 0) AS n FROM ${table} WHERE owner_id = ?`).get(owner).n;
    let total = sum('projects', ['name', 'switches', 'summary']) + sum('project_status', ['body']) + sum('project_tasks', ['title', 'owner_label', 'depends', 'done_when', 'deliver_to', 'notes'])
      + sum('project_messages', ['body', 'refs']) + sum('project_handoffs', ['body']) + sum('project_decisions', ['question', 'options', 'recommendation', 'answer'])
      + sum('project_topologies', ['body']) + sum('project_results', ['body']) + sum('project_members', ['role']);
    for (const table of ['project_texts', 'project_text_history']) {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) total += sum(table, ['content']);
    }
    return total;
  }
  folderBytes(owner, folderId) {
    if (!folderId || !this.db.prepare('SELECT 1 FROM drive_folders WHERE owner_id = ? AND id = ?').get(owner, folderId)) return 0;
    return this.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM drive_folders WHERE owner_id = @owner AND id = @folder
      UNION ALL SELECT f.id FROM drive_folders f JOIN tree t ON f.parent_id = t.id WHERE f.owner_id = @owner)
      SELECT COALESCE(SUM(a.size), 0) n FROM drive_files d JOIN assets a ON a.name = d.name WHERE d.owner_id = @owner AND d.folder_id IN (SELECT id FROM tree)`).get({ owner, folder: folderId }).n;
  }
  // Project collaboration has its own ceiling (all projects of an account: text plus project folders).
  projectUsage(owner) {
    const folders = this.db.prepare('SELECT folder_id FROM projects WHERE owner_id = ?').all(owner).map(row => row.folder_id);
    const used = this.textBytes(owner) + folders.reduce((sum, folder) => sum + this.folderBytes(owner, folder), 0);
    const limitMb = Number(this.settings('project_quota_mb')) || 200;
    return { usedBytes: used, limitBytes: limitMb * 1024 * 1024 };
  }
  quota(owner, additional) {
    if (additional <= 0) return;
    const usage = this.projectUsage(owner);
    if (usage.usedBytes + additional > usage.limitBytes) fail('project_quota_exceeded', 413, { usedBytes: usage.usedBytes, limitBytes: usage.limitBytes });
    this.workspace.enforceQuota(owner, additional);
  }
  scan(value) { if (this.guard) this.guard.check(value); }
  project(owner, slug) {
    const row = typeof slug === 'string' && SLUG.test(slug) && this.db.prepare('SELECT * FROM projects WHERE owner_id = ? AND slug = ?').get(owner, slug);
    if (!row) fail('project_not_found', 404);
    return row;
  }
  modulesOf(project) { return { ...DEFAULT_MODULES, ...JSON.parse(project.modules || '{}') }; }
  requireModule(project, module) { if (!this.modulesOf(project)[module]) fail('module_disabled', 409, { module }); }
  // Agents name themselves per request (X-Agent-Name) or use the key's default name.
  actorOf(who) {
    if (who.kind === 'user') return 'USER';
    if (!who.actor) fail('agent_name_required', 403);
    if (!AGENT.test(who.actor) || reserved(who.actor)) fail('invalid_agent_name');
    return who.actor;
  }
  requireUser(who) { if (who.kind !== 'user') fail('owner_only', 403); }
  touchMember(project, who) {
    if (who.kind === 'user') return;
    const name = this.actorOf(who), now = Date.now();
    const row = this.db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND name = ?').get(project.id, name);
    if (row) this.db.prepare('UPDATE project_members SET last_seen = ? WHERE project_id = ? AND name = ?').run(now, project.id, name);
    else {
      if (this.db.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id = ?').get(project.id).n >= LIMITS.members) fail('member_limit');
      this.db.prepare('INSERT INTO project_members(project_id,owner_id,name,added_by,created_at,last_seen) VALUES(?,?,?,?,?,?)').run(project.id, project.owner_id, name, name, now, now);
    }
  }
  event(project, who, type, objectId, summary) {
    const info = this.db.prepare('INSERT INTO project_events(project_id,owner_id,type,object_id,actor,time,summary) VALUES(?,?,?,?,?,?,?)')
      .run(project.id, project.owner_id, type, String(objectId), who.kind === 'user' ? 'USER' : who.actor || '?', Date.now(), String(summary).slice(0, 300));
    const id = Number(info.lastInsertRowid);
    if (id % 500 === 0) this.db.prepare('DELETE FROM project_events WHERE project_id = ? AND id <= ?').run(project.id, id - LIMITS.eventsKept);
    const payload = { project: project.slug, type, id: String(objectId), event: id };
    setImmediate(() => { this.bus.emit(project.owner_id + ':' + project.id, payload); this.onEvent(project.owner_id, payload); });
    return id;
  }
  // Every write: resolve the project, register the agent as a member, run the change.
  write(who, slug, work, module) {
    return this.db.transaction(() => {
      const project = this.project(who.owner, slug);
      if (module) this.requireModule(project, module);
      const actor = this.actorOf(who); this.touchMember(project, who);
      return work(project, actor);
    })();
  }

  // ─── Projects, modules, summary, switches ─────
  list(owner) {
    return this.db.prepare('SELECT slug, name, created_at FROM projects WHERE owner_id = ? ORDER BY created_at').all(owner)
      .map(row => ({ id: row.slug, name: row.name, created_at: iso(row.created_at) }));
  }
  create(who, input) {
    this.requireUser(who);
    if (!isObject(input) || typeof input.id !== 'string' || !SLUG.test(input.id)) fail('invalid_project_id');
    const name = line(input.name ?? input.id, 120, 'invalid_project_name');
    const modules = { ...DEFAULT_MODULES };
    if (isObject(input.modules)) for (const key of MODULES) if (typeof input.modules[key] === 'boolean') modules[key] = input.modules[key];
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) n FROM projects WHERE owner_id = ?').get(who.owner).n >= LIMITS.projects) fail('project_limit');
      if (this.db.prepare('SELECT 1 FROM projects WHERE owner_id = ? AND slug = ?').get(who.owner, input.id)) fail('project_exists', 409);
      const info = this.db.prepare('INSERT INTO projects(owner_id,slug,name,created_at,modules) VALUES(?,?,?,?,?)').run(who.owner, input.id, name, Date.now(), JSON.stringify(modules));
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
      this.ensureFolder(project);
      this.event(project, who, 'project', project.slug, 'project created');
      return { id: project.slug, name: project.name, created_at: iso(project.created_at), folder_id: project.folder_id };
    })();
  }
  remove(who, slug, deleteFiles) {
    this.requireUser(who);
    const project = this.project(who.owner, slug);
    const folder = project.folder_id && this.db.prepare('SELECT id FROM drive_folders WHERE owner_id = ? AND id = ?').get(who.owner, project.folder_id);
    this.db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(project.id, who.owner);
    if (deleteFiles && folder && this.drive) this.drive.deleteFolder(who.owner, folder.id);
    setImmediate(() => { this.bus.emit(project.owner_id + ':' + project.id, { deleted: true }); this.onEvent(project.owner_id, { project: slug, type: 'project_deleted', id: slug }); });
  }
  deleteOwner(owner) {
    this.db.prepare('DELETE FROM projects WHERE owner_id = ?').run(owner);
    this.db.prepare('DELETE FROM project_idempotency WHERE owner_id = ?').run(owner);
  }
  state(owner, slug) {
    const project = this.project(owner, slug);
    const statuses = {};
    for (const row of this.db.prepare('SELECT * FROM project_status WHERE project_id = ? ORDER BY actor').all(project.id)) statuses[row.actor] = this.statusOut(row);
    const decisions = this.db.prepare(`SELECT COALESCE(SUM(status IN ('open', 'proxy')), 0) n, COALESCE(SUM(status = 'open' AND blocking), 0) b,
      COALESCE(SUM(status = 'proxy'), 0) p FROM project_decisions WHERE project_id = ?`).get(project.id);
    const tasks = {};
    for (const row of this.db.prepare('SELECT status, COUNT(*) n FROM project_tasks WHERE project_id = ? GROUP BY status').all(project.id)) tasks[row.status] = row.n;
    return {
      project: { id: project.slug, name: project.name, created_at: iso(project.created_at), folder_id: project.folder_id, viewer_title: project.viewer_title || '' },
      modules: this.modulesOf(project), modules_version: project.modules_version,
      summary: { text: project.summary, version: project.summary_version, updated_at: iso(project.summary_updated_at), updated_by: project.summary_updated_by },
      members: this.members(owner, slug).members,
      switches: JSON.parse(project.switches), switches_version: project.switches_version, statuses,
      open_decisions: decisions.n, blocking_decisions: decisions.b, proxy_decisions: decisions.p, tasks, usage: this.projectUsage(owner),
      cursor: this.db.prepare('SELECT COALESCE(MAX(id), 0) n FROM project_events WHERE project_id = ?').get(project.id).n,
    };
  }
  setModules(who, slug, input) {
    if (!isObject(input) || !isObject(input.modules)) fail('invalid_modules');
    const expected = version(input.version);
    const viewerTitle = input.viewer_title === undefined ? undefined : line(input.viewer_title, 60, 'invalid_modules', { allowEmpty: true });
    return this.write(who, slug, project => {
      if (project.modules_version !== expected) fail('version_conflict', 409, { version: project.modules_version, current: this.modulesOf(project) });
      const modules = this.modulesOf(project);
      for (const [key, value] of Object.entries(input.modules)) { if (!MODULES.includes(key) || typeof value !== 'boolean') fail('invalid_modules'); modules[key] = value; }
      const title = viewerTitle === undefined ? project.viewer_title : viewerTitle;
      this.db.prepare('UPDATE projects SET modules = ?, modules_version = modules_version + 1, viewer_title = ? WHERE id = ?').run(JSON.stringify(modules), title, project.id);
      this.event(project, who, 'modules', project.slug, 'modules: ' + MODULES.filter(key => modules[key]).join(', '));
      return { modules, modules_version: project.modules_version + 1, viewer_title: title };
    });
  }
  setSummary(who, slug, input) {
    if (!isObject(input)) fail('invalid_summary');
    const summary = text(input.text, LIMITS.summary, 'invalid_summary', { allowEmpty: true }), expected = version(input.version);
    this.scan(summary);
    return this.write(who, slug, (project, by) => {
      if (project.summary_version !== expected) fail('version_conflict', 409, { version: project.summary_version, current: project.summary });
      this.quota(who.owner, bytes(summary) - bytes(project.summary));
      this.db.prepare('UPDATE projects SET summary = ?, summary_version = summary_version + 1, summary_updated_at = ?, summary_updated_by = ? WHERE id = ?').run(summary, Date.now(), by, project.id);
      this.event(project, who, 'summary', project.slug, by + ' updated the summary');
      return { text: summary, version: project.summary_version + 1 };
    });
  }
  setSwitches(who, slug, input) {
    if (!isObject(input)) fail('invalid_switches');
    const switches = primitives(input.switches, 'invalid_switches', 100), expected = version(input.version);
    return this.write(who, slug, project => {
      if (project.switches_version !== expected) fail('version_conflict', 409, { version: project.switches_version, current: JSON.parse(project.switches) });
      this.quota(who.owner, bytes(switches) - bytes(project.switches));
      this.db.prepare('UPDATE projects SET switches = ?, switches_version = switches_version + 1 WHERE id = ?').run(JSON.stringify(switches), project.id);
      this.event(project, who, 'switches', project.slug, 'switches updated');
      return { switches, switches_version: project.switches_version + 1 };
    });
  }

  // ─── Members ──────────────────────────────────
  members(owner, slug) {
    const project = this.project(owner, slug);
    return { members: this.db.prepare('SELECT name, role, added_by, created_at, last_seen FROM project_members WHERE project_id = ? ORDER BY created_at, name').all(project.id)
      .map(row => ({ ...row, created_at: iso(row.created_at), last_seen: iso(row.last_seen) })) };
  }
  putMember(who, slug, name, input) {
    if (typeof name !== 'string' || !AGENT.test(name) || reserved(name)) fail('invalid_agent_name');
    const role = line(input?.role ?? '', 200, 'invalid_member', { allowEmpty: true });
    this.scan(role);
    return this.write(who, slug, (project, by) => {
      if (this.db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND name = ?').get(project.id, name)) this.db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND name = ?').run(role, project.id, name);
      else {
        if (this.db.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id = ?').get(project.id).n >= LIMITS.members) fail('member_limit');
        this.db.prepare('INSERT INTO project_members(project_id,owner_id,name,role,added_by,created_at) VALUES(?,?,?,?,?,?)').run(project.id, who.owner, name, role, by, Date.now());
      }
      this.event(project, who, 'member', name, by + ' set member ' + name);
      return { name, role };
    });
  }
  removeMember(who, slug, name) {
    return this.write(who, slug, project => {
      if (!this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND name = ?').run(project.id, name).changes) fail('not_found', 404);
      this.event(project, who, 'member', name, 'member removed ' + name);
      return { ok: true };
    });
  }

  // ─── Status ───────────────────────────────────
  statusOut(row) { return { actor: row.actor, status: JSON.parse(row.body), version: row.version, updated_at: iso(row.updated_at), updated_by: row.updated_by }; }
  statuses(owner, slug) {
    const project = this.project(owner, slug);
    return { statuses: this.db.prepare('SELECT * FROM project_status WHERE project_id = ? ORDER BY actor').all(project.id).map(row => this.statusOut(row)) };
  }
  setStatus(who, slug, actor, input) {
    if (typeof actor !== 'string' || !AGENT.test(actor) || reserved(actor)) fail('invalid_agent_name');
    if (!isObject(input) || !isObject(input.status)) fail('invalid_status');
    const expected = version(input.version);
    if (bytes(input.status) > LIMITS.status) fail('status_too_large', 413);
    this.scan(input.status);
    return this.write(who, slug, (project, by) => {
      const row = this.db.prepare('SELECT * FROM project_status WHERE project_id = ? AND actor = ?').get(project.id, actor);
      if ((row?.version || 0) !== expected) fail('version_conflict', 409, { version: row?.version || 0, current: row ? JSON.parse(row.body) : null });
      this.quota(who.owner, bytes(input.status) - (row ? bytes(row.body) : 0));
      this.db.prepare(`INSERT INTO project_status(project_id,owner_id,actor,body,version,updated_at,updated_by) VALUES(?,?,?,?,1,?,?)
        ON CONFLICT(project_id, actor) DO UPDATE SET body = excluded.body, version = version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(project.id, who.owner, actor, JSON.stringify(input.status), Date.now(), by);
      this.event(project, who, 'status', actor, actor + ' status updated');
      return this.statusOut(this.db.prepare('SELECT * FROM project_status WHERE project_id = ? AND actor = ?').get(project.id, actor));
    });
  }

  // ─── Tasks ────────────────────────────────────
  taskOut(row) {
    return { id: row.task_id, phase: row.phase, title: row.title, owners: JSON.parse(row.owners), owner_label: row.owner_label, depends: row.depends,
      done_when: row.done_when, deliver_to: row.deliver_to, status: row.status, notes: row.notes, position: row.position,
      version: row.version, updated_at: iso(row.updated_at), updated_by: row.updated_by };
  }
  tasks(owner, slug, query = {}) {
    const project = this.project(owner, slug);
    let rows = this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY position, task_id').all(project.id).map(row => this.taskOut(row));
    if (query.owner) rows = rows.filter(task => task.owners.includes(query.owner));
    if (query.status) rows = rows.filter(task => task.status === query.status);
    if (query.phase) rows = rows.filter(task => task.phase === query.phase);
    return { tasks: rows };
  }
  task(owner, slug, id) {
    const project = this.project(owner, slug);
    const row = this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, id);
    if (!row) fail('task_not_found', 404);
    return this.taskOut(row);
  }
  taskFields(input, partial) {
    const out = {};
    if (!partial || input.title !== undefined) out.title = line(input.title, 500, 'invalid_task');
    if (input.phase !== undefined) out.phase = line(input.phase, 32, 'invalid_task', { allowEmpty: true });
    if (input.owners !== undefined) {
      if (!Array.isArray(input.owners) || input.owners.length > 10 || input.owners.some(actor => typeof actor !== 'string' || !AGENT.test(actor))) fail('invalid_task');
      out.owners = JSON.stringify([...new Set(input.owners.map(actor => reserved(actor) ? actor.toUpperCase() : actor))]);
    }
    for (const field of ['owner_label', 'depends', 'deliver_to']) if (input[field] !== undefined) out[field] = line(input[field], 500, 'invalid_task', { allowEmpty: true });
    if (input.done_when !== undefined) out.done_when = text(input.done_when, 4000, 'invalid_task', { allowEmpty: true });
    if (input.notes !== undefined) out.notes = text(input.notes, 8000, 'invalid_task', { allowEmpty: true });
    if (input.status !== undefined) { if (!TASK_STATUS.includes(input.status)) fail('invalid_task_status'); out.status = input.status; }
    return out;
  }
  // A task proposed by an agent waits for the owner's approval through a decision.
  createTask(who, slug, input) {
    if (!isObject(input) || typeof input.id !== 'string' || !TASK_ID.test(input.id)) fail('invalid_task_id');
    const fields = this.taskFields({ owners: [], ...input, status: undefined }, false);
    this.scan(fields);
    return this.write(who, slug, (project, by) => {
      if (this.db.prepare('SELECT 1 FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, input.id)) fail('task_exists', 409);
      this.quota(who.owner, bytes(fields));
      const status = who.kind === 'user' ? 'todo' : 'proposed', now = Date.now();
      const position = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 n FROM project_tasks WHERE project_id = ?').get(project.id).n;
      const row = { phase: '', owner_label: '', depends: '', done_when: '', deliver_to: '', notes: '', owners: '[]', ...fields };
      this.db.prepare(`INSERT INTO project_tasks(project_id,owner_id,task_id,phase,title,owners,owner_label,depends,done_when,deliver_to,notes,status,position,version,updated_at,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(project.id, who.owner, input.id, row.phase, row.title, row.owners, row.owner_label, row.depends, row.done_when, row.deliver_to, row.notes, status, position, now, by);
      let approval = null;
      if (status === 'proposed') {
        const info = this.db.prepare(`INSERT INTO project_decisions(project_id,owner_id,raised_by,task_id,question,options,recommendation,blocking,created_at,kind,ref)
          VALUES(?,?,?,?,?,?,?,0,?,'approve_task',?)`).run(project.id, who.owner, by, input.id, by + ' proposes task ' + input.id + ': ' + row.title, JSON.stringify(['approve', 'reject']), '', now, input.id);
        approval = pubId('decision', Number(info.lastInsertRowid));
        this.event(project, who, 'decision', approval, by + ' asks approval for task ' + input.id);
      }
      this.event(project, who, 'task', input.id, by + ' ' + (status === 'proposed' ? 'proposed' : 'created') + ' task ' + input.id);
      return { ...this.taskOut(this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, input.id)), approval };
    }, 'tasks');
  }
  updateTask(who, slug, id, input) {
    if (!isObject(input)) fail('invalid_task');
    const expected = version(input.version);
    const fields = this.taskFields(input, true);
    if (!Object.keys(fields).length) fail('invalid_task');
    this.scan(fields);
    return this.write(who, slug, (project, by) => {
      const row = this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, id);
      if (!row) fail('task_not_found', 404);
      if (row.version !== expected) fail('version_conflict', 409, { version: row.version, current: this.taskOut(row) });
      // Only the owner's approval moves a task into or out of "proposed"/"rejected".
      const gated = ['proposed', 'rejected'];
      if (who.kind !== 'user' && fields.status && fields.status !== row.status && (gated.includes(row.status) || gated.includes(fields.status))) fail('approval_required', 403);
      this.quota(who.owner, bytes(fields));
      const sets = Object.keys(fields).map(key => key + ' = @' + key).join(', ');
      this.db.prepare(`UPDATE project_tasks SET ${sets}, version = version + 1, updated_at = @now, updated_by = @by WHERE project_id = @project AND task_id = @id`)
        .run({ ...fields, now: Date.now(), by, project: project.id, id });
      this.event(project, who, 'task', id, id + (fields.status ? ' → ' + fields.status : ' updated'));
      return this.taskOut(this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, id));
    }, 'tasks');
  }
  importTasks(who, slug, input) {
    this.requireUser(who);
    if (!isObject(input) || !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 500) fail('invalid_tasks');
    const seen = new Set(), duplicates = new Set();
    const tasks = input.tasks.map(task => {
      if (!isObject(task) || typeof task.id !== 'string' || !TASK_ID.test(task.id)) fail('invalid_task_id', 400, { id: isObject(task) ? String(task.id).slice(0, 40) : null });
      if (seen.has(task.id)) duplicates.add(task.id); seen.add(task.id);
      return { id: task.id, ...this.taskFields({ owners: [], ...task, status: undefined, notes: undefined }, false) };
    });
    if (duplicates.size) fail('duplicate_task_id', 400, { ids: [...duplicates] });
    this.scan(tasks);
    return this.write(who, slug, project => {
      this.quota(who.owner, bytes(tasks));
      const now = Date.now(); let created = 0, updated = 0;
      const base = this.db.prepare('SELECT COALESCE(MAX(position), 0) n FROM project_tasks WHERE project_id = ?').get(project.id).n;
      tasks.forEach((task, index) => {
        const exists = this.db.prepare('SELECT 1 FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, task.id);
        const row = { phase: '', owner_label: '', depends: '', done_when: '', deliver_to: '', ...task, project: project.id, owner: who.owner, now, position: base + index + 1 };
        if (exists) {
          this.db.prepare(`UPDATE project_tasks SET phase=@phase, title=@title, owners=@owners, owner_label=@owner_label, depends=@depends,
            done_when=@done_when, deliver_to=@deliver_to, version = version + 1, updated_at=@now, updated_by='USER' WHERE project_id=@project AND task_id=@id`).run(row);
          updated++;
        } else {
          this.db.prepare(`INSERT INTO project_tasks(project_id,owner_id,task_id,phase,title,owners,owner_label,depends,done_when,deliver_to,position,version,updated_at,updated_by)
            VALUES(@project,@owner,@id,@phase,@title,@owners,@owner_label,@depends,@done_when,@deliver_to,@position,1,@now,'USER')`).run(row);
          created++;
        }
      });
      this.event(project, who, 'task', '*', 'tasks imported: ' + created + ' new, ' + updated + ' updated');
      return { created, updated };
    }, 'tasks');
  }

  // ─── Messages ─────────────────────────────────
  messageOut(row) {
    return { id: pubId('message', row.id), from: row.sender, to: row.recipient, thread: row.thread, task_id: row.task_id, type: row.type,
      body: row.body, refs: JSON.parse(row.refs), created_at: iso(row.created_at), edited_at: iso(row.edited_at) };
  }
  refs(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 20 || value.some(ref => !isObject(ref) || !REF_KINDS.includes(ref.kind) || typeof ref.id !== 'string' || !ref.id || ref.id.length > 300)) fail('invalid_refs');
    return value.map(ref => ({ kind: ref.kind, id: ref.id }));
  }
  messages(owner, slug, query = {}) {
    const project = this.project(owner, slug);
    const since = cursor(query.since), limit = Math.min(500, Math.max(1, Number(query.limit) || 200));
    const where = ['project_id = @project', 'id > @since'], params = { project: project.id, since, limit };
    if (query.thread) { where.push('thread = @thread'); params.thread = String(query.thread); }
    if (query.to) { where.push("(recipient = @to OR recipient = 'ALL')"); params.to = String(query.to); }
    if (query.task) { where.push('task_id = @task'); params.task = String(query.task); }
    if (query.from) { where.push('sender = @from'); params.from = String(query.from); }
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    const rows = this.db.prepare(`SELECT * FROM project_messages WHERE ${where.join(' AND ')} ORDER BY id ${order} LIMIT @limit`).all(params);
    return { messages: rows.map(row => this.messageOut(row)), next: rows.length === limit ? pubId('message', rows[rows.length - 1].id) : null };
  }
  postMessage(who, slug, input) {
    if (!isObject(input)) fail('invalid_message');
    const to = recipient(input.to ?? 'ALL'), type = input.type ?? 'info';
    if (!MESSAGE_TYPES.includes(type)) fail('invalid_message_type');
    const body = text(input.body, LIMITS.message, 'invalid_message');
    const taskId = input.task_id === undefined || input.task_id === null || input.task_id === '' ? null : input.task_id;
    if (taskId !== null && (typeof taskId !== 'string' || !TASK_ID.test(taskId))) fail('invalid_task_id');
    const refs = this.refs(input.refs);
    this.scan({ body, refs });
    return this.write(who, slug, (project, from) => {
      let thread = null;
      if (input.thread !== undefined && input.thread !== null && input.thread !== '') {
        thread = String(input.thread);
        if (!this.db.prepare('SELECT 1 FROM project_messages WHERE project_id = ? AND thread = ?').get(project.id, thread)) fail('thread_not_found', 404);
      }
      this.quota(who.owner, bytes(body) + bytes(refs));
      const info = this.db.prepare('INSERT INTO project_messages(project_id,owner_id,sender,recipient,thread,task_id,type,body,refs,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, from, to, thread || '', taskId, type, body, JSON.stringify(refs), Date.now());
      const id = Number(info.lastInsertRowid);
      if (!thread) this.db.prepare('UPDATE project_messages SET thread = ? WHERE id = ?').run(pubId('message', id), id);
      this.event(project, who, 'message', pubId('message', id), from + ' → ' + to + ': ' + type + (taskId ? ' [' + taskId + ']' : ''));
      return this.messageOut(this.db.prepare('SELECT * FROM project_messages WHERE id = ?').get(id));
    }, 'messages');
  }
  editMessage(who, slug, id, input) {
    if (!isObject(input)) fail('invalid_message');
    const body = text(input.body, LIMITS.message, 'invalid_message');
    this.scan(body);
    return this.write(who, slug, (project, by) => {
      const row = this.db.prepare('SELECT * FROM project_messages WHERE project_id = ? AND id = ?').get(project.id, parseId('message', id));
      if (!row) fail('not_found', 404);
      this.quota(who.owner, bytes(body) - bytes(row.body));
      this.db.prepare('UPDATE project_messages SET body = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), row.id);
      this.event(project, who, 'message', pubId('message', row.id), by + ' edited ' + pubId('message', row.id));
      return this.messageOut(this.db.prepare('SELECT * FROM project_messages WHERE id = ?').get(row.id));
    }, 'messages');
  }

  // ─── Handoffs ─────────────────────────────────
  handoffOut(row) {
    return { id: pubId('handoff', row.id), from: row.sender, ...JSON.parse(row.body), supersedes: row.supersedes ? pubId('handoff', row.supersedes) : null,
      superseded_by: row.superseded_by ? pubId('handoff', row.superseded_by) : null, created_at: iso(row.created_at), edited_at: iso(row.edited_at) };
  }
  handoffRow(projectId, number) {
    return this.db.prepare(`SELECT h.*, (SELECT MAX(n.id) FROM project_handoffs n WHERE n.project_id = h.project_id AND n.supersedes = h.id) superseded_by
      FROM project_handoffs h WHERE h.project_id = ? AND h.id = ?`).get(projectId, number);
  }
  handoffs(owner, slug, query = {}) {
    const project = this.project(owner, slug);
    const params = { project: project.id, since: cursor(query.since) };
    let where = 'h.project_id = @project AND h.id > @since';
    if (query.task) { where += ' AND h.task_id = @task'; params.task = String(query.task); }
    const rows = this.db.prepare(`SELECT h.*, (SELECT MAX(n.id) FROM project_handoffs n WHERE n.project_id = h.project_id AND n.supersedes = h.id) superseded_by
      FROM project_handoffs h WHERE ${where} ORDER BY h.id LIMIT 500`).all(params);
    return { handoffs: rows.map(row => this.handoffOut(row)) };
  }
  handoff(owner, slug, id) {
    const project = this.project(owner, slug);
    const row = this.handoffRow(project.id, parseId('handoff', id));
    if (!row) fail('not_found', 404);
    return this.handoffOut(row);
  }
  handoffBody(input) {
    if (!isObject(input)) fail('invalid_handoff');
    if (typeof input.task_id !== 'string' || !TASK_ID.test(input.task_id)) fail('invalid_task_id');
    const body = {
      task_id: input.task_id, to: recipient(input.to ?? 'ALL'), status: line(input.status ?? 'PASS', 32, 'invalid_handoff_status'), summary: text(input.summary, 2000, 'invalid_handoff'),
      conditions: primitives(input.conditions, 'invalid_conditions'), evidence_level: input.evidence_level ?? null, files: [], limitations: [],
      next_action: text(input.next_action ?? '', 4000, 'invalid_handoff', { allowEmpty: true }), refs: this.refs(input.refs),
    };
    if (body.evidence_level !== null && (typeof body.evidence_level !== 'string' || body.evidence_level.length > 32)) fail('invalid_evidence_level');
    if (input.files !== undefined) {
      if (!Array.isArray(input.files) || input.files.length > 100) fail('invalid_files');
      body.files = input.files.map(file => {
        if (!isObject(file)) fail('invalid_files');
        const sha = file.sha256 ?? null;
        if (sha !== null && (typeof sha !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha))) fail('invalid_sha256');
        return { name: line(file.name, 300, 'invalid_files'), location: line(file.location, 1000, 'invalid_files'), sha256: sha ? sha.toLowerCase() : null,
          format_note: text(file.format_note ?? '', 2000, 'invalid_files', { allowEmpty: true }) };
      });
    }
    if (input.limitations !== undefined) {
      if (!Array.isArray(input.limitations) || input.limitations.length > 50) fail('invalid_handoff');
      body.limitations = input.limitations.map(item => text(item, 1000, 'invalid_handoff'));
    }
    if (bytes(body) > LIMITS.handoff) fail('handoff_too_large', 413);
    this.scan(body);
    return body;
  }
  addHandoff(who, slug, input) {
    const body = this.handoffBody(input);
    return this.write(who, slug, (project, from) => {
      let supersedes = null;
      if (input.supersedes !== undefined && input.supersedes !== null) {
        supersedes = parseId('handoff', input.supersedes, 'invalid_supersedes', 400);
        if (!this.db.prepare('SELECT 1 FROM project_handoffs WHERE project_id = ? AND id = ?').get(project.id, supersedes)) fail('supersedes_not_found', 404);
      }
      this.quota(who.owner, bytes(body));
      const info = this.db.prepare('INSERT INTO project_handoffs(project_id,owner_id,sender,recipient,task_id,status,body,supersedes,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, from, body.to, body.task_id, body.status, JSON.stringify(body), supersedes, Date.now());
      const id = Number(info.lastInsertRowid);
      this.event(project, who, 'handoff', pubId('handoff', id), from + ' → ' + body.to + ': ' + body.task_id + ' ' + body.status);
      return this.handoffOut(this.handoffRow(project.id, id));
    }, 'handoffs');
  }
  editHandoff(who, slug, id, input) {
    const body = this.handoffBody(input);
    return this.write(who, slug, (project, by) => {
      const row = this.handoffRow(project.id, parseId('handoff', id));
      if (!row) fail('not_found', 404);
      this.quota(who.owner, bytes(body) - bytes(row.body));
      this.db.prepare('UPDATE project_handoffs SET body = ?, recipient = ?, task_id = ?, status = ?, edited_at = ? WHERE id = ?').run(JSON.stringify(body), body.to, body.task_id, body.status, Date.now(), row.id);
      this.event(project, who, 'handoff', pubId('handoff', row.id), by + ' edited ' + pubId('handoff', row.id));
      return this.handoffOut(this.handoffRow(project.id, row.id));
    }, 'handoffs');
  }

  // ─── Decisions ────────────────────────────────
  // status: open → (agent proxy answer) proxy → (owner confirms or overrides) answered.
  // The owner can also answer directly while open. Once answered, only the owner changes it.
  decisionOut(row) {
    return { id: pubId('decision', row.id), kind: row.kind || 'question', ref: row.ref, raised_by: row.raised_by, task_id: row.task_id, question: row.question,
      options: JSON.parse(row.options), recommendation: row.recommendation, blocking: !!row.blocking, status: row.status, answer: row.answer,
      answered_by: row.answered_by || (row.status === 'answered' ? 'USER' : null), proxy: !!row.answered_by && row.answered_by !== 'USER',
      answered_at: iso(row.answered_at), confirmed_at: iso(row.confirmed_at), created_at: iso(row.created_at), edited_at: iso(row.edited_at) };
  }
  decisions(owner, slug, query = {}) {
    const project = this.project(owner, slug);
    const params = { project: project.id }; let where = 'project_id = @project';
    if (query.status) {
      if (!['open', 'proxy', 'answered', 'pending'].includes(query.status)) fail('invalid_status_filter');
      // pending = still waiting for the owner (open or proxy-answered)
      where += query.status === 'pending' ? " AND status IN ('open', 'proxy')" : ' AND status = @status'; params.status = query.status;
    }
    if (query.task) { where += ' AND task_id = @task'; params.task = String(query.task); }
    return { decisions: this.db.prepare(`SELECT * FROM project_decisions WHERE ${where} ORDER BY blocking DESC, id DESC LIMIT 500`).all(params).map(row => this.decisionOut(row)) };
  }
  decision(owner, slug, id) {
    const project = this.project(owner, slug);
    const row = this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND id = ?').get(project.id, parseId('decision', id));
    if (!row) fail('not_found', 404);
    return this.decisionOut(row);
  }
  decisionFields(input) {
    if (!isObject(input)) fail('invalid_decision');
    const taskId = input.task_id ?? null;
    if (taskId !== null && (typeof taskId !== 'string' || !TASK_ID.test(taskId))) fail('invalid_task_id');
    const question = text(input.question, 4000, 'invalid_decision');
    const options = input.options ?? [];
    if (!Array.isArray(options) || options.length > 10) fail('invalid_decision');
    options.forEach(option => text(option, 500, 'invalid_decision'));
    const recommendation = text(input.recommendation ?? '', 4000, 'invalid_decision', { allowEmpty: true });
    if (input.blocking !== undefined && typeof input.blocking !== 'boolean') fail('invalid_decision');
    this.scan({ question, options, recommendation });
    return { taskId, question, options, recommendation, blocking: input.blocking ? 1 : 0 };
  }
  raiseDecision(who, slug, input) {
    const fields = this.decisionFields(input);
    return this.write(who, slug, (project, by) => {
      this.quota(who.owner, bytes(fields));
      const info = this.db.prepare('INSERT INTO project_decisions(project_id,owner_id,raised_by,task_id,question,options,recommendation,blocking,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, by, fields.taskId, fields.question, JSON.stringify(fields.options), fields.recommendation, fields.blocking, Date.now());
      const id = Number(info.lastInsertRowid);
      this.event(project, who, 'decision', pubId('decision', id), by + ' asks' + (fields.blocking ? ' (blocking)' : '') + (fields.taskId ? ' [' + fields.taskId + ']' : ''));
      return this.decisionOut(this.db.prepare('SELECT * FROM project_decisions WHERE id = ?').get(id));
    }, 'decisions');
  }
  editDecision(who, slug, id, input) {
    const fields = this.decisionFields(input);
    return this.write(who, slug, (project, by) => {
      const row = this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND id = ?').get(project.id, parseId('decision', id));
      if (!row) fail('not_found', 404);
      if (row.status !== 'open') fail('decision_answered', 409);
      if (row.kind === 'approve_task' && who.kind !== 'user') fail('approval_required', 403);
      this.db.prepare('UPDATE project_decisions SET task_id = ?, question = ?, options = ?, recommendation = ?, blocking = ?, edited_at = ? WHERE id = ?')
        .run(fields.taskId, fields.question, JSON.stringify(fields.options), fields.recommendation, fields.blocking, Date.now(), row.id);
      this.event(project, who, 'decision', pubId('decision', row.id), by + ' edited ' + pubId('decision', row.id));
      return this.decisionOut(this.db.prepare('SELECT * FROM project_decisions WHERE id = ?').get(row.id));
    }, 'decisions');
  }
  // A task-approval answer moves the task to todo (approve) or rejected (anything else).
  applyTaskApproval(project, who, row, answer, by) {
    if (row.kind !== 'approve_task' || !row.ref) return;
    const approved = /^\s*(approve|批准|同意|yes|ok)/i.test(answer);
    const task = this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, row.ref);
    if (task && ['proposed', 'rejected', 'todo'].includes(task.status)) {
      this.db.prepare('UPDATE project_tasks SET status = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE project_id = ? AND task_id = ?').run(approved ? 'todo' : 'rejected', Date.now(), by, project.id, row.ref);
      this.event(project, who, 'task', row.ref, row.ref + ' ' + (approved ? 'approved' : 'rejected') + (by === 'USER' ? '' : ' (proxy ' + by + ')'));
    }
  }
  // Whether an agent's proxy answer to a task approval takes effect before the owner confirms it.
  // Default: no. A proxy approval only records the answer; the task starts after the owner confirms.
  proxyAppliesToTask(row, by) {
    return false;
  }
  // Owner: final answer (also overrides a proxy answer). Agent: proxy answer, shown
  // as such until the owner confirms or overrides it.
  answerDecision(who, slug, id, input) {
    if (!isObject(input)) fail('invalid_answer');
    const answer = text(input.answer, 8000, 'invalid_answer');
    this.scan(answer);
    return this.write(who, slug, (project, by) => {
      const row = this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND id = ?').get(project.id, parseId('decision', id));
      if (!row) fail('not_found', 404);
      this.quota(who.owner, bytes(answer) - bytes(row.answer || ''));
      const now = Date.now();
      if (who.kind === 'user') {
        this.db.prepare("UPDATE project_decisions SET status = 'answered', answer = ?, answered_by = 'USER', answered_at = ?, confirmed_at = ? WHERE id = ?").run(answer, now, now, row.id);
        this.applyTaskApproval(project, who, row, answer, 'USER');
        this.event(project, who, 'decision', pubId('decision', row.id), row.status === 'proxy' ? 'USER overrode the proxy answer of ' + row.answered_by : 'USER answered');
      } else {
        if (row.status === 'answered') fail('decision_answered', 409);
        // One proxy answer per decision, never by the member who raised it.
        if (row.raised_by === by) fail('own_decision', 403);
        if (row.status === 'proxy') fail('proxy_answered', 409, { answered_by: row.answered_by });
        this.db.prepare("UPDATE project_decisions SET status = 'proxy', answer = ?, answered_by = ?, answered_at = ?, confirmed_at = NULL WHERE id = ?").run(answer, by, now, row.id);
        if (this.proxyAppliesToTask(row, by)) this.applyTaskApproval(project, who, row, answer, by);
        this.event(project, who, 'decision', pubId('decision', row.id), by + ' answered as proxy (awaiting USER)');
      }
      return this.decisionOut(this.db.prepare('SELECT * FROM project_decisions WHERE id = ?').get(row.id));
    }, who.kind === 'user' ? undefined : 'decisions');
  }
  // Owner keeps a proxy answer as the final one.
  confirmDecision(who, slug, id) {
    this.requireUser(who);
    return this.write(who, slug, project => {
      const row = this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND id = ?').get(project.id, parseId('decision', id));
      if (!row) fail('not_found', 404);
      if (row.status !== 'proxy') fail('nothing_to_confirm', 409);
      this.db.prepare("UPDATE project_decisions SET status = 'answered', confirmed_at = ? WHERE id = ?").run(Date.now(), row.id);
      if (!this.proxyAppliesToTask(row, row.answered_by)) this.applyTaskApproval(project, who, row, row.answer, 'USER');
      this.event(project, who, 'decision', pubId('decision', row.id), 'USER confirmed the proxy answer of ' + row.answered_by);
      return this.decisionOut(this.db.prepare('SELECT * FROM project_decisions WHERE id = ?').get(row.id));
    });
  }

  // ─── Project folder (in the owner's drive) ────
  ensureFolder(project) {
    if (!this.drive) fail('drive_unavailable', 500);
    const owner = project.owner_id;
    if (project.folder_id && this.db.prepare('SELECT 1 FROM drive_folders WHERE owner_id = ? AND id = ?').get(owner, project.folder_id)) return project.folder_id;
    let root = this.db.prepare('SELECT id FROM drive_folders WHERE owner_id = ? AND parent_id IS NULL AND name = ?').get(owner, ROOT_FOLDER)?.id;
    if (!root) root = this.drive.createFolder(owner, { name: ROOT_FOLDER, parentId: null }).id;
    const base = project.name.replace(/[\\/\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100) || project.slug;
    let name = base, suffix = 2;
    while (this.db.prepare('SELECT 1 FROM drive_folders WHERE owner_id = ? AND parent_id = ? AND name = ?').get(owner, root, name)) name = base + ' (' + suffix++ + ')';
    const folder = this.drive.createFolder(owner, { name, parentId: root }).id;
    for (const sub of SUBFOLDERS) this.drive.createFolder(owner, { name: sub, parentId: folder });
    this.db.prepare('UPDATE projects SET folder_id = ? WHERE id = ?').run(folder, project.id);
    project.folder_id = folder;
    for (const file of ['RULES.md', 'GUIDE.md']) {
      const source = path.join(TEMPLATES, file);
      if (fs.existsSync(source)) this.storeFile(project, '', file, fs.readFileSync(source, 'utf8').replace(/\{\{PROJECT\}\}/g, project.slug).replace(/\{\{NAME\}\}/g, project.name), false);
    }
    return folder;
  }
  splitPath(value, allowEmpty = false) {
    if (value === undefined || value === null || value === '') { if (allowEmpty) return []; fail('invalid_path'); }
    if (typeof value !== 'string' || value.length > 500 || value.startsWith('/') || value.includes('\\')) fail('invalid_path');
    const parts = value.split('/').filter(Boolean).map(part => part.trim());
    for (const part of parts) if (!part || part.length > 120 || /[\x00-\x1f\x7f]/.test(part) || ['.', '..'].includes(part)) fail('invalid_path');
    if (!parts.length && !allowEmpty) fail('invalid_path');
    return parts;
  }
  resolveFolder(project, parts, create) {
    let folder = this.ensureFolder(project);
    for (const part of parts) {
      const next = this.db.prepare('SELECT id FROM drive_folders WHERE owner_id = ? AND parent_id = ? AND name = ?').get(project.owner_id, folder, part);
      if (next) folder = next.id;
      else if (create) folder = this.drive.createFolder(project.owner_id, { name: part, parentId: folder }).id;
      else fail('not_found', 404);
    }
    return folder;
  }
  findFile(owner, folder, name) {
    return this.db.prepare(`SELECT a.* FROM drive_files d JOIN assets a ON a.name = d.name WHERE d.owner_id = ? AND d.folder_id = ? AND a.original_name = ?
      ORDER BY a.time DESC, a.name DESC`).all(owner, folder, name);
  }
  fileOut(asset, filePath) { return { path: filePath, name: asset.original_name, size: asset.size, time: iso(asset.time), etag: asset.name }; }
  listFiles(owner, slug, dir, recursive) {
    const project = this.project(owner, slug);
    const parts = this.splitPath(dir, true);
    const start = this.db.transaction(() => this.resolveFolder(project, parts, false))();
    const out = { path: parts.join('/'), folder_id: start, folders: [], files: [] };
    const walk = (folder, prefix, depth) => {
      for (const row of this.db.prepare('SELECT id, name FROM drive_folders WHERE owner_id = ? AND parent_id = ? ORDER BY name').all(owner, folder)) {
        out.folders.push(prefix + row.name);
        if (recursive && depth < 32) walk(row.id, prefix + row.name + '/', depth + 1);
      }
      for (const asset of this.db.prepare(`SELECT a.* FROM drive_files d JOIN assets a ON a.name = d.name WHERE d.owner_id = ? AND d.folder_id = ? ORDER BY a.original_name`).all(owner, folder)) {
        out.files.push(this.fileOut(asset, prefix + asset.original_name));
      }
    };
    walk(start, parts.length ? parts.join('/') + '/' : '', 0);
    return out;
  }
  fileAsset(owner, slug, filePath) {
    const project = this.project(owner, slug), parts = this.splitPath(filePath);
    const folder = this.db.transaction(() => this.resolveFolder(project, parts.slice(0, -1), false))();
    const asset = this.findFile(owner, folder, parts[parts.length - 1])[0];
    if (!asset) fail('not_found', 404);
    return asset;
  }
  readFile(owner, slug, filePath) {
    const asset = this.fileAsset(owner, slug, filePath);
    if (asset.size > LIMITS.text) fail('file_too_large_for_text', 413, { size: asset.size });
    return { ...this.fileOut(asset, this.splitPath(filePath).join('/')), content: fs.readFileSync(path.join(this.workspace.uploadsDir, asset.name), 'utf8') };
  }
  protectedPath(parts) { return parts.length === 1 && PROTECTED_FILES.includes(parts[0]); }
  // Stores a body as the file at dir/name, replacing older files of the same name.
  storeFile(project, dir, name, content, check = true, etag) {
    const owner = project.owner_id, size = Buffer.byteLength(content);
    const asset = Date.now() + '_' + randomUUID(), target = path.join(this.workspace.uploadsDir, asset);
    fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
    try {
      const old = this.db.transaction(() => {
        const folder = this.resolveFolder(project, this.splitPath(dir, true), true);
        const existing = this.findFile(owner, folder, name);
        if (etag !== undefined && etag !== null && (existing[0]?.name || '') !== etag) fail('version_conflict', 409, { etag: existing[0]?.name || null });
        if (check) this.quota(owner, size - existing.reduce((sum, row) => sum + row.size, 0));
        this.db.prepare('INSERT INTO assets (name, owner_id, original_name, size, time) VALUES (?, ?, ?, ?, ?)').run(asset, owner, name, size, Date.now());
        this.db.prepare('UPDATE drive_files SET folder_id = ? WHERE owner_id = ? AND name = ?').run(folder, owner, asset);
        const names = existing.map(row => row.name);
        if (names.length) this.drive.removeRecords(owner, names);
        return names;
      })();
      // Old bodies are removed only after the outermost transaction commits.
      if (old.length) { if (this.db.inTransaction) setImmediate(() => this.drive.removeBodies(old)); else this.drive.removeBodies(old); }
      return asset;
    } catch (error) { fs.rmSync(target, { force: true }); throw error; }
  }
  writeFile(who, slug, input) {
    if (!isObject(input)) fail('invalid_file');
    const parts = this.splitPath(input.path), content = text(input.content, LIMITS.textWrite, 'invalid_file', { allowEmpty: true });
    if (Buffer.byteLength(content) > LIMITS.textWrite) fail('file_too_large_for_text', 413, { hint: 'use files/upload' });
    if (who.kind !== 'user' && this.protectedPath(parts)) fail('owner_only', 403);
    this.scan(content);
    return this.write(who, slug, (project, by) => {
      const asset = this.storeFile(project, parts.slice(0, -1).join('/'), parts[parts.length - 1], content, true, input.etag);
      this.event(project, who, 'file', parts.join('/'), by + ' wrote ' + parts.join('/'));
      return { path: parts.join('/'), etag: asset, size: Buffer.byteLength(content) };
    }, 'files');
  }
  // Uploaded files (already on disk) are filed into the project folder.
  addFiles(who, slug, dir, files) {
    const parts = this.splitPath(dir, true);
    const result = this.write(who, slug, (project, by) => {
      const folder = this.resolveFolder(project, parts, true), owner = project.owner_id, replaced = [];
      for (const file of files) {
        if (who.kind !== 'user' && this.protectedPath([...parts, file.originalName])) fail('owner_only', 403);
        const existing = this.findFile(owner, folder, file.originalName);
        this.quota(owner, file.size - existing.reduce((sum, row) => sum + row.size, 0));
        this.db.prepare('INSERT INTO assets (name, owner_id, original_name, size, time) VALUES (?, ?, ?, ?, ?)').run(file.name, owner, file.originalName, file.size, file.time);
        this.db.prepare('UPDATE drive_files SET folder_id = ? WHERE owner_id = ? AND name = ?').run(folder, owner, file.name);
        if (existing.length) { this.drive.removeRecords(owner, existing.map(row => row.name)); replaced.push(...existing.map(row => row.name)); }
      }
      const prefix = parts.length ? parts.join('/') + '/' : '';
      this.event(project, who, 'file', prefix + files.map(file => file.originalName).join(','), by + ' uploaded ' + files.length + ' file(s) to ' + (prefix || '/'));
      return { replaced, files: files.map(file => ({ path: prefix + file.originalName, size: file.size, etag: file.name })) };
    }, 'files');
    if (result.replaced.length) this.drive.removeBodies(result.replaced);
    return { files: result.files };
  }
  deleteFile(who, slug, filePath) {
    const parts = this.splitPath(filePath);
    if (who.kind !== 'user' && this.protectedPath(parts)) fail('owner_only', 403);
    const names = this.write(who, slug, project => {
      const folder = this.resolveFolder(project, parts.slice(0, -1), false);
      const existing = this.findFile(who.owner, folder, parts[parts.length - 1]);
      if (!existing.length) fail('not_found', 404);
      this.drive.removeRecords(who.owner, existing.map(row => row.name));
      this.event(project, who, 'file', parts.join('/'), 'deleted ' + parts.join('/'));
      return existing.map(row => row.name);
    });
    this.drive.removeBodies(names);
    return { ok: true };
  }

  // ─── Viewer: graphs (versioned) and records ───
  validateGraph(view, input) {
    if (!isObject(input)) fail('invalid_graph');
    if (bytes(input) > LIMITS.graph) fail('graph_too_large', 413);
    const problem = (message, at) => fail('invalid_graph', 400, { problem: message, path: at });
    if (input.schema !== undefined && !['graph/v1', 'circuit-topology/v1'].includes(input.schema)) problem('schema must be graph/v1', 'schema');
    if (input.level !== undefined && (typeof input.level !== 'string' || input.level.length > 32)) problem('level must be a short string', 'level');
    if (input.candidate !== undefined && input.candidate !== null && (typeof input.candidate !== 'string' || input.candidate.length > 200)) problem('candidate must be a string', 'candidate');
    const groups = input.groups ?? [];
    if (!Array.isArray(groups) || groups.length > 200) problem('groups must be an array', 'groups');
    const groupIds = new Set();
    groups.forEach((group, index) => {
      if (!isObject(group) || typeof group.id !== 'string' || !NODE_ID.test(group.id) || groupIds.has(group.id)) problem('group ids must be unique identifiers', 'groups[' + index + ']');
      if (group.label !== undefined && (typeof group.label !== 'string' || group.label.length > 200)) problem('group label must be a string', 'groups[' + index + '].label');
      groupIds.add(group.id);
    });
    if (!Array.isArray(input.nodes) || !input.nodes.length) problem('nodes must be a non-empty array', 'nodes');
    if (input.nodes.length > LIMITS.graphNodes) fail('graph_too_large', 413, { problem: 'at most ' + LIMITS.graphNodes + ' nodes' });
    const nodeIds = new Set();
    input.nodes.forEach((node, index) => {
      const at = 'nodes[' + index + ']';
      if (!isObject(node) || typeof node.id !== 'string' || !NODE_ID.test(node.id)) problem('node id must be an identifier', at + '.id');
      if (nodeIds.has(node.id)) problem('duplicate node id ' + node.id, at + '.id');
      nodeIds.add(node.id);
      if (node.kind !== undefined && (typeof node.kind !== 'string' || !KIND.test(node.kind))) problem('kind must be a short identifier', at + '.kind');
      if (node.group !== undefined && node.group !== null && !groupIds.has(node.group)) problem('unknown group', at + '.group');
      for (const field of ['label', 'subckt']) if (node[field] !== undefined && node[field] !== null && (typeof node[field] !== 'string' || node[field].length > 200)) problem(field + ' must be a string', at + '.' + field);
      if (node.params !== undefined && node.params !== null) {
        if (!isObject(node.params) || Object.keys(node.params).length > 100) problem('params must be an object', at + '.params');
        for (const [key, value] of Object.entries(node.params)) {
          if (!['number', 'string', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 200)) problem('param values must be numbers, strings or booleans', at + '.params.' + key.slice(0, 40));
        }
      }
    });
    const edges = input.edges ?? [];
    if (!Array.isArray(edges) || edges.length > LIMITS.graphNodes * 4) problem('edges must be an array', 'edges');
    edges.forEach((edge, index) => {
      const at = 'edges[' + index + ']';
      if (!isObject(edge)) problem('edge must be an object', at);
      for (const end of ['from', 'to']) {
        if (typeof edge[end] !== 'string' || edge[end].length > 130) problem(end + ' must be NODE or NODE.port', at + '.' + end);
        const node = edge[end].includes('.') && !nodeIds.has(edge[end]) ? edge[end].slice(0, edge[end].lastIndexOf('.')) : edge[end];
        if (!nodeIds.has(node)) problem(end + ' refers to a missing node', at + '.' + end);
      }
      if (edge.kind !== undefined && (typeof edge.kind !== 'string' || !KIND.test(edge.kind))) problem('edge kind must be a short identifier', at + '.kind');
      if (edge.net !== undefined && (typeof edge.net !== 'string' || edge.net.length > 200)) problem('net must be a string', at + '.net');
    });
    if (input.source !== undefined && input.source !== null) primitives(input.source, 'invalid_graph');
    if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== 'string' || input.notes.length > 20000)) problem('notes must be a string', 'notes');
    const { circuit, ...rest } = input;
    return { ...rest, schema: 'graph/v1', view };
  }
  views(owner, slug) {
    const project = this.project(owner, slug);
    const rows = this.db.prepare(`SELECT t.circuit, t.version, t.candidate, t.level, t.node_count, t.created_at, t.created_by,
      (SELECT COUNT(*) FROM project_results r WHERE r.project_id = t.project_id AND r.circuit = t.circuit) records
      FROM project_topologies t WHERE t.project_id = ? AND t.version = (SELECT MAX(version) FROM project_topologies x WHERE x.project_id = t.project_id AND x.circuit = t.circuit)
      ORDER BY t.circuit`).all(project.id);
    const known = new Set(rows.map(row => row.circuit));
    const extra = this.db.prepare('SELECT circuit, COUNT(*) records FROM project_results WHERE project_id = ? GROUP BY circuit').all(project.id).filter(row => !known.has(row.circuit));
    return { views: [...rows.map(row => ({ view: row.circuit, latest_version: row.version, candidate: row.candidate, level: row.level, nodes: row.node_count,
      records: row.records, updated_at: iso(row.created_at), updated_by: row.created_by })), ...extra.map(row => ({ view: row.circuit, latest_version: null, records: row.records }))] };
  }
  graphVersions(owner, slug, view) {
    const project = this.project(owner, slug);
    return { versions: this.db.prepare('SELECT version, candidate, level, node_count nodes, created_at, created_by FROM project_topologies WHERE project_id = ? AND circuit = ? ORDER BY version DESC')
      .all(project.id, view).map(row => ({ ...row, created_at: iso(row.created_at) })) };
  }
  graph(owner, slug, view, requested) {
    const project = this.project(owner, slug);
    const row = requested !== undefined && requested !== ''
      ? this.db.prepare('SELECT * FROM project_topologies WHERE project_id = ? AND circuit = ? AND version = ?').get(project.id, view, Number(requested))
      : this.db.prepare('SELECT * FROM project_topologies WHERE project_id = ? AND circuit = ? ORDER BY version DESC LIMIT 1').get(project.id, view);
    if (!row) fail('not_found', 404);
    return { view, version: row.version, created_at: iso(row.created_at), created_by: row.created_by, graph: JSON.parse(row.body) };
  }
  putGraph(who, slug, view, input) {
    if (typeof view !== 'string' || !NAME.test(view)) fail('invalid_view');
    const graph = this.validateGraph(view, input);
    this.scan(graph);
    return this.write(who, slug, (project, by) => {
      this.quota(who.owner, bytes(graph));
      const next = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 n FROM project_topologies WHERE project_id = ? AND circuit = ?').get(project.id, view).n;
      this.db.prepare('INSERT INTO project_topologies(project_id,owner_id,circuit,version,candidate,level,body,node_count,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, view, next, graph.candidate ?? null, graph.level || '', JSON.stringify(graph), graph.nodes.length, Date.now(), by);
      this.event(project, who, 'graph', view + '@' + next, view + ' graph v' + next + ' (' + graph.nodes.length + ' nodes)');
      return { view, version: next, nodes: graph.nodes.length };
    }, 'viewer');
  }
  validateRecord(input, index) {
    const problem = (message, field) => fail('invalid_record', 400, { index, problem: message, field });
    if (!isObject(input)) problem('record must be an object');
    if (input.schema !== undefined && !['record/v1', 'circuit-result/v1'].includes(input.schema)) problem('schema must be record/v1', 'schema');
    if (typeof input.metric !== 'string' || !/^[A-Za-z0-9_.:/%()-]{1,64}$/.test(input.metric)) problem('metric must be an identifier', 'metric');
    const status = input.status ?? 'NO_LIMIT';
    if (typeof status !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(status)) problem('status must be a short identifier', 'status');
    if (input.value !== undefined && input.value !== null && (typeof input.value !== 'number' || !Number.isFinite(input.value))) problem('value must be a finite number', 'value');
    if (['NATIVE_FAILED', 'BLOCKED'].includes(status) && input.value !== undefined && input.value !== null) problem(status + ' must not carry a value', 'value');
    for (const field of ['candidate', 'case_id', 'unit', 'evidence_level']) if (input[field] !== undefined && input[field] !== null && (typeof input[field] !== 'string' || input[field].length > 200)) problem(field + ' must be a string', field);
    if (input.task_id !== undefined && input.task_id !== null && (typeof input.task_id !== 'string' || !TASK_ID.test(input.task_id))) problem('task_id must be a task identifier', 'task_id');
    if (input.node !== undefined && input.node !== null && (typeof input.node !== 'string' || !NODE_ID.test(input.node))) problem('node must be a node identifier', 'node');
    if (input.limit !== undefined && input.limit !== null) {
      const limit = input.limit;
      if (!isObject(limit) || !['>=', '<=', '>', '<', '==', 'between'].includes(limit.op)) problem('limit.op must be >=, <=, >, <, == or between', 'limit');
      if (limit.op === 'between' ? !(Array.isArray(limit.value) && limit.value.length === 2 && limit.value.every(Number.isFinite)) : !Number.isFinite(limit.value)) problem('limit.value must be numeric', 'limit.value');
      if (limit.ref !== undefined && (typeof limit.ref !== 'string' || limit.ref.length > 200)) problem('limit.ref must be a string', 'limit.ref');
    }
    try { primitives(input.conditions, 'x'); } catch { problem('conditions must map names to numbers, strings or booleans', 'conditions'); }
    try { primitives(input.run, 'x'); } catch { problem('run must map names to numbers, strings or booleans', 'run'); }
    if (bytes(input) > 16 * 1024) problem('record is too large');
    return { ...input, schema: 'record/v1', status };
  }
  recordOut(row) {
    return { id: pubId('record', row.id), view: row.circuit, ...JSON.parse(row.body), supersedes: row.supersedes ? pubId('record', row.supersedes) : null,
      created_at: iso(row.created_at), created_by: row.created_by };
  }
  addRecords(who, slug, view, input) {
    if (typeof view !== 'string' || !NAME.test(view)) fail('invalid_view');
    const list = Array.isArray(input) ? input : input?.records ?? input?.results;
    if (!Array.isArray(list) || !list.length) fail('invalid_record');
    if (list.length > LIMITS.recordBatch) fail('too_many_records', 413, { max: LIMITS.recordBatch });
    const records = list.map((record, index) => this.validateRecord(record, index));
    this.scan(records.map(({ supersedes, ...rest }) => rest));
    return this.write(who, slug, (project, by) => {
      this.quota(who.owner, bytes(records));
      const now = Date.now(), ids = [];
      const insert = this.db.prepare(`INSERT INTO project_results(project_id,owner_id,circuit,task_id,candidate,case_id,node,metric,value,unit,status,body,supersedes,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      records.forEach((record, index) => {
        let supersedes = null;
        if (record.supersedes !== undefined && record.supersedes !== null) {
          supersedes = parseId('record', record.supersedes, 'invalid_record', 400);
          if (!this.db.prepare('SELECT 1 FROM project_results WHERE project_id = ? AND id = ?').get(project.id, supersedes)) fail('invalid_record', 400, { index, problem: 'supersedes refers to a missing record', field: 'supersedes' });
        }
        const { supersedes: ignored, ...body } = record;
        const info = insert.run(project.id, who.owner, view, record.task_id ?? null, record.candidate ?? null, record.case_id ?? null, record.node ?? null,
          record.metric, record.value ?? null, record.unit ?? null, record.status, JSON.stringify(body), supersedes, now, by);
        ids.push(pubId('record', Number(info.lastInsertRowid)));
      });
      this.event(project, who, 'records', view + ':' + ids[0] + '..' + ids[ids.length - 1], view + ': ' + records.length + ' records');
      return { view, count: ids.length, ids };
    }, 'viewer');
  }
  records(owner, slug, view, query = {}) {
    const project = this.project(owner, slug);
    const where = ['r.project_id = @project', 'r.id > @since'], params = { project: project.id, since: cursor(query.since), limit: Math.min(1000, Math.max(1, Number(query.limit) || 500)) };
    if (view) { where.push('r.circuit = @view'); params.view = view; }
    for (const [field, column] of [['task', 'task_id'], ['metric', 'metric'], ['candidate', 'candidate'], ['status', 'status'], ['node', 'node'], ['case', 'case_id']]) {
      if (query[field] !== undefined && query[field] !== '') { where.push('r.' + column + ' = @' + field); params[field] = String(query[field]); }
    }
    if (query.current === '1' || query.current === 'true') where.push('NOT EXISTS (SELECT 1 FROM project_results n WHERE n.project_id = r.project_id AND n.supersedes = r.id)');
    const rows = this.db.prepare(`SELECT r.* FROM project_results r WHERE ${where.join(' AND ')} ORDER BY r.id LIMIT @limit`).all(params);
    return { records: rows.map(row => this.recordOut(row)), next: rows.length === params.limit ? pubId('record', rows[rows.length - 1].id) : null };
  }
  summary(owner, slug, view) {
    const project = this.project(owner, slug);
    const rows = this.db.prepare(`SELECT node, metric, case_id, status, MAX(id) id FROM project_results r
      WHERE project_id = ? AND circuit = ? AND node IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM project_results n WHERE n.project_id = r.project_id AND n.supersedes = r.id)
      GROUP BY node, metric, case_id`).all(project.id, view);
    const nodes = {};
    for (const row of rows) {
      const node = nodes[row.node] ||= { counts: {}, latest: 0 };
      node.counts[row.status] = (node.counts[row.status] || 0) + 1; node.latest = Math.max(node.latest, row.id);
    }
    for (const node of Object.values(nodes)) {
      const c = node.counts;
      node.state = c.FAIL ? 'FAIL' : c.NATIVE_FAILED || c.BLOCKED ? 'INCOMPLETE' : c.PASS ? 'PASS' : 'NO_LIMIT';
      node.latest = pubId('record', node.latest);
    }
    return { view, nodes };
  }

  // ─── Deleting records ─────────────────────────
  deleteRecord(who, slug, kind, id) {
    return this.write(who, slug, project => {
      let changes = 0;
      if (kind === 'tasks') changes = this.db.prepare('DELETE FROM project_tasks WHERE project_id = ? AND task_id = ?').run(project.id, id).changes;
      else if (kind === 'graphs') changes = this.db.prepare('DELETE FROM project_topologies WHERE project_id = ? AND circuit = ?').run(project.id, id).changes;
      else if (kind === 'status') changes = this.db.prepare('DELETE FROM project_status WHERE project_id = ? AND actor = ?').run(project.id, id).changes;
      else {
        const map = { messages: ['project_messages', 'message'], handoffs: ['project_handoffs', 'handoff'], decisions: ['project_decisions', 'decision'], records: ['project_results', 'record'] }[kind];
        if (!map) fail('not_found', 404);
        const number = parseId(map[1], id);
        if (kind === 'decisions' && who.kind !== 'user' && this.db.prepare("SELECT 1 FROM project_decisions WHERE project_id = ? AND id = ? AND kind = 'approve_task'").get(project.id, number)) fail('approval_required', 403);
        if (kind === 'handoffs') this.db.prepare('UPDATE project_handoffs SET supersedes = NULL WHERE project_id = ? AND supersedes = ?').run(project.id, number);
        if (kind === 'records') this.db.prepare('UPDATE project_results SET supersedes = NULL WHERE project_id = ? AND supersedes = ?').run(project.id, number);
        changes = this.db.prepare(`DELETE FROM ${map[0]} WHERE project_id = ? AND id = ?`).run(project.id, number).changes;
      }
      if (!changes) fail('not_found', 404);
      this.event(project, who, 'deleted', kind + ':' + id, (who.kind === 'user' ? 'USER' : who.actor) + ' deleted ' + kind + ' ' + id);
      return { ok: true };
    });
  }

  // ─── Events ───────────────────────────────────
  events(owner, slug, since) {
    const project = this.project(owner, slug);
    const after = cursor(since);
    const oldest = this.db.prepare('SELECT MIN(id) n FROM project_events WHERE project_id = ?').get(project.id).n;
    const rows = this.db.prepare('SELECT * FROM project_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?').all(project.id, after, LIMITS.events);
    const latest = this.db.prepare('SELECT COALESCE(MAX(id), 0) n FROM project_events WHERE project_id = ?').get(project.id).n;
    const reset = after > latest || (after > 0 && oldest !== null && after < oldest - 1);
    return {
      project, events: rows.map(row => ({ id: row.id, type: row.type, object: row.object_id, actor: row.actor, time: iso(row.time), summary: row.summary })),
      cursor: rows.length ? rows[rows.length - 1].id : Math.min(after, latest), latest, more: rows.length === LIMITS.events, reset,
    };
  }
  waitEvents(owner, slug, since, wait, signal) {
    const first = this.events(owner, slug, since);
    const seconds = wait === undefined || wait === '' ? 0 : Number(wait);
    if (!Number.isFinite(seconds) || seconds < 0) fail('invalid_wait');
    const strip = ({ project, ...rest }) => rest;
    if (first.events.length || first.reset || seconds === 0) return Promise.resolve(strip(first));
    const channel = first.project.owner_id + ':' + first.project.id;
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer); this.bus.off(channel, wake); signal?.removeEventListener?.('abort', finish);
        try { resolve(strip(this.events(owner, slug, since))); }
        catch { resolve({ events: [], cursor: cursor(since), latest: cursor(since), more: false, reset: false, deleted: true }); }
      };
      const wake = () => setImmediate(finish);
      const timer = setTimeout(finish, Math.min(seconds, LIMITS.wait) * 1000);
      this.bus.on(channel, wake);
      signal?.addEventListener?.('abort', finish);
    });
  }

  // ─── Idempotency ──────────────────────────────
  replay(keyId, idemKey, hash) {
    const row = this.db.prepare('SELECT * FROM project_idempotency WHERE key_id = ? AND idem_key = ? AND created_at > ?').get(keyId, idemKey, Date.now() - 86400000);
    if (!row) return null;
    if (row.request_hash !== hash) fail('idempotency_key_reused', 422);
    return { status: row.status, body: JSON.parse(row.response) };
  }
  remember(keyId, owner, idemKey, hash, status, body) {
    const now = Date.now();
    this.db.prepare('DELETE FROM project_idempotency WHERE created_at <= ?').run(now - 86400000);
    this.db.prepare(`INSERT INTO project_idempotency(key_id,idem_key,owner_id,request_hash,status,response,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(key_id, idem_key) DO UPDATE SET request_hash = excluded.request_hash, status = excluded.status, response = excluded.response, created_at = excluded.created_at`)
      .run(keyId, idemKey, owner, hash, status, JSON.stringify(body), now);
  }
  // Key order does not matter, so different clients sending the same content match.
  static requestHash(method, url, body) {
    const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
      : isObject(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value ?? null);
    return createHash('sha256').update(method + ' ' + url + '\n' + canonical(body)).digest('hex');
  }
}

module.exports = { ProjectStore, LIMITS, MODULES, DEFAULT_MODULES, MESSAGE_TYPES, TASK_STATUS, ROOT_FOLDER, SUBFOLDERS, AGENT };
