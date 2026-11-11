/**
 * The Agnes Studio panel: a generation form on top, the result gallery below.
 *
 * State rules: the Host owns the generations and the configuration; this page
 * holds only view state (which capability tab, the form draft, the in-flight
 * flag, the error line, the gallery filter). Every generation is a Host call and
 * the returned state replaces the local one, so two windows on the same panel
 * converge instead of fighting over local copies.
 *
 * Three decisions worth knowing:
 * 1. **The parameter controls are derived from the model table, not hard-coded.**
 *    Picking the Flash video model narrows the resolution list to 720P, because
 *    the table says so and the Host would refuse anything else. The UI can
 *    therefore never offer a value the API rejects.
 * 2. **The submit is disabled while a request runs.** Image generation takes
 *    tens of seconds and video takes minutes; a double submit would silently
 *    double the cost and the queue depth.
 * 3. **A failure is shown in place with its retry affordance.** The Host marks a
 *    queue-full or a timeout as retryable, so the panel offers "retry" instead of
 *    making the user retype the prompt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { ClientApi } from './api.js'
import { ActionError } from './api.js'
import type { ClientLocaleLike, SidebarEntryProps } from './contracts.js'
import { StudioStyles } from './styles.js'
import type { Translate } from './text.js'
import {
  IMAGE_DIMENSIONS as IMAGE_DIMENSIONS_REF,
  IMAGE_RATIOS,
  IMAGE_SIZES,
  LIMITS,
  VIDEO_DIMENSIONS as VIDEO_DIMENSIONS_REF,
  VIDEO_RATIOS,
  VIDEO_SECONDS,
  modelsFor,
  type Generation,
  type GenerationAsset,
  type GenerationRequest,
  type ImageRatio,
  type ImageSize,
  type MediaKind,
  type MediaReference,
  type StudioState,
  type VideoMode,
  type VideoRatio,
  type VideoSeconds,
  type VideoSize,
} from '../types.js'

/** Keys this file translates; mirrored in `text.ts`. */
// nav, title, subtitle, tab.image, tab.video, config.title, config.body,
// config.source.credential, config.source.environment, config.source.none,
// config.models, form.prompt, form.promptPlaceholder, form.model, form.size,
// form.ratio, form.mode, form.seconds, form.seed, form.seedPlaceholder,
// form.references, form.referencePlaceholder, form.addReference,
// form.removeReference, form.firstFrame, form.lastFrame, form.submitImage,
// form.submitVideo, form.needPrompt, form.needKeyframe, form.needReference,
// mode.text, mode.keyframe, mode.reference, status.generatingImage,
// status.generatingVideo, status.failed, gallery.title, gallery.count,
// gallery.empty, gallery.emptyFiltered, gallery.all, gallery.images,
// gallery.videos, gallery.delete, gallery.clear, gallery.confirmClear,
// gallery.confirmDelete, gallery.retry, gallery.download, gallery.open,
// gallery.viewer, gallery.close, gallery.zoomIn, gallery.zoomOut,
// gallery.resetZoom, gallery.hint,
// gallery.took, gallery.loading, gallery.loadFailed, error.retryable,
// error.not-configured, error.queue-full, error.timeout, error.unauthorized,
// error.rate-limited, error.cancelled, error.unknown, action.dismiss,
// action.refresh, action.cancel, action.confirm, hint.dimensions, hint.videoSlow,
// hint.key

/** Props the `main` slot passes through; the page owns its own data. */
export interface StudioPageProps {
  api: ClientApi
  locale: ClientLocaleLike
  t: Translate
}

/** Which capability tab is open. */
type Tab = MediaKind
/** Which records the gallery shows. */
type Filter = 'all' | 'image' | 'video'

/** The in-flight generation, kept so the panel can describe it while it runs. */
interface Busy {
  readonly kind: MediaKind
}

/** The image form draft. */
interface ImageDraft {
  prompt: string
  model: string
  size: ImageSize
  ratio: ImageRatio
  references: string[]
}

/** The video form draft. */
interface VideoDraft {
  prompt: string
  model: string
  mode: VideoMode
  size: VideoSize
  ratio: VideoRatio
  seconds: VideoSeconds
  seed: string
  firstFrame: string
  lastFrame: string
  references: string[]
}

/** The default image draft: the newest model at a square 1K canvas. */
function initialImageDraft(): ImageDraft {
  const model = modelsFor('image')[0]
  return {
    prompt: '',
    model: model?.id ?? '',
    size: '1K',
    ratio: '1:1',
    references: [],
  }
}

