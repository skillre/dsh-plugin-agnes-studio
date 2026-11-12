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

**A result can be continued, and the versions stack in one card.** A finished image card offers
"Continue editing": its prompt, model, resolution, aspect ratio and reference images come back into the
composer, and the picture itself is submitted as the next request's **reference image**
(image-to-image) — say what should change and what must stay in the prompt. A failed card offers
"Edit & retry": no retyping, the parameters return to the form for adjustment.

A new version does **not** open another card: it joins the original as another layer of the same card.
The badge reads "Version 2 of 3", the newest version sits on top, and the older ones peek out above it
showing **the edge of their own picture** rather than a grey decorative strip, so "there are other shots
of this" is visible at a glance. Three gestures, none of which fights the others:

- **Browse** — move the pointer up and down the picture to flip through versions. It is a preview only:
  nothing is written, and leaving the card returns to the current version. The switch is a pure
  crossfade — every version is already loaded and the card is always as tall as its tallest version —
  so browsing **never flashes, shifts or resizes** the card, and the thing under the pointer stays put.
- **Pin** — click one of the version numbers under the card to commit to that version (it survives the
  pointer leaving), and its view / download / continue-editing / delete actions all act on it. Click
  "1" to go back to following the newest version.
- **Expand** — splits the lineage into ordinary cards, each with its own actions; "Collapse" stacks
  them again.

What used to look like a row of unrelated cards now reads as one result that got better.

Finished videos are excluded: upstream has no endpoint that edits or extends an existing video, and its
"reference video" input needs a publicly reachable URL and only the paid `agnes-video-2.5` accepts it,
so a finished video card offers download and delete only. A failed video can still be edited and retried.

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
| `retryAttempts` | `5` | Total tries for "Keep retrying", counting the first; `1` disables the loop |
| `retryBaseDelayMs` | `15000` | Delay before the second try; doubles per try |
| `retryMaxDelayMs` | `180000` | Ceiling for that backoff |

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

## Background jobs and prompt optimization

- **Work runs on the Host, not in the panel.** A generation answers as soon as the job is registered;
  the task keeps running on the Host, so switching panels, navigating elsewhere, even reloading the
  whole page does not interrupt it. Coming back, a running job is read from the Host's
  `state.running` and shown again (progress bar and a cancel action); when it settles it becomes a
  result card. Previously the in-flight marker lived in the React tree, so the work continued but
  the panel showed nothing on return. A **new** generation takes a placeholder card in the gallery and
  a background banner above the form; a retry does not — see the next point.
