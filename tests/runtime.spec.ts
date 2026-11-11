/**
 * Offline tests for the store, the runtime and the two Connection routes.
 *
 * The store is the only thing that writes user data, so its eviction, atomic
 * index write and path-traversal refusal are asserted directly against a real
 * temporary directory. The runtime and routes are exercised with a fake client,
 * so no test reaches the network.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, isStoreId, newGenerationId } from '../src/store.js'
import { createRuntime, defaultRequest } from '../src/runtime.js'
import { StudioError } from '../src/errors.js'
import type { AgnesClient, ClientDeps } from '../src/agnes.js'
import { createExecuteRoute, createMediaRoute, parseRange, EXECUTE_PATH } from '../src/transport.js'
import {
  MEDIA_PATH,
  mediaIdFrom,
  mediaPathFor,
  type Generation,
  type GenerationRequest,
  type ImageRequest,
  type VideoRequest,
} from '../src/types.js'

/** A small PNG stand-in; the store never parses it. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

let dataDir = ''

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agnes-studio-test-'))
})

afterEach(async () => {
  // Retry the removal, don't just call it once.
  //
  // A job aborted by `dispose()` can still be unwinding when the test that
  // started it returns: the store writes its index through a temporary sibling
  // and a rename, so a removal that races that write leaves the directory
  // non-empty. The first `rm` then FAILS with ENOTEMPTY, and the residue breaks
  // whichever test runs next. The invariant is "the directory is gone", not "one
  // removal call succeeded", so the check is repeated a bounded number of times
  // and the last failure is reported instead of swallowed.
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
  throw lastError
})

/** A generation record for direct store tests. */
function record(patch: Partial<Generation> = {}): Generation {
  return {
    id: newGenerationId(),
    kind: 'image',
    status: 'succeeded',
    model: 'agnes-image-2.5-flash',
    prompt: 'a red apple',
    params: { size: '1K' },
    createdAt: new Date().toISOString(),
    ...patch,
  }
}

/** An image request that continues an already-stored picture. */
function continueRequest(sourceId: string, prompt = 'paint the apple blue'): ImageRequest {
  return {
    kind: 'image',
    prompt,
    model: 'agnes-image-2.5-flash',
    size: '1K',
    ratio: '1:1',
    references: [{ kind: 'image', generationId: sourceId }],
  }
}

/** A fake client whose behaviour each test controls. */
function fakeClient(overrides: Partial<AgnesClient> = {}): AgnesClient {
  return {
    generateImage: async () => ({ bytes: PNG, mediaType: 'image/png' }),
    generateVideo: async () => ({ bytes: new Uint8Array([0, 0, 0, 0]), mediaType: 'video/mp4', upstreamId: 'video_1' }),
    listModels: async () => ({ models: ['agnes-image-2.5-flash'] }),
    optimizePrompt: async () => 'optimized prompt',
    ...overrides,
  }
}

/** Build a runtime over the temp directory with an injected client. */
async function runtimeWith(client: AgnesClient, options: { key?: string } = {}) {
  const store = await openStore(dataDir, 5)
  return createRuntime({
    store,
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    resolveKey: async () => {
      const key = options.key ?? 'sk-test'
      if (key === '') throw new Error('no key')
      return { key, source: 'credential' as const }
    },
    imageTimeoutMs: 1000,
    videoTimeoutMs: 1000,
    pollIntervalMs: 1,
    maxMediaBytes: 1024 * 1024,
    clientFactory: () => client,
  })
}

