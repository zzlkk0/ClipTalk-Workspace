'use strict';
(async () => {
  const ui = ClipTalkUI;
  let shares = [], users = [], filter = 'mine', editing;
  try { const user = await ui.init('sharing.title'); document.getElementById('sharing-account').textContent = user.username; }
  catch (error) { ui.notice(ui.error(error.message), true); return; }
  const linkFor = token => location.origin + '/share/' + token;
  function button(text, action, danger = false) {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
    if (danger) element.className = 'danger';
    element.onclick = async () => {
      element.disabled = true;
      try { await action(); } catch (error) { ui.notice(ui.error(error.message), true); }
      finally { element.disabled = false; }
    };
    return element;
  }
  function recipients(container, selected = []) {
    container.replaceChildren();
    for (const user of users) {
      const label = document.createElement('label'); label.className = 'recipient';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = user.username;
      input.checked = selected.includes(user.username);
      label.append(input, document.createTextNode(user.username)); container.append(label);
    }
    if (!users.length) container.textContent = ui.t('sharing.no_users');
  }
  const selected = id => [...document.querySelectorAll('#' + id + ' input:checked')].map(input => input.value);
  function render() {
    const list = document.getElementById('share-list'); list.replaceChildren();
    const items = shares.filter(share => filter === 'mine' ? share.isOwner : filter === 'received' ? !share.isOwner && share.visibility === 'users' : share.visibility === 'public');
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = ui.t('sharing.empty'); list.append(empty); }
    for (const share of items) {
      const card = document.createElement('article'); card.className = 'share-card'; card.dataset.token = share.token;
      const title = document.createElement('h3'); title.textContent = share.originalName;
      const meta = document.createElement('p'); meta.className = 'muted';
      meta.textContent = share.owner + ' · ' + ui.size(share.size) + ' · ' + new Date(share.createdAt).toLocaleString();
      const access = document.createElement('span'); access.className = 'badge'; access.textContent = ui.t('sharing.' + share.visibility);
      if (share.isOwner && share.visibility === 'users') access.textContent += ' · ' + share.recipients.join(', ');
      const actions = document.createElement('div'); actions.className = 'actions';
      const view = document.createElement('a'); view.className = 'button'; view.textContent = ui.t('workspace.view'); view.href = '/share/' + share.token;
      const download = document.createElement('a'); download.className = 'button'; download.textContent = ui.t('workspace.download'); download.href = '/api/shares/' + share.token + '/download';
      actions.append(view, download);
      if (!share.isOwner) actions.append(button(ui.t('sharing.import'), async () => {
        await ui.api('/api/shares/' + share.token + '/import', ui.json('POST', {})); ui.notice(ui.t('sharing.imported'));
      }));
      else actions.append(button(ui.t('sharing.edit'), async () => {
        editing = share.token; document.getElementById('edit-share-visibility').value = share.visibility;
        recipients(document.getElementById('edit-share-recipients'), share.recipients);
        document.getElementById('edit-recipients-section').hidden = share.visibility === 'public';
        document.getElementById('edit-share-error').textContent = '';
        document.getElementById('share-edit-dialog').showModal();
      }), button(ui.t('sharing.revoke'), async () => {
        if (!confirm(ui.t('sharing.revoke_confirm'))) return;
        await ui.api('/api/shares/' + share.token, { method: 'DELETE' });
        await refresh(); ui.notice(ui.t('sharing.revoked'));
      }, true));
      const link = document.createElement('input'); link.className = 'share-link'; link.readOnly = true;
      link.value = linkFor(share.token); link.setAttribute('aria-label', ui.t('sharing.share_link')); link.onclick = () => link.select();
      const copy = button(ui.t('sharing.copy_link'), async () => {
        let copied = false;
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(link.value); copied = true; }
        else { link.focus(); link.select(); copied = document.execCommand('copy'); }
        ui.notice(ui.t(copied ? 'sharing.copied' : 'sharing.select_copy'));
      });
      actions.append(copy); card.append(title, meta, access, actions, link); list.append(card);
    }
  }
  async function refresh() {
    const [allShares, allUsers, files] = await Promise.all([ui.api('/api/shares'), ui.api('/api/share-users'), ui.api('/api/share-files')]);
    shares = allShares; users = allUsers;
    const select = document.getElementById('share-file'), current = select.value; select.replaceChildren();
    if (!files.length) { const option = new Option(ui.t('workspace.no_files'), ''); select.append(option); }
    for (const file of files) select.append(new Option(file.originalName + ' · ' + ui.size(file.size), file.name));
    if (files.some(file => file.name === current)) select.value = current;
    document.getElementById('create-share-button').disabled = !files.length;
    recipients(document.getElementById('share-recipients'), selected('share-recipients')); render();
  }
  document.querySelectorAll('[data-filter]').forEach(element => { element.onclick = async () => {
    filter = element.dataset.filter; document.querySelectorAll('[data-filter]').forEach(tab => tab.classList.toggle('active', tab === element));
    try { await refresh(); } catch (error) { ui.notice(ui.error(error.message), true); }
  }; });
  document.getElementById('refresh-shares').onclick = () => refresh().catch(error => ui.notice(ui.error(error.message), true));
  document.getElementById('share-visibility').onchange = event => { document.getElementById('share-recipients-section').hidden = event.target.value === 'public'; };
  document.getElementById('edit-share-visibility').onchange = event => { document.getElementById('edit-recipients-section').hidden = event.target.value === 'public'; };
  document.getElementById('close-share-edit').onclick = () => document.getElementById('share-edit-dialog').close();
  document.getElementById('share-create-form').onsubmit = async event => {
    event.preventDefault(); const submit = event.target.querySelector('button'); submit.disabled = true;
    try {
      const share = await ui.api('/api/shares', ui.json('POST', { name: document.getElementById('share-file').value,
        visibility: document.getElementById('share-visibility').value, recipients: selected('share-recipients') }));
      filter = 'mine'; document.querySelectorAll('[data-filter]').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === filter));
      await refresh(); ui.notice(ui.t('sharing.created') + ' ' + linkFor(share.token));
    } catch (error) { ui.notice(ui.error(error.message), true); }
    finally { submit.disabled = false; }
  };
  document.getElementById('share-edit-form').onsubmit = async event => {
    event.preventDefault(); const submit = event.target.querySelector('button'); submit.disabled = true;
    try {
      await ui.api('/api/shares/' + editing, ui.json('PATCH', { visibility: document.getElementById('edit-share-visibility').value, recipients: selected('edit-share-recipients') }));
      document.getElementById('share-edit-dialog').close(); await refresh(); ui.notice(ui.t('sharing.saved'));
    } catch (error) { document.getElementById('edit-share-error').textContent = ui.error(error.message); }
    finally { submit.disabled = false; }
  };
  document.getElementById('share-link-form').onsubmit = event => {
    event.preventDefault();
    try {
      const link = new URL(document.getElementById('share-link-input').value.trim(), location.origin);
      if (link.origin !== location.origin || !/^\/share\/[a-f0-9]{64}$/.test(link.pathname)) throw new Error('invalid_share_link');
      location.href = link.pathname;
    } catch { ui.notice(ui.error('invalid_share_link'), true); }
  };
  await refresh().catch(error => ui.notice(ui.error(error.message), true));
})();
