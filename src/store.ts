/**
 * Durable generation store.
 *
 * The Host owns the data: one JSON index plus one file per artifact under the
 * configured data directory. Files are named after the generation id, which is a
 * random UUID, so a request path can never address a file outside the media
 * directory: the id is a random UUID and every read re-validates it with
 * {@link isStoreId} before joining a path, so a crafted id cannot escape.
 *
 * The index is written atomically (write to a temporary sibling, then rename) so
 * a crash mid-write cannot leave a half-parsed index behind. It is bounded by
 * `historyLimit`: appending past the cap evicts the oldest records together with
 * their files, which is what keeps a long-running dashboard from growing without
 * limit.
 *
 * ONE INSTANCE PER DIRECTORY: the write chain serializes mutations within a
 * single handle. Two handles opened on the same `dataDir` (two plugin rows, or a
 * restart overlapping in-flight requests) can still lose records, so the
 * directory belongs to exactly one mounted plugin.
 *
 * This module deliberately does not use the DSH storage domain: the payload is a
 * binary artifact plus a small index, and the domain's per-record JSON layout
 * would base64 the media into the log. Plain files under an owned directory keep
 * the artifact streamable and the index cheap to rewrite.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError } from './errors.js'
import { isImageMediaType } from './agnes.js'
import { mediaPathFor, type Generation, type GenerationAsset, type MediaKind } from './types.js'

/** The persisted index document. */
interface IndexFile {
  readonly version: 1
  readonly generations: Generation[]
}

/** Stored media plus its metadata, ready to stream to the browser. */
export interface StoredMedia {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly generationId: string
}

/** The store surface the route, the tools and the runtime share. */
export interface StudioStore {
  /** Read every stored generation, newest first. */
  list(): Promise<Generation[]>
  /** Append one finished generation, evicting the oldest past the cap. */
  append(generation: Generation, bytes: Uint8Array, mediaType: string): Promise<Generation>
  /** Remove one generation and its file; returns whether it existed. */
  remove(id: string): Promise<boolean>
  /** Remove every generation and its files. */
  clear(): Promise<number>
  /** Read the bytes of one stored artifact, or undefined when absent. */
  readMedia(id: string): Promise<StoredMedia | undefined>
  /** Resolve the absolute host path of one artifact, for tool hand-off. */
  mediaPath(id: string): Promise<string | undefined>
}

/** Every extension this store can write, so cleanup never misses one. */
const ALL_EXTENSIONS = ['.png', '.jpg', '.webp', '.gif', '.mp4', '.webm', '.bin'] as const

/** File extension for a media type, used only for the on-disk name. */
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
      return '.bin'
  }
}

/** Reject any id that is not the exact shape this store issues. */
export function isStoreId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
}

/** Create a generation id (a UUID v4). */
export function newGenerationId(): string {
  return randomUUID()
}

