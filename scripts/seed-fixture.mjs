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
import { mkdir, writeFile } from 'node:fs/promises'
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
