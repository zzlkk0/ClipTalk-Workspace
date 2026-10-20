'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startFixture,json,macauDate } = require('./fixture');
const io = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS,'socket.io-client') : 'socket.io-client').io;
function once(socket,event) {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(new Error('Socket timeout: '+event)),4000);
    socket.once(event,data=>{clearTimeout(timer);resolve(data);});
  });
}
async function connect(t,base,cookie) {
  const socket=io(base,{autoConnect:false,transports:['websocket'],extraHeaders:{Cookie:cookie},reconnection:false});
  t.after(()=>socket.disconnect()); const init=once(socket,'init'), storage=once(socket,'storage-updated'); socket.connect();
  assert.deepEqual(await init,{clipboardText:'',messages:[],files:[]}); await storage; return socket;
}
const delay=()=>new Promise(resolve=>setTimeout(resolve,120));

test('API and sockets: account isolation, device sync, file ownership, archives, clear and logout',async t=>{
  const f=await startFixture(t);
  const a=await f.login('alice'),a2=await f.login('alice'),b=await f.login('bob'),admin=await f.login('test_admin');
  for (const url of ['/api/workspace','/api/files','/api/archives','/uploads/100_legacy.txt']) assert.equal((await f.request(url)).status,401);
  const sa=await connect(t,f.base,a),sa2=await connect(t,f.base,a2),sb=await connect(t,f.base,b);
  const outsiderEvents=[];
  for (const event of ['chat-message','clipboard-update','files-updated','workspace-updated','archives-updated']) sb.on(event,data=>outsiderEvents.push({event,data}));
  const clipboard=once(sa2,'clipboard-update');
  sa.emit('clipboard-update','alice-only clipboard'); assert.equal(await clipboard,'alice-only clipboard');
  const messageA=once(sa,'chat-message'),messageA2=once(sa2,'chat-message');
  sa.emit('chat-message',{text:'multi-device chat',userId:'bob'});
  assert.equal((await messageA).from,'alice'); assert.equal((await messageA2).text,'multi-device chat');
  const form=new FormData(); form.append('files',new Blob(['private file content']),'private-文件-"quote.txt');
  const fileEvent=once(sa2,'files-updated');
  const uploaded=await f.request('/upload',a,{method:'POST',body:form}); assert.equal(uploaded.status,200);
  const file=uploaded.data.files[0]; assert.equal((await fileEvent)[0].name,file.name);
  assert.equal((await f.request('/api/files',b)).data.length,0);
  assert.equal((await fetch(f.base+'/uploads/'+file.name,{headers:{Cookie:a}})).status,200);
  for (const cookie of [b,admin]) {
    assert.equal((await f.request('/uploads/'+file.name,cookie)).status,404);
    assert.equal((await f.request('/api/files/'+file.name,cookie,{method:'DELETE'})).status,404);
  }
  assert.equal((await f.request('/uploads/%2E%2E%2Fconfig.json',a)).status,404);
  assert.equal((await f.request('/api/workspace?userId=bob',a)).data.clipboardText,'alice-only clipboard');
  const today=macauDate();
  const snapshot=once(sa2,'workspace-updated');
  const created=await f.request('/api/archives',a,json('POST',{title:'阶段一',startDate:today,endDate:today,scope:'both',ownerId:'bob'}));
  assert.equal(created.status,201);const archive=created.data;
  const changed=await snapshot;assert.equal(changed.messages.length,0);assert.equal(changed.files.length,0);assert.equal(changed.clipboardText,'alice-only clipboard');
  assert.equal(archive.messages.length,2);assert.equal(archive.files.length,1);
  for (const cookie of [b,admin]) {
    assert.equal((await f.request('/api/archives/'+archive.id,cookie)).status,404);
    assert.equal((await f.request('/api/archives/'+archive.id,cookie,json('PATCH',{title:'stolen'}))).status,404);
    assert.equal((await f.request('/api/archives/'+archive.id+'/restore',cookie,json('POST',{}))).status,404);
  }
  assert.equal((await f.request('/api/archives',b)).data.length,0);
  assert.equal((await f.request('/uploads/'+file.name,a)).status,200);
  assert.equal((await f.request('/api/archives/'+archive.id,a,json('PATCH',{title:'命名归档'}))).status,200);
  assert.equal((await f.request('/api/archives/'+archive.id,a)).data.title,'命名归档');
  assert.equal((await f.request('/api/archives',a,json('POST',{title:'empty',startDate:today,endDate:today,scope:'both'}))).data.error,'empty_archive');
  assert.equal((await f.request('/api/archives',a,json('POST',{title:'bad',startDate:'2026-02-30',endDate:today,scope:'both'}))).status,400);
  assert.equal((await f.request('/api/workspace/clear',a,json('POST',{scope:'chat'}))).status,400);
  assert.equal((await f.request('/api/workspace/clear',a,json('POST',{scope:'chat',confirm:true}))).status,200);
  assert.equal((await f.request('/api/archives',a)).data.length,1);
  const restored=once(sa2,'workspace-updated');
  assert.equal((await f.request('/api/archives/'+archive.id+'/restore',a,json('POST',{}))).status,200);
  assert.equal((await restored).files.length,1);
  const cleared=once(sa2,'workspace-updated');
  assert.equal((await f.request('/api/workspace/clear',a,json('POST',{scope:'files',confirm:true}))).status,200);
  assert.equal((await cleared).files.length,0);
  assert.equal((await f.request('/uploads/'+file.name,a)).status,404);
  assert.equal((await f.request('/api/workspace/clear',a,json('POST',{scope:'chat',confirm:true}))).status,200);
  assert.equal((await f.request('/api/workspace',a)).data.messages.length,0);
  const legacy=(await f.request('/api/archives',admin)).data;
  assert.equal(legacy[0].title,'升级前共享区');
  assert.equal((await f.request('/uploads/100_legacy.txt',admin)).status,200);
  assert.equal((await f.request('/uploads/100_legacy.txt',b)).status,404);
  assert.equal((await f.request('/api/archives/'+legacy[0].id,a)).status,404);
  await delay(); assert.deepEqual(outsiderEvents,[]);
  const disconnected=once(sa,'disconnect');
  await f.request('/api/logout',a,json('POST',{}));await disconnected;
  sa.emit('chat-message',{text:'after logout'});
  assert.equal((await f.request('/api/workspace',a2)).data.messages.length,0);
});

