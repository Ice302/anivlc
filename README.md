# AniVLC

A dedicated anime video player that runs in the browser, installs as an app, and works offline.
It has no build step and no dependencies to install. It's plain HTML/CSS/JS, with hls.js and dash.js vendored in `vendor/`.

## Run it

```powershell
# Windows: double-click start.bat, or:
python -m http.server 8765
# then open http://localhost:8765
```

Any static file server works (`npx serve`, nginx, GitHub Pages, Netlify…). Offline mode and installing need
`http://localhost` or HTTPS, because service workers don't run from `file://`.

After the first visit, the app loads with no connection. In Chrome or Edge, click **Install** in the top bar to get
a standalone window, and the app then shows up in "Open with" for video and subtitle files.

## Features

### Upload

- Use the **Upload** button, or drag and drop anywhere. Pick a whole season at once and it gets sorted by episode number.
- Subtitles dropped alongside videos are matched by file name (`Show - 01.mkv` ↔ `Show - 01.en.ass`), then by episode number.
- `.m3u` playlists and AniVLC `.json` backups can be dropped too, and they're imported as stream entries.
- Uploaded files play from memory and are never sent anywhere. Choose **Save offline** from an episode's ⋮ menu to keep
  it in the browser's storage (IndexedDB) across restarts.

### Servers

- **Add stream** creates an entry with any number of mirrors: MP4, WebM, HLS (`.m3u8`) or DASH (`.mpd`).
- **Whole series** mode adds a range of episodes at once from URL patterns. `{ep}` becomes the episode number, and
  `{ep2}`/`{ep3}` give zero-padded numbers, so `https://media.example.com/show/{ep2}.m3u8` with episodes 1–12 creates 12 entries.
  Each mirror and the subtitle URL can have its own pattern.
- Switch servers from the chips under the player, the ⚙ menu (also works in fullscreen), or the `S` key. Playback keeps its position.
- If a server errors or doesn't respond within 20 seconds, the player switches to the next one and marks the dead one red.
- AniVLC remembers which server last worked for each show and starts there next time (matched by server name).
- HLS and DASH streams get a quality picker (Auto / 1080p / 720p…). If an HLS host blocks the cross-origin requests hls.js needs,
  the player falls back to the browser's own HLS support where available.
- Any entry, including a local file, can get extra mirrors with **+ Add**.
- **Settings → Offline library → Export / Import** backs up every stream entry to JSON (or loads an `.m3u`).

### Anime info and skipping

