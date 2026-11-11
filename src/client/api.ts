/**
 * Typed Client-side API over the Host's exact Connection routes.
 *
 * The browser RPC caller validates the envelope and the correlation id, so this
 * layer only has to unwrap the endpoint's own result: `ok: true` returns the
 * value, `ok: false` throws an {@link ActionError} carrying the Host's stable
 * code and message. No Host object, function or live Session value crosses this
 * boundary — only lossless JSON.
 */

import type { ClientConnectionLike, RpcResult } from './contracts.js'
import { ENDPOINT, type GenerationRequest, type MediaKind, type StudioResult, type StudioState } from '../types.js'

/** Failure raised by the Host; `code` is stable enough to switch on. */
export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ActionError'
  }

  /** Whether the Host marked the identical request as worth retrying. */
  get retryable(): boolean {
    return this.details['retryable'] === true
  }
}

/** The one API face the view uses. */
export interface ClientApi {
  /**
   * Read the full dashboard state (history, configuration and in-flight jobs).
   *
   * `probeModels` is opt-in because it costs an upstream request: the panel polls
   * this while a job runs, and the model catalog does not change per poll.
   */
  state(options?: { signal?: AbortSignal; probeModels?: boolean }): Promise<StudioState>
  /** Start a generation in the background; resolves with the refreshed state. */
  start(request: GenerationRequest, retryOf?: string): Promise<StudioState>
  /** Restart a stored failed record from ITS OWN stored request. */
  retry(id: string): Promise<StudioState>
  /** Cancel one running job. */
  cancel(id: string): Promise<StudioState>
  /** Rewrite a prompt with the text model. */
  optimize(prompt: string, kind: MediaKind): Promise<string>
  /** Delete one generation. */
  remove(id: string, signal?: AbortSignal): Promise<StudioState>
  /** Delete every generation. */
  clear(signal?: AbortSignal): Promise<StudioState>
}

/** Unwrap one endpoint result, converting a failure into a thrown error. */
function unwrap<T>(result: RpcResult<T>): T {
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    throw new ActionError('invalid-response', 'Host 返回了无法识别的 Agnes Studio 响应。')
  }
  if (!result.ok) throw new ActionError(result.error.code, result.error.message, result.error.details)
  return result.value
}

/** Normalize a state payload, so a partial answer cannot crash the view. */
function normalizeState(value: StudioState): StudioState {
  return {
    configured: value?.configured === true,
    keySource: value?.keySource ?? 'none',
    baseUrl: typeof value?.baseUrl === 'string' ? value.baseUrl : '',
    upstreamModels: Array.isArray(value?.upstreamModels) ? value.upstreamModels : [],
    ...(typeof value?.upstreamModelsError === 'string' ? { upstreamModelsError: value.upstreamModelsError } : {}),
    generations: Array.isArray(value?.generations) ? value.generations : [],
    running: Array.isArray(value?.running) ? value.running : [],
  }
}

/** Create the API bound to this plugin's Fiber lifetime. */
export function createApi(connection: ClientConnectionLike, lifetime: AbortSignal): ClientApi {
  const call = async (payload: Record<string, unknown>, signal?: AbortSignal): Promise<StudioResult> => {
    const signalToUse = signal === undefined ? lifetime : AbortSignal.any([lifetime, signal])
    return unwrap(await connection.rpc.call<StudioResult>('/api', ENDPOINT, payload, signalToUse))
  }
  return {
    async state(options = {}) {
      const payload = options.probeModels === true ? { action: 'state', probeModels: true } : { action: 'state' }
      return normalizeState((await call(payload, options.signal)).state)
    },
    async start(request, retryOf) {
      return normalizeState(
        (await call({ action: 'start', request, ...(retryOf === undefined ? {} : { retryOf }) })).state,
      )
    },
    async retry(id) {
      return normalizeState((await call({ action: 'retry', id })).state)
    },
    async cancel(id) {
      return normalizeState((await call({ action: 'cancel', id })).state)
    },
    async optimize(prompt, kind) {
      const result = await call({ action: 'optimize', prompt, kind })
      if (typeof result.prompt !== 'string') throw new ActionError('invalid-response', 'Host 没有返回优化结果。')
      return result.prompt
    },
    async remove(id, signal) {
      return normalizeState((await call({ action: 'delete', id }, signal)).state)
    },
    async clear(signal) {
      return normalizeState((await call({ action: 'clear' }, signal)).state)
    },
  }
}
