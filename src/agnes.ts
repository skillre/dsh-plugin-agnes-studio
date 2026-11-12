/**
 * The Agnes API client: image generation, asynchronous video generation and the
 * model catalog.
 *
 * Every request is built from the {@link MODELS} capability table rather than
 * from free-form parameters, so an unsupported combination is refused here with
 * a precise message instead of being sent and rejected with HTTP 400. The two
 * APIs have different shapes and this module is the only place that knows it:
 *
 * - Images are synchronous: `POST /v1/images/generations` answers with
 *   `data[0].url` (or `data[0].b64_json`), and the response can take tens of
 *   seconds, so the timeout is minutes rather than seconds.
 * - Videos are asynchronous: `POST /v1/videos` returns a `video_id` and the task
 *   is polled through `GET /agnesapi?video_id=…&model_name=…` until it reports
 *   `completed` or `failed`. The `model_name` query is mandatory for `keyframe`
 *   and `reference` modes, so it is always sent.
 *
 * The client never caches the API key and never logs it.
 */

import {
  findModel,
  IMAGE_RATIOS,
  IMAGE_SIZES,
  LIMITS,
  VIDEO_MODES,
  VIDEO_RATIOS,
  VIDEO_SECONDS,
  VIDEO_SIZES,
  type GenerationRequest,
  type ImageRequest,
  type ImageRatio,
  type ImageSize,
  type MediaKind,
  type MediaReference,
  type MediaReferenceKind,
  type ModelSpec,
  type VideoMode,
  type VideoRatio,
  type VideoRequest,
  type VideoSeconds,
  type VideoSize,
} from './types.js'
import { isStoredReference } from './types.js'
import { StudioError, fromUpstreamStatus } from './errors.js'

/** Injected HTTP callable, so tests can substitute a fake transport. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** What one successful image generation produced. */
export interface ImageOutcome {
  /** Raw image bytes. */
  readonly bytes: Uint8Array
  /** Media type derived from the bytes. */
  readonly mediaType: string
  /** Upstream task id when the API reported one. */
  readonly upstreamId?: string
}

/** The terminal state of one video task. */
export interface VideoOutcome {
  /** Raw video bytes. */
  readonly bytes: Uint8Array
  /** Media type of the bytes. */
  readonly mediaType: string
  /** The upstream task id. */
  readonly upstreamId: string
}

/** One prompt-optimization request. */
export interface OptimizePromptRequest {
  /** The user's own prompt, already trimmed. */
  readonly prompt: string
  /** Which capability the prompt is for; image and video want different advice. */
  readonly kind: MediaKind
}

/** Per-call options shared by both capabilities. */
export interface CallOptions {
  readonly signal?: AbortSignal | undefined
}

/** The client surface the store and tools use. */
export interface AgnesClient {
  generateImage(request: ImageRequest, options?: CallOptions): Promise<ImageOutcome>
  generateVideo(request: VideoRequest, options?: CallOptions): Promise<VideoOutcome>
  /** Probe the upstream model catalog; never throws. */
  listModels(options?: CallOptions): Promise<{ models: readonly string[]; error?: string }>
  /** Rewrite a prompt with the chat model; throws on an unusable answer. */
  optimizePrompt(request: OptimizePromptRequest, options?: CallOptions): Promise<string>
}

/** Dependencies the client needs; all are plain values so tests stay offline. */
export interface ClientDeps {
  readonly baseUrl: string
  /** Resolves the key per operation; throws when unconfigured. */
  readonly resolveKey: () => Promise<string>
  readonly fetchImpl?: FetchLike
  readonly imageTimeoutMs: number
  readonly videoTimeoutMs: number
  readonly pollIntervalMs: number
  readonly maxMediaBytes: number
  /** Sleep helper; injectable so poll tests need no real timers. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Default sleep that honours cancellation. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new StudioError('cancelled', '请求已取消。'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new StudioError('cancelled', '请求已取消。'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Combine the caller signal with a per-operation timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Read a response body with a hard byte ceiling. */
async function readBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new StudioError('too-large', `生成结果超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限，已拒绝下载。`)
  }
  const buffer = new Uint8Array(await response.arrayBuffer())
  signal?.throwIfAborted()
  if (buffer.byteLength > maxBytes) {
    throw new StudioError('too-large', `生成结果超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限，已拒绝下载。`)
  }
  return buffer
}

