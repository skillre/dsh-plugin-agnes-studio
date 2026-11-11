/**
 * The Agnes Studio panel: a composer on the left, the result gallery on the right.
 *
 * State rules: the Host owns the generations and the configuration; this page
 * holds only view state (which capability tab, the form draft, the in-flight
 * flag, the error line, the gallery filter). Every generation is a Host call and
 * the returned state replaces the local one, so two windows on the same panel
 * converge instead of fighting over local copies.
 *
 * Four decisions worth knowing:
 * 1. **The parameter controls are derived from the model table, not hard-coded.**
 *    Picking the Flash video model narrows the resolution list to 720P, because
 *    the table says so and the Host would refuse anything else. The UI can
 *    therefore never offer a value the API rejects. The selected model's own
 *    `note` is shown beneath the controls so the narrowing is explained rather
 *    than surprising.
 * 2. **The submit is disabled while a request runs.** Image generation takes
 *    tens of seconds and video takes minutes; a double submit would silently
 *    double the cost and the queue depth.
 * 3. **A failure is shown in place with its retry affordance.** The Host marks a
 *    queue-full or a timeout as retryable, so the panel offers "retry" instead of
 *    making the user retype the prompt.
 * 4. **Option sets pick their own control shape.** Two to four mutually
 *    exclusive values become a segmented control; larger sets become chips. A
 *    `<select>` hides every alternative behind a popup, which is the wrong shape
 *    for a 4-way resolution choice whose whole point is that the choices differ.
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
  type ModelSpec,
  type StudioState,
  type VideoMode,
  type VideoRatio,
  type VideoSeconds,
  type VideoSize,
} from '../types.js'

/** Keys this file translates; mirrored in `text.ts`. */
// nav, title, subtitle, tab.image, tab.video, config.title, config.body,
// config.source.credential, config.source.environment, config.source.none,
// config.models, status.ready, status.notConfigured, status.loading,
// status.source.credential, status.source.environment, status.source.none,
// status.models, form.prompt, form.promptPlaceholder, form.model, form.size,
// form.ratio, form.mode, form.seconds, form.seed, form.seedPlaceholder,
// form.references, form.referencePlaceholder, form.addReference,
// form.removeReference, form.firstFrame, form.lastFrame, form.submitImage,
// form.submitVideo, form.needPrompt, form.needKeyframe, form.needReference,
// form.examples, example.image.1, example.image.2, example.image.3,
// example.video.1, example.video.2, example.video.3,
// mode.text, mode.keyframe, mode.reference, status.generatingImage,
// status.generatingVideo, status.failed, gallery.title, gallery.count,
// gallery.empty, gallery.emptyHint, gallery.emptyFiltered,
// gallery.emptyFilteredHint, gallery.all, gallery.images, gallery.videos,
// gallery.delete, gallery.clear, gallery.confirmClear, gallery.confirmDelete,
// gallery.retry, gallery.download, gallery.open, gallery.viewer, gallery.close,
// gallery.zoomIn, gallery.zoomOut, gallery.resetZoom, gallery.hint,
// gallery.hintNav, gallery.prev, gallery.next, gallery.position,
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

// ---------------------------------------------------------------------------
// Icons
//
// Inline strokes rather than an icon dependency: the browser bundle's module
// envelope can only resolve `react`, so a package import would break loading.
// Every icon is 1.7px stroke at 24 viewBox so the set looks drawn by one hand.
// ---------------------------------------------------------------------------

