/**
 * The generation runtime: the one place a request becomes a stored artifact.
 *
 * Both entry points — the dashboard route and the model tools — call the same
 * `generate` so a picture produced from the panel and one produced by a tool are
 * identical: same validation, same parameters, same stored record. That is what
 * makes the panel a view of the plugin's real work instead of a parallel
 * implementation.
 *
 * The Host also owns the IN-FLIGHT state, not the panel. A generation runs in
 * this registry, detached from the HTTP request that started it, so switching
 * away from the studio, closing the tab, or a slow video render cannot lose it:
 * the job keeps running and `state()` reports it until it settles into a stored
 * record. Only settled generations are persisted — a crash never leaves a
 * `running` record that could never finish, it just loses an in-memory job.
 * A retryable failure (queue full, timeout) IS recorded so the panel can offer
 * an unchanged retry; a plain validation refusal is not, because the user
 * already sees it in the error line.
 */

import { asStudioError, notConfigured, StudioError } from './errors.js'
import { createClient, dataUriFor, defaultSleep, validateRequest, type AgnesClient, type ClientDeps } from './agnes.js'
import { newGenerationId, type StudioStore } from './store.js'
import {
  defaultModelFor,
  isStoredReference,
  type Generation,
  type GenerationRequest,
  type MediaKind,
  type MediaReference,
  type RunningJob,
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
  /** Total tries one continuous retry may make, counting the first. */
  readonly retryAttempts?: number
  /** Delay before the second try; doubles per try up to `retryMaxDelayMs`. */
  readonly retryBaseDelayMs?: number
  /** Ceiling for that exponential backoff. */
  readonly retryMaxDelayMs?: number
  readonly fetchImpl?: ClientDeps['fetchImpl']
  readonly sleep?: ClientDeps['sleep']
  readonly now?: () => Date
  /** Injectable client factory for tests. */
  readonly clientFactory?: (deps: ClientDeps) => AgnesClient
}

/** The runtime surface the route and the tools share. */
export interface StudioRuntime {
  /** Current state for the dashboard, including every in-flight job. */
  state(options?: { probeModels?: boolean; signal?: AbortSignal }): Promise<StudioState>
  /** Run one generation to completion and store the artifact (tools await this). */
  generate(request: GenerationRequest, options?: GenerateOptions): Promise<Generation>
  /**
   * Start a generation in the background and return its job immediately.
   *
   * This is what the panel uses: the job belongs to the Host, so it survives the
   * panel unmounting. Its outcome lands in the store and is reported through
   * `state()`, never through this call's return value.
   */
  start(request: GenerationRequest, options?: GenerateOptions): Promise<RunningJob>
  /** Cancel one running job; returns whether it was running. */
  cancel(id: string): boolean
  /** Optimize a prompt with the text model; returns the rewritten prompt. */
  optimize(request: OptimizeRequest, options?: { signal?: AbortSignal }): Promise<string>
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
  /** Abort every running job; called from the plugin Fiber's teardown. */
  dispose(): void
}

/** One prompt-optimization request. */
export interface OptimizeRequest {
  readonly prompt: string
  readonly kind: MediaKind
}

/** One generate call's options. */
export interface GenerateOptions {
  readonly signal?: AbortSignal
  /**
   * Id of the failed record this attempt retries, if any.
   *
   * When present the settled outcome REPLACES that record instead of adding a
   * new one. Retrying an identical request used to append a fresh row every
   * time, so a queue-full condition the user retried five times left five
   * identical failures in the gallery and the history cap churned through them.
   * The store keys records by id and `append` already replaces by id, so
   * reusing the id is the whole mechanism.
   */
  readonly retryOf?: string
  /**
   * Keep retrying a retryable failure on the Host until the attempts run out.
   *
   * The reason this belongs on the Host rather than in the panel: Agnes' free
   * video queue answers `video_queue_full` for minutes at a time, so one manual
   * retry usually lands in the SAME full queue and the user ends up clicking
   * again and again. A Host-owned loop keeps waiting after the panel is closed
   * or the tab is gone, and reports its progress through `state()`. A failure
   * that can never succeed on a second try (bad parameter, quota, no key) is
   * never retried, so this cannot spin on a permanent error.
   */
  readonly retryAll?: boolean
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
  // The retry wait uses the same injectable sleep as the client, so tests drive
  // backoff without real timers.
  const sleep = deps.sleep ?? defaultSleep
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