/** Identify an image from its magic bytes; the API does not always say. */
export function sniffMediaType(bytes: Uint8Array): string {
  const at = (offset: number, signature: readonly number[]): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  // ISO base media file format (MP4/MOV): `....ftyp` at byte 4.
  if (at(4, [0x66, 0x74, 0x79, 0x70])) return 'video/mp4'
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  return 'application/octet-stream'
}

/**
 * Whether a media URL is served by the configured API origin.
 *
 * Parsed origins, not string prefixes: a prefix test treats
 * `https://api.example.com.evil.test/x.png` and `https://api.example.com@evil.test/x.png`
 * as "same origin" and hands the bearer token to a host the operator never
 * configured. An unparseable URL is never same-origin.
 */
export function isSameOrigin(candidate: string, baseUrl: string): boolean {
  try {
    const target = new URL(candidate)
    const base = new URL(baseUrl)
    if (target.origin !== base.origin) return false
    // A hostile URL can also smuggle userinfo into an otherwise matching origin.
    return target.username === '' && target.password === ''
  } catch {
    return false
  }
}

/** True when the media type is a video the dashboard can play. */
export function isVideoMediaType(mediaType: string): boolean {
  return mediaType === 'video/mp4' || mediaType === 'video/webm'
}

/** True when the media type is an image the dashboard can render inline. */
export function isImageMediaType(mediaType: string): boolean {
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/gif' || mediaType === 'image/webp'
}

/**
 * Normalize a URL hostname for the private-address check.
 *
 * `new URL().hostname` keeps an IPv6 literal's brackets (`"[::1]"`) and a
 * trailing dot on a DNS name (`"localhost."`), so a naive comparison against
 * `"::1"` or `"localhost"` silently passes both. This strips the brackets, folds
 * the case and drops trailing dots so the checks below see the real host.
 */
export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
}

/** Whether an IPv4 dotted-quad is loopback, private, link-local or unspecified. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * Whether an IPv6 literal is loopback, unique-local, link-local or an
 * IPv4-mapped address that unwraps to a private IPv4.
 *
 * The mapped form matters: `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]`,
 * which is loopback in disguise and reaches the same place.
 */
function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true
  // Unique-local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
  // IPv4-mapped ::ffff:x.x.x.x and its compressed hexadecimal form.
  const mapped = lower.match(/^::ffff:(.+)$/)
  if (mapped !== null) {
    const rest = mapped[1] ?? ''
    if (rest.includes('.')) return isPrivateIpv4(rest)
    const hex = rest.split(':')
    if (hex.length === 2) {
      const high = Number.parseInt(hex[0] ?? '', 16)
      const low = Number.parseInt(hex[1] ?? '', 16)
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateIpv4(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`)
      }
    }
    return true
  }
  return false
}

/**
 * Require a reference URL the Agnes service can actually fetch.
 *
 * The upstream fetches references itself, so a loopback, private-network or
 * plain-HTTP URL is unusable: it would fail late, after queueing and possibly
 * after billing. Refusing it here keeps the failure immediate and explainable,
 * and keeps this plugin from being a channel that feeds internal addresses to a
 * third party. A reference that names a stored generation instead of a URL is
 * skipped: the runtime resolves it to a `data:` URI from bytes it already owns.
 */
export function assertPublicReference(reference: MediaReference): void {
  const url = reference.url
  if (url === undefined) return
  if (/^data:/i.test(url)) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new StudioError('invalid-reference', `参考素材地址无法解析：${url.slice(0, 120)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new StudioError('invalid-reference', '参考素材必须是公网 HTTPS 地址或 data: URI。')
  }
  // A URL with credentials is never a legitimate public reference, and userinfo
  // is what lets a hostile URL look like the API host while resolving elsewhere.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new StudioError('invalid-reference', '参考素材地址不能包含用户名或密码。')
  }
  const host = normalizeHostname(parsed.hostname)
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new StudioError('invalid-reference', '参考素材必须是公网可访问地址，不能是 localhost 或内网地址。')
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new StudioError('invalid-reference', '参考素材必须是公网可访问地址，不能是 localhost 或内网地址。')
  }
}

