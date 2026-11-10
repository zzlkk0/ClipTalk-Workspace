'use strict';
// Project collaboration page. All user and agent text is inserted with
// textContent; nothing from the server is parsed as HTML.
(async () => {
  const ui = ClipTalkUI, $ = id => document.getElementById(id);
  const T = key => ui.t('project.' + key);
  const ACTORS = ['SERVER', 'PC'];
  const TASK_STATUS = ['todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'];
  const RESULT_STATUS = ['PASS', 'FAIL', 'NO_LIMIT', 'NATIVE_FAILED', 'BLOCKED'];
  const MESSAGE_TYPES = ['info', 'question', 'answer', 'blocker', 'handoff_notice'];
  const COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7'];
  const state = { projects: [], current: null, tab: 'overview', tabs: {}, view: null, timer: null };

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
  const fill = (target, options, value) => { put(target, ...select(options, value).children); target.value = value; };
  const field = (label, control) => h('div', { class: 'field' }, h('label', { text: label }), control);
  const kv = entries => h('dl', { class: 'kv' }, entries.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [h('dt', { text: key }), h('dd', {}, value instanceof Node ? value : Array.isArray(value) && value.every(item => typeof item !== 'object') ? (value.join(', ') || '—') : typeof value === 'object' ? JSON.stringify(value, null, 1) : String(value))]));
  const unique = list => [...new Set(list.filter(item => item !== undefined && item !== null && item !== ''))];
  function report(error) {
    if (error?.status === 409) ui.notice(T('conflict'), true);
    else ui.notice(ui.error(error?.message || 'server_error'), true);
  }
  const api = (path, options) => ui.api('/api/projects' + path, options);
  const P = path => '/' + encodeURIComponent(state.current) + path;
  const enc = encodeURIComponent;
  async function action(button, work) {
    if (button) button.disabled = true;
    try { await work(); return true; } catch (error) { report(error); return false; } finally { if (button) button.disabled = false; }
  }

  // ─── Tabs ─────────────────────────────────────
  const TABS = {
    overview: { mount: mountOverview, refresh: refreshOverview },
    tasks: { mount: mountTasks, refresh: refreshTasks },
    messages: { mount: mountMessages, refresh: refreshMessages },
    decisions: { mount: mountDecisions, refresh: refreshDecisions },
    circuits: { mount: mountCircuits, refresh: refreshCircuits },
    texts: { mount: mountTexts, refresh: refreshTexts },
    handoffs: { mount: mountHandoffs, refresh: refreshHandoffs },
  };
  async function open(tab) {
    state.tab = TABS[tab] ? tab : 'overview';
    document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === state.tab)));
    const params = new URLSearchParams(location.search); params.set('p', state.current); params.set('tab', state.tab);
    history.replaceState(null, '', '?' + params);
    const view = $('project-view'); put(view, );
    state.view = state.tabs[state.tab] ||= {};
    TABS[state.tab].mount(view, state.view);
    await refresh();
  }
  async function refresh() {
    if (!state.current) return;
    try { await TABS[state.tab].refresh(state.view); await counts(); } catch (error) { report(error); }
  }
  function scheduleRefresh() { clearTimeout(state.timer); state.timer = setTimeout(refresh, 350); }
  async function counts() {
    const data = await api(P('/state'));
    const tab = document.querySelector('[data-tab="decisions"]');
    tab.querySelector('.count')?.remove();
    if (data.open_decisions) tab.append(h('span', { class: 'count', title: T('open_decisions'), text: data.open_decisions }));
    return data;
  }

  // ─── Overview ─────────────────────────────────
  function mountOverview(view, local) {
    local.statuses = h('div', { class: 'grid2' });
    local.switches = h('div'); local.decisions = h('div'); local.events = h('div');
    const name = h('input', { placeholder: 'PLL_PAUSED', pattern: '[A-Za-z0-9_.:-]{1,64}', 'aria-label': T('switch_name') });
    const add = h('button', { type: 'submit', text: T('add_switch') });
    const form = h('form', { class: 'actions', onsubmit: async event => {
      event.preventDefault();
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name.value)) return ui.notice(T('invalid_switch'), true);
      await action(add, () => saveSwitches({ ...local.data.switches, [name.value]: true }));
      name.value = '';
    } }, name, add);
    view.append(local.statuses,
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', { text: T('blocking_first') }), local.decisions),
        h('section', { class: 'card' }, h('h2', { text: T('switches') }), h('p', { class: 'hint', text: T('switches_hint') }), local.switches, form)),
      h('section', { class: 'card' }, h('h2', { text: T('recent_events') }), local.events));
    async function saveSwitches(switches) {
      try { await api(P('/state'), ui.json('PUT', { switches, version: local.data.switches_version })); }
      finally { await refreshOverview(local); }
    }
    local.saveSwitches = saveSwitches;
  }
  async function refreshOverview(local) {
    const data = local.data = await api(P('/state'));
    const [decisions, events] = await Promise.all([api(P('/decisions?status=open')), api(P('/events?since=' + Math.max(0, data.cursor - 40)))]);
    put(local.statuses, ...unique([...ACTORS, ...Object.keys(data.statuses)]).map(actor => {
      const row = data.statuses[actor];
      const body = row ? (typeof row.status === 'object' ? kv(Object.entries(row.status)) : h('p', { text: String(row.status) })) : h('p', { class: 'muted', text: T('no_status') });
      return h('section', { class: 'card' }, h('h3', {}, h('span', { class: 'who who-' + actor, text: actor }), ' ', h('span', { class: 'meta', text: T('status') })), body,
        row && h('p', { class: 'meta', text: 'v' + row.version + ' · ' + when(row.updated_at) + ' · ' + row.updated_by }));
    }));
    const keys = Object.keys(data.switches);
    put(local.switches, ...(keys.length ? keys.map(key => {
      const value = data.switches[key], id = 'switch-' + key.replace(/[^A-Za-z0-9_-]/g, '_');
      const control = typeof value === 'boolean'
        ? h('input', { id, type: 'checkbox', checked: value, onchange: event => action(event.target, () => local.saveSwitches({ ...data.switches, [key]: event.target.checked })) })
        : h('input', { id, type: 'text', value: String(value), onchange: event => action(event.target, () => local.saveSwitches({ ...data.switches, [key]: event.target.value })) });
      const remove = h('button', { type: 'button', class: 'danger', text: '×', title: T('remove'), onclick: event => { if (!confirm(T('remove_switch_confirm') + '\n' + key)) return; const next = { ...data.switches }; delete next[key]; action(event.target, () => local.saveSwitches(next)); } });
      return h('div', { class: 'switch-row' }, h('label', { for: id, text: key }), control, remove);
    }) : [h('p', { class: 'muted', text: T('no_switches') })]));
    const pending = decisions.decisions.filter(item => item.status === 'open');
    put(local.decisions, ...(pending.length ? pending.map(item => h('div', { class: 'thread decision' + (item.blocking ? ' blocking' : '') },
      h('div', { class: 'msg-head' }, item.blocking && badge('blocker', T('blocking')), h('span', { class: 'who who-' + item.raised_by, text: item.raised_by }), item.task_id && badge('info', item.task_id), h('span', { class: 'meta', text: when(item.created_at) })),
      h('p', { class: 'body', text: item.question }), h('button', { type: 'button', text: T('answer_now'), onclick: () => open('decisions') }))) : [h('p', { class: 'muted', text: T('no_open_decisions') })]));
    put(local.events, ...(events.events.length ? events.events.slice().reverse().map(event => h('div', { class: 'event' }, h('time', { text: when(event.time) }), h('span', { class: 'who who-' + event.actor, text: event.actor }), h('span', { text: event.summary }))) : [h('p', { class: 'muted', text: T('no_events') })]));
  }

  // ─── Tasks ────────────────────────────────────
  function mountTasks(view, local) {
    local.filter ||= { owner: '', status: '', phase: '' };
    local.ownerSelect = select([['', T('all_owners')], 'SERVER', 'PC', 'USER'], local.filter.owner, { onchange: event => { local.filter.owner = event.target.value; refreshTasks(local); } });
    local.statusSelect = select([['', T('all_status')], ...TASK_STATUS.map(item => [item, statusLabel(item)])], local.filter.status, { onchange: event => { local.filter.status = event.target.value; refreshTasks(local); } });
    local.phaseSelect = select([['', T('all_phases')]], local.filter.phase, { onchange: event => { local.filter.phase = event.target.value; refreshTasks(local); } });
    local.table = h('div', { class: 'table-wrap' }); local.detail = h('div');
    const source = h('textarea', { placeholder: '| ID | 任务 | 负责 | 前置 | 完成标准 | 交给谁 |', 'aria-label': T('import_source') });
    const preview = h('div'), importButton = h('button', { type: 'button', class: 'primary', text: T('import'), disabled: true });
    let parsed = null;
    const previewButton = h('button', { type: 'button', text: T('preview'), onclick: () => {
      parsed = ClipTalkTaskTable.parseTaskTable(source.value);
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
      source.value = ''; put(preview, ); importButton.disabled = true; await refreshTasks(local);
    });
    view.append(h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, field(T('task_owner'), local.ownerSelect), field(T('task_status'), local.statusSelect), field(T('phase'), local.phaseSelect)),
      local.table, local.detail),
    h('details', { class: 'card' }, h('summary', { text: T('import_title') }), h('p', { class: 'hint', text: T('import_hint') }), source, h('div', { class: 'actions' }, previewButton, importButton), preview));
  }
  async function refreshTasks(local) {
    const all = (await api(P('/tasks'))).tasks;
    const phases = unique(all.map(task => task.phase));
    fill(local.phaseSelect, [['', T('all_phases')], ...phases], local.filter.phase);
    const phaseOrder = new Map(phases.map((item, index) => [item, index]));
    const tasks = all.slice().sort((a, b) => phaseOrder.get(a.phase) - phaseOrder.get(b.phase) || a.position - b.position).filter(task => (!local.filter.owner || task.owners.includes(local.filter.owner)) && (!local.filter.status || task.status === local.filter.status) && (!local.filter.phase || task.phase === local.filter.phase));
    const rows = [];
    let phase = null;
    for (const task of tasks) {
      if (task.phase !== phase) { phase = task.phase; rows.push(h('tr', { class: 'phase' }, h('td', { colspan: 6, text: (phase || '—') + ' · ' + tasks.filter(item => item.phase === phase).length }))); }
      rows.push(h('tr', { class: 'clickable' + (local.selected === task.id ? ' selected' : ''), tabindex: 0, onclick: () => { local.selected = task.id; refreshTasks(local); }, onkeydown: event => { if (event.key === 'Enter') { local.selected = task.id; refreshTasks(local); } } },
        h('td', { style: 'white-space:nowrap', text: task.id }), h('td', { text: task.title }), h('td', { text: task.owner_label || task.owners.join(', ') || '—' }), h('td', { text: task.depends || '—' }),
        h('td', {}, badge(task.status, statusLabel(task.status))), h('td', { class: 'meta', text: when(task.updated_at) + ' · ' + task.updated_by })));
    }
    put(local.table, h('table', {}, h('thead', {}, h('tr', {}, [T('task_id'), T('task_title'), T('task_owner'), T('task_depends'), T('task_status'), T('updated')].map(text => h('th', { text })))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted', text: all.length ? T('no_match') : T('no_tasks') })))));
    const task = all.find(item => item.id === local.selected);
    if (!task) { put(local.detail, ); return; }
    const q = '?task=' + enc(task.id);
    const [messages, handoffs, results, decisions] = await Promise.all([api(P('/messages' + q)), api(P('/handoffs' + q)), api(P('/results' + q + '&limit=1000')), api(P('/decisions' + q))]);
    const status = select(TASK_STATUS.map(item => [item, statusLabel(item)]), task.status);
    const notes = h('textarea', { value: task.notes, 'aria-label': T('notes') });
    const save = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(save, async () => {
      await api(P('/tasks/' + enc(task.id)), ui.json('PATCH', { status: status.value, notes: notes.value, version: task.version })); await refreshTasks(local);
    }) });
    const resultCounts = {}; for (const result of results.results) resultCounts[result.status] = (resultCounts[result.status] || 0) + 1;
    put(local.detail, h('section', { class: 'card' }, h('h2', { text: task.id + ' · ' + task.title }),
      kv([[T('done_when'), task.done_when], [T('deliver_to'), task.deliver_to], [T('task_owner'), task.owner_label], [T('task_depends'), task.depends], ['version', task.version]]),
      h('div', { class: 'toolbar' }, field(T('task_status'), status)), h('label', { text: T('notes') }), notes, h('div', { class: 'actions' }, save),
      h('h3', { text: T('tab_messages') + ' (' + messages.messages.length + ')' }), messages.messages.slice(-10).map(renderMessage),
      h('h3', { text: T('tab_handoffs') + ' (' + handoffs.handoffs.length + ')' }), handoffs.handoffs.map(renderHandoff),
      h('h3', { text: T('tab_decisions') + ' (' + decisions.decisions.length + ')' }), decisions.decisions.map(item => h('p', {}, badge(item.status, statusLabel(item.status)), ' ', item.question)),
      h('h3', { text: T('results') + ' (' + results.results.length + ')' }), h('p', {}, Object.entries(resultCounts).map(([key, count]) => [badge(key, key + ' ' + count), ' ']))));
  }

  // ─── Messages ─────────────────────────────────
  function renderMessage(message, onReply, onDelete) {
    return h('div', { class: 'msg' },
      h('div', { class: 'msg-head' }, h('span', { class: 'who who-' + message.from, text: message.from }), '→', h('span', { class: 'who who-' + message.to, text: message.to }),
        badge(message.type, statusLabel(message.type)), message.task_id && badge('info', message.task_id), h('span', { class: 'meta', text: message.id + ' · ' + when(message.created_at) }),
        typeof onReply === 'function' && h('button', { type: 'button', text: T('reply'), onclick: () => onReply(message) }),
        typeof onDelete === 'function' && h('button', { type: 'button', class: 'danger', text: T('delete'), onclick: event => onDelete(message, event.target) })),
      h('div', { class: 'body', text: message.body }),
      message.refs?.length ? h('div', { class: 'meta', text: T('refs') + ': ' + message.refs.map(ref => ref.kind + ':' + ref.id).join(', ') }) : null);
  }
  function mountMessages(view, local) {
    local.filter ||= { to: '', task: '' };
    const to = select(['SERVER', 'PC', 'ALL'], 'ALL'), type = select(MESSAGE_TYPES.map(item => [item, statusLabel(item)]), 'info');
    const task = h('input', { placeholder: 'I3', maxlength: 32 }), body = h('textarea', { maxlength: 8000, required: true, 'aria-label': T('message_body') });
    const replying = h('div', { class: 'hint' }); let thread = null;
    const setReply = message => {
      thread = message ? message.thread : null; put(replying, );
      if (message) {
        to.value = ['SERVER', 'PC', 'ALL'].includes(message.from) ? message.from : 'ALL'; task.value = message.task_id || '';
        replying.append(T('replying_to') + ' ' + message.thread + ' ', h('button', { type: 'button', text: T('cancel'), onclick: () => setReply(null) }));
        body.focus();
      }
    };
    const send = h('button', { type: 'submit', class: 'primary', text: T('send') });
    local.setReply = setReply;
    local.threads = h('div');
    const filterTo = select([['', T('all_recipients')], 'SERVER', 'PC', 'USER'], local.filter.to, { onchange: event => { local.filter.to = event.target.value; refreshMessages(local); } });
    const filterTask = h('input', { value: local.filter.task, placeholder: T('task_id'), onchange: event => { local.filter.task = event.target.value.trim(); refreshMessages(local); } });
    view.append(h('section', { class: 'card' }, h('h2', { text: T('new_message') }),
      h('form', { class: 'compose', onsubmit: event => { event.preventDefault(); action(send, async () => {
        await api(P('/messages'), ui.json('POST', { to: to.value, type: type.value, task_id: task.value.trim() || undefined, thread: thread || undefined, body: body.value }));
        body.value = ''; setReply(null); await refreshMessages(local);
      }); } },
        field(T('to'), to), field(T('type'), type), field(T('task_id'), task), h('div', { class: 'wide' }, replying, body), h('div', { class: 'actions wide' }, send))),
      h('div', { class: 'toolbar' }, field(T('to'), filterTo), field(T('task_id'), filterTask)), local.threads);
  }
  async function refreshMessages(local) {
    const params = new URLSearchParams({ order: 'desc', limit: '500' });
    if (local.filter.to) params.set('to', local.filter.to);
    if (local.filter.task) params.set('task', local.filter.task);
    const messages = (await api(P('/messages?' + params))).messages;
    const threads = new Map();
    for (const message of messages) { if (!threads.has(message.thread)) threads.set(message.thread, []); threads.get(message.thread).unshift(message); }
    const remove = (message, button) => { if (confirm(T('delete_message_confirm'))) action(button, async () => { await api(P('/messages/' + enc(message.id)), ui.json('DELETE', { confirm: true })); await refreshMessages(local); }); };
    put(local.threads, ...(threads.size ? [...threads.entries()].map(([id, list]) => h('div', { class: 'thread' },
      h('div', { class: 'meta', text: T('thread') + ' ' + id + ' · ' + list.length }), list.map(message => renderMessage(message, local.setReply, remove)))) : [h('p', { class: 'muted', text: T('no_messages') })]));
  }

  // ─── Decisions ────────────────────────────────
  function mountDecisions(view, local) { local.list = h('div'); view.append(local.list); }
  async function refreshDecisions(local) {
    const list = (await api(P('/decisions'))).decisions.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1));
    put(local.list, ...(list.length ? list.map(item => {
      const answer = h('textarea', { maxlength: 8000, 'aria-label': T('your_answer'), placeholder: T('your_answer') });
      const submit = h('button', { type: 'button', class: 'primary', text: T('submit_answer'), onclick: () => {
        if (!answer.value.trim()) return ui.notice(T('answer_required'), true);
        action(submit, async () => { await api(P('/decisions/' + enc(item.id) + '/answer'), ui.json('POST', { answer: answer.value })); await refreshDecisions(local); });
      } });
      const form = h('div', {}, item.options.length ? h('div', { class: 'option-row' }, item.options.map(option => h('button', { type: 'button', text: option, onclick: () => { answer.value = option + (answer.value && !item.options.includes(answer.value) ? '\n' + answer.value : ''); answer.focus(); } }))) : null,
        answer, h('div', { class: 'actions' }, submit));
      return h('section', { class: 'card decision' + (item.status === 'answered' ? ' answered' : item.blocking ? ' blocking' : '') },
        h('div', { class: 'msg-head' }, badge(item.status, statusLabel(item.status)), item.blocking && badge('blocker', T('blocking')), h('span', { class: 'who who-' + item.raised_by, text: item.raised_by }), item.task_id && badge('info', item.task_id), h('span', { class: 'meta', text: item.id + ' · ' + when(item.created_at) })),
        h('p', { class: 'body', text: item.question }),
        item.recommendation ? kv([[T('recommendation'), item.recommendation]]) : null,
        item.status === 'answered' ? [kv([[T('answer'), item.answer], [T('answered_at'), when(item.answered_at)]]), h('details', {}, h('summary', { text: T('change_answer') }), form)] : form);
    }) : [h('p', { class: 'muted', text: T('no_decisions') })]));
  }

  // ─── Circuits ─────────────────────────────────
  function mountCircuits(view, local) {
    local.filter ||= { task: '', candidate: '', metric: '', status: '', node: '' };
    local.circuitSelect = h('select', { onchange: event => { local.circuit = event.target.value; local.version = ''; local.compare = ''; refreshCircuits(local); } });
    local.versionSelect = h('select', { onchange: event => { local.version = event.target.value; refreshCircuits(local); } });
    local.compareSelect = h('select', { onchange: event => { local.compare = event.target.value; refreshCircuits(local); } });
    local.graph = h('div', { class: 'svg-wrap' }); local.graphInfo = h('div');
    local.filters = h('div', { class: 'toolbar' }); local.table = h('div', { class: 'table-wrap' }); local.chartControls = h('div', { class: 'toolbar' }); local.chart = h('div', { class: 'chart' });
    view.append(h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, field(T('circuit'), local.circuitSelect), field(T('version'), local.versionSelect), field(T('compare_with'), local.compareSelect)),
      h('div', { class: 'circuit-layout' },
        h('div', {}, local.graph, h('div', { class: 'legend' }, ['PASS', 'FAIL', 'INCOMPLETE', 'NO_LIMIT'].map(key => h('span', {}, h('i', { style: 'background:var(--' + { PASS: 'pass', FAIL: 'fail', INCOMPLETE: 'warn', NO_LIMIT: 'neutral' }[key] + ')' }), statusLabel(key)))), local.graphInfo),
        h('div', {}, h('h3', { text: T('chart') }), local.chartControls, local.chart))),
      h('section', { class: 'card' }, h('h2', { text: T('results') }), local.filters, local.table));
  }
  async function refreshCircuits(local) {
    const circuits = (await api(P('/circuits'))).circuits;
    if (!circuits.length) {
      put(local.circuitSelect, h('option', { text: '—' }));
      put(local.graph, h('p', { class: 'muted', style: 'padding:16px', text: T('no_circuits') })); put(local.table, ); put(local.chart, ); put(local.filters, ); put(local.chartControls, ); put(local.graphInfo, );
      return;
    }
    if (!circuits.some(item => item.circuit === local.circuit)) local.circuit = circuits[0].circuit;
    put(local.circuitSelect, ...circuits.map(item => h('option', { value: item.circuit, selected: item.circuit === local.circuit ? true : undefined, text: item.circuit + ' (' + (item.latest_version ? 'v' + item.latest_version : T('no_topology')) + ', ' + item.results + ')' })));
    const c = '/circuits/' + enc(local.circuit);
    const versions = (await api(P(c + '/topologies'))).versions;
    const versionOptions = versions.map(item => [String(item.version), 'v' + item.version + ' · ' + (item.candidate || '') + ' · ' + when(item.created_at)]);
    fill(local.versionSelect, [['', T('latest')], ...versionOptions], local.version || '');
    fill(local.compareSelect, [['', T('no_compare')], ...versionOptions], local.compare || '');
    const [topology, compare, summary, results] = await Promise.all([
      versions.length ? api(P(c + '/topology' + (local.version ? '?version=' + enc(local.version) : ''))) : null,
      local.compare ? api(P(c + '/topology?version=' + enc(local.compare))) : null,
      api(P(c + '/summary')), loadResults(c)]);
    local.results = results; local.summary = summary.nodes; local.topology = topology?.topology; local.compareTopology = compare?.topology;
    drawTopology(local, local.topology, local.compareTopology);
    drawResults(local);
  }
  async function loadResults(c) {
    const all = []; let since = '';
    for (let page = 0; page < 10; page++) {
      const data = await api(P(c + '/results?limit=1000' + (since ? '&since=' + enc(since) : '')));
      all.push(...data.results); if (!data.next) break; since = data.next;
    }
    return all;
  }
  function drawTopology(local, topology, compare) {
    put(local.graphInfo, );
    if (!topology) { put(local.graph, h('p', { class: 'muted', style: 'padding:16px', text: T('no_topology_hint') })); return; }
    const layout = layoutTopology(topology);
    const diff = compare ? diffTopology(topology, compare) : null;
    const svg = s('svg', { width: layout.width, height: layout.height, viewBox: '0 0 ' + layout.width + ' ' + layout.height, role: 'img', 'aria-label': topology.circuit + ' topology' },
      s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor', class: 'topo-arrow' }))));
    for (const band of layout.bands) svg.append(s('rect', { class: 'topo-group', x: 8, y: band.y, width: layout.width - 16, height: band.height, rx: 10 }), s('text', { class: 'topo-group-label', x: 18, y: band.y + 17 }, band.label));
    for (const edge of layout.edges) {
      const path = s('path', { class: 'topo-edge k-' + (edge.kind || 'signal') + (diff?.addedEdges.has(edge.key) ? ' diff-added' : ''), d: edge.d, 'marker-end': 'url(#arrow)', style: 'color:var(--dim)' }, svgTitle([edge.from + ' → ' + edge.to, edge.net, edge.kind].filter(Boolean).join('\n')));
      svg.append(path);
    }
    for (const node of layout.nodes) {
      const state = local.summary?.[node.id]?.state;
      const classes = ['topo-node', local.filter.node === node.id ? 'selected' : '', diff?.added.has(node.id) ? 'diff-added' : '', diff?.changed.has(node.id) ? 'diff-changed' : ''].join(' ');
      const group = s('g', { class: classes, transform: 'translate(' + node.x + ',' + node.y + ')', tabindex: 0, role: 'button', 'aria-label': node.id },
        svgTitle([node.id + ' (' + node.kind + ')', node.subckt, node.params && Object.keys(node.params).length ? JSON.stringify(node.params) : '', state ? statusLabel(state) : ''].filter(Boolean).join('\n')),
        shape(node.kind, layout.nodeW, layout.nodeH),
        s('text', { x: layout.nodeW / 2, y: layout.nodeH / 2 - 2, 'text-anchor': 'middle' }, truncate(node.label || node.id, 18)),
        s('text', { class: 'kind', x: layout.nodeW / 2, y: layout.nodeH / 2 + 12, 'text-anchor': 'middle' }, node.kind),
        state ? s('circle', { class: 'dot-' + state, cx: layout.nodeW - 7, cy: 7, r: 5.5 }) : null);
      const pick = () => { local.filter.node = local.filter.node === node.id ? '' : node.id; drawTopology(local, topology, compare); drawResults(local); };
      group.addEventListener('click', pick); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); } });
      svg.append(group);
    }
    put(local.graph, svg);
    const info = [kv([[T('candidate'), topology.candidate], [T('level'), topology.level], [T('nodes'), topology.nodes.length], [T('source'), topology.source ? JSON.stringify(topology.source) : '']])];
    if (diff) info.push(h('p', { class: 'hint', text: T('diff_summary').replace('{added}', diff.added.size).replace('{changed}', diff.changed.size).replace('{removed}', diff.removed.length).replace('{edges_added}', diff.addedEdges.size).replace('{edges_removed}', diff.removedEdges) + (diff.removed.length ? ' — ' + T('removed') + ': ' + diff.removed.join(', ') : '') }));
    if (topology.notes) info.push(h('div', { class: 'body', text: topology.notes }));
    put(local.graphInfo, ...info);
  }
  const truncate = (value, max) => value.length > max ? value.slice(0, max - 1) + '…' : value;
  function shape(kind, w, hgt) {
    if (['lnta', 'lna', 'vga', 'tia', 'driver', 'buffer'].includes(kind)) return s('path', { d: `M0,0 L${w - 16},0 L${w},${hgt / 2} L${w - 16},${hgt} L0,${hgt} Z` });
    if (['mixer', 'balun', 'switch'].includes(kind)) return s('rect', { width: w, height: hgt, rx: hgt / 2 });
    if (['sar_adc', 'adc', 'dac', 'comparator'].includes(kind)) return s('path', { d: `M0,0 L${w - 12},0 L${w},${hgt / 2} L${w - 12},${hgt} L0,${hgt} L10,${hgt / 2} Z` });
    if (['pll', 'dco', 'vco', 'divider'].includes(kind)) return s('path', { d: `M12,0 L${w - 12},0 L${w},${hgt / 2} L${w - 12},${hgt} L12,${hgt} L0,${hgt / 2} Z` });
    if (['ldo', 'bandgap', 'vsrc', 'isrc'].includes(kind)) return s('g', {}, s('rect', { width: w, height: hgt, rx: 2 }), s('rect', { x: 4, y: 4, width: w - 8, height: hgt - 8, rx: 2 }));
    if (kind === 'digital') return s('path', { d: `M0,0 L${w},0 L${w},${hgt} L10,${hgt} L0,${hgt - 10} Z` });
    if (kind === 'port') return s('circle', { cx: w / 2, cy: hgt / 2, r: hgt / 2 - 2 });
    return s('rect', { width: w, height: hgt, rx: 7 });
  }
  // Layered layout: break cycles with DFS, rank by longest path along signal
  // edges, stack nodes of each group in its own horizontal band.
  function layoutTopology(topology) {
    const nodes = topology.nodes, ids = new Set(nodes.map(node => node.id));
    const endpoint = value => ids.has(value) ? value : value.includes('.') && ids.has(value.slice(0, value.lastIndexOf('.'))) ? value.slice(0, value.lastIndexOf('.')) : null;
    const edges = (topology.edges || []).map((edge, index) => ({ ...edge, index, a: endpoint(edge.from), b: endpoint(edge.to) })).filter(edge => edge.a && edge.b);
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
    const groups = [...(topology.groups || []).map(group => ({ id: group.id, label: group.label || group.id })), { id: '', label: '' }];
    const nodeW = 132, nodeH = 46, colW = 178, rowH = 66, pad = 30;
    const placed = new Map(), bands = [];
    let y = 12;
    for (const group of groups) {
      const members = nodes.filter(node => (node.group || '') === group.id || (group.id === '' && node.group && !groups.some(item => item.id === node.group)));
      if (!members.length) continue;
      const columns = new Map();
      for (const node of members) { const index = column.get(rank.get(node.id)); if (!columns.has(index)) columns.set(index, []); columns.get(index).push(node); }
      let rows = 1;
      for (const [index, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
        // Order by the average row of already placed predecessors to reduce crossings.
        const weight = node => { const rowsOf = dag.filter(edge => edge.b === node.id && placed.has(edge.a)).map(edge => placed.get(edge.a).row); return rowsOf.length ? rowsOf.reduce((a, b) => a + b, 0) / rowsOf.length : Infinity; };
        list.sort((a, b) => weight(a) - weight(b));
        list.forEach((node, row) => placed.set(node.id, { ...node, row, x: pad + index * colW, y: y + 26 + row * rowH }));
        rows = Math.max(rows, list.length);
      }
      const height = 26 + rows * rowH;
      if (group.id || groups.length === 1 || members.length) bands.push({ y, height, label: group.label });
      y += height + 12;
    }
    const width = Math.max(320, pad * 2 + used.length * colW - (colW - nodeW));
    const height = y;
    const lines = edges.map(edge => {
      const a = placed.get(edge.a), b = placed.get(edge.b);
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
      let d;
      if (edge.a === edge.b) d = `M${x1},${y1 - 8} C${x1 + 30},${y1 - 40} ${b.x - 30},${y2 - 40} ${x2},${y2 - 8}`;
      else if (x2 > x1) { const mid = (x1 + x2) / 2; d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`; }
      else { const top = Math.min(a.y, b.y) - 18; d = `M${a.x + nodeW / 2},${a.y} C${a.x + nodeW / 2},${top} ${b.x + nodeW / 2},${top} ${b.x + nodeW / 2},${b.y}`; }
      return { d, kind: edge.kind, net: edge.net, from: edge.from, to: edge.to, key: edge.from + '|' + edge.to + '|' + (edge.kind || '') };
    });
    return { nodes: [...placed.values()], edges: lines, bands, width, height, nodeW, nodeH };
  }
  function diffTopology(current, previous) {
    const before = new Map(previous.nodes.map(node => [node.id, node]));
    const now = new Set(current.nodes.map(node => node.id));
    const added = new Set(), changed = new Set();
    for (const node of current.nodes) {
      const old = before.get(node.id);
      if (!old) added.add(node.id);
      else if (old.kind !== node.kind || (old.group || '') !== (node.group || '') || (old.label || '') !== (node.label || '') || JSON.stringify(old.params || {}) !== JSON.stringify(node.params || {})) changed.add(node.id);
    }
    const key = edge => edge.from + '|' + edge.to + '|' + (edge.kind || '');
    const oldEdges = new Set((previous.edges || []).map(key)), newEdges = new Set((current.edges || []).map(key));
    return { added, changed, removed: previous.nodes.filter(node => !now.has(node.id)).map(node => node.id),
      addedEdges: new Set([...newEdges].filter(item => !oldEdges.has(item))), removedEdges: [...oldEdges].filter(item => !newEdges.has(item)).length };
  }
  function drawResults(local) {
    const results = local.results || [], f = local.filter;
    const options = key => unique(results.map(result => result[key])).sort();
    const make = (key, label, values) => field(label, select([['', T('all')], ...values], f[key], { onchange: event => { f[key] = event.target.value; drawResults(local); if (key === 'node') drawTopology(local, local.topology, local.compareTopology); } }));
    put(local.filters, make('task', T('task_id'), options('task_id')), make('candidate', T('candidate'), options('candidate')), make('metric', T('metric'), options('metric')),
      make('status', T('result_status'), RESULT_STATUS.map(item => [item, statusLabel(item)])), make('node', T('node'), options('node')));
    const shown = results.filter(result => (!f.task || result.task_id === f.task) && (!f.candidate || result.candidate === f.candidate) && (!f.metric || result.metric === f.metric) && (!f.status || result.status === f.status) && (!f.node || result.node === f.node));
    const superseded = new Set(results.map(result => result.supersedes).filter(Boolean));
    const limitText = limit => !limit ? '—' : limit.op === 'between' ? limit.value.join('…') : limit.op + ' ' + limit.value;
    put(local.table, h('table', {}, h('thead', {}, h('tr', {}, ['ID', T('task_id'), T('candidate'), T('case'), T('node'), T('metric'), T('value'), T('limit'), T('result_status'), T('evidence'), T('conditions'), T('updated')].map(text => h('th', { text })))),
      h('tbody', {}, shown.length ? shown.slice().reverse().slice(0, 1000).map(result => h('tr', { style: superseded.has(result.id) ? 'opacity:.5' : null, title: superseded.has(result.id) ? T('superseded') : null },
        h('td', { text: result.id }), h('td', { text: result.task_id || '—' }), h('td', { text: result.candidate || '—' }), h('td', { text: result.case_id || '—' }), h('td', { text: result.node || '—' }),
        h('td', { text: result.metric }), h('td', { class: 'num', text: result.value === undefined || result.value === null ? '—' : result.value + (result.unit ? ' ' + result.unit : '') }),
        h('td', { text: limitText(result.limit), title: result.limit?.ref || null }), h('td', {}, badge(result.status, statusLabel(result.status))), h('td', { text: result.evidence_level || '—' }),
        h('td', { class: 'meta', text: Object.entries(result.conditions || {}).map(([key, value]) => key + '=' + value).join(' ') }), h('td', { class: 'meta', text: when(result.created_at) + ' · ' + result.created_by }))) : h('tr', {}, h('td', { colspan: 12, class: 'muted', text: T('no_results') })))));
    // Chart: one metric against one condition, one series per candidate.
    const numericMetric = metric => shown.some(result => result.metric === metric && typeof result.value === 'number');
    const metrics = options('metric').sort((a, b) => numericMetric(b) - numericMetric(a));
    local.chartMetric = metrics.includes(local.chartMetric) ? local.chartMetric : (f.metric || metrics[0] || '');
    const pool = shown.filter(result => result.metric === local.chartMetric && typeof result.value === 'number' && !superseded.has(result.id));
    const xKeys = ['case_id', ...unique(pool.flatMap(result => Object.keys(result.conditions || {})))];
    local.chartX = xKeys.includes(local.chartX) ? local.chartX : (xKeys.find(key => key !== 'case_id' && pool.every(result => typeof result.conditions?.[key] === 'number')) || 'case_id');
    const seriesKeys = ['candidate', ...xKeys.filter(key => key !== 'case_id' && key !== local.chartX)];
    // Default grouping: a categorical condition that varies (e.g. gain_state), else the candidate.
    const varying = key => unique(pool.map(result => String(result.conditions?.[key] ?? ''))).length > 1;
    if (!seriesKeys.includes(local.chartSeries)) local.chartSeries = seriesKeys.find(key => key !== 'candidate' && varying(key) && pool.some(result => typeof result.conditions?.[key] === 'string')) || 'candidate';
    put(local.chartControls, 
      field(T('metric'), select(metrics, local.chartMetric, { onchange: event => { local.chartMetric = event.target.value; drawResults(local); } })),
      field(T('x_axis'), select(xKeys.map(key => [key, key === 'case_id' ? T('case') : key]), local.chartX, { onchange: event => { local.chartX = event.target.value; drawResults(local); } })),
      field(T('series'), select(seriesKeys.map(key => [key, key === 'candidate' ? T('candidate') : key]), local.chartSeries, { onchange: event => { local.chartSeries = event.target.value; drawResults(local); } })));
    put(local.chart, drawChart(pool, local.chartX, local.chartSeries));
  }
  function drawChart(points, xKey, seriesKey = 'candidate') {
    const seriesOf = result => String((seriesKey === 'candidate' ? result.candidate : result.conditions?.[seriesKey]) ?? '—');
    if (!points.length) return h('p', { class: 'muted', text: T('no_chart') });
    const xOf = result => xKey === 'case_id' ? result.case_id : result.conditions?.[xKey];
    const numeric = points.every(result => typeof xOf(result) === 'number');
    const categories = numeric ? [] : unique(points.map(result => String(xOf(result) ?? '—')));
    const xs = points.map(result => numeric ? xOf(result) : categories.indexOf(String(xOf(result) ?? '—')));
    const limits = unique(points.flatMap(result => result.limit ? (result.limit.op === 'between' ? result.limit.value : [result.limit.value]) : []));
    const ys = [...points.map(result => result.value), ...limits];
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
    else categories.forEach((label, index) => svg.append(s('text', { class: 'tick', x: X(index), y: H - B + 14, 'text-anchor': 'end', transform: `rotate(-30 ${X(index)} ${H - B + 14})` }, truncate(label, 18))));
    for (const value of limits) svg.append(s('line', { class: 'limit', x1: L, x2: W - R, y1: Y(value), y2: Y(value) }, svgTitle(T('limit') + ' ' + value)));
    const series = unique(points.map(seriesOf));
    series.forEach((name, index) => {
      const color = COLORS[index % COLORS.length];
      const list = points.map((result, i) => ({ result, x: xs[i] })).filter(item => seriesOf(item.result) === name).sort((a, b) => a.x - b.x);
      // Only connect points when each x appears once in the series; otherwise a line would mix conditions.
      if (numeric && list.length > 1 && new Set(list.map(item => item.x)).size === list.length) svg.append(s('path', { class: 'series-line', stroke: color, d: list.map((item, i) => (i ? 'L' : 'M') + X(item.x) + ',' + Y(item.result.value)).join(' ') }));
      for (const item of list) svg.append(s('circle', { cx: X(item.x), cy: Y(item.result.value), r: 4, fill: item.result.status === 'FAIL' ? 'var(--fail)' : color, stroke: color, 'stroke-width': 1.5 },
        svgTitle(`${item.result.id} · ${name}\n${xKey}=${xOf(item.result)}\n${item.result.metric}=${item.result.value}${item.result.unit ? ' ' + item.result.unit : ''} · ${item.result.status}`)));
    });
    const legend = h('div', { class: 'legend' }, series.map((name, index) => h('span', {}, h('i', { style: 'background:' + COLORS[index % COLORS.length] }), name)), limits.length ? h('span', { class: 'st-FAIL', text: '- - ' + T('limit') }) : null);
    return h('div', {}, svg, legend);
  }

  // ─── Memory and documents ─────────────────────
  function mountTexts(view, local) {
    local.list = h('div', { class: 'text-list' }); local.detail = h('div');
    view.append(h('div', { class: 'text-layout' }, h('section', { class: 'card' }, local.list), h('section', { class: 'card' }, local.detail)));
  }
  async function refreshTexts(local) {
    const [memory, docs] = await Promise.all([api(P('/memory')), api(P('/docs'))]);
    const item = (kind, name, info) => h('button', { type: 'button', class: local.kind === kind && local.name === name ? 'active' : '', onclick: () => { local.kind = kind; local.name = name; local.version = ''; local.compare = ''; local.editing = false; refreshTexts(local); } },
      name, info ? h('div', { class: 'meta', text: 'v' + info.version + ' · ' + ui.size(info.size) + ' · ' + info.updated_by }) : h('div', { class: 'meta', text: T('not_created') }));
    const memoryActors = unique([...ACTORS, ...memory.memories.map(row => row.actor)]);
    const docNames = unique(['WORKFLOW_SERVER', 'WORKFLOW_PC', '05_SHARED_INTERFACE', 'SPECS', ...docs.docs.map(row => row.name)]);
    const newName = h('input', { placeholder: T('doc_name'), pattern: '[A-Za-z0-9][A-Za-z0-9_.\\-]{0,63}', 'aria-label': T('doc_name') });
    put(local.list, h('h3', { text: T('memory') }), memoryActors.map(actor => item('memory', actor, memory.memories.find(row => row.actor === actor))),
      h('h3', { text: T('documents') }), docNames.map(name => item('doc', name, docs.docs.find(row => row.name === name))),
      h('form', { class: 'actions', onsubmit: event => { event.preventDefault(); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(newName.value)) return ui.notice(ui.error('invalid_doc_name'), true); local.kind = 'doc'; local.name = newName.value; local.editing = true; refreshTexts(local); } }, newName, h('button', { type: 'submit', text: T('new_doc') })));
    if (!local.name) { put(local.detail, h('p', { class: 'muted', text: T('pick_text') })); return; }
    const base = (local.kind === 'memory' ? '/memory/' : '/docs/') + enc(local.name);
    let current = null, history = [];
    try { current = await api(P(base + (local.version ? '?version=' + enc(local.version) : ''))); history = (await api(P(base + '/history'))).history; }
    catch (error) { if (error.status !== 404) throw error; }
    const latest = history[0]?.version || 0;
    const versionSelect = select([['', T('latest')], ...history.map(row => [String(row.version), 'v' + row.version + ' · ' + when(row.updated_at) + ' · ' + row.updated_by])], local.version || '', { onchange: event => { local.version = event.target.value; refreshTexts(local); } });
    const compareSelect = select([['', T('no_compare')], ...history.map(row => [String(row.version), 'v' + row.version])], local.compare || '', { onchange: event => { local.compare = event.target.value; refreshTexts(local); } });
    let body;
    if (local.editing) {
      const editor = h('textarea', { value: current && !local.version ? current.content : current?.content || '', style: 'min-height:50vh', 'aria-label': local.name });
      const save = h('button', { type: 'button', class: 'primary', text: T('save'), onclick: () => action(save, async () => {
        await api(P(base), ui.json('PUT', { content: editor.value, version: latest })); local.editing = false; local.version = ''; await refreshTexts(local);
      }) });
      body = [editor, h('div', { class: 'actions' }, save, h('button', { type: 'button', text: T('cancel'), onclick: () => { local.editing = false; refreshTexts(local); } }))];
    } else if (local.compare && current) {
      const other = await api(P(base + '?version=' + enc(local.compare)));
      body = h('div', {}, h('p', { class: 'hint', text: 'v' + other.version + ' → v' + current.version }), renderDiff(other.content, current.content));
    } else body = current ? h('pre', { class: 'code', text: current.content || '—' }) : h('p', { class: 'muted', text: T('not_created') });
    put(local.detail, h('h2', { text: (local.kind === 'memory' ? T('memory') + ' · ' : '') + local.name }),
      current && h('p', { class: 'meta', text: 'v' + current.version + ' · ' + when(current.updated_at) + ' · ' + current.updated_by }),
      history.length && !local.editing ? h('div', { class: 'toolbar' }, field(T('version'), versionSelect), field(T('compare_with'), compareSelect)) : null,
      !local.editing && h('div', { class: 'actions', style: 'margin:0 0 12px' }, h('button', { type: 'button', text: current ? T('edit') : T('create'), onclick: () => { local.editing = true; local.version = ''; refreshTexts(local); } })),
      body);
  }
  function renderDiff(before, after) {
    let a = before.split('\n'), b = after.split('\n');
    let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length; while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const midA = a.slice(start, endA), midB = b.slice(start, endB), lines = [];
    if (start > 0) lines.push(['same', '… ' + start + ' ' + T('unchanged_lines')]);
    if (midA.length * midB.length > 2500000) { midA.forEach(text => lines.push(['del', text])); midB.forEach(text => lines.push(['add', text])); }
    else {
      const n = midA.length, m = midB.length, table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && midA[i] === midB[j]) { lines.push(['same', midA[i]]); i++; j++; }
        else if (j < m && (i === n || table[i][j + 1] >= table[i + 1][j])) lines.push(['add', midB[j++]]);
        else lines.push(['del', midA[i++]]);
      }
    }
    if (a.length - endA > 0) lines.push(['same', '… ' + (a.length - endA) + ' ' + T('unchanged_lines')]);
    if (!lines.some(([kind]) => kind !== 'same')) return h('p', { class: 'muted', text: T('no_difference') });
    return h('div', { class: 'diff' }, lines.map(([kind, text]) => h('div', { class: kind, text: (kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ') + text })));
  }

  // ─── Handoffs ─────────────────────────────────
  function renderHandoff(item) {
    return h('div', { class: 'thread' },
      h('div', { class: 'msg-head' }, badge(item.status, statusLabel(item.status)), h('span', { class: 'who who-' + item.from, text: item.from }), '→', h('span', { class: 'who who-' + item.to, text: item.to }), badge('info', item.task_id),
        item.evidence_level && badge('info', item.evidence_level), h('span', { class: 'meta', text: item.id + ' · ' + when(item.created_at) }),
        item.supersedes && h('span', { class: 'meta', text: T('supersedes') + ' ' + item.supersedes }), item.superseded_by && badge('NATIVE_FAILED', T('superseded_by') + ' ' + item.superseded_by)),
      h('p', { class: 'body', text: item.summary }),
      kv([[T('conditions'), Object.entries(item.conditions || {}).map(([key, value]) => key + '=' + value).join(' ')], [T('limitations'), (item.limitations || []).join('\n')], [T('next_action'), item.next_action]]),
      item.files?.length ? h('div', { class: 'table-wrap', style: 'margin-top:8px' }, h('table', {}, h('thead', {}, h('tr', {}, [T('file'), T('location'), 'SHA-256', T('format_note')].map(text => h('th', { text })))),
        h('tbody', {}, item.files.map(file => h('tr', {}, h('td', { text: file.name }), h('td', { text: file.location }), h('td', { title: file.sha256 || '', text: file.sha256 ? file.sha256.slice(0, 12) + '…' : '—' }), h('td', { text: file.format_note || '—' })))))) : null);
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
    put(local.list, ...(groups.size ? [...groups.entries()].map(([task, list]) => h('section', { class: 'card' }, h('h2', { text: task + ' · ' + list.length }), list.map(renderHandoff))) : [h('p', { class: 'muted', text: T('no_handoffs') })]));
  }

  // ─── Startup ──────────────────────────────────
  try {
    await ui.init('project.title');
    const params = new URLSearchParams(location.search);
    async function loadProjects(preferred) {
      state.projects = (await api('')).projects;
      const picker = $('project-select');
      put(picker, ...state.projects.map(project => h('option', { value: project.id, text: project.name + ' (' + project.id + ')' })));
      state.current = state.projects.some(project => project.id === preferred) ? preferred : state.projects[0]?.id || null;
      picker.value = state.current || '';
      picker.hidden = !state.projects.length;
      $('empty-state').hidden = !!state.current; $('project-tabs').hidden = !state.current;
      if (!state.current) put($('project-view'), );
    }
    await loadProjects(params.get('p'));
    $('project-select').onchange = event => { state.current = event.target.value; state.tabs = {}; open(state.tab); };
    document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => open(button.dataset.tab); });
    const dialog = $('new-project-dialog');
    $('project-new').onclick = () => { $('new-project-form').reset(); dialog.showModal(); };
    $('new-project-cancel').onclick = () => dialog.close();
    $('new-project-form').onsubmit = async event => {
      event.preventDefault();
      const ok = await action(event.submitter, async () => {
        const created = await api('', ui.json('POST', { id: $('new-project-id').value.trim(), name: $('new-project-name').value.trim() || undefined }));
        dialog.close(); state.tabs = {}; await loadProjects(created.id); await open('overview');
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
        if (payload.type === 'project_deleted' || payload.type === 'project') { const keep = state.current; await loadProjects(keep); if (state.current && state.current !== keep) open('overview'); return; }
        if (payload.project === state.current) scheduleRefresh();
      });
      socket.on('preferences-updated', value => ClipTalkTheme.update?.(value));
      socket.on('site-updated', site => ui.updateSite(site));
    }
  } catch (error) { if (error.message !== 'unauthorized') report(error); }
})();
