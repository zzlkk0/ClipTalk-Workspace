'use strict';
// Parses a Markdown task table into project tasks. Used by the project page
// for import preview and by tests. Owners are matched against the project's
// member names; 用户/user/主人 means USER; 两边/双方/all/both means every member.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClipTalkTaskTable = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const COLUMNS = {
    id: /^(id|编号|序号)$/i, title: /^(任务|task|title|名称|内容)$/i, owner: /^(负责|负责方|负责人|owner|owners|assignee)$/i,
    depends: /^(前置|依赖|depends|depends on|prerequisites?)$/i, done_when: /^(完成标准|验收标准|done|done when|acceptance)$/i,
    deliver_to: /^(交给谁|交付对象|交付给|deliver to|handoff)$/i, phase: /^(阶段|phase|stage)$/i,
  };
  const EMPTY = /^(—|–|-|无|none|n\/a)?$/i;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function cells(line) {
    const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return body.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
  }
  function clean(value) { const text = String(value || '').replace(/`/g, '').replace(/\*\*/g, '').trim(); return EMPTY.test(text) ? '' : text; }
  function owners(label, members = []) {
    const found = [];
    for (const name of members) {
      const match = new RegExp('(^|[^A-Za-z0-9_-])' + escape(name) + '(?![A-Za-z0-9_-])', 'i').exec(label);
      if (match) found.push({ at: match.index, actors: [name] });
    }
    const user = /用户|主人|\buser\b|\bowner\b/i.exec(label);
    if (user) found.push({ at: user.index, actors: ['USER'] });
    const all = /两边|双方|所有人|\ball\b|\bboth\b/i.exec(label);
    if (all) found.push({ at: all.index, actors: members.length ? members : ['ALL'] });
    if (!found.length) for (const token of label.split(/[\s,，、/;；+&]+/)) if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(token)) found.push({ at: label.indexOf(token), actors: [token] });
    return [...new Set(found.sort((a, b) => a.at - b.at).flatMap(item => item.actors))].slice(0, 10);
  }
  function parseTaskTable(markdown, members = []) {
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
      tasks.push({ id, phase: get('phase') || (/^[A-Za-z]+/.exec(id) || [''])[0], title: get('title') || id, owners: owners(label, members), owner_label: label,
        depends: get('depends'), done_when: get('done_when'), deliver_to: get('deliver_to') });
    }
    const counts = {};
    for (const task of tasks) counts[task.id] = (counts[task.id] || 0) + 1;
    return { tasks, duplicates: Object.keys(counts).filter(id => counts[id] > 1), problems, header: !!map };
  }
  // A short prompt the owner can give any AI to turn a plan into an importable table.
  function taskPrompt(members = []) {
    return [
      '请把下面的计划整理成一张 Markdown 表格，只输出表格本身，不要其他文字。',
      '列依次为：| ID | 阶段 | 任务 | 负责 | 前置 | 完成标准 | 交给谁 |',
      '- ID：字母开头的短编号（如 T1、M2、S3），全表唯一，不要重复。',
      '- 阶段：可选，用一两个字母或词表示（如 T、M、准备）。',
      '- 负责：从这些成员中选（可多个，用顿号分隔）：' + (members.length ? members.join('、') : '（成员名）') + '、用户。',
      '- 前置：依赖的任务 ID，多个用顿号分隔；没有写 —。',
      '- 完成标准：一句可检查的话，怎样算完成。',
      '- 交给谁：成果交给哪个成员或用户。',
      '',
      '计划：',
      '<在这里粘贴你的计划或需求>',
    ].join('\n');
  }
  return { parseTaskTable, owners, taskPrompt };
});