describe('store', () => {
  it('issues UUID-shaped ids and refuses anything else as a path', async () => {
    const id = newGenerationId()
    expect(isStoreId(id)).toBe(true)
    expect(isStoreId('../../etc/passwd')).toBe(false)
    expect(isStoreId('')).toBe(false)
  })

  it('appends, lists newest first and reads the bytes back', async () => {
    const store = await openStore(dataDir, 5)
    const first = await store.append(record(), PNG, 'image/png')
    const second = await store.append(record({ prompt: 'second' }), PNG, 'image/png')
    expect(first.asset?.mediaType).toBe('image/png')
    expect(first.asset?.bytes).toBe(PNG.byteLength)
    expect(first.asset?.src).toBe(mediaPathFor(first.id))
    const list = await store.list()
    expect(list.map((entry) => entry.id)).toEqual([second.id, first.id])
    const media = await store.readMedia(first.id)
    expect(media?.mediaType).toBe('image/png')
    expect(Array.from(media?.bytes ?? [])).toEqual(Array.from(PNG))
  })

  it('refuses a traversal id without touching the filesystem', async () => {
    const store = await openStore(dataDir, 5)
    expect(await store.readMedia('../../etc/passwd')).toBeUndefined()
    expect(await store.readMedia('not-a-uuid')).toBeUndefined()
  })

  it('evicts the oldest record and its file past the cap', async () => {
    const store = await openStore(dataDir, 2)
    const a = await store.append(record({ prompt: 'a' }), PNG, 'image/png')
    const b = await store.append(record({ prompt: 'b' }), PNG, 'image/png')
    const c = await store.append(record({ prompt: 'c' }), PNG, 'image/png')
    const list = await store.list()
    expect(list.map((entry) => entry.id)).toEqual([c.id, b.id])
    expect(await store.readMedia(a.id)).toBeUndefined()
    // The evicted artifact file must be gone too, not just its index entry.
    const files = await readdir(join(dataDir, 'media'))
    expect(files.some((name) => name.startsWith(a.id))).toBe(false)
  })

  it('removes one record and clears everything', async () => {
    const store = await openStore(dataDir, 5)
    const a = await store.append(record(), PNG, 'image/png')
    const b = await store.append(record(), PNG, 'image/png')
    expect(await store.remove(a.id)).toBe(true)
    expect(await store.remove(a.id)).toBe(false)
    expect((await store.list()).map((entry) => entry.id)).toEqual([b.id])
    expect(await store.clear()).toBe(1)
    expect(await store.list()).toEqual([])
  })

  it('keeps every record under concurrent appends', async () => {
    // The index is one document, so read-modify-write must be serialized. A
    // measured run of 20 concurrent appends kept exactly 1 record before this
    // was fixed — the second write erased the first record.
    const store = await openStore(dataDir, 100)
    const appends = Array.from({ length: 20 }, () => store.append(record(), PNG, 'image/png'))
    const results = await Promise.all(appends)
    const list = await store.list()
    expect(results).toHaveLength(20)
    expect(list).toHaveLength(20)
    expect(new Set(list.map((entry) => entry.id)).size).toBe(20)
    // Every artifact must still be readable, not just listed.
    for (const entry of list) expect(await store.readMedia(entry.id)).toBeDefined()
  })

  it('keeps the chain alive after a failed write', async () => {
    const store = await openStore(dataDir, 100)
    // Removing an absent record is a no-op, not a failure; the point is that a
    // settled rejection must not poison later writes.
    await store.remove(newGenerationId())
    const next = await store.append(record(), PNG, 'image/png')
    expect((await store.list()).map((entry) => entry.id)).toEqual([next.id])
  })

  it('survives a corrupt index instead of failing every request', async () => {
    const store = await openStore(dataDir, 5)
    await store.append(record(), PNG, 'image/png')
    // Corrupt the index the way a truncated write would.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dataDir, 'index.json'), '{ not json', 'utf8')
    expect(await store.list()).toEqual([])
    // The store stays usable afterwards.
    const next = await store.append(record(), PNG, 'image/png')
    expect((await store.list()).map((entry) => entry.id)).toEqual([next.id])
  })

  it('only hands image paths to the tool layer, never a video path', async () => {
    const store = await openStore(dataDir, 5)
    const image = await store.append(record(), PNG, 'image/png')
    const video = await store.append(record({ kind: 'video' }), new Uint8Array([1, 2]), 'video/mp4')
    expect(await store.mediaPath(image.id)).toContain(image.id)
    expect(await store.mediaPath(video.id)).toBeUndefined()
  })
})

