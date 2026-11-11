'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class ClipTalkClient {
  constructor(env = process.env) {
    this.base = new URL(env.CLIPTALK_URL || 'http://127.0.0.1:8000');
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') throw new Error('CLIPTALK_URL must be a site origin without credentials or a path.');
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname);
    if (this.base.protocol === 'http:' && !local) throw new Error('Use HTTPS or an SSH tunnel to localhost. Remote plaintext HTTP is not supported.');
    this.token = env.CLIPTALK_TOKEN_FILE ? fs.readFileSync(env.CLIPTALK_TOKEN_FILE, 'utf8').trim() : (env.CLIPTALK_TOKEN || '').trim();
    if (!/^ct_[A-Za-z0-9_-]{43}$/.test(this.token)) throw new Error('Set CLIPTALK_TOKEN_FILE to a private key file, or set CLIPTALK_TOKEN.');
    this.localDir = env.CLIPTALK_LOCAL_DIR ? fs.realpathSync(env.CLIPTALK_LOCAL_DIR) : null;
    // A private CA (e.g. the one created by deploy.sh --https-ip) is added to the default trust store.
    if (env.CLIPTALK_CA_FILE) {
      const tls = require('node:tls'), pem = fs.readFileSync(env.CLIPTALK_CA_FILE, 'utf8');
      if (typeof tls.setDefaultCACertificates !== 'function') throw new Error('This Node.js version cannot load CLIPTALK_CA_FILE. Update Node.js 22/24, or start Node with NODE_EXTRA_CA_CERTS=' + env.CLIPTALK_CA_FILE);
      tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem]);
    }
  }
  async request(endpoint, options = {}) {
    const response = await fetch(new URL('/api/v1' + endpoint, this.base), {
      ...options, redirect: 'error', headers: { ...options.headers, Authorization: 'Bearer ' + this.token },
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'HTTP ' + response.status), { status: response.status, retryAfter: response.headers.get('retry-after'), detail: result.detail });
    }
    return response;
  }
  async json(endpoint, method = 'GET', body, headers = {}) {
    return (await this.request(endpoint, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
  }
  localPath(filename, writing = false, restricted = false) {
    if (typeof filename !== 'string' || !filename || filename.includes('\0')) throw new Error('Invalid local file path.');
    if (restricted && !this.localDir) throw new Error('Set CLIPTALK_LOCAL_DIR to enable MCP local file transfers.');
    const resolved = path.resolve(this.localDir || process.cwd(), filename);
    const real = writing ? path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)) : fs.realpathSync(resolved);
    if (restricted && (real === this.localDir || !real.startsWith(this.localDir + path.sep))) throw new Error('File must be inside CLIPTALK_LOCAL_DIR.');
    return real;
  }
  async upload(filename, folderId = null, restricted = false) {
    const local = this.localPath(filename, false, restricted), stat = fs.statSync(local);
    if (!stat.isFile() || stat.size > 500 * 1024 * 1024) throw new Error('Upload must be a regular file of at most 500 MB.');
    const body = new FormData(); body.append('files', await fs.openAsBlob(local), path.basename(local));
    return (await this.request('/files' + (folderId ? '?folderId=' + encodeURIComponent(folderId) : ''), { method: 'POST', body })).json();
  }
  async download(name, filename, restricted = false) {
    const local = this.localPath(filename, true, restricted);
    // Exclusive creation refuses existing files and symlinks, including races.
    const handle = await fs.promises.open(local, 'wx', 0o600);
    try {
      const response = await this.request('/files/' + encodeURIComponent(name));
      await pipeline(Readable.fromWeb(response.body), handle.createWriteStream());
      return { ok: true, path: local };
    } catch (error) {
      await handle.close().catch(() => {}); await fs.promises.unlink(local).catch(() => {}); throw error;
    }
  }
}
module.exports = { ClipTalkClient };
