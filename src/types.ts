/**
 * Shared contract between the Host half, the Client half and the model tools.
 *
 * Everything here is lossless JSON: no Host objects, functions, Buffers or live
 * Session values cross the wire. The Client half imports this module too, so it
 * must stay free of Node built-ins and of any Host-only import.
 *
 * The parameter tables are the single source of truth for what each Agnes model
 * actually accepts. They are transcribed from the live model documentation and
 * verified against the live API (see docs/DETAIL.md, "Verified model matrix"):
 * the dashboard renders its controls from these tables and the Host rejects an
 * unsupported combination before a request is sent, so the UI can never offer a
 * value the API would answer with HTTP 400.
 */

/** Model family: the two capabilities this plugin exposes. */
export type MediaKind = 'image' | 'video'

/** Output-resolution tier accepted by the image models. */
export const IMAGE_SIZES = ['1K', '2K', '3K', '4K'] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

/** Aspect ratios accepted by the image models. */
export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const
export type ImageRatio = (typeof IMAGE_RATIOS)[number]

/** Aspect ratios accepted by the video models. */
export const VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const
export type VideoRatio = (typeof VIDEO_RATIOS)[number]

/** Resolution tiers accepted by `agnes-video-2.5` (Flash is fixed to 720P). */
export const VIDEO_SIZES = ['720P', '1080P', '1K', '2K'] as const
export type VideoSize = (typeof VIDEO_SIZES)[number]

/** Video generation modes; each one accepts a different media set. */
export const VIDEO_MODES = ['text', 'keyframe', 'reference'] as const
export type VideoMode = (typeof VIDEO_MODES)[number]

/** Allowed output durations, in seconds (the API takes these as strings). */
export const VIDEO_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const
export type VideoSeconds = (typeof VIDEO_SECONDS)[number]

/** One model's declared capabilities, used by both halves. */
export interface ModelSpec {
  /** Exact model id sent to the API. */
  readonly id: string
  /** Which capability this model provides. */
  readonly kind: MediaKind
  /** Display name for the dashboard. */
  readonly label: string
  /** One-line capability summary shown as a hint. */
  readonly note: string
  /** Accepted resolution tiers. */
  readonly sizes: readonly string[]
  /** Accepted aspect ratios. */
  readonly ratios: readonly string[]
  /** Accepted generation modes; image models have none (always text/img2img). */
  readonly modes: readonly VideoMode[]
  /** Accepted durations in seconds; empty for image models. */
  readonly seconds: readonly number[]
  /** Maximum reference images accepted in one request. */
  readonly maxImages: number
  /** Whether a reference video is accepted. */
  readonly supportsVideoReference: boolean
  /** Whether reference audio is accepted. */
  readonly supportsAudioReference: boolean
}

/**
 * The shipped model matrix.
 *
 * Image: 2.0 / 2.1 / 2.5 Flash share one integration contract (tier `size` plus
 * `ratio`, or a legacy exact `WxH`); 2.5 is the strongest and the default.
 * Video: 2.5 accepts 720P/1080P/1K/2K with up to 8 images, 3 audios and one
 * reference video; 2.5 Flash is fixed to 720P with up to 5 images and 3 audios
 * and refuses reference videos. Verified against the live API on 2026-11-11.
 */
