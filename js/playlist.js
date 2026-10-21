// Import/export: AniVLC JSON backups, M3U playlists, and URL patterns for batch-adding a series.

export const PLAYLIST_EXT = /\.(m3u8?|json)$/i;

const isWebUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

/** Fill {ep}, {ep2}, {ep3} (zero-padded) in a URL pattern. */
export function fillPattern(pattern, n) {
  return pattern
    .replace(/\{ep3\}/g, String(n).padStart(3, '0'))
    .replace(/\{ep2\}/g, String(n).padStart(2, '0'))
    .replace(/\{ep\}/g, String(n));
}
export const hasEpToken = (s) => /\{ep[23]?\}/.test(s);

export function exportLibrary(entries) {
  return {
    app: 'anivlc',
    version: 1,
    exported: new Date().toISOString(),
    entries: entries
      .filter((e) => !e.file)
      .map((e) => ({
        title: e.title,
        ep: e.ep,
        servers: e.servers.filter((s) => !s.local).map(({ name, url, type }) => ({ name, url, type })),
        subUrl: e.subUrl || undefined,
      })),
  };
}

/**
 * Parse a JSON backup or an M3U playlist into plain stream specs:
 * [{ title, servers: [{ name, url, type }], subUrl }]. Throws on anything else.
 */
export function parsePlaylist(text, name = '') {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (/\.json$/i.test(name) || /^[[{]/.test(trimmed)) return parseJson(trimmed);
  if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(trimmed)) {
    throw new Error('This is an HLS stream manifest, not a playlist. Add its URL as a server instead.');
  }
  return parseM3U(trimmed);
}

function parseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This JSON file could not be read'); }
  const list = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(list)) throw new Error('No episodes found in this JSON file');
  const out = [];
  for (const e of list) {
    const servers = (e.servers || (e.url ? [{ url: e.url }] : []))
      .filter((s) => s && isWebUrl(s.url))
      .map((s, i) => ({ name: String(s.name || `Server ${i + 1}`).slice(0, 40), url: s.url, type: s.type }));
    if (!servers.length) continue;
    out.push({ title: String(e.title || 'Untitled').slice(0, 200), servers, subUrl: isWebUrl(e.subUrl) ? e.subUrl : '' });
  }
  if (!out.length) throw new Error('No playable streams found in this JSON file');
  return out;
}

function parseM3U(text) {
  const out = [];
  let title = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      title = line.slice(line.indexOf(',') + 1).trim() || null;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (isWebUrl(line)) {
      const fallback = decodeURIComponent(new URL(line).pathname.split('/').pop() || 'Stream').replace(/\.[^.]+$/, '');
      out.push({ title: title || fallback, servers: [{ name: 'Server 1', url: line }], subUrl: '' });
    }
    title = null;
  }
  if (!out.length) throw new Error('No web URLs found in this playlist (local file paths can\'t be opened from a browser)');
  return out;
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
