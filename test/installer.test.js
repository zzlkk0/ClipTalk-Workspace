'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {execFile,execFileSync}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const root=path.join(__dirname,'..');
function executable(file,text){fs.writeFileSync(file,text,{mode:0o755});}
async function unusedPort(){
  const reservation=net.createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  return port;
}
function isolatedInstaller(dir,release){
  fs.writeFileSync(path.join(dir,'os-release'),release);
  fs.mkdirSync(path.join(dir,'systemd'));
  fs.mkdirSync(path.join(dir,'units'));
  const script=path.join(dir,'deploy.sh');
  fs.writeFileSync(script,fs.readFileSync(path.join(root,'deploy.sh'),'utf8')
    .replaceAll('/etc/os-release',path.join(dir,'os-release'))
    .replaceAll('/etc/systemd/system',path.join(dir,'units'))
    .replaceAll('/run/systemd/system',path.join(dir,'systemd')));
  return script;
}

test('installer options validate without touching packages or services',async()=>{
  await run('bash',['-n',path.join(root,'deploy.sh')]);
  for(const mode of ['native','docker']) {
    const result=await run('bash',[path.join(root,'deploy.sh'),'--dry-run','--mode',mode,'--dir','/tmp/cliptalk-example','--port','18000']);
    assert.ok(result.stdout.includes('No files, packages, containers or services were changed.'));
  }
  for(const options of [['--mode','bad'],['--port','0'],['--port','65536'],['--port','-1'],['--dir','/'],['--dir','/tmp/a b'],['--ref','../bad'],['--port']]) {
    await assert.rejects(run('bash',[path.join(root,'deploy.sh'),'--dry-run',...options]));
  }
});

test('native updates discover the existing service directory instead of creating another default installation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cliptalk-discovery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=isolatedInstaller(dir,'ID=debian\n');
  const original=path.join(dir,'original'),data=path.join(original,'data');
  fs.mkdirSync(path.join(data,'database'),{recursive:true});
  fs.writeFileSync(path.join(data,'database','users.db'),'existing account database');
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:13131}));
  fs.writeFileSync(path.join(original,'.deployment-mode'),'native\n');
  const unit=path.join(dir,'units','cliptalk-workspace.service');
  const contents='[Service]\nUser='+os.userInfo().username+'\nWorkingDirectory='+original+'/current\nEnvironment=CLIPTALK_DATA_DIR='+data+'\n';
  fs.writeFileSync(unit,contents);
  const detected=await run('bash',[script,'--dry-run']);
  assert.ok(detected.stdout.includes('directory='+original));
  assert.ok(detected.stdout.includes('port=13131'));
  const explicit=await run('bash',[script,'--dry-run','--dir',path.join(dir,'another')]);
  assert.ok(explicit.stdout.includes('directory='+path.join(dir,'another')));
  assert.equal(fs.readFileSync(unit,'utf8'),contents);
  assert.equal(fs.existsSync(path.join(dir,'another')),false);
});

test('a managed installation with a missing account database aborts before packages or service changes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cliptalk-missing-accounts-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=isolatedInstaller(dir,'ID=alinux\n');
  const target=path.join(dir,'app');fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'.deployment-mode'),'native\n');
  await assert.rejects(run('bash',[script,'--dir',target,'--port','13131']),
    error=>error.code===1&&error.stderr.includes('Update stopped without creating new accounts'));
  assert.equal(fs.existsSync(path.join(target,'releases')),false);
  assert.equal(fs.existsSync(path.join(target,'data')),false);
});

test('installer keeps existing native and Docker host ports unless explicitly overridden',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cliptalk-port-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const data=path.join(dir,'data');fs.mkdirSync(data);
  const config=path.join(data,'config.json'),metadata=path.join(dir,'.port');
  const args=[path.join(root,'deploy.sh'),'--dry-run','--dir',dir];
  const plan=async(...options)=>(await run('bash',[...args,...options])).stdout;
  assert.ok((await plan()).includes('port=8000'));
  fs.writeFileSync(metadata,'13131\n');
  assert.ok((await plan()).includes('port=13131'));
  fs.writeFileSync(config,JSON.stringify({port:14343}));
  assert.ok((await plan()).includes('port=14343'),'Manual native configuration changes take precedence over stale metadata');
  assert.ok((await plan('--mode','docker')).includes('port=13131'),'Docker retains its host port, rather than its container port');
  assert.ok((await plan('--port','18000')).includes('port=18000'));
  assert.equal(JSON.parse(fs.readFileSync(config)).port,14343,'A preview must not change the stored port');
  for(const content of ['{broken',JSON.stringify({port:0}),JSON.stringify({port:65536}),JSON.stringify({port:true})]){
    fs.writeFileSync(config,content);
    await assert.rejects(plan(),error=>error.code===1&&error.stderr.includes('configuration was not changed'));
    assert.equal(fs.readFileSync(config,'utf8'),content);
  }
  fs.rmSync(config);
  fs.writeFileSync(metadata,'not-a-port\n');
  await assert.rejects(plan(),error=>error.code===2&&error.stderr.includes('Invalid port'));
});

