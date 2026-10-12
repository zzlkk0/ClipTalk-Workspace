'use strict';
window.ClipTalkUI = (() => {
  let dictionary = {}, language = localStorage.getItem('lang') || 'zh-CN';
  let siteName = '', fallbackName = '共享工作区', pageName = '';
  const siteReady = fetch('/api/site').then(response => response.json()).then(site => {
    siteName = site.siteName || ''; applyBrand();
  }).catch(() => {});
  function applyBrand(fallback, page) {
    if (fallback) fallbackName = fallback;
    if (page !== undefined) pageName = page;
    const name = siteName || fallbackName;
    document.querySelectorAll('[data-site-name]').forEach(element => { element.textContent = name; });
    document.title = (pageName ? pageName + ' — ' : '') + name;
  }
  function updateSite(site) { siteName = site.siteName || ''; applyBrand(); }
  function t(key) { return key.split('.').reduce((value, part) => value?.[part], dictionary) || key; }
  function error(code) { const text = t('errors.' + code); return text === 'errors.' + code ? t('errors.server_error') : text; }
  function json(method, body) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'server_error'), { status: response.status });
    return data;
  }
  function size(bytes) {
    return bytes >= 1073741824 ? (bytes / 1073741824).toFixed(2) + ' GB' : bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + ' MB' : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
  }
  function login() { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); }
  async function init(page, auth = true) {
    const user = auth ? await api('/api/me').catch(error => { if (error.status === 401) login(); throw error; }) : await api('/api/me').catch(() => null);
    dictionary = await api('/api/i18n/' + (language === 'en' ? 'en' : 'zh-CN'));
    document.documentElement.lang = language;
    document.querySelectorAll('[data-t]').forEach(element => { element.textContent = t(element.dataset.t); });
    document.querySelectorAll('[data-t-placeholder]').forEach(element => { element.placeholder = t(element.dataset.tPlaceholder); });
    await siteReady; applyBrand(t('app.title'), t(page));
    const languageButton = document.getElementById('language-button');
    if (languageButton) languageButton.onclick = () => { localStorage.setItem('lang', language === 'en' ? 'zh-CN' : 'en'); location.reload(); };
    return user;
  }
  function notice(message, bad = false) {
    const element = document.getElementById('page-notice');
    element.textContent = message; element.classList.toggle('error', bad); element.hidden = false;
  }
  return { init, api, json, t, error, size, login, notice, applyBrand, updateSite, siteReady };
})();
