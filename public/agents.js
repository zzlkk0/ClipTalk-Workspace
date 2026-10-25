'use strict';
(async () => {
  const ui = ClipTalkUI, el = id => document.getElementById(id);
  let cursor = null;
  const date = time => time ? new Date(time).toLocaleString(document.documentElement.lang) : '—';
  const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
  function scopeLabel(scope) { return ui.t('agents.scope_' + scope.replace(':', '_')); }
  async function keys() {
    const data = await ui.api('/api/agent-keys');
    const list = el('key-list'); list.replaceChildren();
    for (const key of data.keys) {
      const row = document.createElement('div'); row.className = 'key-row'; row.dataset.keyId = key.id;
      const state = key.revoked_at ? 'revoked' : key.expires_at <= Date.now() ? 'expired' : 'active';
      row.append(text('h3', key.label), text('p', key.prefix + '… · ' + ui.t('agents.' + state)), text('p', key.scopes.map(scopeLabel).join(' · '), 'muted'),
        text('p', ui.t('agents.expires_at') + ': ' + date(key.expires_at) + ' · ' + ui.t('agents.last_used') + ': ' + date(key.last_used_at), 'hint'));
      if (state === 'active') {
        const revoke = text('button', ui.t('agents.revoke'), 'danger'); revoke.type = 'button';
        revoke.onclick = async () => {
          if (!confirm(ui.t('agents.revoke_confirm') + '\n' + key.label)) return;
          try { await ui.api('/api/agent-keys/' + encodeURIComponent(key.id), { method: 'DELETE' }); await keys(); }
          catch (error) { ui.notice(ui.error(error.message), true); }
        };
        row.append(revoke);
      }
      list.append(row);
    }
    if (!data.keys.length) list.append(text('p', ui.t('agents.no_keys'), 'muted'));
    if (!el('key-scopes').children.length) for (const scope of data.scopes) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.name = 'scope'; input.value = scope;
      input.checked = scope.endsWith(':read'); label.append(input, document.createTextNode(scopeLabel(scope))); el('key-scopes').append(label);
    }
  }
  async function audit(more = false) {
    const data = await ui.api('/api/agent-audit' + (more && cursor ? '?before=' + cursor : ''));
    if (!more) el('audit-list').replaceChildren();
    for (const item of data.entries) {
      const row = document.createElement('tr'); row.dataset.action = item.action;
      const actions = { 'GET /me': 'inspect_key', 'GET /storage': 'storage', 'GET /clipboard': 'read_clipboard', 'PUT /clipboard': 'write_clipboard', 'GET /drive': 'list_files', 'GET /folders': 'list_folders', 'POST /folders': 'create_folder', 'PATCH /folders/:id': 'update_folder', 'DELETE /folders/:id': 'delete_folder', 'GET /files/:name': 'download_file', 'POST /files': 'upload_file', 'PATCH /files': 'move_files', 'DELETE /files': 'delete_files' };
      const action = actions[item.action] ? ui.t('agents.action_' + actions[item.action]) : item.action;
      const status = item.status < 300 ? 'success' : ({ 401: 'invalid', 403: 'forbidden', 404: 'missing', 413: 'full', 429: 'limited', 499: 'cancelled' }[item.status] || 'failed');
      for (const value of [date(item.time), item.label, action, item.target || '—', ui.t('agents.result_' + status)]) row.append(text('td', value));
      row.children[2].title = item.action; row.lastChild.title = String(item.status);
      el('audit-list').append(row);
    }
    cursor = data.nextCursor; el('audit-more').hidden = !cursor;
  }
  try {
    await ui.init('agents.title');
    el('transport-hint').hidden = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const base = location.protocol === 'https:' ? location.origin : 'http://127.0.0.1:18131';
    el('mcp-config').textContent = JSON.stringify({ mcpServers: { cliptalk: { command: 'node', args: ['/path/to/ClipTalk-Workspace/scripts/cliptalk-mcp.js'], env: {
      CLIPTALK_URL: base, CLIPTALK_TOKEN_FILE: '/path/to/private/cliptalk-token', CLIPTALK_LOCAL_DIR: '/path/to/agent-files',
    } } } }, null, 2);
    await keys(); await audit();
    el('key-form').onsubmit = async event => {
      event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
      el('new-token').value = ''; el('created-key').hidden = true;
      try {
        const result = await ui.api('/api/agent-keys', ui.json('POST', { label: el('key-label').value, expiresInDays: Number(el('key-days').value),
          scopes: [...document.querySelectorAll('[name=scope]:checked')].map(node => node.value), currentPassword: el('key-password').value }));
        el('new-token').value = result.token; el('created-key').hidden = false; await keys();
      } catch (error) { ui.notice(ui.error(error.message), true); }
      finally { el('key-password').value = ''; button.disabled = false; }
    };
    el('hide-token').onclick = () => { el('new-token').value = ''; el('created-key').hidden = true; };
    el('copy-token').onclick = async () => {
      try { await navigator.clipboard.writeText(el('new-token').value); ui.notice(ui.t('agents.copied')); }
      catch { el('new-token').focus(); el('new-token').select(); ui.notice(ui.t('agents.copy_manually')); }
    };
    el('audit-refresh').onclick = () => audit().catch(error => ui.notice(ui.error(error.message), true));
    el('audit-more').onclick = () => audit(true).catch(error => ui.notice(ui.error(error.message), true));
  } catch (error) { ui.notice(ui.error(error.message), true); }
})();
