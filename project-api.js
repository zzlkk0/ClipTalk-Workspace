'use strict';
// Project collaboration routes. The same router serves the Agent API
// (/api/v1/projects, Bearer key) and the browser (/api/projects, session).
// Identity always comes from the key's actor or the session, never the body.
const express = require('express');
const { ProjectStore } = require('./project-store');

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

function createProjectRouter({ projects, keys }) {
  const router = express.Router();
  const fail = (code, status) => { throw Object.assign(new Error(code), { status }); };
  const principal = req => req.agent
    ? { kind: 'agent', owner: req.agent.owner_id, actor: req.agent.actor || null, keyId: req.agent.id }
    : { kind: 'user', owner: req.session.userId, actor: 'USER' };
  const need = (req, scope) => { if (req.agent) keys.authorizeId(req.agent.id, scope); };
  const target = (req, ...parts) => { req.agentTarget = [req.params.project, ...parts].filter(Boolean).join('/'); };

  const read = handler => (req, res, next) => {
    try { need(req, 'project:read'); target(req); res.json(handler(req, principal(req))); }
    catch (error) { next(error); }
  };
  // Writes run in one transaction with the idempotency record, so a retried
  // request either replays the stored response or performs the write once.
  const write = (scope, handler, okStatus = 200) => (req, res, next) => {
    try {
      need(req, scope);
      const who = principal(req), idem = req.get('Idempotency-Key');
      let hash = null;
      if (idem !== undefined && who.kind === 'agent') {
        if (!IDEMPOTENCY_KEY.test(idem)) fail('invalid_idempotency_key', 400);
        hash = ProjectStore.requestHash(req.method, req.baseUrl + req.path, req.body);
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
  const userOnly = (req, res, next) => req.agent ? next(Object.assign(new Error('browser_session_required'), { status: 403 })) : next();
  const confirm = (req, res, next) => req.body?.confirm === true ? next() : res.status(400).json({ error: 'confirmation_required' });
  const body = req => req.body ?? {};

  // P1/P2: projects, global state and switches
  router.get('/', read((req, who) => ({ projects: projects.list(who.owner) })));
  router.post('/', userOnly, write(null, (req, who) => projects.create(who, body(req)), 201));
  router.delete('/:project', userOnly, confirm, write(null, (req, who) => { projects.remove(who, req.params.project); return { ok: true }; }));
  router.get('/:project/state', read((req, who) => projects.state(who.owner, req.params.project)));
  router.put('/:project/state', userOnly, write(null, (req, who) => projects.setSwitches(who, req.params.project, body(req))));

  // P3: per-actor status
  router.get('/:project/status', read((req, who) => projects.statuses(who.owner, req.params.project)));
  router.put('/:project/status/:actor', write('project:write', (req, who) => { target(req, 'status', req.params.actor); return projects.setStatus(who, req.params.project, req.params.actor, body(req)); }));

  // P4: tasks
  router.get('/:project/tasks', read((req, who) => projects.tasks(who.owner, req.params.project, req.query)));
  router.post('/:project/tasks/import', userOnly, write(null, (req, who) => projects.importTasks(who, req.params.project, body(req))));
  router.get('/:project/tasks/:id', read((req, who) => projects.task(who.owner, req.params.project, req.params.id)));
  router.patch('/:project/tasks/:id', write('project:write', (req, who) => { target(req, 'tasks', req.params.id); return projects.updateTask(who, req.params.project, req.params.id, body(req)); }));

  // P5: messages
  router.get('/:project/messages', read((req, who) => projects.messages(who.owner, req.params.project, req.query)));
  router.post('/:project/messages', write('project:write', (req, who) => { const message = projects.postMessage(who, req.params.project, body(req)); target(req, message.id); return message; }, 201));

  // P6: handoffs
  router.get('/:project/handoffs', read((req, who) => projects.handoffs(who.owner, req.params.project, req.query)));
  router.post('/:project/handoffs', write('project:write', (req, who) => { const handoff = projects.addHandoff(who, req.params.project, body(req)); target(req, handoff.id); return handoff; }, 201));
  router.get('/:project/handoffs/:id', read((req, who) => projects.handoff(who.owner, req.params.project, req.params.id)));

  // P7: decisions
  router.get('/:project/decisions', read((req, who) => projects.decisions(who.owner, req.params.project, req.query)));
  router.post('/:project/decisions', write('project:write', (req, who) => { const decision = projects.raiseDecision(who, req.params.project, body(req)); target(req, decision.id); return decision; }, 201));
  router.get('/:project/decisions/:id', read((req, who) => projects.decision(who.owner, req.params.project, req.params.id)));
  router.post('/:project/decisions/:id/answer', userOnly, write(null, (req, who) => projects.answerDecision(who, req.params.project, req.params.id, body(req))));

  // P8/P9: document copies and shared memory
  for (const [path, kind, param] of [['docs', 'doc', 'name'], ['memory', 'memory', 'actor']]) {
    router.get('/:project/' + path, read((req, who) => projects.texts(who.owner, req.params.project, kind)));
    router.get('/:project/' + path + '/:' + param, read((req, who) => projects.getText(who.owner, req.params.project, kind, req.params[param], req.query.version)));
    router.get('/:project/' + path + '/:' + param + '/history', read((req, who) => projects.textHistory(who.owner, req.params.project, kind, req.params[param])));
    router.put('/:project/' + path + '/:' + param, write('project:write', (req, who) => { target(req, path, req.params[param]); return projects.putText(who, req.params.project, kind, req.params[param], body(req)); }));
  }

  // P10/P11: circuits
  router.get('/:project/circuits', read((req, who) => projects.circuits(who.owner, req.params.project)));
  router.get('/:project/circuits/:circuit/topology', read((req, who) => projects.topology(who.owner, req.params.project, req.params.circuit, req.query.version)));
  router.get('/:project/circuits/:circuit/topologies', read((req, who) => projects.topologyVersions(who.owner, req.params.project, req.params.circuit)));
  router.put('/:project/circuits/:circuit/topology', write('project:circuits', (req, who) => { target(req, req.params.circuit, 'topology'); return projects.putTopology(who, req.params.project, req.params.circuit, body(req)); }, 201));
  router.get('/:project/circuits/:circuit/results', read((req, who) => projects.results(who.owner, req.params.project, req.params.circuit, req.query)));
  router.post('/:project/circuits/:circuit/results', write('project:circuits', (req, who) => { target(req, req.params.circuit, 'results'); return projects.addResults(who, req.params.project, req.params.circuit, req.body); }, 201));
  router.get('/:project/circuits/:circuit/summary', read((req, who) => projects.summary(who.owner, req.params.project, req.params.circuit)));
  router.get('/:project/results', read((req, who) => projects.results(who.owner, req.params.project, null, req.query)));

  // P12: event stream with long polling (at most 25 s)
  router.get('/:project/events', async (req, res, next) => {
    try {
      need(req, 'project:read'); target(req, 'events');
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const result = await projects.waitEvents(principal(req).owner, req.params.project, req.query.since, req.query.wait, controller.signal);
      if (!res.writableEnded && !res.destroyed) res.json(result);
    } catch (error) { next(error); }
  });

  // Deleting any record requires a signed-in person and explicit confirmation.
  router.delete('/:project/:kind/:id', userOnly, confirm, write(null, (req, who) => projects.deleteRecord(who, req.params.project, req.params.kind, req.params.id)));
  router.all('*', (req, res, next) => req.method === 'DELETE' && req.agent ? next(Object.assign(new Error('browser_session_required'), { status: 403 })) : res.status(404).json({ error: 'not_found' }));
  return router;
}

module.exports = { createProjectRouter };
