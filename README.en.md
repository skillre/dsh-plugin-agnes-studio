# @skillre/dsh-plugin-agnes-studio

> Status: experimental · verified on DSH `0.2.2-rc.1` (2026-11-11)

Generate images and video with Agnes' free models, from two entry points:

- **Sidebar panel**: click "Agnes Studio" in the DSH left sidebar. The composer sits on the left
  (prompt, model, resolution, aspect ratio) and the result gallery on the right; each pane scrolls on
  its own, and the generate button is pinned to the foot of the composer so it is always one click
  away. Small mutually-exclusive sets (resolution, video mode) render as a segmented control; larger
  sets (aspect ratios, durations) as chips that draw their own proportions. "View full size" on a
  result — or a click on the thumbnail — opens an in-panel viewer: scroll to zoom, drag to pan,
  double-click to zoom, Escape or a backdrop click to close, and arrow keys to step through the
  gallery. The panel never opens a popup or leaves the app.
- **Session tools**: just say "draw a …" or "generate a … video". The model calls `agnes_image` /
  `agnes_video`, and an image arrives in the conversation as a real DSH image block.

[中文](README.md)

## What it does

| Capability | Models | Parameters |
|---|---|---|
| Text-to-image, image-to-image, multi-image composition | `agnes-image-2.5-flash` (default), `2.1-flash`, `2.0-flash` | Resolution tiers `1K`/`2K`/`3K`/`4K`, 8 aspect ratios, up to 8 reference images |
| Text-to-video, keyframes, references | `agnes-video-2.5` (default), `agnes-video-2.5-flash` | 720P–2K (Flash is 720P only), 6 aspect ratios, 4–12 seconds, optional seed, first/last frame, image/audio/video references |

Parameters are not free-form: the panel's options come from the model capability table, and the Host
validates against the same table before sending. Pick `agnes-video-2.5-flash` and the resolution list
collapses to 720P, because that model accepts nothing else upstream — so the UI can never offer a
value the API would reject with HTTP 400.

## Install

**The user** installs from the DSH Desktop Client or Web UI **Plugins** manager. Once published, enter
the npm package name (e.g. `@skillre/dsh-plugin-agnes-studio@0.1.0`); before publication an absolute
path to a built `.tgz` works if the target client accepts that source.

After installing, check **Plugins → this plugin → configuration** that `enableTools` is on (the
default), and the sidebar entry appears.

### Configure the API key

The plugin **never writes the key into its configuration**. It resolves the key per operation, so a
rotated key takes effect without a restart:

1. the DSH credentials record named `AGNES_API_KEY` (recommended);
2. the environment variable `AGNES_API_KEY`;
3. neither → the panel says "No API key configured yet" and disables generation, and the session
   tools return `not-configured`.

Create a free key at <https://platform.agnes-ai.com> (no card required). The key is used on the Host
only: it is never sent to the browser and never written into a generation record.

## Configuration

All keys are optional and override the row's `config`:

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://apihub.agnes-ai.com/v1` | Agnes API root, no trailing slash |
| `credentialRef` | `AGNES_API_KEY` | Credential record name |
| `apiKeyEnv` | `AGNES_API_KEY` | Environment fallback when the credential is empty |
| `dataDir` | `''` → `$DSH_HOME/agnes-studio` | Generation index and media directory (owned by this plugin) |
| `enableTools` | `true` | Register the `agnes_image` / `agnes_video` tools |
| `historyLimit` | `200` | How many generations to keep; oldest are evicted with their files |
| `imageTimeoutMs` | `360000` | Image timeout (upstream recommends 60–360 s) |
| `videoTimeoutMs` | `900000` | Whole video task timeout, including queue wait |
| `pollIntervalMs` | `2000` | Video poll interval |

`dataDir` follows `$DSH_HOME` on purpose: a hard-coded `~/.dsh` would escape an isolated profile and
write into the user's real installation.

## Permissions and side effects

- **Network**: only `baseUrl` (default `apihub.agnes-ai.com`) and the media URLs it returns. A
  third-party CDN download does **not** carry the API key.
- **Files**: only `dataDir` — one `index.json` plus files under `media/`. File names are random
  UUIDs, and reads re-check the id shape, so path traversal is unreachable.
