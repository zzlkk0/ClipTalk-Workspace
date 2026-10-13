'use strict';
(async () => {
  const ui = ClipTalkUI;
  let user;
  try { user = await ui.init('account.title'); }
  catch (error) { ui.notice(ui.error(error.message), true); return; }
  const username = document.getElementById('account-username');
  username.value = user.username;
  function applyPolicy() {
    document.getElementById('account-admin-link').hidden = user.role !== 'admin';
    username.readOnly = !!user.builtin_admin;
    const nameHint = document.getElementById('username-hint');
    nameHint.hidden = !user.builtin_admin;
    nameHint.textContent = user.builtin_admin ? ui.error('protected_admin_name') : '';
    if (user.builtin_admin) username.setAttribute('aria-describedby', 'username-hint');
    else username.removeAttribute('aria-describedby');
    const reason = user.deletionBlockedReason;
    const hint = document.getElementById('last-admin-hint');
    hint.hidden = !reason; hint.textContent = reason ? ui.error(reason) : '';
    document.querySelectorAll('#delete-account-form input, #delete-account-form button').forEach(element => { element.disabled = !!reason; });
    document.getElementById('delete-username').placeholder = user.username;
  }
  applyPolicy();
  document.getElementById('theme-select').addEventListener('change', async event => {
    try { await ClipTalkTheme.save(event.target.value); ui.notice(ui.t('preferences.saved')); }
    catch (error) { ui.notice(ui.error(error.message), true); }
  });
  document.getElementById('account-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target, button = form.querySelector('button');
    const newPassword = document.getElementById('account-new-password').value;
    if (newPassword !== document.getElementById('account-confirm-password').value) { ui.notice(ui.t('register.error_password_mismatch'), true); return; }
    button.disabled = true;
    try {
      const result = await ui.api('/api/account', ui.json('PATCH', {
        username: username.value.trim(), currentPassword: document.getElementById('account-password').value,
        ...(newPassword ? { newPassword } : {}),
      }));
      user = result.user; form.reset(); username.value = user.username;
      applyPolicy();
      ui.notice(ui.t('account.saved'));
    } catch (error) { ui.notice(ui.error(error.message), true); }
    finally { button.disabled = false; }
  });
  document.getElementById('delete-account-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!confirm(ui.t('account.delete_confirm'))) return;
    const button = event.target.querySelector('button'); button.disabled = true;
    try {
      await ui.api('/api/account', ui.json('DELETE', {
        username: document.getElementById('delete-username').value,
        currentPassword: document.getElementById('delete-password').value, confirm: true,
      }));
      location.href = '/login.html';
    } catch (error) { ui.notice(ui.error(error.message), true); }
    finally { button.disabled = false; }
  });
})();
