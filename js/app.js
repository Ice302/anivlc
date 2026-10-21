import { parseSubtitles, decodeText, labelFromName, SUB_EXT, SubtitleRenderer } from './subtitles.js';
import { library, settings as settingsStore, progress, subPrefs, serverPrefs, storageEstimate, requestPersistence } from './storage.js';
import { SourceEngine, serverKind, detectType } from './source.js';
import { animeLinks, seriesKey, seriesName, searchAnime, fetchSkipTimes } from './anime.js';
import { parsePlaylist, exportLibrary, downloadJson, fillPattern, hasEpToken, PLAYLIST_EXT } from './playlist.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const video = $('#video');
const player = $('#player');
const layout = $('#layout');
const engine = new SourceEngine(video);
const subs = new SubtitleRenderer($('#subs'));
const S = settingsStore.load();
const saveSettings = () => settingsStore.save(S);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|mov|ts|avi|ogv)$/i;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const state = {
  entries: [],
  current: null,
  serverIdx: 0,
  serverStatus: {},
  trackId: null,
  objectUrl: null,
  loadToken: 0,
  lastTime: 0,
  pendingSubs: [],
  skippedIntro: false,
  previewOn: false,
  skips: [],            // AniSkip segments for the current episode: { type, start, end }
  skipDone: new Set(),  // segments already auto-skipped this play
  skipToken: 0,
};

// ============================================================ helpers

const uid = () => Math.random().toString(36).slice(2, 10);

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const fmtOffset = (o) => `${o > 0 ? '+' : o < 0 ? '−' : ''}${Math.abs(o).toFixed(3)}s`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg, kind = '', action) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); dismiss(); };
    el.appendChild(b);
  }
  const stack = $('#toasts');
  stack.appendChild(el);
  // Keep at most 3 visible so a burst of messages can't pile up over the controls.
  [...stack.children].slice(0, -3).forEach((old) => old.remove());
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  setTimeout(dismiss, action ? 6000 : 3200);
}

let osdTimer;
function osd(text) {
  const el = $('#osd');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('show'), 1100);
}

/** Pull a clean title and episode number from a release-style file name. */
function parseName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  let clean = base
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*?)(?:\d{3,4}p|bit|x26[45]|hevc|avc|aac|flac|bd|web|dual)[^)]*\)/gi, ' ');
  if (!/\s/.test(clean.trim())) clean = clean.replace(/[._]/g, ' ');
  clean = clean.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const m =
    clean.match(/\bS\d{1,2}\s?E(\d{1,4})\b/i) ||
    clean.match(/(?:\bEp(?:isode)?\.?\s*|\bE|\s-\s|#)(\d{1,4})(?:v\d)?\b/i) ||
    clean.match(/(?:^|\s)(\d{1,3})(?:v\d)?$/);
  return { title: clean || base, ep: m ? Number(m[1]) : null };
}

const isVideoFile = (f) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name);
const isSubFile = (f) => SUB_EXT.test(f.name);
const isPlaylistFile = (f) => PLAYLIST_EXT.test(f.name);
const isWebUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, '')}")`;

// ============================================================ library / entries

function makeLocalEntry(file) {
  const { title, ep } = parseName(file.name);
  return {
    id: `f:${file.name}:${file.size}`,
    title,
    ep,
    fileName: file.name,
    file,
    saved: false,
    servers: [{ id: 'local', name: 'Local file', local: true }],
    subs: [],
    order: Date.now(),
  };
}

function makeStreamEntry({ title, servers, subUrl, ep }) {
  return {
    id: `r:${uid()}`,
    title,
    ep: ep ?? parseName(title + '.x').ep,
    file: null,
    saved: false,
    servers: servers.map((s, i) => ({ id: s.id || uid(), name: s.name || `Server ${i + 1}`, url: s.url, type: detectType(s.url, s.type) })),
    subs: [],
    subUrl: subUrl || '',
    order: Date.now(),
  };
}

/** Add stream specs, skipping any whose first server URL is already queued. Returns { added, skipped }. */
function addStreamSpecs(specs) {
  const known = new Set(state.entries.filter((e) => !e.file).map((e) => e.servers[0]?.url));
  const base = Date.now();
  const fresh = specs.filter((s) => !known.has(s.servers[0].url));
  const added = addEntries(fresh.map((s, i) => Object.assign(makeStreamEntry(s), { order: base + i })));
  return { added, skipped: specs.length - fresh.length };
}

const isPersistable = (e) => !e.file || e.saved;

async function persist(entry) {
  if (!isPersistable(entry)) return;
  try {
    await library.put({
      id: entry.id,
      title: entry.title,
      ep: entry.ep,
      fileName: entry.fileName,
      file: entry.saved ? entry.file : null,
      saved: entry.saved,
      servers: entry.servers,
      subs: entry.subs.map(({ id, label, name, raw }) => ({ id, label, name, raw })),
      subUrl: entry.subUrl || '',
      order: entry.order,
    });
  } catch (err) {
    console.error(err);
    toast(err?.name === 'QuotaExceededError' ? 'Not enough storage to save this offline' : 'Could not save to the library', 'err');
    if (entry.saved && entry.file) { entry.saved = false; renderEpisodes(); }
  }
}

async function restoreLibrary() {
  let records = [];
  try { records = await library.all(); } catch (err) { console.warn('Library unavailable', err); }
  for (const r of records.sort((a, b) => a.order - b.order)) {
    if (r.saved && !r.file) continue;
    const entry = { ...r, subs: [] };
    for (const s of r.subs || []) {
      try { entry.subs.push({ ...s, cues: parseSubtitles(s.raw, s.name).cues }); } catch { /* skip broken */ }
    }
    state.entries.push(entry);
  }
}

function addEntries(list) {
  const added = [];
  for (const e of list) {
    const existing = state.entries.find((x) => x.id === e.id);
    if (existing) {
      if (e.file && !existing.file) existing.file = e.file;
      added.push(existing);
    } else {
      state.entries.push(e);
      added.push(e);
      persist(e);
    }
  }
  renderEpisodes();
  return added;
}

async function removeEntry(entry) {
  state.entries = state.entries.filter((e) => e !== entry);
  library.remove(entry.id).catch(() => {});
  if (state.current === entry) stopPlayback();
  renderEpisodes();
}

// ============================================================ uploads

async function readSubFile(file) {
  const raw = decodeText(await file.arrayBuffer());
  const { cues, format } = parseSubtitles(raw, file.name);
  if (!cues.length) throw new Error(`No subtitle lines found in ${file.name}`);
  return { id: uid(), name: file.name, label: labelFromName(file.name), raw, cues, format };
}

function attachSub(entry, sub, { select = true } = {}) {
  const dup = entry.subs.find((s) => s.name === sub.name && s.raw.length === sub.raw.length);
  if (dup) sub = dup;
  else entry.subs.push(sub);
  persist(entry);
  if (entry === state.current) {
    if (select) selectTrack(sub.id);
    else if (state.trackId == null) selectTrack(defaultTrack(entry)?.id ?? sub.id, { remember: false });
    else renderSubPanel();
  }
  return sub;
}

/** Track to use when the viewer hasn't picked one: preferred language, then full dialogue vs. signs-only. */
function defaultTrack(entry) {
  let list = entry.subs;
  if (!list.length) return null;
  if (S.subLang) {
    const lang = list.filter((s) => s.label.includes(S.subLang));
    if (lang.length) list = lang;
  }
  const isSigns = (s) => /\b(signs?|songs?|forced)\b/i.test(`${s.label} ${s.name}`);
  const signs = list.filter(isSigns);
  const full = list.filter((s) => !isSigns(s));
  return (S.subSigns ? signs[0] || full[0] : full[0] || signs[0]) || null;
}

function matchSubToEntry(subName, candidates) {
  const sb = subName.replace(SUB_EXT, '').toLowerCase();
  const byName = candidates.find((e) => {
    if (!e.fileName) return false;
    const vb = e.fileName.replace(/\.[^.]+$/, '').toLowerCase();
    return sb === vb || sb.startsWith(vb + '.') || sb.startsWith(vb + '_') || sb.startsWith(vb + ' ');
  });
  if (byName) return byName;
  const { ep } = parseName(subName.replace(SUB_EXT, '') + '.x');
  if (ep != null) {
    const sameEp = candidates.filter((e) => e.ep === ep);
    if (sameEp.length === 1) return sameEp[0];
  }
  return null;
}

