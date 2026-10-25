#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { ClipTalkClient } = require('../agent/client');
const help = `ClipTalk agent CLI (Node.js 22+)
Set CLIPTALK_URL and CLIPTALK_TOKEN_FILE (or CLIPTALK_TOKEN).
  cliptalk me
  cliptalk storage
  cliptalk clipboard get
  cliptalk clipboard set --text "summary"  (or --file path / --stdin)
  cliptalk list [--folder ID]
  cliptalk folders
  cliptalk mkdir NAME [--parent ID]
  cliptalk rename-folder ID NAME
  cliptalk move-folder ID [--parent ID]  (omit parent for root)
  cliptalk delete-folder ID --confirm
  cliptalk upload PATH [--folder ID]
  cliptalk download FILE_ID OUTPUT_PATH  (never overwrites)
  cliptalk move FILE_ID... [--folder ID]  (omit folder for root)
  cliptalk delete FILE_ID... --confirm
Files use IDs returned by list/upload. All output is JSON.
HTTPS is required for remote hosts; localhost HTTP supports SSH tunnels.
`;
async function main() {
  const { positionals: p, values: v } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, folder: { type: 'string' }, parent: { type: 'string' },
    text: { type: 'string' }, file: { type: 'string' }, stdin: { type: 'boolean' }, confirm: { type: 'boolean' },
  } });
  if (v.help || !p.length) { process.stdout.write(help); return; }
  const client = new ClipTalkClient(); let result;
  const count = n => { if (p.length !== n) throw new Error('Wrong number of arguments. Use --help.'); };
  const confirm = () => { if (!v.confirm) throw new Error('Deletion requires --confirm.'); };
  switch (p[0]) {
    case 'me': count(1); result = await client.json('/me'); break;
    case 'storage': count(1); result = await client.json('/storage'); break;
    case 'clipboard':
      count(2);
      if (p[1] === 'get') result = await client.json('/clipboard');
      else if (p[1] === 'set') {
        if ([v.text !== undefined, v.file !== undefined, v.stdin === true].filter(Boolean).length !== 1) throw new Error('Choose exactly one of --text, --file, --stdin.');
        const text = v.text !== undefined ? v.text : fs.readFileSync(v.stdin ? 0 : v.file, 'utf8');
        result = await client.json('/clipboard', 'PUT', { text });
      } else throw new Error('Use clipboard get or clipboard set.');
      break;
    case 'list': count(1); result = await client.json('/drive' + (v.folder ? '?folderId=' + encodeURIComponent(v.folder) : '')); break;
    case 'folders': count(1); result = await client.json('/folders'); break;
    case 'mkdir': count(2); result = await client.json('/folders', 'POST', { name: p[1], parentId: v.parent || null }); break;
    case 'rename-folder': count(3); result = await client.json('/folders/' + encodeURIComponent(p[1]), 'PATCH', { name: p[2] }); break;
    case 'move-folder': count(2); result = await client.json('/folders/' + encodeURIComponent(p[1]), 'PATCH', { parentId: v.parent || null }); break;
    case 'delete-folder': count(2); confirm(); result = await client.json('/folders/' + encodeURIComponent(p[1]), 'DELETE', { confirm: true }); break;
    case 'upload': count(2); result = await client.upload(p[1], v.folder); break;
    case 'download': count(3); result = await client.download(p[1], p[2]); break;
    case 'move': if (p.length < 2) throw new Error('Provide file IDs.'); result = await client.json('/files', 'PATCH', { names: p.slice(1), folderId: v.folder || null }); break;
    case 'delete': if (p.length < 2) throw new Error('Provide file IDs.'); confirm(); result = await client.json('/files', 'DELETE', { names: p.slice(1), confirm: true }); break;
    default: throw new Error('Unknown command. Use --help.');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error.message, status: error.status, retryAfter: error.retryAfter }) + '\n'); process.exitCode = 1; });