/** The default video draft: the full model, text mode, 720P, 5 seconds. */
function initialVideoDraft(): VideoDraft {
  const model = modelsFor('video')[0]
  return {
    prompt: '',
    model: model?.id ?? '',
    mode: 'text',
    size: (model?.sizes[0] as VideoSize | undefined) ?? '720P',
    ratio: '16:9',
    seconds: 5,
    seed: '',
    firstFrame: '',
    lastFrame: '',
    references: [],
  }
}

/** The sidebar entry icon: a frame with a spark and film perforations. */
export function SidebarGlyph({ size = 'md' }: SidebarEntryProps): JSX.Element {
  const dimension = size === 'sm' ? 18 : 20
  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4.5" width="18" height="13" rx="2.5" />
      <path d="M4.5 14.5 L9 10 L12 13 L14.5 10.5 L19.5 14.5" />
      <circle cx="15.5" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <path d="M7 20.5 h2 M11 20.5 h2 M15 20.5 h2" />
    </svg>
  )
}

/** Read one message for a Host failure code, falling back to the raw message. */
function messageFor(t: Translate, error: unknown): string {
  if (error instanceof ActionError) {
    const key = `error.${error.code.replace('agnes-studio/', '')}`
    const translated = t(key)
    // `t` returns the key itself when the dictionary lacks it; the Host message
    // is then more useful than a bare key.
    return translated === key ? error.message : translated
  }
  if (error instanceof Error) return error.message
  return t('error.unknown')
}

/** Whether a failure should offer a retry. */
function isRetryable(error: unknown): boolean {
  if (error instanceof ActionError) return error.retryable || error.code.endsWith('queue-full') || error.code.endsWith('timeout')
  return false
}

/**
 * Ask for confirmation, tolerating a non-browser render (tests, SSR).
 *
 * A missing `window` must not crash the panel: the destructive action simply
 * proceeds unconfirmed, which is what a headless environment can express.
 */
function confirmInBrowser(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
  return window.confirm(message)
}

/** The file extension for a download name, derived from the stored media type. */
function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'video/mp4':
      return '.mp4'
    case 'video/webm':
      return '.webm'
    default:
      return ''
  }
}

/** Format a duration as a short seconds string. */
function formatSeconds(durationMs: number | undefined): string {
  if (durationMs === undefined) return ''
  return (durationMs / 1000).toFixed(1)
}

/** A human summary of the parameters actually sent. */
function paramSummary(generation: Generation): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(generation.params)) {
    // `seed=0` is a legitimate value, so only empty and null are skipped.
    if (key === 'model' || value === null || value === '') continue
    parts.push(`${key}=${String(value)}`)
  }
  return parts.join(' · ')
}

/** Resolve the expected pixel dimensions for a draft, when the table knows them. */
function expectedDimensions(kind: MediaKind, size: string, ratio: string): string | undefined {
  const table = kind === 'image' ? IMAGE_DIMENSIONS_REF : VIDEO_DIMENSIONS_REF
  const row = table[ratio as keyof typeof table] as Record<string, readonly [number, number]> | undefined
  const pair = row?.[size]
  return pair === undefined ? undefined : `${pair[0]}×${pair[1]}`
}