async function handleFiles(fileList) {
  const files = [...fileList];
  const vids = files.filter(isVideoFile).sort((a, b) => collator.compare(a.name, b.name));
  const subFiles = files.filter(isSubFile);
  const lists = files.filter((f) => !isVideoFile(f) && isPlaylistFile(f));
  const ignored = files.length - vids.length - subFiles.length - lists.length;
  if (ignored) toast(`Skipped ${ignored} unsupported file${ignored > 1 ? 's' : ''}`, 'warn');
  for (const f of lists) await importPlaylistFile(f);

  const base = Date.now();
  const newEntries = addEntries(vids.map((f, i) => Object.assign(makeLocalEntry(f), { order: base + i })));

  let attached = 0;
  let touchedCurrent = false;
  for (const f of subFiles) {
    try {
      const sub = await readSubFile(f);
      const target =
        matchSubToEntry(f.name, newEntries) ||
        matchSubToEntry(f.name, state.entries) ||
        (newEntries.length === 1 ? newEntries[0] : null) ||
        state.current;
      if (target) {
        attachSub(target, sub, { select: false });
        attached++;
        if (target === state.current) touchedCurrent = true;
      } else {
        state.pendingSubs.push(sub);
        toast(`Subtitle "${sub.label}" will be used for the next video you open`);
      }
    } catch (err) {
      toast(err.message || `Couldn't read ${f.name}`, 'err');
    }
  }
  // Several tracks dropped at once: pick by preference unless the viewer already chose one.
  if (touchedCurrent) {
    const cur = state.current;
    if (!subPrefs.get(cur.id).track) {
      const d = defaultTrack(cur);
      if (d) selectTrack(d.id, { remember: false });
    } else if (subFiles.length === 1) {
      selectTrack(cur.subs[cur.subs.length - 1].id);
    }
  }

  if (newEntries.length) {
    toast(`Added ${newEntries.length} episode${newEntries.length > 1 ? 's' : ''}${attached ? ` + ${attached} subtitle${attached > 1 ? 's' : ''}` : ''}`, 'ok');
    if (!state.current || video.ended) playEntry(newEntries[0]);
  } else if (attached) {
    toast(`Loaded ${attached} subtitle${attached > 1 ? 's' : ''}`, 'ok');
  }
}

// ============================================================ playback

function objectUrlFor(entry) {
  if (state.objectUrl?.entry === entry) return state.objectUrl.url;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl.url);
  const url = URL.createObjectURL(entry.file);
  state.objectUrl = { entry, url };
  return url;
}

function releaseObjectUrl() {
  if (!state.objectUrl) return;
  URL.revokeObjectURL(state.objectUrl.url);
  state.objectUrl = null;
}

function stopPlayback() {
  saveProgress();
  engine.destroy();
  teardownPreview();
  releaseObjectUrl();
  state.current = null;
  state.skips = [];
  renderSkipMarks();
  $('#skipOp').hidden = true;
  subs.setCues([]);
  subs.clear();
  player.dataset.state = 'empty';
  $('#info').hidden = true;
  $('#nowTitle').textContent = '';
  document.title = 'AniVLC';
  hideUpNext();
  renderEpisodes();
}

function preferredServerIdx(entry) {
  if (!S.preferServer || entry.servers.length < 2) return 0;
  const name = serverPrefs.get(seriesKey(entry.title));
  const i = entry.servers.findIndex((s) => s.name === name);
  return i === -1 ? 0 : i;
}

async function playEntry(entry, { serverIdx = null, startAt = null } = {}) {
  hideUpNext();
  if (serverIdx == null) serverIdx = preferredServerIdx(entry);
  if (state.current !== entry) {
    saveProgress();
    state.current = entry;
    state.serverStatus = {};
    state.skippedIntro = false;
    state.skips = [];
    state.skipDone = new Set();
    state.skipToken++;
    renderSkipMarks();
    if (state.pendingSubs.length) {
      state.pendingSubs.splice(0).forEach((s) => attachSub(entry, s, { select: false }));
    }
    loadEntrySubs(entry);
    if (entry.subUrl && !entry.subs.length && navigator.onLine) fetchRemoteSub(entry, entry.subUrl, { quiet: true });
  }
  if (startAt == null) {
    const p = progress.get(entry.id);
    startAt = S.resume && p && p.t > 10 && p.t < p.d - 30 ? p.t : 0;
    if (startAt) toast(`Resuming from ${fmt(startAt)}`, '', { label: 'Start over', run: () => { video.currentTime = 0; } });
  }
  player.dataset.state = 'ready';
  renderNowPlaying();
  renderEpisodes();
  updateMediaSession();
  await loadServer(serverIdx, startAt, true);
}

async function loadServer(idx, startAt = 0, autoplay = true) {
  const entry = state.current;
  if (!entry) return;
  const server = entry.servers[idx];
  if (!server) return;
  state.serverIdx = idx;
  state.serverStatus[server.id] = 'trying';
  $('#errorCard').hidden = true;
  renderServers();
  setLoading(true);
  const token = ++state.loadToken;

  if (server.local && !entry.file) {
    setLoading(false);
    state.serverStatus[server.id] = 'bad';
    renderServers();
    return showError('The local file for this episode is no longer available. Upload it again.');
  }
  if (!server.local && !navigator.onLine) {
    toast('You are offline, so streams may not load', 'warn');
  }
  const url = server.local ? objectUrlFor(entry) : server.url;
  try {
    await engine.load(url, { type: server.type, startAt });
    if (token !== state.loadToken) return;
    state.serverStatus[server.id] = 'ok';
    if (!server.local && entry.servers.length > 1) serverPrefs.set(seriesKey(entry.title), server.name);
    video.defaultPlaybackRate = video.playbackRate = S.speed;
    renderServers();
    setupPreview(server, url);
    if (autoplay) {
      try { await video.play(); } catch { /* autoplay blocked: user presses play */ }
    }
  } catch (err) {
    if (err?.aborted || token !== state.loadToken) return;
    onServerFailed(err, startAt);
  } finally {
    if (token === state.loadToken) setLoading(false);
  }
}

function onServerFailed(err, at) {
  const entry = state.current;
  if (!entry) return;
  const failed = entry.servers[state.serverIdx];
  state.serverStatus[failed.id] = 'bad';
  renderServers();
  const order = entry.servers.map((_, i) => (state.serverIdx + 1 + i) % entry.servers.length);
  const next = order.find((i) => state.serverStatus[entry.servers[i].id] !== 'bad');
  if (S.failover && next != null && next !== state.serverIdx) {
    toast(`${failed.name} failed, switching to ${entry.servers[next].name}`, 'warn');
    loadServer(next, at ?? state.lastTime, true);
  } else {
    setLoading(false);
    const undecodable = failed.local && (err?.code === 3 || err?.code === 4);
    showError(undecodable
      ? "Your browser can't decode this file. HEVC/x265 video, AC3/DTS audio and some MKVs aren't supported in every browser. Try Edge, Chrome or Safari, or a stream server."
      : err?.message || 'Playback failed');
  }
}

engine.addEventListener('fatal', (e) => onServerFailed(e.detail, state.lastTime));
engine.addEventListener('levels', () => { if (!$('#gearMenu').hidden) renderGear(gearPage); });

function switchServer(idx) {
  const entry = state.current;
  if (!entry || idx === state.serverIdx && state.serverStatus[entry.servers[idx].id] === 'ok') return;
  const t = video.currentTime || state.lastTime;
  osd(`Server · ${entry.servers[idx].name}`);
  loadServer(idx, t, true);
}

function showError(msg) {
  $('#errorText').textContent = msg;
  $('#errorCard').hidden = false;
}

function setLoading(on) { player.classList.toggle('loading', on); }

function togglePlay() {
  if (!state.current) return;
  if (video.paused || video.ended) video.play().catch(() => {});
  else video.pause();
}

function seekBy(d) {
  if (!state.current || !isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.1, video.currentTime + d));
  osd(`${d > 0 ? '+' : '−'}${Math.abs(d)}s · ${fmt(video.currentTime)}`);
}

// ---- intro / outro / recap skipping (AniSkip segments, with a fixed-length fallback)

const SKIP_NAMES = { op: 'intro', ed: 'outro', recap: 'recap' };

function activeSkip(t) {
  return state.skips.find((s) => t >= s.start - 0.3 && t < s.end - 1) || null;
}

/** An outro that runs to the end of the episode becomes "Next episode" when there is one. */
const outroEndsEpisode = (seg) => seg.type === 'ed' && seg.end >= video.duration - 20 && !!neighbor(1);

function skipLabel(seg) {
  if (outroEndsEpisode(seg)) return 'Next episode';
  return `Skip ${SKIP_NAMES[seg.type] || seg.type}`;
}

function doSkip(seg, { auto = false } = {}) {
  if (!auto && outroEndsEpisode(seg)) { playNeighbor(1); return; }
  video.currentTime = Math.min(seg.end, video.duration - 0.25);
  $('#skipOp').hidden = true;
  osd(`${auto ? 'Auto-skipped' : 'Skipped'} ${SKIP_NAMES[seg.type] || seg.type}`);
}

function skipIntro() {
  if (!state.current) return;
  const seg = activeSkip(video.currentTime);
  if (seg) return doSkip(seg);
  if (state.skips.length) return osd('Nothing to skip here');
  state.skippedIntro = true;
  $('#skipOp').hidden = true;
  seekBy(S.skipLen);
}

