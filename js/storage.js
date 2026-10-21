// Persistence: IndexedDB for the library (including saved video files), localStorage for small prefs.

const DB_NAME = 'anivlc';
const DB_VERSION = 1;
const STORE = 'entries';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const library = {
  all: () => tx('readonly', (s) => s.getAll()),
  put: (record) => tx('readwrite', (s) => s.put(record)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

// ---------- small prefs ----------

const LS = 'anivlc:';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(LS + key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(LS + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export const DEFAULT_SETTINGS = {
  autoNext: true,
  failover: true,
  resume: true,
  preview: true,
  skipLen: 85,
  accent: '#ff5fa2',
  volume: 1,
  muted: false,
  speed: 1,
  subSize: 100,
  subBg: 0.35,
  subPos: 7,
  subColor: '#ffffff',
  subOutline: false,
  subsOn: true,
  theater: false,
  autoSkip: false,
  seekStep: 10,
  subLang: '',
  subSigns: false,
  subFont: 'sans',
  preferServer: true,
};

/** Last server name that worked, per series key. */
export const serverPrefs = {
  _cache: null,
  _all() {
    if (!this._cache) this._cache = readJSON('serverprefs', {});
    return this._cache;
  },
  get(key) { return this._all()[key] || null; },
  set(key, name) {
    const all = this._all();
    if (all[key] === name) return;
    all[key] = name;
    writeJSON('serverprefs', all);
  },
};

export const settings = {
  load: () => readJSON('settings', DEFAULT_SETTINGS),
  save: (s) => writeJSON('settings', s),
};

/** Watch progress keyed by entry id: { t, d, at }. */
export const progress = {
  _cache: null,
  _all() {
    if (!this._cache) this._cache = readJSON('progress', {});
    return this._cache;
  },
  get(id) { return this._all()[id]; },
  set(id, t, d) {
    const all = this._all();
    all[id] = { t: Math.round(t * 10) / 10, d: Math.round(d), at: Date.now() };
    // Keep the 500 most recent.
    const keys = Object.keys(all);
    if (keys.length > 500) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 500).forEach((k) => delete all[k]);
    writeJSON('progress', all);
  },
  clear(id) {
    delete this._all()[id];
    writeJSON('progress', this._all());
  },
};

/** Per-entry subtitle offset (seconds) and chosen track. */
export const subPrefs = {
  _cache: null,
  _all() {
    if (!this._cache) this._cache = readJSON('subprefs', {});
    return this._cache;
  },
  get(id) { return this._all()[id] || { offset: 0, track: null }; },
  set(id, patch) {
    const all = this._all();
    all[id] = { ...this.get(id), ...patch };
    writeJSON('subprefs', all);
  },
};

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