/** One select control with a label. */
function Field(props: {
  label: string
  value: string
  options: readonly { readonly value: string; readonly label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="agnes__label">
      {props.label}
      <select
        className="agnes__field"
        value={props.value}
        disabled={props.disabled === true}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The editable reference-URL list shared by both forms. */
function ReferenceList(props: {
  t: Translate
  urls: string[]
  disabled: boolean
  onChange: (urls: string[]) => void
}): JSX.Element {
  const { t, urls, disabled, onChange } = props
  return (
    <div className="agnes__refs">
      <span className="agnes__label">
        {t('form.references')}
        {urls.map((url, index) => (
          <span className="agnes__refRow" key={index}>
            <input
              className="agnes__field"
              type="url"
              value={url}
              disabled={disabled}
              placeholder={t('form.referencePlaceholder')}
              onChange={(event) => {
                const next = [...urls]
                next[index] = event.target.value
                onChange(next)
              }}
            />
            <button
              type="button"
              className="agnes__button agnes__button--ghost"
              disabled={disabled}
              onClick={() => onChange(urls.filter((_entry, position) => position !== index))}
            >
              {t('form.removeReference')}
            </button>
          </span>
        ))}
      </span>
      <button
        type="button"
        className="agnes__button"
        disabled={disabled || urls.length >= 8}
        onClick={() => onChange([...urls, ''])}
      >
        {t('form.addReference')}
      </button>
    </div>
  )
}

/** Lowest zoom: the picture fits the stage. */
const VIEWER_MIN_ZOOM = 1
/** Highest zoom: far enough in to read one pixel of a 4K render. */
const VIEWER_MAX_ZOOM = 8
/** The zoom a click on the picture jumps to, and back from. */
const VIEWER_CLICK_ZOOM = 2
/** One wheel notch or one button press multiplies the zoom by this. */
const VIEWER_ZOOM_STEP = 1.25
/** Pointer travel, in px, before a press counts as a pan instead of a click. */
const VIEWER_DRAG_THRESHOLD = 3

/** Zoom plus pan, as the picture's transform expresses it. */
interface ViewerTransform {
  readonly zoom: number
  readonly x: number
  readonly y: number
}

/** The resting transform: fitted, centred. */
const VIEWER_IDENTITY: ViewerTransform = { zoom: VIEWER_MIN_ZOOM, x: 0, y: 0 }

/** Keep a zoom inside the declared range, tolerating a NaN from a bad event. */
function clampViewerZoom(value: number): number {
  if (!Number.isFinite(value)) return VIEWER_MIN_ZOOM
  return Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, value))
}

/** A 16px stroke icon for the viewer controls; inherits the button's color. */
function ViewerIcon({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * The in-panel image viewer.
 *
 * Why this exists instead of a new-window link: the stored media URL is a
 * same-origin, session-authenticated path. The Desktop shell denies every popup
 * the page requests, so `target="_blank"` did nothing at all, and opening the URL
 * in an external browser would answer 401 anyway. The panel therefore owns the
 * zoom itself and never leaves the window.
 *
 * It renders in the component tree under a `position: fixed` overlay rather than
 * through a portal: the browser bundle's module envelope can only resolve
 * `react`, so importing `react-dom` would break module loading.
 */
function ImageViewer(props: {
  t: Translate
  generation: Generation
  asset: GenerationAsset
  onClose: () => void
}): JSX.Element {
  const { t, generation, asset, onClose } = props
  const [view, setView] = useState<ViewerTransform>(VIEWER_IDENTITY)
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  /** The committed transform, so the native wheel listener never reads a stale value. */
  const latest = useRef<ViewerTransform>(VIEWER_IDENTITY)
  latest.current = view
  /** The live pan; a ref because a pointer move must not re-render per frame. */
  const pan = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  /** Set when a pan ended, so its trailing click does not toggle the zoom. */
  const suppressClick = useRef(false)

  // Land focus inside the dialog, on the safe action.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  // Escape closes from anywhere in the panel, not only while the stage has
  // focus. The listener is removed on unmount, so closing leaves no global trace.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  /**
   * Scale about one screen point.
   *
   * `translate(x, y) scale(z)` scales about the picture's own centre, so a plain
   * zoom drifts the detail the user aimed at off screen. Keeping the point under
   * the cursor fixed needs the element's UNTRANSFORMED centre, and
   * `getBoundingClientRect()` already includes the translate — so the base centre
   * is the current rect centre minus the current pan.
   */
  const zoomAt = useCallback((nextZoom: number, clientX: number, clientY: number): void => {
    const target = clampViewerZoom(nextZoom)
    const current = latest.current
    const node = imageRef.current
    if (target <= VIEWER_MIN_ZOOM || node === null) {
      // Returning to 1x always recentres: a picture left off-centre at fit zoom
      // reads as a bug, not as a remembered position.
      setView(VIEWER_IDENTITY)
      return
    }
    const rect = node.getBoundingClientRect()
    const baseX = rect.left + rect.width / 2 - current.x
    const baseY = rect.top + rect.height / 2 - current.y
    const ux = clientX - baseX
    const uy = clientY - baseY
    const ratio = target / current.zoom
    setView({
      zoom: target,
      x: ux - ratio * (ux - current.x),
      y: uy - ratio * (uy - current.y),
    })
  }, [])

  /** Zoom about the middle of the stage, for the button controls. */
  const zoomFromButton = useCallback(
    (factor: number): void => {
      const node = stageRef.current
      if (node === null) {
        zoomAt(latest.current.zoom * factor, 0, 0)
        return
      }
      const rect = node.getBoundingClientRect()
      zoomAt(latest.current.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
    },
    [zoomAt],
  )

  // Wheel zoom is bound natively and non-passively: React's synthetic wheel
  // listener is passive at the root, so `preventDefault()` there is ignored and
  // the panel behind the overlay would scroll while the user zooms.
  useEffect(() => {
    const node = stageRef.current
    if (node === null || typeof node.addEventListener !== 'function') return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? VIEWER_ZOOM_STEP : 1 / VIEWER_ZOOM_STEP
      zoomAt(latest.current.zoom * factor, event.clientX, event.clientY)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      node.removeEventListener('wheel', onWheel)
    }
  }, [zoomAt])

  const endPan = (): void => {
    suppressClick.current = pan.current?.moved === true
    pan.current = null
    setDragging(false)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (latest.current.zoom <= VIEWER_MIN_ZOOM) return
    // A synthetic pointer event can arrive without usable coordinates (jsdom has
    // no PointerEvent, and an assistive tool may omit them). Starting a pan from
    // an undefined origin would write `translate(NaNpx, NaNpx)` and blank the
    // picture, so such an event simply does not begin a pan.
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: latest.current.x,
      originY: latest.current.y,
      moved: false,
    }
    setDragging(true)
    // Capture keeps the pan alive when the pointer leaves the picture. A DOM
    // without pointer capture (jsdom) simply keeps the element handlers.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const live = pan.current
    if (live === null || live.pointerId !== event.pointerId) return
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    const dx = event.clientX - live.startX
    const dy = event.clientY - live.startY
    if (!live.moved && Math.abs(dx) + Math.abs(dy) < VIEWER_DRAG_THRESHOLD) return
    live.moved = true
    setView((previous) => ({ ...previous, x: live.originX + dx, y: live.originY + dy }))
  }

  const onPointerEnd = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const live = pan.current
    if (live !== null && live.pointerId === event.pointerId && typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // The capture may already be gone; ending the pan is what matters.
      }
    }
    endPan()
  }

  const onImageClick = (event: ReactMouseEvent<HTMLImageElement>): void => {
    const suppressed = suppressClick.current
    suppressClick.current = false
    if (suppressed) return
    const current = latest.current
    zoomAt(current.zoom > VIEWER_MIN_ZOOM ? VIEWER_MIN_ZOOM : VIEWER_CLICK_ZOOM, event.clientX, event.clientY)
  }

  /** Only the backdrop itself closes: the bar and the stage are not dismissals. */
  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  const pannable = view.zoom > VIEWER_MIN_ZOOM

  return (
    <div
      className="agnes__lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('gallery.viewer')}
      onClick={onBackdropClick}
    >
      <div className="agnes__lightboxBar">
        <span className="agnes__lightboxZoom">{Math.round(view.zoom * 100)}%</span>
        <button
          type="button"
          className="agnes__lightboxZoomOut"
          aria-label={t('gallery.zoomOut')}
          onClick={() => zoomFromButton(1 / VIEWER_ZOOM_STEP)}
        >
          <ViewerIcon>
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M7.4 10.5h6.2M16.2 16.2 21 21" />
          </ViewerIcon>
        </button>
        <button
          type="button"
          className="agnes__lightboxZoomIn"
          aria-label={t('gallery.zoomIn')}
          onClick={() => zoomFromButton(VIEWER_ZOOM_STEP)}
        >
          <ViewerIcon>
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M7.4 10.5h6.2M10.5 7.4v6.2M16.2 16.2 21 21" />
          </ViewerIcon>
        </button>
        <button
          type="button"
          className="agnes__lightboxReset"
          aria-label={t('gallery.resetZoom')}
          onClick={() => setView(VIEWER_IDENTITY)}
        >
          <ViewerIcon>
            <path d="M4 9.5h5V4.5" />
            <path d="M4.6 9.2a8 8 0 1 1-1.1 5.3" />
          </ViewerIcon>
        </button>
        <a
          className="agnes__button agnes__button--ghost"
          href={asset.src}
          download={`agnes-${generation.id}${extensionFor(asset.mediaType)}`}
        >
          {t('gallery.download')}
        </a>
        <button type="button" className="agnes__lightboxClose" aria-label={t('gallery.close')} ref={closeRef} onClick={onClose}>
          <ViewerIcon>
            <path d="M6 6l12 12M18 6 6 18" />
          </ViewerIcon>
        </button>
      </div>

      <div
        className={pannable ? 'agnes__lightboxStage agnes__lightboxStage--pannable' : 'agnes__lightboxStage'}
        ref={stageRef}
        data-panning={dragging}
      >
        <img
          className="agnes__lightboxImage"
          ref={imageRef}
          src={asset.src}
          alt={generation.prompt}
          draggable={false}
          data-dragging={dragging}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClick={onImageClick}
        />
      </div>

      <span className="agnes__lightboxHint">{t('gallery.hint')}</span>
    </div>
  )
}