function updateSkipButton(t, d) {
  const btn = $('#skipOp');
  const seg = activeSkip(t);
  if (seg) {
    const key = `${seg.type}:${seg.start}`;
    if (S.autoSkip && !video.paused && !state.skipDone.has(key)) {
      state.skipDone.add(key);
      doSkip(seg, { auto: true });
      return;
    }
    $('#skipOpLabel').textContent = skipLabel(seg);
    btn.hidden = false;
    return;
  }
  $('#skipOpLabel').textContent = 'Skip intro';
  btn.hidden = !(!state.skips.length && !state.skippedIntro && d > 600 && t > 3 && t < 240 && !video.paused);
}

function renderSkipMarks() {
  const d = video.duration;
  $('#progSegs').innerHTML = state.current && isFinite(d) && d > 0
    ? state.skips.map((s) => `<i class="${s.type}" style="left:${(s.start / d) * 100}%;width:${(Math.max(0, s.end - s.start) / d) * 100}%" title="${SKIP_NAMES[s.type] || s.type}"></i>`).join('')
    : '';
}

async function loadSkipTimes() {
  const entry = state.current;
  const token = ++state.skipToken;
  const anime = entry && animeLinks.get(entry.title);
  if (!anime?.idMal || entry.ep == null || !isFinite(video.duration)) {
    state.skips = [];
    renderSkipMarks();
    return;
  }
  try {
    const segs = await fetchSkipTimes(anime.idMal, entry.ep, video.duration);
    if (token !== state.skipToken || entry !== state.current) return;
    state.skips = segs.filter((s) => s.end > s.start && s.start < video.duration);
    renderSkipMarks();
    renderNowPlaying();
  } catch (err) {
    console.warn('Skip times unavailable', err);
  }
}

function neighbor(dir) {
  if (!state.current) return null;
  const list = state.entries;
  const i = list.indexOf(state.current);
  return list[i + dir] || null;
}

function playNeighbor(dir) {
  const e = neighbor(dir);
  if (e) playEntry(e);
  else osd(dir > 0 ? 'Last episode in queue' : 'First episode in queue');
}

function saveProgress() {
  const e = state.current;
  if (!e || !isFinite(video.duration) || video.duration < 1) return;
  const t = video.ended ? video.duration : video.currentTime;
  if (t > 0) progress.set(e.id, t, video.duration);
}

function setSpeed(r) {
  S.speed = r;
  video.playbackRate = video.defaultPlaybackRate = r;
  saveSettings();
  const b = $('#speedBadge');
  b.hidden = r === 1;
  b.textContent = `${r}×`;
  osd(`Speed ${r}×`);
}

function setVolume(v, { silent } = {}) {
  v = Math.max(0, Math.min(1, v));
  video.volume = v;
  video.muted = v === 0;
  S.volume = v;
  S.muted = video.muted;
  saveSettings();
  if (!silent) osd(`Volume ${Math.round(v * 100)}%`);
}

function toggleMute() {
  video.muted = !video.muted;
  if (!video.muted && video.volume === 0) video.volume = 0.5;
  S.muted = video.muted;
  saveSettings();
  osd(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (player.requestFullscreen) {
      await player.requestFullscreen({ navigationUI: 'hide' });
      screen.orientation?.lock?.('landscape').catch(() => {});
    } else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  } catch { /* denied */ }
}

async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (state.current) await video.requestPictureInPicture();
  } catch { toast('Picture-in-picture is not available here', 'warn'); }
}

function setTheater(on) {
  S.theater = on;
  saveSettings();
  layout.classList.toggle('theater', on);
  $('#theaterBtn').classList.toggle('on', on);
}

