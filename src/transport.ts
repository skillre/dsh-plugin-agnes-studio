/**
 * Host ↔ Client transport: one exact Fetch route for RPC and one for media.
 *
 * Connection owns the Host/Origin check, the browser-session authentication and
 * the Peer scope; this module registers two exact `POST`/`GET` routes under
 * `/api` and only validates its own envelope and payload. No physical server,
 * no Express, and no second RPC channel is claimed.
 *
 * Media is served from its own GET route rather than embedded as Base64 in the
 * RPC value: a 4K PNG or a 12-second video would bloat every state response, and
 * a same-origin URL lets the browser stream, cache and range-request it. The
 * route requires the same authenticated Connection fence, so generated media is
 * not world-readable.
 */

import { z } from 'zod'
import { StudioError } from './errors.js'
import { ENDPOINT, MEDIA_PATH, mediaIdFrom } from './types.js'
import type { StudioRequest, StudioResult } from './types.js'
import type { StudioRuntime } from './runtime.js'

/** Path of the exact RPC route, under the shared `/api` channel. */
export const EXECUTE_PATH = `/api/${ENDPOINT}`

/** One buffered exact Fetch route as the Connection registry accepts it. */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** The Host Connection face this plugin depends on. */
export interface HostConnection {
  readonly fetch: { register(route: FetchRoute): () => Promise<void> }
}

/** The wire envelope Connection's browser RPC caller sends. */
const envelopeSchema = z.object({
  type: z.literal('client-request'),
  rpcId: z.string(),
  method: z.string(),
  payload: z.unknown(),
})

const referenceSchema = z
  .object({
    url: z.string().min(1).max(2_000_000),
    kind: z.enum(['image', 'video', 'audio']),
  })
  .strict()

const imageRequestSchema = z
  .object({
    kind: z.literal('image'),
    prompt: z.string().min(1).max(4000),
    model: z.string().min(1).max(120),
    size: z.enum(['1K', '2K', '3K', '4K']),
    ratio: z.enum(['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']),
    references: z.array(referenceSchema).max(12),
  })
  .strict()

const videoRequestSchema = z
  .object({
    kind: z.literal('video'),
    prompt: z.string().min(1).max(4000),
    model: z.string().min(1).max(120),
    mode: z.enum(['text', 'keyframe', 'reference']),
    size: z.enum(['720P', '1080P', '1K', '2K']),
    ratio: z.enum(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
    seconds: z.number().int().min(4).max(12),
    seed: z.number().int().min(0).optional(),
    references: z.array(referenceSchema).max(12),
  })
  .strict()

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state'), probeModels: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('start'), request: z.union([imageRequestSchema, videoRequestSchema]), retryOf: z.string().min(1).max(128).optional() }).strict(),
  z.object({ action: z.literal('retry'), id: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal('cancel'), id: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal('optimize'), prompt: z.string().min(1).max(4000), kind: z.enum(['image', 'video']) }).strict(),
  z.object({ action: z.literal('delete'), id: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
])

/** A JSON response with no-store caching; state is always live. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

/** One server-response success envelope. */
function success(rpcId: string, value: unknown): Response {
  return json({ type: 'server-response', rpcId, result: { ok: true, value } })
}

/** One server-response failure envelope, using a stable plugin-owned code. */
function failure(rpcId: string, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return json({ type: 'server-response', rpcId, result: { ok: false, error: { code: `agnes-studio/${code}`, message, details } } })
}

/** Recover the correlation id from any body shape so failures stay correlatable. */
function correlation(body: unknown): string {
  return body !== null && typeof body === 'object' && 'rpcId' in body && typeof (body as { rpcId?: unknown }).rpcId === 'string'
    ? ((body as { rpcId: string }).rpcId)
    : 'invalid-request'
}

/** Dispatch one validated request onto the runtime. */
async function dispatch(runtime: StudioRuntime, request: StudioRequest, signal: AbortSignal): Promise<StudioResult> {
  switch (request.action) {
    case 'state':
      return { state: await runtime.state({ probeModels: request.probeModels === true, signal }) }
    case 'start': {
      // Deliberately does NOT pass `signal`: that is the HTTP request's signal, and
      // tying the generation to it is exactly what made a job disappear when the
      // panel unmounted. The job belongs to the plugin Fiber instead.
      await runtime.start(request.request, request.retryOf === undefined ? {} : { retryOf: request.retryOf })
      return { state: await runtime.state() }
    }
    case 'retry': {
      // Rewriting the stored request from `params` would lose reference URLs, so
      // the record's own `request` is replayed. A record written before that field
      // existed cannot be retried faithfully; the error says so instead of
      // silently sending a different request.
      const record = (await runtime.state()).generations.find((entry) => entry.id === request.id)
      if (record === undefined) throw new StudioError('bad-request', '这条记录已经不存在了，无法重试。')
      if (record.request === undefined) {
        throw new StudioError('bad-request', '这条记录来自更早的版本，没有保存原始请求参数，请重新填写后再生成。')
      }
      await runtime.start(record.request, { retryOf: record.id })
      return { state: await runtime.state() }
    }
    case 'cancel': {
      await runtime.cancel(request.id)
      return { state: await runtime.state() }
    }
    case 'optimize': {
      const prompt = await runtime.optimize({ prompt: request.prompt, kind: request.kind }, { signal })
      return { state: await runtime.state(), prompt }
    }
    case 'delete': {
      await runtime.remove(request.id)
      return { state: await runtime.state() }
    }
    case 'clear': {
      await runtime.clear()
      return { state: await runtime.state() }
    }
  }
}

/** Build the exact RPC route; every failure stays inside the envelope. */
export function createExecuteRoute(runtime: StudioRuntime): FetchRoute {
  return {
    path: EXECUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST' || new URL(request.url).pathname !== EXECUTE_PATH) return new Response('not found', { status: 404 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: unknown
      let rawText = ''
      try {
        rawText = await request.text()
        body = JSON.parse(rawText)
      } catch {
        if (request.signal.aborted) return failure(correlation(body), 'cancelled', 'The request was cancelled before dispatch.')
        // A non-JSON body still carries an rpcId often enough to correlate; a
        // bare 400 makes the Client report a transport failure instead of a
        // structured error it can display.
        const recovered = /"rpcId"\s*:\s*"([^"]+)"/.exec(rawText)?.[1]
        if (recovered !== undefined) return failure(recovered, 'bad-request', 'The request body is not JSON.')
        return new Response('body is not JSON', { status: 400 })
      }
      if (request.signal.aborted) return failure(correlation(body), 'cancelled', 'The request was cancelled before dispatch.')
      const envelope = envelopeSchema.safeParse(body)
      if (!envelope.success) return failure(correlation(body), 'bad-request', 'Invalid client-request message.')
      const message = envelope.data
      if (message.method !== ENDPOINT) return failure(message.rpcId, 'bad-request', 'RPC method does not match the agnes-studio endpoint.')
      const parsed = requestSchema.safeParse(message.payload)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        return failure(message.rpcId, 'bad-request', first?.message ?? 'Invalid agnes-studio request.', {
          issues: parsed.error.issues.slice(0, 4),
        })
      }
      try {
        request.signal.throwIfAborted()
        return success(message.rpcId, await dispatch(runtime, parsed.data as StudioRequest, request.signal))
      } catch (error) {
        // A StudioError is authored for the user; anything else is a Host fault
        // whose text must not become UI copy.
        if (error instanceof StudioError) {
          return failure(correlation(body), error.code, error.message.slice(0, 2000), {
            ...error.details,
            ...(error.retryable ? { retryable: true } : {}),
          })
        }
        if (request.signal.aborted) return failure(correlation(body), 'cancelled', 'The request was cancelled.')
        return failure(correlation(body), 'internal', '生成本身遇到了内部错误，请查看 Host 日志。')
      }
    },
  }
}