/** A stroke-icon wrapper; `size` is the rendered square in px. */
function Glyph({ size = 16, children }: { readonly size?: number; readonly children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
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

/** The panel's own mark: a four-point spark inside a rounded frame. */
function BrandGlyph(): JSX.Element {
  return (
    <Glyph size={19}>
      <path d="M12 3.2 13.7 8.3 18.8 10 13.7 11.7 12 16.8 10.3 11.7 5.2 10 10.3 8.3Z" fill="currentColor" stroke="none" />
      <path d="M18.4 15.2 19.2 17.4 21.4 18.2 19.2 19 18.4 21.2 17.6 19 15.4 18.2 17.6 17.4Z" fill="currentColor" stroke="none" opacity="0.72" />
    </Glyph>
  )
}

const IconImage = (): JSX.Element => (
  <Glyph size={14}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M4.5 15.5 9 11l3 3 2.5-2.5 5 4.5" />
    <circle cx="15.5" cy="8.5" r="1.3" />
  </Glyph>
)

const IconVideo = (): JSX.Element => (
  <Glyph size={14}>
    <rect x="2.5" y="5.5" width="13" height="13" rx="2.5" />
    <path d="M15.5 10.4 21 7.4v9.2l-5.5-3" />
  </Glyph>
)

const IconChevron = (): JSX.Element => (
  <Glyph size={13}>
    <path d="m6 9.5 6 6 6-6" />
  </Glyph>
)

const IconPlus = (): JSX.Element => (
  <Glyph size={12}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
)

const IconTrash = (): JSX.Element => (
  <Glyph size={14}>
    <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7" />
    <path d="M10.5 10.8v5.4M13.5 10.8v5.4" />
  </Glyph>
)

const IconDownload = (): JSX.Element => (
  <Glyph size={14}>
    <path d="M12 3.8v10.4M8 10.4 12 14.4l4-4" />
    <path d="M4.5 16.5v2.2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.2" />
  </Glyph>
)

const IconClose = (): JSX.Element => (
  <Glyph size={15}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Glyph>
)

const IconExpand = (): JSX.Element => (
  <Glyph size={13}>
    <path d="M9.5 4.5H4.5v5M14.5 4.5h5v5M9.5 19.5H4.5v-5M14.5 19.5h5v-5" />
  </Glyph>
)

const IconZoomIn = (): JSX.Element => (
  <Glyph size={15}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M7.4 10.5h6.2M10.5 7.4v6.2M16.2 16.2 21 21" />
  </Glyph>
)

const IconZoomOut = (): JSX.Element => (
  <Glyph size={15}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M7.4 10.5h6.2M16.2 16.2 21 21" />
  </Glyph>
)

const IconReset = (): JSX.Element => (
  <Glyph size={15}>
    <path d="M4 9.5h5V4.5" />
    <path d="M4.6 9.2a8 8 0 1 1-1.1 5.3" />
  </Glyph>
)

const IconAlert = (): JSX.Element => (
  <Glyph size={15}>
    <path d="M12 4.2 21 19.4H3Z" />
    <path d="M12 9.6v4.2M12 16.6v.1" />
  </Glyph>
)

const IconInfo = (): JSX.Element => (
  <Glyph size={15}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 11v5.4M12 7.9v.1" />
  </Glyph>
)

const IconSpark = (): JSX.Element => (
  <Glyph size={14}>
    <path d="M12 3.6 13.8 8.9 19.1 10.7 13.8 12.5 12 17.8 10.2 12.5 4.9 10.7 10.2 8.9Z" />
    <path d="M18.2 15.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z" />
  </Glyph>
)

const IconArrowLeft = (): JSX.Element => (
  <Glyph size={17}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Glyph>
)

const IconArrowRight = (): JSX.Element => (
  <Glyph size={17}>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </Glyph>
)

const IconFrame = (): JSX.Element => (
  <Glyph size={20}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M4.5 15.5 9 11l3 3 2.5-2.5 5 4.5" />
    <circle cx="15.5" cy="8.5" r="1.3" />
  </Glyph>
)

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

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

/** A human summary of the parameters actually sent, one entry per value. */
function paramFacts(generation: Generation): string[] {
  const parts: string[] = []
  for (const [key, value] of Object.entries(generation.params)) {
    // `seed=0` is a legitimate value, so only empty and null are skipped.
    if (key === 'model' || value === null || value === '') continue
    parts.push(`${key}=${String(value)}`)
  }
  return parts
}

/** Resolve the expected pixel dimensions for a draft, when the table knows them. */
function expectedDimensions(kind: MediaKind, size: string, ratio: string): readonly [number, number] | undefined {
  const table = kind === 'image' ? IMAGE_DIMENSIONS_REF : VIDEO_DIMENSIONS_REF
  const row = table[ratio as keyof typeof table] as Record<string, readonly [number, number]> | undefined
  return row?.[size]
}

/** The width/height of an aspect-ratio label, e.g. `16:9` → `[16, 9]`. */
function ratioParts(ratio: string): readonly [number, number] {
  const parts = ratio.split(':').map((part) => Number(part))
  const width = parts[0]
  const height = parts[1]
  if (width === undefined || height === undefined) return [1, 1]
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [1, 1]
  return [width, height]
}

/** A tiny proportional box drawn from a ratio label, sized to fit `box` px. */
function RatioGlyph({ ratio, box = 15 }: { readonly ratio: string; readonly box?: number }): JSX.Element {
  const [width, height] = ratioParts(ratio)
  const scale = box / Math.max(width, height)
  return (
    <span
      className="agnes__ratioGlyph"
      aria-hidden="true"
      style={{ width: `${String(Math.max(6, Math.round(width * scale)))}px`, height: `${String(Math.max(6, Math.round(height * scale)))}px` }}
    />
  )
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** One option for a segmented control or a chip row. */
interface Option<T extends string> {
  readonly value: T
  readonly label: string
}

/**
 * A segmented single-choice control.
 *
 * Used for two to four mutually exclusive values where the alternatives should
 * stay visible. Every option is a real `<button>` inside a `radiogroup`, so
 * keyboard users get arrow-free tabbing and screen readers announce the state.
 */
function Segmented<T extends string>(props: {
  t: Translate
  label: string
  value: T
  options: readonly Option<T>[]
  disabled: boolean
  onChange: (value: T) => void
}): JSX.Element {
  const { t, label, value, options, disabled, onChange } = props
  return (
    <div className="agnes__label">
      <span>{label}</span>
      <div className="agnes__seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={option.value === value ? 'agnes__segBtn agnes__segBtn--on' : 'agnes__segBtn'}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="agnes__srOnly">{t('gallery.title')}</span>
    </div>
  )
}

/**
 * A chip row for larger option sets.
 *
 * Eight aspect ratios or nine durations do not fit a segmented control without
 * shrinking the labels past legibility, so each value becomes a pill. A ratio
 * pill also draws itself, which is faster to scan than reading "21:9".
 */
function Chips<T extends string>(props: {
  label: string
  value: T
  options: readonly Option<T>[]
  disabled: boolean
  showRatio: boolean
  onChange: (value: T) => void
}): JSX.Element {
  const { label, value, options, disabled, showRatio, onChange } = props
  return (
    <div className="agnes__label">
      <span>{label}</span>
      <div className="agnes__chips" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={option.value === value ? 'agnes__chip agnes__chip--on' : 'agnes__chip'}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {showRatio ? <RatioGlyph ratio={option.value} /> : null}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** One `<select>` with its own chevron; `appearance: none` removes the native one. */
function SelectField(props: {
  label: string
  value: string
  options: readonly Option<string>[]
  disabled: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const { label, value, options, disabled, onChange } = props
  return (
    <label className="agnes__label">
      {label}
      <span className="agnes__selectWrap">
        <select
          className="agnes__field"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="agnes__chevron">
          <IconChevron />
        </span>
      </span>
    </label>
  )
}

/** The prompt field with its own footer: character count and example chips. */
function PromptBox(props: {
  t: Translate
  value: string
  disabled: boolean
  examples: readonly string[]
  onChange: (value: string) => void
  /** Whether a key is configured; optimization needs the same upstream call. */
  configured: boolean
  /** Run the optimizer; resolves with the rewritten prompt. */
  onOptimize: () => Promise<string>
}): JSX.Element {
  const { t, value, disabled, examples, onChange, configured, onOptimize } = props
  const nearLimit = value.length > LIMITS.prompt * 0.9
  const [optimizing, setOptimizing] = useState(false)
  const [optimizedFrom, setOptimizedFrom] = useState<string | null>(null)
  const [optimizeError, setOptimizeError] = useState<string | null>(null)

  /**
   * Rewrite the prompt, keeping the original so the edit is reversible.
   *
   * An optimizer that silently replaces the user's words is worse than none, so
   * the pre-optimization text is held until the user accepts it by editing.
   */
  const optimize = async (): Promise<void> => {
    if (value.trim() === '' || optimizing) return
    setOptimizing(true)
    setOptimizeError(null)
    const previous = value
    try {
      const improved = await onOptimize()
      onChange(improved)
      setOptimizedFrom(previous)
    } catch {
      setOptimizeError(t('error.optimizeFailed'))
    } finally {
      setOptimizing(false)
    }
  }

  return (
    <div className="agnes__form">
      <div className="agnes__label">
        <span>{t('form.prompt')}</span>
        <div className="agnes__promptBox">
          <textarea
            className="agnes__prompt"
            value={value}
            maxLength={LIMITS.prompt}
            disabled={disabled || optimizing}
            aria-label={t('form.prompt')}
            placeholder={t('form.promptPlaceholder')}
            onChange={(event) => {
              // Editing after an optimization is an acceptance of the rewrite, so
              // the offers to undo or re-run disappear.
              if (optimizedFrom !== null) setOptimizedFrom(null)
              onChange(event.target.value)
            }}
          />
          <div className="agnes__promptFoot">
            <button
              type="button"
              className="agnes__optimize"
              disabled={disabled || optimizing || !configured || value.trim() === ''}
              title={t('form.optimizeHint')}
              onClick={() => void optimize()}
            >
              <IconSpark />
              {optimizing ? t('form.optimizing') : t('form.optimize')}
            </button>
            {optimizedFrom !== null ? (
              <>
                <span className="agnes__optimizedTag">{t('form.optimized')}</span>
                <button
                  type="button"
                  className="agnes__undo"
                  disabled={optimizing}
                  onClick={() => {
                    onChange(optimizedFrom)
                    setOptimizedFrom(null)
                  }}
                >
                  {t('form.optimizeUndo')}
                </button>
              </>
            ) : null}
            <span className="agnes__counter" data-near={nearLimit ? 'true' : 'false'} style={nearLimit ? { color: 'var(--a-warn)' } : undefined}>
              {value.length} / {LIMITS.prompt}
            </span>
          </div>
        </div>
      </div>
      {optimizeError === null ? null : (
        <span className="agnes__hint" role="alert">
          {optimizeError}
        </span>
      )}
      <div className="agnes__examples">
        <span className="agnes__hint">{t('form.examples')}</span>
        {examples.map((example, index) => (
          <button
            key={index}
            type="button"
            className="agnes__example"
            disabled={disabled}
            title={example}
            onClick={() => onChange(example)}
          >
            {example.length > 26 ? `${example.slice(0, 26)}…` : example}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The editable reference-URL list shared by both forms. */
function ReferenceList(props: {
  t: Translate
  urls: string[]
  disabled: boolean
  max: number
  onChange: (urls: string[]) => void
}): JSX.Element {
  const { t, urls, disabled, max, onChange } = props
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
              aria-label={`${t('form.references')} ${String(index + 1)}`}
              placeholder={t('form.referencePlaceholder')}
              onChange={(event) => {
                const next = [...urls]
                next[index] = event.target.value
                onChange(next)
              }}
            />
            <button
              type="button"
              className="agnes__iconBtn agnes__iconBtn--danger"
              disabled={disabled}
              aria-label={t('form.removeReference')}
              title={t('form.removeReference')}
              onClick={() => onChange(urls.filter((_entry, position) => position !== index))}
            >
              <IconTrash />
            </button>
          </span>
        ))}
      </span>
      <button
        type="button"
        className="agnes__refAdd"
        disabled={disabled || urls.length >= max}
        onClick={() => onChange([...urls, ''])}
      >
        <IconPlus />
        {t('form.addReference')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * How often the panel re-reads the Host while a job is in flight.
 *
 * The Host is the authority on running work, so the panel must ask. 1.5s is fast
 * enough that a finishing image feels immediate and slow enough that a 15-minute
 * video costs ~600 small requests rather than thousands.
 */
const POLL_MS = 1500

// ---------------------------------------------------------------------------
// Image viewer
// ---------------------------------------------------------------------------

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
 *
 * Keyboard: Escape closes, arrows step between pictures, +/- zoom, 0 resets. The
 * arrows matter more than they look — a gallery is browsed, and forcing a close
 * and a re-open per picture makes a viewer useless for comparison.
 */
function ImageViewer(props: {
  t: Translate
  generation: Generation
  asset: GenerationAsset
  position: { readonly index: number; readonly total: number }
  onPrev?: () => void
  onNext?: () => void
  onClose: () => void
}): JSX.Element {
  const { t, generation, asset, position, onPrev, onNext, onClose } = props
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

  // Keyboard shortcuts. Bound on the window rather than on the overlay so they
  // work whatever holds focus, and removed on unmount so closing leaves no
  // global trace.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onClose()
          return
        case 'ArrowLeft':
          if (onPrev === undefined) return
          event.preventDefault()
          onPrev()
          return
        case 'ArrowRight':
          if (onNext === undefined) return
          event.preventDefault()
          onNext()
          return
        case '+':
        case '=':
          event.preventDefault()
          zoomFromButton(VIEWER_ZOOM_STEP)
          return
        case '-':
        case '_':
          event.preventDefault()
          zoomFromButton(1 / VIEWER_ZOOM_STEP)
          return
        case '0':
          event.preventDefault()
          setView(VIEWER_IDENTITY)
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, onNext, onPrev, zoomFromButton])

  // A new picture starts fitted: carrying the previous zoom and pan across a
  // navigation would show the next picture cropped to wherever the last one was.
  useEffect(() => {
    setView(VIEWER_IDENTITY)
  }, [generation.id])

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
  const facts = [
    generation.model,
    asset.width !== undefined && asset.height !== undefined ? `${String(asset.width)}×${String(asset.height)}` : undefined,
    ...paramFacts(generation),
    formatSeconds(generation.durationMs) === '' ? undefined : t('gallery.took', { seconds: formatSeconds(generation.durationMs) }),
  ].filter((entry): entry is string => entry !== undefined && entry !== '')

  return (
    <div
      className="agnes__lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('gallery.viewer')}
      onClick={onBackdropClick}
    >
      <div className="agnes__lightboxBar">
        <span className="agnes__lightboxMeta">
          <span className="agnes__lightboxTitle">{generation.prompt}</span>
          <span className="agnes__lightboxSub">
            {facts.join(' · ')}
            {position.total > 1 ? ` · ${t('gallery.position', { index: position.index + 1, total: position.total })}` : ''}
          </span>
        </span>

        <span className="agnes__lightboxGroup">
          <button
            type="button"
            className="agnes__lightboxBtn agnes__lightboxZoomOut"
            aria-label={t('gallery.zoomOut')}
            title={t('gallery.zoomOut')}
            disabled={view.zoom <= VIEWER_MIN_ZOOM}
            onClick={() => zoomFromButton(1 / VIEWER_ZOOM_STEP)}
          >
            <IconZoomOut />
          </button>
          <span className="agnes__lightboxZoom">{Math.round(view.zoom * 100)}%</span>
          <button
            type="button"
            className="agnes__lightboxBtn agnes__lightboxZoomIn"
            aria-label={t('gallery.zoomIn')}
            title={t('gallery.zoomIn')}
            disabled={view.zoom >= VIEWER_MAX_ZOOM}
            onClick={() => zoomFromButton(VIEWER_ZOOM_STEP)}
          >
            <IconZoomIn />
          </button>
          <button
            type="button"
            className="agnes__lightboxBtn agnes__lightboxReset"
            aria-label={t('gallery.resetZoom')}
            title={t('gallery.resetZoom')}
            disabled={view.zoom === VIEWER_MIN_ZOOM && view.x === 0 && view.y === 0}
            onClick={() => setView(VIEWER_IDENTITY)}
          >
            <IconReset />
          </button>
        </span>

        <a
          className="agnes__lightboxSave"
          href={asset.src}
          download={`agnes-${generation.id}${extensionFor(asset.mediaType)}`}
        >
          <IconDownload />
          {t('gallery.download')}
        </a>

        <button
          type="button"
          className="agnes__lightboxBtn agnes__lightboxClose"
          aria-label={t('gallery.close')}
          title={t('gallery.close')}
          ref={closeRef}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      <div
        className={pannable ? 'agnes__lightboxStage agnes__lightboxStage--pannable' : 'agnes__lightboxStage'}
        ref={stageRef}
        data-panning={dragging}
      >
        {onPrev === undefined ? null : (
          <button type="button" className="agnes__lightboxNav agnes__lightboxNav--prev" aria-label={t('gallery.prev')} title={t('gallery.prev')} onClick={onPrev}>
            <IconArrowLeft />
          </button>
        )}
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
        {onNext === undefined ? null : (
          <button type="button" className="agnes__lightboxNav agnes__lightboxNav--next" aria-label={t('gallery.next')} title={t('gallery.next')} onClick={onNext}>
            <IconArrowRight />
          </button>
        )}
      </div>

      <div className="agnes__lightboxFoot">
        <span className="agnes__lightboxHint">{t('gallery.hint')}</span>
        {position.total > 1 ? (
          <span className="agnes__lightboxHint">
            <kbd className="agnes__lightboxKbd">←</kbd>
            <kbd className="agnes__lightboxKbd">→</kbd>
            {t('gallery.hintNav')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/**
 * The placeholder card shown for one running job that has no record yet.
 *
 * Driven by the Host's in-flight list, so it also appears when the user comes
 * back to the studio while a job is still rendering elsewhere. A RETRY never
 * gets one of these: it reuses the failed record's card (see
 * {@link GenerationCard}), because a placeholder beside that card reads as a
 * second task and only merges back when the attempt settles.
 */
function PendingCard(props: { t: Translate; kind: MediaKind; onCancel: () => void }): JSX.Element {
  const { t, kind, onCancel } = props
  return (
    <article className="agnes__card agnes__card--pending">
      <div className="agnes__thumbFrame">
        <div className="agnes__pendingShine" />
        <span className="agnes__pendingBadge">
          <span className="agnes__spinner" />
          {kind === 'image' ? t('status.generatingImage') : t('status.generatingVideo')}
        </span>
      </div>
      <div className="agnes__cardBody">
        <span className="agnes__pendingLine" style={{ width: '72%' }} />
        <span className="agnes__pendingLine" style={{ width: '46%' }} />
        <div className="agnes__cardActions">
          <span className="agnes__hint">{t('hint.background')}</span>
          <span className="agnes__spacer" />
          <button type="button" className="agnes__open" onClick={onCancel}>
            {t('action.cancelJob')}
          </button>
        </div>
      </div>
    </article>
  )
}

/** One gallery card. */
function GenerationCard(props: {
  t: Translate
  generation: Generation
  /** Whether the Host is retrying THIS record right now. */
  retrying: boolean
  onDelete: (id: string) => void
  onRetry: (generation: Generation) => void
  onCancelJob: () => void
  onOpen: (generation: Generation, opener: Element | null) => void
  disabled: boolean
}): JSX.Element {
  const { t, generation, retrying, onDelete, onRetry, onCancelJob, onOpen, disabled } = props
  const asset = generation.asset
  const isImage = generation.kind === 'image'
  const failed = generation.status === 'failed'
  const took = formatSeconds(generation.durationMs)
  const dimensions =
    asset?.width !== undefined && asset?.height !== undefined ? `${String(asset.width)}×${String(asset.height)}` : undefined
  // A record being retried still describes its failed attempt until the new one
  // settles, so its old duration is dropped: it would otherwise read as the
  // runtime of the attempt the user is watching.
  const facts = [
    dimensions,
    ...(retrying || took === '' ? [] : [t('gallery.took', { seconds: took })]),
    ...paramFacts(generation),
  ].filter((entry): entry is string => entry !== undefined && entry !== '')

  return (
    <article
      className={
        retrying ? 'agnes__card agnes__card--retrying' : failed ? 'agnes__card agnes__card--failed' : 'agnes__card'
      }
    >
      {retrying ? (
        /* The card the user clicked BECOMES the progress card: same slot, same
           history row, so restarting a failed task cannot look like a second
           task appearing next to it. */
        <div className="agnes__thumbFrame">
          <div className="agnes__pendingShine" />
          <span className="agnes__pendingBadge">
            <span className="agnes__spinner" aria-hidden="true" />
            {isImage ? t('status.generatingImage') : t('status.generatingVideo')}
          </span>
        </div>
      ) : asset !== undefined && isImage ? (
        <button
          type="button"
          className="agnes__thumbButton"
          onClick={(event) => onOpen(generation, event.currentTarget)}
          aria-label={`${t('gallery.viewer')}: ${generation.prompt.slice(0, 80)}`}
        >
          <img className="agnes__thumb" src={asset.src} alt={generation.prompt.slice(0, 160)} loading="lazy" />
          <span className="agnes__thumbVeil">
            <span className="agnes__thumbVeilInner">
              <IconExpand />
              {t('gallery.viewer')}
            </span>
          </span>
        </button>
      ) : asset !== undefined ? (
        <div className="agnes__thumbFrame">
          <video className="agnes__thumb agnes__thumb--contain" src={asset.src} controls preload="metadata" />
        </div>
      ) : (
        <div className="agnes__thumbFrame">
          <div className="agnes__thumbEmpty">
            <IconAlert />
          </div>
        </div>
      )}

      <div className="agnes__cardBody">
        <p className="agnes__promptText">{generation.prompt}</p>
        <div className="agnes__facts">
          <span className="agnes__fact">{generation.model}</span>
          {facts.map((fact) => (
            <span className="agnes__fact" key={fact}>
              <span className="agnes__factDot" aria-hidden="true" />
              {fact}
            </span>
          ))}
        </div>
        {retrying ? (
          /* One progress surface per task: the stale failure text and its retry
             button give way to the retry's own state and one cancel action,
             because this card IS the attempt that is running. */
          <div className="agnes__cardActions">
            <span className="agnes__hint">{t('hint.retrying')}</span>
            <span className="agnes__spacer" />
            <button type="button" className="agnes__open" onClick={onCancelJob}>
              {t('action.cancelJob')}
            </button>
          </div>
        ) : (
          <>
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
                <button
                  type="button"
                  className="agnes__open"
                  onClick={(event) => onOpen(generation, event.currentTarget)}
                >
                  <IconExpand />
                  {t('gallery.open')}
                </button>
              ) : null}
              {asset !== undefined ? (
                <a
                  className="agnes__iconBtn"
                  href={asset.src}
                  download={`agnes-${generation.id}${extensionFor(asset.mediaType)}`}
                  aria-label={t('gallery.download')}
                  title={t('gallery.download')}
                >
                  <IconDownload />
                </a>
              ) : null}
              {failed && generation.retryable === true ? (
                <button type="button" className="agnes__open" disabled={disabled} onClick={() => onRetry(generation)}>
                  <IconReset />
                  {t('gallery.retry')}
                </button>
              ) : null}
              <span className="agnes__spacer" />
              <button
                type="button"
                className="agnes__iconBtn agnes__iconBtn--danger"
                disabled={disabled}
                aria-label={t('gallery.delete')}
                title={t('gallery.delete')}
                onClick={() => {
                  if (confirmInBrowser(t('gallery.confirmDelete'))) onDelete(generation.id)
                }}
              >
                <IconTrash />
              </button>
            </div>
          </>
        )}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** The studio page. */
export function StudioPage({ api, t }: StudioPageProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('image')
  const [state, setState] = useState<StudioState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ message: string; retryable: boolean; recordId?: string } | null>(null)
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
  // The last submitted request, so the error line's retry can resend it.
  const lastRequest = useRef<GenerationRequest | null>(null)
  /** The element that opened the viewer, so closing can return focus to it. */
  const openerRef = useRef<Element | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Read the state without the model-catalog probe (that costs an upstream call). */
  const refresh = useCallback(async () => {
    const next = await api.state()
    if (mounted.current) {
      setState(next)
      setLoadError(null)
    }
    return next
  }, [api])

  /** Load once, including the model catalog the header reports. */
  useEffect(() => {
    const controller = new AbortController()
    api
      .state({ probeModels: true, signal: controller.signal })
      .then((next) => {
        if (mounted.current) setState(next)
      })
      .catch((cause: unknown) => {
        if (mounted.current && !controller.signal.aborted) setLoadError(messageFor(t, cause))
      })
    return () => controller.abort()
  }, [api, t])

  /**
   * Keep polling while the Host has work in flight.
   *
   * This is the whole point of Host-owned jobs: the panel is a VIEW of remote
   * work, so coming back after switching away must show what is still running.
   * Polling only runs while there is something to observe — an idle panel costs
   * nothing — and stops as soon as the last job settles, whose stored record
   * arrives in the same response.
   */
  const running = state?.running ?? []
  const hasRunning = running.length > 0
  useEffect(() => {
    if (!hasRunning) return
    let cancelled = false
    const timer = setInterval(() => {
      if (cancelled) return
      void refresh().catch(() => {
        // A transient poll failure keeps the last known state; the next tick
        // retries, and the records are still on the Host either way.
      })
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hasRunning, refresh])

  /**
   * Submit one generation and let the Host run it in the background.
   *
   * Deliberately not awaited to completion: the Host answers as soon as the job
   * is registered, and the panel learns the outcome by polling. That is what
   * makes the work survive the user leaving the studio.
   */
  const run = useCallback(
    async (request: GenerationRequest) => {
      lastRequest.current = request
      setSubmitting(true)
      setError(null)
      try {
        const next = await api.start(request)
        if (!mounted.current) return
        setState(next)
      } catch (cause) {
        if (!mounted.current) return
        const recordId = cause instanceof ActionError ? cause.details['recordId'] : undefined
        setError({
          message: messageFor(t, cause),
          retryable: isRetryable(cause),
          ...(typeof recordId === 'string' ? { recordId } : {}),
        })
      } finally {
        if (mounted.current) setSubmitting(false)
      }
    },
    [api, t],
  )

  /** Retry one stored failure from its own stored request. */
  const retryRecord = useCallback(
    async (generation: Generation) => {
      setSubmitting(true)
      setError(null)
      try {
        const next = await api.retry(generation.id)
        if (!mounted.current) return
        setState(next)
      } catch (cause) {
        if (!mounted.current) return
        setError({ message: messageFor(t, cause), retryable: false })
      } finally {
        if (mounted.current) setSubmitting(false)
      }
    },
    [api, t],
  )

  /** Cancel one running job. */
  const cancelJob = useCallback(
    async (id: string) => {
      try {
        const next = await api.cancel(id)
        if (mounted.current) setState(next)
      } catch (cause) {
        if (mounted.current) setError({ message: messageFor(t, cause), retryable: false })
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

  /** The selected models' specs, which narrow the available controls. */
  const imageModel = useMemo(() => modelsFor('image').find((model) => model.id === imageDraft.model), [imageDraft.model])
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
  // A running job blocks a second submit: the upstream video queue is shared and
  // deepening it is the one thing the panel can guarantee it does not do. Leaving
  // the studio does NOT clear this, because the job is still real.
  const disabled = submitting || running.length > 0

  /**
   * Retries do not add a card.
   *
   * A retry reuses the failed record's id, and the Host reports it as a running
   * job whose `retryOf` names the record it will replace. Rendering the usual
   * placeholder for it showed one task twice — a new skeleton card that only
   * "merged" into the failed one when the attempt settled — so the record's own
   * card carries the progress state instead. Only a job with no record to
   * replace, i.e. a fresh generation, still gets a placeholder of its own.
   */
  const retryingRecordIds = new Set<string>()
  for (const job of running) {
    if (job.retryOf !== undefined) retryingRecordIds.add(job.retryOf)
  }
  /** Jobs that are not a retry, i.e. work with no card of its own yet. */
  const pendingJobs = running.filter((job) => job.retryOf === undefined)
  const placeholders = pendingJobs.filter((job) => filter === 'all' || job.kind === filter)

  /** The image records the viewer can step through, in gallery order. */
  const viewable = useMemo(
    () => generations.filter((generation) => generation.kind === 'image' && generation.asset !== undefined),
    [generations],
  )
  const viewingIndex = useMemo(
    () => (viewingId === null ? -1 : viewable.findIndex((generation) => generation.id === viewingId)),
    [viewable, viewingId],
  )
  const viewing = viewingIndex === -1 ? undefined : viewable[viewingIndex]
  const closeViewer = useCallback(() => {
    setViewingId(null)
    // Return focus to the control that opened the viewer, so closing does not
    // drop a keyboard user back at the top of the document.
    //
    // The opener is taken from the click event rather than from
    // `document.activeElement`: a programmatic `.click()` (which is how the
    // browser check and any automation drive this) does not move focus, so
    // `activeElement` would be `<body>` and focus would be lost.
    const opener = openerRef.current
    openerRef.current = null
    if (opener instanceof HTMLElement && typeof opener.focus === 'function') opener.focus()
  }, [])
  const openViewer = useCallback((generation: Generation, opener: Element | null) => {
    openerRef.current = opener
    setViewingId(generation.id)
  }, [])
  const stepViewer = useCallback(
    (delta: number) => {
      if (viewingIndex === -1 || viewable.length < 2) return
      const next = viewable[(viewingIndex + delta + viewable.length) % viewable.length]
      if (next !== undefined) setViewingId(next.id)
    },
    [viewable, viewingIndex],
  )

  // A record can vanish under the viewer (deleted here, evicted by the history
  // cap, cleared from another window). Leaving the overlay up would show a
  // picture the Host no longer serves.
  useEffect(() => {
    if (viewingId !== null && state !== null && viewing === undefined) setViewingId(null)
  }, [state, viewing, viewingId])

  const imageDimension = expectedDimensions('image', imageDraft.size, imageDraft.ratio)
  const videoDimension = expectedDimensions('video', videoDraft.size, videoDraft.ratio)

  const imageSizeOptions: Option<ImageSize>[] = IMAGE_SIZES.map((size) => ({ value: size, label: size }))
  const imageRatioOptions: Option<ImageRatio>[] = IMAGE_RATIOS.map((ratio) => ({ value: ratio, label: ratio }))
  const videoSizeOptions: Option<VideoSize>[] = ((videoModel?.sizes ?? ['720P']) as readonly VideoSize[]).map((size) => ({ value: size, label: size }))
  const videoRatioOptions: Option<VideoRatio>[] = VIDEO_RATIOS.map((ratio) => ({ value: ratio, label: ratio }))
  const videoSecondsOptions: Option<string>[] = VIDEO_SECONDS.map((seconds) => ({ value: String(seconds), label: `${String(seconds)}s` }))
  const videoModeOptions: Option<VideoMode>[] = ((videoModel?.modes ?? ['text']) as readonly VideoMode[]).map((mode) => ({
    value: mode,
    label: t(`mode.${mode}`),
  }))

  /** The status pill: configuration state in one glance, detail on hover. */
  const status: { text: string; title: string; tone: 'ok' | 'off' | 'loading' } =
    state === null
      ? { text: t('status.loading'), title: t('status.loading'), tone: 'loading' }
      : state.configured
        ? {
            text: `${t('status.ready')}${state.upstreamModels.length > 0 ? ` · ${t('status.models', { count: state.upstreamModels.length })}` : ''}`,
            title:
              state.keySource === 'credential'
                ? t('config.source.credential')
                : state.keySource === 'environment'
                  ? t('config.source.environment')
                  : t('config.source.none'),
            tone: 'ok',
          }
        : { text: t('status.notConfigured'), title: t('config.body'), tone: 'off' }

  const examples = tab === 'image' ? [t('example.image.1'), t('example.image.2'), t('example.image.3')] : [t('example.video.1'), t('example.video.2'), t('example.video.3')]

  return (
    <div className="agnes">
      <StudioStyles />

      <header className="agnes__header">
        <span className="agnes__brandMark" aria-hidden="true">
          <BrandGlyph />
        </span>
        <span className="agnes__head">
          <h1 className="agnes__title">{t('title')}</h1>
          <p className="agnes__subtitle">{t('subtitle')}</p>
        </span>
        <span
          className={`agnes__status${status.tone === 'ok' ? '' : status.tone === 'off' ? ' agnes__status--off' : ' agnes__status--loading'}`}
          title={status.title}
        >
          <span className="agnes__statusDot" aria-hidden="true" />
          {status.text}
        </span>
      </header>

      {state !== null && !state.configured ? (
        <div className="agnes__notice" role="status">
          <span className="agnes__noticeIcon">
            <IconInfo />
          </span>
          <span className="agnes__noticeText">
            <span className="agnes__noticeTitle">{t('config.title')}</span>
            <span className="agnes__noticeBody">{t('config.body')}</span>
          </span>
        </div>
      ) : null}

      <div className="agnes__body">
        <section className="agnes__composer" aria-label={tab === 'image' ? t('tab.image') : t('tab.video')}>
          <div className="agnes__composerScroll">
          <div className="agnes__tabs" role="tablist" aria-label={t('title')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'image'}
              className={tab === 'image' ? 'agnes__tab agnes__tab--on' : 'agnes__tab'}
              onClick={() => setTab('image')}
            >
              <span className="agnes__tabIcon">
                <IconImage />
              </span>
              {t('tab.image')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'video'}
              className={tab === 'video' ? 'agnes__tab agnes__tab--on' : 'agnes__tab'}
              onClick={() => setTab('video')}
            >
              <span className="agnes__tabIcon">
                <IconVideo />
              </span>
              {t('tab.video')}
            </button>
          </div>

          {error !== null ? (
            <div className="agnes__error" role="alert">
              <span className="agnes__errorIcon">
                <IconAlert />
              </span>
              <span className="agnes__errorText">
                <span className="agnes__errorTitle">{t('status.failed')}</span>
                <span className="agnes__errorBody">{error.message}</span>
                <span className="agnes__actions">
                  {error.retryable ? (
                    <button
                      type="button"
                      className="agnes__button"
                      disabled={disabled}
                      onClick={() => {
                        const request = lastRequest.current
                        if (request !== null) void run(request)
                      }}
                    >
                      <IconReset />
                      {t('gallery.retry')}
                    </button>
                  ) : null}
                  <button type="button" className="agnes__button agnes__button--ghost" onClick={() => setError(null)}>
                    {t('action.dismiss')}
                  </button>
                </span>
              </span>
            </div>
          ) : null}

          {/* One banner per job that has no card of its own. A retry is already
              reported by the record's card, and repeating it here would put two
              progress lines and two cancel buttons for one task on screen. */}
          {pendingJobs.map((job) => (
            <div className="agnes__busy" role="status" aria-live="polite" key={job.id}>
              <span className="agnes__busyRow">
                <span className="agnes__spinner" aria-hidden="true" />
                <span>{job.kind === 'image' ? t('status.generatingImage') : t('status.generatingVideo')}</span>
                <span className="agnes__spacer" />
                {/* Leaving the studio does not stop the job, so the panel must
                    also offer the one action that does. */}
                <button
                  type="button"
                  className="agnes__button agnes__button--ghost agnes__cancelJob"
                  onClick={() => void cancelJob(job.id)}
                >
                  {t('action.cancelJob')}
                </button>
              </span>
              <span className="agnes__busyTrack" aria-hidden="true">
                <span className="agnes__busyBar" />
              </span>
              <span className="agnes__busyHint">{t('hint.background')}</span>
            </div>
          ))}

          {tab === 'image' ? (
            <div className="agnes__form">
              <PromptBox
                t={t}
                value={imageDraft.prompt}
                disabled={disabled}
                examples={examples}
                configured={state?.configured === true}
                onOptimize={() => api.optimize(imageDraft.prompt, 'image')}
                onChange={(prompt) => setImageDraft({ ...imageDraft, prompt })}
              />

              <SelectField
                label={t('form.model')}
                value={imageDraft.model}
                disabled={disabled}
                options={modelsFor('image').map((model) => ({ value: model.id, label: model.label }))}
                onChange={(value) => setImageDraft({ ...imageDraft, model: value })}
              />
              {imageModel === undefined ? null : <span className="agnes__hint">{imageModel.note}</span>}

              <Segmented
                t={t}
                label={t('form.size')}
                value={imageDraft.size}
                disabled={disabled}
                options={imageSizeOptions}
                onChange={(value) => setImageDraft({ ...imageDraft, size: value })}
              />

              <Chips
                label={t('form.ratio')}
                value={imageDraft.ratio}
                disabled={disabled}
                showRatio
                options={imageRatioOptions}
                onChange={(value) => setImageDraft({ ...imageDraft, ratio: value })}
              />

              {imageDimension === undefined ? null : (
                <span className="agnes__hintRow">
                  <span className="agnes__hint">
                    {t('hint.dimensions', { width: imageDimension[0], height: imageDimension[1] })}
                  </span>
                </span>
              )}

              <ReferenceList
                t={t}
                urls={imageDraft.references}
                disabled={disabled}
                max={imageModel?.maxImages ?? 8}
                onChange={(references) => setImageDraft({ ...imageDraft, references })}
              />
            </div>
          ) : (
            <div className="agnes__form">
              <PromptBox
                t={t}
                value={videoDraft.prompt}
                disabled={disabled}
                examples={examples}
                configured={state?.configured === true}
                onOptimize={() => api.optimize(videoDraft.prompt, 'video')}
                onChange={(prompt) => setVideoDraft({ ...videoDraft, prompt })}
              />

              <SelectField
                label={t('form.model')}
                value={videoDraft.model}
                disabled={disabled}
                options={modelsFor('video').map((model) => ({ value: model.id, label: model.label }))}
                onChange={(value) => setVideoDraft({ ...videoDraft, model: value })}
              />
              {videoModel === undefined ? null : <span className="agnes__hint">{videoModel.note}</span>}

              <Segmented
                t={t}
                label={t('form.mode')}
                value={videoDraft.mode}
                disabled={disabled}
                options={videoModeOptions}
                onChange={(value) => setVideoDraft({ ...videoDraft, mode: value })}
              />

              <Chips
                label={t('form.size')}
                value={videoDraft.size}
                disabled={disabled}
                showRatio={false}
                options={videoSizeOptions}
                onChange={(value) => setVideoDraft({ ...videoDraft, size: value })}
              />

              <Chips
                label={t('form.ratio')}
                value={videoDraft.ratio}
                disabled={disabled}
                showRatio
                options={videoRatioOptions}
                onChange={(value) => setVideoDraft({ ...videoDraft, ratio: value })}
              />

              <Chips
                label={t('form.seconds')}
                value={String(videoDraft.seconds)}
                disabled={disabled}
                showRatio={false}
                options={videoSecondsOptions}
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

              {videoDimension === undefined ? null : (
                <span className="agnes__hintRow">
                  <span className="agnes__hint">
                    {t('hint.dimensions', { width: videoDimension[0], height: videoDimension[1] })}
                  </span>
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
                  max={videoModel?.maxImages ?? 8}
                  onChange={(references) => setVideoDraft({ ...videoDraft, references })}
                />
              ) : null}

              <span className="agnes__hint">{t('hint.videoSlow')}</span>
            </div>
          )}
          </div>

          {/* The action row is pinned, not the last field of a scrolling form:
              on the video tab the submit used to sit below the fold, so the
              panel's primary action needed a page scroll to reach while nothing
              else on screen was moving. */}
          <div className="agnes__composerFoot">
            <button
              type="button"
              className="agnes__button agnes__button--primary"
              disabled={disabled || state?.configured === false}
              onClick={tab === 'image' ? submitImage : submitVideo}
            >
              <IconSpark />
              {tab === 'image' ? t('form.submitImage') : t('form.submitVideo')}
            </button>
            <span className="agnes__hint">
              {tab === 'image' ? t('hint.imageFast') : t('hint.videoSlow')}
            </span>
          </div>
        </section>

        <section className="agnes__gallery" aria-label={t('gallery.title')}>
          <div className="agnes__galleryHead">
            <h2 className="agnes__galleryTitle">
              <IconFrame />
              {t('gallery.title')}
            </h2>
            <span className="agnes__count">{t('gallery.count', { count: generations.length })}</span>
            <span className="agnes__spacer" />
            <div className="agnes__filters" role="tablist" aria-label={t('gallery.title')}>
              {(['all', 'image', 'video'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={filter === option}
                  className={filter === option ? 'agnes__filter agnes__filter--on' : 'agnes__filter'}
                  onClick={() => setFilter(option)}
                >
                  {option === 'all'
                    ? t('gallery.all')
                    : option === 'image'
                      ? `${t('gallery.images')} ${String(imageCount)}`
                      : `${t('gallery.videos')} ${String(videoCount)}`}
                </button>
              ))}
            </div>
            {generations.length > 0 ? (
              <button
                type="button"
                className="agnes__iconBtn agnes__iconBtn--danger"
                disabled={disabled}
                aria-label={t('gallery.clear')}
                title={t('gallery.clear')}
                onClick={() => void clearAll()}
              >
                <IconTrash />
              </button>
            ) : null}
          </div>

          {state === null ? (
            <div className="agnes__empty">
              <span className="agnes__emptyIcon">
                <IconFrame />
              </span>
              <span className="agnes__emptyTitle">{loadError ?? t('gallery.loading')}</span>
            </div>
          ) : filtered.length === 0 && placeholders.length === 0 ? (
            <div className="agnes__empty">
              <span className="agnes__emptyIcon">
                <IconFrame />
              </span>
              <span className="agnes__emptyTitle">{generations.length === 0 ? t('gallery.empty') : t('gallery.emptyFiltered')}</span>
              <span className="agnes__emptyBody">{generations.length === 0 ? t('gallery.emptyHint') : t('gallery.emptyFilteredHint')}</span>
            </div>
          ) : (
            <div className="agnes__grid">
              {placeholders.map((job) => (
                <PendingCard key={job.id} t={t} kind={job.kind} onCancel={() => void cancelJob(job.id)} />
              ))}
              {filtered.map((generation) => (
                <GenerationCard
                  key={generation.id}
                  t={t}
                  generation={generation}
                  retrying={retryingRecordIds.has(generation.id)}
                  disabled={disabled}
                  onDelete={(id) => void deleteOne(id)}
                  onRetry={(generation) => void retryRecord(generation)}
                  onCancelJob={() => {
                    // Cancel the JOB, looked up by the record it replaces: the
                    // panel is not the authority on job ids, `retryOf` is the
                    // link between a record and the attempt running for it.
                    const job = running.find((entry) => entry.retryOf === generation.id)
                    if (job !== undefined) void cancelJob(job.id)
                  }}
                  onOpen={openViewer}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <span className="agnes__hint">{t('hint.key')}</span>

      {viewing !== undefined && viewing.asset !== undefined ? (
        <ImageViewer
          t={t}
          generation={viewing}
          asset={viewing.asset}
          position={{ index: viewingIndex, total: viewable.length }}
          {...(viewable.length > 1 ? { onPrev: () => stepViewer(-1), onNext: () => stepViewer(1) } : {})}
          onClose={closeViewer}
        />
      ) : null}
    </div>
  )
}

/** Re-exported for tests that assert the model table drives the controls. */
export type { ModelSpec }
