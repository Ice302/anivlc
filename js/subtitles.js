// Subtitle parsing (SRT, WebVTT, ASS/SSA) and an overlay renderer with a sync offset.
// Cues are { id, start, end, html, text, top } with times in seconds.

export const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

/** Decode subtitle bytes: honour BOMs, try strict UTF-8, fall back to Windows-1252. */
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function detectFormat(name, text) {
  const ext = (name.match(SUB_EXT) || [])[1]?.toLowerCase();
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  const head = text.slice(0, 400);
  if (/^﻿?WEBVTT/.test(head)) return 'vtt';
  if (/\[Script Info\]/i.test(head)) return 'ass';
  return 'srt';
}

export function parseSubtitles(text, name = '') {
  const fmt = detectFormat(name, text);
  const cues = fmt === 'ass' ? parseASS(text) : parseTimed(text);
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  cues.forEach((c, i) => (c.id = i));
  return { format: fmt, cues };
}

/** Guess a short label like "English" or "EN" from a file name such as "Ep01.en.forced.ass". */
export function labelFromName(name) {
  const langs = { en: 'English', eng: 'English', ja: 'Japanese', jp: 'Japanese', jpn: 'Japanese', es: 'Spanish', spa: 'Spanish', pt: 'Portuguese', 'pt-br': 'Portuguese (BR)', fr: 'French', de: 'German', it: 'Italian', ru: 'Russian', ar: 'Arabic', id: 'Indonesian', ind: 'Indonesian', tl: 'Filipino', fil: 'Filipino', zh: 'Chinese', ko: 'Korean', vi: 'Vietnamese', th: 'Thai' };
  const parts = name.replace(SUB_EXT, '').toLowerCase().split(/[._\s-]+/).reverse();
  const tags = [];
  for (const p of parts.slice(0, 3)) {
    if (langs[p]) { tags.unshift(langs[p]); break; }
    if (/^(forced|signs|songs|sdh|cc)$/.test(p)) tags.push(p[0].toUpperCase() + p.slice(1));
  }
  return tags.length ? tags.join(' · ') : name.replace(SUB_EXT, '').slice(-28);
}

// ---------- SRT / VTT ----------

const TIME_LINE = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(.*)$/;

function toSeconds(ts) {
  const parts = ts.replace(',', '.').split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}

function parseTimed(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n');
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip VTT STYLE / NOTE / REGION blocks entirely.
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) {
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }
    const m = line.match(TIME_LINE);
    if (!m) { i++; continue; }
    const start = toSeconds(m[1]);
    const end = toSeconds(m[2]);
    const settings = m[3] || '';
    const body = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !TIME_LINE.test(lines[i])) body.push(lines[i++]);
    const raw = body.join('\n');
    if (!raw.trim() || end <= start) continue;
    const top = isTopLine(settings) || /^\{\\an[789]\}/.test(raw);
    cues.push({ start, end, html: sanitizeMarkup(raw), text: stripTags(raw), top });
  }
  return cues;
}

