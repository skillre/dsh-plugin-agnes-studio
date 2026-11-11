---
'@skillre/dsh-plugin-agnes-studio': minor
---

First working release of Agnes Studio.

- **Sidebar panel**: a generation dashboard with an image/video tab pair, a prompt field, model and
  parameter controls derived from the model capability table, a reference-URL list, an in-flight
  state, and a result gallery with per-record delete, clear-all, download and retry.
- **Session tools**: `agnes_image` and `agnes_video` register on the Host tool registry, so a Session
  can generate media directly. An image is committed to the DSH attachment store and rendered inline
  as a real image block; a video returns a same-origin URL.
- **Image models**: `agnes-image-2.5-flash` (default), `2.1-flash`, `2.0-flash` — tier `size` +
  `ratio`, up to 8 reference images, text-to-image / image-to-image / multi-image composition.
- **Video models**: `agnes-video-2.5` (default) and `agnes-video-2.5-flash` — async task create +
  poll, `text`/`keyframe`/`reference` modes, 4–12 s, 720P–2K (Flash is 720P only).
- **Key handling**: resolved per operation from the DSH credentials service, then `AGNES_API_KEY`;
  never written to configuration, logs, generation records or the browser.
- **Storage**: an atomic JSON index plus one file per artifact under the plugin's own data directory,
  with serialized index writes, a bounded history, and path-traversal refusal on every read.
- **Failure mapping**: upstream statuses map to stable codes, including the observed
  `video_queue_full` 503 as a retryable `queue-full`, and a bounded retry for the flaky media CDN.
- **Keyframe slots**: `firstFrame` / `lastFrame` are named request slots, so a last-frame-only
  request is sent as `last_frame` (a positional array used to send it as `first_frame`).
- **Reference guards**: references and frame URLs must be public HTTPS or `data:` URIs; IPv6
  literals, IPv4-mapped addresses, trailing-dot hostnames, userinfo and private ranges are refused.
- **Same-origin media**: the bearer token is attached only when the media URL's parsed origin
  matches `baseUrl`, so a prefixed host cannot receive the API key.
- **Range requests**: the media route answers a single `bytes=` range with 206, so a `<video>`
  can seek.

Verified by 129 offline tests including a test that loads and renders the SHIPPED client bundle through the real loader envelope,
and by installing the packed tarball into a disposable isolated DSH
`0.2.2-rc.1` profile: composed with `--dump-config`, bounded real startup, authenticated `/api` calls,
one real image generation downloaded through the media route, record and artifact surviving a restart,
and deletion removing both. Cleanup verified.