/** One gallery card. */
function GenerationCard(props: {
  t: Translate
  generation: Generation
  onDelete: (id: string) => void
  onRetry: (generation: Generation) => void
  onOpen: (generation: Generation) => void
  disabled: boolean
}): JSX.Element {
  const { t, generation, onDelete, onRetry, onOpen, disabled } = props
  const asset = generation.asset
  const isImage = generation.kind === 'image'
  const failed = generation.status === 'failed'
  const took = formatSeconds(generation.durationMs)
  return (
    <article className={failed ? 'agnes__card agnes__card--failed' : 'agnes__card'}>
      {asset !== undefined && isImage ? (
        <button
          type="button"
          className="agnes__thumbButton"
          onClick={() => onOpen(generation)}
          aria-label={t('gallery.viewer')}
        >
          <img className="agnes__thumb" src={asset.src} alt={generation.prompt.slice(0, 160)} loading="lazy" />
        </button>
      ) : asset !== undefined ? (
        <video className="agnes__thumb" src={asset.src} controls preload="metadata" />
      ) : (
        <div className="agnes__thumb" aria-hidden="true" />
      )}
      <div className="agnes__body">
        <p className="agnes__prompt">{generation.prompt}</p>
        <div className="agnes__facts">
          <span>{generation.model}</span>
          {took === '' ? null : <span>{t('gallery.took', { seconds: took })}</span>}
          <span>{paramSummary(generation)}</span>
        </div>
        {failed ? (
          <>
            <p className="agnes__failText">{generation.error ?? t('status.failed')}</p>
            {generation.retryable === true ? <span className="agnes__retryHint">{t('error.retryable')}</span> : null}
          </>
        ) : null}
        <div className="agnes__cardActions">
          {/* The viewer replaces the old new-window link for images only: a
              video already has a player in the card, and the lightbox is an
              image viewer. */}
          {asset !== undefined && isImage ? (
            <button type="button" className="agnes__open" onClick={() => onOpen(generation)}>
              {t('gallery.open')}
            </button>
          ) : null}
          {asset !== undefined ? (
            <a
              className="agnes__button agnes__button--ghost"
              href={asset.src}
              download={`agnes-${generation.id}${extensionFor(asset.mediaType)}`}
            >
              {t('gallery.download')}
            </a>
          ) : null}
          {failed && generation.retryable === true ? (
            <button type="button" className="agnes__button" disabled={disabled} onClick={() => onRetry(generation)}>
              {t('gallery.retry')}
            </button>
          ) : null}
          <button
            type="button"
            className="agnes__button agnes__button--danger"
            disabled={disabled}
            onClick={() => {
              if (confirmInBrowser(t('gallery.confirmDelete'))) onDelete(generation.id)
            }}
          >
            {t('gallery.delete')}
          </button>
        </div>
      </div>
    </article>
  )
}