/**
 * Require exactly one usable locator on a reference before any request is sent.
 *
 * `url` and `generationId` are alternatives, not a pair: sending both would let
 * one silently win, and sending neither would reach the API as an empty image.
 * A stored reference is only legal for images, because the Host inlines image
 * bytes as a `data:` URI and has no public address to give the upstream for an
 * audio or video file.
 */
export function assertReferenceLocator(reference: MediaReference): void {
  const hasUrl = typeof reference.url === 'string' && reference.url !== ''
  const hasStored = isStoredReference(reference) && typeof reference.generationId === 'string' && reference.generationId !== ''
  if (hasUrl === hasStored) {
    throw new StudioError('invalid-reference', '参考素材必须且只能指定一个地址或一条已保存的生成记录。')
  }
  if (hasStored && reference.kind !== 'image') {
    throw new StudioError('invalid-reference', '只有已保存的图片可以作为参考素材，音频与视频请用公网地址。')
  }
  assertPublicReference(reference)
}

/** Validate one request against the model table before any network call. */
export function validateRequest(request: GenerationRequest): ModelSpec {
  const model = findModel(request.model)
  if (!model) throw new StudioError('invalid-model', `未知的 Agnes 模型：${request.model}`)
  if (model.kind !== request.kind) {
    throw new StudioError('invalid-model', `${model.id} 是${model.kind === 'image' ? '图片' : '视频'}模型，不能用于${request.kind === 'image' ? '生图' : '生视频'}。`)
  }
  if (request.prompt.trim() === '') throw new StudioError('bad-request', '提示词不能为空。')
  if (request.prompt.length > LIMITS.prompt) {
    throw new StudioError('bad-request', `提示词超过 ${LIMITS.prompt} 字符上限。`)
  }
  if (request.kind === 'image') {
    if (!IMAGE_SIZES.includes(request.size)) throw new StudioError('invalid-parameter', `${model.id} 不支持尺寸 ${request.size}。`)
    if (!IMAGE_RATIOS.includes(request.ratio)) throw new StudioError('invalid-parameter', `${model.id} 不支持比例 ${request.ratio}。`)
    const images = request.references.filter((reference) => reference.kind === 'image')
    if (images.length > model.maxImages) {
      throw new StudioError('invalid-reference', `${model.id} 最多接受 ${model.maxImages} 张参考图，收到 ${images.length} 张。`)
    }
    if (request.references.length > images.length) {
      throw new StudioError('invalid-reference', '生图只接受图片作为参考，不接受音频或视频。')
    }
    for (const reference of request.references) assertReferenceLocator(reference)
    return model
  }
  if (!model.modes.includes(request.mode)) {
    throw new StudioError('invalid-parameter', `${model.id} 不支持 ${request.mode} 模式。`)
  }
  if (!model.sizes.includes(request.size)) {
    throw new StudioError('invalid-parameter', `${model.id} 的分辨率只支持 ${model.sizes.join(' / ')}。`)
  }
  if (!VIDEO_RATIOS.includes(request.ratio)) throw new StudioError('invalid-parameter', `${model.id} 不支持比例 ${request.ratio}。`)
  if (!model.seconds.includes(request.seconds)) {
    throw new StudioError('invalid-parameter', `${model.id} 的时长只支持 ${model.seconds.join('/')} 秒。`)
  }
  if (request.seed !== undefined && (!Number.isInteger(request.seed) || request.seed < 0)) {
    throw new StudioError('invalid-parameter', '随机种子必须是非负整数。')
  }
  const images = request.references.filter((reference) => reference.kind === 'image')
  const videos = request.references.filter((reference) => reference.kind === 'video')
  const audios = request.references.filter((reference) => reference.kind === 'audio')
  if (request.references.length > LIMITS.references) {
    throw new StudioError('invalid-reference', `参考素材最多 ${LIMITS.references} 个。`)
  }
  for (const reference of request.references) {
    assertReferenceLocator(reference)
  }
  // Mode rules: each mode accepts a disjoint media set, and the API answers 400
  // when a disallowed field is present — so the check has to be this strict.
  if (request.mode === 'text' && request.references.length > 0) {
    throw new StudioError('invalid-reference', 'text 模式不接受任何参考素材；请改用 keyframe 或 reference 模式。')
  }
  if (request.mode === 'keyframe') {
    // Frames come from the named slots; a stray reference here means the caller
    // put frames in the wrong field, which would silently become a first frame.
    if (request.references.length > 0) {
      throw new StudioError('invalid-reference', 'keyframe 模式请用 firstFrame / lastFrame 传首尾帧，不要放进 references。')
    }
    if (request.firstFrame === undefined && request.lastFrame === undefined) {
      throw new StudioError('invalid-reference', 'keyframe 模式至少需要一张首帧或尾帧图片。')
    }
    // Frame URLs are fetched by the upstream just like references, so they need
    // the same public-HTTPS check; otherwise a loopback address reaches Agnes.
    for (const frame of [request.firstFrame, request.lastFrame]) {
      if (frame === undefined) continue
      assertPublicReference({ url: frame, kind: 'image' })
    }
  }
  if (request.mode === 'reference') {
    if (images.length + audios.length + videos.length === 0) {
      throw new StudioError('invalid-reference', 'reference 模式至少需要一个参考素材。')
    }
    if (images.length > model.maxImages) {
      throw new StudioError('invalid-reference', `${model.id} 最多接受 ${model.maxImages} 张参考图，收到 ${images.length} 张。`)
    }
    if (audios.length > 3) throw new StudioError('invalid-reference', 'reference 模式最多接受 3 段参考音频。')
    if (videos.length > 1) throw new StudioError('invalid-reference', 'reference 模式最多接受 1 段参考视频。')
    if (videos.length > 0 && !model.supportsVideoReference) {
      throw new StudioError('invalid-reference', `${model.id} 不支持参考视频；请改用 agnes-video-2.5。`)
    }
    if (audios.length > 0 && !model.supportsAudioReference) {
      throw new StudioError('invalid-reference', `${model.id} 不支持参考音频。`)
    }
  }
  return model
}

