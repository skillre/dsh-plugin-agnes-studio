#!/usr/bin/env node
// Preview-image checks for one plugin repository.
//
// This is the offline half of the display contract (see the fleet's
// docs/display-contract.md). All of the rules live in `display-contract.mjs`,
// which `scripts/prepare-release.mjs` and the fleet audit import too, so a
// repository check and a publication check cannot drift apart.
//
// The Lark whiteboard is one way to author the preview, never a requirement:
// `push` and `pull` round-trip through it and are deliberately NOT part of
// `npm run check`.

import { readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DISPLAY_LANGUAGES, validateDisplay } from './display-contract.mjs'

const ROOT = process.cwd()

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    lang: { type: 'string' },
    root: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})

const command = positionals[0] ?? 'check'

function report({ errors, warnings }) {
  for (const entry of warnings) process.stderr.write(`WARN preview: ${entry.message}\n`)
  if (errors.length > 0) {
    for (const entry of errors) process.stderr.write(`FAIL preview: ${entry.message}\n`)
    process.stderr.write(`preview: ${errors.length} error(s), ${warnings.length} warning(s).\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`preview: OK (${warnings.length} warning(s)).\n`)
}

async function check(root) {
  const result = await validateDisplay(root)
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ root, ...result }, null, 2)}\n`)
    process.exitCode = result.errors.length > 0 ? 1 : 0
    return
  }
  report(result)
}

// ---------------------------------------------------------------------------
// Lark round-trip. The editing source of truth lives on a Feishu whiteboard;
// these commands only move the SVG between the board and docs/.

const BOARD_FILE = 'docs/PREVIEW.md'