/** The studio page. */
export function StudioPage({ api, t }: StudioPageProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('image')
  const [state, setState] = useState<StudioState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [imageDraft, setImageDraft] = useState<ImageDraft>(initialImageDraft)
  const [videoDraft, setVideoDraft] = useState<VideoDraft>(initialVideoDraft)
  /**
   * Which generation the viewer shows, by id rather than by object.
   *
   * The Host owns the records, so every state refresh hands back freshly parsed
   * objects. Holding the id keeps the viewer open across those refreshes — which
   * matters because a generation finishing in the background rewrites the whole
   * list — while a record that actually disappeared closes the viewer instead of
   * leaving it on a stale picture.
   */
  const [viewingId, setViewingId] = useState<string | null>(null)
  // The last submitted request, so "retry" resends exactly what failed.
  const lastRequest = useRef<GenerationRequest | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Load the initial state once. */
  useEffect(() => {
    const controller = new AbortController()
    api
      .state(controller.signal)
      .then((next) => {
        if (mounted.current) setState(next)
      })
      .catch((cause: unknown) => {
        if (mounted.current && !controller.signal.aborted) setLoadError(messageFor(t, cause))
      })
    return () => controller.abort()
  }, [api, t])

  /** Run one request and reconcile the returned state. */
  const run = useCallback(
    async (request: GenerationRequest) => {
      lastRequest.current = request
      setBusy({ kind: request.kind })
      setError(null)
      try {
        const result = await api.generate(request)
        if (!mounted.current) return
        setState(result.state)
      } catch (cause) {
        if (!mounted.current) return
        setError({ message: messageFor(t, cause), retryable: isRetryable(cause) })
        // A failed attempt may still have refreshed the history (a retryable
        // failure is recorded), so re-read the state rather than assume.
        try {
          const next = await api.state()
          if (mounted.current) setState(next)
        } catch {
          // Keep the error line; the stale history is better than a blank panel.
        }
      } finally {
        if (mounted.current) setBusy(null)
      }
    },
    [api, t],
  )

  /** Submit the image form. */
  const submitImage = useCallback(() => {
    const prompt = imageDraft.prompt.trim()
    if (prompt === '') {
      setError({ message: t('form.needPrompt'), retryable: false })
      return
    }
    const references: MediaReference[] = imageDraft.references
      .map((url) => url.trim())
      .filter((url) => url !== '')
      .map((url) => ({ url, kind: 'image' as const }))
    void run({ kind: 'image', prompt, model: imageDraft.model, size: imageDraft.size, ratio: imageDraft.ratio, references })
  }, [imageDraft, run, t])

  /** Submit the video form. */
  const submitVideo = useCallback(() => {
    const prompt = videoDraft.prompt.trim()
    if (prompt === '') {
      setError({ message: t('form.needPrompt'), retryable: false })
      return
    }
    const references: MediaReference[] = []
    if (videoDraft.mode === 'keyframe') {
      if (videoDraft.firstFrame.trim() !== '') references.push({ url: videoDraft.firstFrame.trim(), kind: 'image' })
      if (videoDraft.lastFrame.trim() !== '') references.push({ url: videoDraft.lastFrame.trim(), kind: 'image' })
      if (references.length === 0) {
        setError({ message: t('form.needKeyframe'), retryable: false })
        return
      }
    }
    if (videoDraft.mode === 'reference') {
      for (const url of videoDraft.references) {
        if (url.trim() !== '') references.push({ url: url.trim(), kind: 'image' })
      }
      if (references.length === 0) {
        setError({ message: t('form.needReference'), retryable: false })
        return
      }
    }
    const seed = videoDraft.seed.trim() === '' ? undefined : Number(videoDraft.seed)
    void run({
      kind: 'video',
      prompt,
      model: videoDraft.model,
      mode: videoDraft.mode,
      size: videoDraft.size,
      ratio: videoDraft.ratio,
      seconds: videoDraft.seconds,
      references,
      ...(seed === undefined || !Number.isInteger(seed) ? {} : { seed }),
    })
  }, [run, t, videoDraft])

  /** Retry the last identical request. */
  const retry = useCallback(() => {
    const request = lastRequest.current
    if (request !== null) void run(request)
  }, [run])

  const deleteOne = useCallback(
    async (id: string) => {
      try {
        setState(await api.remove(id))
      } catch (cause) {
        setError({ message: messageFor(t, cause), retryable: false })
      }
    },
    [api, t],
  )

  const clearAll = useCallback(async () => {
    if (!confirmInBrowser(t('gallery.confirmClear'))) return
    try {
      setState(await api.clear())
    } catch (cause) {
      setError({ message: messageFor(t, cause), retryable: false })
    }
  }, [api, t])

  /** The selected video model's spec, which narrows the size options. */
  const videoModel = useMemo(() => modelsFor('video').find((model) => model.id === videoDraft.model), [videoDraft.model])

  /** Keep the video size legal when the model changes (Flash is 720P only). */
  useEffect(() => {
    if (videoModel === undefined) return
    if (!videoModel.sizes.includes(videoDraft.size)) {
      const fallback = videoModel.sizes[0] as VideoSize | undefined
      if (fallback !== undefined) setVideoDraft((draft) => ({ ...draft, size: fallback }))
    }
  }, [videoModel, videoDraft.size])

  const generations = state?.generations ?? []
  const filtered = useMemo(
    () => (filter === 'all' ? generations : generations.filter((generation) => generation.kind === filter)),
    [filter, generations],
  )
  const imageCount = generations.filter((generation) => generation.kind === 'image').length
  const videoCount = generations.length - imageCount
  const disabled = busy !== null

  /** The record the viewer shows; resolving by id keeps it alive across refreshes. */
  const viewing = useMemo(
    () => (viewingId === null ? undefined : generations.find((generation) => generation.id === viewingId)),
    [generations, viewingId],
  )
  const closeViewer = useCallback(() => setViewingId(null), [])
  const openViewer = useCallback((generation: Generation) => setViewingId(generation.id), [])

  // A record can vanish under the viewer (deleted here, evicted by the history
  // cap, cleared from another window). Leaving the overlay up would show a
  // picture the Host no longer serves.
  useEffect(() => {
    if (viewingId !== null && state !== null && viewing === undefined) setViewingId(null)
  }, [state, viewing, viewingId])

  const imageDimension = expectedDimensions('image', imageDraft.size, imageDraft.ratio)
  const videoDimension = expectedDimensions('video', videoDraft.size, videoDraft.ratio)

  return (
    <div className="agnes">
      <StudioStyles />
      <header className="agnes__head">
        <h1 className="agnes__title">{t('title')}</h1>
        <p className="agnes__subtitle">{t('subtitle')}</p>
      </header>

      {state !== null && !state.configured ? (
        <div className="agnes__notice" role="status">
          <span className="agnes__noticeTitle">{t('config.title')}</span>
          <span className="agnes__noticeBody">{t('config.body')}</span>
        </div>
      ) : null}

      {state !== null && state.configured ? (
        <div className="agnes__meta">
          <span>
            {state.keySource === 'credential'
              ? t('config.source.credential')
              : state.keySource === 'environment'
                ? t('config.source.environment')
                : t('config.source.none')}
          </span>
          {state.upstreamModels.length > 0 ? <span>{t('config.models', { count: state.upstreamModels.length })}</span> : null}
        </div>
      ) : null}

      <div className="agnes__tabs" role="tablist" aria-label={t('title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'image'}
          className={tab === 'image' ? 'agnes__tab agnes__tab--on' : 'agnes__tab'}
          onClick={() => setTab('image')}
        >
          {t('tab.image')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'video'}
          className={tab === 'video' ? 'agnes__tab agnes__tab--on' : 'agnes__tab'}
          onClick={() => setTab('video')}
        >
          {t('tab.video')}
        </button>
      </div>

      {error !== null ? (
        <div className="agnes__error" role="alert">
          <span className="agnes__errorTitle">{t('status.failed')}</span>
          <span className="agnes__errorBody">{error.message}</span>
          <div className="agnes__actions">
            {error.retryable ? (
              <button type="button" className="agnes__button" disabled={disabled} onClick={retry}>
                {t('gallery.retry')}
              </button>
            ) : null}
            <button type="button" className="agnes__button agnes__button--ghost" onClick={() => setError(null)}>
              {t('action.dismiss')}
            </button>
          </div>
        </div>
      ) : null}

      {busy !== null ? (
        <div className="agnes__busy" role="status" aria-live="polite">
          <span className="agnes__spinner" aria-hidden="true" />
          <span>{busy.kind === 'image' ? t('status.generatingImage') : t('status.generatingVideo')}</span>
        </div>
      ) : null}

      {tab === 'image' ? (
        <section className="agnes__form" aria-label={t('tab.image')}>
          <label className="agnes__label">
            {t('form.prompt')}
            <textarea
              className="agnes__field"
              value={imageDraft.prompt}
              maxLength={LIMITS.prompt}
              disabled={disabled}
              placeholder={t('form.promptPlaceholder')}
              onChange={(event) => setImageDraft({ ...imageDraft, prompt: event.target.value })}
            />
          </label>
          <div className="agnes__row">
            <Field
              label={t('form.model')}
              value={imageDraft.model}
              disabled={disabled}
              options={modelsFor('image').map((model) => ({ value: model.id, label: model.label }))}
              onChange={(value) => setImageDraft({ ...imageDraft, model: value })}
            />
            <Field
              label={t('form.size')}
              value={imageDraft.size}
              disabled={disabled}
              options={IMAGE_SIZES.map((size) => ({ value: size, label: size }))}
              onChange={(value) => setImageDraft({ ...imageDraft, size: value as ImageSize })}
            />
            <Field
              label={t('form.ratio')}
              value={imageDraft.ratio}
              disabled={disabled}
              options={IMAGE_RATIOS.map((ratio) => ({ value: ratio, label: ratio }))}
              onChange={(value) => setImageDraft({ ...imageDraft, ratio: value as ImageRatio })}
            />
          </div>
          {imageDimension === undefined ? null : (
            <span className="agnes__hint">{t('hint.dimensions', { width: imageDimension.split('×')[0] ?? '', height: imageDimension.split('×')[1] ?? '' })}</span>
          )}
          <ReferenceList
            t={t}
            urls={imageDraft.references}
            disabled={disabled}
            onChange={(references) => setImageDraft({ ...imageDraft, references })}
          />
          <div className="agnes__actions">
            <button
              type="button"
              className="agnes__button agnes__button--primary"
              disabled={disabled || state?.configured === false}
              onClick={submitImage}
            >
              {t('form.submitImage')}
            </button>
          </div>
        </section>
      ) : (
        <section className="agnes__form" aria-label={t('tab.video')}>
          <label className="agnes__label">
            {t('form.prompt')}
            <textarea
              className="agnes__field"
              value={videoDraft.prompt}
              maxLength={LIMITS.prompt}
              disabled={disabled}
              placeholder={t('form.promptPlaceholder')}
              onChange={(event) => setVideoDraft({ ...videoDraft, prompt: event.target.value })}
            />
          </label>
          <div className="agnes__row">
            <Field
              label={t('form.model')}
              value={videoDraft.model}
              disabled={disabled}
              options={modelsFor('video').map((model) => ({ value: model.id, label: model.label }))}
              onChange={(value) => setVideoDraft({ ...videoDraft, model: value })}
            />
            <Field
              label={t('form.mode')}
              value={videoDraft.mode}
              disabled={disabled}
              options={(videoModel?.modes ?? ['text']).map((mode) => ({ value: mode, label: t(`mode.${mode}`) }))}
              onChange={(value) => setVideoDraft({ ...videoDraft, mode: value as VideoMode })}
            />
            <Field
              label={t('form.size')}
              value={videoDraft.size}
              disabled={disabled}
              options={(videoModel?.sizes ?? ['720P']).map((size) => ({ value: size, label: size }))}
              onChange={(value) => setVideoDraft({ ...videoDraft, size: value as VideoSize })}
            />
            <Field
              label={t('form.ratio')}
              value={videoDraft.ratio}
              disabled={disabled}
              options={VIDEO_RATIOS.map((ratio) => ({ value: ratio, label: ratio }))}
              onChange={(value) => setVideoDraft({ ...videoDraft, ratio: value as VideoRatio })}
            />
            <Field
              label={t('form.seconds')}
              value={String(videoDraft.seconds)}
              disabled={disabled}
              options={VIDEO_SECONDS.map((seconds) => ({ value: String(seconds), label: String(seconds) }))}
              onChange={(value) => setVideoDraft({ ...videoDraft, seconds: Number(value) as VideoSeconds })}
            />
            <label className="agnes__label">
              {t('form.seed')}
              <input
                className="agnes__field"
                type="number"
                min={0}
                value={videoDraft.seed}
                disabled={disabled}
                placeholder={t('form.seedPlaceholder')}
                onChange={(event) => setVideoDraft({ ...videoDraft, seed: event.target.value })}
              />
            </label>
          </div>
          {videoDimension === undefined ? null : (
            <span className="agnes__hint">
              {t('hint.dimensions', { width: videoDimension.split('×')[0] ?? '', height: videoDimension.split('×')[1] ?? '' })}
            </span>
          )}
          {videoDraft.mode === 'keyframe' ? (
            <div className="agnes__row">
              <label className="agnes__label">
                {t('form.firstFrame')}
                <input
                  className="agnes__field"
                  type="url"
                  value={videoDraft.firstFrame}
                  disabled={disabled}
                  placeholder={t('form.referencePlaceholder')}
                  onChange={(event) => setVideoDraft({ ...videoDraft, firstFrame: event.target.value })}
                />
              </label>
              <label className="agnes__label">
                {t('form.lastFrame')}
                <input
                  className="agnes__field"
                  type="url"
                  value={videoDraft.lastFrame}
                  disabled={disabled}
                  placeholder={t('form.referencePlaceholder')}
                  onChange={(event) => setVideoDraft({ ...videoDraft, lastFrame: event.target.value })}
                />
              </label>
            </div>
          ) : null}
          {videoDraft.mode === 'reference' ? (
            <ReferenceList
              t={t}
              urls={videoDraft.references}
              disabled={disabled}
              onChange={(references) => setVideoDraft({ ...videoDraft, references })}
            />
          ) : null}
          <span className="agnes__hint">{t('hint.videoSlow')}</span>
          <div className="agnes__actions">
            <button
              type="button"
              className="agnes__button agnes__button--primary"
              disabled={disabled || state?.configured === false}
              onClick={submitVideo}
            >
              {t('form.submitVideo')}
            </button>
          </div>
        </section>
      )}

      <section aria-label={t('gallery.title')}>
        <div className="agnes__galleryHead">
          <h2 className="agnes__galleryTitle">{t('gallery.title')}</h2>
          <span className="agnes__count">{t('gallery.count', { count: generations.length })}</span>
          <span className="agnes__spacer" />
          <div className="agnes__filters">
            {(['all', 'image', 'video'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={filter === option ? 'agnes__chip agnes__chip--on' : 'agnes__chip'}
                onClick={() => setFilter(option)}
              >
                {option === 'all' ? t('gallery.all') : option === 'image' ? `${t('gallery.images')} ${imageCount}` : `${t('gallery.videos')} ${videoCount}`}
              </button>
            ))}
          </div>
          {generations.length > 0 ? (
            <button type="button" className="agnes__button agnes__button--danger" disabled={disabled} onClick={() => void clearAll()}>
              {t('gallery.clear')}
            </button>
          ) : null}
        </div>

        {state === null ? (
          <div className="agnes__empty">{loadError ?? t('gallery.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="agnes__empty">{generations.length === 0 ? t('gallery.empty') : t('gallery.emptyFiltered')}</div>
        ) : (
          <div className="agnes__grid">
            {filtered.map((generation) => (
              <GenerationCard
                key={generation.id}
                t={t}
                generation={generation}
                disabled={disabled}
                onDelete={(id) => void deleteOne(id)}
                onRetry={() => retry()}
                onOpen={openViewer}
              />
            ))}
          </div>
        )}
      </section>

      {viewing !== undefined && viewing.kind === 'image' && viewing.asset !== undefined ? (
        <ImageViewer t={t} generation={viewing} asset={viewing.asset} onClose={closeViewer} />
      ) : null}

      <span className="agnes__hint">{t('hint.key')}</span>
    </div>
  )
}