/** Build the `data:` URI a stored artifact is inlined as. */
export function dataUriFor(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Collect the URLs of one reference kind.
 *
 * A stored reference is resolved by the runtime into a `data:` URI BEFORE the
 * client is called; seeing one here means the request would go out with an
 * empty image, so it is refused with a precise message instead.
 */
function referenceUrls(references: readonly MediaReference[], kind: MediaReferenceKind): string[] {
  return references
    .filter((reference) => reference.kind === kind)
    .map((reference) => {
      if (typeof reference.url !== 'string' || reference.url === '') {
        throw new StudioError('invalid-reference', '参考素材还没有被解析成地址，无法发送请求。')
      }
      return reference.url
    })
}

/** Build the JSON body for an image request. */
export function buildImageBody(request: ImageRequest): Record<string, unknown> {
  const images = referenceUrls(request.references, 'image')
  const extra: Record<string, unknown> = { response_format: 'url' }
  // Image-to-image passes references inside `extra_body`; the top-level `image`
  // field is accepted by some gateways but the documented contract is nested.
  if (images.length > 0) extra['image'] = images
  return { model: request.model, prompt: request.prompt, size: request.size, ratio: request.ratio, extra_body: extra }
}

/** Build the JSON body for a video request, honouring the mode's media set. */
export function buildVideoBody(request: VideoRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    mode: request.mode,
    size: request.size,
    aspect_ratio: request.ratio,
    seconds: String(request.seconds),
    n: 1,
  }
  if (request.seed !== undefined) body['seed'] = request.seed
  const images = referenceUrls(request.references, 'image')
  const audios = referenceUrls(request.references, 'audio')
  const videos = referenceUrls(request.references, 'video')
  if (request.mode === 'keyframe') {
    // Read the named slots directly: positional destructuring of a filtered array
    // sent a lone last frame as `first_frame`.
    if (request.firstFrame !== undefined) body['first_frame'] = request.firstFrame
    if (request.lastFrame !== undefined) body['last_frame'] = request.lastFrame
  }
  if (request.mode === 'reference') {
    if (images.length > 0) body['images'] = images
    if (audios.length > 0) body['audios'] = audios
    if (videos.length > 0) body['videos'] = videos.map((url) => ({ url, start_seconds: 0, require_audio: false }))
  }
  return body
}

