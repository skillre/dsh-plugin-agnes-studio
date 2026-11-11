/**
 * The generation runtime: the one place a request becomes a stored artifact.
 *
 * Both entry points — the dashboard route and the model tools — call the same
 * `generate` so a picture produced from the panel and one produced by a tool are
 * identical: same validation, same parameters, same stored record. That is what
 * makes the panel a view of the plugin's real work instead of a parallel
 * implementation.
 *
 * Only settled generations are persisted: the in-flight state lives in the
 * dashboard's own memory, so a crash never leaves a `running` record that can
 * never finish. A retryable failure (queue full, timeout) IS recorded so the
 * panel can offer an unchanged retry; a plain validation refusal is not, because
 * the user already sees it in the error line.
 */

import { asStudioError, notConfigured, StudioError } from './errors.js'
import { createClient, type AgnesClient, type ClientDeps } from './agnes.js'
import { newGenerationId, type StudioStore } from './store.js'
import {
  defaultModelFor,
  type Generation,
  type GenerationRequest,
  type MediaKind,
  type StudioState,
  type KeySource,
} from './types.js'

/** Resolve the API key plus the source it came from. */
export interface KeyResolver {
  (): Promise<{ key: string; source: KeySource }>
}

/** Dependencies the runtime needs. */
export interface RuntimeDeps {
  readonly store: StudioStore
  readonly baseUrl: string
  readonly resolveKey: KeyResolver
  readonly imageTimeoutMs: number
  readonly videoTimeoutMs: number
  readonly pollIntervalMs: number
  readonly maxMediaBytes: number
  readonly fetchImpl?: ClientDeps['fetchImpl']
  readonly sleep?: ClientDeps['sleep']
  readonly now?: () => Date
  /** Injectable client factory for tests. */
  readonly clientFactory?: (deps: ClientDeps) => AgnesClient
}