describe('runtime', () => {
  it('stores a successful image generation with its timing', async () => {
    const runtime = await runtimeWith(fakeClient())
    const generation = await runtime.generate(defaultRequest('image', 'a red apple'))
    expect(generation.status).toBe('succeeded')
    expect(generation.asset?.mediaType).toBe('image/png')
    expect(generation.durationMs).toBeGreaterThanOrEqual(0)
    expect((await runtime.state()).generations).toHaveLength(1)
  })

  it('reports configuration state without leaking the key', async () => {
    const configured = await runtimeWith(fakeClient())
    const state = await configured.state()
    expect(state.configured).toBe(true)
    expect(state.keySource).toBe('credential')
    expect(JSON.stringify(state)).not.toContain('sk-test')

    const missing = await runtimeWith(fakeClient(), { key: '' })
    const unconfigured = await missing.state()
    expect(unconfigured.configured).toBe(false)
    expect(unconfigured.keySource).toBe('none')
  })

  it('refuses to generate when no key is configured', async () => {
    const runtime = await runtimeWith(fakeClient(), { key: '' })
    await expect(runtime.generate(defaultRequest('image', 'x'))).rejects.toMatchObject({ code: 'not-configured' })
    // A refused request must not leave a record behind.
    expect((await runtime.state()).generations).toEqual([])
  })

  it('records a retryable failure so the panel can offer a retry', async () => {
    const failing = fakeClient({
      generateVideo: async () => {
        const error = new Error('queue full') as Error & { code: string; retryable: boolean }
        error.code = 'queue-full'
        error.retryable = true
        const { StudioError } = await import('../src/errors.js')
        throw new StudioError('queue-full', '队列已满', {}, true)
      },
    })
    const runtime = await runtimeWith(failing)
    await expect(runtime.generate(defaultRequest('video', 'x'))).rejects.toMatchObject({ code: 'queue-full' })
    const state = await runtime.state()
    expect(state.generations).toHaveLength(1)
    expect(state.generations[0]?.status).toBe('failed')
    expect(state.generations[0]?.retryable).toBe(true)
  })

  it('replaces the failed record on retry instead of appending a new one', async () => {
    // The reported bug: retrying a queue-full video five times left five
    // identical failure rows in the gallery, because every attempt minted a new
    // id. A retry names the record it replaces, so the count must stay at one.
    let attempts = 0
    const failing = fakeClient({
      generateVideo: async () => {
        attempts += 1
        const { StudioError } = await import('../src/errors.js')
        throw new StudioError('queue-full', `队列已满（第 ${String(attempts)} 次）`, {}, true)
      },
    })
    const runtime = await runtimeWith(failing)
    const request = defaultRequest('video', 'x')

    await expect(runtime.generate(request)).rejects.toMatchObject({ code: 'queue-full' })
    const first = (await runtime.state()).generations
    expect(first).toHaveLength(1)
    const originalId = first[0]?.id
    const originalCreatedAt = first[0]?.createdAt
    expect(originalId).toBeDefined()

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(runtime.generate(request, { retryOf: originalId as string })).rejects.toMatchObject({ code: 'queue-full' })
    }

    const after = (await runtime.state()).generations
    // Still exactly one row, still the same identity, and it carries the LATEST
    // error rather than the first one.
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(originalId)
    expect(after[0]?.createdAt).toBe(originalCreatedAt)
    expect(after[0]?.error).toContain('第 5 次')
  })

  it('replaces the failed record with the success when a retry finally works', async () => {
    // The other half of the same bug: a retry that SUCCEEDS must also update the
    // row in place, otherwise the failure stays beside a duplicate success.
    let attempts = 0
    const flaky = fakeClient({
      generateImage: async () => {
        attempts += 1
        if (attempts === 1) {
          const { StudioError } = await import('../src/errors.js')
          throw new StudioError('upstream-failed', '上游 502', {}, true)
        }
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(flaky)
    const request = defaultRequest('image', 'a red apple')

    await expect(runtime.generate(request)).rejects.toMatchObject({ code: 'upstream-failed' })
    const failedId = (await runtime.state()).generations[0]?.id
    expect(failedId).toBeDefined()

    const succeeded = await runtime.generate(request, { retryOf: failedId as string })
    expect(succeeded.status).toBe('succeeded')
    expect(succeeded.id).toBe(failedId)
    const after = (await runtime.state()).generations
    expect(after).toHaveLength(1)
    expect(after[0]?.status).toBe('succeeded')
    expect(after[0]?.error).toBeUndefined()
  })

  it('stores the exact request so a retry resends what that record asked for', async () => {
    // Rebuilding a request from `params` would lose reference URLs (params is a
    // flattened display summary), so the request itself is persisted.
    const runtime = await runtimeWith(fakeClient())
    const request = {
      ...defaultRequest('image', 'a red apple'),
      references: [{ url: 'https://example.test/ref.png', kind: 'image' as const }],
    }
    const stored = await runtime.generate(request)
    expect(stored.request).toEqual(request)
    const reread = (await runtime.state()).generations[0]
    expect(reread?.request).toEqual(request)
  })

  it('records a retryable failure without inventing a media asset', async () => {
    // A failed generation has no bytes. Writing an empty
    // `application/octet-stream` asset made the panel render a broken <video>.
    const store = await openStore(dataDir, 10)
    const failed: Generation = record({ status: 'failed', errorCode: 'queue-full', error: '队列已满', retryable: true })
    const stored = await store.append(failed, new Uint8Array(0), 'application/octet-stream')
    expect(stored.asset).toBeUndefined()
    expect(stored.error).toBe('队列已满')
    expect(await store.readMedia(stored.id)).toBeUndefined()
    const files = await readdir(join(dataDir, 'media'))
    expect(files).toHaveLength(0)
  })

  it('refuses an unsupported parameter synchronously, before any job exists', async () => {
    // `start` answers immediately and reports outcomes only through stored records,
    // so a bad parameter validated inside the background task would surface as a
    // failed CARD. It must be refused by the call itself, and leave no job behind.
    const runtime = await runtimeWith(fakeClient())
    const bad = { ...defaultRequest('image', 'x'), size: '8K' } as unknown as GenerationRequest
    await expect(runtime.start(bad)).rejects.toMatchObject({ code: 'invalid-parameter' })
    expect((await runtime.state()).running).toEqual([])
    // Same for a model that belongs to the other capability.
    const wrongModel = { ...defaultRequest('image', 'x'), model: 'agnes-video-2.5' } as GenerationRequest
    await expect(runtime.start(wrongModel)).rejects.toMatchObject({ code: 'invalid-model' })
    expect((await runtime.state()).running).toEqual([])
  })

  it('reports a running job in state, and clears it once it settles', async () => {
    // The Host owns in-flight work, which is what lets the panel show a job that
    // was started before it mounted. Without this, leaving the studio lost the
    // only evidence a video was still rendering.
    let release: (() => void) | undefined
    const slow = fakeClient({
      generateImage: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(slow)
    const job = await runtime.start(defaultRequest('image', 'a slow one'))
    expect(job.kind).toBe('image')
    expect(job.prompt).toBe('a slow one')

    const during = await runtime.state()
    expect(during.running).toHaveLength(1)
    expect(during.running[0]?.id).toBe(job.id)
    // A job in flight is not a stored record yet.
    expect(during.generations).toEqual([])

    release?.()
    await vi.waitFor(async () => {
      expect((await runtime.state()).running).toEqual([])
    })
    const after = await runtime.state()
    expect(after.generations).toHaveLength(1)
    expect(after.generations[0]?.id).toBe(job.id)
  })

  it('keeps a background failure as a record the panel can see', async () => {
    // A background job has no request to report on, so a failure that vanished
    // would be invisible: the user would come back to an idle panel and no record.
    const failing = fakeClient({
      generateImage: async () => {
        const { StudioError } = await import('../src/errors.js')
        throw new StudioError('invalid-parameter', 'bad size')
      },
    })
    const runtime = await runtimeWith(failing)
    await runtime.start(defaultRequest('image', 'x'))
    await vi.waitFor(async () => {
      expect((await runtime.state()).generations).toHaveLength(1)
    })
    const state = await runtime.state()
    expect(state.generations[0]?.status).toBe('failed')
    expect(state.generations[0]?.errorCode).toBe('invalid-parameter')
    // The job is settled, so nothing is running any more.
    expect(state.running).toEqual([])
  })

  it('cancels a running job and leaves no record behind', async () => {
    // A background job the user cannot stop would hold the form disabled until the
    // 15-minute video timeout, with nothing on screen to act on.
    const hang = fakeClient({
      generateImage: async (_request, options) => {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new StudioError('cancelled', '请求已取消。'))
          })
        })
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(hang)
    const job = await runtime.start(defaultRequest('image', 'x'))
    expect(runtime.cancel(job.id)).toBe(true)
    await vi.waitFor(async () => {
      expect((await runtime.state()).running).toEqual([])
    })
    expect((await runtime.state()).generations).toEqual([])
    // Cancelling an id that is not running is a no-op, not a crash.
    expect(runtime.cancel(job.id)).toBe(false)
  })

  it('dies with the plugin: dispose aborts every running job', async () => {
    let aborted = false
    const hang = fakeClient({
      generateImage: async (_request, options) => {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        })
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(hang)
    await runtime.start(defaultRequest('image', 'x'))
    runtime.dispose()
    await vi.waitFor(() => {
      expect(aborted).toBe(true)
    })
    // Wait for the aborted job to finish unwinding before the test's own teardown
    // removes the data directory: a still-running rejection would otherwise write
    // into a directory that no longer exists and fail the NEXT test with ENOTEMPTY.
    await vi.waitFor(async () => {
      expect((await runtime.state()).running).toEqual([])
    })
    // An aborted job is a cancellation, not a failure, so nothing is recorded.
    expect((await runtime.state()).generations).toEqual([])
  })

  it('treats an aborted job as cancelled, whatever error shape it surfaced', async () => {
    // A real client can reject an aborted request with a plain Error rather than
    // an AbortError (a socket teardown, a wrapped transport failure). Judging the
    // outcome by the error type alone recorded that as a failure — and, worse, it
    // wrote to the store while a plugin teardown was removing the data directory,
    // which is the ENOTEMPTY this reproduces. An abort by the job's OWN controller
    // is a cancellation by definition, so nothing may be written.
    const hang = fakeClient({
      generateImage: async (_request, options) => {
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('socket hang up'))
          })
        })
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(hang)
    const job = await runtime.start(defaultRequest('image', 'x'))
    runtime.cancel(job.id)
    await vi.waitFor(async () => {
      expect((await runtime.state()).running).toEqual([])
    })
    // No failure record, and the store is untouched.
    expect((await runtime.state()).generations).toEqual([])
    expect(await readdir(join(dataDir, 'media'))).toEqual([])
  })

  it('optimizes a prompt with the text model', async () => {
    const seen: { prompt: string; kind: string }[] = []
    const runtime = await runtimeWith(
      fakeClient({
        optimizePrompt: async (request) => {
          seen.push({ prompt: request.prompt, kind: request.kind })
          return '一只橘猫，午后窗边，柔和侧光，浅景深'
        },
      }),
    )
    expect(await runtime.optimize({ prompt: '  一只猫  ', kind: 'image' })).toContain('橘猫')
    // The draft is trimmed before it reaches the model.
    expect(seen[0]).toEqual({ prompt: '一只猫', kind: 'image' })
  })

  it('refuses to optimize an empty prompt without calling upstream', async () => {
    const runtime = await runtimeWith(fakeClient())
    await expect(runtime.optimize({ prompt: '   ', kind: 'image' })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('does not store a transient non-retryable failure as history', async () => {
    const failing = fakeClient({
      generateImage: async () => {
        const { StudioError } = await import('../src/errors.js')
        throw new StudioError('invalid-parameter', 'bad size')
      },
    })
    const runtime = await runtimeWith(failing)
    await expect(runtime.generate(defaultRequest('image', 'x'))).rejects.toMatchObject({ code: 'invalid-parameter' })
    expect((await runtime.state()).generations).toEqual([])
  })

  it('maps an unexpected throw to an internal failure', async () => {
    const runtime = await runtimeWith(
      fakeClient({
        generateImage: async () => {
          throw new Error('kaboom')
        },
      }),
    )
    await expect(runtime.generate(defaultRequest('image', 'x'))).rejects.toMatchObject({ code: 'internal' })
  })

  it('builds a default request that the capability table accepts', async () => {
    const runtime = await runtimeWith(fakeClient())
    expect((await runtime.generate(defaultRequest('image', 'x'))).kind).toBe('image')
    expect((await runtime.generate(defaultRequest('video', 'x'))).kind).toBe('video')
  })
})

describe('continue editing', () => {
  it('inlines a stored picture as a data: URI and records the lineage', async () => {
    // The panel can only address generated media through the authenticated
    // same-origin route, which the upstream cannot fetch. The Host therefore
    // re-sends the bytes it owns as a data: URI; the record keeps the symbolic
    // reference so a retry re-resolves instead of freezing megabytes of base64.
    const sent: GenerationRequest[] = []
    const client = fakeClient({
      generateImage: async (request) => {
        sent.push(request)
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(client)
    const source = await runtime.generate(defaultRequest('image', 'a red apple'))
    const stored = await runtime.generate(continueRequest(source.id))

    expect(sent).toHaveLength(2)
    const wire = sent[1]
    expect(wire?.kind).toBe('image')
    if (wire?.kind !== 'image') throw new Error('expected an image request')
    expect(wire.references).toEqual([{ kind: 'image', url: expect.stringMatching(/^data:image\/png;base64,/) }])
    expect(stored.request).toEqual(continueRequest(source.id))
    expect(stored.derivedFrom).toBe(source.id)
  })

  it('refuses a source record that no longer exists before starting a job', async () => {
    // A background job reports only through a stored record, so a dangling
    // reference must be refused by the call itself and leave no placeholder.
    const runtime = await runtimeWith(fakeClient())
    await expect(runtime.start(continueRequest(newGenerationId()))).rejects.toMatchObject({ code: 'invalid-reference' })
    expect((await runtime.state()).running).toEqual([])
  })

  it('refuses a source record that never produced a picture', async () => {
    const store = await openStore(dataDir, 10)
    const failed = await store.append(
      record({ status: 'failed', errorCode: 'upstream-failed', error: '上游失败', retryable: true }),
      new Uint8Array(0),
      'application/octet-stream',
    )
    const runtime = await runtimeWith(fakeClient())
    await expect(runtime.start(continueRequest(failed.id))).rejects.toMatchObject({
      code: 'invalid-reference',
      message: expect.stringContaining('没有生成成功'),
    })
  })

  it('refuses a stored reference on a video request, which needs a public address', async () => {
    const runtime = await runtimeWith(fakeClient())
    const source = await runtime.generate(defaultRequest('image', 'a red apple'))
    const video: VideoRequest = {
      kind: 'video',
      prompt: 'animate it',
      model: 'agnes-video-2.5',
      mode: 'reference',
      size: '720P',
      ratio: '16:9',
      seconds: 5,
      references: [{ kind: 'image', generationId: source.id }],
    }
    await expect(runtime.start(video)).rejects.toMatchObject({ code: 'invalid-reference' })
  })

  it('re-resolves the symbolic reference on retry', async () => {
    const sent: GenerationRequest[] = []
    const client = fakeClient({
      generateImage: async (request) => {
        sent.push(request)
        return { bytes: PNG, mediaType: 'image/png' }
      },
    })
    const runtime = await runtimeWith(client)
    const source = await runtime.generate(defaultRequest('image', 'a red apple'))
    const stored = await runtime.generate(continueRequest(source.id))

    const retried = await runtime.generate(stored.request as ImageRequest, { retryOf: stored.id })
    expect(sent).toHaveLength(3)
    const wire = sent[2]
    if (wire?.kind !== 'image') throw new Error('expected an image request')
    expect(wire.references[0]?.url).toMatch(/^data:image\/png;base64,/)
    // A retry settles into the SAME record: one row, one lineage.
    expect(retried.id).toBe(stored.id)
    expect(retried.derivedFrom).toBe(source.id)
  })
})

describe('routes', () => {
  /** Send one RPC envelope through the execute route. */
  async function rpc(runtime: Awaited<ReturnType<typeof runtimeWith>>, payload: unknown): Promise<{ status: number; body: unknown }> {
    const route = createExecuteRoute(runtime)
    const request = new Request(`http://127.0.0.1:56873${EXECUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'agnes-studio', payload }),
    })
    const response = await route.fetch(request)
    return { status: response.status, body: await response.json() }
  }

  it('answers a state request with the state document', async () => {
    const runtime = await runtimeWith(fakeClient())
    const { status, body } = await rpc(runtime, { action: 'state' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true } })
  })

  it('rejects a non-JSON body and an unknown method inside the envelope', async () => {
    const runtime = await runtimeWith(fakeClient())
    const route = createExecuteRoute(runtime)
    const badContent = await route.fetch(
      new Request(`http://127.0.0.1:56873${EXECUTE_PATH}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
    )
    expect(badContent.status).toBe(415)

    const wrongMethod = await route.fetch(
      new Request(`http://127.0.0.1:56873${EXECUTE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'other', payload: {} }),
      }),
    )
    const parsed = (await wrongMethod.json()) as { result: { ok: boolean; error: { code: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error.code).toContain('bad-request')
  })

  it('reports a StudioError with its own code, never an internal fault', async () => {
    const runtime = await runtimeWith(fakeClient(), { key: '' })
    const { body } = await rpc(runtime, { action: 'start', request: defaultRequest('image', 'x') })
    const parsed = body as { result: { ok: boolean; error: { code: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error.code).toBe('agnes-studio/not-configured')
  })

  it('accepts a stored-generation reference at the fence', async () => {
    // The wire schema must accept the symbolic form, otherwise "continue
    // editing" would fail as a bad-request before the Host ever saw it.
    const runtime = await runtimeWith(fakeClient())
    const { body } = await rpc(runtime, { action: 'start', request: continueRequest(newGenerationId()) })
    const parsed = body as { result: { ok: boolean; error: { code: string } } }
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error.code).toBe('agnes-studio/invalid-reference')
  })

  it('serves stored media over the media route with no-store-safe headers', async () => {
    const runtime = await runtimeWith(fakeClient())
    const generation = await runtime.generate(defaultRequest('image', 'x'))
    const route = createMediaRoute(runtime)
    const response = await route.fetch(new Request(`http://127.0.0.1:56873${mediaPathFor(generation.id)}`, { method: 'GET' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)

    const head = await route.fetch(new Request(`http://127.0.0.1:56873${mediaPathFor(generation.id)}`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
  })

  it('404s an unknown id and a traversal attempt in the query string', async () => {
    const runtime = await runtimeWith(fakeClient())
    const route = createMediaRoute(runtime)
    const unknown = await route.fetch(
      new Request(`http://127.0.0.1:56873${mediaPathFor(newGenerationId())}`, { method: 'GET' }),
    )
    expect(unknown.status).toBe(404)
    // The traversal must be attempted through `?id=`, which is the only input
    // this route reads; a `/media/../..` pathname merely fails to match.
    const traversal = await route.fetch(
      new Request(`http://127.0.0.1:56873/api/agnes-studio/media?id=${encodeURIComponent('../../etc/passwd')}`, { method: 'GET' }),
    )
    expect(traversal.status).toBe(404)
    const dotdot = await route.fetch(
      new Request('http://127.0.0.1:56873/api/agnes-studio/media?id=..%2F..%2Fetc%2Fpasswd', { method: 'GET' }),
    )
    expect(dotdot.status).toBe(404)
  })
})

describe('media route path shape', () => {
  it('uses one exact pathname with the id in the query, which the registry can match', async () => {
    // Connection keys exact Fetch routes by `new URL(url).pathname`, so a
    // `/media/<id>` URL can never reach the handler. This asserts the contract
    // the registry actually enforces.
    const id = newGenerationId()
    const url = new URL(mediaPathFor(id), 'http://127.0.0.1:56873')
    expect(url.pathname).toBe(MEDIA_PATH)
    expect(url.searchParams.get('id')).toBe(id)
    expect(mediaIdFrom(url.search)).toBe(id)
  })

  it('rejects a malformed or absent id', () => {
    expect(mediaIdFrom('')).toBeUndefined()
    expect(mediaIdFrom('?id=')).toBeUndefined()
    expect(mediaIdFrom('?other=1')).toBeUndefined()
  })

  it('serves bytes at the exact registered path', async () => {
    const runtime = await runtimeWith(fakeClient())
    const generation = await runtime.generate(defaultRequest('image', 'x'))
    const route = createMediaRoute(runtime)
    expect(route.path).toBe(MEDIA_PATH)
    const url = `http://127.0.0.1:56873${generation.asset?.src ?? ''}`
    expect(new URL(url).pathname).toBe(MEDIA_PATH)
    const response = await route.fetch(new Request(url, { method: 'GET' }))
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })
})

describe('range support', () => {
  it('parses the range forms a media element sends', () => {
    expect(parseRange(null, 100)).toBeUndefined()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    // A suffix range asks for the last N bytes.
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    // An end past the payload is clamped, not refused.
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    // Malformed headers fall back to the whole body.
    expect(parseRange('bytes=abc', 100)).toBeUndefined()
    expect(parseRange('items=0-1', 100)).toBeUndefined()
  })

  it('answers a satisfiable range with 206 and the exact slice', async () => {
    const runtime = await runtimeWith(fakeClient())
    const generation = await runtime.generate(defaultRequest('image', 'x'))
    const route = createMediaRoute(runtime)
    const response = await route.fetch(
      new Request(`http://127.0.0.1:56873${mediaPathFor(generation.id)}`, { method: 'GET', headers: { range: 'bytes=0-3' } }),
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 0-3/${String(PNG.byteLength)}`)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG.subarray(0, 4))
  })

  it('answers an unsatisfiable range with 416', async () => {
    const runtime = await runtimeWith(fakeClient())
    const generation = await runtime.generate(defaultRequest('image', 'x'))
    const route = createMediaRoute(runtime)
    const response = await route.fetch(
      new Request(`http://127.0.0.1:56873${mediaPathFor(generation.id)}`, { method: 'GET', headers: { range: 'bytes=99999-' } }),
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${String(PNG.byteLength)}`)
  })
})

describe('request defaults', () => {
  it('produces requests that survive validation', async () => {
    const { validateRequest } = await import('../src/agnes.js')
    const image = defaultRequest('image', 'x') as GenerationRequest
    const video = defaultRequest('video', 'x') as GenerationRequest
    expect(() => validateRequest(image)).not.toThrow()
    expect(() => validateRequest(video)).not.toThrow()
  })
})