test('admin quota changes, concurrent uploads, batch rejection and archive deletion', async t => {
  const f=await startFixture(t,{legacy:false});
  const a=await f.login('alice'),b=await f.login('bob'),admin=await f.login('test_admin');
  assert.equal((await f.request('/api/storage',a)).data.quotaBytes,1024**3);
  assert.equal((await f.request('/api/admin/storage',a)).status,403);
  assert.equal((await f.request('/api/admin/users/alice/quota',a,json('PATCH',{quotaBytes:2000}))).status,403);
  assert.equal((await f.request('/api/admin/users/missing/quota',admin,json('PATCH',{quotaBytes:2000}))).status,404);
  assert.equal((await f.request('/api/admin/users/bob/quota',admin,json('PATCH',{quotaBytes:-1}))).status,400);
  assert.equal((await f.request('/api/admin/users/bob/quota',admin,json('PATCH',{quotaBytes:1500}))).status,200);
  const device=await connect(t,f.base,b);
  const storageChanged=once(device,'storage-updated');
  await f.request('/api/admin/users/bob/quota',admin,json('PATCH',{quotaBytes:1501}));
  assert.equal((await storageChanged).quotaBytes,1501);
  function form(name,size){const body=new FormData();body.append('files',new Blob(['x'.repeat(size)]),name);return body;}
  const results=await Promise.all([
    f.request('/upload',b,{method:'POST',body:form('first.txt',1024)}),
    f.request('/upload',b,{method:'POST',body:form('second.txt',1024)}),
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,413]);
  const quota=(await f.request('/api/storage',b)).data;
  assert.equal(quota.fileBytes,1024);assert.ok(quota.usedBytes<=quota.quotaBytes);
  const smallChat=await new Promise(resolve=>device.emit('chat-message',{text:'x'.repeat(1000)},resolve));
  assert.deepEqual(smallChat,{ok:false,error:'quota_exceeded'});
  assert.equal((await f.request('/api/workspace',b)).data.messages.length,1);
  await f.request('/api/workspace/clear',b,json('POST',{scope:'files',confirm:true}));
  await f.request('/api/workspace/clear',b,json('POST',{scope:'chat',confirm:true}));
  const batch=new FormData();batch.append('files',new Blob(['x'.repeat(800)]),'one.txt');batch.append('files',new Blob(['x'.repeat(800)]),'two.txt');
  assert.equal((await f.request('/upload',b,{method:'POST',body:batch})).status,413);
  assert.equal((await f.request('/api/storage',b)).data.usedBytes,0);
  assert.equal(require('node:fs').readdirSync(f.dir+'/uploads').length,0);
  const uploaded=await f.request('/upload',b,{method:'POST',body:form('keep.txt',1000)});
  assert.equal(uploaded.status,200);
  const today=macauDate();
  const archive=(await f.request('/api/archives',b,json('POST',{title:'quota archive',scope:'both',startDate:today,endDate:today}))).data;
  const usedBefore=(await f.request('/api/storage',b)).data.usedBytes;
  assert.ok(usedBefore>=1000);
  assert.equal((await f.request('/api/archives/'+archive.id,b,json('DELETE',{}))).status,400);
  assert.equal((await f.request('/api/archives/'+archive.id,a,json('DELETE',{confirm:true}))).status,404);
  assert.equal((await f.request('/api/archives/'+archive.id,b,json('DELETE',{confirm:true}))).status,200);
  assert.equal((await f.request('/api/storage',b)).data.usedBytes,1000);
  assert.equal((await f.request('/uploads/'+uploaded.data.files[0].name,b)).status,200);
  assert.equal((await f.request('/api/drive/files',b,json('DELETE',{names:[uploaded.data.files[0].name],confirm:true}))).status,200);
  assert.equal((await f.request('/api/storage',b)).data.usedBytes,0);
  assert.equal((await f.request('/uploads/'+uploaded.data.files[0].name,b)).status,404);
});
