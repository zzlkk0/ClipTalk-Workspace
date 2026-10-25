'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Transform, pipeline } = require('stream');

// Count in-flight bytes across every upload from the same account, including
// simultaneous uploads from different devices. Committed data is checked again
// in the SQLite transaction before an upload becomes visible.
class QuotaStorage {
  constructor(workspace) { this.workspace = workspace; this.pending = new Map(); }

  reserve(req, bytes) {
    const reservation = req.clipTalkReservation ||= { owner: req.agent?.owner_id || req.session.userId, bytes: 0, released: false };
    if (reservation.released || req.aborted) throw Object.assign(new Error('upload_aborted'), { status: 400 });
    const pending = this.pending.get(reservation.owner) || 0;
    const { usedBytes, quotaBytes } = this.workspace.storage(reservation.owner);
    if (usedBytes + pending + bytes > quotaBytes) throw Object.assign(new Error('quota_exceeded'), { status: 413 });
    reservation.bytes += bytes;
    this.pending.set(reservation.owner, pending + bytes);
  }

  release(req) {
    const reservation = req.clipTalkReservation;
    if (!reservation || reservation.released) return;
    reservation.released = true;
    const remaining = Math.max(0, (this.pending.get(reservation.owner) || 0) - reservation.bytes);
    if (remaining) this.pending.set(reservation.owner, remaining);
    else this.pending.delete(reservation.owner);
  }

  _handleFile(req, file, callback) {
    const filename = Date.now() + '_' + randomUUID();
    const filePath = path.join(this.workspace.uploadsDir, filename);
    const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
    const counter = new Transform({ transform: (chunk, encoding, done) => {
      try { this.reserve(req, chunk.length); done(null, chunk); }
      catch (error) { done(error); }
    }});
    const abort = () => counter.destroy(Object.assign(new Error('upload_aborted'), { status: 400 }));
    req.once('aborted', abort);
    pipeline(file.stream, counter, output, error => {
      req.off('aborted', abort);
      if (error) return fs.rm(filePath, { force: true }, () => callback(error));
      callback(null, { destination: this.workspace.uploadsDir, filename, path: filePath, size: output.bytesWritten });
    });
  }

  _removeFile(req, file, callback) { fs.unlink(file.path, error => callback(error?.code === 'ENOENT' ? null : error)); }
}

module.exports = { QuotaStorage };