- **Retry is a Host operation keyed by record id.** Clicking retry hands the record id to the Host,
  which re-runs **that record's own stored request** — it does not depend on anything the panel
  remembers, so retry keeps working after leaving, returning, or a full page reload (verified: a
  reload followed by retry still starts a job). A retry updates the row in place instead of adding
  one more failure per attempt. The progress is shown **inside that card itself** (spinner, "retrying;
  this record updates when it finishes", cancel) — no second "new task" card appears beside it waiting
  to merge, and the work is not repeated in the background banner.
- **Continuous retry: no endless clicking while the queue is full.** The free video queue answers
  "queue full" for minutes at a time, so a single manual retry usually hits the same wall. A retryable
  failed card therefore also offers "Keep retrying": the Host re-queues on its own backoff
  (15s → 30s → 60s → 120s → 180s, capped) for up to 5 attempts, and the card shows "Attempt 2 of 5"
  plus an "Auto-retrying in Ns" countdown. That wait lives on the **Host**, so closing the panel or
  reloading the page does not interrupt it. Only failures that can plausibly heal are retried (full
  queue, rate limit, 5xx, timeout, broken download); a bad parameter, an exhausted balance or a
  rejected key is reported after one try instead of burning the budget. The wait is cancellable, the
  final outcome writes exactly **one** record, and that record reports "N attempts". Tune it with
  `retryAttempts` / `retryBaseDelayMs` / `retryMaxDelayMs`; `retryAttempts: 1` turns the loop off and
  restores single-shot retry.
- **Continue editing and edit & retry.** "Continue editing" on a finished image fills the composer
  with that record's original request (prompt, model, resolution, ratio, references) and shows the
  source picture above the form. On submit the Host reads the stored bytes and inlines them as a
  `data:` URI reference, because the generated media is served behind same-origin authentication and
  upstream cannot fetch it — the browser only says which record to use. "Edit & retry" on a failed
  card restores the prompt and parameters only (a failed task produced no artifact), then re-runs as a
  new record. Neither action reuses the original record id: the original stays, the new record carries
  `derivedFrom` and the "From …" marker. If the source record is deleted before submitting, the Host
  refuses immediately with an explanation instead of leaving an unexplained failed card.
- **Prompt optimization.** The "Improve prompt" button in the prompt box calls Agnes' text model
  (`agnes-3.0-flash`) to make the draft more specific, with different advice for stills (composition,
  light, lens) and video (motion, camera movement, pacing), preserving your language and subject.
  The rewrite is reversible with "Undo"; editing the text accepts it.
- **Cancel.** A running job can be cancelled from the panel and leaves no failure record behind.

## Known limitations

- Video is an **async** task: the Host polls upstream until it finishes. When the queue is full the
  API answers HTTP 503 `video_queue_full`; the panel says in as many words that this is an upstream
  concurrency limit rather than a problem with the request, and marks it retryable. Measured: this
  state can persist for several minutes — it is upstream queueing, not a plugin fault.
- References must be **publicly reachable** HTTPS URLs or `data:` URIs. localhost, private networks
  and plain HTTP are refused before the request is sent — upstream fetches the media itself, so such
  an address would only fail late.
- When the account balance cannot cover a task, upstream returns 403 `insufficient_user_quota`; the
  plugin reports it as an exhausted balance and says the key itself is valid, rather than blaming the
  key. The paid `agnes-video-2.5` consumes quota; `agnes-video-2.5-flash` is free but shares a queue.
- **A finished video cannot be continued**: upstream only offers text-to-video, keyframes and reference
  material — no editing, extension or remix of an existing video. The only "reference video" input
  needs a publicly reachable URL and only the paid `agnes-video-2.5` accepts it, while this plugin
  stores results locally behind the same-origin route and has no channel to make them public. A
  finished video therefore offers download and delete; a failed video can still be edited and retried.
- "Continue editing" inlines the stored picture as a `data:` URI reference, so the source never needs
  a public URL; the cost is a request body that grows with the source resolution (about 2 MiB at 1K,
  20 MiB+ at 4K). Upstream may reject an oversized request, which surfaces as an ordinary failure
  that can be retried at a lower resolution tier.
- `agnes-video-2.5-flash` accepts no reference video and at most 5 reference images (`2.5` takes 8).
- Generations are **local** and do not sync across machines; records past `historyLimit` are deleted.
- The panel runs one task at a time, so a double submit cannot double the cost or deepen the queue.
  The form stays disabled while a background job runs; cancel it from the panel to end it.
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

- 201 offline tests: parameter validation, response parsing, error mapping, storage concurrency and
  eviction, route fencing, media-path shape, schema conformance, tool argument mapping, panel rendering
  (including a retry turning its own card into the progress card with no placeholder added; a finished
  image filling the composer and submitting as a symbolic reference; a failed record restored for
  adjustment; a finished video offering no continuation), the **version stack** (lineage collapsing
  into one card, a single record growing no stack chrome, scrubbing down the picture switching versions
  and snapping back on leave, a version change adding/removing/reordering NO node at all (the
  structural guarantee against the old flicker), pinning a version from the rail and having it survive
  the pointer leaving, the card's actions acting on the shown version, the peeking layers never
  repeating the version already on the face of the stack, the newest and oldest versions staying
  reachable across every version-count × picture-height combination, expanding into standalone cards and
  collapsing again, an orphaned continuation surviving its deleted source), **continuous retry** (only self-healing failures are
  retried, the budget ending in ONE record that reports its attempt count, single-shot behaviour without
  the flag, the wait publishing its next attempt time, and the wire fence accepting `retryAll`),
  image-viewer interaction, the background-job lifecycle (state reporting a running job, a background
  failure landing as a record, cancel leaving no record, dispose aborting every job, prompt
  optimization), and the SHIPPED client bundle (loaded and rendered through the real loader envelope).
- Packed tarball installed into a disposable isolated profile: `--dump-config` composition, bounded
  real startup, authenticated `/api` calls, a real image generation downloaded through the media
  route, records and files surviving a restart, and the file disappearing after deletion.
- Real headless Chrome driving the DSH Web app — 41 checks (the two retry, three continue-editing and
  five version-stack checks need a real API key; without one they are skipped and reported as such): sidebar entry, panel render, the
  two-pane layout (measured: both panes side by side, the composer not spanning the panel), the
  model-derived controls **and their shape** (four resolutions are a segmented control, eight ratios
  are chips), Flash narrowing the resolution list, the generate button reachable without scrolling,
  the gallery card with its uniform 4:3 thumbnail crop, the category filter actually changing the
  results, both themes following the host (measured surface and text colours), the image viewer
  (spans the viewport, zoom changes the measured layout, closes on Escape and on a backdrop click,
  does not close when the picture is clicked, steps through the gallery with the arrow keys and resets
  the zoom per picture, and returns focus to the control that opened it), the prompt optimizer being
  in place, no phantom in-flight UI while idle, and a **retry rendering in place** (the failed record's
  own card becomes the progress card, zero placeholder cards, no duplicated background banner, the
  card count unchanged, and the same record settling in its original slot), and **continue editing**
  (the prompt restored, the source thumbnail shown, the card count unchanged, the submit button
  reading "Generate edit"; submitting really runs a `data:` URI image-to-image generation, adds one
  card, marks the new card with its lineage, and the store keeps the symbolic reference and
  `derivedFrom`), and the **version stack** (a continuation settling into its source's stack rather than
  adding a sibling — card count unchanged, one stack, one peeking layer, two version numbers, a badge
  reporting two versions and lineage on the top card; then a REAL mouse sweeps the picture through 7
  positions and the card's and the picture's `getBoundingClientRect` must be identical at every one
  (the machine-checkable form of "it flashed and shook", which jsdom cannot measure) while the sweep
  must genuinely reach version 2; leaving restoring the newest; clicking version "2" pinning the older
  version with the badge and rail following, surviving the pointer leaving, the card height unchanged,
  and "1" returning to follow the newest; the stack re-rendered in the OTHER theme with its sliver
  still painting a picture rather than turning transparent — the earlier theme screenshot predates any
  stack, so this is the only place the dark stack is ever looked at; a deep SIX-version lineage is then
  seeded and the page reloaded, requiring all six rail numbers to render with none clipped out of the
  rail's box, the peek budget to stay capped at two, the badge to report six versions, the rail to reach
  the oldest version, and a real scrub across the six-version picture to keep the card's measured box
  identical; Expand turning it into two standalone cards and Collapse restoring the stack). Evidence is
  in `docs/evidence/`.
- Real-key end-to-end runs (not in CI): submit an image, leave the panel, come back while it is still
  rendering and see it running, then watch it settle into a result card; the same running job is still
  shown as running after a **full page reload**, then settles into a result card; submit a video that
  fails, reload the whole page, click retry on the failed record, and see a real job start with the
  card count unchanged; click retry on a failed record and see the progress only inside that card
  (no extra "new task" card), then the same record turn into the generated result in its original
  slot — verified after a full page reload as well; click continue editing on a finished image, watch
  the composer fill in with its source, submit, and see upstream accept the inlined picture as a
  reference while the original card stays and the new card carries its lineage.

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
