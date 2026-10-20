'use strict';
window.ClipTalkLifecycle = (() => {
  let socket, lastSent = 0, interval = 10000;
  function activity() {
    if (!socket?.connected || document.hidden || Date.now() - lastSent < interval) return;
    lastSent = Date.now();
    socket.emit('user-activity');
  }
  function paused(value) {
    document.getElementById('idle-notice').hidden = !value;
    for (const id of ['clipboard-area', 'chat-input']) document.getElementById(id).disabled = value;
  }
  function init(connection) {
    socket = connection;
    socket.on('connection-policy', policy => { interval = Math.min(10000, policy.idle_timeout_seconds * 1000 / 3); });
    socket.on('idle-disconnect', () => paused(true));
    socket.on('connect', () => { lastSent = 0; paused(false); });
    for (const event of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) document.addEventListener(event, activity, { passive: true });
    document.getElementById('resume-connection').onclick = async () => {
      try {
        const response = await fetch('/api/me');
        if (!response.ok) { location.href = '/login.html'; return; }
        socket.connect();
      } catch { showNotice(t('errors.network_error')); }
    };
  }
  return { init, activity };
})();
