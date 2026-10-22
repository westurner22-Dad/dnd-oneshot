// store.js — one tiny adapter around a shared "game document".
// API (both backends):
//   get()                -> Promise<doc|null>          doc always has a numeric .v (version)
//   cas(expectedV, doc)  -> Promise<boolean>           writes doc with v = expectedV+1 only if current v === expectedV
//   subscribe(cb)        -> unsubscribe fn             cb(doc) on every change (including from other tabs/devices)
// Compare-and-set on v is what makes turns conflict-safe: two writes based on the same version -> only one wins.

function localStore(gameId) {
  const key = 'game:' + gameId;
  const ch = new BroadcastChannel(key);
  const read = () => JSON.parse(localStorage.getItem(key) || 'null');
  // navigator.locks serialises the read-compare-write across all tabs of this origin.
  const locked = fn => navigator.locks ? navigator.locks.request(key, fn) : Promise.resolve(fn());
  return {
    async get() { return read(); },
    cas(expectedV, doc) {
      return locked(() => {
        const cur = read();
        if ((cur ? cur.v : 0) !== expectedV) return false;
        const next = { ...doc, v: expectedV + 1 };
        localStorage.setItem(key, JSON.stringify(next));
        ch.postMessage(next);
        return true;
      });
    },
    subscribe(cb) {
      const h = e => cb(e.data);
      ch.addEventListener('message', h);
      return () => ch.removeEventListener('message', h);
    }
  };
}

function firebaseStore(gameId, cfg) {
  // Realtime Database REST: ETag + if-match gives server-side compare-and-set; SSE gives live updates.
  const url = `${cfg.databaseURL.replace(/\/$/, '')}/games/${encodeURIComponent(gameId)}.json`;
  return {
    async get() { const r = await fetch(url); return r.ok ? r.json() : null; },
    async cas(expectedV, doc) {
      const r = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
      const cur = await r.json();
      if ((cur ? cur.v : 0) !== expectedV) return false;
      const w = await fetch(url, { method: 'PUT', headers: { 'if-match': r.headers.get('ETag') },
        body: JSON.stringify({ ...doc, v: expectedV + 1 }) });
      return w.ok;                       // 412 Precondition Failed = someone else wrote first
    },
    subscribe(cb) {
      const es = new EventSource(url);
      const h = () => this.get().then(d => d && cb(d)); // simplest: refetch whole doc on any change
      es.addEventListener('put', h); es.addEventListener('patch', h);
      return () => es.close();
    }
  };
}

window.makeStore = (gameId, config) =>
  config.backend === 'firebase' ? firebaseStore(gameId, config.firebase) : localStore(gameId);
