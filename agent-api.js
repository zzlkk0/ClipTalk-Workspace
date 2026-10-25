'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('node:path');

function createAgentRouter({ keys, accounts, workspace, drive, handleUpload, emitDrive, emitSnapshot, emitArchives, emitClipboard }) {
  const router = express.Router();
  router.use(rateLimit({ windowMs: 60000, limit: 240, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_requests' } }));
  router.use((req, res, next) => {
    try {
      req.agent = keys.authenticate(req.headers.authorization);
      const started = Date.now(); let recorded = false;
      const record = () => {
        if (recorded) return; recorded = true;
        try { keys.audit(req.agent, req.method + ' ' + (req.route?.path || 'unknown'), req.agentTarget, res.writableFinished ? res.statusCode : 499, Date.now() - started); }
        catch (error) { console.error('Agent audit failed:', error.code || 'database_error'); }
      };
      res.once('finish', record); res.once('close', record);
      keys.consume(req.agent.id);
      next();
    } catch (error) {
      if (error.status === 401) res.set('WWW-Authenticate', 'Bearer realm="ClipTalk"');
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      next(error);
    }
  });
  const scope = name => (req, res, next) => { try { keys.authorizeId(req.agent.id, name); next(); } catch (error) { next(error); } };
  const owner = req => req.agent.owner_id;
  const confirm = (req, res, next) => req.body.confirm === true ? next() : res.status(400).json({ error: 'confirmation_required' });
  router.get('/me', (req, res) => res.json({ username: accounts.getUserById(owner(req)).username, keyName: req.agent.label, scopes: req.agent.scopes, expiresAt: req.agent.expires_at, rateLimitPerMinute: 60 }));
  router.get('/storage', scope('files:read'), (req, res) => res.json(workspace.storage(owner(req))));
  router.get('/clipboard', scope('clipboard:read'), (req, res) => res.json({ text: workspace.db.prepare('SELECT clipboard_text FROM workspaces WHERE owner_id = ?').get(owner(req))?.clipboard_text || '' }));
  router.put('/clipboard', scope('clipboard:write'), (req, res) => {
    if (typeof req.body.text !== 'string' || req.body.text.length > 500000) return res.status(400).json({ error: 'invalid_clipboard' });
    workspace.setClipboard(owner(req), req.body.text); emitClipboard(owner(req), req.body.text);
    res.json({ ok: true });
  });
  router.get('/drive', scope('files:read'), (req, res) => res.json(drive.list(owner(req), req.query.folderId)));
  router.get('/folders', scope('files:read'), (req, res) => res.json(drive.folders(owner(req))));
  router.post('/folders', scope('files:manage'), (req, res) => {
    const folder = drive.createFolder(owner(req), req.body); req.agentTarget = folder.name;
    emitDrive(owner(req)); res.status(201).json(folder);
  });
  router.patch('/folders/:id', scope('files:manage'), (req, res) => {
    const folder = drive.updateFolder(owner(req), req.params.id, req.body); req.agentTarget = folder.name;
    emitDrive(owner(req)); res.json(folder);
  });
  router.delete('/folders/:id', scope('files:delete'), confirm, (req, res) => {
    req.agentTarget = drive.folder(owner(req), req.params.id)?.name;
    drive.deleteFolder(owner(req), req.params.id); emitDrive(owner(req)); emitSnapshot(owner(req)); emitArchives(owner(req));
    res.json({ ok: true });
  });
  router.get('/files/:name', scope('files:read'), (req, res, next) => {
    const asset = workspace.downloadable(owner(req), req.params.name);
    if (!asset || path.basename(asset.name) !== asset.name) return res.status(404).json({ error: 'not_found' });
    req.agentTarget = asset.original_name;
    res.download(path.join(workspace.uploadsDir, asset.name), asset.original_name, error => { if (error && !res.headersSent) next(Object.assign(new Error('not_found'), { status: 404 })); });
  });
  router.post('/files', scope('files:upload'), handleUpload);
  router.patch('/files', scope('files:manage'), (req, res) => {
    drive.moveFiles(owner(req), req.body.names, req.body.folderId); req.agentTarget = req.body.names.join(', ');
    emitDrive(owner(req)); res.json({ ok: true });
  });
  router.delete('/files', scope('files:delete'), confirm, (req, res) => {
    drive.deleteFiles(owner(req), req.body.names); req.agentTarget = req.body.names.join(', ');
    emitDrive(owner(req)); emitSnapshot(owner(req)); emitArchives(owner(req)); res.json({ ok: true });
  });
  router.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return router;
}
module.exports = { createAgentRouter };
