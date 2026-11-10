'use strict';
// Turns a CSV, JSONL or JSON file into record/v1 records.
// CSV columns: candidate, task_id, case_id, node, metric, value, unit, status,
// evidence_level, limit_op, limit_value, limit_ref, supersedes, cond.<name>,
// run.<name>. Common condition names (corner, temp_C, vdd_V, rf_Hz, lo_Hz,
// if_Hz, fs_Hz, gain_state) may also be used without the cond. prefix.
const CONDITIONS = ['corner', 'temp_C', 'vdd_V', 'rf_Hz', 'lo_Hz', 'if_Hz', 'fs_Hz', 'gain_state'];
const TOP = ['candidate', 'task_id', 'case_id', 'node', 'metric', 'unit', 'status', 'evidence_level', 'supersedes'];

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some(value => value !== '')) rows.push(row);
  return rows;
}
const number = value => value !== '' && Number.isFinite(Number(value)) ? Number(value) : value;

function fromRow(row, defaults) {
  const result = { schema: 'record/v1', ...defaults, conditions: { ...(defaults.conditions || {}) } };
  const limit = {}, run = { ...(defaults.run || {}) };
  for (const [key, raw] of Object.entries(row)) {
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '' || value === undefined || value === null) continue;
    if (key === 'value') result.value = Number(value);
    else if (key === 'limit_op') limit.op = value;
    else if (key === 'limit_value') limit.value = number(value);
    else if (key === 'limit_ref') limit.ref = value;
    else if (key.startsWith('cond.')) result.conditions[key.slice(5)] = number(value);
    else if (key.startsWith('run.')) run[key.slice(4)] = number(value);
    else if (CONDITIONS.includes(key)) result.conditions[key] = number(value);
    else if (TOP.includes(key)) result[key] = String(value);
  }
  if (limit.op) result.limit = limit;
  if (Object.keys(run).length) result.run = run;
  if (!Object.keys(result.conditions).length) delete result.conditions;
  return result;
}

function parseResults(text, filename, defaults = {}) {
  const trimmed = text.trim();
  if (/\.jsonl$/i.test(filename) || (!/\.json$/i.test(filename) && trimmed.startsWith('{') && trimmed.includes('\n{'))) {
    return trimmed.split(/\r?\n/).filter(line => line.trim()).map(line => ({ schema: 'record/v1', ...defaults, ...JSON.parse(line) }));
  }
  if (/\.json$/i.test(filename) || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed), list = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(list)) throw new Error('JSON must be an array or {"results": [...]}.');
    return list.map(item => ({ schema: 'record/v1', ...defaults, ...item }));
  }
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row.');
  const header = rows[0].map(name => name.trim());
  return rows.slice(1).map(cells => fromRow(Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])), defaults));
}

module.exports = { parseResults, parseCsv };
