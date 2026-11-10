'use strict';
// Second line of defence for project collaboration: refuse text that looks like
// foundry model cards, library files or PDK paths. The sending agent must still
// sanitize its own uploads; this only catches obvious mistakes.
const fs = require('fs');
const path = require('path');

const RULES_FILE = 'project-content-rules.json';
const MODEL_PARAMETERS = /\b(?:vth0|toxe|toxm|tox|u0|ua|ub|uc|vsat|k1|k2|k3|dvt0|dvt1|nfactor|cdsc|cdscb|eta0|etab|dsub|pclm|pdiblc1|pdiblc2|rdsw|lint|wint|xj|ndep|nch|cgso|cgdo|cj|cjsw|mjsw|pb|pbsw)\s*=/gi;

const BUILTIN_RULES = [
  { id: 'spice_model_card', description: 'SPICE/Spectre model statement with a device type',
    test: text => /^[ \t]*\.?model[ \t]+\S+[ \t]+\(?(?:nmos|pmos|nfet|pfet|npn|pnp|bsim\w*|psp\w*|hisim\w*|ekv\w*|mos\d+)\b/im.test(text) },
  { id: 'model_parameters', description: 'Many device model parameters (BSIM style)',
    test: text => new Set((text.match(MODEL_PARAMETERS) || []).map(item => item.replace(/\s*=$/, '').toLowerCase())).size >= 6 },
  { id: 'pdk_include', description: '.lib/.include/include statement pointing to a file path',
    test: text => /^[ \t]*(?:\.lib|\.include|\.inc|include|ahdl_include)[ \t]+["'][^"'\n]*[/\\][^"'\n]*["']/im.test(text)
      || /^[ \t]*\.lib[ \t]+\S*[/\\]\S*[ \t]+\w+/im.test(text)
      || /\binclude[ \t]+["'][^"'\n]+["'][ \t]+section[ \t]*=/i.test(text) },
  { id: 'liberty_structure', description: 'Liberty library structure (library/cell/pin/timing groups)',
    test: text => new Set([...text.matchAll(/\b(library|cell|pin|timing)[ \t]*\([^()\n]*\)[ \t]*\{/g)].map(match => match[1])).size >= 2 },
  { id: 'lef_structure', description: 'LEF structure (MACRO/LAYER/SITE statements)',
    test: text => {
      const found = new Set();
      for (const match of text.matchAll(/^[ \t]*(MACRO|LAYER|SITE|FOREIGN|ORIGIN|OBS|SYMMETRY|CLASS[ \t]+(?:CORE|PAD|BLOCK)|TYPE[ \t]+(?:ROUTING|CUT|MASTERSLICE))\b/gm)) found.add(match[1].split(/[ \t]/)[0]);
      return found.size >= 2 && (found.has('MACRO') || found.has('LAYER') || found.has('SITE'));
    } },
  { id: 'foundry_path', description: 'File path containing a foundry or PDK directory name',
    test: text => /[/\\](?:pdks?|tsmc\w*|cln\d+\w*|crn\d+\w*|tcbn\d+\w*|smic\w*|umc\d*\w*|gf\d+\w*|globalfoundries\w*|tower\w*|xfab\w*|ihp\w*|sky130\w*|gpdk\d*\w*|ams_?c\d+\w*)[/\\]/i.test(text) },
];

class ContentGuard {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, RULES_FILE) : null;
    this.cache = { mtime: -1, custom: [], disabled: new Set() };
    if (this.file && !fs.existsSync(this.file)) {
      try {
        fs.writeFileSync(this.file, JSON.stringify({
          _help: 'Add case-insensitive keywords or JavaScript regular expressions. Built-in rule ids can be listed in disabled. Changes apply without restart.',
          keywords: [], patterns: [], disabled: [],
        }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      } catch (error) { if (error.code !== 'EEXIST') console.error('Content rules file not created:', error.code); }
    }
  }

  load() {
    if (!this.file) return this.cache;
    let mtime;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { return this.cache = { mtime: -1, custom: [], disabled: new Set() }; }
    if (mtime === this.cache.mtime) return this.cache;
    const custom = [], disabled = new Set();
    try {
      const config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [index, keyword] of (Array.isArray(config.keywords) ? config.keywords : []).entries()) {
        if (typeof keyword !== 'string' || !keyword.trim()) continue;
        const needle = keyword.trim().toLowerCase();
        custom.push({ id: 'custom_keyword_' + (index + 1), description: 'Custom keyword #' + (index + 1), test: text => text.toLowerCase().includes(needle) });
      }
      for (const [index, pattern] of (Array.isArray(config.patterns) ? config.patterns : []).entries()) {
        try {
          const regex = new RegExp(typeof pattern === 'string' ? pattern : pattern.source, typeof pattern === 'string' ? 'im' : (pattern.flags || 'im').replace(/[gy]/g, ''));
          custom.push({ id: 'custom_pattern_' + (index + 1), description: (typeof pattern === 'object' && pattern.description) || 'Custom pattern #' + (index + 1), test: text => regex.test(text) });
        } catch { console.error('Ignoring invalid custom content pattern #' + (index + 1)); }
      }
      for (const id of Array.isArray(config.disabled) ? config.disabled : []) if (typeof id === 'string') disabled.add(id);
    } catch { console.error('Content rules file is not valid JSON; built-in rules still apply.'); }
    return this.cache = { mtime, custom, disabled };
  }

  // Check every string (keys and values) inside a value. Throws 422 without echoing content.
  check(value) {
    const { custom, disabled } = this.load();
    const rules = [...BUILTIN_RULES.filter(rule => !disabled.has(rule.id)), ...custom];
    const strings = [];
    const collect = item => {
      if (typeof item === 'string') strings.push(item);
      else if (Array.isArray(item)) item.forEach(collect);
      else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { strings.push(key); collect(child); }
    };
    collect(value);
    const joined = strings.join('\n');
    for (const rule of rules) {
      if (strings.some(text => rule.test(text)) || rule.test(joined)) {
        console.warn('Project content blocked by rule:', rule.id);
        throw Object.assign(new Error('sensitive_content_blocked'), { status: 422, detail: { rule: rule.id, description: rule.description } });
      }
    }
  }
}

module.exports = { ContentGuard, BUILTIN_RULES, RULES_FILE };