  /**
   * The in-flight registry.
   *
   * Keyed by the generation id the job will settle into, so a retry of an
   * existing record occupies that record's slot and the panel can render one
   * placeholder per id without de-duplicating.
   *
   * The entry holds a MUTABLE job so continuous retry can publish which attempt
   * is running and when the next one starts, without re-registering an id the
   * panel is already tracking.
   */
  interface JobEntry {
    job: RunningJob
    readonly controller: AbortController
  }
  const jobs = new Map<string, JobEntry>()

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
      running: [...jobs.values()].map((entry) => entry.job),
      ...extra,
    }
  }

  /** Register a running job and return its abort controller. */
  const registerJob = (job: RunningJob, external?: AbortSignal): AbortController => {
    const controller = new AbortController()
    // The job's own controller is what the panel's cancel button aborts; the
    // caller's signal (a tool execution) can also end it. Neither is the HTTP
    // request's signal, which would tie the work to the panel being open.
    const onExternalAbort = (): void => controller.abort(external?.reason)
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }
    jobs.set(job.id, { job, controller })
    return controller
  }

  /** The retry-progress fields a running job may be patched with. */
  interface RetryProgress {
    readonly attempt?: number
    readonly maxAttempts?: number
    readonly nextAttemptAt?: string | undefined
  }

  /**
   * Publish a running job's progress.
   *
   * Called between attempts so the gallery can show "第 2/5 次尝试 · 稍后自动重试"
   * and a countdown that comes from the Host's own schedule rather than from a
   * guess the panel made up.
   */
  const updateJob = (id: string, patch: RetryProgress): void => {
    const entry = jobs.get(id)
    if (entry === undefined) return
    const next: { -readonly [K in keyof RunningJob]: RunningJob[K] } = { ...entry.job }
    if (patch.attempt !== undefined) next.attempt = patch.attempt
    if (patch.maxAttempts !== undefined) next.maxAttempts = patch.maxAttempts
    // `exactOptionalPropertyTypes` means "an attempt is running" is an ABSENT
    // key, so the old countdown must be deleted rather than set to undefined.
    if (patch.nextAttemptAt === undefined) delete next.nextAttemptAt
    else next.nextAttemptAt = patch.nextAttemptAt
    entry.job = next
  }

  /** Drop a settled job from the registry. */
  const unregisterJob = (id: string): void => {
    jobs.delete(id)
  }

  /**
   * Resolve everything a generation needs before any network call, and register
   * the job.
   *
   * Split out so both entry points share one preflight: a missing key must fail
   * BEFORE a job is registered (otherwise the panel would poll a placeholder that
   * never settles), and a retry must recover the original `createdAt` so the row
   * keeps its identity.
   */
  const begin = async (
    request: GenerationRequest,
    options: GenerateOptions,
  ): Promise<{
    job: RunningJob
    controller: AbortController
    id: string
    createdAt: string
    attemptStartedAt: number
    resolved: GenerationRequest
    maxAttempts: number
  }> => {
    const key = await deps.resolveKey().catch(() => {
      throw notConfigured()
    })
    if (key.key === '') throw notConfigured()

    // Validate SYNCHRONOUSLY, before a job exists. A background job's outcome
    // reaches the panel only through a stored record, so an unsupported size or a
    // video model named for an image would come back as a failed CARD instead of
    // the immediate refusal the caller can act on. The key check runs first so an
    // unconfigured profile still reports "no key" rather than a parameter detail.
    validateRequest(request)
    // Resolve stored references BEFORE a job exists, so an editor pointing at a
    // record that has since been deleted refuses immediately instead of becoming
    // a failed card the user cannot explain.
    const resolved = await resolveReferences(request)

    const id = options.retryOf ?? newGenerationId()
    const createdAt =
      options.retryOf === undefined
        ? now().toISOString()
        : ((await deps.store.list()).find((entry) => entry.id === options.retryOf)?.createdAt ?? now().toISOString())

    // A retry that reuses an existing record can go on the continuous loop; a
    // first attempt keeps its own single try until it has failed, because the
    // record it will replace does not exist yet.
    const maxAttempts = retryBudget(options)
    const derivedFrom = derivedFromOf(request)

    const job: RunningJob = {
      id,
      kind: request.kind,
      prompt: request.prompt,
      model: request.model,
      startedAt: now().toISOString(),
      ...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
      ...(derivedFrom === undefined ? {} : { derivedFrom }),
      ...(maxAttempts > 1 ? { attempt: 1, maxAttempts } : {}),
    }
    const controller = registerJob(job, options.signal)
    // `createdAt` is the record's identity (a retry keeps the original); the
    // attempt start is separate so `durationMs` measures THIS call, not the whole
    // history of a record the user has retried several times. Under continuous
    // retry it therefore measures the loop including its backoff waits, which is
    // the honest "how long until I got a result" number; `attempts` on the
    // record says how many tries that covered.
    return { job, controller, id, createdAt, attemptStartedAt: Date.now(), resolved, maxAttempts }
  }

  /**
   * How many tries one call may make, counting this one.
   *
   * Continuous retry is opt-in per call (`retryAll`), and the Host never retries
   * a request it validated itself: those failures are deterministic, so a loop
   * over them would just burn the budget. A disabled or single-attempt
   * configuration reports 1, which is exactly the old behaviour.
   */
  function retryBudget(options: GenerateOptions): number {
    if (options.retryAll !== true) return 1
    const configured = Math.floor(deps.retryAttempts ?? 1)
    return Number.isFinite(configured) && configured > 1 ? configured : 1
  }

  /**
   * Delay before attempt N+1, with exponential backoff and a ceiling.
   *
   * The free queue is full in bursts, so retrying after a fixed second mostly
   * re-hits the same wall; growing the gap gives the queue time to drain while
   * still capping how long a user waits between visible state changes.
   */
  function retryDelayMs(attempt: number): number {
    const base = Math.max(1, Math.floor(deps.retryBaseDelayMs ?? 1_000))
    const ceiling = Math.max(base, Math.floor(deps.retryMaxDelayMs ?? base))
    const grown = base * 2 ** Math.max(0, attempt - 1)
    return Math.min(ceiling, grown)
  }

  /**
   * Inline every stored-generation reference as a `data:` URI.
   *
   * The panel can only address generated media through the authenticated
   * same-origin route, which the upstream cannot reach; the bytes are already on
   * the Host, so the one request form that works is a `data:` URI. The record's
   * own `request` keeps the symbolic form, so a retry re-resolves against
   * whatever still exists instead of freezing a multi-megabyte string into the
   * index.
   */
  const resolveReferences = async (request: GenerationRequest): Promise<GenerationRequest> => {
    if (!request.references.some(isStoredReference)) return request
    if (request.kind !== 'image') {
      throw new StudioError('invalid-reference', '只有生图可以用已保存的记录作为参考素材。')
    }
    const generations = await deps.store.list()
    const resolved: MediaReference[] = []
    for (const reference of request.references) {
      if (!isStoredReference(reference)) {
        resolved.push(reference)
        continue
      }
      const id = reference.generationId ?? ''
      const source = generations.find((entry) => entry.id === id)
      if (source === undefined) {
        throw new StudioError('invalid-reference', '找不到这条生成记录，无法作为参考图。', { generationId: id })
      }
      if (source.kind !== 'image') {
        throw new StudioError('invalid-reference', '只有图片记录可以作为参考素材。', { generationId: id })
      }
      if (source.asset === undefined) {
        throw new StudioError('invalid-reference', '这条记录没有生成成功的图片，无法作为参考图。', { generationId: id })
      }
      const media = await deps.store.readMedia(id)
      if (media === undefined) {
        throw new StudioError('invalid-reference', '这条记录的图片文件已不存在，无法作为参考图。', { generationId: id })
      }
      resolved.push({ kind: 'image', url: dataUriFor(media.mediaType, media.bytes) })
    }
    return { ...request, references: resolved }
  }

  /** The record a new generation continues, when its request names one. */
  function derivedFromOf(request: GenerationRequest): string | undefined {
    for (const reference of request.references) {
      if (isStoredReference(reference)) return reference.generationId
    }
    return undefined
  }

  /** One attempt's immutable inputs, grouped so the long call cannot drift. */
  interface Attempt {
    /** The request as recorded: stored references stay symbolic. */
    readonly request: GenerationRequest
    /** The request as sent: every stored reference inlined as a data: URI. */
    readonly resolved: GenerationRequest
    readonly id: string
    readonly createdAt: string
    readonly attemptStartedAt: number
    readonly controller: AbortController
    /** Continuous-retry budget: total tries, 1 when the retry loop is off. */
    readonly maxAttempts: number
    /** Tries already finished, this one included. */
    readonly attempt: number
    /**
     * Keep a non-retryable failure in the history.
     *
     * True for a background job (its record is the only report the user gets) and
     * for a retry (it replaces a row the user can already see, so that row must
     * not keep describing an older attempt). False for a tool call, which throws
     * to its caller and would otherwise sprinkle validation noise into the gallery.
     */
    readonly keepAnyFailure: boolean
  }

  /** One network try. Throws the failure as-is; records nothing. */
  const attemptOnce = async (resolved: GenerationRequest, controller: AbortController): Promise<{ bytes: Uint8Array; mediaType: string; upstreamId?: string }> => {
    return resolved.kind === 'image'
      ? client.generateImage(resolved, { signal: controller.signal })
      : client.generateVideo(resolved, { signal: controller.signal })
  }

  /**
   * Run one generation to a settled record and store it.
   *
   * The retry loop lives here, not in the panel, because the free video queue
   * stays full for minutes: one manual retry almost always lands in the same
   * full queue, so the user ends up clicking again and again. A Host-owned loop
   * keeps waiting while the panel is closed, and each intermediate try is
   * reported through `state()` instead of being written to the index — a
   * five-attempt queue wait must not leave five identical failure rows behind.
   * Only the FINAL outcome becomes a record, carrying how many tries it took.
   */
  const runGeneration = async (attempt: Attempt): Promise<Generation> => {
    const { request, resolved, id, createdAt, attemptStartedAt: started, controller, keepAnyFailure } = attempt
    const derivedFrom = derivedFromOf(request)
    const base = {
      id,
      kind: request.kind,
      model: request.model,
      prompt: request.prompt,
      params: paramsOf(request),
      createdAt,
      // Stored verbatim so a later retry resends exactly what this record asked
      // for: `params` is a flattened display summary and loses reference URLs.
      request,
      ...(derivedFrom === undefined ? {} : { derivedFrom }),
    }

    let attemptNo = attempt.attempt
    let outcome: { bytes: Uint8Array; mediaType: string; upstreamId?: string }
    for (;;) {
      try {
        outcome = await attemptOnce(resolved, controller)
        break
      } catch (error) {
        // The job's OWN controller aborting means the user (or the plugin
        // shutting down) cancelled this work, whatever error shape the client
        // surfaced. That must never be recorded as a failure, and must never
        // race a teardown that has already removed the store.
        if (controller.signal.aborted) throw new StudioError('cancelled', '请求已取消。')
        const failure = asStudioError(error)
        // Only a failure that could plausibly succeed later earns another try:
        // a bad parameter, an exhausted quota or a rejected key is deterministic,
        // so looping on it would burn the budget and delay the honest report.
        const canRetry = failure.retryable === true && attemptNo < attempt.maxAttempts
        if (!canRetry) {
          const settledAt = now()
          const failed: Generation = {
            ...base,
            status: 'failed',
            finishedAt: settledAt.toISOString(),
            durationMs: settledAt.getTime() - started,
            errorCode: failure.code,
            error: failure.message,
            ...(failure.retryable ? { retryable: true } : {}),
            ...(attemptNo > 1 ? { attempts: attemptNo } : {}),
          }
          // A BACKGROUND failure must always become a record: the panel has no
          // request left to report it on, so a record is its only way to learn
          // the job ended badly. The TOOL path throws to the caller instead, so
          // a plain validation refusal there stays out of the history rather
          // than becoming gallery noise — as does a retry, which replaces a row
          // the user can already see and therefore may never silently disappear.
          // A cancellation the user asked for is not a failure to remember.
          if (
            failure.code !== 'cancelled' &&
            (keepAnyFailure || failure.retryable === true || failure.code === 'timeout')
          ) {
            await deps.store.append(failed, new Uint8Array(0), 'application/octet-stream').catch(() => undefined)
            throw new StudioError(failure.code, failure.message, { ...failure.details, recordId: id }, failure.retryable)
          }
          throw failure
        }
        // Publish the wait so the card can count down to the next try instead of
        // looking frozen for minutes.
        const delay = retryDelayMs(attemptNo)
        updateJob(id, {
          attempt: attemptNo + 1,
          maxAttempts: attempt.maxAttempts,
          nextAttemptAt: new Date(now().getTime() + delay).toISOString(),
        })
        await sleep(delay, controller.signal)
        // The wait was cancelled: a user who stops a queued retry gets no card.
        if (controller.signal.aborted) throw new StudioError('cancelled', '请求已取消。')
        attemptNo += 1
        updateJob(id, { attempt: attemptNo, maxAttempts: attempt.maxAttempts, nextAttemptAt: undefined })
      }
    }

    const settledAt = now()
    const record: Generation = {
      ...base,
      status: 'succeeded',
      finishedAt: settledAt.toISOString(),
      durationMs: settledAt.getTime() - started,
      ...(outcome.upstreamId === undefined ? {} : { upstreamId: outcome.upstreamId }),
      ...(attemptNo > 1 ? { attempts: attemptNo } : {}),
    }
    return deps.store.append(record, outcome.bytes, outcome.mediaType)
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
      // The tool path: register the job so the panel shows it, then await the
      // outcome and let the throw reach the caller.
      const { id, createdAt, attemptStartedAt, controller, resolved, maxAttempts } = await begin(request, options)
      try {
        // A tool call reports through its throw; only a retry replaces an
        // existing row and so must persist whatever the new outcome is.
        return await runGeneration({
          request,
          resolved,
          id,
          createdAt,
          attemptStartedAt,
          controller,
          maxAttempts,
          attempt: 1,
          keepAnyFailure: options.retryOf !== undefined,
        })
      } finally {
        unregisterJob(id)
      }
    },

    /**
     * Start a generation and return immediately.
     *
     * The work is deliberately NOT tied to the caller: a video render outliving
     * the panel (or the browser tab) is the normal case, not an error. The
     * outcome reaches the user through `state()` — a stored record or a stored
     * failure — which is what makes leaving the studio and coming back safe.
     */
    async start(request, options = {}) {
      const { job, id, createdAt, attemptStartedAt, controller, resolved, maxAttempts } = await begin(request, options)
      // A background job's record IS its report, so every failure is kept.
      void runGeneration({
        request,
        resolved,
        id,
        createdAt,
        attemptStartedAt,
        controller,
        maxAttempts,
        attempt: 1,
        keepAnyFailure: true,
      })
        .catch(() => undefined)
        .finally(() => unregisterJob(id))
      return job
    },

    cancel(id) {
      const entry = jobs.get(id)
      if (entry === undefined) return false
      entry.controller.abort()
      return true
    },

    async optimize(request, options = {}) {
      const key = await deps.resolveKey().catch(() => {
        throw notConfigured()
      })
      if (key.key === '') throw notConfigured()
      const prompt = request.prompt.trim()
      if (prompt === '') throw new StudioError('bad-request', '请先写一个提示词，再让 Agnes 帮你优化。')
      return client.optimizePrompt({ prompt, kind: request.kind }, { signal: options.signal })
    },

    dispose() {
      // Aborting every job on Fiber teardown is what keeps a plugin stop from
      // leaving a detached fetch running against a dead registry.
      for (const entry of jobs.values()) entry.controller.abort()
      jobs.clear()
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
