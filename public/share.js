'use strict';
(async () => {
  const ui = ClipTalkUI, token = location.pathname.split('/').pop();
  const loginLink = '/login.html?next=' + encodeURIComponent(location.pathname);
  const user = await ui.init('sharing.shared_file', false);
  try {
    const share = await ui.api('/api/shares/' + encodeURIComponent(token));
    document.getElementById('share-content').hidden = false;
    document.getElementById('share-name').textContent = share.originalName;
    document.getElementById('share-meta').textContent = share.owner + ' · ' + ui.size(share.size);
    document.getElementById('share-access').textContent = ui.t('sharing.' + share.visibility);
    document.getElementById('share-download').href = '/api/shares/' + token + '/download';
    const receive = document.getElementById('share-import'); receive.hidden = !user || share.isOwner;
    receive.onclick = async () => {
      receive.disabled = true;
      try { await ui.api('/api/shares/' + token + '/import', ui.json('POST', {})); ui.notice(ui.t('sharing.imported')); }
      catch (error) { ui.notice(ui.error(error.message), true); }
      finally { receive.disabled = false; }
    };
    const login = document.getElementById('share-login'); login.href = loginLink; login.hidden = !!user;
  } catch (error) {
    ui.notice(ui.error(error.message), true);
    if (error.status === 401) { const login = document.getElementById('private-share-login'); login.hidden = false; login.href = loginLink; }
  }
})();
