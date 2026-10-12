'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {execFile,execFileSync}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const root=path.join(__dirname,'..');
function executable(file,text){fs.writeFileSync(file,text,{mode:0o755});}
function isolatedInstaller(dir,release){
  fs.writeFileSync(path.join(dir,'os-release'),release);
  fs.mkdirSync(path.join(dir,'systemd'));
  const script=path.join(dir,'deploy.sh');
  fs.writeFileSync(script,fs.readFileSync(path.join(root,'deploy.sh'),'utf8')
    .replaceAll('/etc/os-release',path.join(dir,'os-release'))
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
]) test('native installer on '+platform.name+': fresh startup, persistent update and rollback with mocked host commands',async t=>{
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
  const publicFiles=['server.js','db.js','workspace-store.js','sharing-store.js','quota-storage.js','package.json','package-lock.json','scripts','public','i18n','deploy.sh'];
  for(const file of publicFiles)fs.cpSync(path.join(root,file),path.join(source,file),{recursive:true});
  const archive=path.join(dir,'source.tar.gz');execFileSync('tar',['-czf',archive,'-C',dir,'source']);
  const realNode=process.execPath,realCurl=execFileSync('bash',['-c','command -v curl'],{encoding:'utf8'}).trim();
  executable(path.join(bin,'node'),'#!/bin/sh\nexec '+JSON.stringify(realNode)+' "$@"\n');
  executable(path.join(bin,'npm'),'#!/bin/sh\nln -s "$CLIPTALK_INSTALL_TEST_MODULES" node_modules\n');
  executable(path.join(bin,'sudo'),'#!/bin/sh\nexec "$@"\n');
  executable(path.join(bin,'seq'),'#!/bin/sh\nprintf "1\\n2\\n3\\n"\n');
  executable(path.join(bin,'journalctl'),'#!/bin/sh\nexit 0\n');
  executable(path.join(bin,'curl'),`#!/usr/bin/env python3
import os,sys,shutil,subprocess
args=sys.argv[1:]
if any('api.github.com/repos/' in a for a in args):
 shutil.copyfile(os.environ['CLIPTALK_INSTALL_TEST_ARCHIVE'],args[args.index('-o')+1]);sys.exit(0)
if os.environ.get('CLIPTALK_INSTALL_TEST_FAIL_HEALTH')=='1' and any('/api/health' in a for a in args):sys.exit(22)
sys.exit(subprocess.call([${JSON.stringify(realCurl)}]+args))
`);
  executable(path.join(bin,'install'),`#!/usr/bin/env python3
import os,sys,shutil
if sys.argv[-1]!='/etc/systemd/system/cliptalk-workspace.service':raise RuntimeError('Unexpected host mutation')
shutil.copyfile(sys.argv[-2],os.environ['CLIPTALK_INSTALL_TEST_ROOT']+'/unit')
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
 stop();unit=(root/'unit').read_text().splitlines();cwd=next(l[17:] for l in unit if l.startswith('WorkingDirectory='))
 data=next(l[len('Environment=CLIPTALK_DATA_DIR='):] for l in unit if l.startswith('Environment=CLIPTALK_DATA_DIR='))
 logfile=open(root/'service.log','ab');env=os.environ.copy();env['CLIPTALK_DATA_DIR']=data;env['CLIPTALK_HOST']='127.0.0.1'
 child=subprocess.Popen([${JSON.stringify(realNode)},cwd+'/server.js'],cwd=cwd,env=env,stdout=logfile,stderr=logfile,start_new_session=True)
 pidfile.write_text(str(child.pid))
elif command not in ['daemon-reload','enable']:raise RuntimeError('Unexpected service action')
`);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,
    BASH_ENV:shellEnv,CLIPTALK_INSTALL_TEST_MANAGER:platform.manager,
    CLIPTALK_INSTALL_TEST_ROOT:dir,CLIPTALK_INSTALL_TEST_ARCHIVE:archive,
    CLIPTALK_INSTALL_TEST_MODULES:path.join(root,'node_modules')};
  t.after(async()=>{await run(path.join(bin,'systemctl'),['stop','cliptalk-workspace.service'],{env});fs.rmSync(dir,{recursive:true,force:true});});
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const args=[script,'--mode','native','--port',String(port),'--dir',target];
  const first=await run('bash',args,{env});assert.ok(first.stdout.includes('ClipTalk is ready'));
  const packages=fs.readFileSync(path.join(dir,'packages.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(packages.every(args=>args[0]===platform.manager));
  const install=packages.find(args=>args[1]==='install');
  assert.ok(install.includes(platform.manager==='apt-get'?'xz-utils':'xz'));
  assert.ok(install.includes(platform.manager==='apt-get'?'g++':'gcc-c++'));
  const firstRelease=fs.realpathSync(path.join(target,'current'));
  const configFile=path.join(target,'data','config.json');const secret=JSON.parse(fs.readFileSync(configFile)).sessionSecret;
  const Database=require('better-sqlite3');
  const database=new Database(path.join(target,'data','database','workspace.db'));
  database.prepare('INSERT INTO workspaces (owner_id,clipboard_text) VALUES (?,?)').run('test-owner','preserve me');database.close();
  const second=await run('bash',args,{env});assert.ok(second.stdout.includes('Previous data backup'));
  const secondRelease=fs.realpathSync(path.join(target,'current'));assert.notEqual(secondRelease,firstRelease);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).sessionSecret,secret);
  await assert.rejects(run('bash',args,{env:{...env,CLIPTALK_INSTALL_TEST_FAIL_HEALTH:'1'}}),error=>error.code===1);
  assert.equal(fs.realpathSync(path.join(target,'current')),secondRelease);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).sessionSecret,secret);
  const restored=new Database(path.join(target,'data','database','workspace.db'));
  assert.equal(restored.prepare('SELECT clipboard_text FROM workspaces WHERE owner_id=?').get('test-owner').clipboard_text,'preserve me');restored.close();
  let response;
  for(let attempt=0;attempt<40;attempt++){
    try{response=await fetch('http://127.0.0.1:'+port+'/api/health');if(response.ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(response?.status,200);
});