async function readBoards(root) {
  let source
  try {
    source = await readFile(join(root, BOARD_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${BOARD_FILE} is missing; it records each language's whiteboard`)
    throw error
  }
  const boards = new Map()
  // The registry is a Markdown table whose last cell is the whiteboard token,
  // so the column count stays flexible (doc URL, notes, …) while the language
  // id is always first.
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    const lang = cells[0].replace(/`/g, '').trim()
    if (!/^[a-z]{2}$/.test(lang)) continue
    const token = cells.at(-1).replace(/`/g, '').trim()
    if (!/^[A-Za-z0-9]+$/.test(token)) continue
    boards.set(lang, token)
  }
  if (boards.size === 0) throw new Error(`${BOARD_FILE}: no "| lang | ... | token |" rows found`)
  return boards
}

function runLark(root, args) {
  // Resolve against the package being worked on, not the caller's cwd, so
  // `--root` means the same thing for check, push and pull.
  const result = spawnSync('lark-cli', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw new Error(`cannot run lark-cli: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`lark-cli exited ${result.status}: ${result.stderr.trim()}`)
  let answer
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    throw new Error(`lark-cli printed no JSON: ${result.stdout.slice(0, 400)}`)
  }
  if (answer.ok !== true) {
    throw new Error(`lark-cli refused: ${answer.error?.message ?? JSON.stringify(answer.error ?? answer)}`)
  }
  return answer.data
}

async function boardFor(root, lang) {
  const boards = await readBoards(root)
  const token = boards.get(lang)
  if (token === undefined) throw new Error(`no whiteboard recorded for language ${lang} in ${BOARD_FILE}`)
  const entry = DISPLAY_LANGUAGES.find((candidate) => candidate.lang === lang)
  return { token, entry }
}

// The board owns its own canvas: an export comes back at whatever size the
// whiteboard happens to be, which is not the 640x300 detail-banner ratio. A
// pulled file is therefore refitted into the contract canvas instead of
// rejecting it, so editing on the board stays the normal workflow.
const CONTRACT_WIDTH = 640
const CONTRACT_HEIGHT = 300
const CONTRACT_SCALE = 2

// The largest axis-aligned rect in a drawing, used as the artboard when a
// board export pads its canvas. Reads the flat coordinate attributes the board
// writes; a rect inside a nested transform is not considered.
function largestRect(source) {
  let best
  for (const match of source.matchAll(/<rect\b[^>]*>/g)) {
    const tag = match[0]
    const x = Number(tag.match(/\bx\s*=\s*["']([-0-9.]+)/)?.[1] ?? 0)
    const y = Number(tag.match(/\by\s*=\s*["']([-0-9.]+)/)?.[1] ?? 0)
    const width = Number(tag.match(/\bwidth\s*=\s*["']([0-9.]+)/)?.[1])
    const height = Number(tag.match(/\bheight\s*=\s*["']([0-9.]+)/)?.[1])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue
    if (width <= 0 || height <= 0) continue
    if (best === undefined || width * height > best.width * best.height) best = { x, y, width, height }
  }
  return best
}

function normalizePreview(source) {
  const root = source.match(/<svg\b[^>]*>/i)
  if (root === null) throw new Error('the export has no <svg> root')
  const tag = root[0]
  const openEnd = source.indexOf('>', source.indexOf(root[0])) + 1
  const closeStart = source.lastIndexOf('</svg>')
  if (closeStart < openEnd) throw new Error('the export has no closing </svg>')

  const viewBox = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
  const width = Number(tag.match(/\bwidth\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  const height = Number(tag.match(/\bheight\s*=\s*["']([0-9.]+)(?:px)?["']/i)?.[1])
  let box
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value)) || parts[2] <= 0 || parts[3] <= 0) {
      throw new Error(`the export has an unusable viewBox ${JSON.stringify(viewBox)}`)
    }
    box = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  } else if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    box = { x: 0, y: 0, width, height }
  } else {
    throw new Error('the export declares neither a usable viewBox nor numeric width and height')
  }

  const inner = source.slice(openEnd, closeStart).trim()
  if (inner === '') throw new Error('the export carries no drawing')

  // The board pads its canvas around the drawing (a 1280x600 artwork comes back
  // as a 1448x800 viewBox with negative offsets). Cropping to the artboard rect
  // keeps the pulled banner full-bleed instead of letterboxed inside the
  // contract canvas. The artboard is the largest rect the export carries.
  const artboard = largestRect(inner)
  if (artboard !== undefined && artboard.width > 0 && artboard.height > 0) {
    box = { x: artboard.x, y: artboard.y, width: artboard.width, height: artboard.height }
  }

  const targetWidth = CONTRACT_WIDTH * CONTRACT_SCALE
  const targetHeight = CONTRACT_HEIGHT * CONTRACT_SCALE
  const scale = Math.min(targetWidth / box.width, targetHeight / box.height)
  const translateX = (targetWidth - box.width * scale) / 2 - box.x * scale
  const translateY = (targetHeight - box.height * scale) / 2 - box.y * scale

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${targetHeight}" ` +
    `viewBox="0 0 ${targetWidth} ${targetHeight}">\n` +
    `<g transform="translate(${translateX.toFixed(2)}, ${translateY.toFixed(2)}) scale(${scale.toFixed(4)})">\n` +
    `${inner}\n</g>\n</svg>\n`
  )
}

async function push(root, lang) {
  const { token, entry } = await boardFor(root, lang)
  const result = await validateDisplay(root)
  if (result.errors.length > 0) {
    throw new Error(`refusing to push an invalid preview:\n  ${result.errors.map((item) => item.message).join('\n  ')}`)
  }
  runLark(root, [
    'whiteboard', '+update',
    '--whiteboard-token', token,
    '--input_format', 'svg',
    '--source', `@${entry.image}`,
    '--overwrite',
    '--as', 'bot',
  ])
  process.stdout.write(`pushed ${entry.image} to whiteboard ${token} (the board was rebuilt)\n`)
}

async function pull(root, lang) {
  const { token, entry } = await boardFor(root, lang)
  const temporary = `${entry.image}.export.svg`
  runLark(root, [
    'whiteboard', '+export',
    '--whiteboard-token', token,
    '--output-type', 'svg',
    '--output', `./${temporary}`,
    '--overwrite',
    '--as', 'bot',
  ])
  const exported = await readFile(join(root, ...temporary.split('/')), 'utf8')
  let normalized
  try {
    normalized = normalizePreview(exported)
  } finally {
    await rm(join(root, ...temporary.split('/')), { force: true })
  }
  await writeFile(join(root, ...entry.image.split('/')), normalized)
  const result = await validateDisplay(root)
  for (const item of result.warnings) process.stderr.write(`WARN preview: ${item.message}\n`)
  if (result.errors.length > 0) {
    throw new Error(
      `the exported board does not satisfy the preview contract:\n  ${result.errors.map((item) => item.message).join('\n  ')}`,
    )
  }
  process.stdout.write(
    `pulled whiteboard ${token} into ${entry.image} (refitted to the ${CONTRACT_WIDTH}x${CONTRACT_HEIGHT} banner)\n`,
  )
}

try {
  const root = values.root === undefined ? ROOT : values.root
  if (command === 'check') {
    await check(root)
  } else if (command === 'push' || command === 'pull') {
    const lang = values.lang ?? 'zh'
    if (!DISPLAY_LANGUAGES.some((entry) => entry.lang === lang)) throw new Error('--lang must be en or zh')
    await (command === 'push' ? push(root, lang) : pull(root, lang))
  } else {
    throw new Error(`unknown command ${JSON.stringify(command)}; expected check, push or pull`)
  }
} catch (error) {
  process.stderr.write(`preview: ${error.message}\n`)
  process.exit(1)
}
