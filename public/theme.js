'use strict';
window.ClipTalkTheme = (() => {
  let user = null, theme = 'dark', saving = false;
  let language = localStorage.getItem('lang') || 'zh-CN';
  try {
    const cached = JSON.parse(localStorage.getItem('cliptalk-theme') || 'null');
    if (cached && ['dark', 'light'].includes(cached.theme)) theme = cached.theme;
  } catch {}
  function render() {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.hidden = !user;
      button.disabled = saving;
      button.textContent = theme === 'light' ? '🌙' : '☀️';
      const label = language === 'en'
        ? (theme === 'light' ? 'Switch to dark theme' : 'Switch to white theme')
        : (theme === 'light' ? '切换深色主题' : '切换白色主题');
      button.title = label; button.setAttribute('aria-label', label);
    });
    document.querySelectorAll('[data-theme-select]').forEach(select => {
      select.value = theme; select.disabled = saving;
    });
  }
  function update(value) {
    theme = value.theme === 'light' ? 'light' : 'dark';
    if (user) {
      user.theme = theme;
      localStorage.setItem('cliptalk-theme', JSON.stringify({ owner: user.id, theme }));
    }
    render();
  }
  async function refresh() {
    try {
      const response = await fetch('/api/me');
      if (!response.ok) { user = null; update({ theme: 'dark' }); return null; }
      user = await response.json(); update(user); return user;
    } catch { return user; }
  }
  async function save(value) {
    if (!user || saving) return;
    saving = true; render();
    try {
      const response = await fetch('/api/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'server_error');
      update(data);
      return data;
    } finally { saving = false; render(); }
  }
  function setLanguage(value) { language = value === 'en' ? 'en' : 'zh-CN'; render(); }
  render();
  const ready = refresh();
  document.addEventListener('DOMContentLoaded', () => {
    render();
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => save(theme === 'light' ? 'dark' : 'light').catch(() => {
        alert(language === 'en' ? 'Could not save theme. Please try again.' : '主题保存失败，请重试。');
      }));
    });
  });
  window.addEventListener('storage', event => {
    if (event.key !== 'cliptalk-theme' || !user) return;
    try { const value = JSON.parse(event.newValue); if (value?.owner === user.id) update(value); } catch {}
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && user) refresh(); });
  return { ready, refresh, save, update, setLanguage };
})();