function screenshot() {
  if (!state.current || !video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  try {
    c.toBlob((blob) => {
      if (!blob) return toast('Screenshot failed', 'err');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const t = fmt(video.currentTime).replace(/:/g, '-');
      a.download = `${state.current.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60)} ${t}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      osd('Screenshot saved');
    }, 'image/png');
  } catch {
    toast("This server doesn't allow screenshots", 'warn');
  }
}

// ============================================================ subtitles

function loadEntrySubs(entry) {
  const pref = subPrefs.get(entry.id);
  subs.offset = pref.offset || 0;
  const track = entry.subs.find((s) => s.id === pref.track) || (pref.track === 'off' ? null : defaultTrack(entry));
  state.trackId = track ? track.id : pref.track === 'off' ? 'off' : null;
  subs.enabled = S.subsOn;
  subs.setCues(track ? track.cues : []);
  subs.clear();
  renderSubPanel();
}

function currentTrack() {
  return state.current?.subs.find((s) => s.id === state.trackId) || null;
}

function selectTrack(id, { remember = true } = {}) {
  if (!state.current) return;
  state.trackId = id;
  const track = currentTrack();
  subs.setCues(track ? track.cues : []);
  if (track && !S.subsOn && remember) { S.subsOn = true; subs.enabled = true; saveSettings(); }
  if (remember) subPrefs.set(state.current.id, { track: id });
  subs.render(video.currentTime);
  renderSubPanel();
  updateCcButton();
}

function toggleSubs() {
  if (!state.current) return;
  if (!currentTrack()) {
    const first = state.current.subs[0];
    if (first) { selectTrack(first.id); osd(`Subtitles · ${first.label}`); }
    else osd('No subtitles loaded. Press "Load file" in the Subtitles tab');
    return;
  }
  S.subsOn = !S.subsOn;
  subs.enabled = S.subsOn;
  saveSettings();
  subs.render(video.currentTime);
  updateCcButton();
  osd(S.subsOn ? `Subtitles · ${currentTrack().label}` : 'Subtitles off');
}

function cycleTracks() {
  const list = state.current?.subs || [];
  if (!list.length) return osd('No subtitles loaded');
  const ids = [...list.map((s) => s.id), 'off'];
  const next = ids[(ids.indexOf(state.trackId) + 1) % ids.length];
  selectTrack(next);
  osd(next === 'off' ? 'Subtitles off' : `Subtitles · ${currentTrack().label}`);
}

function setOffset(o, { label } = {}) {
  o = Math.round(o * 1000) / 1000;
  subs.offset = o;
  if (state.current) subPrefs.set(state.current.id, { offset: o });
  subs.lastKey = null;
  subs.render(video.currentTime);
  renderOffset();
  osd(label || `Subtitle delay ${fmtOffset(o)}`);
}

const shiftOffset = (d) => setOffset(subs.offset + d);

async function fetchRemoteSub(entry, url, { quiet } = {}) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = decodeText(await res.arrayBuffer());
    const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'subtitle.srt');
    const { cues } = parseSubtitles(raw, name);
    if (!cues.length) throw new Error('No subtitle lines found');
    attachSub(entry, { id: uid(), name, label: labelFromName(name), raw, cues }, { select: entry === state.current });
    if (!quiet) toast('Subtitles loaded', 'ok');
  } catch (err) {
    toast(`Couldn't load the subtitle URL (${err.message}). The host may block cross-origin requests; download the file and upload it instead.`, 'err');
  }
}

// ============================================================ rendering

function renderNowPlaying() {
  const e = state.current;
  if (!e) return;
  const kind = e.file ? (e.saved ? 'Saved offline' : 'Local file') : 'Stream';
  $('#info').hidden = false;
  $('#infoKicker').textContent = [e.ep != null ? `Episode ${String(e.ep).padStart(2, '0')}` : null, kind].filter(Boolean).join(' · ');
  $('#infoTitle').textContent = e.title;
  $('#nowTitle').textContent = e.title;
  document.title = `${e.title} · AniVLC`;

  const anime = animeLinks.get(e.title);
  $('#infoCover').hidden = !anime?.cover;
  if (anime?.cover) $('#infoCoverImg').src = anime.cover;
  $('#linkAnimeBtn').hidden = !!anime;
  const bits = [];
  if (anime) {
    bits.push(`<a href="${escapeHtml(anime.url || `https://anilist.co/anime/${anime.id}`)}" target="_blank" rel="noopener">${escapeHtml(anime.title)} ↗</a>`);
    const fmtYear = [anime.format?.replace('_', ' '), anime.year].filter(Boolean).join(' · ');
    if (fmtYear) bits.push(`<span class="pill">${escapeHtml(fmtYear)}</span>`);
    if (anime.episodes) bits.push(`<span class="pill">${anime.episodes} eps</span>`);
    if (state.skips.length) bits.push(`<span class="pill skip" title="Intro/outro times from AniSkip">${state.skips.map((s) => SKIP_NAMES[s.type] || s.type).join(' · ')} marked</span>`);
  }
  $('#infoSub').innerHTML = bits.join('');
  $('#prevBtn').disabled = !neighbor(-1);
  $('#nextBtn').disabled = !neighbor(1);
  renderServers();
  updateCcButton();
}

function renderServers() {
  const e = state.current;
  const wrap = $('#serverChips');
  if (!e) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = e.servers.map((s, i) => {
    const st = state.serverStatus[s.id] || '';
    const dot = st === 'ok' ? 'ok' : st === 'bad' ? 'bad' : st === 'trying' ? 'trying' : '';
    return `<button class="chip ${i === state.serverIdx ? 'active' : ''}" data-server="${i}" title="${escapeHtml(s.local ? e.fileName || 'Local file' : s.url)}">
      <span class="dot ${dot}"></span>${escapeHtml(s.name)}<span class="tag">${serverKind(s)}</span></button>`;
  }).join('');
}

function renderEpisodes() {
  const list = $('#episodes');
  const q = $('#epSearch').value.trim().toLowerCase();
  const items = state.entries.filter((e) => !q || e.title.toLowerCase().includes(q));
  $('#epCount').textContent = state.entries.length;
  $('#epEmpty').hidden = state.entries.length > 0;
  list.innerHTML = items.map((e) => {
    const i = state.entries.indexOf(e);
    const p = progress.get(e.id);
    const pct = p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0;
    const watched = pct > 92;
    const isCur = e === state.current;
    const num = e.ep != null ? String(e.ep).padStart(2, '0') : String(i + 1).padStart(2, '0');
    const playing = isCur && !video.paused;
    const kind = e.file ? (e.saved ? '<span class="pill saved">OFFLINE</span>' : '<span class="pill">LOCAL</span>') : '<span class="pill">STREAM</span>';
    const meta = watched ? '<span class="pill watched">WATCHED</span>' : p && p.d ? `${fmt(p.t)} / ${fmt(p.d)}` : e.servers.length > 1 ? `${e.servers.length} servers` : '';
    const cover = animeLinks.get(e.title)?.thumb;
    return `<li class="ep ${isCur ? 'current' : ''}" data-id="${escapeHtml(e.id)}">
      <div class="ep-num ${cover ? 'has-cover' : ''}" ${cover ? `style="--cover:${escapeHtml(cssUrl(cover))}"` : ''}>${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : `<small>EP</small>${num}`}</div>
      <div class="ep-body">
        <div class="ep-title" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>
        <div class="ep-meta">${kind}${e.subs.length ? `<span class="pill">CC ${e.subs.length}</span>` : ''}<span>${meta}</span></div>
        ${pct > 0 ? `<div class="ep-bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
      </div>
      <button class="cbtn ep-more" data-more aria-label="More actions" aria-expanded="false"><svg><use href="#i-dots"/></svg></button>
    </li>`;
  }).join('');
  if (state.current) {
    $('#prevBtn').disabled = !neighbor(-1);
    $('#nextBtn').disabled = !neighbor(1);
  }
}

function renderSubPanel() {
  const e = state.current;
  const tracks = $('#subTracks');
  if (!e) {
    tracks.innerHTML = '<span class="hint">Play something first.</span>';
  } else {
    tracks.innerHTML = [
      `<button data-track="off" class="${!currentTrack() ? 'sel' : ''}">Off</button>`,
      ...e.subs.map((s) => `<button data-track="${s.id}" class="${s.id === state.trackId ? 'sel' : ''}" title="${escapeHtml(s.name)}">${escapeHtml(s.label)}</button>`),
    ].join('') + (e.subs.length ? '' : '<span class="hint" style="align-self:center">No tracks yet. Load a file or drop one on the player.</span>');
  }
  renderOffset();
  renderCues();
}

function renderOffset() {
  const r = $('#offsetReadout');
  r.textContent = fmtOffset(subs.offset);
  r.classList.toggle('zero', subs.offset === 0);
}

function renderCues() {
  const track = currentTrack();
  const list = $('#cueList');
  if (!track) { list.innerHTML = '<li class="hint" style="padding:8px">Dialogue lines show up here once a subtitle track is selected.</li>'; return; }
  list.innerHTML = track.cues.map((c) =>
    `<li class="cue-row" data-cue="${c.id}"><span class="t">${fmt(c.start)}</span><span class="tx">${escapeHtml(c.text)}</span><button class="sync-now" data-sync="${c.id}" title="This line is being spoken right now">Sync</button></li>`
  ).join('');
  filterCues();
}

function filterCues() {
  const q = $('#cueSearch').value.trim().toLowerCase();
  for (const li of $('#cueList').children) {
    if (!li.dataset.cue) continue;
    li.hidden = !!q && !li.querySelector('.tx').textContent.toLowerCase().includes(q);
  }
}

let activeCueEls = [];
subs.onActiveChange = (active) => {
  activeCueEls.forEach((el) => el.classList.remove('active'));
  activeCueEls = active.map((c) => $(`#cueList [data-cue="${c.id}"]`)).filter(Boolean);
  activeCueEls.forEach((el) => el.classList.add('active'));
  const list = $('#cueList');
  if (activeCueEls[0] && $('#followCues').checked && !list.matches(':hover') && list.offsetParent) {
    const el = activeCueEls[0];
    list.scrollTo({ top: el.offsetTop - list.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
  }
};

function updateCcButton() {
  const on = S.subsOn && !!currentTrack();
  $('#ccBtn').classList.toggle('on', on);
}

function applySubStyle() {
  const r = document.documentElement.style;
  r.setProperty('--sub-size', S.subSize);
  r.setProperty('--sub-bg', S.subBg);
  r.setProperty('--sub-pos', S.subPos);
  r.setProperty('--sub-color', S.subColor);
  player.classList.toggle('sub-outline', S.subOutline);
  player.dataset.subfont = S.subFont;
  $$('#subColors button').forEach((b) => b.classList.toggle('sel', b.dataset.color === S.subColor));
}

function applyAccent() {
  document.documentElement.style.setProperty('--accent', S.accent);
  $$('#accentSwatches button').forEach((b) => b.classList.toggle('sel', b.dataset.accent === S.accent));
}

async function renderStorageInfo() {
  const est = await storageEstimate();
  const saved = state.entries.filter((e) => e.saved).length;
  const mb = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  $('#storageInfo').textContent = est
    ? `${mb(est.usage)} used of ${mb(est.quota)} available · ${saved} episode${saved === 1 ? '' : 's'} saved offline.`
    : `${saved} episode${saved === 1 ? '' : 's'} saved offline.`;
}

// ============================================================ frame loop: progress bar + subtitles

let lastSecond = -1;
let progressSaveAt = 0;
let dragging = false;

let rafId = 0;
function loop() {
  rafId = 0;
  tick();
  if (!video.paused) rafId = requestAnimationFrame(loop);
}
const startLoop = () => { if (!rafId) rafId = requestAnimationFrame(loop); };

function tick() {
  const t = video.currentTime;
  const d = video.duration;
  if (state.current) {
    if (!video.paused) state.lastTime = t;
    subs.render(t);
    if (!dragging && isFinite(d) && d > 0) setProgressVisual(t / d);
    const sec = Math.floor(t);
    if (sec !== lastSecond) {
      lastSecond = sec;
      $('#curTime').textContent = fmt(t);
      updateBuffered();
      updateSkipButton(t, d);
      if (Date.now() - progressSaveAt > 5000 && !video.paused) { progressSaveAt = Date.now(); saveProgress(); }
    }
  }
}

function setProgressVisual(frac) {
  frac = Math.max(0, Math.min(1, frac || 0));
  $('#progFill').style.width = `${frac * 100}%`;
  $('#progThumb').style.left = `${frac * 100}%`;
}

function updateBuffered() {
  const b = video.buffered, t = video.currentTime, d = video.duration;
  let end = 0;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > end) end = b.end(i);
  $('#progBuffer').style.width = isFinite(d) && d ? `${(end / d) * 100}%` : '0';
}

// ============================================================ seek bar + hover preview

const prog = $('#progress');
const previewVideo = $('#previewVideo');
let previewPending = null;

function setupPreview(server, url) {
  teardownPreview();
  // Previews need a plain file; adaptive streams (HLS/DASH) would load a second full player.
  if (!S.preview || engine.adaptive || (!server.local && detectType(server.url, server.type) !== 'file')) return;
  state.previewOn = true;
  previewVideo.preload = server.local ? 'auto' : 'metadata';
  previewVideo.src = url;
  $('#scrubTip').classList.add('has-preview');
}

function teardownPreview() {
  state.previewOn = false;
  previewVideo.removeAttribute('src');
  previewVideo.load();
  $('#scrubTip').classList.remove('has-preview');
}

previewVideo.addEventListener('seeked', () => {
  if (previewPending != null) {
    const t = previewPending;
    previewPending = null;
    previewVideo.currentTime = t;
  }
});
previewVideo.addEventListener('error', () => $('#scrubTip').classList.remove('has-preview'));

function fracFromEvent(e) {
  const r = prog.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

function updateScrubTip(frac) {
  const d = video.duration;
  if (!isFinite(d)) return;
  const t = frac * d;
  const tip = $('#scrubTip');
  const w = prog.clientWidth;
  const half = (tip.offsetWidth || 60) / 2;
  tip.style.left = `${Math.max(half, Math.min(w - half, frac * w))}px`;
  $('#scrubTime').textContent = fmt(t);
  $('#progHover').style.width = `${frac * 100}%`;
  if (state.previewOn) {
    if (previewVideo.seeking) previewPending = t;
    else previewVideo.currentTime = t;
  }
}

prog.addEventListener('pointermove', (e) => {
  const f = fracFromEvent(e);
  updateScrubTip(f);
  if (dragging) setProgressVisual(f);
});
prog.addEventListener('pointerdown', (e) => {
  if (!state.current || !isFinite(video.duration)) return;
  dragging = true;
  prog.classList.add('dragging');
  prog.setPointerCapture(e.pointerId);
  const f = fracFromEvent(e);
  setProgressVisual(f);
  updateScrubTip(f);
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  prog.classList.remove('dragging');
  const f = fracFromEvent(e);
  video.currentTime = f * video.duration;
  hideUpNext();
};
prog.addEventListener('pointerup', endDrag);
prog.addEventListener('pointercancel', () => { dragging = false; prog.classList.remove('dragging'); });

// ============================================================ controls visibility + gestures

let idleTimer;
function wake() {
  player.classList.add('show-controls');
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && !dragging && $('#gearMenu').hidden && !$('#controls').matches(':hover')) player.classList.add('idle');
  }, 2600);
}
player.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); });
player.addEventListener('mouseleave', () => { if (!video.paused) player.classList.add('idle'); });

let lastTap = { t: 0, x: 0 };
let lastPointerType = 'mouse';
let tapTimer;
video.addEventListener('pointerup', (e) => {
  if (!state.current || e.button > 0) return;
  lastPointerType = e.pointerType;
  // A click that closes an open menu shouldn't also pause the video.
  if (!$('#gearMenu').hidden) { $('#gearMenu').hidden = true; return; }
  if (e.pointerType === 'mouse') {
    togglePlay();
    return;
  }
  // Touch: single tap shows/hides controls, double tap on the sides seeks.
  const now = Date.now();
  const r = player.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  if (now - lastTap.t < 300) {
    clearTimeout(tapTimer);
    if (x < 0.35) { seekBy(-S.seekStep); flash('left'); }
    else if (x > 0.65) { seekBy(S.seekStep); flash('right'); }
    else togglePlay();
    lastTap = { t: 0, x };
    return;
  }
  lastTap = { t: now, x };
  tapTimer = setTimeout(() => {
    if (player.classList.contains('idle') || !player.classList.contains('show-controls')) wake();
    else { player.classList.add('idle'); }
  }, 280);
});
video.addEventListener('dblclick', (e) => {
  if (!state.current || lastPointerType !== 'mouse') return;
  toggleFullscreen();
  e.preventDefault();
});

function flash(side) {
  const el = side === 'left' ? $('#tapLeft') : $('#tapRight');
  el.classList.add('show');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('show')));
}

// ============================================================ gear menu

let gearPage = 'main';
function renderGear(page = 'main') {
  gearPage = page;
  const m = $('#gearMenu');
  const e = state.current;
  const back = (title) => `<button class="pop-item pop-back" data-page="main">‹ ${title}</button>`;
  let html = '';
  if (page === 'main') {
    const track = currentTrack();
    const playing = engine.levels.find((l) => l.index === engine.playingLevel);
    const levelLabel = engine.adaptive && engine.levels.length > 1
      ? engine.autoLevel ? `Auto${playing ? ` (${playing.height}p)` : ''}` : `${playing?.height ?? '?'}p`
      : null;
    html += `<button class="pop-item" data-page="speed">Speed <span class="val">${S.speed === 1 ? 'Normal' : S.speed + '×'} ›</span></button>`;
    if (levelLabel) html += `<button class="pop-item" data-page="quality">Quality <span class="val">${levelLabel} ›</span></button>`;
    if (e) html += `<button class="pop-item" data-page="server">Server <span class="val">${escapeHtml(e.servers[state.serverIdx]?.name || '')} ›</span></button>`;
    html += `<button class="pop-item" data-page="subs">Subtitles <span class="val">${track && S.subsOn ? escapeHtml(track.label) : 'Off'} ›</span></button>`;
    html += `<button class="pop-item" data-page="sync">Subtitle sync <span class="val">${fmtOffset(subs.offset)} ›</span></button>`;
  } else if (page === 'speed') {
    html += back('Speed') + SPEEDS.map((r) => `<button class="pop-item ${r === S.speed ? 'sel' : ''}" data-speed="${r}">${r === 1 ? 'Normal' : r + '×'}</button>`).join('');
  } else if (page === 'quality') {
    html += back('Quality') + `<button class="pop-item ${engine.autoLevel ? 'sel' : ''}" data-level="-1">Auto</button>` +
      [...engine.levels].sort((a, b) => b.height - a.height || b.bitrate - a.bitrate).map((l) => `<button class="pop-item ${!engine.autoLevel && engine.playingLevel === l.index ? 'sel' : ''}" data-level="${l.index}">${l.height}p <span class="val">${(l.bitrate / 1e6).toFixed(1)} Mbps</span></button>`).join('');
  } else if (page === 'server' && e) {
    html += back('Server') + e.servers.map((s, i) => `<button class="pop-item ${i === state.serverIdx ? 'sel' : ''}" data-server="${i}">${escapeHtml(s.name)} <span class="val">${serverKind(s)}</span></button>`).join('');
  } else if (page === 'subs') {
    html += back('Subtitles') + `<button class="pop-item ${!currentTrack() ? 'sel' : ''}" data-track="off">Off</button>` +
      (e?.subs || []).map((s) => `<button class="pop-item ${s.id === state.trackId && S.subsOn ? 'sel' : ''}" data-track="${s.id}">${escapeHtml(s.label)}</button>`).join('');
  } else if (page === 'sync') {
    html += back('Subtitle sync') + [-1, -0.1, 0.1, 1].map((d) => `<button class="pop-item" data-shift="${d}">${d > 0 ? 'Later' : 'Earlier'} by ${Math.abs(d)}s <span class="val">${d > 0 ? 'H' : 'G'}${Math.abs(d) === 1 ? ' + Shift' : ''}</span></button>`).join('') +
      `<button class="pop-item" data-shift="reset">Reset <span class="val">${fmtOffset(subs.offset)}</span></button>`;
  }
  m.innerHTML = html;
}

function toggleGear(force) {
  const m = $('#gearMenu');
  const open = force ?? m.hidden;
  m.hidden = !open;
  if (open) renderGear('main');
}

$('#gearMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.stopPropagation();
  const d = b.dataset;
  if (d.page) return renderGear(d.page);
  if (d.speed) { setSpeed(Number(d.speed)); return renderGear('main'); }
  if (d.level) {
    const i = Number(d.level);
    engine.setLevel(i);
    osd(i < 0 ? 'Quality · Auto' : `Quality · ${engine.levels.find((l) => l.index === i)?.height}p`);
    return renderGear('main');
  }
  if (d.server) { switchServer(Number(d.server)); return toggleGear(false); }
  if (d.track) {
    selectTrack(d.track);
    return renderGear('main');
  }
  if (d.shift) { d.shift === 'reset' ? setOffset(0) : shiftOffset(Number(d.shift)); return renderGear('sync'); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-anchor')) $('#gearMenu').hidden = true;
  if (!e.target.closest('.ep-menu, [data-more]')) closeEpMenu();
});

// ============================================================ episode menu

function closeEpMenu() {
  $$('.ep-menu').forEach((m) => m.remove());
  $$('[data-more][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function openEpMenu(li, entry) {
  closeEpMenu();
  const btn = li.querySelector('[data-more]');
  btn.setAttribute('aria-expanded', 'true');
  const m = document.createElement('div');
  m.className = 'ep-menu';
  const items = [['play', 'Play']];
  if (entry.file) items.push(entry.saved ? ['unsave', 'Remove offline copy'] : ['save', 'Save offline']);
  items.push(['edit', 'Edit servers']);
  items.push(['anime', animeLinks.get(entry.title) ? 'Change linked anime' : 'Link anime']);
  if (progress.get(entry.id)) items.push(['unwatch', 'Clear watch progress']);
  if (!entry.file) items.push(['share', 'Copy share link']);
  items.push(['remove', 'Remove from queue']);
  m.innerHTML = items.map(([a, l]) => `<button class="pop-item ${a === 'remove' ? 'danger' : ''}" data-act="${a}">${l}</button>`).join('');
  m.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    e.stopPropagation();
    closeEpMenu();
    if (act === 'play') playEntry(entry);
    if (act === 'save') {
      entry.saved = true;
      requestPersistence();
      await persist(entry);
      if (entry.saved) toast(`Saved "${entry.title}" for offline viewing`, 'ok');
      renderEpisodes(); renderNowPlaying(); renderStorageInfo();
    }
    if (act === 'unsave') {
      entry.saved = false;
      await library.remove(entry.id).catch(() => {});
      toast('Offline copy removed. It stays in the queue until you close the tab.');
      renderEpisodes(); renderNowPlaying(); renderStorageInfo();
    }
    if (act === 'edit') openStreamDialog(entry);
    if (act === 'anime') openAnimeDialog(entry);
    if (act === 'unwatch') { progress.clear(entry.id); renderEpisodes(); }
    if (act === 'share') {
      const u = new URL(location.href.split('?')[0]);
      u.searchParams.set('title', entry.title);
      entry.servers.forEach((s) => u.searchParams.append('src', s.url));
      if (entry.subUrl) u.searchParams.set('sub', entry.subUrl);
      navigator.clipboard?.writeText(u.toString()).then(() => toast('Link copied', 'ok'), () => prompt('Copy this link', u.toString()));
    }
    if (act === 'remove') {
      removeEntry(entry);
      toast(`Removed "${entry.title}"`);
    }
  });
  li.appendChild(m);
}

