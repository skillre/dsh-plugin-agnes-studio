/**
 * Seed one deterministic generation into an owned test profile's data directory.
 *
 * The browser check has to click "打开原图" (open original), which only renders for
 * a record that already has an image asset. Producing that record by calling the
 * live Agnes API would make the UI check depend on network, credentials, quota
 * and generation latency — a flaky test that proves nothing about the client. So
 * the fixture writes exactly what the Host's store writes: one index entry plus
 * one PNG file under `<dataDir>/media/`.
 *
 * The PNG is generated here rather than checked in: a binary fixture in the
 * repository is one more thing to keep honest, and a 96x96 image with a grid and
 * a ring is enough to see that zoom and pan actually move something.
 *
 * This is a development harness detail. It never ships and never touches a user
 * profile: the caller passes a directory it created and owns.
 */

import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The generation id the UI check looks for. A literal UUID, because the store validates the shape. */
export const FIXTURE_ID = '3f2b6c1e-9a4d-4c8b-9f61-2d7e5a0b4c33'

/** CRC-32, as PNG requires for every chunk. */
function crc32(bytes) {
  let table = crc32.table
  if (table === undefined) {
    table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1
      table[index] = value >>> 0
    }
    crc32.table = table
  }
  let crc = 0xff_ff_ff_ff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}

/** One PNG chunk: length, type, payload, CRC. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * A square RGB PNG: a light gradient, a dark grid and a ring.
 *
 * The grid makes 1x→2x obvious (lines get thicker and further apart) and the
 * ring gives the pan drag a visible landmark, so a broken transform cannot pass
 * by looking like a plain photo that simply did not move much.
 *
 * The default size is deliberately larger than the gallery thumbnail (168px) and
 * close to a real 1K render: a 96px fixture would be shown at its natural size
 * inside the viewer and prove nothing about zooming into detail.
 */
export function fixturePng(size = 512) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  const centre = (size - 1) / 2
  const radius = size * 0.31
  const step = Math.max(4, Math.round(size / 8))
  const ringWidth = Math.max(1.6, size / 60)
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3
      const grid = x % step === 0 || y % step === 0
      const ring = Math.abs(Math.hypot(x - centre, y - centre) - radius) < ringWidth
      raw[at] = grid ? 38 : ring ? 244 : Math.round((255 * x) / (size - 1))
      raw[at + 1] = grid ? 38 : ring ? 92 : Math.round((255 * y) / (size - 1))
      raw[at + 2] = grid ? 38 : ring ? 58 : 205
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Write one finished image generation into `dataDir`.
 *
 * Mirrors `src/store.ts`: `<dataDir>/index.json` holding
 * `{ version: 1, generations: [...] }` and `<dataDir>/media/<id>.png`. The asset
 * `src` is the authenticated same-origin media path the panel actually requests,
 * so the `<img>` loads through the real Host route rather than a data URI — that
 * is the path whose authentication the lightbox must survive.
 *
 * @returns the seeded record, for the caller's log line.
 */
export async function seedImageGeneration(dataDir, options = {}) {
  const { id = FIXTURE_ID, prompt = '灯箱验收用图：网格 + 圆环', model = 'agnes-image-2.5-flash', size = 512 } = options
  const mediaDir = join(dataDir, 'media')
  await mkdir(mediaDir, { recursive: true })
  const png = fixturePng(size)
  await writeFile(join(mediaDir, `${id}.png`), png)
  const generation = {
    id,
    kind: 'image',
    status: 'succeeded',
    model,
    prompt,
    params: { size: '1K', ratio: '1:1', references: 0 },
    createdAt: new Date('2026-11-11T00:00:00.000Z').toISOString(),
    finishedAt: new Date('2026-11-11T00:00:12.000Z').toISOString(),
    durationMs: 12_000,
    asset: {
      src: `/api/agnes-studio/media?id=${encodeURIComponent(id)}`,
      mediaType: 'image/png',
      bytes: png.length,
      // The declared dimensions must match the real bytes: the panel and the
      // viewer both trust this field, and a mismatch is invisible until layout.
      width: size,
      height: size,
    },
  }
  await writeFile(join(dataDir, 'index.json'), JSON.stringify({ version: 1, generations: [generation] }), 'utf8')
  return generation
}

/** The second image id, used by the viewer-navigation checks. */
export const SECOND_FIXTURE_ID = '8c41d7a2-5e3b-4f19-a872-6b0d9c4e1f57'

/**
 * Seed two finished images, so the viewer's prev/next navigation is reachable.
 *
 * One picture cannot exercise a sequence: with a single record the panel
 * deliberately renders no arrows at all. The second record also carries a
 * different aspect ratio and prompt so a navigation bug (showing the wrong
 * picture, or keeping the previous zoom) is visible rather than plausible.
 */
