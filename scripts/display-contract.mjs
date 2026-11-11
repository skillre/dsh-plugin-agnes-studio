// The display contract of one plugin package, as one module.
//
// A plugin's page in DSH is built from three resources that all fail *silently*
// when packaged wrong, so they are validated here in one place and by one
// implementation:
//
//   locale/<lang>.json   card title/description, plus `meta.detail`
//   docs/DETAIL*.md      the detail page: exactly one image, no prose
//   docs/preview*.svg    that image
//
// Three callers import this module and must never grow their own copy of the
// rules:
//
//   scripts/preview.mjs          the repository half (`npm run check`)
//   scripts/prepare-release.mjs  the publication half (the packed file list)
//   the fleet audit              the same contract across every checkout
//
// Coverage is decided by a real `npm pack` probe, never by re-reading
// `package.json#files`. `files` is not an allow/deny list: an entry naming an
// existing file becomes a strict inclusion that beats every ignore rule, while a
// directory or glob entry only contributes ignores, and `.npmignore`/`.gitignore`
// participate as well. A local reimplementation of that model drifted from npm on
// exactly those cases — it reported a file as excluded while `npm pack` shipped
// it — so there is no local copy of the rules any more.
//
// Nothing here touches the network or needs a Lark login.

import { spawnSync } from 'node:child_process'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

/** Languages every package ships, and the exact detail document each names. */
export const DISPLAY_LANGUAGES = Object.freeze([
  { lang: 'en', locale: 'locale/en.json', detail: 'docs/DETAIL.md', image: 'docs/preview.svg' },
  { lang: 'zh', locale: 'locale/zh.json', detail: 'docs/DETAIL.zh.md', image: 'docs/preview.zh.svg' },
])

/**
 * The template version that introduced this contract. A package generated
 * before it was built against the README fallback, so its detail page
 * legitimately *is* the README until the repository migrates in its own
 * compatibility PR. Publication and the fleet audit both treat that as a
 * migration to schedule rather than a defect — but only for the detail layer:
 * the card layer and the whiteboard-registry rule apply to every package.
 */
export const DISPLAY_CONTRACT_TEMPLATE_VERSION = '0.8.0'

/** The artifacts the tarball must carry, whatever else `files` lists. */
export const REQUIRED_ARTIFACTS = Object.freeze([
  'locale/en.json',
  'locale/zh.json',
  'docs/DETAIL.md',
  'docs/DETAIL.zh.md',
  'docs/preview.svg',
  'docs/preview.zh.svg',
])

// DSH renders the detail banner from whatever Markdown the document carries; it
// does not impose a ratio. 640x300 (2.13:1) is the shape every official plugin
// preview uses, and the shape the fleet draws for, so a different ratio leaves
// dead space or squashes the artwork. It is a fleet convention, not a runtime
// rule — see docs/display-contract.md.
export const PREVIEW_ASPECT = 640 / 300
export const PREVIEW_ASPECT_TOLERANCE = 0.02

// DSH itself admits 5 MiB per detail image; the fleet draws its budget much
// lower so a repository and its tarball stay small.
export const PREVIEW_MAX_BYTES = 500 * 1024

// DSH clamps the card subtitle to one line; the fleet budgets 120 characters so
// the clamp lands on a whole sentence rather than mid-word.
export const DESCRIPTION_MAX_CHARS = 120

// DSH reads the icon without activating the plugin: a relative path inside the
// package, SVG/PNG/JPEG/WebP, at most 256 KiB. These mirror MAX_ICON_BYTES and
// ICON_MEDIA_TYPES in @deepseek-ai/dsh-app-boot, which also realpath-checks the
// icon against its manifest directory.
export const ICON_MAX_BYTES = 256 * 1024
export const ICON_EXTENSIONS = Object.freeze(['.svg', '.png', '.jpg', '.jpeg', '.webp'])

// Markers the fleet's own placeholder artwork carries. A package that still
// ships them shows a generic mark to every user, so their presence is reported.
export const PLACEHOLDER_ICON_MARKER = 'Fleet placeholder artwork'
export const PLACEHOLDER_PREVIEW_MARKER = 'Preview placeholder'

