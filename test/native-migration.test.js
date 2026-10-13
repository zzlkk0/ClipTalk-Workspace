'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

test('native migration preserves complete data and passwords, keeps backups, and rolls back failed startups',async()=>{
  const result=await run('python3',[path.join(__dirname,'native_migration.py')]);
  assert.match(result.stderr,/Ran 6 tests/);
  assert.match(result.stderr,/\bOK\b/);
});