/**
 * Parse one single-range `Range: bytes=…` header.
 *
 * Returns `undefined` for an absent or malformed header (serve the whole body),
 * a resolved window for a satisfiable range, or `'unsatisfiable'` for a range
 * that starts past the end (answer 416). Multi-range requests are answered with
 * the whole body, which is always a valid response.
 */
export function parseRange(header: string | null, total: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (header === null) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === undefined || rawEnd === undefined) return undefined
  if (rawStart === '' && rawEnd === '') return undefined
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return undefined
    return { start: Math.max(0, total - length), end: total - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= total) return 'unsatisfiable'
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
  if (!Number.isFinite(end) || end < start) return undefined
  return { start, end }
}

/** Build the exact media route; HEAD is answered without a body. */
export function createMediaRoute(runtime: StudioRuntime): FetchRoute {
  return {
    path: MEDIA_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      const method = request.method
      if (method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
      const url = new URL(request.url)
      // The registry matches this exact pathname for every id; the id comes from
      // `?id=` and is re-validated by the store before any file is touched.
      if (url.pathname !== MEDIA_PATH) return new Response('not found', { status: 404 })
      const id = mediaIdFrom(url.search)
      if (id === undefined) return new Response('not found', { status: 404 })
      const media = await runtime.readMedia(id)
      if (media === undefined) return new Response('not found', { status: 404 })
      const total = media.bytes.byteLength
      const headers: Record<string, string> = {
        'content-type': media.mediaType,
        'content-length': String(total),
        // Generated artifacts are immutable per id; a long cache is safe.
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        // Without range support a WebKit <video> cannot seek, and Safari may
        // refuse to play at all. One satisfiable range is enough for seeking.
        'accept-ranges': 'bytes',
      }
      if (method === 'HEAD') return new Response(null, { status: 200, headers })
      const range = parseRange(request.headers.get('range'), total)
      if (range === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${String(total)}` } })
      }
      if (range !== undefined) {
        const slice = media.bytes.subarray(range.start, range.end + 1)
        return new Response(slice, {
          status: 206,
          headers: { ...headers, 'content-length': String(slice.byteLength), 'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(total)}` },
        })
      }
      return new Response(media.bytes, { status: 200, headers })
    },
  }
}
