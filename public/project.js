'use strict';
// Project collaboration page. Tabs follow the project's module switches.
// All user and agent text is inserted with textContent; nothing from the
// server is parsed as HTML.
(async () => {
  const ui = ClipTalkUI, $ = id => document.getElementById(id);
  const T = key => ui.t('project.' + key);
  const MODULES = ['tasks', 'messages', 'decisions', 'handoffs', 'viewer', 'files'];
  const TASK_STATUS = ['proposed', 'todo', 'in_progress', 'blocked', 'review', 'done', 'dropped', 'rejected'];
  const MESSAGE_TYPES = ['info', 'question', 'answer', 'blocker', 'handoff_notice'];
  const COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7'];
  const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i, TABLE = /\.(csv|tsv)$/i, TEXT = /\.(md|txt|json|jsonl|csv|tsv|log|ya?ml|xml|ini|cfg|conf|py|js|ts|m|c|h|cpp|v|sv|vhd|tcl|sh|toml|html?)$/i;
  const state = { projects: [], current: null, tab: 'overview', tabs: {}, view: null, timer: null, info: null };

  // ─── Small DOM helpers ────────────────────────
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = !!value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
    return node;
  }
  function s(tag, attrs, ...kids) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs || {})) if (value !== undefined && value !== null) node.setAttribute(key, value);
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
    return node;
  }
  // Like replaceChildren, but flattens arrays and skips empty values (as h() does).
  const put = (target, ...kids) => target.replaceChildren(...kids.flat(Infinity).filter(kid => kid !== null && kid !== undefined && kid !== false).map(kid => kid instanceof Node ? kid : String(kid)));
  const svgTitle = text => s('title', {}, text);
  const when = value => value ? new Date(value).toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'zh-CN', { timeZone: 'Asia/Macau', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const badge = (value, label) => h('span', { class: 'badge st-' + value, text: label || value });
  const statusLabel = value => { const label = T('status_' + value); return label.startsWith('project.') ? value : label; };
  const select = (options, value, props = {}) => h('select', props, options.map(option => {
    const [optionValue, label] = Array.isArray(option) ? option : [option, option];
    return h('option', { value: optionValue, selected: optionValue === value ? true : undefined, text: label });
  }));
  const fill = (target, options, value) => { target.replaceChildren(...select(options, value).children); target.value = value; };
  const field = (label, control) => h('div', { class: 'field' }, h('label', { text: label }), control);
  const kv = entries => h('dl', { class: 'kv' }, entries.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [h('dt', { text: key }), h('dd', {}, value instanceof Node ? value : Array.isArray(value) && value.every(item => typeof item !== 'object') ? (value.join(', ') || '—') : typeof value === 'object' ? JSON.stringify(value, null, 1) : String(value))]));
  const unique = list => [...new Set(list.filter(item => item !== undefined && item !== null && item !== ''))];
  const truncate = (value, max) => value.length > max ? value.slice(0, max - 1) + '…' : value;
  function report(error) {
    if (error?.status === 409 && error.message === 'version_conflict') ui.notice(T('conflict'), true);
    else ui.notice(ui.error(error?.message || 'server_error'), true);
  }
  const api = (path, options) => ui.api('/api/projects' + path, options);
  const P = path => '/' + encodeURIComponent(state.current) + path;
  const enc = encodeURIComponent;
  const rawUrl = filePath => '/api/projects' + P('/files/raw?path=' + enc(filePath));
  async function action(button, work) {
    if (button) button.disabled = true;
    try { await work(); return true; } catch (error) { report(error); return false; } finally { if (button) button.disabled = false; }
  }
  const members = () => (state.info?.members || []).map(member => member.name);
  const recipients = () => unique([...members(), 'USER', 'ALL']);
  const viewerTitle = () => state.info?.project.viewer_title || T('tab_viewer');
  const copyText = async (box) => { try { await navigator.clipboard.writeText(box.value); ui.notice(T('copied')); } catch { box.focus(); box.select(); ui.notice(T('copy_manually')); } };

  // ─── Tabs and module switches ─────────────────
  const TABS = {
    overview: { mount: mountOverview, refresh: refreshOverview },
    tasks: { mount: mountTasks, refresh: refreshTasks },
    messages: { mount: mountMessages, refresh: refreshMessages },
    decisions: { mount: mountDecisions, refresh: refreshDecisions },
    handoffs: { mount: mountHandoffs, refresh: refreshHandoffs },
    viewer: { mount: mountViewer, refresh: refreshViewer },
    files: { mount: mountFiles, refresh: refreshFiles },
  };
  async function loadInfo() {
    state.info = await api(P('/state'));
    for (const button of document.querySelectorAll('[data-tab]')) {
      const module = button.dataset.module;
      button.hidden = !!module && !state.info.modules[module];
      if (button.dataset.tab === 'viewer') button.firstChild.textContent = viewerTitle();
    }
    const tab = document.querySelector('[data-tab="decisions"]');
    tab.querySelector('.count')?.remove();
    if (state.info.open_decisions) tab.append(h('span', { class: 'count', title: T('open_decisions'), text: state.info.open_decisions }));
    return state.info;
  }
  async function open(tab) {
    if (!state.info) await loadInfo();
    state.tab = TABS[tab] && (tab === 'overview' || state.info.modules[tab]) ? tab : 'overview';
    document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === state.tab)));
    const params = new URLSearchParams(location.search); params.set('p', state.current); params.set('tab', state.tab);
    history.replaceState(null, '', '?' + params);
    const view = $('project-view'); view.replaceChildren();
    state.view = state.tabs[state.tab] ||= {};
    TABS[state.tab].mount(view, state.view);
    await refresh(false);
  }
  async function refresh(reloadInfo = true) {
    if (!state.current) return;
    try {
      if (reloadInfo) await loadInfo();
      if (state.tab !== 'overview' && !state.info.modules[state.tab]) return open('overview');
      await TABS[state.tab].refresh(state.view);
    } catch (error) { report(error); }
  }
  function scheduleRefresh() { clearTimeout(state.timer); state.timer = setTimeout(() => refresh(true), 350); }

  // ─── Overview ─────────────────────────────────
  function mountOverview(view, local) {
    local.summary = h('div'); local.statuses = h('div', { class: 'grid2' }); local.members = h('div'); local.modules = h('div');
    local.switches = h('div'); local.decisions = h('div'); local.events = h('div'); local.usage = h('div', { class: 'usage' });
    const memberName = h('input', { placeholder: 'PC1', pattern: '[A-Za-z0-9][A-Za-z0-9_\\-]{0,31}', maxlength: 32, required: true, 'aria-label': T('member_name') });
    const memberRole = h('input', { placeholder: T('member_role_hint'), maxlength: 200, 'aria-label': T('member_role') });
    const addMember = h('button', { type: 'submit', text: T('add_member') });
    const switchName = h('input', { placeholder: 'PAUSED', pattern: '[A-Za-z0-9_.:-]{1,64}', 'aria-label': T('switch_name') });
    const addSwitch = h('button', { type: 'submit', text: T('add_switch') });
    const prompt = h('textarea', { readonly: true, style: 'min-height:180px', 'aria-label': T('agent_prompt') });
    local.prompt = prompt;
    view.append(
      h('section', { class: 'card' }, h('div', { class: 'section-head' }, h('h2', { text: T('summary') }), local.usage), local.summary),
      local.statuses,
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', { text: T('blocking_first') }), local.decisions),
        h('section', { class: 'card' }, h('h2', { text: T('members') }), h('p', { class: 'hint', text: T('members_hint') }), local.members,
          h('form', { class: 'actions', onsubmit: event => { event.preventDefault(); action(addMember, async () => {
            await api(P('/members/' + enc(memberName.value.trim())), ui.json('PUT', { role: memberRole.value.trim() })); memberName.value = ''; memberRole.value = ''; await refresh(true);
          }); } }, memberName, memberRole, addMember))),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', { text: T('modules') }), h('p', { class: 'hint', text: T('modules_hint') }), local.modules),
        h('section', { class: 'card' }, h('h2', { text: T('switches') }), h('p', { class: 'hint', text: T('switches_hint') }), local.switches,
          h('form', { class: 'actions', onsubmit: event => { event.preventDefault(); if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(switchName.value)) return ui.notice(T('invalid_switch'), true); action(addSwitch, async () => { await saveSwitches({ ...state.info.switches, [switchName.value]: true }); switchName.value = ''; }); } }, switchName, addSwitch))),
      h('section', { class: 'card' }, h('h2', { text: T('agent_prompt') }), h('p', { class: 'hint', text: T('agent_prompt_hint') }), prompt, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', text: T('copy_prompt'), onclick: () => copyText(prompt) }))),
      h('section', { class: 'card' }, h('h2', { text: T('recent_events') }), local.events),
      dangerZone());
    // Deleting a project is owner-only and asks for the project ID as confirmation.
    function dangerZone() {
      const withFiles = h('input', { type: 'checkbox', id: 'delete-project-files' });
      const typed = h('input', { id: 'delete-project-id', autocomplete: 'off', placeholder: state.current, 'aria-label': T('delete_project_type').replace('{id}', state.current) });
      const remove = h('button', { type: 'button', class: 'danger', text: T('delete_project'), disabled: true, onclick: () => action(remove, async () => {
        if (typed.value.trim() !== state.current) throw new Error('confirmation_required');
        await api(P(''), ui.json('DELETE', { confirm: true, deleteFiles: withFiles.checked }));
        location.href = '/project.html';
      }) });
      typed.addEventListener('input', () => { remove.disabled = typed.value.trim() !== state.current; });
      return h('section', { class: 'card danger-zone' }, h('h2', { text: T('delete_project') }), h('p', { class: 'hint', text: T('delete_project_hint') }),
        h('label', { class: 'switch-row', for: 'delete-project-files' }, withFiles, h('span', { text: T('delete_project_files') })),
        field(T('delete_project_type').replace('{id}', state.current), typed), h('div', { class: 'actions' }, remove));
    }
    async function saveSwitches(switches) {
      try { await api(P('/switches'), ui.json('PUT', { switches, version: state.info.switches_version })); } finally { await refresh(true); }
    }
    local.saveSwitches = saveSwitches;
  }
  async function refreshOverview(local) {
    const info = state.info;
    const [decisions, events] = await Promise.all([info.modules.decisions ? api(P('/decisions?status=open')) : { decisions: [] }, api(P('/events?since=' + Math.max(0, info.cursor - 40)))]);
    // Summary (现状): short free text anyone can update.
    const editSummary = h('button', { type: 'button', text: T('edit'), onclick: () => {
      const editor = h('textarea', { value: info.summary.text, maxlength: 4000, 'aria-label': T('summary') });
      const save = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(save, async () => { await api(P('/summary'), ui.json('PUT', { text: editor.value, version: info.summary.version })); await refresh(true); }) });
      put(local.summary, editor, h('div', { class: 'actions' }, save, h('button', { type: 'button', text: T('cancel'), onclick: () => refresh(true) })));
      editor.focus();
    } });
    put(local.summary, h('div', { class: 'body', text: info.summary.text || T('no_summary') }),
      info.summary.version ? h('p', { class: 'meta', text: 'v' + info.summary.version + ' · ' + when(info.summary.updated_at) + ' · ' + info.summary.updated_by }) : null, h('div', { class: 'actions' }, editSummary));
    const percent = Math.min(100, info.usage.usedBytes / info.usage.limitBytes * 100);
    put(local.usage, h('span', { class: 'meta' + (percent > 90 ? ' st-FAIL' : ''), text: T('usage') + ' ' + ui.size(info.usage.usedBytes) + ' / ' + ui.size(info.usage.limitBytes) }), h('progress', { max: 100, value: percent }));
    // Statuses for every member (and anyone who reported one).
    const actors = unique([...members(), ...Object.keys(info.statuses)]);
    put(local.statuses, actors.length ? actors.map(actor => {
      const row = info.statuses[actor], member = info.members.find(item => item.name === actor);
      const body = row ? (typeof row.status === 'object' ? kv(Object.entries(row.status)) : h('p', { text: String(row.status) })) : h('p', { class: 'muted', text: T('no_status') });
      return h('section', { class: 'card' }, h('h3', {}, h('span', { class: 'who', text: actor }), ' ', h('span', { class: 'meta', text: member?.role || '' })), body,
        h('p', { class: 'meta', text: (row ? 'v' + row.version + ' · ' + when(row.updated_at) + ' · ' + row.updated_by : '') + (member?.last_seen ? ' · ' + T('last_seen') + ' ' + when(member.last_seen) : '') }));
    }) : h('section', { class: 'card' }, h('p', { class: 'muted', text: T('no_members') })));
    put(local.members, info.members.length ? info.members.map(member => h('div', { class: 'switch-row' },
      h('span', { class: 'who', text: member.name }), h('span', { class: 'meta', style: 'flex:1', text: member.role || '—' }),
      h('button', { type: 'button', class: 'danger', text: '×', title: T('remove'), onclick: event => { if (confirm(T('remove_member_confirm') + '\n' + member.name)) action(event.target, async () => { await api(P('/members/' + enc(member.name)), ui.json('DELETE', { confirm: true })); await refresh(true); }); } }))) : h('p', { class: 'muted', text: T('no_members') }));
    // Module switches, including the viewer's own title.
    const boxes = MODULES.map(module => h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', checked: info.modules[module], 'data-module-box': module }), h('span', { text: module === 'viewer' ? viewerTitle() : T('tab_' + module) }), h('span', { class: 'meta', text: T('module_' + module) })));
    const title = h('input', { value: info.project.viewer_title, maxlength: 60, placeholder: T('tab_viewer'), 'aria-label': T('viewer_title') });
    const saveModules = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(saveModules, async () => {
      const modules = Object.fromEntries(MODULES.map(module => [module, local.modules.querySelector('[data-module-box="' + module + '"]').checked]));
      await api(P('/modules'), ui.json('PUT', { modules, version: info.modules_version, viewer_title: title.value.trim() })); await refresh(true);
    }) });
    put(local.modules, boxes, field(T('viewer_title'), title), h('div', { class: 'actions' }, saveModules));
    const keys = Object.keys(info.switches);
    put(local.switches, keys.length ? keys.map(key => {
      const value = info.switches[key], id = 'switch-' + key.replace(/[^A-Za-z0-9_-]/g, '_');
      const control = typeof value === 'boolean'
        ? h('input', { id, type: 'checkbox', checked: value, onchange: event => action(event.target, () => local.saveSwitches({ ...info.switches, [key]: event.target.checked })) })
        : h('input', { id, type: 'text', value: String(value), onchange: event => action(event.target, () => local.saveSwitches({ ...info.switches, [key]: event.target.value })) });
      const remove = h('button', { type: 'button', class: 'danger', text: '×', title: T('remove'), onclick: event => { if (!confirm(T('remove_switch_confirm') + '\n' + key)) return; const next = { ...info.switches }; delete next[key]; action(event.target, () => local.saveSwitches(next)); } });
      return h('div', { class: 'switch-row' }, h('label', { for: id, text: key }), control, remove);
    }) : h('p', { class: 'muted', text: T('no_switches') }));
    const pending = decisions.decisions.filter(item => item.status === 'open');
    put(local.decisions, !info.modules.decisions ? h('p', { class: 'muted', text: T('decisions_off') }) : pending.length ? pending.map(item => h('div', { class: 'thread decision' + (item.blocking ? ' blocking' : '') },
      h('div', { class: 'msg-head' }, item.kind === 'approve_task' && badge('question', T('approval')), item.blocking && badge('blocker', T('blocking')), h('span', { class: 'who', text: item.raised_by }), item.task_id && badge('info', item.task_id), h('span', { class: 'meta', text: when(item.created_at) })),
      h('p', { class: 'body', text: item.question }), h('button', { type: 'button', text: T('answer_now'), onclick: () => open('decisions') }))) : h('p', { class: 'muted', text: T('no_open_decisions') }));
    put(local.events, events.events.length ? events.events.slice().reverse().map(event => h('div', { class: 'event' }, h('time', { text: when(event.time) }), h('span', { class: 'who', text: event.actor }), h('span', { text: event.summary }))) : h('p', { class: 'muted', text: T('no_events') }));
    local.prompt.value = agentPrompt();
  }
  function agentPrompt() {
    const origin = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.origin : T('site_placeholder');
    return T('prompt_template').replace(/\{site\}/g, origin).replace(/\{project\}/g, state.current).replace(/\{members\}/g, members().join(', ') || 'PC1, server1');
  }

  // ─── Tasks ────────────────────────────────────
  function mountTasks(view, local) {
    local.filter ||= { owner: '', status: '', phase: '' };
    local.ownerSelect = h('select', { onchange: event => { local.filter.owner = event.target.value; refreshTasks(local); } });
    local.statusSelect = select([['', T('all_status')], ...TASK_STATUS.map(item => [item, statusLabel(item)])], local.filter.status, { onchange: event => { local.filter.status = event.target.value; refreshTasks(local); } });
    local.phaseSelect = select([['', T('all_phases')]], local.filter.phase, { onchange: event => { local.filter.phase = event.target.value; refreshTasks(local); } });
    local.table = h('div', { class: 'table-wrap' }); local.detail = h('div');
    const id = h('input', { placeholder: 'T1', maxlength: 32, required: true, 'aria-label': T('task_id') }), title = h('input', { placeholder: T('task_title'), maxlength: 500, required: true, 'aria-label': T('task_title') });
    const owners = h('input', { placeholder: 'PC1, server1', 'aria-label': T('task_owner') }), add = h('button', { type: 'submit', class: 'primary', text: T('add_task') });
    const source = h('textarea', { placeholder: '| ID | 任务 | 负责 | 前置 | 完成标准 | 交给谁 |', 'aria-label': T('import_source') });
    const preview = h('div'), importButton = h('button', { type: 'button', class: 'primary', text: T('import'), disabled: true });
    const promptBox = h('textarea', { readonly: true, style: 'min-height:200px', 'aria-label': T('task_prompt') });
    let parsed = null;
    const previewButton = h('button', { type: 'button', text: T('preview'), onclick: () => {
      parsed = ClipTalkTaskTable.parseTaskTable(source.value, members());
      const problems = [];
      if (!parsed.header) problems.push(T('import_no_header'));
      if (parsed.duplicates.length) problems.push(T('import_duplicates') + ' ' + parsed.duplicates.join(', '));
      for (const problem of parsed.problems) problems.push(T('import_invalid_id') + ' ' + problem.id);
      put(preview,
        problems.length ? h('div', { class: 'notice error' }, problems.map(text => h('div', { text }))) : h('p', { class: 'hint', text: T('import_ready').replace('{n}', parsed.tasks.length) }),
        parsed.tasks.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, [T('task_id'), T('task_title'), T('task_owner'), T('owners_parsed'), T('task_depends')].map(text => h('th', { text })))),
          h('tbody', {}, parsed.tasks.map(task => h('tr', {}, h('td', { class: parsed.duplicates.includes(task.id) ? 'warn' : '', text: task.id }), h('td', { text: task.title }), h('td', { text: task.owner_label }), h('td', { text: task.owners.join(', ') || '—' }), h('td', { text: task.depends || '—' })))))) : null);
      importButton.disabled = !parsed.tasks.length || parsed.duplicates.length > 0 || parsed.problems.length > 0;
    } });
    importButton.onclick = () => action(importButton, async () => {
      const result = await api(P('/tasks/import'), ui.json('POST', { tasks: parsed.tasks }));
      ui.notice(T('import_done').replace('{created}', result.created).replace('{updated}', result.updated));
      source.value = ''; put(preview); importButton.disabled = true; await refreshTasks(local);
    });
    local.promptBox = promptBox;
    view.append(h('section', { class: 'card' },
      h('form', { class: 'compose', onsubmit: event => { event.preventDefault(); action(add, async () => {
        await api(P('/tasks'), ui.json('POST', { id: id.value.trim(), title: title.value.trim(), owners: owners.value.split(/[\s,，、]+/).filter(Boolean) }));
        id.value = ''; title.value = ''; owners.value = ''; await refreshTasks(local);
      }); } }, field(T('task_id'), id), field(T('task_title'), title), field(T('task_owner'), owners), h('div', { class: 'actions', style: 'margin:0' }, add)),
      h('div', { class: 'toolbar', style: 'margin-top:16px' }, field(T('task_owner'), local.ownerSelect), field(T('task_status'), local.statusSelect), field(T('phase'), local.phaseSelect)),
      local.table, local.detail),
    h('details', { class: 'card' }, h('summary', { text: T('import_title') }), h('p', { class: 'hint', text: T('import_hint') }), source, h('div', { class: 'actions' }, previewButton, importButton), preview),
    h('details', { class: 'card' }, h('summary', { text: T('task_prompt') }), h('p', { class: 'hint', text: T('task_prompt_hint') }), promptBox,
      h('div', { class: 'actions' }, h('button', { type: 'button', text: T('copy_prompt'), onclick: () => copyText(promptBox) }))));
  }
  async function refreshTasks(local) {
    local.promptBox.value = ClipTalkTaskTable.taskPrompt(members());
    fill(local.ownerSelect, [['', T('all_owners')], ...recipients().filter(name => name !== 'ALL')], local.filter.owner);
    const all = (await api(P('/tasks'))).tasks;
    const phases = unique(all.map(task => task.phase));
    fill(local.phaseSelect, [['', T('all_phases')], ...phases], local.filter.phase);
    const phaseOrder = new Map(phases.map((item, index) => [item, index]));
    const tasks = all.slice().sort((a, b) => (phaseOrder.get(a.phase) ?? -1) - (phaseOrder.get(b.phase) ?? -1) || a.position - b.position)
      .filter(task => (!local.filter.owner || task.owners.includes(local.filter.owner)) && (!local.filter.status || task.status === local.filter.status) && (!local.filter.phase || task.phase === local.filter.phase));
    const rows = []; let phase = null;
    for (const task of tasks) {
      if (task.phase !== phase) { phase = task.phase; rows.push(h('tr', { class: 'phase' }, h('td', { colspan: 6, text: (phase || '—') + ' · ' + tasks.filter(item => item.phase === phase).length }))); }
      const pick = () => { local.selected = task.id; refreshTasks(local); };
      rows.push(h('tr', { class: 'clickable' + (local.selected === task.id ? ' selected' : ''), tabindex: 0, onclick: pick, onkeydown: event => { if (event.key === 'Enter') pick(); } },
        h('td', { style: 'white-space:nowrap', text: task.id }), h('td', { text: task.title }), h('td', { text: task.owner_label || task.owners.join(', ') || '—' }), h('td', { text: task.depends || '—' }),
        h('td', {}, badge(task.status, statusLabel(task.status))), h('td', { class: 'meta', text: when(task.updated_at) + ' · ' + task.updated_by })));
    }
    put(local.table, h('table', {}, h('thead', {}, h('tr', {}, [T('task_id'), T('task_title'), T('task_owner'), T('task_depends'), T('task_status'), T('updated')].map(text => h('th', { text })))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted', text: all.length ? T('no_match') : T('no_tasks') })))));
    const task = all.find(item => item.id === local.selected);
    if (!task) { put(local.detail); return; }
    const q = '?task=' + enc(task.id), m = state.info.modules;
    const [messages, handoffs, records, decisions] = await Promise.all([m.messages ? api(P('/messages' + q)) : { messages: [] }, m.handoffs ? api(P('/handoffs' + q)) : { handoffs: [] }, api(P('/records' + q + '&limit=1000')), m.decisions ? api(P('/decisions' + q)) : { decisions: [] }]);
    const status = select(TASK_STATUS.map(item => [item, statusLabel(item)]), task.status);
    const notes = h('textarea', { value: task.notes, 'aria-label': T('notes') });
    const save = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(save, async () => {
      await api(P('/tasks/' + enc(task.id)), ui.json('PATCH', { status: status.value, notes: notes.value, version: task.version })); await refreshTasks(local);
    }) });
    const remove = h('button', { type: 'button', class: 'danger', text: T('delete'), onclick: () => { if (confirm(T('delete_task_confirm') + '\n' + task.id)) action(remove, async () => { await api(P('/tasks/' + enc(task.id)), ui.json('DELETE', { confirm: true })); local.selected = null; await refreshTasks(local); }); } });
    const counts = {}; for (const record of records.records) counts[record.status] = (counts[record.status] || 0) + 1;
    put(local.detail, h('section', { class: 'card' }, h('h2', { text: task.id + ' · ' + task.title }),
      kv([[T('done_when'), task.done_when], [T('deliver_to'), task.deliver_to], [T('task_owner'), task.owner_label || task.owners.join(', ')], [T('task_depends'), task.depends], ['version', task.version]]),
      h('div', { class: 'toolbar' }, field(T('task_status'), status)), h('label', { text: T('notes') }), notes, h('div', { class: 'actions' }, save, remove),
      m.messages && [h('h3', { text: T('tab_messages') + ' (' + messages.messages.length + ')' }), messages.messages.slice(-10).map(message => renderMessage(message))],
      m.handoffs && [h('h3', { text: T('tab_handoffs') + ' (' + handoffs.handoffs.length + ')' }), handoffs.handoffs.map(renderHandoff)],
      m.decisions && [h('h3', { text: T('tab_decisions') + ' (' + decisions.decisions.length + ')' }), decisions.decisions.map(item => h('p', {}, badge(item.status, statusLabel(item.status)), ' ', item.question))],
      records.records.length ? [h('h3', { text: T('records') + ' (' + records.records.length + ')' }), h('p', {}, Object.entries(counts).map(([key, count]) => [badge(key, key + ' ' + count), ' ']))] : null));
  }

  // ─── Messages ─────────────────────────────────
  function renderMessage(message, onReply, onDelete) {
    return h('div', { class: 'msg' },
      h('div', { class: 'msg-head' }, h('span', { class: 'who', text: message.from }), '→', h('span', { class: 'who', text: message.to }),
        badge(message.type, statusLabel(message.type)), message.task_id && badge('info', message.task_id), h('span', { class: 'meta', text: message.id + ' · ' + when(message.created_at) + (message.edited_at ? ' · ' + T('edited') : '') }),
        typeof onReply === 'function' && h('button', { type: 'button', text: T('reply'), onclick: () => onReply(message) }),
        typeof onDelete === 'function' && h('button', { type: 'button', class: 'danger', text: T('delete'), onclick: event => onDelete(message, event.target) })),
      h('div', { class: 'body', text: message.body }),
      message.refs?.length ? h('div', { class: 'meta', text: T('refs') + ': ' + message.refs.map(ref => ref.kind + ':' + ref.id).join(', ') }) : null);
  }
  function mountMessages(view, local) {
    local.filter ||= { to: '', task: '' };
    const to = h('select'), type = select(MESSAGE_TYPES.map(item => [item, statusLabel(item)]), 'info');
    const task = h('input', { placeholder: 'T1', maxlength: 32 }), body = h('textarea', { maxlength: 8000, required: true, 'aria-label': T('message_body') });
    const replying = h('div', { class: 'hint' }); let thread = null;
    const setReply = message => {
      thread = message ? message.thread : null; put(replying);
      if (message) {
        to.value = recipients().includes(message.from) ? message.from : 'ALL'; task.value = message.task_id || '';
        put(replying, T('replying_to') + ' ' + message.thread + ' ', h('button', { type: 'button', text: T('cancel'), onclick: () => setReply(null) }));
        body.focus();
      }
    };
    const send = h('button', { type: 'submit', class: 'primary', text: T('send') });
    local.setReply = setReply; local.to = to; local.threads = h('div');
    local.filterTo = h('select', { onchange: event => { local.filter.to = event.target.value; refreshMessages(local); } });
    const filterTask = h('input', { value: local.filter.task, placeholder: T('task_id'), onchange: event => { local.filter.task = event.target.value.trim(); refreshMessages(local); } });
    view.append(h('section', { class: 'card' }, h('h2', { text: T('new_message') }),
      h('form', { class: 'compose', onsubmit: event => { event.preventDefault(); action(send, async () => {
        await api(P('/messages'), ui.json('POST', { to: to.value, type: type.value, task_id: task.value.trim() || undefined, thread: thread || undefined, body: body.value }));
        body.value = ''; setReply(null); await refreshMessages(local);
      }); } },
        field(T('to'), to), field(T('type'), type), field(T('task_id'), task), h('div', { class: 'wide' }, replying, body), h('div', { class: 'actions wide' }, send))),
      h('div', { class: 'toolbar' }, field(T('to'), local.filterTo), field(T('task_id'), filterTask)), local.threads);
  }
  async function refreshMessages(local) {
    const current = local.to.value || 'ALL';
    fill(local.to, recipients().filter(name => name !== 'USER'), recipients().includes(current) ? current : 'ALL');
    fill(local.filterTo, [['', T('all_recipients')], ...recipients().filter(name => name !== 'ALL')], local.filter.to);
    const params = new URLSearchParams({ order: 'desc', limit: '500' });
    if (local.filter.to) params.set('to', local.filter.to);
    if (local.filter.task) params.set('task', local.filter.task);
    const messages = (await api(P('/messages?' + params))).messages;
    const threads = new Map();
    for (const message of messages) { if (!threads.has(message.thread)) threads.set(message.thread, []); threads.get(message.thread).unshift(message); }
    const remove = (message, button) => { if (confirm(T('delete_message_confirm'))) action(button, async () => { await api(P('/messages/' + enc(message.id)), ui.json('DELETE', { confirm: true })); await refreshMessages(local); }); };
    put(local.threads, threads.size ? [...threads.entries()].map(([id, list]) => h('div', { class: 'thread' },
      h('div', { class: 'meta', text: T('thread') + ' ' + id + ' · ' + list.length }), list.map(message => renderMessage(message, local.setReply, remove)))) : h('p', { class: 'muted', text: T('no_messages') }));
  }

  // ─── Decisions ────────────────────────────────
  function mountDecisions(view, local) { local.list = h('div'); view.append(local.list); }
  async function refreshDecisions(local) {
    const list = (await api(P('/decisions'))).decisions.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1));
    put(local.list, list.length ? list.map(item => {
      const submit = (button, answer) => action(button, async () => { await api(P('/decisions/' + enc(item.id) + '/answer'), ui.json('POST', { answer })); await refresh(true); });
      let form;
      if (item.kind === 'approve_task') {
        form = h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', text: T('approve'), onclick: event => submit(event.target, 'approve') }), h('button', { type: 'button', class: 'danger', text: T('reject'), onclick: event => submit(event.target, 'reject') }));
      } else {
        const answer = h('textarea', { maxlength: 8000, 'aria-label': T('your_answer'), placeholder: T('your_answer') });
        const send = h('button', { type: 'button', class: 'primary', text: T('submit_answer'), onclick: () => answer.value.trim() ? submit(send, answer.value) : ui.notice(T('answer_required'), true) });
        form = h('div', {}, item.options.length ? h('div', { class: 'option-row' }, item.options.map(option => h('button', { type: 'button', text: option, onclick: () => { answer.value = option; answer.focus(); } }))) : null, answer, h('div', { class: 'actions' }, send));
      }
      return h('section', { class: 'card decision' + (item.status === 'answered' ? ' answered' : item.blocking ? ' blocking' : '') },
        h('div', { class: 'msg-head' }, badge(item.status, statusLabel(item.status)), item.kind === 'approve_task' && badge('question', T('approval')), item.blocking && badge('blocker', T('blocking')), h('span', { class: 'who', text: item.raised_by }), item.task_id && badge('info', item.task_id), h('span', { class: 'meta', text: item.id + ' · ' + when(item.created_at) })),
        h('p', { class: 'body', text: item.question }),
        item.recommendation ? kv([[T('recommendation'), item.recommendation]]) : null,
        item.status === 'answered' ? [kv([[T('answer'), item.answer], [T('answered_at'), when(item.answered_at)]]), h('details', {}, h('summary', { text: T('change_answer') }), form)] : form);
    }) : h('p', { class: 'muted', text: T('no_decisions') }));
  }

  // ─── Handoffs ─────────────────────────────────
  function openProjectFile(location) {
    const match = /^project:(.+)$/.exec(location);
    if (!match) return;
    if (state.info.modules.viewer) { state.tabs.viewer = { ...(state.tabs.viewer || {}), file: match[1] }; open('viewer'); }
    else { state.tabs.files = { ...(state.tabs.files || {}), file: match[1], path: match[1].split('/').slice(0, -1).join('/') }; open('files'); }
  }
  function renderHandoff(item) {
    return h('div', { class: 'thread' },
      h('div', { class: 'msg-head' }, badge(item.status, statusLabel(item.status)), h('span', { class: 'who', text: item.from }), '→', h('span', { class: 'who', text: item.to }), badge('info', item.task_id),
        item.evidence_level && badge('info', item.evidence_level), h('span', { class: 'meta', text: item.id + ' · ' + when(item.created_at) }),
        item.supersedes && h('span', { class: 'meta', text: T('supersedes') + ' ' + item.supersedes }), item.superseded_by && badge('NATIVE_FAILED', T('superseded_by') + ' ' + item.superseded_by)),
      h('p', { class: 'body', text: item.summary }),
      kv([[T('conditions'), Object.entries(item.conditions || {}).map(([key, value]) => key + '=' + value).join(' ')], [T('limitations'), (item.limitations || []).join('\n')], [T('next_action'), item.next_action]]),
      item.files?.length ? h('div', { class: 'table-wrap', style: 'margin-top:8px' }, h('table', {}, h('thead', {}, h('tr', {}, [T('file'), T('location'), 'SHA-256', T('format_note'), ''].map(text => h('th', { text })))),
        h('tbody', {}, item.files.map(file => h('tr', {}, h('td', { text: file.name }), h('td', { text: file.location }), h('td', { title: file.sha256 || '', text: file.sha256 ? file.sha256.slice(0, 12) + '…' : '—' }), h('td', { text: file.format_note || '—' }),
          h('td', {}, /^project:/.test(file.location) ? h('button', { type: 'button', text: T('view'), onclick: () => openProjectFile(file.location) }) : null)))))) : null,
      (item.refs || []).filter(ref => ref.kind === 'view' && state.info.modules.viewer).map(ref => h('button', { type: 'button', text: T('view') + ' ' + ref.id, onclick: () => { state.tabs.viewer = { ...(state.tabs.viewer || {}), view: ref.id }; open('viewer'); } })));
  }
  function mountHandoffs(view, local) {
    local.taskSelect = h('select', { onchange: event => { local.task = event.target.value; refreshHandoffs(local); } });
    local.list = h('div');
    view.append(h('div', { class: 'toolbar' }, field(T('task_id'), local.taskSelect)), local.list);
  }
  async function refreshHandoffs(local) {
    const all = (await api(P('/handoffs'))).handoffs;
    fill(local.taskSelect, [['', T('all')], ...unique(all.map(item => item.task_id)).sort()], local.task || '');
    const shown = all.filter(item => !local.task || item.task_id === local.task).reverse();
    const groups = new Map(); for (const item of shown) { if (!groups.has(item.task_id)) groups.set(item.task_id, []); groups.get(item.task_id).push(item); }
    put(local.list, groups.size ? [...groups.entries()].map(([task, list]) => h('section', { class: 'card' }, h('h2', { text: task + ' · ' + list.length }), list.map(renderHandoff))) : h('p', { class: 'muted', text: T('no_handoffs') }));
  }

  // ─── File preview (shared by files and viewer) ─
  async function preview(container, file, { editable = false, onSaved } = {}) {
    const head = h('div', { class: 'section-head' }, h('h3', { text: file.path }), h('span', { class: 'meta', text: ui.size(file.size) + ' · ' + when(file.time) }),
      h('a', { class: 'button', href: rawUrl(file.path), text: T('download') }));
    if (IMAGE.test(file.path)) return put(container, head, h('img', { src: rawUrl(file.path), alt: file.path, class: 'preview-image' }));
    if (!TEXT.test(file.path) && file.name.includes('.')) return put(container, head, h('p', { class: 'muted', text: T('no_preview') }));
    if (file.size > 1024 * 1024) return put(container, head, h('p', { class: 'muted', text: T('too_large_preview') }));
    const data = await api(P('/files/content?path=' + enc(file.path)));
    let body;
    if (TABLE.test(file.path)) body = csvTable(data.content, /\.tsv$/i.test(file.path) ? '\t' : ',');
    else if (/\.json$/i.test(file.path)) { try { body = h('pre', { class: 'code', text: JSON.stringify(JSON.parse(data.content), null, 2) }); } catch { body = h('pre', { class: 'code', text: data.content }); } }
    else body = h('pre', { class: 'code', text: data.content || '—' });
    const edit = editable && h('button', { type: 'button', text: T('edit'), onclick: () => {
      const editor = h('textarea', { value: data.content, style: 'min-height:50vh', 'aria-label': file.path });
      const save = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(save, async () => {
        await api(P('/files/content'), ui.json('PUT', { path: file.path, content: editor.value, etag: data.etag })); onSaved?.();
      }) });
      put(container, head, editor, h('div', { class: 'actions' }, save, h('button', { type: 'button', text: T('cancel'), onclick: () => preview(container, file, { editable, onSaved }) })));
    } });
    put(container, head, edit && h('div', { class: 'actions', style: 'margin:0 0 10px' }, edit), body);
  }
  function parseCsv(text, separator) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
      else if (c === '"') quoted = true;
      else if (c === separator) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(Boolean)) rows.push(row); row = []; }
      else cell += c;
    }
    row.push(cell); if (row.some(Boolean)) rows.push(row);
    return rows;
  }
  function csvTable(text, separator) {
    const rows = parseCsv(text, separator), header = rows[0] || [], data = rows.slice(1);
    const numeric = header.map((_, index) => data.length > 0 && data.every(row => row[index] === undefined || row[index] === '' || Number.isFinite(Number(row[index]))));
    const xs = h('select'), ys = h('select'), chart = h('div', { class: 'chart' });
    const draw = () => {
      const x = Number(xs.value), y = Number(ys.value);
      const points = data.filter(row => row[y] !== '' && Number.isFinite(Number(row[y]))).map((row, index) => ({ id: 'row ' + (index + 2), value: Number(row[y]), metric: header[y], status: 'NO_LIMIT', case_id: row[x], conditions: { [header[x]]: numeric[x] ? Number(row[x]) : row[x] } }));
      put(chart, drawChart(points, header[x], 'candidate'));
    };
    const numericColumns = header.map((name, index) => [String(index), name]).filter(([index]) => numeric[Number(index)]);
    const table = h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, header.map(name => h('th', { text: name })))),
      h('tbody', {}, data.slice(0, 500).map(row => h('tr', {}, header.map((_, index) => h('td', { class: numeric[index] ? 'num' : '', text: row[index] ?? '' })))))));
    const out = h('div', {}, data.length > 500 ? h('p', { class: 'hint', text: T('rows_shown').replace('{n}', data.length) }) : null, table);
    if (numericColumns.length && data.length > 1) {
      fill(xs, header.map((name, index) => [String(index), name]), '0'); fill(ys, numericColumns, numericColumns[numericColumns.length > 1 ? 1 : 0][0]);
      xs.onchange = draw; ys.onchange = draw;
      out.append(h('div', { class: 'toolbar', style: 'margin-top:12px' }, field(T('x_axis'), xs), field(T('value'), ys)), chart); draw();
    }
    return out;
  }

  // ─── Files ────────────────────────────────────
  function mountFiles(view, local) {
    local.path ||= '';
    local.crumbs = h('div', { class: 'crumbs' }); local.list = h('div', { class: 'table-wrap' }); local.preview = h('div');
    const newName = h('input', { placeholder: T('new_file_hint'), 'aria-label': T('new_file') });
    const picker = h('input', { type: 'file', multiple: true, 'aria-label': T('upload') });
    const upload = h('button', { type: 'button', text: T('upload'), onclick: () => action(upload, async () => {
      if (!picker.files.length) throw new Error('no_files');
      const body = new FormData(); for (const file of picker.files) body.append('files', file, file.name);
      await api(P('/files/upload?path=' + enc(local.path)), { method: 'POST', body }); picker.value = ''; await refreshFiles(local);
    }) });
    view.append(h('section', { class: 'card' }, h('p', { class: 'hint', text: T('files_hint') }), local.crumbs,
      h('div', { class: 'toolbar' },
        h('form', { class: 'actions', style: 'margin:0', onsubmit: event => { event.preventDefault(); const name = newName.value.trim(); if (!name) return; local.file = (local.path ? local.path + '/' : '') + name; local.creating = true; newName.value = ''; refreshFiles(local); } }, newName, h('button', { type: 'submit', text: T('new_file') })),
        h('div', { class: 'actions', style: 'margin:0' }, picker, upload)),
      h('div', { class: 'circuit-layout' }, local.list, local.preview)));
  }
  async function refreshFiles(local) {
    let listing;
    try { listing = await api(P('/files?path=' + enc(local.path))); }
    catch (error) { if (error.status === 404 && local.path) { local.path = ''; return refreshFiles(local); } throw error; }
    const parts = local.path ? local.path.split('/') : [];
    put(local.crumbs, h('button', { type: 'button', text: '📁 ' + state.info.project.name, onclick: () => { local.path = ''; local.file = null; refreshFiles(local); } }),
      parts.map((part, index) => [' / ', h('button', { type: 'button', text: part, onclick: () => { local.path = parts.slice(0, index + 1).join('/'); local.file = null; refreshFiles(local); } })]));
    const rows = [
      ...listing.folders.map(folderPath => h('tr', { class: 'clickable', tabindex: 0, onclick: () => { local.path = folderPath; local.file = null; refreshFiles(local); } },
        h('td', { text: '📁 ' + folderPath.split('/').pop() }), h('td'), h('td'), h('td'))),
      ...listing.files.map(file => h('tr', { class: 'clickable' + (local.file === file.path ? ' selected' : ''), tabindex: 0, onclick: () => { local.file = file.path; local.creating = false; refreshFiles(local); } },
        h('td', { text: '📄 ' + file.name }), h('td', { class: 'num', text: ui.size(file.size) }), h('td', { class: 'meta', text: when(file.time) }),
        h('td', {}, h('button', { type: 'button', class: 'danger', text: '×', title: T('delete'), onclick: event => { event.stopPropagation(); if (confirm(T('delete_file_confirm') + '\n' + file.path)) action(event.target, async () => { await api(P('/files'), ui.json('DELETE', { path: file.path, confirm: true })); if (local.file === file.path) local.file = null; await refreshFiles(local); }); } })))),
    ];
    put(local.list, h('table', { style: 'min-width:0' }, h('thead', {}, h('tr', {}, [T('file'), T('size'), T('updated'), ''].map(text => h('th', { text })))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 4, class: 'muted', text: T('empty_folder') })))));
    if (local.creating && local.file) {
      const editor = h('textarea', { style: 'min-height:40vh', 'aria-label': local.file });
      const save = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(save, async () => { await api(P('/files/content'), ui.json('PUT', { path: local.file, content: editor.value })); local.creating = false; await refreshFiles(local); }) });
      return put(local.preview, h('h3', { text: local.file }), editor, h('div', { class: 'actions' }, save));
    }
    const file = listing.files.find(item => item.path === local.file);
    if (!file) return put(local.preview, h('p', { class: 'muted', text: T('pick_file') }));
    await preview(local.preview, file, { editable: TEXT.test(file.path) || !file.name.includes('.'), onSaved: () => refreshFiles(local) });
  }

  // ─── Viewer: deliverable files, graphs and records ─
  function mountViewer(view, local) {
    local.filter ||= { task: '', candidate: '', metric: '', status: '', node: '' };
    local.fileList = h('div'); local.filePreview = h('div');
    local.viewSelect = h('select', { onchange: event => { local.view = event.target.value; local.version = ''; local.compare = ''; refreshViewer(local); } });
    local.versionSelect = h('select', { onchange: event => { local.version = event.target.value; refreshViewer(local); } });
    local.compareSelect = h('select', { onchange: event => { local.compare = event.target.value; refreshViewer(local); } });
    local.graph = h('div', { class: 'svg-wrap' }); local.graphInfo = h('div');
    local.filters = h('div', { class: 'toolbar' }); local.table = h('div', { class: 'table-wrap' }); local.chartControls = h('div', { class: 'toolbar' }); local.chart = h('div', { class: 'chart' });
    local.dataSection = h('div', {},
      h('section', { class: 'card' }, h('h2', { text: T('data_views') }),
        h('div', { class: 'toolbar' }, field(T('view_name'), local.viewSelect), field(T('version'), local.versionSelect), field(T('compare_with'), local.compareSelect)),
        h('div', { class: 'circuit-layout' },
          h('div', {}, local.graph, h('div', { class: 'legend' }, ['PASS', 'FAIL', 'INCOMPLETE', 'NO_LIMIT'].map(key => h('span', {}, h('i', { style: 'background:var(--' + { PASS: 'pass', FAIL: 'fail', INCOMPLETE: 'warn', NO_LIMIT: 'neutral' }[key] + ')' }), statusLabel(key)))), local.graphInfo),
          h('div', {}, h('h3', { text: T('chart') }), local.chartControls, local.chart))),
      h('section', { class: 'card' }, h('h2', { text: T('records') }), local.filters, local.table));
    view.append(h('section', { class: 'card' }, h('h2', { text: viewerTitle() + ' · ' + T('deliverable_files') }), h('p', { class: 'hint', text: T('deliverable_files_hint') }), h('div', { class: 'circuit-layout' }, local.fileList, local.filePreview)), local.dataSection);
  }
  async function refreshViewer(local) {
    const [files, views] = await Promise.all([api(P('/files?path=deliverables&recursive=1')).catch(() => ({ files: [] })), api(P('/views'))]);
    put(local.fileList, files.files.length ? h('div', { class: 'table-wrap' }, h('table', { style: 'min-width:0' }, h('tbody', {}, files.files.map(file => h('tr', { class: 'clickable' + (local.file === file.path ? ' selected' : ''), tabindex: 0, onclick: () => { local.file = file.path; refreshViewer(local); } },
      h('td', { text: file.path.replace(/^deliverables\//, '') }), h('td', { class: 'num', text: ui.size(file.size) }), h('td', { class: 'meta', text: when(file.time) })))))) : h('p', { class: 'muted', text: T('no_deliverables') }));
    const file = files.files.find(item => item.path === local.file);
    if (file) await preview(local.filePreview, file); else put(local.filePreview, h('p', { class: 'muted', text: T('pick_file') }));
    local.dataSection.hidden = !views.views.length;
    if (!views.views.length) return;
    if (!views.views.some(item => item.view === local.view)) local.view = views.views[0].view;
    put(local.viewSelect, views.views.map(item => h('option', { value: item.view, text: item.view + ' (' + (item.latest_version ? 'v' + item.latest_version : T('no_graph')) + ', ' + item.records + ')' })));
    local.viewSelect.value = local.view;
    const c = '/views/' + enc(local.view);
    const versions = (await api(P(c + '/graphs'))).versions;
    const versionOptions = versions.map(item => [String(item.version), 'v' + item.version + (item.candidate ? ' · ' + item.candidate : '') + ' · ' + when(item.created_at)]);
    fill(local.versionSelect, [['', T('latest')], ...versionOptions], local.version || '');
    fill(local.compareSelect, [['', T('no_compare')], ...versionOptions], local.compare || '');
    const [graph, compare, summary, records] = await Promise.all([
      versions.length ? api(P(c + '/graph' + (local.version ? '?version=' + enc(local.version) : ''))) : null,
      local.compare ? api(P(c + '/graph?version=' + enc(local.compare))) : null,
      api(P(c + '/summary')), loadRecords(c)]);
    local.records = records; local.summary = summary.nodes; local.graphData = graph?.graph; local.compareData = compare?.graph;
    drawGraph(local, local.graphData, local.compareData);
    drawRecords(local);
  }
  async function loadRecords(c) {
    const all = []; let since = '';
    for (let page = 0; page < 10; page++) {
      const data = await api(P(c + '/records?limit=1000' + (since ? '&since=' + enc(since) : '')));
      all.push(...data.records); if (!data.next) break; since = data.next;
    }
    return all;
  }
  function drawGraph(local, graph, compare) {
    put(local.graphInfo);
    if (!graph) { put(local.graph, h('p', { class: 'muted', style: 'padding:16px', text: T('no_graph_hint') })); return; }
    const layout = layoutGraph(graph);
    const diff = compare ? diffGraph(graph, compare) : null;
    const svg = s('svg', { width: layout.width, height: layout.height, viewBox: '0 0 ' + layout.width + ' ' + layout.height, role: 'img', 'aria-label': (graph.view || '') + ' graph' },
      s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor' }))));
    for (const band of layout.bands) svg.append(s('rect', { class: 'topo-group', x: 8, y: band.y, width: layout.width - 16, height: band.height, rx: 10 }), s('text', { class: 'topo-group-label', x: 18, y: band.y + 17 }, band.label));
    for (const edge of layout.edges) svg.append(s('path', { class: 'topo-edge k-' + (edge.kind || 'signal') + (diff?.addedEdges.has(edge.key) ? ' diff-added' : ''), d: edge.d, 'marker-end': 'url(#arrow)', style: 'color:var(--dim)' }, svgTitle([edge.from + ' → ' + edge.to, edge.net, edge.kind].filter(Boolean).join('\n'))));
    for (const node of layout.nodes) {
      const nodeState = local.summary?.[node.id]?.state;
      const classes = ['topo-node', local.filter.node === node.id ? 'selected' : '', diff?.added.has(node.id) ? 'diff-added' : '', diff?.changed.has(node.id) ? 'diff-changed' : ''].join(' ');
      const group = s('g', { class: classes, transform: 'translate(' + node.x + ',' + node.y + ')', tabindex: 0, role: 'button', 'aria-label': node.id },
        svgTitle([node.id + (node.kind ? ' (' + node.kind + ')' : ''), node.subckt, node.params && Object.keys(node.params).length ? JSON.stringify(node.params) : '', nodeState ? statusLabel(nodeState) : ''].filter(Boolean).join('\n')),
        shape(node.kind, layout.nodeW, layout.nodeH),
        s('text', { x: layout.nodeW / 2, y: layout.nodeH / 2 - 2, 'text-anchor': 'middle' }, truncate(node.label || node.id, 18)),
        s('text', { class: 'kind', x: layout.nodeW / 2, y: layout.nodeH / 2 + 12, 'text-anchor': 'middle' }, node.kind || ''),
        nodeState ? s('circle', { class: 'dot-' + nodeState, cx: layout.nodeW - 7, cy: 7, r: 5.5 }) : null);
      const pick = () => { local.filter.node = local.filter.node === node.id ? '' : node.id; drawGraph(local, graph, compare); drawRecords(local); };
      group.addEventListener('click', pick); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } });
      svg.append(group);
    }
    put(local.graph, svg);
    const info = [kv([[T('candidate'), graph.candidate], [T('level'), graph.level], [T('nodes'), graph.nodes.length], [T('source'), graph.source ? JSON.stringify(graph.source) : '']])];
    if (diff) info.push(h('p', { class: 'hint', text: T('diff_summary').replace('{added}', diff.added.size).replace('{changed}', diff.changed.size).replace('{removed}', diff.removed.length).replace('{edges_added}', diff.addedEdges.size).replace('{edges_removed}', diff.removedEdges) + (diff.removed.length ? ' — ' + T('removed') + ': ' + diff.removed.join(', ') : '') }));
    if (graph.notes) info.push(h('div', { class: 'body', text: graph.notes }));
    put(local.graphInfo, info);
  }
  function shape(kind, w, hgt) {
    const k = String(kind || '');
    if (/^(lnta|lna|vga|tia|driver|buffer|amp\w*)$/.test(k)) return s('path', { d: `M0,0 L${w - 16},0 L${w},${hgt / 2} L${w - 16},${hgt} L0,${hgt} Z` });
    if (/^(mixer|balun|switch)$/.test(k)) return s('rect', { width: w, height: hgt, rx: hgt / 2 });
    if (/(adc|dac|comparator)$/.test(k)) return s('path', { d: `M0,0 L${w - 12},0 L${w},${hgt / 2} L${w - 12},${hgt} L0,${hgt} L10,${hgt / 2} Z` });
    if (/^(pll|dco|vco|divider|clock)$/.test(k)) return s('path', { d: `M12,0 L${w - 12},0 L${w},${hgt / 2} L${w - 12},${hgt} L12,${hgt} L0,${hgt / 2} Z` });
    if (/^(ldo|bandgap|vsrc|isrc|power|supply)$/.test(k)) return s('g', {}, s('rect', { width: w, height: hgt, rx: 2 }), s('rect', { x: 4, y: 4, width: w - 8, height: hgt - 8, rx: 2 }));
    if (/^(digital|cpu|mcu|fpga|software)$/.test(k)) return s('path', { d: `M0,0 L${w},0 L${w},${hgt} L10,${hgt} L0,${hgt - 10} Z` });
    if (/^(port|io|input|output)$/.test(k)) return s('circle', { cx: w / 2, cy: hgt / 2, r: hgt / 2 - 2 });
    return s('rect', { width: w, height: hgt, rx: 7 });
  }
  // Layered layout: break cycles with DFS, rank by longest path along data
  // edges, stack nodes of each group in its own horizontal band.
  function layoutGraph(graph) {
    const nodes = graph.nodes, ids = new Set(nodes.map(node => node.id));
    const endpoint = value => ids.has(value) ? value : value.includes('.') && ids.has(value.slice(0, value.lastIndexOf('.'))) ? value.slice(0, value.lastIndexOf('.')) : null;
    const edges = (graph.edges || []).map((edge, index) => ({ ...edge, index, a: endpoint(edge.from), b: endpoint(edge.to) })).filter(edge => edge.a && edge.b);
    const flow = edges.filter(edge => edge.a !== edge.b && !['supply', 'bias'].includes(edge.kind));
    const out = new Map(nodes.map(node => [node.id, []]));
    for (const edge of flow) out.get(edge.a).push(edge);
    const mark = new Map(), back = new Set();
    const visit = id => { mark.set(id, 1); for (const edge of out.get(id)) { if (mark.get(edge.b) === 1) back.add(edge.index); else if (!mark.get(edge.b)) visit(edge.b); } mark.set(id, 2); };
    for (const node of nodes) if (!mark.get(node.id)) visit(node.id);
    const dag = flow.filter(edge => !back.has(edge.index)), indegree = new Map(nodes.map(node => [node.id, 0])), rank = new Map(nodes.map(node => [node.id, 0]));
    for (const edge of dag) indegree.set(edge.b, indegree.get(edge.b) + 1);
    const queue = nodes.filter(node => !indegree.get(node.id)).map(node => node.id);
    while (queue.length) {
      const id = queue.shift();
      for (const edge of dag.filter(item => item.a === id)) { rank.set(edge.b, Math.max(rank.get(edge.b), rank.get(id) + 1)); indegree.set(edge.b, indegree.get(edge.b) - 1); if (!indegree.get(edge.b)) queue.push(edge.b); }
    }
    const used = [...new Set(rank.values())].sort((a, b) => a - b), column = new Map(used.map((value, index) => [value, index]));
    const groups = [...(graph.groups || []).map(group => ({ id: group.id, label: group.label || group.id })), { id: '', label: '' }];
    const nodeW = 132, nodeH = 46, colW = 178, rowH = 66, pad = 30, placed = new Map(), bands = [];
    let y = 12;
    for (const group of groups) {
      const groupNodes = nodes.filter(node => (node.group || '') === group.id || (group.id === '' && node.group && !groups.some(item => item.id === node.group)));
      if (!groupNodes.length) continue;
      const columns = new Map();
      for (const node of groupNodes) { const index = column.get(rank.get(node.id)); if (!columns.has(index)) columns.set(index, []); columns.get(index).push(node); }
      let rows = 1;
      for (const [index, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
        const weight = node => { const rowsOf = dag.filter(edge => edge.b === node.id && placed.has(edge.a)).map(edge => placed.get(edge.a).row); return rowsOf.length ? rowsOf.reduce((a, b) => a + b, 0) / rowsOf.length : Infinity; };
        list.sort((a, b) => weight(a) - weight(b));
        list.forEach((node, row) => placed.set(node.id, { ...node, row, x: pad + index * colW, y: y + 26 + row * rowH }));
        rows = Math.max(rows, list.length);
      }
      const height = 26 + rows * rowH;
      bands.push({ y, height, label: group.label });
      y += height + 12;
    }
    const width = Math.max(320, pad * 2 + used.length * colW - (colW - nodeW));
    const lines = edges.map(edge => {
      const a = placed.get(edge.a), b = placed.get(edge.b);
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
      let d;
      if (edge.a === edge.b) d = `M${x1},${y1 - 8} C${x1 + 30},${y1 - 40} ${b.x - 30},${y2 - 40} ${x2},${y2 - 8}`;
      else if (x2 > x1) { const mid = (x1 + x2) / 2; d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`; }
      else { const top = Math.min(a.y, b.y) - 18; d = `M${a.x + nodeW / 2},${a.y} C${a.x + nodeW / 2},${top} ${b.x + nodeW / 2},${top} ${b.x + nodeW / 2},${b.y}`; }
      return { d, kind: edge.kind, net: edge.net, from: edge.from, to: edge.to, key: edge.from + '|' + edge.to + '|' + (edge.kind || '') };
    });
    return { nodes: [...placed.values()], edges: lines, bands, width, height: y, nodeW, nodeH };
  }
  function diffGraph(current, previous) {
    const before = new Map(previous.nodes.map(node => [node.id, node])), now = new Set(current.nodes.map(node => node.id)), added = new Set(), changed = new Set();
    for (const node of current.nodes) {
      const old = before.get(node.id);
      if (!old) added.add(node.id);
      else if ((old.kind || '') !== (node.kind || '') || (old.group || '') !== (node.group || '') || (old.label || '') !== (node.label || '') || JSON.stringify(old.params || {}) !== JSON.stringify(node.params || {})) changed.add(node.id);
    }
    const key = edge => edge.from + '|' + edge.to + '|' + (edge.kind || '');
    const oldEdges = new Set((previous.edges || []).map(key)), newEdges = new Set((current.edges || []).map(key));
    return { added, changed, removed: previous.nodes.filter(node => !now.has(node.id)).map(node => node.id),
      addedEdges: new Set([...newEdges].filter(item => !oldEdges.has(item))), removedEdges: [...oldEdges].filter(item => !newEdges.has(item)).length };
  }
  function drawRecords(local) {
    const records = local.records || [], f = local.filter;
    const options = key => unique(records.map(record => record[key])).sort();
    const make = (key, label, values) => field(label, select([['', T('all')], ...values], f[key], { onchange: event => { f[key] = event.target.value; drawRecords(local); if (key === 'node') drawGraph(local, local.graphData, local.compareData); } }));
    put(local.filters, make('task', T('task_id'), options('task_id')), make('candidate', T('candidate'), options('candidate')), make('metric', T('metric'), options('metric')),
      make('status', T('result_status'), options('status').map(item => [item, statusLabel(item)])), make('node', T('node'), options('node')));
    const shown = records.filter(record => (!f.task || record.task_id === f.task) && (!f.candidate || record.candidate === f.candidate) && (!f.metric || record.metric === f.metric) && (!f.status || record.status === f.status) && (!f.node || record.node === f.node));
    const superseded = new Set(records.map(record => record.supersedes).filter(Boolean));
    const limitText = limit => !limit ? '—' : limit.op === 'between' ? limit.value.join('…') : limit.op + ' ' + limit.value;
    put(local.table, h('table', {}, h('thead', {}, h('tr', {}, ['ID', T('task_id'), T('candidate'), T('case'), T('node'), T('metric'), T('value'), T('limit'), T('result_status'), T('evidence'), T('conditions'), T('updated')].map(text => h('th', { text })))),
      h('tbody', {}, shown.length ? shown.slice().reverse().slice(0, 1000).map(record => h('tr', { style: superseded.has(record.id) ? 'opacity:.5' : null, title: superseded.has(record.id) ? T('superseded') : null },
        h('td', { text: record.id }), h('td', { text: record.task_id || '—' }), h('td', { text: record.candidate || '—' }), h('td', { text: record.case_id || '—' }), h('td', { text: record.node || '—' }),
        h('td', { text: record.metric }), h('td', { class: 'num', text: record.value === undefined || record.value === null ? '—' : record.value + (record.unit ? ' ' + record.unit : '') }),
        h('td', { text: limitText(record.limit), title: record.limit?.ref || null }), h('td', {}, badge(record.status, statusLabel(record.status))), h('td', { text: record.evidence_level || '—' }),
        h('td', { class: 'meta', text: Object.entries(record.conditions || {}).map(([key, value]) => key + '=' + value).join(' ') }), h('td', { class: 'meta', text: when(record.created_at) + ' · ' + record.created_by }))) : h('tr', {}, h('td', { colspan: 12, class: 'muted', text: T('no_records') })))));
    const numericMetric = metric => shown.some(record => record.metric === metric && typeof record.value === 'number');
    const metrics = options('metric').sort((a, b) => numericMetric(b) - numericMetric(a));
    local.chartMetric = metrics.includes(local.chartMetric) ? local.chartMetric : (f.metric || metrics[0] || '');
    const pool = shown.filter(record => record.metric === local.chartMetric && typeof record.value === 'number' && !superseded.has(record.id));
    const xKeys = ['case_id', ...unique(pool.flatMap(record => Object.keys(record.conditions || {})))];
    local.chartX = xKeys.includes(local.chartX) ? local.chartX : (xKeys.find(key => key !== 'case_id' && pool.every(record => typeof record.conditions?.[key] === 'number')) || 'case_id');
    const seriesKeys = ['candidate', ...xKeys.filter(key => key !== 'case_id' && key !== local.chartX)];
    const varying = key => unique(pool.map(record => String(record.conditions?.[key] ?? ''))).length > 1;
    if (!seriesKeys.includes(local.chartSeries)) local.chartSeries = seriesKeys.find(key => key !== 'candidate' && varying(key) && pool.some(record => typeof record.conditions?.[key] === 'string')) || 'candidate';
    put(local.chartControls,
      field(T('metric'), select(metrics, local.chartMetric, { onchange: event => { local.chartMetric = event.target.value; drawRecords(local); } })),
      field(T('x_axis'), select(xKeys.map(key => [key, key === 'case_id' ? T('case') : key]), local.chartX, { onchange: event => { local.chartX = event.target.value; drawRecords(local); } })),
      field(T('series'), select(seriesKeys.map(key => [key, key === 'candidate' ? T('candidate') : key]), local.chartSeries, { onchange: event => { local.chartSeries = event.target.value; drawRecords(local); } })));
    put(local.chart, drawChart(pool, local.chartX, local.chartSeries));
  }
  function drawChart(points, xKey, seriesKey = 'candidate') {
    if (!points.length) return h('p', { class: 'muted', text: T('no_chart') });
    const seriesOf = record => String((seriesKey === 'candidate' ? record.candidate : record.conditions?.[seriesKey]) ?? '—');
    const xOf = record => xKey === 'case_id' ? record.case_id : record.conditions?.[xKey];
    const numeric = points.every(record => typeof xOf(record) === 'number');
    const categories = numeric ? [] : unique(points.map(record => String(xOf(record) ?? '—')));
    const xs = points.map(record => numeric ? xOf(record) : categories.indexOf(String(xOf(record) ?? '—')));
    const limits = unique(points.flatMap(record => record.limit ? (record.limit.op === 'between' ? record.limit.value : [record.limit.value]) : []));
    const ys = [...points.map(record => record.value), ...limits];
    const W = 560, H = 300, L = 56, R = 16, Tp = 14, B = 54;
    const span = (min, max) => min === max ? [min - 1, max + 1] : [min - (max - min) * 0.06, max + (max - min) * 0.06];
    const [x0, x1] = numeric ? span(Math.min(...xs), Math.max(...xs)) : [-0.5, categories.length - 0.5];
    const [y0, y1] = span(Math.min(...ys), Math.max(...ys));
    const X = value => L + (value - x0) / (x1 - x0) * (W - L - R), Y = value => H - B - (value - y0) / (y1 - y0) * (H - Tp - B);
    const ticks = (min, max) => { const step = Math.pow(10, Math.floor(Math.log10((max - min) / 5 || 1))), size = [1, 2, 5, 10].map(m => m * step).find(m => (max - min) / m <= 6) || step * 10; const list = []; for (let v = Math.ceil(min / size) * size; v <= max + 1e-12; v += size) list.push(+v.toPrecision(10)); return list; };
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T('chart') },
      s('line', { class: 'axis', x1: L, y1: H - B, x2: W - R, y2: H - B }), s('line', { class: 'axis', x1: L, y1: Tp, x2: L, y2: H - B }));
    for (const value of ticks(y0, y1)) svg.append(s('line', { class: 'axis', x1: L - 4, x2: W - R, y1: Y(value), y2: Y(value), opacity: 0.35 }), s('text', { class: 'tick', x: L - 6, y: Y(value) + 3, 'text-anchor': 'end' }, String(value)));
    if (numeric) for (const value of ticks(x0, x1)) svg.append(s('text', { class: 'tick', x: X(value), y: H - B + 14, 'text-anchor': 'middle' }, String(value)));
    else categories.forEach((label, index) => { if (categories.length <= 40 || index % Math.ceil(categories.length / 40) === 0) svg.append(s('text', { class: 'tick', x: X(index), y: H - B + 14, 'text-anchor': 'end', transform: `rotate(-30 ${X(index)} ${H - B + 14})` }, truncate(label, 18))); });
    for (const value of limits) svg.append(s('line', { class: 'limit', x1: L, x2: W - R, y1: Y(value), y2: Y(value) }, svgTitle(T('limit') + ' ' + value)));
    const series = unique(points.map(seriesOf));
    series.forEach((name, index) => {
      const color = COLORS[index % COLORS.length];
      const list = points.map((record, i) => ({ record, x: xs[i] })).filter(item => seriesOf(item.record) === name).sort((a, b) => a.x - b.x);
      // Only connect points when each x appears once in the series; otherwise a line would mix conditions.
      if (numeric && list.length > 1 && new Set(list.map(item => item.x)).size === list.length) svg.append(s('path', { class: 'series-line', stroke: color, d: list.map((item, i) => (i ? 'L' : 'M') + X(item.x) + ',' + Y(item.record.value)).join(' ') }));
      for (const item of list) svg.append(s('circle', { cx: X(item.x), cy: Y(item.record.value), r: 4, fill: item.record.status === 'FAIL' ? 'var(--fail)' : color, stroke: color, 'stroke-width': 1.5 },
        svgTitle(`${item.record.id} · ${name}\n${xKey}=${xOf(item.record)}\n${item.record.metric}=${item.record.value}${item.record.unit ? ' ' + item.record.unit : ''} · ${item.record.status}`)));
    });
    return h('div', {}, svg, h('div', { class: 'legend' }, series.length > 1 || series[0] !== '—' ? series.map((name, index) => h('span', {}, h('i', { style: 'background:' + COLORS[index % COLORS.length] }), name)) : null, limits.length ? h('span', { class: 'st-FAIL', text: '- - ' + T('limit') }) : null));
  }

  // ─── Startup ──────────────────────────────────
  try {
    await ui.init('project.title');
    const params = new URLSearchParams(location.search);
    async function loadProjects(preferred) {
      state.projects = (await api('')).projects;
      const picker = $('project-select');
      put(picker, state.projects.map(project => h('option', { value: project.id, text: project.name + ' (' + project.id + ')' })));
      state.current = state.projects.some(project => project.id === preferred) ? preferred : state.projects[0]?.id || null;
      picker.value = state.current || '';
      picker.hidden = !state.projects.length;
      $('empty-state').hidden = !!state.current; $('project-tabs').hidden = !state.current;
      if (!state.current) put($('project-view'));
    }
    await loadProjects(params.get('p'));
    $('project-select').onchange = event => { state.current = event.target.value; state.tabs = {}; state.info = null; open(state.tab); };
    document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => open(button.dataset.tab); });
    const dialog = $('new-project-dialog');
    $('project-new').onclick = () => { $('new-project-form').reset(); dialog.showModal(); };
    $('new-project-cancel').onclick = () => dialog.close();
    $('new-project-form').onsubmit = async event => {
      event.preventDefault();
      const modules = Object.fromEntries([...document.querySelectorAll('[data-new-module]')].map(box => [box.dataset.newModule, box.checked]));
      const ok = await action(event.submitter, async () => {
        const created = await api('', ui.json('POST', { id: $('new-project-id').value.trim(), name: $('new-project-name').value.trim() || undefined, modules }));
        dialog.close(); state.tabs = {}; state.info = null; await loadProjects(created.id); await open('overview');
      });
      if (!ok) dialog.close();
    };
    if (state.current) await open(params.get('tab') || 'overview');
    if (typeof io === 'function') {
      const socket = io({ transports: ['websocket', 'polling'] });
      const live = $('live-state');
      socket.on('connect', () => { live.textContent = T('live'); live.classList.add('on'); });
      socket.on('disconnect', () => { live.textContent = T('offline'); live.classList.remove('on'); });
      live.onclick = () => { if (!socket.connected) socket.connect(); };
      socket.on('project-updated', async payload => {
        if (payload.type === 'project_deleted' || payload.type === 'project') { const keep = state.current; await loadProjects(keep); if (state.current && state.current !== keep) { state.info = null; open('overview'); } return; }
        if (payload.project === state.current) scheduleRefresh();
      });
      socket.on('preferences-updated', value => ClipTalkTheme.update?.(value));
      socket.on('site-updated', site => ui.updateSite(site));
    }
  } catch (error) { if (error.message !== 'unauthorized') report(error); }
})();