// Elements the Feishu whiteboard importer cannot round-trip: it drops them or
// flattens the drawing into a bitmap. This matters only for the documented
// board workflow, not for DSH, which renders the SVG as authored.
export const FORBIDDEN_ELEMENTS = Object.freeze([
  'pattern',
  'clipPath',
  'mask',
  'image',
  'script',
  'style',
  'foreignObject',
])

/** The whiteboard registry: internal links and tokens, never published. */
export const BOARD_REGISTRY = 'docs/PREVIEW.md'

// Failure kinds that exist only because a package is expected to ship a detail
// page. A package generated before the contract does not, so these are what a
// migration is allowed to defer; every other kind applies to it today.
export const DETAIL_LAYER_KINDS = Object.freeze([
  'detail-missing',
  'detail-unreadable',
  'detail-unpublished',
  'detail-image-count',
  'detail-alt',
  'detail-image-path',
  'detail-prose',
  'preview-missing',
  'preview-unpublished',
  'preview-svg',
  'preview-aspect',
  'preview-element',
  'preview-external',
  'preview-size',
])

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const YAML_FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
const EXTERNAL_REFERENCE = /\b(?:href|xlink:href)\s*=\s*["']([^"']+)["']/g
const SVG_ROOT = /<svg\b[^>]*>/i
const SAFE_MARKDOWN_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:md|markdown)$/i

const stripComments = (source) => source.replace(/<!--[\s\S]*?-->/g, '')

function normalizeEntry(entry) {
  return String(entry).replace(/^\.\//, '')
}

/**
 * The files a real `npm pack` would publish, as a `Set` of package-relative
 * paths. `--ignore-scripts` keeps the probe side-effect free (no `prepack`
 * build) and `--dry-run` writes nothing.
 * @param root Package directory.
 * @returns { files } on success, or `{ error }` when npm could not answer.
 */
export function packList(root) {
  // npm writes logs and cache outside the project; point both at a directory the
  // caller owns so a read-only HOME (CI sandbox, disposable test profile) does
  // not turn a coverage probe into a spurious failure.
  const cache = process.env.DSH_DISPLAY_PACK_CACHE
  const environment = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' }
  if (cache !== undefined && cache !== '') environment.npm_config_cache = cache
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) return { error: `cannot run npm pack: ${result.error.message}` }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
    return { error: `npm pack exited ${result.status ?? 'without status'}${detail === '' ? '' : `: ${detail}`}` }
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { error: 'npm pack printed no JSON' }
  }
  const entry = Array.isArray(parsed) ? parsed[0] : undefined
  if (entry === undefined || !Array.isArray(entry.files)) return { error: 'npm pack reported no file list' }
  return { files: new Set(entry.files.map((file) => String(file.path))) }
}