$('#episodes').addEventListener('click', (e) => {
  const li = e.target.closest('.ep');
  if (!li || e.target.closest('.ep-menu')) return;
  const entry = state.entries.find((x) => x.id === li.dataset.id);
  if (!entry) return;
  const more = e.target.closest('[data-more]');
  if (more) {
    e.stopPropagation();
    if (more.getAttribute('aria-expanded') === 'true') closeEpMenu();
    else openEpMenu(li, entry);
    return;
  }
  if (entry !== state.current) playEntry(entry);
  else togglePlay();
});

// ============================================================ stream dialog

const streamDialog = $('#streamDialog');
let editing = null;

function serverRow(s = {}, i = 0) {
  const locked = !!s.local;
  return `<div class="server-row" data-id="${escapeHtml(s.id || uid())}" ${locked ? 'data-local="1"' : ''}>
    <input class="input" name="sname" placeholder="Server ${i + 1}" value="${escapeHtml(s.name || '')}" ${locked ? 'disabled' : ''}>
    <input class="input" name="surl" type="${locked ? 'text' : 'url'}" placeholder="https://…/episode.m3u8" value="${escapeHtml(locked ? 'Uploaded file' : s.url || '')}" ${locked ? 'disabled' : ''}>
    <button type="button" class="cbtn" data-remove-row aria-label="Remove server" ${locked ? 'disabled' : ''}><svg><use href="#i-x"/></svg></button>
  </div>`;
}