/** The fields one poll answer carries, already narrowed to what is used. */
interface VideoPollBody {
  readonly status: string
  readonly progress?: unknown
  readonly url?: string
  readonly video_id?: string
  readonly error?: unknown
}

/** Extract a human message from a failed task's `error` field. */
function taskError(body: VideoPollBody): string {
  const error = body.error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string' && message.trim() !== '') return message.trim().slice(0, 300)
  }
  if (typeof error === 'string' && error.trim() !== '') return error.trim().slice(0, 300)
  return '视频生成失败。'
}

/** Create the client bound to one resolved configuration. */
export function createClient(deps: ClientDeps): AgnesClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const sleep = deps.sleep ?? defaultSleep

  /** One authenticated JSON request; returns the parsed body and raw text. */
  const postJson = async (path: string, body: unknown, timeoutMs: number, options: CallOptions): Promise<{ status: number; text: string }> => {
    const key = await deps.resolveKey()
    const signal = withTimeout(options.signal, timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${deps.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw transportError(error, options.signal)
    }
    const text = await response.text()
    if (!response.ok) throw fromUpstreamStatus(response.status, text)
    return { status: response.status, text }
  }

  /** One authenticated GET; returns the raw text. */
  const getText = async (url: string, timeoutMs: number, options: CallOptions): Promise<string> => {
    const key = await deps.resolveKey()
    const signal = withTimeout(options.signal, timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${key}` }, signal })
    } catch (error) {
      throw transportError(error, options.signal)
    }
    const text = await response.text()
    if (!response.ok) throw fromUpstreamStatus(response.status, text)
    return text
  }

  /**
   * Download generated media; a public URL needs no key, a same-origin one does.
   *
   * The upstream media CDN is measurably flaky: in repeated live runs the
   * transfer aborted mid-body with `UND_ERR_SOCKET` / "other side closed" in
   * roughly a third of attempts. Generation already succeeded at that point, so
   * failing the whole request would throw away a paid-for image. A GET is
   * idempotent, so the download is retried a bounded number of times with a
   * short backoff before the failure is reported.
   */
  const download = async (url: string, timeoutMs: number, options: CallOptions): Promise<Uint8Array> => {
    const attempts = 3
    let lastError: StudioError | undefined
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(400 * attempt, options.signal)
      const signal = withTimeout(options.signal, timeoutMs)
      // Compare parsed ORIGINS, never string prefixes: `startsWith(baseUrl)` sends
      // the API key to `https://<host>.evil.example/...` and, for a path-less
      // baseUrl, to `https://<host>@evil.example/...` — the key would leave the
      // building. Only a same-origin artifact legitimately needs the bearer.
      const sameOrigin = isSameOrigin(url, deps.baseUrl)
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          ...(sameOrigin ? { headers: { authorization: `Bearer ${await deps.resolveKey()}` } } : {}),
          signal,
        })
      } catch (error) {
        lastError = transportError(error, options.signal)
        // A cancellation is the caller's decision, not a flaky transfer.
        if (lastError.code === 'cancelled') throw lastError
        continue
      }
      if (!response.ok) {
        lastError = new StudioError('download-failed', `下载生成结果失败（HTTP ${response.status}）。`, {}, response.status >= 500)
        if (response.status < 500) throw lastError
        continue
      }
      try {
        return await readBounded(response, deps.maxMediaBytes, signal)
      } catch (error) {
        // A truncated body is the flaky case worth retrying; a size refusal is not.
        if (error instanceof StudioError && error.code === 'too-large') throw error
        lastError = error instanceof StudioError ? error : new StudioError('download-failed', '下载生成结果时连接中断。', {}, true)
        if (lastError.code === 'cancelled') throw lastError
        continue
      }
    }
    throw lastError ?? new StudioError('download-failed', '下载生成结果失败。', {}, true)
  }

  return {
    async generateImage(request, options = {}) {
      validateRequest(request)
      const { text } = await postJson('/images/generations', buildImageBody(request), deps.imageTimeoutMs, options)
      const parsed = parseImageResponse(text)
      const bytes = parsed.b64 !== undefined
        ? decodeBase64(parsed.b64)
        : await download(parsed.url ?? '', deps.imageTimeoutMs, options)
      const mediaType = sniffMediaType(bytes)
      if (!isImageMediaType(mediaType)) {
        throw new StudioError('upstream-failed', 'Agnes 返回的内容不是可识别的图片格式。')
      }
      return {
        bytes,
        mediaType,
        ...(parsed.taskId === undefined ? {} : { upstreamId: parsed.taskId }),
      }
    },

    async generateVideo(request, options = {}) {
      validateRequest(request)
      const { text } = await postJson('/videos', buildVideoBody(request), 120_000, options)
      const created = parseCreateResponse(text)
      const deadline = Date.now() + deps.videoTimeoutMs
      let lastStatus = 'queued'
      // Poll until terminal. The documented cadence is 1–2 s and `status` plus
      // `url` are the source of truth; `internal_status` is deliberately ignored.
      for (;;) {
        if (Date.now() > deadline) {
          throw new StudioError(
            'timeout',
            `视频任务等待超时（已等待 ${Math.round(deps.videoTimeoutMs / 1000)} 秒，最后状态 ${lastStatus}）。任务可能仍在生成，可稍后重试。`,
            { videoId: created.videoId },
            true,
          )
        }
        await sleep(deps.pollIntervalMs, options.signal)
        const pollUrl = `${originOf(deps.baseUrl)}/agnesapi?video_id=${encodeURIComponent(created.videoId)}&model_name=${encodeURIComponent(request.model)}`
        const pollText = await getText(pollUrl, 60_000, options)
        const poll = parsePollResponse(pollText)
        lastStatus = poll.status
        if (poll.status === 'failed') {
          throw new StudioError('upstream-failed', taskError(poll), { videoId: created.videoId })
        }
        if (poll.status === 'completed') {
          if (poll.url === undefined || poll.url === '') {
            throw new StudioError('upstream-failed', '视频任务已完成，但没有返回可下载地址。', { videoId: created.videoId })
          }
          const bytes = await download(poll.url, deps.videoTimeoutMs, options)
          const mediaType = sniffMediaType(bytes)
          // A 200 with an HTML error page would otherwise be stored as a
          // successful video and render as a broken <video>.
          if (!isVideoMediaType(mediaType)) {
            throw new StudioError('upstream-failed', 'Agnes 返回的内容不是可识别的视频格式。', { videoId: created.videoId })
          }
          return { bytes, mediaType, upstreamId: created.videoId }
        }
      }
    },

    async listModels(options = {}) {
      try {
        const text = await getText(`${deps.baseUrl}/models`, 30_000, options)
        const parsed: unknown = JSON.parse(text)
        const data = (parsed as Record<string, unknown> | null)?.['data']
        if (!Array.isArray(data)) return { models: [], error: '上游模型目录格式无法识别。' }
        const models = data
          .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['id'] : undefined))
          .filter((id): id is string => typeof id === 'string')
        return { models }
      } catch (error) {
        const failure = error instanceof StudioError ? error : undefined
        return { models: [], error: failure?.message ?? '无法读取上游模型目录。' }
      }
    },

    async optimizePrompt(request, options = {}) {
      // The chat model is a different capability from the image/video models, but
      // it is the same key and the same base URL, so it needs no extra config.
      const body = buildOptimizeBody(request)
      const { text } = await postJson('/chat/completions', body, OPTIMIZE_TIMEOUT_MS, options)
      const prompt = parseOptimizeResponse(text)
      if (prompt === '') throw new StudioError('upstream-failed', 'Agnes 没有返回可用的优化结果，请稍后重试。')
      // The optimized prompt must still fit the prompt field it replaces.
      return prompt.length > LIMITS.prompt ? prompt.slice(0, LIMITS.prompt) : prompt
    },
  }
}