function readDimensions(stripped) {
  const open = stripped.match(SVG_ROOT)
  if (open === null) return undefined
  const tag = open[0]
  const width = Number(tag.match(/\bwidth\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  const height = Number(tag.match(/\bheight\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height, viewBox: tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1] }
}

/**
 * Read a package file, or `undefined` when it does not exist.
 *
 * Containment is checked on the *real* path, so a symlink standing in for a file
 * or for any directory above it is treated as absent. npm never publishes a
 * symlink, so a linked document is not in the tarball even when it resolves here;
 * DSH applies the same realpath rule to the icon.
 * @param realRoot The package's real path, resolved once by the caller.
 */
async function readInside(realRoot, relativePath) {
  const parts = relativePath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  const target = join(realRoot, ...parts)
  let real
  try {
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined
    real = await realpath(target)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return undefined
    throw error
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return undefined
  try {
    return await readFile(real, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * Validate one package directory against the display contract.
 * @param root Package directory.
 * @param options.packedPaths The tarball's file list when the caller already has
 *   one (the release path, from its own `npm pack`). Omitted, this module asks
 *   npm itself.
 * @param options.legacyReadmeFallback The package was generated before the
 *   contract and has no detail page; defer the detail layer. The card layer and
 *   the whiteboard-registry rule still apply, and a detail page the package does
 *   ship is still validated.
 * @returns { errors, warnings } — each entry is `{ kind, message }`.
 */
export async function validateDisplay(root, { packedPaths, legacyReadmeFallback = false } = {}) {
  const errors = []
  const warnings = []
  const fail = (kind, message) => errors.push({ kind, message })
  const warn = (kind, message) => warnings.push({ kind, message })

  let realRoot
  try {
    realRoot = await realpath(root)
  } catch (cause) {
    return { errors: [{ kind: 'root', message: `cannot resolve ${root}: ${cause.message}` }], warnings }
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(realRoot, 'package.json'), 'utf8'))
  } catch (cause) {
    return { errors: [{ kind: 'manifest', message: `package.json: cannot be read (${cause.message})` }], warnings }
  }

  // The packed view is npm's, not ours. A caller that already packed passes its
  // list; everyone else asks npm for the same answer.
  let packed = packedPaths
  if (packed === undefined) {
    const probe = packList(realRoot)
    if (probe.error !== undefined) {
      fail('pack-error', `${probe.error}; cannot tell what would be published`)
      return { errors, warnings }
    }
    packed = probe.files
  }
  const ships = (target) => packed.has(target)
  const coverageHint = 'the tarball is missing it'

  // DSH resolves locale dictionaries through the Node ESM resolver, so a package
  // without the wildcard throws ERR_PACKAGE_PATH_NOT_EXPORTED, which dsh-app-boot
  // swallows into the bare package name.
  if ((manifest.exports ?? {})['./locale/*.json'] === undefined) {
    fail('locale-exports', 'package.json: exports["./locale/*.json"] is missing; DSH then silently shows the bare package name')
  }

  for (const entry of DISPLAY_LANGUAGES) {
    let locale
    const localeSource = await readInside(realRoot, entry.locale)
    if (localeSource === undefined) {
      fail('locale-missing', `${entry.locale} is missing; every plugin ships an en and a zh locale file`)
    } else {
      if (!ships(entry.locale)) fail('locale-unpublished', `${entry.locale}: ${coverageHint}`)
      try {
        locale = JSON.parse(localeSource)
      } catch {
        fail('locale-invalid', `${entry.locale} is not valid JSON`)
      }
    }

    const meta = locale?.meta
    if (locale !== undefined && (meta === null || typeof meta !== 'object' || Array.isArray(meta))) {
      fail('locale-meta', `${entry.locale}: meta must be an object carrying title, description and detail`)
      continue
    }

    if (meta !== undefined) {
      if (typeof meta.title !== 'string' || meta.title.trim() === '') {
        fail('locale-title', `${entry.locale}: meta.title must be a non-empty product name`)
      } else if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.title)) {
        warn('locale-title-slug', `${entry.locale}: meta.title ${JSON.stringify(meta.title)} looks like the package slug, not a product name`)
      }

      if (typeof meta.description !== 'string' || meta.description.trim() === '') {
        fail('locale-description', `${entry.locale}: meta.description must be a non-empty one-sentence summary`)
      } else {
        const description = meta.description.trim()
        if (description.length > DESCRIPTION_MAX_CHARS) {
          // A fleet convention (DSH clamps the subtitle to one line rather than
          // counting characters). A package that predates it keeps its existing
          // card text and gets a warning.
          const message =
            `${entry.locale}: meta.description is ${description.length} characters; ` +
            `the card subtitle budget is ${DESCRIPTION_MAX_CHARS}`
          if (legacyReadmeFallback) warn('locale-description-length', message)
          else fail('locale-description-length', message)
        }
        if (/\n/.test(description)) fail('locale-description', `${entry.locale}: meta.description must be a single line`)
        if (/[#*`[\]]|^\s*[-*] /m.test(description)) {
          fail('locale-description', `${entry.locale}: meta.description must be plain text, not Markdown`)
        }
      }
    }

    // Which document is this language's detail page?
    let detailPath
    if (meta?.detail === undefined) {
      if (legacyReadmeFallback) {
        // No detail document at all: this package's page is the README, which is
        // correct for it. The fleet audit reports the migration once.
        continue
      }
      fail(
        'detail-missing',
        `${entry.locale}: meta.detail is missing; without it DSH falls back to README.md and the card shows the whole manual`,
      )
      continue
    }
    if (typeof meta.detail !== 'string') {
      fail('detail-path', `${entry.locale}: meta.detail must be a string`)
      continue
    }
    if (meta.detail === entry.detail) {
      detailPath = entry.detail
    } else if (legacyReadmeFallback && SAFE_MARKDOWN_PATH.test(meta.detail)) {
      // A legacy package that does have a working detail page keeps it; the
      // canonical filename is a convention for new repositories, not a reason to
      // block a package that already renders correctly.
      detailPath = meta.detail
    } else {
      fail('detail-path', `${entry.locale}: meta.detail must be ${JSON.stringify(entry.detail)}`)
      continue
    }

    const detail = await readInside(realRoot, detailPath)
    if (detail === undefined) {
      fail('detail-unreadable', `${detailPath} is missing; meta.detail names it and DSH reports an invalid document without it`)
      continue
    }
    if (!ships(detailPath)) fail('detail-unpublished', `${detailPath}: ${coverageHint}`)

    const body = stripComments(detail).replace(/^\uFEFF/u, '').replace(YAML_FRONT_MATTER, '').trim()
    const images = [...body.matchAll(MARKDOWN_IMAGE)]
    if (images.length === 0) {
      fail('detail-image-count', `${detailPath}: no image reference; the detail page must be carried by one preview image`)
      continue
    }
    if (images.length > 1) {
      fail('detail-image-count', `${detailPath}: ${images.length} images; the detail page carries exactly one preview`)
      continue
    }
    const [image] = images
    const alt = image[1].trim()
    if (alt === '') fail('detail-alt', `${detailPath}: the preview image needs alt text`)
    else if (alt.length < 12) warn('detail-alt-terse', `${detailPath}: alt text ${JSON.stringify(alt)} is too terse to describe the picture`)
    const rest = body.replace(image[0], '').trim()
    if (rest !== '') {
      const lines = rest.split(/\r?\n/).filter((line) => line.trim() !== '').length
      fail(
        'detail-prose',
        `${detailPath}: ${lines} extra line(s) after the image; the detail page carries only the preview image and long-form text belongs in README.md`,
      )
    }

    // The image is resolved relative to the document that references it, which is
    // how DSH's detail-image route resolves it too.
    const documentDirectory = detailPath.split('/').slice(0, -1).join('/')
    const imagePath = normalizeEntry(image[2])
    if (imagePath.includes('..') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(imagePath) || imagePath.startsWith('/')) {
      fail('preview-missing', `${detailPath}: image ${JSON.stringify(image[2])} must stay inside the package`)
      continue
    }
    const resolvedImage = documentDirectory === '' ? imagePath : `${documentDirectory}/${imagePath}`
    if (detailPath === entry.detail && imagePath !== entry.image.split('/').at(-1)) {
      fail('detail-image-path', `${detailPath}: the image must be referenced as ${JSON.stringify(entry.image.split('/').at(-1))}`)
    }

    const imageSource = await readInside(realRoot, resolvedImage)
    if (imageSource === undefined) {
      fail('preview-missing', `${resolvedImage} is missing preview image for language ${entry.lang}`)
      continue
    }
    if (!ships(resolvedImage)) fail('preview-unpublished', `${resolvedImage}: ${coverageHint}`)

    // Comments are stripped once, and every SVG rule reads the stripped source:
    // a commented-out decoy root must not satisfy the xmlns or banner checks.
    const svg = stripComments(imageSource)
    if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(svg.match(SVG_ROOT)?.[0] ?? '')) {
      fail('preview-svg', `${resolvedImage}: the <svg> root must declare xmlns="http://www.w3.org/2000/svg"`)
    }
    const dimensions = readDimensions(svg)
    if (dimensions === undefined) {
      fail('preview-svg', `${resolvedImage}: <svg> must declare numeric width and height`)
    } else {
      if (dimensions.viewBox === undefined) fail('preview-svg', `${resolvedImage}: <svg> must declare a viewBox`)
      const aspect = dimensions.width / dimensions.height
      if (Math.abs(aspect - PREVIEW_ASPECT) > PREVIEW_ASPECT_TOLERANCE) {
        fail(
          'preview-aspect',
          `${resolvedImage}: aspect ${dimensions.width}:${dimensions.height} (${aspect.toFixed(2)}:1) is not the ` +
            `detail-banner ratio ${PREVIEW_ASPECT.toFixed(2)}:1 (640x300, or an integer multiple)`,
        )
      }
    }
    for (const match of svg.matchAll(/<([A-Za-z][A-Za-z0-9._-]*)/g)) {
      if (FORBIDDEN_ELEMENTS.includes(match[1])) {
        fail('preview-element', `${resolvedImage}: <${match[1]}> is not supported by the Feishu whiteboard parser and must not be used`)
      }
    }
    for (const match of svg.matchAll(EXTERNAL_REFERENCE)) {
      const target = match[1].trim()
      if (target.startsWith('#') || target.startsWith('data:')) continue
      fail('preview-external', `${resolvedImage}: external reference ${JSON.stringify(target)}; the preview must be self-contained`)
    }
    if (/@import|url\s*\(\s*["']?(?:https?:)?\/\//i.test(svg)) {
      fail('preview-external', `${resolvedImage}: external stylesheet or remote URL reference; the preview must be self-contained`)
    }
    if (!/<text\b/.test(svg)) warn('preview-no-text', `${resolvedImage}: no <text> elements; verify the artwork carries readable labels`)
    const bytes = Buffer.byteLength(imageSource, 'utf8')
    if (bytes > PREVIEW_MAX_BYTES) {
      fail('preview-size', `${resolvedImage}: ${bytes} bytes exceeds the ${PREVIEW_MAX_BYTES}-byte preview budget`)
    }
    if (svg.includes(PLACEHOLDER_PREVIEW_MARKER)) {
      warn('preview-placeholder', `${resolvedImage} is still the fleet placeholder; draw the real product moment before release`)
    }
  }

  // The icon is read from the manifest directory without activating the plugin.
  const icon = manifest.icon
  if (typeof icon !== 'string' || icon.trim() === '') {
    fail('icon-missing', 'package.json: a top-level icon is required (SVG, PNG, JPEG, or WebP within 256 KiB)')
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(icon) || icon.startsWith('/') || icon.split(/[/\\]/).includes('..')) {
    fail('icon-path', `package.json: icon must be a relative path inside the package: ${icon}`)
  } else {
    const iconPath = normalizeEntry(icon)
    const source = await readInside(realRoot, iconPath)
    if (source === undefined) {
      fail('icon-missing', `package.json: declared icon does not exist inside the package: ${icon}`)
    } else {
      const metadata = await lstat(join(realRoot, ...iconPath.split('/')))
      if (metadata.size > ICON_MAX_BYTES) fail('icon-size', `package.json: icon exceeds 256 KiB: ${icon}`)
      if (!ICON_EXTENSIONS.includes(extname(iconPath).toLowerCase())) {
        fail('icon-type', `package.json: icon must be SVG, PNG, JPEG, or WebP: ${icon}`)
      }
      if (!ships(iconPath)) fail('icon-unpublished', `${iconPath}: ${coverageHint}`)
      if (source.includes(PLACEHOLDER_ICON_MARKER)) {
        warn('icon-placeholder', `${iconPath} is still the fleet placeholder artwork; every user sees a generic mark`)
      }
    }
  }

  // The whiteboard registry is optional: a repository may author its previews
  // directly, and a package that never had the file has nothing to leak. When it
  // does exist, an unfilled row means the documented round trip cannot work.
  const boards = await readInside(realRoot, BOARD_REGISTRY)
  if (boards !== undefined) {
    if (/待填|待建|TODO|TBD/.test(boards)) {
      warn(
        'board-registry-unfilled',
        `${BOARD_REGISTRY} still has unfilled whiteboard rows; \`node scripts/preview.mjs push|pull\` cannot round-trip until they are recorded`,
      )
    }
    // Internal Feishu links and whiteboard tokens belong in the repository, never
    // in a published tarball. This is a security rule, so it is never deferred by
    // the legacy fallback.
    if (ships(BOARD_REGISTRY)) {
      fail(
        'board-registry-published',
        `${BOARD_REGISTRY} must not be published; add "!${BOARD_REGISTRY}" to package.json#files`,
      )
    }
  }

  return { errors, warnings }
}