function setStreamMode(mode) {
  const f = $('#streamForm');
  f.dataset.mode = mode;
  $$('#streamMode button').forEach((b) => b.classList.toggle('sel', b.dataset.mode === mode));
  const series = mode === 'series';
  $('#titleLabel').textContent = series ? 'Series title' : 'Title';
  f.elements.title.placeholder = series ? 'Frieren' : 'Frieren · Episode 12';
  f.elements.subUrl.placeholder = series ? 'https://…/subs/{ep2}.en.ass' : 'https://…/episode12.en.ass';
  $$('#serverRows input[name="surl"]:not(:disabled)').forEach((i) => {
    i.placeholder = series ? 'https://…/show/{ep2}.m3u8' : 'https://…/episode.m3u8';
    i.type = series ? 'text' : 'url'; // {ep} tokens aren't valid in type=url
  });
  $('#streamSubmit').textContent = series ? 'Add episodes' : 'Save & play';
}

function openStreamDialog(entry = null, { addRow = false } = {}) {
  editing = entry;
  const f = $('#streamForm');
  f.reset();
  $('#streamMode').hidden = !!entry;
  $('#streamDialogTitle').textContent = entry ? 'Edit servers' : 'Add stream';
  f.elements.title.value = entry?.title || '';
  f.elements.subUrl.value = entry?.subUrl || '';
  const servers = entry ? [...entry.servers] : [];
  if (!servers.length || addRow) servers.push({});
  $('#serverRows').innerHTML = servers.map(serverRow).join('');
  setStreamMode('single');
  streamDialog.showModal();
  const firstEmpty = $$('#serverRows input[name="surl"]').find((i) => !i.value && !i.disabled);
  (entry ? firstEmpty : f.elements.title)?.focus();
}

$('#streamMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setStreamMode(b.dataset.mode);
});
$('#addServerRow').addEventListener('click', () => {
  const rows = $('#serverRows');
  rows.insertAdjacentHTML('beforeend', serverRow({}, rows.children.length));
  setStreamMode($('#streamForm').dataset.mode || 'single');
  rows.lastElementChild.querySelector('[name="surl"]').focus();
});
$('#serverRows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove-row]');
  if (!b) return;
  const rows = $('#serverRows');
  if (rows.children.length > 1) b.closest('.server-row').remove();
  else rows.querySelector('[name="surl"]').value = '';
});

$('#streamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const series = !editing && f.dataset.mode === 'series';
  const servers = [];
  for (const [i, row] of $$('#serverRows .server-row').entries()) {
    if (row.dataset.local) { servers.push({ id: 'local', name: 'Local file', local: true }); continue; }
    const url = row.querySelector('[name="surl"]').value.trim();
    if (!url) continue;
    if (!isWebUrl(series ? fillPattern(url, 1) : url)) { toast(`"${url}" isn't a valid http(s) URL`, 'err'); return; }
    const name = row.querySelector('[name="sname"]').value.trim() || `Server ${i + 1}`;
    servers.push({ id: row.dataset.id, name, url, type: detectType(url) });
  }
  if (!servers.length) { toast('Add at least one server URL', 'err'); return; }
  const title = f.elements.title.value.trim() || 'Untitled';
  const subUrl = f.elements.subUrl.value.trim();
  if (subUrl && !isWebUrl(series ? fillPattern(subUrl, 1) : subUrl)) { toast("The subtitle URL isn't a valid http(s) URL", 'err'); return; }

  if (series) {
    const from = parseInt(f.elements.epFrom.value, 10);
    const to = parseInt(f.elements.epTo.value, 10);
    if (!(from >= 0) || !(to >= from) || to - from > 1999) { toast('Check the episode range (up to 2000 episodes)', 'err'); return; }
    if (!servers.some((s) => hasEpToken(s.url))) { toast('Put {ep} (or {ep2}/{ep3}) in at least one server URL so each episode gets its own link', 'err'); return; }
    streamDialog.close();
    const specs = [];
    for (let n = from; n <= to; n++) {
      specs.push({
        title: `${title} · Episode ${n}`,
        ep: n,
        servers: servers.map((s) => ({ name: s.name, url: fillPattern(s.url, n), type: s.type })),
        subUrl: subUrl ? fillPattern(subUrl, n) : '',
      });
    }
    const { added, skipped } = addStreamSpecs(specs);
    toast(`Added ${added.length} episode${added.length === 1 ? '' : 's'}${skipped ? ` (${skipped} already queued)` : ''}`, 'ok');
    if (added.length && (!state.current || video.paused)) playEntry(added[0]);
    return;
  }
  streamDialog.close();

  if (editing) {
    const entry = editing;
    const prevServer = entry.servers[state.serverIdx];
    const subChanged = subUrl && subUrl !== entry.subUrl;
    Object.assign(entry, { title, servers, subUrl });
    if (!entry.file) entry.ep = parseName(title + '.x').ep;
    persist(entry);
    renderEpisodes();
    if (entry === state.current) {
      renderNowPlaying();
      const idx = servers.findIndex((s) => s.id === prevServer?.id);
      if (idx === -1) loadServer(0, video.currentTime, true);
      else {
        state.serverIdx = idx;
        renderServers();
        // An "add server" from the error card should try the new one immediately.
        if (!$('#errorCard').hidden) loadServer(servers.length - 1, state.lastTime, true);
      }
    }
    if (subChanged) fetchRemoteSub(entry, subUrl);
    toast('Saved', 'ok');
  } else {
    const [entry] = addEntries([makeStreamEntry({ title, servers, subUrl })]);
    await playEntry(entry);
  }
});

$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// ============================================================ wiring

const fileInput = $('#fileInput');
const openUpload = () => fileInput.click();
fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
$('#uploadBtn').addEventListener('click', openUpload);
$('#emptyUpload').addEventListener('click', openUpload);
$('#streamBtn').addEventListener('click', () => openStreamDialog());
$('#emptyStream').addEventListener('click', () => openStreamDialog());
$('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
$('#editEntryBtn').addEventListener('click', () => state.current && openStreamDialog(state.current));
$('#addServerBtn').addEventListener('click', () => state.current && openStreamDialog(state.current, { addRow: true }));
$('#addServerFromError').addEventListener('click', () => state.current && openStreamDialog(state.current, { addRow: true }));
$('#retryBtn').addEventListener('click', () => {
  if (!state.current) return;
  state.serverStatus = {};
  loadServer(state.serverIdx, state.lastTime, true);
});
$('#serverChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-server]');
  if (b) switchServer(Number(b.dataset.server));
});
$('#shotBtn').addEventListener('click', screenshot);