/** Model used for prompt rewriting; a text model, not an image one. */
export const OPTIMIZE_MODEL = 'agnes-3.0-flash'

/** How long a prompt rewrite may take. */
const OPTIMIZE_TIMEOUT_MS = 60_000

/**
 * Build the chat-completions body for one prompt rewrite.
 *
 * The system instruction is deliberately narrow: it asks for a rewrite of the
 * user's intent, never a new idea, and forbids the commentary the panel would
 * otherwise paste into the prompt field. Image and video get different advice
 * because the two models respond to different things — a video prompt needs
 * motion and camera language, a still needs composition and light.
 */
export function buildOptimizeBody(request: OptimizePromptRequest): Record<string, unknown> {
  const craft =
    request.kind === 'video'
      ? 'You rewrite prompts for a text-to-video model. Add concrete subject motion, camera movement (push in, pan, orbit), pacing and lighting. Keep it to one flowing paragraph.'
      : 'You rewrite prompts for a text-to-image model. Add concrete subject detail, composition, lighting, lens/medium and style. Keep it to one flowing paragraph.'
  return {
    model: OPTIMIZE_MODEL,
    messages: [
      {
        role: 'system',
        content: `${craft} Rewrite the user's prompt in the SAME language they wrote it in. Preserve their subject and intent exactly; never invent a different scene. Return ONLY the rewritten prompt text: no quotes, no preface, no explanation.`,
      },
      { role: 'user', content: request.prompt },
    ],
    temperature: 0.7,
    max_tokens: 600,
  }
}