export const MODELS: readonly ModelSpec[] = [
  {
    id: 'agnes-image-2.5-flash',
    kind: 'image',
    label: 'Agnes Image 2.5 Flash',
    note: '最新一代图像模型：复杂构图、高信息密度细节，兼容 2.1 的全部参数。',
    sizes: IMAGE_SIZES,
    ratios: IMAGE_RATIOS,
    modes: [],
    seconds: [],
    maxImages: 8,
    supportsVideoReference: false,
    supportsAudioReference: false,
  },
  {
    id: 'agnes-image-2.1-flash',
    kind: 'image',
    label: 'Agnes Image 2.1 Flash',
    note: '上一代图像模型：语义对齐与多图合成稳定，参数与 2.5 一致。',
    sizes: IMAGE_SIZES,
    ratios: IMAGE_RATIOS,
    modes: [],
    seconds: [],
    maxImages: 8,
    supportsVideoReference: false,
    supportsAudioReference: false,
  },
  {
    id: 'agnes-image-2.0-flash',
    kind: 'image',
    label: 'Agnes Image 2.0 Flash',
    note: '快速图像模型：适合高频出图与快速试稿，参数与 2.1 一致。',
    sizes: IMAGE_SIZES,
    ratios: IMAGE_RATIOS,
    modes: [],
    seconds: [],
    maxImages: 8,
    supportsVideoReference: false,
    supportsAudioReference: false,
  },
  {
    id: 'agnes-video-2.5',
    kind: 'video',
    label: 'Agnes Video 2.5',
    note: '视频主力模型：720P/1080P/1K/2K，支持首尾帧、最多 8 张参考图与参考视频。',
    sizes: VIDEO_SIZES,
    ratios: VIDEO_RATIOS,
    modes: VIDEO_MODES,
    seconds: VIDEO_SECONDS,
    maxImages: 8,
    supportsVideoReference: true,
    supportsAudioReference: true,
  },
  {
    id: 'agnes-video-2.5-flash',
    kind: 'video',
    label: 'Agnes Video 2.5 Flash',
    note: '视频快速模型：固定 720P，最多 5 张参考图与 3 段音频，不支持参考视频。',
    sizes: ['720P'],
    ratios: VIDEO_RATIOS,
    modes: VIDEO_MODES,
    seconds: VIDEO_SECONDS,
    maxImages: 5,
    supportsVideoReference: false,
    supportsAudioReference: true,
  },
] as const

/** Models for one capability, in dashboard order. */
export function modelsFor(kind: MediaKind): readonly ModelSpec[] {
  return MODELS.filter((model) => model.kind === kind)
}

/** Look one model up by its exact id. */
export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((model) => model.id === id)
}

/** The default model for a capability (the first, i.e. the newest). */
export function defaultModelFor(kind: MediaKind): ModelSpec {
  const model = modelsFor(kind)[0]
  if (!model) throw new Error(`no model registered for ${kind}`)
  return model
}

/**
 * The image output dimensions for one tier/ratio pair.
 *
 * Mirrors the published dimension table; `undefined` for an unsupported pair.
 * The API may normalize a legacy exact size, so this is the expected size, not
 * a guarantee — the Host records the real dimensions from the downloaded bytes.
 */
export const IMAGE_DIMENSIONS: Readonly<Record<ImageRatio, Readonly<Record<ImageSize, readonly [number, number]>>>> = {
  '1:1': { '1K': [1024, 1024], '2K': [2048, 2048], '3K': [3072, 3072], '4K': [4096, 4096] },
  '3:4': { '1K': [864, 1152], '2K': [1728, 2304], '3K': [2592, 3456], '4K': [3456, 4608] },
  '4:3': { '1K': [1152, 864], '2K': [2304, 1728], '3K': [3456, 2592], '4K': [4608, 3456] },
  '16:9': { '1K': [1312, 736], '2K': [2624, 1472], '3K': [3936, 2208], '4K': [5248, 2944] },
  '9:16': { '1K': [736, 1312], '2K': [1472, 2624], '3K': [2208, 3936], '4K': [2944, 5248] },
  '2:3': { '1K': [832, 1248], '2K': [1664, 2496], '3K': [2496, 3744], '4K': [3328, 4992] },
  '3:2': { '1K': [1248, 832], '2K': [2496, 1664], '3K': [3744, 2496], '4K': [4992, 3328] },
  '21:9': { '1K': [1568, 672], '2K': [3136, 1344], '3K': [4704, 2016], '4K': [6272, 2688] },
}

/** The video output dimensions for one tier/ratio pair. */
export const VIDEO_DIMENSIONS: Readonly<Record<VideoRatio, Readonly<Record<VideoSize, readonly [number, number]>>>> = {
  '21:9': { '720P': [1470, 630], '1080P': [2206, 946], '1K': [1024, 438], '2K': [2940, 1260] },
  '16:9': { '720P': [1280, 720], '1080P': [1920, 1080], '1K': [1024, 576], '2K': [2560, 1440] },
  '4:3': { '720P': [1112, 834], '1080P': [1664, 1248], '1K': [1024, 768], '2K': [2224, 1668] },
  '1:1': { '720P': [960, 960], '1080P': [1440, 1440], '1K': [1024, 1024], '2K': [1920, 1920] },
  '3:4': { '720P': [834, 1112], '1080P': [1248, 1664], '1K': [768, 1024], '2K': [1668, 2224] },
  '9:16': { '720P': [720, 1280], '1080P': [1080, 1920], '1K': [576, 1024], '2K': [1440, 2560] },
}

