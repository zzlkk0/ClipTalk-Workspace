'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {startFixture}=require('./fixture');
const {chromium}=require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS,'playwright') : 'playwright');
async function waitText(page,selector,text){await page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});}
async function login(browser,f,username,viewport={width:1440,height:900}){
  const context=await browser.newContext({viewport,locale:'zh-CN'}),page=await context.newPage();
  await page.goto(f.base+'/login.html');await page.locator('#username').fill(username);await page.locator('#password').fill(f.password);
  await page.locator('#btn').click();await page.waitForURL(f.base+'/');await waitText(page,'#status-text','已连接');
  page.on('dialog',dialog=>dialog.accept());return{context,page};
}
async function theme(page,value){await page.waitForFunction(value=>document.documentElement.dataset.theme===value,value);}

test('browser: account themes, administrator creation and revocation, protected admin name, and storage refresh',async t=>{
  const f=await startFixture(t,{legacy:false,builtinAdmin:true});
  const browser=await chromium.launch({executablePath:process.env.CLIPTALK_CHROME||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const root=await login(browser,f,'admin'),alice=await login(browser,f,'alice'),a2=await login(browser,f,'alice'),bob=await login(browser,f,'bob');
  const errors=[];for(const device of [root,alice,a2,bob])device.page.on('pageerror',error=>errors.push(error.message));
  await alice.page.locator('#account-label').click();await alice.page.locator('#theme-select').selectOption('light');
  await waitText(alice.page,'#page-notice','主题已保存');await theme(alice.page,'light');await theme(a2.page,'light');await theme(bob.page,'dark');
  assert.equal(await alice.page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(245, 247, 251)');
  await alice.page.goto(f.base+'/');await waitText(alice.page,'#status-text','已连接');await theme(alice.page,'light');
  const newDevice=await login(browser,f,'alice',{width:390,height:844});await theme(newDevice.page,'light');
  assert.equal(await newDevice.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await alice.page.locator('#chat-input').fill('new storage text');await alice.page.locator('#chat-input').press('Enter');await waitText(alice.page,'#chat-messages','new storage text');
  await alice.page.locator('#sharing-button').click();await theme(alice.page,'light');
  assert.equal(await alice.page.evaluate(()=>getComputedStyle(document.querySelector('.card')).backgroundColor),'rgb(255, 255, 255)');
  await root.page.locator('#admin-btn').click();await waitText(root.page,'#storage-table','alice');
  await root.page.locator('[data-theme-toggle]').click();await theme(root.page,'light');
  const row=root.page.locator('[data-storage-user="alice"]');
  assert.notEqual(await row.locator('[data-storage-used]').textContent(),'0 B');
  await row.locator('input').fill('321');
  await root.page.locator('#refresh-storage').click();await root.page.waitForFunction(()=>!document.querySelector('#refresh-storage').disabled);
  assert.equal(await row.locator('input').inputValue(),'321');
  assert.ok((await root.page.locator('#total-storage-text').textContent()).length>0);
  await root.page.locator('#new-admin-username').fill('manager_one');await root.page.locator('#new-admin-password').fill(f.password);
  await root.page.locator('#create-admin-form button').click();await waitText(root.page,'#admin-create-msg','管理员已创建');
  await waitText(root.page,'#user-table','manager_one');
  await root.page.locator('[data-promote-user="bob"]').click();await bob.page.locator('#admin-btn').waitFor({state:'visible'});
  await root.page.locator('[data-demote-user="bob"]').click();await bob.page.locator('#admin-btn').waitFor({state:'hidden'});
  await root.page.locator('[data-promote-user="bob"]').waitFor({state:'visible'});
  assert.equal(await bob.page.evaluate(async()=> (await fetch('/api/admin/users')).status),403);
  assert.equal(await bob.page.evaluate(async()=> (await fetch('/api/me')).status),200);
  const manager=await login(browser,f,'manager_one');manager.page.on('pageerror',error=>errors.push(error.message));
  await manager.page.locator('#admin-btn').click();await manager.page.locator('#my-account-link').click();
  await manager.page.locator('#account-username').fill('manager_renamed');await manager.page.locator('#account-password').fill(f.password);
  await manager.page.locator('#account-form button').click();await waitText(manager.page,'#page-notice','账号已更新');
  await manager.page.locator('#delete-username').fill('manager_renamed');await manager.page.locator('#delete-password').fill(f.password);
  await manager.page.locator('#delete-account-form button').click();await manager.page.waitForURL(f.base+'/login.html');
  await root.page.locator('#my-account-link').click();await waitText(root.page,'#last-admin-hint','默认管理员账号不能删除');
  assert.equal(await root.page.locator('#delete-account-form button').isDisabled(),true);
  await waitText(root.page,'#username-hint','默认管理员的用户名固定');
  assert.equal(await root.page.locator('#account-username').isEditable(),false);
  assert.equal(await root.page.locator('#account-new-password').isEditable(),true);
  assert.equal(await root.page.locator('#account-username').inputValue(),'admin');
  const screenshots=path.join(__dirname,'..','validation','screenshots');fs.mkdirSync(screenshots,{recursive:true});
  await root.page.goto(f.base+'/admin3.html');await waitText(root.page,'#storage-table','alice');await theme(root.page,'light');
  await root.page.screenshot({path:path.join(screenshots,'white-admin-storage.png'),fullPage:true});
  await alice.page.goto(f.base+'/');await waitText(alice.page,'#status-text','已连接');
  await alice.page.screenshot({path:path.join(screenshots,'white-workspace.png'),fullPage:true});
  await newDevice.page.screenshot({path:path.join(screenshots,'white-workspace-mobile.png'),fullPage:true});
  await alice.page.locator('[data-theme-toggle]').click();await theme(alice.page,'dark');await theme(newDevice.page,'dark');
  await theme(bob.page,'dark');assert.deepEqual(errors,[]);
});