/** The runtime surface the route and the tools share. */
export interface StudioRuntime {
  /** Current state for the dashboard. */
  state(options?: { probeModels?: boolean; signal?: AbortSignal }): Promise<StudioState>
  /** Run one generation and store the artifact. */
  generate(request: GenerationRequest, options?: { signal?: AbortSignal }): Promise<Generation>
  /** Remove one generation. */
  remove(id: string): Promise<boolean>
  /** Remove every generation. */
  clear(): Promise<number>
  /** Read stored media for the download route. */
  readMedia(id: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
  /** The host path of one generated image, for the tool layer. */
  mediaPath(id: string): Promise<string | undefined>
  /** Whether a key is currently resolvable. */
  isConfigured(): Promise<boolean>
}

/** Normalize the parameters actually sent, for the record's detail view. */
function paramsOf(request: GenerationRequest): Record<string, string | number | boolean | null> {
  const base: Record<string, string | number | boolean | null> = {
    model: request.model,
    size: request.size,
    ratio: request.ratio,
  }
  if (request.kind === 'video') {
    base['mode'] = request.mode
    base['seconds'] = request.seconds
    if (request.seed !== undefined) base['seed'] = request.seed
  }
  base['references'] = request.references.length
  for (const kind of ['image', 'video', 'audio'] as const) {
    const count = request.references.filter((reference) => reference.kind === kind).length
    if (count > 0) base[`${kind}References`] = count
  }
  return base
}

/** Create the runtime over one store and configuration. */
export function createRuntime(deps: RuntimeDeps): StudioRuntime {
  const now = deps.now ?? (() => new Date())
  const client = (deps.clientFactory ?? createClient)({
    baseUrl: deps.baseUrl,
    resolveKey: async () => (await deps.resolveKey()).key,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    imageTimeoutMs: deps.imageTimeoutMs,
    videoTimeoutMs: deps.videoTimeoutMs,
    pollIntervalMs: deps.pollIntervalMs,
    maxMediaBytes: deps.maxMediaBytes,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  })

  /** Build the state document the dashboard renders. */
  const buildState = async (generations: readonly Generation[], extra: Partial<StudioState> = {}): Promise<StudioState> => {
    let configured = false
    let keySource: KeySource = 'none'
    try {
      const resolved = await deps.resolveKey()
      configured = resolved.key !== ''
      keySource = resolved.source
    } catch {
      configured = false
    }
    return {
      configured,
      keySource,
      baseUrl: deps.baseUrl,
      upstreamModels: [],
      generations,
      ...extra,
    }
  }

  return {
    async state(options = {}) {
      const generations = await deps.store.list()
      if (options.probeModels !== true) return buildState(generations)
      // The catalog probe is advisory: a failure must not hide the history, so
      // the error is reported beside an otherwise complete state document.
      const probe = await client.listModels({ signal: options.signal })
      return buildState(
        generations,
        probe.error === undefined
          ? { upstreamModels: probe.models }
          : { upstreamModels: probe.models, upstreamModelsError: probe.error },
      )
    },

    async generate(request, options = {}) {
      const started = now()
      const id = newGenerationId()
      const kind: MediaKind = request.kind
      // Fail before touching the network when no key is configured.
      const key = await deps.resolveKey().catch(() => {
        throw notConfigured()
      })
      if (key.key === '') throw notConfigured()

      // The record's identity and request facts, before the status is known.
      const base = {
        id,
        kind,
        model: request.model,
        prompt: request.prompt,
        params: paramsOf(request),
        createdAt: started.toISOString(),
      }
      // Nothing is persisted while the request runs: the dashboard's own busy
      // state is the in-flight indicator, so a crash cannot leave a record that
      // never settles.
      let outcome: { bytes: Uint8Array; mediaType: string; upstreamId?: string }
      try {
        outcome =
          request.kind === 'image'
            ? await client.generateImage(request, { signal: options.signal })
            : await client.generateVideo(request, { signal: options.signal })
      } catch (error) {
        const failure = asStudioError(error)
        const failed: Generation = {
          ...base,
          status: 'failed',
          finishedAt: now().toISOString(),
          durationMs: now().getTime() - started.getTime(),
          errorCode: failure.code,
          error: failure.message,
          ...(failure.retryable ? { retryable: true } : {}),
        }
        // A failed attempt is kept only when it carries a retryable signal or an
        // upstream id; otherwise it is transient noise the user already sees in
        // the panel's own error line.
        if (failed.retryable === true || failure.code === 'timeout') {
          await deps.store.append(failed, new Uint8Array(0), 'application/octet-stream').catch(() => undefined)
        }
        throw failure
      }
      const finished = now()
      const record: Generation = {
        ...base,
        status: 'succeeded',
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        ...(outcome.upstreamId === undefined ? {} : { upstreamId: outcome.upstreamId }),
      }
      return deps.store.append(record, outcome.bytes, outcome.mediaType)
    },

    async remove(id) {
      return deps.store.remove(id)
    },

    async clear() {
      return deps.store.clear()
    },

    async readMedia(id) {
      const media = await deps.store.readMedia(id)
      return media === undefined ? undefined : { bytes: media.bytes, mediaType: media.mediaType }
    },

    async mediaPath(id) {
      return deps.store.mediaPath(id)
    },

    async isConfigured() {
      try {
        const resolved = await deps.resolveKey()
        return resolved.key !== ''
      } catch {
        return false
      }
    },
  }
}

/** The default request for a capability, used when a tool omits parameters. */
export function defaultRequest(kind: MediaKind, prompt: string): GenerationRequest {
  const model = defaultModelFor(kind)
  if (kind === 'image') {
    return { kind: 'image', prompt, model: model.id, size: '1K', ratio: '1:1', references: [] }
  }
  return { kind: 'video', prompt, model: model.id, mode: 'text', size: '720P', ratio: '16:9', seconds: 5, references: [] }
}

/** Re-export for callers that only import this module. */
export type { StudioError }