/** Limits shared by both halves; the Host enforces them, the Client shows them. */
export const LIMITS = {
  /** Maximum prompt length in characters. */
  prompt: 4000,
  /** Maximum reference media items in one request. */
  references: 12,
  /** Image generation timeout (the docs recommend 60–360 s). */
  imageTimeoutMs: 360_000,
  /** Whole video task timeout: queue wait plus generation. */
  videoTimeoutMs: 900_000,
  /** Poll interval while a video task runs. */
  pollIntervalMs: 2000,
  /** Maximum downloaded media size in bytes. */
  maxMediaBytes: 64 * 1024 * 1024,
} as const

/** One reference image/video/audio the user attached. */
export interface MediaReference {
  /** Public URL or `data:` URI the API can read. */
  readonly url: string
  /** What the reference is; drives which request field it lands in. */
  readonly kind: 'image' | 'video' | 'audio'
}

/** An image-generation request as the dashboard and the tool both express it. */
export interface ImageRequest {
  readonly kind: 'image'
  readonly prompt: string
  /** Model id; must be an image model. */
  readonly model: string
  /** Resolution tier. */
  readonly size: ImageSize
  /** Aspect ratio. */
  readonly ratio: ImageRatio
  /** Optional reference images for image-to-image or multi-image composition. */
  readonly references: readonly MediaReference[]
}

/** A video-generation request. */
export interface VideoRequest {
  readonly kind: 'video'
  readonly prompt: string
  /** Model id; must be a video model. */
  readonly model: string
  /** Generation mode; selects which media fields are legal. */
  readonly mode: VideoMode
  /** Resolution tier; Flash accepts only 720P. */
  readonly size: VideoSize
  readonly ratio: VideoRatio
  /** Duration in seconds. */
  readonly seconds: VideoSeconds
  /** Optional seed for reproducibility. */
  readonly seed?: number
  /**
   * The first-frame image for `keyframe` mode.
   *
   * Named slots rather than positional entries in `references`: a request that
   * supplies ONLY a last frame would otherwise collapse to index 0 and be sent
   * as `first_frame`, silently starting the video on the wrong picture.
   */
  readonly firstFrame?: string
  /** The last-frame image for `keyframe` mode. */
  readonly lastFrame?: string
  /** References; `reference` mode uses these as style/content references. */
  readonly references: readonly MediaReference[]
}

/** Either request kind. */
export type GenerationRequest = ImageRequest | VideoRequest

/**
 * Lifecycle of one STORED generation.
 *
 * No `running` member: in-flight state is dashboard memory, and only settled
 * records are persisted, so a `running` value could never be written or read.
 */
export type GenerationStatus = 'succeeded' | 'failed'

/** One generated artifact, ready to render or download. */
export interface GenerationAsset {
  /** Host route path serving the bytes (authenticated, same-origin). */
  readonly src: string
  /** Media type of the stored bytes. */
  readonly mediaType: string
  /** Size in bytes. */
  readonly bytes: number
  /** Pixel dimensions when known (images always; videos when probed). */
  readonly width?: number
  readonly height?: number
}

/** One generation record: the request, its status and its result. */
export interface Generation {
  readonly id: string
  readonly kind: MediaKind
  readonly status: GenerationStatus
  /** The model id used. */
  readonly model: string
  /** The exact prompt submitted. */
  readonly prompt: string
  /** Parameters actually sent, for the detail view. */
  readonly params: Record<string, string | number | boolean | null>
  /** ISO timestamp of creation. */
  readonly createdAt: string
  /** ISO timestamp of the terminal state, when reached. */
  readonly finishedAt?: string
  /** Elapsed milliseconds until the terminal state. */
  readonly durationMs?: number
  /** The artifact when the generation succeeded. */
  readonly asset?: GenerationAsset
  /** Stable failure code when the generation failed. */
  readonly errorCode?: string
  /** User-facing failure message when the generation failed. */
  readonly error?: string
  /** True when the failure is worth retrying unchanged (queue full, 5xx). */
  readonly retryable?: boolean
  /** Upstream task id for video generations, useful when reporting a bug. */
  readonly upstreamId?: string
  /**
   * The exact request that produced this record.
   *
   * Kept so "retry" can resend what THIS card asked for. The `params` field is
   * a flattened summary for display and loses the reference URLs, so rebuilding
   * a request from it would silently drop an image reference or a keyframe.
   * Absent on records written before this field existed.
   */
  readonly request?: GenerationRequest
}

