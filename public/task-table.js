'use strict';
// Parses the Markdown task table of 05_SHARED_INTERFACE.md (section 4) into
// project tasks. Used by the project page for import preview and by tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClipTalkTaskTable = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const COLUMNS = {
    id: /^(id|编号)$/i, title: /^(任务|task|title|名称)$/i, owner: /^(负责|负责方|owner|owners)$/i,
    depends: /^(前置|依赖|depends|prerequisites?)$/i, done_when: /^(完成标准|done|done when|acceptance)$/i, deliver_to: /^(交给谁|交付对象|deliver to|handoff)$/i,
  };
  const OWNERS = [[/两边|双方|both/i, ['SERVER', 'PC']], [/服务器|server/i, ['SERVER']], [/\bPC\b|电脑/i, ['PC']], [/用户|user/i, ['USER']]];
  const EMPTY = /^(—|–|-|无|none|n\/a)?$/i;

  function cells(line) {
    const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return body.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
  }
  function clean(value) { const text = String(value || '').replace(/`/g, '').replace(/\*\*/g, '').trim(); return EMPTY.test(text) ? '' : text; }
  function owners(label) {
    const found = [];
    for (const [pattern, actors] of OWNERS) {
      const match = pattern.exec(label);
      if (match) found.push({ at: match.index, actors });
    }
    return [...new Set(found.sort((a, b) => a.at - b.at).flatMap(item => item.actors))];
  }
  function parseTaskTable(markdown) {
    const lines = String(markdown || '').split(/\r?\n/).filter(line => /^\s*\|/.test(line));
    const problems = [], tasks = [];
    let map = null;
    for (const line of lines) {
      const row = cells(line);
      if (row.every(cell => /^:?-{2,}:?$/.test(cell))) continue;
      if (!map) {
        const found = {};
        row.forEach((cell, index) => { for (const [field, pattern] of Object.entries(COLUMNS)) if (pattern.test(clean(cell)) && found[field] === undefined) found[field] = index; });
        if (found.id !== undefined && found.title !== undefined) map = found;
        continue;
      }
      const get = field => map[field] === undefined ? '' : clean(row[map[field]]);
      const id = get('id');
      if (!id) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(id)) { problems.push({ id, problem: 'invalid_id' }); continue; }
      const label = get('owner');
      tasks.push({ id, phase: (/^[A-Za-z]+/.exec(id) || [''])[0], title: get('title') || id, owners: owners(label), owner_label: label,
        depends: get('depends'), done_when: get('done_when'), deliver_to: get('deliver_to') });
    }
    const counts = {};
    for (const task of tasks) counts[task.id] = (counts[task.id] || 0) + 1;
    return { tasks, duplicates: Object.keys(counts).filter(id => counts[id] > 1), problems, header: !!map };
  }
  return { parseTaskTable, owners };
});