/** Open the store rooted at `dataDir`, creating the directories on demand. */
export async function openStore(dataDir: string, historyLimit: number): Promise<StudioStore> {
  const mediaDir = join(dataDir, 'media')
  const indexPath = join(dataDir, 'index.json')
  await mkdir(mediaDir, { recursive: true })

  /**
   * Serialize every index mutation.
   *
   * The index is a single document, so `read → modify → write` is a critical
   * section: two overlapping `append` calls both read the same list and the
   * second write erases the first record. A measured run of 20 concurrent
   * appends kept exactly 1 record without this chain. Mutations therefore run
   * one at a time through one promise chain; reads stay concurrent.
   */
  let writeChain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(operation, operation)
    // Keep the chain alive after a failure: one rejected write must not poison
    // every later one.
    writeChain = run.catch(() => undefined)
    return run
  }

  /** Read the index, treating a missing or corrupt file as empty. */
  const readIndex = async (): Promise<Generation[]> => {
    let text: string
    try {
      text = await readFile(indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new StudioError('storage-failed', `无法读取生成记录索引：${(error as Error).message}`)
    }
    try {
      const parsed = JSON.parse(text) as Partial<IndexFile>
      return Array.isArray(parsed.generations) ? parsed.generations.filter(isGeneration) : []
    } catch {
      // A corrupt index must not brick the dashboard: the media files are still
      // usable, so start from an empty index rather than failing every request.
      return []
    }
  }

  /** Write the index atomically. */
  const writeIndex = async (generations: Generation[]): Promise<void> => {
    const document: IndexFile = { version: 1, generations }
    const temporary = `${indexPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(document), 'utf8')
    await rename(temporary, indexPath)
  }

  /** Delete one artifact file, tolerating its absence. */
  const removeFile = async (id: string, mediaType?: string): Promise<void> => {
    const extensions = mediaType === undefined ? ALL_EXTENSIONS : [extensionFor(mediaType)]
    await Promise.all(
      extensions.map(async (extension) => {
        try {
          await rm(join(mediaDir, `${id}${extension}`), { force: true })
        } catch {
          // Best effort: a missing file is the desired end state.
        }
      }),
    )
  }

  /** Find the artifact file for one id, trying the recorded type first. */
  const findFile = async (generation: Generation): Promise<{ path: string; mediaType: string } | undefined> => {
    const recorded = generation.asset?.mediaType
    const candidates = recorded === undefined ? [] : [recorded]
    candidates.push('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'application/octet-stream')
    for (const mediaType of candidates) {
      const path = join(mediaDir, `${generation.id}${extensionFor(mediaType)}`)
      try {
        const info = await stat(path)
        if (info.isFile()) return { path, mediaType }
      } catch {
        continue
      }
    }
    return undefined
  }

  return {
    async list() {
      return readIndex()
    },

    async append(generation, bytes, mediaType) {
      // No bytes means no artifact: a failed generation is recorded for its error
      // and timing only. Inventing an `application/octet-stream` asset here would
      // write an empty file and make the panel render a broken <video> for a
      // failed image.
      const hasMedia = bytes.byteLength > 0
      const asset: GenerationAsset | undefined = hasMedia
        ? {
            src: mediaPathFor(generation.id),
            mediaType,
            bytes: bytes.byteLength,
            ...(generation.asset?.width === undefined ? {} : { width: generation.asset.width }),
            ...(generation.asset?.height === undefined ? {} : { height: generation.asset.height }),
          }
        : undefined
      // `exactOptionalPropertyTypes` means an absent asset is an ABSENT key, not
      // an explicit `undefined`.
      const stored: Generation = asset === undefined ? { ...generation } : { ...generation, asset }
      if (hasMedia) {
        // The bytes are written before the index entry: a crash in between leaves
        // an orphan file, never an index entry pointing at nothing.
        await writeFile(join(mediaDir, `${generation.id}${extensionFor(mediaType)}`), bytes)
      }
      return serialize(async () => {
        const current = await readIndex()
        const next = [stored, ...current.filter((entry) => entry.id !== stored.id)]
        const evicted = next.splice(historyLimit)
        await writeIndex(next)
        await Promise.all(evicted.map((entry) => removeFile(entry.id, entry.asset?.mediaType)))
        return stored
      })
    },

    async remove(id) {
      return serialize(async () => {
        const current = await readIndex()
        const target = current.find((entry) => entry.id === id)
        if (target === undefined) return false
        await writeIndex(current.filter((entry) => entry.id !== id))
        await removeFile(id, target.asset?.mediaType)
        return true
      })
    },

    async clear() {
      return serialize(async () => {
        const current = await readIndex()
        await writeIndex([])
        await Promise.all(current.map((entry) => removeFile(entry.id, entry.asset?.mediaType)))
        return current.length
      })
    },

    async readMedia(id) {
      if (!isStoreId(id)) return undefined
      const current = await readIndex()
      const generation = current.find((entry) => entry.id === id)
      if (generation === undefined) return undefined
      const found = await findFile(generation)
      if (found === undefined) return undefined
      const bytes = new Uint8Array(await readFile(found.path))
      return { bytes, mediaType: found.mediaType, generationId: id }
    },

    async mediaPath(id) {
      if (!isStoreId(id)) return undefined
      const current = await readIndex()
      const generation = current.find((entry) => entry.id === id)
      if (generation === undefined) return undefined
      const found = await findFile(generation)
      // Only images are handed to the model as a host path; a video path would
      // be useless to `read_image` and is never exposed.
      if (found === undefined || !isImageMediaType(found.mediaType)) return undefined
      return found.path
    },
  }
}

/** Structural check for one persisted record. */
function isGeneration(value: unknown): value is Generation {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const kind: MediaKind | undefined = record['kind'] === 'image' || record['kind'] === 'video' ? record['kind'] : undefined
  return (
    typeof record['id'] === 'string' &&
    isStoreId(record['id']) &&
    kind !== undefined &&
    (record['status'] === 'running' || record['status'] === 'succeeded' || record['status'] === 'failed') &&
    typeof record['prompt'] === 'string' &&
    typeof record['model'] === 'string' &&
    typeof record['createdAt'] === 'string'
  )
}