/** Where the API key came from, so the dashboard can explain configuration. */
export type KeySource = 'credential' | 'environment' | 'none'

/**
 * One generation currently running on the Host.
 *
 * The Host owns this, not the panel. A generation outlives the HTTP request that
 * started it (and the React tree that asked for it), so "is something running?"
 * cannot be panel state: leaving the studio and coming back used to lose it
 * entirely, showing an idle form while a video was still rendering.
 */
export interface RunningJob {
  /** The generation id this job will settle into. */
  readonly id: string
  readonly kind: MediaKind
  readonly prompt: string
  readonly model: string
  /** When the Host started the job. */
  readonly startedAt: string
  /** The record this job replaces on settle, when it is a retry. */
  readonly retryOf?: string
}

/** Host capabilities and configuration state the dashboard shows. */
export interface StudioState {
  /** Whether a usable API key is configured. */
  readonly configured: boolean
  /** Which source supplied the key. */
  readonly keySource: KeySource
  /** Base URL in use. */
  readonly baseUrl: string
  /** Model ids the upstream catalog reported, when the probe succeeded. */
  readonly upstreamModels: readonly string[]
  /** Whether the upstream model probe failed. */
  readonly upstreamModelsError?: string
  /** Stored generations, newest first. */
  readonly generations: readonly Generation[]
  /** Generations in flight right now, oldest first. */
  readonly running: readonly RunningJob[]
}

/** The Host RPC endpoint name shared by both halves. */
export const ENDPOINT = 'agnes-studio'

/**
 * The panel id shared by the sidebar entry and the `main` slot key.
 *
 * Both halves use one constant so the entry cannot select a panel key that the
 * page never registered, which would leave the centre column blank.
 */
export const PANEL_ID = 'skillre-agnes-studio'

/**
 * The exact Fetch route serving generated media bytes.
 *
 * The id rides in the QUERY STRING, not as a trailing path segment: Connection's
 * exact Fetch registry keys routes by `new URL(request.url).pathname`, so a
 * `/media/<id>` route can never match — the handler would be dead code and every
 * `<img src>` would 404. One pathname with `?id=` keeps the route exact while
 * still addressing any number of artifacts.
 */
export const MEDIA_PATH = `/api/${ENDPOINT}/media`

/** Build the media URL for one generation id. */
export function mediaPathFor(id: string): string {
  return `${MEDIA_PATH}?id=${encodeURIComponent(id)}`
}

/**
 * Extract the generation id from a media request, or undefined when malformed.
 *
 * Accepts the full URL or a bare search string; the store re-validates the id
 * shape, so this only has to reject an absent or empty value.
 */
export function mediaIdFrom(url: string): string | undefined {
  let search: string
  try {
    search = url.includes('?') ? new URL(url, 'http://localhost').search : url
  } catch {
    return undefined
  }
  const id = new URLSearchParams(search).get('id')
  return id === null || id === '' ? undefined : id
}

/** Every request the dashboard can send to the Host. */
export type StudioRequest =
  | { readonly action: 'state'; readonly probeModels?: boolean }
  | {
      /**
       * Start a generation in the BACKGROUND and answer immediately.
       *
       * The panel never awaits a generation: a video render takes minutes and the
       * user is expected to look elsewhere. The outcome is read back through
       * `state`, which is also what makes a job survive the panel unmounting.
       */
      readonly action: 'start'
      readonly request: GenerationRequest
      /** Id of the failed record being retried, when this starts a retry. */
      readonly retryOf?: string
    }
  | { readonly action: 'retry'; readonly id: string }
  | { readonly action: 'cancel'; readonly id: string }
  | { readonly action: 'optimize'; readonly prompt: string; readonly kind: MediaKind }
  | { readonly action: 'delete'; readonly id: string }
  | { readonly action: 'clear' }

/** The Host's answer to one request. */
export interface StudioResult {
  readonly state: StudioState
  /** The generation just produced, when the request created one. */
  readonly created?: Generation
  /** The rewritten prompt, when the request was a prompt optimization. */
  readonly prompt?: string
}