/** Pull the assistant text out of a chat-completions answer. */
export function parseOptimizeResponse(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new StudioError('upstream-failed', 'Agnes 返回了无法解析的优化响应。')
  }
  const choices = (parsed as Record<string, unknown> | null)?.['choices']
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new StudioError('upstream-failed', 'Agnes 的优化响应里没有结果。')
  }
  const message = (choices[0] as Record<string, unknown> | null)?.['message']
  const content = (message as Record<string, unknown> | null)?.['content']
  if (typeof content !== 'string') throw new StudioError('upstream-failed', 'Agnes 的优化响应里没有文本。')
  // Trim the wrapping quotes a model sometimes adds, plus any leading label like
  // "优化后的提示词：", which would otherwise end up inside the user's prompt.
  return content.replace(/^\s*(?:优化后的?提示词|优化后|prompt)\s*[:：]\s*/i, '').replace(/^["'“”「」]\s*|\s*["'“”「」]$/g, '').trim()
}

/** The API root without the version suffix, for the non-`/v1` poll endpoint. */
export function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '')
}

/** Translate a transport failure, keeping cancellation distinct from a fault. */
function transportError(error: unknown, callerSignal: AbortSignal | undefined): StudioError {
  if (callerSignal?.aborted === true) return new StudioError('cancelled', '请求已取消。')
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') return new StudioError('timeout', 'Agnes 请求超时，请稍后重试或降低分辨率。', {}, true)
  if (name === 'AbortError') return new StudioError('cancelled', '请求已取消。')
  const message = error instanceof Error ? error.message : String(error)
  return new StudioError('upstream-failed', `无法连接 Agnes 服务：${message.slice(0, 200)}`, {}, true)
}