- **Link anime** (under the player) searches [AniList](https://anilist.co) for the show. The link applies to every episode of that
  series, including local files, and adds cover art, the AniList title, format/year/episode count and lock-screen artwork.
- Once linked, intro, outro and recap times come from [AniSkip](https://aniskip.com), a community database. They're marked on
  the seek bar, and a **Skip intro / Skip outro / Skip recap** button appears at the right moment. An outro that runs to the end
  becomes **Next episode**.
- Turn on **Settings → Auto-skip** to skip them without clicking.
- Only the show title (to AniList) and the MyAnimeList ID, episode number and length (to AniSkip) leave your device.
  Results are cached, so skipping keeps working offline.
- Without a link, **Skip intro** jumps ahead by a fixed length (80–100s, configurable).

### Subtitle sync

- Supports SRT, WebVTT and ASS/SSA (italics, bold, `\an8` top positioning, and layered fansub lines are de-duplicated).
- Text encoding is detected automatically (UTF-8, UTF-16, Windows-1252).
- Shift timing with `G` / `H` (±0.1s), `Shift+G` / `Shift+H` (±1s), or the buttons in the Subtitles tab.
- **Sync to line:** open the Subtitles tab, wait for a line to be spoken, and press **Sync** next to it. The offset is set in one click.
- Offsets and track choices are remembered per episode. Set a preferred language and choose between full dialogue
  and "Signs & Songs" tracks for when there's more than one.
- Size, background, position, color, outline and font (sans, rounded, serif, typewriter) can all be adjusted.

### Player

- Hover previews on the seek bar, resume where you left off, an autoplay-next countdown, speed control,
  picture-in-picture, theater mode, screenshots, double-tap to seek on phones, and a configurable seek step (5/10/15/30s).
- Media keys and the lock-screen controls work through the Media Session API.

## Where to get streams

AniVLC plays whatever you point it at: your own files, a home media server, or any direct MP4/HLS/DASH link you're
allowed to use. It doesn't scrape or bundle third-party streaming sites. Good legitimate sources:

- **Your own collection** (rips of discs you own), uploaded or served from a NAS. Run `python -m http.server` in the folder,
  or use Jellyfin/Plex direct-play URLs, and add them with **Whole series** mode.
- **Free, licensed anime** is available on Crunchyroll's free tier, Tubi, Pluto TV, RetroCrush and the official YouTube channels
  of Muse Asia and Ani-One Asia. Those play in their own players, not as raw links.
- **Public-domain and Creative Commons video** on the Internet Archive often has direct MP4 links that work here.

## Keyboard

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `Space` / `K` | Play / pause | `C` | Subtitles on/off |
| `J` / `L` | Back / forward (seek step) | `V` | Cycle subtitle tracks |
| `←` / `→` | −5s / +5s | `G` / `H` | Subs 0.1s earlier / later |
| `↑` / `↓` | Volume | `Shift+G` / `Shift+H` | Subs 1s earlier / later |
| `0`–`9` | Jump to 0–90% | `S` | Next server |
| `,` / `.` | Frame step (paused) | `N` / `B` | Next / previous episode |
| `O` | Skip intro / outro / recap | `[` / `]` | Slower / faster |
| `F` | Fullscreen | `T` | Theater mode |
| `I` | Picture-in-picture | `X` | Screenshot |
| `M` | Mute | `?` | Shortcut sheet |

## Share links

`?src=<url>&src=<mirror>&title=<title>&sub=<subtitle url>` opens a stream directly. The ⋮ menu → **Copy share link**
builds one. Only `http(s)` URLs are accepted.

## Limitations

- **Codecs depend on the browser.** MKV with H.264 + AAC/Opus plays in Chrome and Edge. HEVC/x265 needs hardware
  support (Edge and Safari usually work, Chrome only on some systems), and AC3/DTS audio often doesn't play at all. The player
  says so when a file can't be decoded.
- **Subtitles embedded inside MKV files aren't read.** Browsers don't expose them, so load the `.ass`/`.srt` separately.
- **ASS typesetting is simplified.** Signs, karaoke effects and custom fonts render as plain styled text.
- **Remote URLs need CORS.** Stream and subtitle URLs only load if the host allows cross-origin requests
  (except native HLS, where the browser supports it). Screenshots of remote streams need it too.
- **Skip times depend on AniSkip coverage.** Popular shows are well covered and obscure ones may have nothing yet.

## Files

```text
index.html            app shell and markup
css/styles.css        all styling (accent colour and subtitle look are CSS variables)
js/app.js             UI, queue, keyboard, gestures, uploads, dialogs, skipping
js/source.js          loads servers into <video> (direct, HLS via hls.js, DASH via dash.js), timeouts, failure events
js/subtitles.js       SRT/VTT/ASS parsers, encoding detection, overlay renderer with sync offset
js/anime.js           AniList search, AniSkip skip times, series-name matching
js/playlist.js        JSON backup / M3U import, export, {ep} URL patterns
js/storage.js         IndexedDB library + localStorage prefs, progress, subtitle offsets, preferred servers
sw.js                 service worker (network-first, falls back to cache offline)
vendor/hls.min.js     hls.js 1.6.15
vendor/dash.all.min.js dash.js 4.7.4 (loaded only for .mpd servers)
```