test('native installer rejects old glibc before changing packages, data or services',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cliptalk-old-glibc-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);
  const script=isolatedInstaller(dir,'ID=alinux\nID_LIKE="rhel fedora centos anolis"\nVERSION_ID=2\n');
  executable(path.join(bin,'dnf'),'#!/bin/sh\nprintf "Package installation must not run\\n" >&2\nexit 99\n');
  for(const version of ['2.17','2.26']){
    executable(path.join(bin,'getconf'),'#!/bin/sh\nprintf "glibc '+version+'\\n"\n');
    await assert.rejects(run('bash',[script,'--dir',path.join(dir,'app')],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}}),
      error=>error.code===1&&error.stderr.includes('requires glibc 2.28 or newer'));
    assert.equal(fs.existsSync(path.join(dir,'app')),false);
  }
});

for(const platform of [
  {name:'Ubuntu/Debian',manager:'apt-get',release:'ID=debian\nVERSION_ID=12\nPRETTY_NAME="Debian test fixture"\n'},
  {name:'Alibaba Cloud Linux 3 with dnf',manager:'dnf',release:'ID=alinux\nID_LIKE="rhel fedora centos anolis"\nVERSION_ID=3\nPRETTY_NAME="Alibaba Cloud Linux 3"\n'},
  {name:'Alibaba Cloud Linux 3 with yum fallback',manager:'yum',release:'ID=alinux\nID_LIKE="rhel fedora centos anolis"\nVERSION_ID=3\nPRETTY_NAME="Alibaba Cloud Linux 3"\n'}
]) test('native installer on '+platform.name+': fresh startup, update through proxy and rollback with mocked host commands',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cliptalk-installer-'));
  const bin=path.join(dir,'bin'),target=path.join(dir,'app'),source=path.join(dir,'source');
  fs.mkdirSync(bin);fs.mkdirSync(source);
  const script=isolatedInstaller(dir,platform.release);
  executable(path.join(bin,'getconf'),'#!/bin/sh\nprintf "glibc 2.32\\n"\n');
  for(const manager of ['apt-get','dnf','yum'])executable(path.join(bin,manager),`#!/usr/bin/env python3
import json,os,pathlib,sys
with open(os.environ['CLIPTALK_INSTALL_TEST_ROOT']+'/packages.log','a') as log:
 log.write(json.dumps([pathlib.Path(sys.argv[0]).name]+sys.argv[1:])+'\\n')
`);
  const shellEnv=path.join(dir,'shell-env');
  fs.writeFileSync(shellEnv,`command() {
  if [[ "$1" == -v && "$2" == g++ ]]; then return 1; fi
  if [[ "$1" == -v && "$2" == dnf && "$CLIPTALK_INSTALL_TEST_MANAGER" == yum ]]; then return 1; fi
  builtin command "$@"
}
`);
  const publicFiles=['server.js','db.js','workspace-store.js','sharing-store.js','quota-storage.js','drive-store.js','connection-policy.js','package.json','package-lock.json','scripts','public','i18n','deploy.sh'];
  for(const file of publicFiles)fs.cpSync(path.join(root,file),path.join(source,file),{recursive:true});
  const archive=path.join(dir,'source.tar.gz');execFileSync('tar',['-czf',archive,'-C',dir,'source']);
  const realNode=process.execPath,realCurl=execFileSync('bash',['-c','command -v curl'],{encoding:'utf8'}).trim();
  executable(path.join(bin,'node'),'#!/bin/sh\nexec '+JSON.stringify(realNode)+' "$@"\n');
  executable(path.join(bin,'npm'),'#!/bin/sh\nln -s "$CLIPTALK_INSTALL_TEST_MODULES" node_modules\n');
  executable(path.join(bin,'sudo'),'#!/bin/sh\nexec "$@"\n');
  executable(path.join(bin,'seq'),'#!/bin/sh\nprintf "1\\n2\\n3\\n"\n');
  executable(path.join(bin,'journalctl'),`#!/usr/bin/env python3
import os,pathlib,sys
log=pathlib.Path(os.environ['CLIPTALK_INSTALL_TEST_ROOT'])/'service.log'
offset=pathlib.Path(os.environ['CLIPTALK_INSTALL_TEST_ROOT'])/'log-offset'
if log.exists():
 start=int(offset.read_text()) if '--since' in sys.argv and offset.exists() else 0
 print(log.read_bytes()[start:].decode(),end='')
`);
  executable(path.join(bin,'curl'),`#!/usr/bin/env python3
import os,sys,shutil,subprocess
args=sys.argv[1:]
if any('api.github.com/repos/' in a for a in args):
 shutil.copyfile(os.environ['CLIPTALK_INSTALL_TEST_ARCHIVE'],args[args.index('-o')+1]);sys.exit(0)
if os.environ.get('CLIPTALK_INSTALL_TEST_FAIL_HEALTH')=='1' and any('/api/health' in a for a in args):
 print('curl: (22) Forced health check failure',file=sys.stderr);sys.exit(22)
sys.exit(subprocess.call([${JSON.stringify(realCurl)}]+args))
`);
  executable(path.join(bin,'install'),`#!/usr/bin/env python3
import os,sys,shutil
expected=os.environ['CLIPTALK_INSTALL_TEST_ROOT']+'/units/cliptalk-workspace.service'
if sys.argv[-1]!=expected:raise RuntimeError('Unexpected host mutation')
shutil.copyfile(sys.argv[-2],expected)
`);
  executable(path.join(bin,'systemctl'),`#!/usr/bin/env python3
import os,sys,subprocess,signal,time,pathlib
root=pathlib.Path(os.environ['CLIPTALK_INSTALL_TEST_ROOT']);pidfile=root/'pid'
command=sys.argv[1]
def stop():
 if pidfile.exists():
  pid=int(pidfile.read_text())
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
  for i in range(40):
   stat=pathlib.Path('/proc')/str(pid)/'stat'
   if not stat.exists() or ') Z ' in stat.read_text():break
   time.sleep(.05)
  pidfile.unlink(missing_ok=True)
if command=='stop':stop()
elif command=='restart':
 stop();unit=(root/'units/cliptalk-workspace.service').read_text().splitlines();cwd=next(l[17:] for l in unit if l.startswith('WorkingDirectory='))
 data=next(l[len('Environment=CLIPTALK_DATA_DIR='):] for l in unit if l.startswith('Environment=CLIPTALK_DATA_DIR='))
 logpath=root/'service.log';(root/'log-offset').write_text(str(logpath.stat().st_size if logpath.exists() else 0))
 logfile=open(logpath,'ab');env=os.environ.copy();env['CLIPTALK_DATA_DIR']=data;env['CLIPTALK_HOST']='127.0.0.1'
 if env.get('CLIPTALK_INSTALL_TEST_FAIL_HEALTH')=='1':
  logfile.write(b'Password: INSTALLER_DIAGNOSTIC_PASSWORD_SHOULD_BE_REDACTED\\n')
  logfile.write('密码:   INSTALLER_DIAGNOSTIC_PASSWORD_SHOULD_BE_REDACTED\\n'.encode());logfile.flush()
 child=subprocess.Popen([${JSON.stringify(realNode)},cwd+'/server.js'],cwd=cwd,env=env,stdout=logfile,stderr=logfile,start_new_session=True)
 pidfile.write_text(str(child.pid))
elif command=='status':
 print('Mock service status: active (running)');sys.exit(3)
elif command=='daemon-reload' and os.environ.get('CLIPTALK_INSTALL_TEST_FAIL_RELOAD_ONCE')=='1':
 marker=root/'failed-reload-once'
 if not marker.exists():marker.write_text('failed');sys.exit(1)
elif command not in ['daemon-reload','enable']:raise RuntimeError('Unexpected service action')
`);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,
    BASH_ENV:shellEnv,CLIPTALK_INSTALL_TEST_MANAGER:platform.manager,
    CLIPTALK_INSTALL_TEST_ROOT:dir,CLIPTALK_INSTALL_TEST_ARCHIVE:archive,
    CLIPTALK_INSTALL_TEST_MODULES:path.join(root,'node_modules')};
  t.after(async()=>{await run(path.join(bin,'systemctl'),['stop','cliptalk-workspace.service'],{env});fs.rmSync(dir,{recursive:true,force:true});});
  const port=await unusedPort();
  const updateArgs=[script,'--mode','native','--dir',target];
  const args=[...updateArgs,'--port',String(port)];
  const first=await run('bash',args,{env});assert.ok(first.stdout.includes('ClipTalk is ready'));
  assert.ok(first.stdout.includes('New account database initialized'));
  const initialPassword=first.stdout.match(/密码:\s*(\S+)/)?.[1];assert.ok(initialPassword);
  const packages=fs.readFileSync(path.join(dir,'packages.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(packages.every(args=>args[0]===platform.manager));
  const install=packages.find(args=>args[1]==='install');
  assert.ok(install.includes(platform.manager==='apt-get'?'xz-utils':'xz'));
  assert.ok(install.includes(platform.manager==='apt-get'?'g++':'gcc-c++'));
  const firstRelease=fs.realpathSync(path.join(target,'current'));
  const configFile=path.join(target,'data','config.json');const secret=JSON.parse(fs.readFileSync(configFile)).sessionSecret;
  assert.equal(JSON.parse(fs.readFileSync(configFile)).port,port);
  assert.equal(fs.readFileSync(path.join(target,'.port'),'utf8').trim(),String(port));
  const Database=require('better-sqlite3');
  const usersFile=path.join(target,'data','database','users.db');
  const users=new Database(usersFile);
  const adminHash=users.prepare("SELECT password_hash FROM users WHERE role='admin'").get().password_hash;
  users.prepare("UPDATE users SET username='existing-admin', theme='light' WHERE role='admin'").run();
  for(const status of ['active','pending','disabled']) {
    users.prepare('INSERT INTO users (id,username,password_hash,role,status,language,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('u-retained-'+status,'member-'+status,adminHash,'user',status,'en',123456);
  }
  users.close();
  const accountsFingerprint=()=>{
    const current=new Database(usersFile,{readonly:true,fileMustExist:true});
    const rows=current.prepare('SELECT id,username,password_hash,role,status,language,created_at,theme,builtin_admin FROM users ORDER BY id').all();current.close();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  };
  const expectedAccounts=accountsFingerprint();
  const database=new Database(path.join(target,'data','database','workspace.db'));
  database.prepare('INSERT INTO workspaces (owner_id,clipboard_text) VALUES (?,?)').run('test-owner','preserve me');database.close();
  // Reproduce curl (52): the configured proxy accepts and closes HTTP requests.
  let proxyRequests=0;
  const proxy=net.createServer(socket=>{proxyRequests++;socket.once('data',()=>socket.end());});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>proxy.close(resolve)));
  const proxyUrl='http://127.0.0.1:'+proxy.address().port;
  const proxyEnv={...env,http_proxy:proxyUrl,HTTP_PROXY:proxyUrl,https_proxy:proxyUrl,HTTPS_PROXY:proxyUrl,
    all_proxy:proxyUrl,ALL_PROXY:proxyUrl,no_proxy:'',NO_PROXY:''};
  await assert.rejects(run(realCurl,['-fsS','--max-time','2','http://127.0.0.1:'+port+'/api/health'],{env:proxyEnv}),
    error=>error.code===52&&error.stderr.includes('Empty reply from server'));
  const proxyRequestsBeforeUpdate=proxyRequests;
  assert.ok(proxyRequestsBeforeUpdate>0);
  fs.writeFileSync(path.join(target,'.port'),'8000\n');
  const second=await run('bash',updateArgs,{env:proxyEnv});assert.ok(second.stdout.includes('Previous data backup'));
  assert.ok(second.stdout.includes('Existing account database reused'));
  assert.ok(!second.stdout.includes('Initial username: admin'));
  assert.ok(!second.stdout.includes('初始管理员账号已创建'));
  assert.equal(accountsFingerprint(),expectedAccounts,'Account IDs, names, password hashes, roles and status must persist');
  assert.equal(proxyRequests,proxyRequestsBeforeUpdate,'Loopback health checks must bypass the configured proxy');
  const secondRelease=fs.realpathSync(path.join(target,'current'));assert.notEqual(secondRelease,firstRelease);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).sessionSecret,secret);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).port,port);
  assert.equal(fs.readFileSync(path.join(target,'.port'),'utf8').trim(),String(port));
  const changedPort=await unusedPort();
  const changed=await run('bash',[...updateArgs,'--port',String(changedPort)],{env:proxyEnv});
  assert.ok(changed.stdout.includes('ClipTalk is ready on port '+changedPort));
  assert.equal(JSON.parse(fs.readFileSync(configFile)).port,changedPort);
  assert.equal(fs.readFileSync(path.join(target,'.port'),'utf8').trim(),String(changedPort));
  const changedRelease=fs.realpathSync(path.join(target,'current'));assert.notEqual(changedRelease,secondRelease);
  assert.equal(accountsFingerprint(),expectedAccounts);
  const unitFile=path.join(dir,'units','cliptalk-workspace.service');
  const previousUnit=fs.readFileSync(unitFile,'utf8');
  const diagnosticPassword='INSTALLER_DIAGNOSTIC_PASSWORD_SHOULD_BE_REDACTED';
  await assert.rejects(run('bash',args,{env:{...proxyEnv,CLIPTALK_INSTALL_TEST_FAIL_HEALTH:'1'}}),error=>{
    assert.equal(error.code,1);
    assert.ok(error.stderr.includes('curl: (22) Forced health check failure'));
    assert.ok(error.stderr.includes('Mock service status: active (running)'));
    assert.ok(error.stderr.includes('Password: [redacted]'));
    assert.ok(error.stderr.includes('密码:   [redacted]'));
    assert.ok(!error.stderr.includes(diagnosticPassword));
    assert.ok(!error.stderr.includes(initialPassword));
    assert.ok(error.stderr.indexOf('Service status and recent logs')<error.stderr.indexOf('rolling back'));
    return true;
  });
  assert.equal(fs.realpathSync(path.join(target,'current')),changedRelease);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).sessionSecret,secret);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).port,changedPort,'Failed port changes restore the previous configuration');
  assert.equal(fs.readFileSync(path.join(target,'.port'),'utf8').trim(),String(changedPort));
  assert.equal(fs.readFileSync(unitFile,'utf8'),previousUnit);
  assert.equal(accountsFingerprint(),expectedAccounts,'Account records must also survive rollback');
  const restored=new Database(path.join(target,'data','database','workspace.db'));
  assert.equal(restored.prepare('SELECT clipboard_text FROM workspaces WHERE owner_id=?').get('test-owner').clipboard_text,'preserve me');restored.close();
  let response;
  for(let attempt=0;attempt<40;attempt++){
    try{response=await fetch('http://127.0.0.1:'+changedPort+'/api/health');if(response.ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(response?.status,200);
  // A failed explicit directory switch must restore the previously running unit,
  // even though the new directory has no previous release to roll back to.
  const switchedTarget=path.join(dir,'another-install');
  await assert.rejects(run('bash',[script,'--dir',switchedTarget,'--port',String(port)],
    {env:{...proxyEnv,CLIPTALK_INSTALL_TEST_FAIL_HEALTH:'1'}}),error=>error.code===1);
  assert.equal(fs.readFileSync(unitFile,'utf8'),previousUnit);
  assert.equal(accountsFingerprint(),expectedAccounts);
  for(let attempt=0;attempt<40;attempt++){
    try{response=await fetch('http://127.0.0.1:'+changedPort+'/api/health');if(response.ok)break;}catch{response=null;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(response?.status,200);
  const login=await fetch('http://127.0.0.1:'+changedPort+'/api/login',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'existing-admin',password:initialPassword})
  });
  assert.equal(login.status,200,'The existing password must continue to authenticate the renamed administrator');
  // Fail after writing the new global unit but before activation; the original
  // installation must still be restored, including on an empty new directory.
  await assert.rejects(run('bash',[script,'--dir',path.join(dir,'reload-failure'),'--port',String(port)],
    {env:{...env,CLIPTALK_INSTALL_TEST_FAIL_RELOAD_ONCE:'1'}}),error=>error.code===1);
  assert.equal(fs.readFileSync(unitFile,'utf8'),previousUnit);
  assert.equal(accountsFingerprint(),expectedAccounts);
  for(let attempt=0;attempt<40;attempt++){
    try{response=await fetch('http://127.0.0.1:'+changedPort+'/api/health');if(response.ok)break;}catch{response=null;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(response?.status,200);
});
