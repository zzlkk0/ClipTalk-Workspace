'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Database=require('better-sqlite3');
const {startFixture,json,macauDate}=require('./fixture');
const io=require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS,'socket.io-client') : 'socket.io-client').io;
function once(socket,event){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Socket timeout: '+event)),5000);socket.once(event,data=>{clearTimeout(timer);resolve(data)});});}
async function connect(t,f,cookie){const socket=io(f.base,{autoConnect:false,transports:['websocket'],extraHeaders:{Cookie:cookie},reconnection:false});t.after(()=>socket.disconnect());const ready=once(socket,'init');socket.connect();await ready;return socket;}

test('administrators can create and promote administrators; initial admin name and identity remain protected',async t=>{
  const f=await startFixture(t,{legacy:false,builtinAdmin:true});
  const root=await f.login('admin'),alice=await f.login('alice'),bob=await f.login('bob');
  const body={username:'manager_one',password:f.password};
  assert.equal((await f.request('/api/admin/administrators',alice,json('POST',body))).status,403);
  assert.equal((await f.request('/api/admin/users/bob/promote',alice,{method:'POST'})).status,403);
  for(const data of [{username:'x',password:f.password},{username:'bad name',password:f.password},{username:'manager_one',password:'short'},{username:'manager_one',password:'字'.repeat(30)}]){
    assert.equal((await f.request('/api/admin/administrators',root,json('POST',data))).status,400);
  }
  const created=await f.request('/api/admin/administrators',root,json('POST',body));
  assert.equal(created.status,201);assert.equal(created.data.user.role,'admin');assert.equal(created.data.user.status,'active');assert.equal(created.data.user.builtin_admin,0);
  assert.equal((await f.request('/api/admin/administrators',root,json('POST',body))).status,409);
  const manager=await f.login('manager_one');
  const changed=await f.request('/api/account',manager,json('PATCH',{username:'manager_renamed',currentPassword:f.password}));
  assert.equal(changed.status,200);assert.equal(changed.data.user.id,created.data.user.id);assert.equal(changed.data.user.role,'admin');
  assert.equal((await f.request('/api/admin/users',manager)).status,200);
  const rootRenamed=await f.request('/api/account',root,json('PATCH',{username:'root_renamed',currentPassword:f.password}));
  assert.equal(rootRenamed.status,409);assert.equal(rootRenamed.data.error,'protected_admin_name');
  const rootInfo=(await f.request('/api/me',root)).data;
  assert.equal(rootInfo.username,'admin');assert.equal(rootInfo.builtin_admin,1);assert.equal(rootInfo.deletionBlockedReason,'protected_admin');
  const newPassword=f.password+'-changed';
  assert.equal((await f.request('/api/account',root,json('PATCH',{currentPassword:f.password,newPassword}))).status,200);
  assert.equal((await f.request('/api/login',null,json('POST',{username:'admin',password:newPassword}))).status,200);
  assert.equal((await f.request('/api/login',null,json('POST',{username:'admin',password:f.password}))).status,401);
  assert.equal((await f.request('/api/account',root,json('DELETE',{username:'admin',currentPassword:newPassword,confirm:true}))).data.error,'protected_admin');
  const socket=await connect(t,f,bob),promoted=once(socket,'account-role-updated');
  assert.equal((await f.request('/api/admin/users/bob/promote',root,{method:'POST'})).status,200);
  assert.equal((await promoted).role,'admin');assert.equal((await f.request('/api/admin/users',bob)).status,200);
  const deleted=await f.request('/api/account',manager,json('DELETE',{username:'manager_renamed',currentPassword:f.password,confirm:true}));
  assert.equal(deleted.status,200);assert.equal((await f.request('/api/me',manager)).status,401);
  assert.equal((await f.request('/api/me',root)).data.id,'admin-fixture');
});

test('revoking another administrator preserves all account data and immediately removes access from existing sessions',async t=>{
  const f=await startFixture(t,{legacy:false,builtinAdmin:true});
  const root=await f.login('admin'),alice=await f.login('alice'),alice2=await f.login('alice'),bob=await f.login('bob');
  const endpoint='/api/admin/users/alice/demote';
  assert.equal((await f.request(endpoint,null,{method:'POST'})).status,401);
  assert.equal((await f.request(endpoint,bob,{method:'POST'})).status,403);
  assert.equal((await f.request('/api/admin/users/missing/demote',root,{method:'POST'})).status,404);
  assert.equal((await f.request('/api/admin/users/bob/demote',root,{method:'POST'})).data.error,'not_admin');
  assert.equal((await f.request('/api/admin/users/alice/promote',root,{method:'POST'})).status,200);
  assert.equal((await f.request('/api/admin/users/admin-fixture/demote',alice,{method:'POST'})).data.error,'protected_admin_role');
  assert.equal((await f.request(endpoint,alice,{method:'POST'})).data.error,'cannot_demote_self');
  await f.request('/api/admin/users/alice/quota',root,json('PATCH',{quotaBytes:4096}));
  await f.request('/api/preferences',alice,json('PATCH',{theme:'light'}));
  const body=new FormData();body.append('files',new Blob(['retained private file']),'retained.txt');
  const uploaded=await f.request('/upload',alice,{method:'POST',body});assert.equal(uploaded.status,200);
  const name=uploaded.data.files[0].name;
  const share=await f.request('/api/shares',alice,json('POST',{name,visibility:'users',recipients:['bob']}));assert.equal(share.status,201);
  const date=macauDate();
  assert.equal((await f.request('/api/archives',alice,json('POST',{title:'retained archive',scope:'both',startDate:date,endDate:date}))).status,201);
  const aSocket=await connect(t,f,alice),a2Socket=await connect(t,f,alice2),bSocket=await connect(t,f,bob),outside=[];
  bSocket.on('account-role-updated',data=>outside.push(data));
  const records=new Database(path.join(f.dir,'database/users.db'),{readonly:true});t.after(()=>records.close());
  const workspace=new Database(path.join(f.dir,'database/workspace.db'),{readonly:true});t.after(()=>workspace.close());
  const beforeUser=records.prepare('SELECT * FROM users WHERE id=?').get('alice');
  const tables=['workspaces','quotas','archives','assets','files','messages','message_assets','file_shares','share_recipients'];
  const snapshot=()=>Object.fromEntries(tables.map(table=>[table,workspace.prepare('SELECT * FROM '+table).all()]));
  const beforeData=snapshot(),changed=once(aSocket,'account-role-updated'),changed2=once(a2Socket,'account-role-updated');
  const demoted=await f.request(endpoint,root,{method:'POST'});
  assert.equal(demoted.status,200);assert.equal(demoted.data.user.role,'user');assert.equal(demoted.data.user.status,'active');
  assert.deepEqual(await changed,{role:'user'});assert.deepEqual(await changed2,{role:'user'});
  const reconnect=io(f.base,{autoConnect:false,transports:['websocket'],extraHeaders:{Cookie:alice},reconnection:false});t.after(()=>reconnect.disconnect());
  const info=once(reconnect,'user-info');reconnect.connect();assert.equal((await info).role,'user');
  for(const cookie of [alice,alice2]){
    assert.equal((await f.request('/api/admin/users',cookie)).status,403);
    assert.equal((await f.request('/api/admin/settings',cookie,json('POST',{site_name:'forbidden'}))).status,403);
    assert.equal((await f.request('/api/admin/users/bob/promote',cookie,{method:'POST'})).status,403);
    assert.equal((await f.request('/api/me',cookie)).data.role,'user');
    assert.equal((await f.request('/api/workspace',cookie)).status,200);
  }
  const afterUser=records.prepare('SELECT * FROM users WHERE id=?').get('alice');
  assert.deepEqual({...afterUser,role:beforeUser.role},beforeUser);assert.deepEqual(snapshot(),beforeData);
  assert.equal((await fetch(f.base+'/api/shares/'+share.data.token+'/download',{headers:{Cookie:bob}})).status,200);
  assert.equal((await f.request('/api/storage',alice)).data.quotaBytes,4096);assert.equal((await f.request('/api/me',alice)).data.theme,'light');
  assert.equal((await f.request('/api/admin/users/alice/promote',root,{method:'POST'})).status,200);
  assert.equal((await f.request('/api/admin/users',alice)).status,200);
  await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(outside,[]);
});

test('concurrent administrator revocations retain one administrator and cannot revoke your own access',async t=>{
  const f=await startFixture(t,{legacy:false});
  const root=await f.login('test_admin');
  const created=await f.request('/api/admin/administrators',root,json('POST',{username:'second_admin',password:f.password}));
  const second=await f.login('second_admin');
  const removed=await Promise.all([
    f.request('/api/admin/users/'+created.data.user.id+'/demote',root,{method:'POST'}),
    f.request('/api/admin/users/test_admin/demote',second,{method:'POST'}),
  ]);
  assert.deepEqual(removed.map(response=>response.status).sort(),[200,403]);
  const records=new Database(path.join(f.dir,'database/users.db'),{readonly:true});
  const survivor=records.prepare("SELECT id,username FROM users WHERE role='admin' AND status='active'").all();
  assert.equal(survivor.length,1);assert.equal(records.prepare('SELECT COUNT(*) AS n FROM users').get().n,4);records.close();
  const cookie=await f.login(survivor[0].username);
  assert.equal((await f.request('/api/admin/users/'+survivor[0].id+'/demote',cookie,{method:'POST'})).data.error,'cannot_demote_self');
});

test('concurrent administrator self deletions preserve at least one active administrator',async t=>{
  const f=await startFixture(t,{legacy:false});
  const root=await f.login('test_admin');
  await f.request('/api/admin/administrators',root,json('POST',{username:'second_admin',password:f.password}));
  const second=await f.login('second_admin');
  const removed=await Promise.all([
    f.request('/api/account',root,json('DELETE',{username:'test_admin',currentPassword:f.password,confirm:true})),
    f.request('/api/account',second,json('DELETE',{username:'second_admin',currentPassword:f.password,confirm:true})),
  ]);
  assert.deepEqual(removed.map(response=>response.status).sort(),[200,409]);
  assert.equal(removed.find(response=>response.status===409).data.error,'last_admin');
  const records=new Database(path.join(f.dir,'database/users.db'),{readonly:true});
  assert.equal(records.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get().n,1);records.close();
});

test('account themes persist separately and broadcast only to the same account',async t=>{
  const f=await startFixture(t,{legacy:false});
  const alice=await f.login('alice'),alice2=await f.login('alice'),bob=await f.login('bob');
  const aSocket=await connect(t,f,alice2),bSocket=await connect(t,f,bob),outsider=[];
  bSocket.on('preferences-updated',event=>outsider.push(event));
  assert.equal((await f.request('/api/preferences',null,json('PATCH',{theme:'light'}))).status,401);
  for(const theme of ['blue','',true,null])assert.equal((await f.request('/api/preferences',alice,json('PATCH',{theme}))).status,400);
  const updated=once(aSocket,'preferences-updated');
  assert.equal((await f.request('/api/preferences',alice,json('PATCH',{theme:'light',userId:'bob'}))).status,200);
  assert.deepEqual(await updated,{theme:'light'});
  assert.equal((await f.request('/api/me',alice2)).data.theme,'light');
  assert.equal((await f.request('/api/me',bob)).data.theme,'dark');
  const records=new Database(path.join(f.dir,'database/users.db'),{readonly:true});
  assert.equal(records.prepare('SELECT theme FROM users WHERE id=?').get('alice').theme,'light');records.close();
  const nextDevice=await f.login('alice');assert.equal((await f.request('/api/me',nextDevice)).data.theme,'light');
  await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(outsider,[]);
});

test('admin storage includes archived file and UTF-8 text usage while preserving private content',async t=>{
  const f=await startFixture(t,{legacy:false});
  const root=await f.login('test_admin'),alice=await f.login('alice');
  const socket=await connect(t,f,alice),otherDevice=await connect(t,f,await f.login('alice')),changed=once(otherDevice,'clipboard-update');
  socket.emit('clipboard-update','私密剪贴板');await changed;
  const body=new FormData();body.append('files',new Blob(['private attachment']),'private.txt');
  assert.equal((await f.request('/upload',alice,{method:'POST',body})).status,200);
  const date=macauDate();
  await f.request('/api/archives',alice,json('POST',{title:'private archive',scope:'both',startDate:date,endDate:date}));
  assert.equal((await f.request('/api/admin/storage',alice)).status,403);
  const storage=(await f.request('/api/admin/storage',root)).data;
  const own=(await f.request('/api/storage',alice)).data,row=storage.find(user=>user.id==='alice');
  for(const key of ['usedBytes','quotaBytes','fileBytes','textBytes','availableBytes'])assert.equal(row[key],own[key]);
  assert.equal(row.fileBytes,18);assert.ok(row.textBytes>=Buffer.byteLength('私密剪贴板'));
  assert.ok(!JSON.stringify(storage).includes('private archive'));assert.ok(!JSON.stringify(storage).includes('私密剪贴板'));
});
