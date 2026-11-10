'use strict';
// Project collaboration: structured state shared by agents (SERVER, PC, ...) and
// the signed-in person (USER). Data lives in workspace.db next to the workspace
// tables. Every row carries owner_id and every query filters by it.
const { EventEmitter } = require('events');
const { createHash } = require('crypto');
const { ACTOR, RESERVED_ACTORS } = require('./agent-store');

const LIMITS = {
  projects: 20, message: 8000, memory: 64 * 1024, doc: 256 * 1024, topology: 512 * 1024, topologyNodes: 2000,
  resultBatch: 500, status: 16 * 1024, handoff: 64 * 1024, events: 200, eventsKept: 20000, wait: 25,
};
const MESSAGE_TYPES = ['info', 'question', 'answer', 'blocker', 'handoff_notice'];
const RESULT_STATUS = ['PASS', 'FAIL', 'NO_LIMIT', 'NATIVE_FAILED', 'BLOCKED'];
const TASK_STATUS = ['todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'];
const EVIDENCE = /^L[0-7]$/;
const REF_KINDS = ['handoff', 'result', 'topology', 'decision', 'message', 'task'];
const TOPOLOGY_KINDS = [
  'lnta', 'lna', 'mixer', 'tia', 'ppf', 'vga', 'driver', 'buffer', 'filter', 'sar_adc', 'adc', 'dac', 'comparator', 'pll', 'dco', 'vco',
  'divider', 'ldo', 'bandgap', 'digital', 'balun', 'switch', 'port', 'block', 'subckt', 'other',
  'nmos', 'pmos', 'res', 'cap', 'ind', 'mim', 'mom', 'vsrc', 'isrc', 'diode', 'bjt',
];
const EDGE_KINDS = ['signal', 'lo', 'supply', 'bias', 'clock', 'digital'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const NODE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const PREFIX = { message: 'msg', handoff: 'ho', decision: 'dec', result: 'res' };

function fail(code, status = 400, detail) { throw Object.assign(new Error(code), { status, ...(detail === undefined ? {} : { detail }) }); }
const iso = ms => ms === null || ms === undefined ? null : new Date(ms).toISOString();
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pubId = (kind, n) => PREFIX[kind] + '-' + n;
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
function recipient(value, code = 'invalid_recipient') {
  if (typeof value !== 'string' || !(ACTOR.test(value))) fail(code);
  return value;
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
  constructor(workspace, { guard, onEvent } = {}) {
    this.workspace = workspace; this.db = workspace.db; this.guard = guard; this.onEvent = onEvent || (() => {});
    this.bus = new EventEmitter(); this.bus.setMaxListeners(0);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
        switches TEXT NOT NULL DEFAULT '{}', switches_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, UNIQUE(owner_id, slug)
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
      CREATE TABLE IF NOT EXISTS project_texts (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        kind TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (project_id, kind, name)
      );
      CREATE TABLE IF NOT EXISTS project_text_history (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
        kind TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
        updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (project_id, kind, name, version)
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
    // Project text counts toward the same account quota as clipboard and chat text.
    workspace.extraTextBytes = owner => this.usedBytes(owner);
    (workspace.accountCleanup ||= []).push(owner => this.deleteOwner(owner));
  }

  // ─── Helpers ──────────────────────────────────
  usedBytes(owner) {
    const sum = (table, columns) => this.db.prepare(`SELECT COALESCE(SUM(${columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ')}), 0) AS n FROM ${table} WHERE owner_id = ?`).get(owner).n;
    return sum('projects', ['name', 'switches']) + sum('project_status', ['body']) + sum('project_tasks', ['title', 'owner_label', 'depends', 'done_when', 'deliver_to', 'notes'])
      + sum('project_messages', ['body', 'refs']) + sum('project_handoffs', ['body']) + sum('project_decisions', ['question', 'options', 'recommendation', 'answer'])
      + sum('project_texts', ['content']) + sum('project_text_history', ['content']) + sum('project_topologies', ['body']) + sum('project_results', ['body']);
  }
  quota(owner, additional) { this.workspace.enforceQuota(owner, additional); }
  scan(value) { if (this.guard) this.guard.check(value); }
  project(owner, slug) {
    const row = typeof slug === 'string' && SLUG.test(slug) && this.db.prepare('SELECT * FROM projects WHERE owner_id = ? AND slug = ?').get(owner, slug);
    if (!row) fail('project_not_found', 404);
    return row;
  }
  requireActor(who) {
    if (who.kind === 'user') return 'USER';
    if (!who.actor) fail('actor_required', 403);
    return who.actor;
  }
  requireUser(who) { if (who.kind !== 'user') fail('browser_session_required', 403); }
  event(project, who, type, objectId, summary) {
    const info = this.db.prepare('INSERT INTO project_events(project_id,owner_id,type,object_id,actor,time,summary) VALUES(?,?,?,?,?,?,?)')
      .run(project.id, project.owner_id, type, String(objectId), who.kind === 'user' ? 'USER' : who.actor || '?', Date.now(), String(summary).slice(0, 300));
    const id = Number(info.lastInsertRowid);
    if (id % 500 === 0) this.db.prepare('DELETE FROM project_events WHERE project_id = ? AND id <= ?').run(project.id, id - LIMITS.eventsKept);
    const payload = { project: project.slug, type, id: String(objectId), event: id };
    // Notify after the surrounding transaction commits.
    setImmediate(() => { this.bus.emit(project.owner_id + ':' + project.id, payload); this.onEvent(project.owner_id, payload); });
    return id;
  }
  withProject(owner, slug, work) { return this.db.transaction(() => work(this.project(owner, slug)))(); }

  // ─── Projects and switches ────────────────────
  list(owner) {
    return this.db.prepare('SELECT slug, name, created_at FROM projects WHERE owner_id = ? ORDER BY created_at').all(owner)
      .map(row => ({ id: row.slug, name: row.name, created_at: iso(row.created_at) }));
  }
  create(who, input) {
    this.requireUser(who);
    if (!isObject(input) || typeof input.id !== 'string' || !SLUG.test(input.id)) fail('invalid_project_id');
    const name = line(input.name ?? input.id, 120, 'invalid_project_name');
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) n FROM projects WHERE owner_id = ?').get(who.owner).n >= LIMITS.projects) fail('project_limit');
      if (this.db.prepare('SELECT 1 FROM projects WHERE owner_id = ? AND slug = ?').get(who.owner, input.id)) fail('project_exists', 409);
      this.quota(who.owner, bytes(name));
      const info = this.db.prepare('INSERT INTO projects(owner_id,slug,name,created_at) VALUES(?,?,?,?)').run(who.owner, input.id, name, Date.now());
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
      this.event(project, who, 'project', project.slug, 'project created');
      return { id: project.slug, name: project.name, created_at: iso(project.created_at) };
    })();
  }
  remove(who, slug) {
    this.requireUser(who);
    const project = this.project(who.owner, slug);
    this.db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(project.id, who.owner);
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
    const decisions = this.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(blocking), 0) b FROM project_decisions WHERE project_id = ? AND status = 'open'").get(project.id);
    const tasks = {};
    for (const row of this.db.prepare('SELECT status, COUNT(*) n FROM project_tasks WHERE project_id = ? GROUP BY status').all(project.id)) tasks[row.status] = row.n;
    return {
      project: { id: project.slug, name: project.name, created_at: iso(project.created_at) },
      switches: JSON.parse(project.switches), switches_version: project.switches_version, statuses,
      open_decisions: decisions.n, blocking_decisions: decisions.b, tasks,
      cursor: this.db.prepare('SELECT COALESCE(MAX(id), 0) n FROM project_events WHERE project_id = ?').get(project.id).n,
    };
  }
  setSwitches(who, slug, input) {
    this.requireUser(who);
    if (!isObject(input)) fail('invalid_switches');
    const switches = primitives(input.switches, 'invalid_switches', 100), expected = version(input.version);
    return this.withProject(who.owner, slug, project => {
      if (project.switches_version !== expected) fail('version_conflict', 409, { version: project.switches_version, current: JSON.parse(project.switches) });
      this.quota(who.owner, bytes(switches));
      this.db.prepare('UPDATE projects SET switches = ?, switches_version = switches_version + 1 WHERE id = ?').run(JSON.stringify(switches), project.id);
      this.event(project, who, 'switches', project.slug, 'switches updated');
      return { switches, switches_version: project.switches_version + 1 };
    });
  }

  // ─── Status ───────────────────────────────────
  statusOut(row) { return { actor: row.actor, status: JSON.parse(row.body), version: row.version, updated_at: iso(row.updated_at), updated_by: row.updated_by }; }
  statuses(owner, slug) {
    const project = this.project(owner, slug);
    return { statuses: this.db.prepare('SELECT * FROM project_status WHERE project_id = ? ORDER BY actor').all(project.id).map(row => this.statusOut(row)) };
  }
  setStatus(who, slug, actor, input) {
    const by = this.requireActor(who);
    if (typeof actor !== 'string' || !ACTOR.test(actor) || RESERVED_ACTORS.includes(actor)) fail('invalid_actor');
    if (who.kind !== 'user' && actor !== who.actor) fail('not_your_actor', 403);
    if (!isObject(input) || !isObject(input.status)) fail('invalid_status');
    const expected = version(input.version);
    if (bytes(input.status) > LIMITS.status) fail('status_too_large', 413);
    this.scan(input.status);
    return this.withProject(who.owner, slug, project => {
      const row = this.db.prepare('SELECT * FROM project_status WHERE project_id = ? AND actor = ?').get(project.id, actor);
      if ((row?.version || 0) !== expected) fail('version_conflict', 409, { version: row?.version || 0, current: row ? JSON.parse(row.body) : null });
      this.quota(who.owner, bytes(input.status) - (row ? bytes(row.body) : 0));
      const now = Date.now();
      this.db.prepare(`INSERT INTO project_status(project_id,owner_id,actor,body,version,updated_at,updated_by) VALUES(?,?,?,?,1,?,?)
        ON CONFLICT(project_id, actor) DO UPDATE SET body = excluded.body, version = version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(project.id, who.owner, actor, JSON.stringify(input.status), now, by);
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
      if (!Array.isArray(input.owners) || input.owners.length > 10 || input.owners.some(actor => typeof actor !== 'string' || !ACTOR.test(actor))) fail('invalid_task');
      out.owners = JSON.stringify([...new Set(input.owners)]);
    }
    for (const field of ['owner_label', 'depends', 'deliver_to']) if (input[field] !== undefined) out[field] = line(input[field], 500, 'invalid_task', { allowEmpty: true });
    if (input.done_when !== undefined) out.done_when = text(input.done_when, 4000, 'invalid_task', { allowEmpty: true });
    if (input.notes !== undefined) out.notes = text(input.notes, 8000, 'invalid_task', { allowEmpty: true });
    if (input.status !== undefined) { if (!TASK_STATUS.includes(input.status)) fail('invalid_task_status'); out.status = input.status; }
    return out;
  }
  updateTask(who, slug, id, input) {
    const by = this.requireActor(who);
    if (!isObject(input)) fail('invalid_task');
    const expected = version(input.version);
    const allowed = who.kind === 'user' ? null : ['status', 'notes'];
    const changes = Object.keys(input).filter(key => key !== 'version');
    if (allowed && changes.some(key => !allowed.includes(key))) fail('field_not_allowed', 403, { allowed });
    const fields = this.taskFields(input, true);
    if (!Object.keys(fields).length) fail('invalid_task');
    this.scan(fields);
    return this.withProject(who.owner, slug, project => {
      const row = this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, id);
      if (!row) fail('task_not_found', 404);
      if (who.kind !== 'user' && !JSON.parse(row.owners).includes(who.actor)) fail('not_task_owner', 403);
      if (row.version !== expected) fail('version_conflict', 409, { version: row.version, current: this.taskOut(row) });
      this.quota(who.owner, bytes(fields));
      const sets = Object.keys(fields).map(key => key + ' = @' + key).join(', ');
      this.db.prepare(`UPDATE project_tasks SET ${sets}, version = version + 1, updated_at = @now, updated_by = @by WHERE project_id = @project AND task_id = @id`)
        .run({ ...fields, now: Date.now(), by, project: project.id, id });
      this.event(project, who, 'task', id, id + (fields.status ? ' → ' + fields.status : ' updated'));
      return this.taskOut(this.db.prepare('SELECT * FROM project_tasks WHERE project_id = ? AND task_id = ?').get(project.id, id));
    });
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
    return this.withProject(who.owner, slug, project => {
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
    });
  }

  // ─── Messages ─────────────────────────────────
  messageOut(row) {
    return { id: pubId('message', row.id), from: row.sender, to: row.recipient, thread: row.thread, task_id: row.task_id, type: row.type,
      body: row.body, refs: JSON.parse(row.refs), created_at: iso(row.created_at) };
  }
  refs(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 20 || value.some(ref => !isObject(ref) || !REF_KINDS.includes(ref.kind) || typeof ref.id !== 'string' || !ref.id || ref.id.length > 100)) fail('invalid_refs');
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
    const from = this.requireActor(who);
    if (!isObject(input)) fail('invalid_message');
    const to = recipient(input.to ?? 'ALL');
    const type = input.type ?? 'info';
    if (!MESSAGE_TYPES.includes(type)) fail('invalid_message_type');
    const body = text(input.body, LIMITS.message, 'invalid_message');
    const taskId = input.task_id === undefined || input.task_id === null || input.task_id === '' ? null : input.task_id;
    if (taskId !== null && (typeof taskId !== 'string' || !TASK_ID.test(taskId))) fail('invalid_task_id');
    const refs = this.refs(input.refs);
    this.scan({ body, refs });
    return this.withProject(who.owner, slug, project => {
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
    });
  }

  // ─── Handoffs (append-only) ───────────────────
  handoffOut(row) {
    return { id: pubId('handoff', row.id), from: row.sender, ...JSON.parse(row.body), supersedes: row.supersedes ? pubId('handoff', row.supersedes) : null,
      superseded_by: row.superseded_by ? pubId('handoff', row.superseded_by) : null, created_at: iso(row.created_at) };
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
    const row = this.db.prepare(`SELECT h.*, (SELECT MAX(n.id) FROM project_handoffs n WHERE n.project_id = h.project_id AND n.supersedes = h.id) superseded_by
      FROM project_handoffs h WHERE h.project_id = ? AND h.id = ?`).get(project.id, parseId('handoff', id));
    if (!row) fail('not_found', 404);
    return this.handoffOut(row);
  }
  addHandoff(who, slug, input) {
    const from = this.requireActor(who);
    if (!isObject(input)) fail('invalid_handoff');
    if (typeof input.task_id !== 'string' || !TASK_ID.test(input.task_id)) fail('invalid_task_id');
    const to = recipient(input.to);
    if (!RESULT_STATUS.includes(input.status)) fail('invalid_handoff_status');
    const body = {
      task_id: input.task_id, to, status: input.status, summary: text(input.summary, 2000, 'invalid_handoff'),
      conditions: primitives(input.conditions, 'invalid_conditions'),
      evidence_level: input.evidence_level ?? null, files: [], limitations: [], next_action: text(input.next_action ?? '', 4000, 'invalid_handoff', { allowEmpty: true }),
    };
    if (body.evidence_level !== null && (typeof body.evidence_level !== 'string' || !EVIDENCE.test(body.evidence_level))) fail('invalid_evidence_level');
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
    return this.withProject(who.owner, slug, project => {
      let supersedes = null;
      if (input.supersedes !== undefined && input.supersedes !== null) {
        supersedes = parseId('handoff', input.supersedes, 'invalid_supersedes', 400);
        if (!this.db.prepare('SELECT 1 FROM project_handoffs WHERE project_id = ? AND id = ?').get(project.id, supersedes)) fail('supersedes_not_found', 404);
      }
      this.quota(who.owner, bytes(body));
      const info = this.db.prepare('INSERT INTO project_handoffs(project_id,owner_id,sender,recipient,task_id,status,body,supersedes,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, from, to, body.task_id, body.status, JSON.stringify(body), supersedes, Date.now());
      const id = Number(info.lastInsertRowid);
      this.event(project, who, 'handoff', pubId('handoff', id), from + ' → ' + to + ': ' + body.task_id + ' ' + body.status);
      return this.handoff(who.owner, slug, pubId('handoff', id));
    });
  }

  // ─── Decisions ────────────────────────────────
  decisionOut(row) {
    return { id: pubId('decision', row.id), raised_by: row.raised_by, task_id: row.task_id, question: row.question, options: JSON.parse(row.options),
      recommendation: row.recommendation, blocking: !!row.blocking, status: row.status, answer: row.answer, answered_at: iso(row.answered_at), created_at: iso(row.created_at) };
  }
  decisions(owner, slug, query = {}) {
    const project = this.project(owner, slug);
    const params = { project: project.id }; let where = 'project_id = @project';
    if (query.status) { if (!['open', 'answered'].includes(query.status)) fail('invalid_status_filter'); where += ' AND status = @status'; params.status = query.status; }
    if (query.task) { where += ' AND task_id = @task'; params.task = String(query.task); }
    return { decisions: this.db.prepare(`SELECT * FROM project_decisions WHERE ${where} ORDER BY blocking DESC, id DESC LIMIT 500`).all(params).map(row => this.decisionOut(row)) };
  }
  decision(owner, slug, id) {
    const project = this.project(owner, slug);
    const row = this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND id = ?').get(project.id, parseId('decision', id));
    if (!row) fail('not_found', 404);
    return this.decisionOut(row);
  }
  raiseDecision(who, slug, input) {
    const by = this.requireActor(who);
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
    return this.withProject(who.owner, slug, project => {
      this.quota(who.owner, bytes(question) + bytes(options) + bytes(recommendation));
      const info = this.db.prepare('INSERT INTO project_decisions(project_id,owner_id,raised_by,task_id,question,options,recommendation,blocking,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, by, taskId, question, JSON.stringify(options), recommendation, input.blocking ? 1 : 0, Date.now());
      const id = pubId('decision', Number(info.lastInsertRowid));
      this.event(project, who, 'decision', id, by + ' asks' + (input.blocking ? ' (blocking)' : '') + (taskId ? ' [' + taskId + ']' : ''));
      return this.decision(who.owner, slug, id);
    });
  }
  answerDecision(who, slug, id, input) {
    this.requireUser(who);
    if (!isObject(input)) fail('invalid_answer');
    const answer = text(input.answer, 8000, 'invalid_answer');
    this.scan(answer);
    return this.withProject(who.owner, slug, project => {
      const row = this.db.prepare('SELECT * FROM project_decisions WHERE project_id = ? AND id = ?').get(project.id, parseId('decision', id));
      if (!row) fail('not_found', 404);
      this.quota(who.owner, bytes(answer));
      this.db.prepare("UPDATE project_decisions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, Date.now(), row.id);
      this.event(project, who, 'decision', pubId('decision', row.id), 'USER answered');
      return this.decision(who.owner, slug, pubId('decision', row.id));
    });
  }

  // ─── Documents and memory (versioned text) ────
  textOut(row, kind) { return { [kind === 'memory' ? 'actor' : 'name']: row.name, content: row.content, version: row.version, updated_at: iso(row.updated_at), updated_by: row.updated_by }; }
  texts(owner, slug, kind) {
    const project = this.project(owner, slug);
    return { [kind === 'memory' ? 'memories' : 'docs']: this.db.prepare('SELECT name, version, updated_at, updated_by, length(CAST(content AS BLOB)) size FROM project_texts WHERE project_id = ? AND kind = ? ORDER BY name').all(project.id, kind)
      .map(row => ({ [kind === 'memory' ? 'actor' : 'name']: row.name, version: row.version, size: row.size, updated_at: iso(row.updated_at), updated_by: row.updated_by })) };
  }
  textName(kind, name) {
    if (typeof name !== 'string' || !(kind === 'memory' ? ACTOR.test(name) && !RESERVED_ACTORS.includes(name) : NAME.test(name))) fail(kind === 'memory' ? 'invalid_actor' : 'invalid_doc_name');
    return name;
  }
  getText(owner, slug, kind, name, requestedVersion) {
    const project = this.project(owner, slug); this.textName(kind, name);
    if (requestedVersion !== undefined && requestedVersion !== '') {
      const number = Number(requestedVersion);
      if (!Number.isSafeInteger(number) || number < 1) fail('invalid_version');
      const row = this.db.prepare('SELECT * FROM project_text_history WHERE project_id = ? AND kind = ? AND name = ? AND version = ?').get(project.id, kind, name, number);
      if (!row) fail('not_found', 404);
      return this.textOut(row, kind);
    }
    const row = this.db.prepare('SELECT * FROM project_texts WHERE project_id = ? AND kind = ? AND name = ?').get(project.id, kind, name);
    if (!row) fail('not_found', 404);
    return this.textOut(row, kind);
  }
  textHistory(owner, slug, kind, name) {
    const project = this.project(owner, slug); this.textName(kind, name);
    return { history: this.db.prepare('SELECT version, updated_at, updated_by, length(CAST(content AS BLOB)) size FROM project_text_history WHERE project_id = ? AND kind = ? AND name = ? ORDER BY version DESC LIMIT 200')
      .all(project.id, kind, name).map(row => ({ ...row, updated_at: iso(row.updated_at) })) };
  }
  putText(who, slug, kind, name, input) {
    const by = this.requireActor(who); this.textName(kind, name);
    if (who.kind !== 'user') {
      if (kind === 'memory' && name !== who.actor) fail('not_your_actor', 403);
      if (kind === 'doc' && name !== 'WORKFLOW_' + who.actor && name !== 'WORKFLOW_' + who.actor + '.md') fail('doc_write_forbidden', 403);
    }
    if (!isObject(input)) fail('invalid_document');
    const content = text(input.content, Number.MAX_SAFE_INTEGER, 'invalid_document', { allowEmpty: true });
    if (bytes(content) > (kind === 'memory' ? LIMITS.memory : LIMITS.doc)) fail(kind === 'memory' ? 'memory_too_large' : 'document_too_large', 413);
    const expected = version(input.version);
    this.scan(content);
    return this.withProject(who.owner, slug, project => {
      const row = this.db.prepare('SELECT * FROM project_texts WHERE project_id = ? AND kind = ? AND name = ?').get(project.id, kind, name);
      if ((row?.version || 0) !== expected) fail('version_conflict', 409, { version: row?.version || 0, current: row ? row.content : null });
      this.quota(who.owner, bytes(content) * 2);
      const now = Date.now(), next = (row?.version || 0) + 1;
      this.db.prepare(`INSERT INTO project_texts(project_id,owner_id,kind,name,content,version,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, kind, name) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(project.id, who.owner, kind, name, content, next, now, by);
      this.db.prepare('INSERT INTO project_text_history(project_id,owner_id,kind,name,version,content,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, kind, name, next, content, now, by);
      this.event(project, who, kind, name, name + ' v' + next);
      return this.textOut(this.db.prepare('SELECT * FROM project_texts WHERE project_id = ? AND kind = ? AND name = ?').get(project.id, kind, name), kind);
    });
  }

  // ─── Circuit topology ─────────────────────────
  validateTopology(circuit, input) {
    if (!isObject(input)) fail('invalid_topology');
    if (bytes(input) > LIMITS.topology) fail('topology_too_large', 413);
    const problem = (message, path) => fail('invalid_topology', 400, { problem: message, path });
    if (input.schema !== 'circuit-topology/v1') problem('schema must be circuit-topology/v1', 'schema');
    if (input.circuit !== undefined && input.circuit !== circuit) problem('circuit does not match the URL', 'circuit');
    if (!['block', 'device'].includes(input.level)) problem('level must be block or device', 'level');
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
    if (input.nodes.length > LIMITS.topologyNodes) fail('topology_too_large', 413, { problem: 'at most ' + LIMITS.topologyNodes + ' nodes' });
    const nodeIds = new Set();
    input.nodes.forEach((node, index) => {
      const at = 'nodes[' + index + ']';
      if (!isObject(node) || typeof node.id !== 'string' || !NODE_ID.test(node.id)) problem('node id must be an identifier', at + '.id');
      if (nodeIds.has(node.id)) problem('duplicate node id ' + node.id, at + '.id');
      nodeIds.add(node.id);
      if (!TOPOLOGY_KINDS.includes(node.kind)) problem('kind ' + String(node.kind).slice(0, 40) + ' is not allowed', at + '.kind');
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
    if (!Array.isArray(edges) || edges.length > LIMITS.topologyNodes * 4) problem('edges must be an array', 'edges');
    edges.forEach((edge, index) => {
      const at = 'edges[' + index + ']';
      if (!isObject(edge)) problem('edge must be an object', at);
      for (const end of ['from', 'to']) {
        if (typeof edge[end] !== 'string' || edge[end].length > 130) problem(end + ' must be NODE or NODE.port', at + '.' + end);
        const node = edge[end].includes('.') && !nodeIds.has(edge[end]) ? edge[end].slice(0, edge[end].lastIndexOf('.')) : edge[end];
        if (!nodeIds.has(node)) problem(end + ' refers to a missing node', at + '.' + end);
      }
      if (edge.kind !== undefined && !EDGE_KINDS.includes(edge.kind)) problem('edge kind is not allowed', at + '.kind');
      if (edge.net !== undefined && (typeof edge.net !== 'string' || edge.net.length > 200)) problem('net must be a string', at + '.net');
    });
    if (input.source !== undefined && input.source !== null) primitives(input.source, 'invalid_topology');
    if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== 'string' || input.notes.length > 20000)) problem('notes must be a string', 'notes');
    return { ...input, circuit };
  }
  circuits(owner, slug) {
    const project = this.project(owner, slug);
    const rows = this.db.prepare(`SELECT t.circuit, t.version, t.candidate, t.level, t.node_count, t.created_at, t.created_by,
      (SELECT COUNT(*) FROM project_results r WHERE r.project_id = t.project_id AND r.circuit = t.circuit) results
      FROM project_topologies t WHERE t.project_id = ? AND t.version = (SELECT MAX(version) FROM project_topologies x WHERE x.project_id = t.project_id AND x.circuit = t.circuit)
      ORDER BY t.circuit`).all(project.id);
    const known = new Set(rows.map(row => row.circuit));
    const extra = this.db.prepare('SELECT circuit, COUNT(*) results FROM project_results WHERE project_id = ? GROUP BY circuit').all(project.id).filter(row => !known.has(row.circuit));
    return { circuits: [...rows.map(row => ({ circuit: row.circuit, latest_version: row.version, candidate: row.candidate, level: row.level, nodes: row.node_count,
      results: row.results, updated_at: iso(row.created_at), updated_by: row.created_by })), ...extra.map(row => ({ circuit: row.circuit, latest_version: null, results: row.results }))] };
  }
  topologyVersions(owner, slug, circuit) {
    const project = this.project(owner, slug);
    return { versions: this.db.prepare('SELECT version, candidate, level, node_count, created_at, created_by FROM project_topologies WHERE project_id = ? AND circuit = ? ORDER BY version DESC')
      .all(project.id, circuit).map(row => ({ ...row, nodes: row.node_count, node_count: undefined, created_at: iso(row.created_at) })) };
  }
  topology(owner, slug, circuit, requested) {
    const project = this.project(owner, slug);
    const row = requested !== undefined && requested !== ''
      ? this.db.prepare('SELECT * FROM project_topologies WHERE project_id = ? AND circuit = ? AND version = ?').get(project.id, circuit, Number(requested))
      : this.db.prepare('SELECT * FROM project_topologies WHERE project_id = ? AND circuit = ? ORDER BY version DESC LIMIT 1').get(project.id, circuit);
    if (!row) fail('not_found', 404);
    return { circuit, version: row.version, created_at: iso(row.created_at), created_by: row.created_by, topology: JSON.parse(row.body) };
  }
  putTopology(who, slug, circuit, input) {
    const by = this.requireActor(who);
    if (typeof circuit !== 'string' || !NAME.test(circuit)) fail('invalid_circuit');
    const topology = this.validateTopology(circuit, input);
    this.scan(topology);
    return this.withProject(who.owner, slug, project => {
      this.quota(who.owner, bytes(topology));
      const next = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 n FROM project_topologies WHERE project_id = ? AND circuit = ?').get(project.id, circuit).n;
      this.db.prepare('INSERT INTO project_topologies(project_id,owner_id,circuit,version,candidate,level,body,node_count,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(project.id, who.owner, circuit, next, topology.candidate ?? null, topology.level, JSON.stringify(topology), topology.nodes.length, Date.now(), by);
      this.event(project, who, 'topology', circuit + '@' + next, circuit + ' topology v' + next + ' (' + topology.nodes.length + ' nodes)');
      return { circuit, version: next, nodes: topology.nodes.length };
    });
  }

  // ─── Circuit results (append-only) ────────────
  validateResult(input, index) {
    const problem = (message, field) => fail('invalid_result', 400, { index, problem: message, field });
    if (!isObject(input)) problem('result must be an object');
    if (input.schema !== 'circuit-result/v1') problem('schema must be circuit-result/v1', 'schema');
    if (!RESULT_STATUS.includes(input.status)) problem('status must be one of ' + RESULT_STATUS.join(', '), 'status');
    if (typeof input.metric !== 'string' || !/^[A-Za-z0-9_.:/%()-]{1,64}$/.test(input.metric)) problem('metric must be an identifier', 'metric');
    const hasValue = input.value !== undefined && input.value !== null;
    if (['NATIVE_FAILED', 'BLOCKED'].includes(input.status)) { if (hasValue) problem(input.status + ' must not carry a value', 'value'); }
    else if (typeof input.value !== 'number' || !Number.isFinite(input.value)) problem('value must be a finite number', 'value');
    if (input.evidence_level !== undefined && input.evidence_level !== null && (typeof input.evidence_level !== 'string' || !EVIDENCE.test(input.evidence_level))) problem('evidence_level must be L0–L7', 'evidence_level');
    for (const field of ['candidate', 'case_id', 'unit']) if (input[field] !== undefined && input[field] !== null && (typeof input[field] !== 'string' || input[field].length > 200)) problem(field + ' must be a string', field);
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
    if (bytes(input) > 16 * 1024) problem('result is too large');
    return input;
  }
  resultOut(row) {
    return { id: pubId('result', row.id), circuit: row.circuit, ...JSON.parse(row.body), supersedes: row.supersedes ? pubId('result', row.supersedes) : null,
      created_at: iso(row.created_at), created_by: row.created_by };
  }
  addResults(who, slug, circuit, input) {
    const by = this.requireActor(who);
    if (typeof circuit !== 'string' || !NAME.test(circuit)) fail('invalid_circuit');
    const list = Array.isArray(input) ? input : input?.results;
    if (!Array.isArray(list) || !list.length) fail('invalid_result');
    if (list.length > LIMITS.resultBatch) fail('too_many_results', 413, { max: LIMITS.resultBatch });
    const results = list.map((result, index) => this.validateResult(result, index));
    this.scan(results.map(({ supersedes, ...rest }) => rest));
    return this.withProject(who.owner, slug, project => {
      this.quota(who.owner, bytes(results));
      const now = Date.now(), ids = [];
      const insert = this.db.prepare(`INSERT INTO project_results(project_id,owner_id,circuit,task_id,candidate,case_id,node,metric,value,unit,status,body,supersedes,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      results.forEach((result, index) => {
        let supersedes = null;
        if (result.supersedes !== undefined && result.supersedes !== null) {
          supersedes = parseId('result', result.supersedes, 'invalid_result', 400);
          if (!this.db.prepare('SELECT 1 FROM project_results WHERE project_id = ? AND id = ?').get(project.id, supersedes)) fail('invalid_result', 400, { index, problem: 'supersedes refers to a missing result', field: 'supersedes' });
        }
        const { supersedes: ignored, ...body } = result;
        const info = insert.run(project.id, who.owner, circuit, result.task_id ?? null, result.candidate ?? null, result.case_id ?? null, result.node ?? null,
          result.metric, result.value ?? null, result.unit ?? null, result.status, JSON.stringify(body), supersedes, now, by);
        ids.push(pubId('result', Number(info.lastInsertRowid)));
      });
      const counts = {}; for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
      this.event(project, who, 'results', circuit + ':' + ids[0] + '..' + ids[ids.length - 1], circuit + ': ' + results.length + ' results ' + JSON.stringify(counts).replace(/["{}]/g, ''));
      return { circuit, count: ids.length, ids };
    });
  }
  results(owner, slug, circuit, query = {}) {
    const project = this.project(owner, slug);
    const where = ['r.project_id = @project', 'r.id > @since'], params = { project: project.id, since: cursor(query.since), limit: Math.min(1000, Math.max(1, Number(query.limit) || 500)) };
    if (circuit) { where.push('r.circuit = @circuit'); params.circuit = circuit; }
    for (const [field, column] of [['task', 'task_id'], ['metric', 'metric'], ['candidate', 'candidate'], ['status', 'status'], ['node', 'node'], ['case', 'case_id']]) {
      if (query[field] !== undefined && query[field] !== '') { where.push('r.' + column + ' = @' + field); params[field] = String(query[field]); }
    }
    if (query.current === '1' || query.current === 'true') where.push('NOT EXISTS (SELECT 1 FROM project_results n WHERE n.project_id = r.project_id AND n.supersedes = r.id)');
    const rows = this.db.prepare(`SELECT r.* FROM project_results r WHERE ${where.join(' AND ')} ORDER BY r.id LIMIT @limit`).all(params);
    return { results: rows.map(row => this.resultOut(row)), next: rows.length === params.limit ? pubId('result', rows[rows.length - 1].id) : null };
  }
  // Latest current result per (node, metric, case) decides each node's badge.
  summary(owner, slug, circuit) {
    const project = this.project(owner, slug);
    const rows = this.db.prepare(`SELECT node, metric, case_id, status, MAX(id) id FROM project_results r
      WHERE project_id = ? AND circuit = ? AND node IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM project_results n WHERE n.project_id = r.project_id AND n.supersedes = r.id)
      GROUP BY node, metric, case_id`).all(project.id, circuit);
    const nodes = {};
    for (const row of rows) {
      const node = nodes[row.node] ||= { PASS: 0, FAIL: 0, NO_LIMIT: 0, NATIVE_FAILED: 0, BLOCKED: 0, latest: 0 };
      node[row.status]++; node.latest = Math.max(node.latest, row.id);
    }
    for (const node of Object.values(nodes)) {
      node.state = node.FAIL ? 'FAIL' : node.NATIVE_FAILED || node.BLOCKED ? 'INCOMPLETE' : node.PASS ? 'PASS' : 'NO_LIMIT';
      node.latest = pubId('result', node.latest);
    }
    return { circuit, nodes };
  }

  // ─── Deletion (browser only) ──────────────────
  deleteRecord(who, slug, kind, id) {
    this.requireUser(who);
    return this.withProject(who.owner, slug, project => {
      let changes = 0;
      if (kind === 'tasks') changes = this.db.prepare('DELETE FROM project_tasks WHERE project_id = ? AND task_id = ?').run(project.id, id).changes;
      else if (kind === 'topologies') changes = this.db.prepare('DELETE FROM project_topologies WHERE project_id = ? AND circuit = ?').run(project.id, id).changes;
      else if (kind === 'docs' || kind === 'memory') {
        const textKind = kind === 'docs' ? 'doc' : 'memory';
        changes = this.db.prepare('DELETE FROM project_texts WHERE project_id = ? AND kind = ? AND name = ?').run(project.id, textKind, id).changes;
        this.db.prepare('DELETE FROM project_text_history WHERE project_id = ? AND kind = ? AND name = ?').run(project.id, textKind, id);
      } else {
        const map = { messages: ['project_messages', 'message'], handoffs: ['project_handoffs', 'handoff'], decisions: ['project_decisions', 'decision'], results: ['project_results', 'result'] }[kind];
        if (!map) fail('not_found', 404);
        const number = parseId(map[1], id);
        if (kind === 'handoffs') this.db.prepare('UPDATE project_handoffs SET supersedes = NULL WHERE project_id = ? AND supersedes = ?').run(project.id, number);
        if (kind === 'results') this.db.prepare('UPDATE project_results SET supersedes = NULL WHERE project_id = ? AND supersedes = ?').run(project.id, number);
        changes = this.db.prepare(`DELETE FROM ${map[0]} WHERE project_id = ? AND id = ?`).run(project.id, number).changes;
      }
      if (!changes) fail('not_found', 404);
      this.event(project, who, 'deleted', kind + ':' + id, 'USER deleted ' + kind + ' ' + id);
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
    // reset: the cursor is older than the retained log or newer than anything stored
    // (e.g. after a restore). The client should re-read state and continue from `cursor`.
    const reset = after > latest || (after > 0 && oldest !== null && after < oldest - 1);
    return {
      project, events: rows.map(row => ({ id: row.id, type: row.type, object: row.object_id, actor: row.actor, time: iso(row.time), summary: row.summary })),
      cursor: rows.length ? rows[rows.length - 1].id : Math.min(after, latest), latest, more: rows.length === LIMITS.events, reset,
    };
  }
  // Resolves with events after `since`, waiting up to `wait` seconds when there are none.
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
  static requestHash(method, path, body) {
    const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
      : isObject(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value ?? null);
    return createHash('sha256').update(method + ' ' + path + '\n' + canonical(body)).digest('hex');
  }
}

module.exports = { ProjectStore, LIMITS, MESSAGE_TYPES, RESULT_STATUS, TASK_STATUS, TOPOLOGY_KINDS, EDGE_KINDS };