export async function seedTwoImageGenerations(dataDir, options = {}) {
  const { size = 512 } = options
  const first = await seedImageGeneration(dataDir, options)
  const mediaDir = join(dataDir, 'media')
  const png = fixturePng(size)
  await writeFile(join(mediaDir, `${SECOND_FIXTURE_ID}.png`), png)
  const second = {
    ...first,
    id: SECOND_FIXTURE_ID,
    prompt: '灯箱验收用图二：另一张，用于切换',
    createdAt: new Date('2026-11-11T00:00:20.000Z').toISOString(),
    finishedAt: new Date('2026-11-11T00:00:31.000Z').toISOString(),
    durationMs: 11_000,
    asset: {
      ...first.asset,
      src: `/api/agnes-studio/media?id=${encodeURIComponent(SECOND_FIXTURE_ID)}`,
      bytes: png.length,
      width: size,
      height: size,
    },
  }
  await writeFile(
    join(dataDir, 'index.json'),
    JSON.stringify({ version: 1, generations: [second, first] }),
    'utf8',
  )
  return { first, second }
}

/** The failure id the retry check looks for. */
export const FAILED_FIXTURE_ID = 'd5c9a1f4-2b7e-4e63-b0a8-6f3d1c2e9a70'

/**
 * Append one retryable failure to an existing index.
 *
 * The browser check for the retry path needs a record whose stored request the
 * Host can replay — `retry` refuses a record without one, so a synthesised
 * "failed" card without a body would prove nothing. Writing this AFTER the
 * harness's own seeding keeps every earlier card-count assertion in the driver
 * exact, which is why the caller does it at the very end of the run and then
 * reloads the page.
 *
 * The request is a plain image prompt on the free Flash model: when the driver
 * clicks 重试, the Host really runs it, so the check observes the real in-place
 * progress state instead of a mocked one.
 */
export async function appendFailedGeneration(dataDir, options = {}) {
  const {
    id = FAILED_FIXTURE_ID,
    prompt = '重试验收用图：白色桌面上的红苹果',
    model = 'agnes-image-2.5-flash',
  } = options
  const indexPath = join(dataDir, 'index.json')
  const existing = JSON.parse(await readFile(indexPath, 'utf8'))
  const now = new Date()
  const generation = {
    id,
    kind: 'image',
    status: 'failed',
    model,
    prompt,
    params: { model, size: '1K', ratio: '1:1', references: 0 },
    createdAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 4_200,
    errorCode: 'timeout',
    error: '上游超时：这条记录稍后重试即可。',
    retryable: true,
    // `params` is a display summary; the request is what the Host replays, so it
    // must carry the full parameter set exactly as a real record does.
    request: { kind: 'image', prompt, model, size: '1K', ratio: '1:1', references: [] },
  }
  await writeFile(
    indexPath,
    JSON.stringify({ version: 1, generations: [generation, ...existing.generations] }),
    'utf8',
  )
  return generation
}

/**
 * Seed a DEEP lineage: one root plus `count - 1` continuations.
 *
 * The version stack has to stay usable for a real chain — a rail that clips, a
 * peek budget that grows unbounded, or a scrub band that skips versions all show
 * up here and nowhere else, because the interactive suite would otherwise only
 * ever see a chain of two.
 */
export async function seedChain(dataDir, count = 6, options = {}) {
  const { size = 512 } = options
  const mediaDir = join(dataDir, 'media')
  await mkdir(mediaDir, { recursive: true })
  const png = fixturePng(size)
  const generations = []
  let parent
  for (let index = 0; index < count; index += 1) {
    // A real hex UUID shape: the Host re-validates every media id with the same
    // pattern (see isStoreId in src/store.ts), and a fixture id that fails it
    // renders a card with no picture and a broken stack.
    const id = `0000000${index}-0000-4000-8000-00000000000${index}`
    await writeFile(join(mediaDir, `${id}.png`), png)
    const createdAt = new Date(Date.parse('2026-11-11T00:00:00.000Z') + index * 60_000).toISOString()
    const generation = {
      id,
      kind: 'image',
      status: 'succeeded',
      model: 'agnes-image-2.5-flash',
      // A per-version prompt, so "which version is showing" is readable in a
      // screenshot as well as in the DOM.
      prompt: `链条第 ${String(index + 1)} 版`,
      params: { size: '1K', ratio: '1:1', references: index === 0 ? 0 : 1 },
      createdAt,
      finishedAt: createdAt,
      durationMs: 12_000,
      asset: { src: `/api/agnes-studio/media?id=${encodeURIComponent(id)}`, mediaType: 'image/png', bytes: png.length, width: size, height: size },
      ...(parent === undefined
        ? {}
        : {
            derivedFrom: parent,
            request: {
              kind: 'image',
              prompt: `链条第 ${String(index + 1)} 版`,
              model: 'agnes-image-2.5-flash',
              size: '1K',
              ratio: '1:1',
              references: [{ kind: 'image', generationId: parent }],
            },
          }),
    }
    generations.unshift(generation)
    parent = id
  }
  await writeFile(join(dataDir, 'index.json'), JSON.stringify({ version: 1, generations }), 'utf8')
  return generations
}