/** Decode canonical base64 into bytes. */
export function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '')
  if (normalized === '') throw new StudioError('upstream-failed', 'Agnes 返回了空的图片数据。')
  return new Uint8Array(Buffer.from(normalized, 'base64'))
}

/** What an image response carried. */
interface ImageResponse {
  readonly url?: string
  readonly b64?: string
  readonly taskId?: string
}

/** Read an image response, preferring Base64 over a URL when both appear. */
export function parseImageResponse(text: string): ImageResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new StudioError('upstream-failed', 'Agnes 返回了无法解析的图片响应。')
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  const data = record['data']
  const first = Array.isArray(data) && data.length > 0 ? (data[0] as Record<string, unknown>) : undefined
  const taskId = typeof record['task_id'] === 'string' ? record['task_id'] : undefined
  if (first === undefined) {
    throw new StudioError('upstream-failed', 'Agnes 没有返回任何图片。')
  }
  const b64 = typeof first['b64_json'] === 'string' && first['b64_json'] !== '' ? first['b64_json'] : undefined
  const url = typeof first['url'] === 'string' && first['url'] !== '' ? first['url'] : undefined
  if (b64 === undefined && url === undefined) {
    throw new StudioError('upstream-failed', 'Agnes 没有返回图片地址或图片数据。')
  }
  return { ...(url === undefined ? {} : { url }), ...(b64 === undefined ? {} : { b64 }), ...(taskId === undefined ? {} : { taskId }) }
}

/** The created video task's id. */
export interface CreatedVideo {
  readonly videoId: string
}

/** Read a create-task response, requiring a usable `video_id`. */
export function parseCreateResponse(text: string): CreatedVideo {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new StudioError('upstream-failed', 'Agnes 返回了无法解析的视频响应。')
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  const videoId = record['video_id']
  if (typeof videoId === 'string' && videoId !== '') return { videoId }
  // `id` names the same task; accept it so a gateway that omits `video_id`
  // still works, but prefer the documented field above.
  const id = record['id']
  if (typeof id === 'string' && id !== '') return { videoId: id }
  throw new StudioError('upstream-failed', 'Agnes 没有返回视频任务 id。')
}

/** Read one poll response. */
export function parsePollResponse(text: string): VideoPollBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new StudioError('upstream-failed', 'Agnes 返回了无法解析的视频状态。')
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  const status = typeof record['status'] === 'string' ? record['status'] : 'unknown'
  const url = typeof record['url'] === 'string' ? record['url'] : undefined
  const videoId = typeof record['video_id'] === 'string' ? record['video_id'] : undefined
  return {
    status,
    progress: record['progress'],
    ...(url === undefined ? {} : { url }),
    ...(videoId === undefined ? {} : { video_id: videoId }),
    error: record['error'],
  }
}

/** Re-export the media reference type for callers that only import this module. */
export type { MediaReference, ImageRatio, ImageSize, VideoMode, VideoRatio, VideoSeconds, VideoSize }
