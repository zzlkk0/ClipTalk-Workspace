'use strict';
window.ClipTalkDrive = (() => {
  let folderId = null, selected = new Set(), refreshing = false, again = false, nameTarget = null, moveTarget = null, upload = null;
  const element = id => document.getElementById(id);
  const label = key => t('drive.' + key);
  function button(text, action, style = '') {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'small-btn ' + style;
    node.textContent = text; node.onclick = action; return node;
  }
  function selection() {
    element('drive-selection').textContent = selected.size + ' ' + label('selected');
    element('drive-move').disabled = element('drive-delete').disabled = !selected.size;
  }
  async function navigate(id) {
    folderId = id; selected.clear(); selection(); await refresh();
  }
  async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    const requested = folderId;
    try {
      const data = await api('/api/drive' + (requested ? '?folderId=' + encodeURIComponent(requested) : ''));
      if (requested !== folderId) { again = true; return; }
      const names = new Set(data.files.map(file => file.name));
      selected = new Set([...selected].filter(name => names.has(name))); selection();
      const breadcrumbs = element('drive-breadcrumbs'); breadcrumbs.replaceChildren(button(label('root'), () => navigate(null)));
      for (const folder of data.breadcrumbs) {
        breadcrumbs.append(document.createTextNode(' / '), button(folder.name, () => navigate(folder.id)));
      }
      const list = element('file-list'); list.replaceChildren();
      for (const folder of data.folders) {
        const row = document.createElement('div'); row.className = 'file-item folder-item'; row.dataset.folderId = folder.id;
        const open = button('📁 ' + folder.name, () => navigate(folder.id), 'folder-name');
        row.append(open, button(label('rename'), () => openName(folder)), button(label('move'), () => openMove(folder)),
          button(label('delete'), () => deleteFolder(folder), 'danger'));
        list.append(row);
      }
      for (const file of data.files) {
        const row = document.createElement('div'); row.className = 'file-item'; row.dataset.fileName = file.name;
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(file.name);
        check.setAttribute('aria-label', label('select') + ' ' + file.originalName);
        check.onchange = () => { check.checked ? selected.add(file.name) : selected.delete(file.name); selection(); };
        const meta = document.createElement('div'); meta.className = 'file-meta';
        const name = document.createElement('span'); name.className = 'fname'; name.textContent = file.originalName; name.title = file.originalName;
        const detail = document.createElement('span'); detail.className = 'muted'; detail.textContent = ClipTalkUI.size(file.size) + ' · ' + dateTime(file.time);
        meta.append(name, detail);
        const download = document.createElement('a'); download.textContent = t('workspace.download');
        download.href = '/uploads/' + encodeURIComponent(file.name); download.download = file.originalName;
        row.append(check, meta, download, button(label('move'), () => openMove(null, [file.name])),
          button('✕', () => deleteFiles([file.name]), 'danger'));
        row.lastChild.setAttribute('aria-label', t('workspace.delete_file'));
        list.append(row);
      }
      if (!data.files.length && !data.folders.length) {
        const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = label('empty'); list.append(empty);
      }
    } catch (error) {
      if (error.message === 'not_found' && requested && folderId === requested) { folderId = null; again = true; }
      else showNotice(errorText(error.message));
    } finally {
      refreshing = false;
      if (again) { again = false; await refresh(); }
    }
  }
  function openName(folder = null) {
    nameTarget = folder;
    element('drive-name-title').textContent = label(folder ? 'rename' : 'new_folder');
    element('drive-name').value = folder?.name || '';
    element('drive-name-error').textContent = '';
    element('drive-name-dialog').showModal(); element('drive-name').focus();
  }
  async function openMove(folder, names = [...selected]) {
    moveTarget = { folder, names };
    try {
      const folders = await api('/api/drive/folders'), map = new Map(folders.map(item => [item.id, item]));
      const destination = element('drive-destination'); destination.replaceChildren(new Option(label('root'), ''));
      for (const item of folders) {
        const parts = [], ancestors = new Set(); let current = item;
        while (current) { parts.unshift(current.name); ancestors.add(current.id); current = map.get(current.parentId); }
        if (!folder || !ancestors.has(folder.id)) destination.add(new Option('/ ' + parts.join(' / '), item.id));
      }
      destination.value = folderId || '';
      element('drive-move-error').textContent = ''; element('drive-move-dialog').showModal();
    } catch (error) { showNotice(errorText(error.message)); }
  }
  async function deleteFiles(names = [...selected]) {
    if (!names.length || !confirm(label('delete_files_confirm') + ' (' + names.length + ')')) return;
    try {
      await api('/api/drive/files', jsonOptions('DELETE', { names, confirm: true }));
      selected.clear(); await refresh(); showNotice(label('deleted'));
    } catch (error) { showNotice(errorText(error.message)); }
  }
  async function deleteFolder(folder) {
    if (!confirm(label('delete_folder_confirm') + '\n' + folder.name)) return;
    try {
      await api('/api/drive/folders/' + encodeURIComponent(folder.id), jsonOptions('DELETE', { confirm: true }));
      await refresh(); showNotice(label('deleted'));
    } catch (error) { showNotice(errorText(error.message)); }
  }
  function uploadFiles(files) {
    if (!files.length || upload) return;
    const data = new FormData();
    for (const file of files) data.append('files', file);
    const request = upload = new XMLHttpRequest();
    request.open('POST', '/upload' + (folderId ? '?folderId=' + encodeURIComponent(folderId) : ''));
    element('drive-upload-progress').hidden = false;
    element('drive-upload-progress').value = 0; element('drive-cancel-upload').hidden = false;
    request.upload.onprogress = event => {
      if (event.lengthComputable) element('drive-upload-progress').value = event.loaded / event.total;
      ClipTalkLifecycle.activity();
    };
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText);
        if (request.status < 200 || request.status >= 300) throw new Error(result.error || 'server_error');
        showNotice(t('workspace.upload_done')); refresh();
      } catch (error) { showNotice(errorText(error.message)); }
    };
    request.onerror = () => showNotice(t('errors.network_error'));
    request.onabort = () => showNotice(t('errors.upload_aborted'));
    request.onloadend = () => {
      upload = null; element('drive-upload-progress').hidden = true; element('drive-cancel-upload').hidden = true;
      element('file-input').value = '';
    };
    showNotice(t('workspace.uploading')); request.send(data);
  }
  function init(socket) {
    socket.on('drive-updated', refresh);
    element('drive-new-folder').onclick = () => openName();
    element('drive-move').onclick = () => openMove(null);
    element('drive-delete').onclick = () => deleteFiles();
    element('drive-refresh').onclick = refresh;
    element('drive-cancel-upload').onclick = () => upload?.abort();
    element('drive-select-all').onclick = () => {
      const checks = [...element('file-list').querySelectorAll('input[type=checkbox]')];
      const checked = checks.some(check => !check.checked);
      for (const check of checks) { check.checked = checked; check.onchange(); }
    };
    element('drive-name-form').onsubmit = async event => {
      event.preventDefault(); const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
      try {
        await api('/api/drive/folders' + (nameTarget ? '/' + encodeURIComponent(nameTarget.id) : ''),
          jsonOptions(nameTarget ? 'PATCH' : 'POST', { name: element('drive-name').value, ...(nameTarget ? {} : { parentId: folderId }) }));
        element('drive-name-dialog').close(); await refresh();
      } catch (error) { element('drive-name-error').textContent = errorText(error.message); }
      finally { submit.disabled = false; }
    };
    element('drive-move-form').onsubmit = async event => {
      event.preventDefault(); const submit = event.target.querySelector('[type=submit]'); submit.disabled = true;
      try {
        const destination = element('drive-destination').value || null;
        await api('/api/drive/' + (moveTarget.folder ? 'folders/' + encodeURIComponent(moveTarget.folder.id) : 'files'),
          jsonOptions('PATCH', moveTarget.folder ? { parentId: destination } : { names: moveTarget.names, folderId: destination }));
        element('drive-move-dialog').close(); selected.clear(); await refresh(); showNotice(label('moved'));
      } catch (error) { element('drive-move-error').textContent = errorText(error.message); }
      finally { submit.disabled = false; }
    };
  }
  return { init, refresh, uploadFiles, deleteFile: name => deleteFiles([name]) };
})();
