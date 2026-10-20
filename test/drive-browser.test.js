'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./fixture');
const { chromium } = require(process.env.CLIPTALK_TEST_TOOLS ? path.join(process.env.CLIPTALK_TEST_TOOLS, 'playwright') : 'playwright');
const waitText = (page, selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });

test('browser drive: folders, upload, moves, delete, themes, mobile and idle resume', async t => {
  const f = await startFixture(t, { legacy: false });
  const browser = await chromium.launch({ executablePath: process.env.CLIPTALK_CHROME || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  t.after(() => browser.close());
  const errors = [];
  async function login(username) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(f.base + '/login.html'); await page.locator('#username').fill(username);
    await page.locator('#password').fill(f.password); await page.locator('#btn').click();
    await page.waitForURL(f.base + '/'); await waitText(page, '#status-text', '已连接');
    return page;
  }
  const page = await login('alice'), admin = await login('test_admin');
  assert.equal(await page.locator('#panel-files button[data-t="workspace.archive"]').count(), 0);
  assert.equal(await page.locator('#archive-scope option').count(), 1);
  async function create(name) {
    await page.locator('#drive-new-folder').click(); await page.locator('#drive-name').fill(name);
    await page.locator('#drive-name-form [type=submit]').click();
    await page.waitForFunction(() => !document.getElementById('drive-name-dialog').open);
    await waitText(page, '#file-list', name);
  }
  const folderName = '<img src=x onerror=window.__injected=1>';
  // A folder name may contain markup, but never path separators.
  await create(folderName);
  assert.equal(await page.locator('#file-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await page.locator('.folder-name').click();
  await waitText(page, '#drive-breadcrumbs', folderName);
  await create('子目录'); await page.locator('.folder-name').click();
  const response = page.waitForResponse(response => response.url().includes('/upload?folderId='));
  await page.locator('#file-input').setInputFiles({ name: '报告.txt', mimeType: 'text/plain', buffer: Buffer.from('nested upload') });
  const result = await response; assert.equal(result.status(), 200);
  const file = (await result.json()).files[0]; await waitText(page, '#file-list', file.originalName);
  await page.locator('#drive-select-all').click(); await page.locator('#drive-move').click();
  await page.locator('#drive-destination').selectOption('');
  await page.locator('#drive-move-form [type=submit]').click();
  await page.waitForFunction(() => !document.getElementById('drive-move-dialog').open);
  await page.waitForFunction(() => !document.querySelector('[data-file-name]'));
  await page.locator('#drive-breadcrumbs button').first().click(); await waitText(page, '#file-list', file.originalName);
  await page.locator('.folder-item button').nth(1).click();
  await page.locator('#drive-name').fill('研究资料'); await page.locator('#drive-name-form [type=submit]').click();
  await waitText(page, '#file-list', '研究资料');
  await page.locator('#drive-select-all').click(); await page.locator('#drive-move').click();
  const destination = await page.locator('#drive-destination option').filter({ hasText: '/ 研究资料 / 子目录' }).getAttribute('value');
  await page.locator('#drive-destination').selectOption(destination);
  await page.locator('#drive-move-form [type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('[data-file-name]'));
  const artifacts = path.join(__dirname, '..', 'validation/screenshots'); fs.mkdirSync(artifacts, { recursive: true });
  await page.locator('.folder-name').click(); await page.locator('.folder-name').click();
  await waitText(page, '#file-list', file.originalName);
  await page.screenshot({ path: path.join(artifacts, 'drive-dark-desktop.png'), fullPage: true });
  await page.evaluate(async () => {
    await fetch('/api/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
  });
  await page.reload(); await waitText(page, '#status-text', '已连接');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.folder-name').click(); await page.locator('.folder-name').click();
  await waitText(page, '#file-list', file.originalName);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'drive-light-mobile.png'), fullPage: true });
  await page.locator('#drive-breadcrumbs button').first().click();
  await page.locator('.folder-item .danger').click();
  await page.waitForFunction(() => !document.querySelector('.folder-item'));
  assert.equal((await page.request.get(f.base + '/uploads/' + file.name)).status(), 404);
  await admin.goto(f.base + '/admin3.html'); await admin.locator('#idle-timeout').fill('5');
  await admin.locator('#timeout-form button').click(); await waitText(admin, '#timeout-msg', '已保存');
  await page.waitForFunction(() => !document.getElementById('idle-notice').hidden, null, { timeout: 12000 });
  assert.equal(await page.locator('#chat-input').isDisabled(), true);
  await page.waitForTimeout(1200); assert.equal(await page.locator('#idle-notice').isVisible(), true);
  await page.screenshot({ path: path.join(artifacts, 'idle-mobile.png'), fullPage: true });
  await page.locator('#resume-connection').click(); await waitText(page, '#status-text', '已连接');
  assert.equal(await page.locator('#chat-input').isEnabled(), true);
  await page.locator('#chat-input').fill('恢复连接后的对话'); await page.locator('#chat-input').press('Enter');
  await waitText(page, '#chat-messages', '恢复连接后的对话');
  assert.deepEqual(errors, []);
});