/** VTT cue settings put a cue near the top when line: is a small percentage or a small non-negative line number. */
function isTopLine(settings) {
  const m = settings.match(/line:\s*(-?[\d.]+)(%?)/);
  if (!m) return false;
  const v = Number(m[1]);
  return m[2] === '%' ? v < 30 : v >= 0 && v <= 2;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** Keep only <i>, <b>, <u>, <s>; drop everything else (voice spans, classes, fonts, timestamps). */
function sanitizeMarkup(raw) {
  const placeholders = [];
  const keep = raw
    .replace(/\{\\an?\d\}/g, '') // stray ASS alignment tags inside SRTs
    .replace(/<(\/?)(i|b|u|s)(?:\.[^>]*)?>/gi, (_, slash, tag) => {
      placeholders.push(`<${slash}${tag.toLowerCase()}>`);
      return `\u0000${placeholders.length - 1}\u0000`;
    })
    .replace(/<[^>]*>/g, '');
  return escapeHtml(keep).replace(/\u0000(\d+)\u0000/g, (_, n) => placeholders[n]).trim();
}

function stripTags(raw) {
  return raw.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

// ---------- ASS / SSA ----------

function assTime(ts) {
  const [h, m, s] = ts.trim().split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseASS(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const styleAlign = {};
  let styleFields = null;
  let inStyles = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[(.+)\]\s*$/);
    if (section) {
      const name = section[1].toLowerCase();
      inEvents = name === 'events';
      inStyles = name.includes('styles');
      continue;
    }
    if (inStyles) {
      if (/^Format:/i.test(line)) styleFields = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
      else if (/^Style:/i.test(line) && styleFields) {
        const vals = line.slice(6).split(',').map((v) => v.trim());
        const name = vals[styleFields.indexOf('name')];
        const align = Number(vals[styleFields.indexOf('alignment')]);
        if (name) styleAlign[name] = align;
      }
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(line)) {
      fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const rest = line.slice(line.indexOf(':') + 1);
    const vals = [];
    let pos = 0;
    for (let f = 0; f < fields.length - 1; f++) {
      const comma = rest.indexOf(',', pos);
      if (comma === -1) break;
      vals.push(rest.slice(pos, comma));
      pos = comma + 1;
    }
    vals.push(rest.slice(pos));
    const get = (k) => vals[fields.indexOf(k)] ?? '';
    const raw = get('text');
    if (!raw) continue;
    // Vector drawings (\p1..) are typesetting art, not dialogue.
    if (/\\p[1-9]/.test(raw)) continue;

    const start = assTime(get('start'));
    const end = assTime(get('end'));
    if (!(end > start)) continue;

    const anMatch = raw.match(/\\an([1-9])/);
    const aMatch = !anMatch && raw.match(/\\a(\d{1,2})/);
    let align = anMatch ? Number(anMatch[1]) : aMatch ? legacyAlign(Number(aMatch[1])) : styleAlign[get('style').trim()] ?? 2;
    const top = align >= 7;

    const html = assToHtml(raw);
    const plain = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!plain) continue;
    cues.push({ start, end, html, text: decodeEntities(plain.replace(/\s*\n\s*/g, ' ')), top, layer: Number(get('layer')) || 0 });
  }

  // Fansub files often repeat the same line on several layers (border, shadow, fill). Collapse those.
  const seen = new Set();
  return cues.filter((c) => {
    const k = `${c.start}|${c.end}|${c.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function legacyAlign(a) {
  // SSA v4 \a: 1-3 bottom, 5-7 top, 9-11 middle
  if (a >= 5 && a <= 7) return a + 2;
  if (a >= 9) return a - 5;
  return a;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function assToHtml(raw) {
  let out = '';
  const open = { i: false, b: false, u: false, s: false };
  const parts = raw.split(/(\{[^}]*\})/);
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      for (const tag of ['i', 'b', 'u', 's']) {
        const m = part.match(new RegExp(`\\\\${tag}(\\d+)?(?![a-z])`));
        if (!m) continue;
        const on = m[1] === undefined ? false : Number(m[1]) > 0;
        if (on && !open[tag]) { out += `<${tag}>`; open[tag] = true; }
        else if (!on && open[tag]) { out += `</${tag}>`; open[tag] = false; }
      }
      if (/\\r(?![a-z])/.test(part)) {
        for (const tag of ['s', 'u', 'b', 'i']) if (open[tag]) { out += `</${tag}>`; open[tag] = false; }
      }
      continue;
    }
    out += escapeHtml(part).replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, '&nbsp;');
  }
  for (const tag of ['s', 'u', 'b', 'i']) if (open[tag]) out += `</${tag}>`;
  return out.trim();
}

// ---------- renderer ----------

export class SubtitleRenderer {
  constructor(container) {
    this.el = container;
    this.top = document.createElement('div');
    this.top.className = 'subs-top';
    container.parentElement.insertBefore(this.top, container.nextSibling);
    this.cues = [];
    this.offset = 0;
    this.enabled = true;
    this.lastKey = '';
    this.onActiveChange = null;
  }

  setCues(cues) {
    this.cues = cues || [];
    this.lastKey = null;
  }

  /** Cues active at media time t. Positive offset = subtitles appear later. */
  activeAt(t) {
    const tt = t - this.offset;
    const cues = this.cues;
    // Binary search: first cue with start > tt.
    let lo = 0, hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= tt) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo - 1, scanned = 0; i >= 0 && scanned < 60; i--, scanned++) {
      if (cues[i].end > tt) out.push(cues[i]);
    }
    return out.reverse();
  }

  /** Index of the cue nearest to time t (for the "follow" list). */
  nearestIndex(t) {
    const tt = t - this.offset;
    let lo = 0, hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start <= tt) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  render(t) {
    const active = this.enabled ? this.activeAt(t) : [];
    const key = active.map((c) => c.id).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const bottom = active.filter((c) => !c.top);
    const top = active.filter((c) => c.top);
    this.el.innerHTML = bottom.map((c) => `<span class="cue">${c.html}</span>`).join('');
    this.top.innerHTML = top.map((c) => `<span class="cue">${c.html}</span>`).join('');
    this.onActiveChange?.(active);
  }

  clear() {
    this.el.innerHTML = '';
    this.top.innerHTML = '';
    this.lastKey = '';
  }
}
