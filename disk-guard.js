'use strict';
// Keeps the server disk from filling up: every write that adds data is refused
// with 507 disk_full when free space would drop below the reserve
// (admin setting disk_reserve_mb, default 1024 MB).
const fs = require('fs');

class DiskGuard {
  constructor(dataDir, settings) {
    this.dataDir = dataDir; this.settings = settings; this.cache = null;
  }
  reserveBytes() {
    const raw = this.settings('disk_reserve_mb'), value = Number(raw);
    return (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0 ? value : 1024) * 1024 * 1024;
  }
  status() {
    // statfs is cheap, but uploads check per chunk; cache for one second.
    if (this.cache && Date.now() - this.cache.time < 1000) return this.cache.value;
    let value;
    try {
      const stat = fs.statfsSync(this.dataDir);
      const total = stat.blocks * stat.bsize, free = stat.bavail * stat.bsize;
      value = { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - stat.bfree * stat.bsize), reserveBytes: this.reserveBytes() };
    } catch { value = { totalBytes: 0, freeBytes: Infinity, usedBytes: 0, reserveBytes: this.reserveBytes(), unavailable: true }; }
    this.cache = { time: Date.now(), value };
    return value;
  }
  check(additional = 0) {
    const { freeBytes, reserveBytes } = this.status();
    if (freeBytes - Math.max(0, additional) < reserveBytes) throw Object.assign(new Error('disk_full'), { status: 507 });
  }
  forget() { this.cache = null; }
}

module.exports = { DiskGuard };
