'use strict';
const DEFAULTS = { idle_timeout_seconds: 1800 };
const LIMITS = { idle_timeout_seconds: [5, 86400] };

class ConnectionPolicy {
  constructor(accounts) {
    this.accounts = accounts;
    this.sockets = new Map();
    this.refresh();
  }

  settings() {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => {
      const value = Number(this.accounts.getSetting(key)), [min, max] = LIMITS[key];
      return [key, Number.isInteger(value) && value >= min && value <= max ? value : fallback];
    }));
  }

  validate(input) {
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)) {
        throw Object.assign(new Error('invalid_timeout'), { status: 400 });
      }
    }
  }

  refresh() {
    this.current = this.settings();
    for (const state of this.sockets.values()) {
      state.socket.emit('connection-policy', this.current);
      this.schedule(state);
    }
  }

  schedule(state) {
    clearTimeout(state.timer);
    const remaining = this.current.idle_timeout_seconds * 1000 - (Date.now() - state.lastActivity);
    state.timer = setTimeout(() => {
      state.socket.emit('idle-disconnect');
      state.socket.disconnect(true);
    }, Math.max(1, remaining));
    state.timer.unref();
  }

  attach(socket) {
    const state = { socket, lastActivity: Date.now(), timer: null };
    this.sockets.set(socket.id, state);
    socket.emit('connection-policy', this.current);
    this.schedule(state);
    socket.once('disconnect', () => { clearTimeout(state.timer); this.sockets.delete(socket.id); });
  }

  touch(socket) {
    const state = this.sockets.get(socket.id);
    if (state) { state.lastActivity = Date.now(); this.schedule(state); }
  }
}
module.exports = { ConnectionPolicy, DEFAULTS };