- **Secrets**: read from the credential service or the environment only; never logged, never stored
  in a generation record, never sent to the browser.
- **Browser**: the panel talks through DSH Connection's `/api` route, behind the same Host/Origin and
  session-auth fence; generated media is served through that same fence, not world-readable.

## Data and cleanup

Generations live in `$DSH_HOME/agnes-studio` (normally `~/.dsh/agnes-studio`):

```sh
# remove every generation and file (same as the panel's "Clear all")
rm -rf ~/.dsh/agnes-studio
```

Deleting one record or clearing all in the panel removes both the index entry and the file on disk.

## Uninstall and rollback

See [UNINSTALL](UNINSTALL.md). Uninstalling does not delete `$DSH_HOME/agnes-studio`; remove it with
the command above if you no longer want the files.

## Known limitations

- Video is an **async** task: the Host polls upstream until it finishes. When the queue is full the
  API answers HTTP 503 `video_queue_full`; the panel marks it retryable rather than reporting a
  parameter error.
- References must be **publicly reachable** HTTPS URLs or `data:` URIs. localhost, private networks
  and plain HTTP are refused before the request is sent — upstream fetches the media itself, so such
  an address would only fail late.
- `agnes-video-2.5-flash` accepts no reference video and at most 5 reference images (`2.5` takes 8).
- Generations are **local** and do not sync across machines; records past `historyLimit` are deleted.
- The panel runs one task at a time, so a double submit cannot double the cost or deepen the queue.
- The image viewer zooms **inside the panel** and never opens the system image viewer or a new
  window: generated media is stored locally behind session authentication, so handing it to an
  external program would both answer 401 and bypass DSH's window policy.
- One `dataDir` belongs to one plugin instance: index writes are serialized per handle, so two
  instances pointed at the same directory can still overwrite each other.
- Images enter the conversation as DSH attachments; a video returns a same-origin URL and the
  conversation names where to open it, rather than rendering a video block.
- Agnes' free quota, model list and parameter ceilings change upstream. This plugin implements the
  contract verified on 2026-11-11; new upstream capabilities need a plugin update.

## Verification

- 145 offline tests: parameter validation, response parsing, error mapping, storage concurrency and
  eviction, route fencing, media-path shape, schema conformance, tool argument mapping, panel rendering,
  image-viewer interaction, and the SHIPPED client bundle (loaded and rendered through the real loader
  envelope).
- Packed tarball installed into a disposable isolated profile: `--dump-config` composition, bounded
  real startup, authenticated `/api` calls, a real image generation downloaded through the media
  route, records and files surviving a restart, and the file disappearing after deletion.
- Real headless Chrome driving the DSH Web app — 29 checks: sidebar entry, panel render, the
  two-pane layout (measured: both panes side by side, the composer not spanning the panel), the
  model-derived controls **and their shape** (four resolutions are a segmented control, eight ratios
  are chips), Flash narrowing the resolution list, the generate button reachable without scrolling,
  the gallery card with its uniform 4:3 thumbnail crop, the category filter actually changing the
  results, both themes following the host (measured surface and text colours), and the image viewer
  (spans the viewport, zoom changes the measured layout, closes on Escape and on a backdrop click,
  does not close when the picture is clicked, steps through the gallery with the arrow keys and resets
  the zoom per picture, and returns focus to the control that opened it). Evidence is in
  `docs/evidence/`.

## Development

```sh
npm install
npm run check     # preview + typecheck + tests + publint + pack
npm pack
```

Isolated verification (**only an owned, disposable, non-Desktop profile**):

```sh
AGNES_API_KEY=... node scripts/verify-isolated.mjs ./skillre-dsh-plugin-agnes-studio-0.1.0.tgz
```

The script creates its own temporary DSH home, installs, starts, verifies, and in `finally` stops the
process, removes the directory and confirms cleanup.

## Bundle

- npm: `@skillre/dsh-plugin-agnes-studio`
- GitHub: `skillre/dsh-plugin-agnes-studio`
- Cordis row / plugin name: `skillre-agnes-studio`
- `package.json#dsh.bundle.patch` → `cordis.patch.yml`

## Display metadata

`locale/en.json` and `locale/zh.json` carry the card title and description; `icon.svg` is the icon.
All three ship in the package (`files` covers them, `exports` declares `"./locale/*.json"`).
