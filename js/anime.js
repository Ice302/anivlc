// Anime metadata (AniList) and community skip times (AniSkip). Both are free, CORS-enabled public APIs.

const ANILIST = 'https://graphql.anilist.co';
const ANISKIP = 'https://api.aniskip.com/v2/skip-times';
const LS_LINKS = 'anivlc:animeLinks';
const LS_SKIPS = 'anivlc:skipCache';

/** "Sousou no Frieren - 12" / "Frieren · Episode 12" / "Show S01E05" → series name. */
export function seriesName(title) {
  // Only the first matching pattern applies, so "Kaiju No. 8 - 03" keeps its "8".
  const patterns = [
    /\s*\bS\d{1,2}\s?E\d{1,4}\b.*$/i,
    /\s*[·|:-]?\s*\b(?:Ep(?:isode)?\.?|E)\s*\d{1,4}\b.*$/i,
    /\s+-\s+\d{1,4}(?:v\d)?\b.*$/i,
    /\s+\d{1,4}(?:v\d)?$/,
  ];
  let name = title;
  for (const re of patterns) {
    if (re.test(name)) { name = name.replace(re, ''); break; }
  }
  return name.replace(/\s*[·|:-]\s*$/, '').trim() || title.trim();
}

export const seriesKey = (title) => seriesName(title).toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]+/g, ' ').trim();

function readLS(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

/** Series → AniList entry links, shared by every episode of that series (local files included). */
export const animeLinks = {
  get(title) { return readLS(LS_LINKS)[seriesKey(title)] || null; },
  set(title, anime) {
    const all = readLS(LS_LINKS);
    if (anime) all[seriesKey(title)] = anime; else delete all[seriesKey(title)];
    writeLS(LS_LINKS, all);
  },
};

const SEARCH_QUERY = `query ($search: String) {
  Page(perPage: 8) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id idMal episodes format seasonYear siteUrl
      title { romaji english }
      coverImage { medium large color }
    }
  }
}`;

export async function searchAnime(search, { signal } = {}) {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { search } }),
    signal,
  });
  if (res.status === 429) throw new Error('AniList rate limit reached, so try again in a minute');
  if (!res.ok) throw new Error(`AniList error ${res.status}`);
  const json = await res.json();
  return (json.data?.Page?.media || []).map((m) => ({
    id: m.id,
    idMal: m.idMal,
    title: m.title.english || m.title.romaji,
    romaji: m.title.romaji,
    episodes: m.episodes,
    format: m.format,
    year: m.seasonYear,
    url: m.siteUrl,
    cover: m.coverImage?.large || m.coverImage?.medium,
    thumb: m.coverImage?.medium,
    color: m.coverImage?.color,
  }));
}

/**
 * Skip segments for an episode: [{ type: 'op'|'ed'|'recap', start, end }].
 * Releases of the same episode differ in length (TV vs. Blu-ray cuts), so we send our real
 * duration and AniSkip returns timestamps adjusted to it. Results (including "none found")
 * are cached per episode and length.
 */
export async function fetchSkipTimes(idMal, episode, duration) {
  const len = Math.round(duration / 5) * 5;
  const key = `${idMal}:${episode}:${len}`;
  const cache = readLS(LS_SKIPS);
  const hit = cache[key];
  if (hit && Date.now() - hit.at < (hit.results.length ? 30 : 3) * 86400e3) return pick(hit.results, duration);

  const types = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'].map((t) => `types[]=${t}`).join('&');
  const res = await fetch(`${ANISKIP}/${idMal}/${episode}?${types}&episodeLength=${len}`);
  let results = [];
  if (res.ok) {
    const json = await res.json();
    results = (json.results || []).map((r) => ({ type: r.skipType, start: r.interval.startTime, end: r.interval.endTime, len: r.episodeLength }));
  } else if (res.status !== 404) {
    throw new Error(`AniSkip error ${res.status}`);
  }
  cache[key] = { at: Date.now(), results };
  const keys = Object.keys(cache);
  if (keys.length > 400) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 400).forEach((k) => delete cache[k]);
  writeLS(LS_SKIPS, cache);
  return pick(results, duration);
}

function pick(results, duration) {
  const best = {};
  for (const r of results) {
    const type = r.type.replace('mixed-', '');
    // Prefer the submission closest to our length; ignore ones from a clearly different cut.
    const diff = duration && r.len ? Math.abs(r.len - duration) : 0;
    if (diff > 120 || r.start >= duration) continue;
    const score = diff + (r.type.startsWith('mixed') ? 5 : 0);
    if (!best[type] || score < best[type].score) best[type] = { type, start: r.start, end: r.end, score };
  }
  return Object.values(best).map(({ type, start, end }) => ({ type, start, end })).sort((a, b) => a.start - b.start);
}
