'use strict';
(async () => {
  const ui = ClipTalkUI;
  let user;
  try { user = await ui.init('account.title'); }
  catch (error) { ui.notice(ui.error(error.message), true); return; }
  const username = document.getElementById('account-username');
  username.value = user.username;
  document.getElementById('last-admin-hint').hidden = user.role !== 'admin';
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