$('#demoBtn').addEventListener('click', () => {
  const demo = [
    makeStreamEntry({ title: 'Big Buck Bunny · Episode 1', servers: [
      { name: 'Mux', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
      { name: 'Akamai', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd' },
    ] }),
    makeStreamEntry({ title: 'Sintel (trailer) · Episode 2', servers: [{ name: 'Blender', url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' }] }),
  ];
  demo[1].order = demo[0].order + 1;
  const added = demo.map((d) => state.entries.find((e) => !e.file && e.servers[0]?.url === d.servers[0].url) || addEntries([d])[0]);
  playEntry(added[0]);
});

$('#playBtn').addEventListener('click', togglePlay);
$('#prevBtn').addEventListener('click', () => playNeighbor(-1));
$('#nextBtn').addEventListener('click', () => playNeighbor(1));
$('#back10').addEventListener('click', () => seekBy(-S.seekStep));
$('#fwd10').addEventListener('click', () => seekBy(S.seekStep));
$('#skipBtn').addEventListener('click', skipIntro);
$('#skipOp').addEventListener('click', skipIntro);
$('#muteBtn').addEventListener('click', toggleMute);
$('#volRange').addEventListener('input', (e) => setVolume(Number(e.target.value), { silent: true }));
$('#ccBtn').addEventListener('click', toggleSubs);
$('#gearBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleGear(); });
$('#pipBtn').addEventListener('click', togglePip);
$('#theaterBtn').addEventListener('click', () => setTheater(!S.theater));
$('#fullBtn').addEventListener('click', toggleFullscreen);
if (!document.pictureInPictureEnabled) $('#pipBtn').hidden = true;

// side tabs
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
function showTab(name) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'settings') renderStorageInfo();
  if (name === 'subtitles') { subs.lastKey = null; subs.render(video.currentTime); }
}
$('#epSearch').addEventListener('input', renderEpisodes);

// subtitle panel
$('#subUploadBtn').addEventListener('click', () => {
  if (!state.current) return toast('Play an episode first', 'warn');
  $('#subInput').click();
});
$('#subInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !state.current) return;
  try {
    const sub = await readSubFile(f);
    attachSub(state.current, sub);
    toast(`Loaded ${sub.cues.length} lines · ${sub.label}`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});
$('#subTracks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-track]');
  if (b) selectTrack(b.dataset.track);
});
$$('.sync-grid [data-shift]').forEach((b) => b.addEventListener('click', () => shiftOffset(Number(b.dataset.shift))));
$('#resetOffset').addEventListener('click', () => setOffset(0));
$('#cueSearch').addEventListener('input', filterCues);
$('#cueList').addEventListener('click', (e) => {
  const sync = e.target.closest('[data-sync]');
  const track = currentTrack();
  if (!track) return;
  if (sync) {
    const cue = track.cues[Number(sync.dataset.sync)];
    setOffset(video.currentTime - cue.start, { label: `Synced · ${fmtOffset(Math.round((video.currentTime - cue.start) * 1000) / 1000)}` });
    return;
  }
  const row = e.target.closest('[data-cue]');
  if (row) {
    const cue = track.cues[Number(row.dataset.cue)];
    video.currentTime = Math.max(0, cue.start + subs.offset);
  }
});

// appearance
const bindRange = (id, key, apply) => {
  const el = $(id);
  el.value = S[key];
  el.addEventListener('input', () => { S[key] = Number(el.value); saveSettings(); apply(); });
};
bindRange('#subSize', 'subSize', applySubStyle);
bindRange('#subBg', 'subBg', applySubStyle);
bindRange('#subPos', 'subPos', applySubStyle);
$('#subOutline').checked = S.subOutline;
$('#subOutline').addEventListener('change', (e) => { S.subOutline = e.target.checked; saveSettings(); applySubStyle(); });
$('#subColors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (b) { S.subColor = b.dataset.color; saveSettings(); applySubStyle(); }
});

// settings
const bindSwitch = (id, key, after) => {
  const el = $(id);
  el.checked = !!S[key];
  el.addEventListener('change', () => { S[key] = el.checked; saveSettings(); after?.(); });
};
bindSwitch('#setAutoNext', 'autoNext');
bindSwitch('#setFailover', 'failover');
bindSwitch('#setResume', 'resume');
bindSwitch('#setPreview', 'preview', () => {
  if (!S.preview) teardownPreview();
  else if (state.current) {
    const s = state.current.servers[state.serverIdx];
    setupPreview(s, s.local ? objectUrlFor(state.current) : s.url);
  }
});
$('#setSkipLen').value = String(S.skipLen);
$('#setSkipLen').addEventListener('change', (e) => { S.skipLen = Number(e.target.value); saveSettings(); });
$('#accentSwatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-accent]');
  if (b) { S.accent = b.dataset.accent; saveSettings(); applyAccent(); }
});
$('#clearLibrary').addEventListener('click', async () => {
  if (!confirm('Remove all saved streams and offline episodes from this device?')) return;
  await library.clear().catch(() => {});
  const keep = state.entries.filter((e) => e.file);
  keep.forEach((e) => (e.saved = false));
  if (state.current && !keep.includes(state.current)) stopPlayback();
  state.entries = keep;
  renderEpisodes();
  renderNowPlaying();
  renderStorageInfo();
  toast('Library cleared');
});

$('#setAutoSkip').checked = S.autoSkip;
$('#setAutoSkip').addEventListener('change', (e) => { S.autoSkip = e.target.checked; state.skipDone = new Set(); saveSettings(); });
bindSwitch('#setSubSigns', 'subSigns');
bindSwitch('#setPreferServer', 'preferServer');
$('#setSeekStep').value = String(S.seekStep);
$('#setSeekStep').addEventListener('change', (e) => { S.seekStep = Number(e.target.value); saveSettings(); applySeekStep(); });
$('#setSubLang').value = S.subLang;
$('#setSubLang').addEventListener('change', (e) => { S.subLang = e.target.value; saveSettings(); });
$('#subFont').value = S.subFont;
$('#subFont').addEventListener('change', (e) => { S.subFont = e.target.value; saveSettings(); applySubStyle(); });

function applySeekStep() {
  $$('#i-back10 text, #i-fwd10 text').forEach((t) => (t.textContent = S.seekStep));
  $('#back10').title = `Back ${S.seekStep}s (J)`;
  $('#fwd10').title = `Forward ${S.seekStep}s (L)`;
}

// ============================================================ anime linking (AniList)

const animeDialog = $('#animeDialog');
let animeFor = null;       // entry the dialog was opened for
let animeResults = [];
let animeAbort = null;

function seriesEntries(entry) {
  const key = seriesKey(entry.title);
  return state.entries.filter((e) => seriesKey(e.title) === key);
}

function openAnimeDialog(entry = state.current) {
  if (!entry) return;
  animeFor = entry;
  const linked = animeLinks.get(entry.title);
  $('#animeQuery').value = linked?.romaji || seriesName(entry.title);
  $('#unlinkAnime').hidden = !linked;
  const n = seriesEntries(entry).length;
  $('#animeScope').textContent = n > 1 ? `Applies to all ${n} episodes of "${seriesName(entry.title)}".` : '';
  animeDialog.showModal();
  runAnimeSearch();
}

async function runAnimeSearch() {
  const q = $('#animeQuery').value.trim();
  const list = $('#animeResults');
  if (!q) { list.innerHTML = ''; return; }
  if (!navigator.onLine) { list.innerHTML = '<li class="hint">You are offline. Linking needs a connection once; after that it works offline.</li>'; return; }
  animeAbort?.abort();
  animeAbort = new AbortController();
  list.innerHTML = '<li class="hint">Searching AniList…</li>';
  try {
    animeResults = await searchAnime(q, { signal: animeAbort.signal });
    const linkedId = animeFor && animeLinks.get(animeFor.title)?.id;
    list.innerHTML = animeResults.length
      ? animeResults.map((a, i) => `<li><button type="button" data-anime="${i}" class="${a.id === linkedId ? 'sel' : ''}">
          <img src="${escapeHtml(a.thumb || '')}" alt="" loading="lazy">
          <span><b>${escapeHtml(a.title)}</b><small>${escapeHtml([a.romaji !== a.title ? a.romaji : null, a.format?.replace('_', ' '), a.year, a.episodes ? `${a.episodes} eps` : null].filter(Boolean).join(' · '))}</small></span>
        </button></li>`).join('')
      : '<li class="hint">No matches. Try the Japanese (romaji) title or a shorter name.</li>';
  } catch (err) {
    if (err.name === 'AbortError') return;
    list.innerHTML = `<li class="hint">${escapeHtml(err.message || 'Search failed')}</li>`;
  }
}

$('#animeSearchForm').addEventListener('submit', (e) => { e.preventDefault(); runAnimeSearch(); });
$('#animeResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-anime]');
  if (!b || !animeFor) return;
  const anime = animeResults[Number(b.dataset.anime)];
  animeLinks.set(animeFor.title, anime);
  animeDialog.close();
  toast(`Linked to ${anime.title}${anime.idMal ? '' : ' (no MyAnimeList ID, so skip times are unavailable)'}`, 'ok');
  afterAnimeChange();
});
$('#unlinkAnime').addEventListener('click', () => {
  if (!animeFor) return;
  animeLinks.set(animeFor.title, null);
  animeDialog.close();
  afterAnimeChange();
});
function afterAnimeChange() {
  renderEpisodes();
  if (state.current && animeFor && seriesKey(state.current.title) === seriesKey(animeFor.title)) {
    renderNowPlaying();
    updateMediaSession();
    loadSkipTimes();
  }
}
$('#linkAnimeBtn').addEventListener('click', () => openAnimeDialog());
$('#infoCover').addEventListener('click', () => openAnimeDialog());

