'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

async function startFixture(t, { legacy = true, builtinAdmin = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliptalk-api-'));
  fs.mkdirSync(path.join(dir, 'database')); fs.mkdirSync(path.join(dir, 'uploads'));
  const database = new Database(path.join(dir, 'database', 'users.db'));
  database.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL, status TEXT NOT NULL, language TEXT DEFAULT 'zh-CN', created_at INTEGER NOT NULL, last_login INTEGER
  );`);
  const password = crypto.randomBytes(16).toString('hex');
  const hash = bcrypt.hashSync(password, 4);
  for (const [name, role] of [[builtinAdmin ? 'admin' : 'test_admin','admin'],['alice','user'],['bob','user']]) {
    database.prepare('INSERT INTO users (id,username,password_hash,role,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(builtinAdmin && role === 'admin' ? 'admin-fixture' : name, name, hash, role, 'active', Date.now());
  }
  database.close();
  if (legacy) {
    fs.writeFileSync(path.join(dir, 'uploads', '100_legacy.txt'), 'legacy content');
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
      clipboardText: 'legacy clipboard', messages: [{type:'user',text:'legacy chat',time:Date.now(),from:'old'}],
      files: [{name:'100_legacy.txt',originalName:'旧文件.txt',size:14,time:Date.now()}],
    }));
  }
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({port,sessionSecret:crypto.randomBytes(32).toString('hex'),rateLimitMax:5000,maxLoginAttempts:100}));
  let logs = '';
  function launch() {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd:path.join(__dirname,'..'), env:{...process.env,CLIPTALK_DATA_DIR:dir,CLIPTALK_HOST:'127.0.0.1'}, stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    return child;
  }
  let child = launch();
  const base = 'http://127.0.0.1:' + port;
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref(); });
    }
    fs.rmSync(dir,{recursive:true,force:true});
  });
  async function ready() { for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Fixture exited: ' + logs);
    try { const resp = await fetch(base+'/api/health'); if (resp.ok) break; } catch {}
    if (attempt === 99) throw new Error('Fixture startup timeout: ' + logs);
    await new Promise(resolve => setTimeout(resolve,50));
  } }
  await ready();
  async function restart() {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await stopped; logs = ''; child = launch(); await ready();
  }
  async function request(url, cookie, options = {}) {
    const response = await fetch(base+url, {...options,headers:{...options.headers,...(cookie?{Cookie:cookie}:{})}});
    let data; try { data = await response.json(); } catch { data = null; }
    return {status:response.status,data,response};
  }
  async function login(username) {
    const result = await request('/api/login',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    if (result.status !== 200) throw new Error('Fixture login failed');
    return result.response.headers.getSetCookie()[0].split(';')[0];
  }
  return {base,dir,password,request,login,restart,get child() { return child; }};
}
function json(method,body) {return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};}
function macauDate() { return new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10); }
module.exports = {startFixture,json,macauDate};
