'use strict';
// Project collaboration routes. The same router serves the Agent API
// (/api/v1/projects, Bearer key) and the browser (/api/projects, session).
// Agents name themselves with the X-Agent-Name header (or the key's default
// name); the owner in the browser is USER.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { ProjectStore } = require('./project-store');

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

function createProjectRouter({ projects, keys, receiveFiles, uploadsDir }) {
  const router = express.Router();
  const fail = (code, status) => { throw Object.assign(new Error(code), { status }); };
  const principal = req => req.agent
    ? { kind: 'agent', owner: req.agent.owner_id, actor: (req.get('X-Agent-Name') || '').trim() || req.agent.actor || null, keyId: req.agent.id }
    : { kind: 'user', owner: req.session.userId, actor: 'USER' };
  const need = (req, scope) => { if (req.agent) keys.authorizeId(req.agent.id, scope); };
  const target = (req, ...parts) => { req.agentTarget = [req.params.project, ...parts].filter(Boolean).join('/'); };
  const body = req => req.body ?? {};
  const P = req => req.params.project;

  const read = handler => (req, res, next) => {
    try { need(req, 'project:read'); target(req); res.json(handler(req, principal(req))); }
    catch (error) { next(error); }
  };
  // Writes run in one transaction with the idempotency record, so a retried
  // request either replays the stored response or performs the write once.
  const write = (handler, okStatus = 200) => (req, res, next) => {
    try {
      need(req, 'project:write');
      const who = principal(req), idem = req.get('Idempotency-Key');
      let hash = null;
      if (idem !== undefined && who.kind === 'agent') {
        if (!IDEMPOTENCY_KEY.test(idem)) fail('invalid_idempotency_key', 400);
        hash = ProjectStore.requestHash(req.method, req.baseUrl + req.path + '?' + new URLSearchParams(req.query), req.body);
        const cached = projects.replay(who.keyId, idem, hash);
        if (cached) { target(req, 'replay'); res.set('Idempotent-Replayed', 'true'); return res.status(cached.status).json(cached.body); }
      }
      const result = projects.db.transaction(() => {
        const value = handler(req, who);
        if (hash) projects.remember(who.keyId, who.owner, idem, hash, okStatus, value);
        return value;
      })();
      res.status(okStatus).json(result);
    } catch (error) { next(error); }
  };
  const confirm = (req, res, next) => req.body?.confirm === true ? next() : res.status(400).json({ error: 'confirmation_required' });

  // Projects, overview, modules
  router.get('/', read((req, who) => ({ projects: projects.list(who.owner) })));
  router.post('/', write((req, who) => projects.create(who, body(req)), 201));
  router.delete('/:project', confirm, write((req, who) => { projects.remove(who, P(req), req.body.deleteFiles === true); return { ok: true }; }));
  router.get('/:project/state', read((req, who) => projects.state(who.owner, P(req))));
  router.put('/:project/modules', write((req, who) => projects.setModules(who, P(req), body(req))));
  router.put('/:project/summary', write((req, who) => projects.setSummary(who, P(req), body(req))));
  router.put('/:project/switches', write((req, who) => projects.setSwitches(who, P(req), body(req))));

  // Members and status
  router.get('/:project/members', read((req, who) => projects.members(who.owner, P(req))));
  router.put('/:project/members/:name', write((req, who) => { target(req, 'members', req.params.name); return projects.putMember(who, P(req), req.params.name, body(req)); }));
  router.delete('/:project/members/:name', confirm, write((req, who) => projects.removeMember(who, P(req), req.params.name)));
  router.get('/:project/status', read((req, who) => projects.statuses(who.owner, P(req))));
  router.put('/:project/status/:actor', write((req, who) => { target(req, 'status', req.params.actor); return projects.setStatus(who, P(req), req.params.actor, body(req)); }));

  // Tasks
  router.get('/:project/tasks', read((req, who) => projects.tasks(who.owner, P(req), req.query)));
  router.post('/:project/tasks', write((req, who) => { const task = projects.createTask(who, P(req), body(req)); target(req, 'tasks', task.id); return task; }, 201));
  router.post('/:project/tasks/import', write((req, who) => projects.importTasks(who, P(req), body(req))));
  router.get('/:project/tasks/:id', read((req, who) => projects.task(who.owner, P(req), req.params.id)));
  router.patch('/:project/tasks/:id', write((req, who) => { target(req, 'tasks', req.params.id); return projects.updateTask(who, P(req), req.params.id, body(req)); }));

  // Messages, handoffs, decisions
  router.get('/:project/messages', read((req, who) => projects.messages(who.owner, P(req), req.query)));
  router.post('/:project/messages', write((req, who) => { const message = projects.postMessage(who, P(req), body(req)); target(req, message.id); return message; }, 201));
  router.patch('/:project/messages/:id', write((req, who) => { target(req, req.params.id); return projects.editMessage(who, P(req), req.params.id, body(req)); }));
  router.get('/:project/handoffs', read((req, who) => projects.handoffs(who.owner, P(req), req.query)));
  router.post('/:project/handoffs', write((req, who) => { const handoff = projects.addHandoff(who, P(req), body(req)); target(req, handoff.id); return handoff; }, 201));
  router.get('/:project/handoffs/:id', read((req, who) => projects.handoff(who.owner, P(req), req.params.id)));
  router.put('/:project/handoffs/:id', write((req, who) => { target(req, req.params.id); return projects.editHandoff(who, P(req), req.params.id, body(req)); }));
  router.get('/:project/decisions', read((req, who) => projects.decisions(who.owner, P(req), req.query)));
  router.post('/:project/decisions', write((req, who) => { const decision = projects.raiseDecision(who, P(req), body(req)); target(req, decision.id); return decision; }, 201));
  router.get('/:project/decisions/:id', read((req, who) => projects.decision(who.owner, P(req), req.params.id)));
  router.patch('/:project/decisions/:id', write((req, who) => { target(req, req.params.id); return projects.editDecision(who, P(req), req.params.id, body(req)); }));
  router.post('/:project/decisions/:id/answer', write((req, who) => projects.answerDecision(who, P(req), req.params.id, body(req))));

  // Project folder (also visible in the drive)
  router.get('/:project/files', read((req, who) => projects.listFiles(who.owner, P(req), req.query.path, req.query.recursive === '1' || req.query.recursive === 'true')));
  router.get('/:project/files/content', read((req, who) => { target(req, 'files', req.query.path); return projects.readFile(who.owner, P(req), req.query.path); }));
  router.put('/:project/files/content', write((req, who) => { target(req, 'files', req.body?.path); return projects.writeFile(who, P(req), body(req)); }));
  router.get('/:project/files/raw', (req, res, next) => {
    try {
      need(req, 'project:read'); target(req, 'files', req.query.path);
      const asset = projects.fileAsset(principal(req).owner, P(req), req.query.path);
      if (path.basename(asset.name) !== asset.name) fail('not_found', 404);
      res.download(path.join(uploadsDir, asset.name), asset.original_name, error => { if (error && !res.headersSent) next(Object.assign(new Error('not_found'), { status: 404 })); });
    } catch (error) { next(error); }
  });
  router.post('/:project/files/upload', async (req, res, next) => {
    let files = [];
    try {
      need(req, 'project:write');
      const who = principal(req);
      projects.project(who.owner, P(req)); projects.actorOf(who);
      files = await receiveFiles(req, res);
      if (!files.length) fail('no_files', 400);
      if (req.agent) keys.authorizeId(req.agent.id, 'project:write'); // recheck after a long upload
      target(req, 'files', req.query.path || '/');
      const result = projects.addFiles(who, P(req), req.query.path || '', files);
      files = [];
      res.status(201).json(result);
    } catch (error) {
      for (const file of files) fs.rmSync(file.path, { force: true });
      next(error);
    }
  });
  router.delete('/:project/files', confirm, write((req, who) => { target(req, 'files', req.body.path); return projects.deleteFile(who, P(req), req.body.path); }));

  // Viewer: graphs (versioned) and records
  router.get('/:project/views', read((req, who) => projects.views(who.owner, P(req))));
  router.get('/:project/views/:view/graph', read((req, who) => projects.graph(who.owner, P(req), req.params.view, req.query.version)));
  router.get('/:project/views/:view/graphs', read((req, who) => projects.graphVersions(who.owner, P(req), req.params.view)));
  router.put('/:project/views/:view/graph', write((req, who) => { target(req, req.params.view, 'graph'); return projects.putGraph(who, P(req), req.params.view, body(req)); }, 201));
  router.get('/:project/views/:view/records', read((req, who) => projects.records(who.owner, P(req), req.params.view, req.query)));
  router.post('/:project/views/:view/records', write((req, who) => { target(req, req.params.view, 'records'); return projects.addRecords(who, P(req), req.params.view, req.body); }, 201));
  router.get('/:project/views/:view/summary', read((req, who) => projects.summary(who.owner, P(req), req.params.view)));
  router.get('/:project/records', read((req, who) => projects.records(who.owner, P(req), null, req.query)));

  // Event stream with long polling (at most 25 s)
  router.get('/:project/events', async (req, res, next) => {
    try {
      need(req, 'project:read'); target(req, 'events');
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const result = await projects.waitEvents(principal(req).owner, P(req), req.query.since, req.query.wait, controller.signal);
      if (!res.writableEnded && !res.destroyed) res.json(result);
    } catch (error) { next(error); }
  });

  router.delete('/:project/:kind/:id', confirm, write((req, who) => projects.deleteRecord(who, P(req), req.params.kind, req.params.id)));
  router.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return router;
}

module.exports = { createProjectRouter };