// ============================================================ import / export

async function importPlaylistFile(file) {
  try {
    const specs = parsePlaylist(decodeText(await file.arrayBuffer()), file.name);
    const { added, skipped } = addStreamSpecs(specs);
    toast(`Imported ${added.length} stream${added.length === 1 ? '' : 's'} from ${file.name}${skipped ? ` (${skipped} already queued)` : ''}`, added.length ? 'ok' : 'warn');
    if (added.length && !state.current) playEntry(added[0]);
  } catch (err) {
    toast(err.message || `Couldn't import ${file.name}`, 'err');
  }
}

$('#exportLibrary').addEventListener('click', () => {
  const data = exportLibrary(state.entries);
  if (!data.entries.length) return toast('Nothing to export yet. Only stream entries can be exported, not uploaded files.', 'warn');
  downloadJson(data, `anivlc-library-${new Date().toISOString().slice(0, 10)}.json`);
  toast(`Exported ${data.entries.length} stream${data.entries.length === 1 ? '' : 's'}`, 'ok');
});
$('#importLibrary').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await importPlaylistFile(f);
});

// ============================================================ video events

video.addEventListener('play', () => {
  hideUpNext();
  player.classList.remove('paused');
  $('#playBtn use').setAttribute('href', '#i-pause');
  $('#errorCard').hidden = true;
  startLoop();
  wake();
  renderEpisodes();
});
video.addEventListener('pause', () => {
  player.classList.add('paused');
  $('#playBtn use').setAttribute('href', '#i-play');
  saveProgress();
  wake();
  renderEpisodes();
});
video.addEventListener('waiting', () => setLoading(true));
video.addEventListener('playing', () => setLoading(false));
video.addEventListener('canplay', () => setLoading(false));
video.addEventListener('seeked', () => { tick(); setLoading(false); });
video.addEventListener('progress', updateBuffered);
video.addEventListener('loadedmetadata', () => {
  $('#durTime').textContent = fmt(video.duration);
  tick();
  if (state.current) loadSkipTimes();
});
video.addEventListener('seeking', () => { if (!video.ended) hideUpNext(); });
video.addEventListener('volumechange', () => {
  $('#muteBtn use').setAttribute('href', video.muted || video.volume === 0 ? '#i-mute' : '#i-vol');
  $('#volRange').value = video.muted ? 0 : video.volume;
});
video.addEventListener('ended', () => {
  saveProgress();
  renderEpisodes();
  const next = neighbor(1);
  if (S.autoNext && next) showUpNext(next);
});
video.addEventListener('enterpictureinpicture', () => $('#pipBtn').classList.add('on'));
video.addEventListener('leavepictureinpicture', () => $('#pipBtn').classList.remove('on'));
document.addEventListener('fullscreenchange', () => {
  $('#fullBtn use').setAttribute('href', document.fullscreenElement ? '#i-exitfull' : '#i-full');
  // Only the fullscreen element is visible, so carry the toast stack inside it.
  (document.fullscreenElement === player ? player : document.body).appendChild($('#toasts'));
});

// up next
let upNextTimer;
function showUpNext(next) {
  const el = $('#upnext');
  $('#upnextTitle').textContent = next.title;
  el.hidden = false;
  const ring = $('#upnextRing');
  const total = 6000, start = performance.now();
  const step = (now) => {
    if (el.hidden) return;
    const p = Math.min(1, (now - start) / total);
    ring.style.strokeDashoffset = String(94.25 * (1 - p));
    if (p >= 1) { hideUpNext(); playEntry(next); return; }
    upNextTimer = requestAnimationFrame(step);
  };
  upNextTimer = requestAnimationFrame(step);
  $('#upnextPlay').onclick = () => { hideUpNext(); playEntry(next); };
}
function hideUpNext() {
  cancelAnimationFrame(upNextTimer);
  $('#upnext').hidden = true;
}
$('#upnextCancel').addEventListener('click', hideUpNext);

// ============================================================ keyboard

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || $('dialog[open]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const map = {
    ' ': togglePlay, k: togglePlay, K: togglePlay,
    j: () => seekBy(-S.seekStep), l: () => seekBy(S.seekStep),
    ArrowLeft: () => seekBy(-5), ArrowRight: () => seekBy(5),
    ArrowUp: () => setVolume(video.volume + 0.05), ArrowDown: () => setVolume(video.volume - 0.05),
    m: toggleMute, f: toggleFullscreen, t: () => setTheater(!S.theater), i: togglePip,
    c: toggleSubs, v: cycleTracks,
    g: () => shiftOffset(-0.1), h: () => shiftOffset(0.1),
    G: () => shiftOffset(-1), H: () => shiftOffset(1),
    n: () => playNeighbor(1), b: () => playNeighbor(-1),
    s: () => {
      const e2 = state.current;
      if (e2 && e2.servers.length > 1) switchServer((state.serverIdx + 1) % e2.servers.length);
      else osd('Only one server for this episode');
    },
    o: skipIntro, x: screenshot,
    '[': () => setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(S.speed) - 1)] ?? 1),
    ']': () => setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + 1)] ?? 1),
    ',': () => { if (video.paused) video.currentTime = Math.max(0, video.currentTime - 1 / 24); },
    '.': () => { if (video.paused) video.currentTime += 1 / 24; },
    '?': () => $('#helpDialog').showModal(),
  };
  let fn = map[k] || map[k.toLowerCase()];
  if (!fn && /^[0-9]$/.test(k) && isFinite(video.duration)) fn = () => { video.currentTime = video.duration * Number(k) / 10; osd(`${k}0%`); };
  if (!fn) return;
  e.preventDefault();
  fn();
  wake();
});

// ============================================================ drag & drop

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  handleFiles(e.dataTransfer.files);
});

// ============================================================ media session, network, install, SW

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !state.current) return;
  const anime = animeLinks.get(state.current.title);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.current.title,
    artist: anime?.title || 'AniVLC',
    artwork: anime?.cover ? [{ src: anime.cover, sizes: '460x650', type: 'image/jpeg' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported */ } };
  set('play', () => video.play());
  set('pause', () => video.pause());
  set('seekbackward', () => seekBy(-S.seekStep));
  set('seekforward', () => seekBy(S.seekStep));
  set('previoustrack', neighbor(-1) ? () => playNeighbor(-1) : null);
  set('nexttrack', neighbor(1) ? () => playNeighbor(1) : null);
}

function renderNet() {
  const pill = $('#netPill');
  pill.classList.toggle('offline', !navigator.onLine);
  pill.querySelector('span').textContent = navigator.onLine ? 'Online' : 'Offline';
}
addEventListener('online', () => { renderNet(); toast('Back online', 'ok'); });
addEventListener('offline', () => { renderNet(); toast('You are offline. Local and saved episodes still play.', 'warn'); });

let installPrompt;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#installBtn').hidden = true;
});

addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
}

// ============================================================ boot

async function boot() {
  applyAccent();
  applySubStyle();
  setTheater(S.theater);
  video.volume = S.volume;
  video.muted = S.muted;
  $('#volRange').value = S.muted ? 0 : S.volume;
  if (S.speed !== 1) { $('#speedBadge').hidden = false; $('#speedBadge').textContent = `${S.speed}×`; }
  player.classList.add('paused');
  applySeekStep();
  renderNet();
  await restoreLibrary();
  renderEpisodes();
  renderSubPanel();

  // Installed app opened via "Open with AniVLC" on a video/subtitle file.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      handleFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }

  // Deep link: ?src=URL[&src=mirror]&title=...&sub=URL
  const params = new URLSearchParams(location.search);
  const srcs = params.getAll('src').filter(isWebUrl);
  if (params.has('src')) history.replaceState(null, '', location.pathname);
  if (srcs.length) {
    const existing = state.entries.find((e) => !e.file && e.servers[0]?.url === srcs[0]);
    const sub = params.get('sub');
    const entry = existing || addEntries([makeStreamEntry({
      title: (params.get('title') || 'Shared stream').slice(0, 200),
      servers: srcs.map((url, i) => ({ name: `Server ${i + 1}`, url })),
      subUrl: sub && isWebUrl(sub) ? sub : '',
    })])[0];
    playEntry(entry);
  }
}

boot();
