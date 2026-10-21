// Loads a server into the <video>: direct files natively, HLS via hls.js (or native), DASH via dash.js.

const LOAD_TIMEOUT_MS = 20000;
const libs = {};

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!libs[src]) {
    libs[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(window[globalName]);
      s.onerror = () => { delete libs[src]; reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(s);
    });
  }
  return libs[src];
}

export const isHlsUrl = (url) => /\.m3u8(\?|#|$)/i.test(url);
export const isDashUrl = (url) => /\.mpd(\?|#|$)/i.test(url);

/** Server type from an explicit type or the URL: 'hls' | 'dash' | 'file'. */
export function detectType(url, type) {
  if (type === 'hls' || type === 'dash') return type;
  if (isHlsUrl(url)) return 'hls';
  if (isDashUrl(url)) return 'dash';
  return 'file';
}

export function serverKind(server) {
  if (server.local) return 'FILE';
  const t = detectType(server.url, server.type);
  if (t !== 'file') return t.toUpperCase();
  const ext = (server.url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
  return ext ? ext.toUpperCase() : 'URL';
}

export class SourceEngine extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.hls = null;
    this.dash = null;
    this.token = 0;
    this.levels = [];
  }

  /** True when an adaptive engine (hls.js / dash.js) drives the video element. */
  get adaptive() { return !!(this.hls || this.dash); }

  destroy() {
    this.token++;
    if (this._rejectReady) {
      const reject = this._rejectReady;
      this._rejectReady = null;
      reject(Object.assign(new Error('Load replaced'), { aborted: true }));
    }
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.dash) { try { this.dash.reset(); } catch { /* already torn down */ } this.dash = null; }
    this.levels = [];
    this.video.removeAttribute('src');
    this.video.load();
  }

  /**
   * Load url and resolve once metadata is ready (or reject on a fatal error / timeout).
   * Errors after start are reported once via a 'fatal' event so the app can fail over.
   */
  async load(url, { type, startAt = 0 } = {}) {
    try {
      return await this._load(url, { type, startAt });
    } catch (err) {
      // hls.js needs CORS; the browser's own HLS player doesn't. Retry natively when possible.
      if (err.aborted || !err.hlsNetwork || !this.video.canPlayType('application/vnd.apple.mpegurl')) throw err;
      return this._load(url, { type, startAt, forceNative: true });
    }
  }

  async _load(url, { type, startAt, forceNative = false }) {
    this.destroy();
    const token = this.token;
    const video = this.video;
    const kind = detectType(url, type);

    let Hls = null;
    let dashjs = null;
    if (kind === 'hls' && !forceNative) {
      try { Hls = await loadScript('vendor/hls.min.js', 'Hls'); } catch { /* fall back to native */ }
      if (token !== this.token) throw aborted();
      if (!Hls?.isSupported()) {
        Hls = null;
        if (!video.canPlayType('application/vnd.apple.mpegurl')) throw new Error('HLS streams are not supported in this browser');
      }
    } else if (kind === 'dash') {
      dashjs = await loadScript('vendor/dash.all.min.js', 'dashjs');
      if (token !== this.token) throw aborted();
      if (!dashjs.supportsMediaSource()) throw new Error('DASH streams are not supported in this browser');
    }

    let fatalSent = false;
    const fatal = (err) => {
      if (token !== this.token) return;
      if (this._rejectReady) { this._rejectReady(err); return; } // still starting: load() rejects
      if (fatalSent) return;
      fatalSent = true;
      this.dispatchEvent(new CustomEvent('fatal', { detail: err }));
    };

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('The server did not respond in time')); }, LOAD_TIMEOUT_MS);
      const onMeta = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(mediaError(video.error)); };
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onErr);
      };
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('error', onErr);
      this._rejectReady = (e) => { cleanup(); reject(e); };
    });

    if (Hls) {
      const hls = new Hls({ startPosition: startAt > 0 ? startAt : -1, maxBufferLength: 45, enableWorker: true });
      this.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        this.levels = data.levels.map((l, i) => ({ index: i, height: l.height, bitrate: l.bitrate }));
        this.dispatchEvent(new Event('levels'));
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.dispatchEvent(new Event('levels')));
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) {
          hls.recoverMediaError();
          return;
        }
        const network = data.type === Hls.ErrorTypes.NETWORK_ERROR;
        const err = new Error(network ? 'Network error while loading the stream' : `Stream error (${data.details})`);
        err.hlsNetwork = network;
        fatal(err);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (dashjs) {
      const dash = dashjs.MediaPlayer().create();
      this.dash = dash;
      dash.updateSettings({ debug: { logLevel: dashjs.Debug.LOG_LEVEL_NONE } });
      dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        this.levels = (dash.getBitrateInfoListFor('video') || []).map((b) => ({ index: b.qualityIndex, height: b.height, bitrate: b.bitrate }));
        this.dispatchEvent(new Event('levels'));
      });
      dash.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, () => this.dispatchEvent(new Event('levels')));
      dash.on(dashjs.MediaPlayer.events.ERROR, (e) => {
        fatal(new Error(`Stream error (${e?.error?.message || e?.error?.code || 'DASH'})`));
      });
      dash.initialize(video, url, false, startAt > 0 ? startAt : NaN);
    } else {
      video.src = url;
    }

    try {
      await ready;
    } finally {
      if (token === this.token) this._rejectReady = null;
    }
    if (token !== this.token) throw aborted();
    if (startAt > 0 && !this.adaptive) {
      try { video.currentTime = Math.min(startAt, Math.max(0, (video.duration || startAt) - 2)); } catch { /* ignore */ }
    }

    // Later media errors (e.g. a CDN dropping mid-episode) go out as a single 'fatal' event.
    video.addEventListener('error', () => fatal(mediaError(video.error)), { once: true });
  }

  /** Level index currently playing (not necessarily the one requested). */
  get playingLevel() {
    if (this.hls) return this.hls.currentLevel;
    if (this.dash) return this.dash.getQualityFor('video');
    return -1;
  }

  get autoLevel() {
    if (this.hls) return this.hls.autoLevelEnabled;
    if (this.dash) return this.dash.getSettings().streaming.abr.autoSwitchBitrate.video !== false;
    return true;
  }

  setLevel(i) {
    if (this.hls) this.hls.currentLevel = i;
    if (this.dash) {
      const auto = i < 0;
      this.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: auto } } } });
      if (!auto) this.dash.setQualityFor('video', i, true);
    }
  }
}

const aborted = () => Object.assign(new Error('Load replaced'), { aborted: true });

function mediaError(err) {
  const map = {
    1: 'Playback was aborted',
    2: 'Network error, so the server may be down or blocking this site',
    3: 'The video could not be decoded',
    4: 'This format or server is not supported',
  };
  const e = new Error(err ? map[err.code] || 'Unknown playback error' : 'Unknown playback error');
  e.code = err?.code;
  return e;
}
