/**
 * Stable failure codes and the user-facing message for each.
 *
 * The transport maps a {@link StudioError} onto the RPC envelope verbatim, and
 * the tool layer turns one into a model-readable sentence. Codes are stable
 * enough for the Client to switch on; messages are authored for the user and
 * never carry upstream detail that could leak the key or an internal trace.
 */

/** Failure codes this plugin can report. */
export type StudioErrorCode =
  | 'not-configured'
  | 'bad-request'
  | 'invalid-model'
  | 'invalid-parameter'
  | 'invalid-reference'
  | 'unauthorized'
  | 'rate-limited'
  | 'queue-full'
  | 'upstream-failed'
  | 'timeout'
  | 'download-failed'
  | 'too-large'
  | 'cancelled'
  | 'storage-failed'
  | 'internal'

/** A failure authored by this plugin. */
export class StudioError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** Whether retrying the identical request may succeed. */
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'StudioError'
  }
}

/** The API key is missing; the dashboard shows the configuration hint. */
export function notConfigured(): StudioError {
  return new StudioError(
    'not-configured',
    '还没有配置 Agnes API Key。请在 DSH 凭据中设置 AGNES_API_KEY，或设置同名环境变量后重试。',
  )
}

/**
 * Map an upstream HTTP status plus body onto a plugin failure.
 *
 * `queue-full` is a real, observed answer (HTTP 503 `video_queue_full`) rather
 * than a transport fault, so it gets its own code and a retryable flag: the
 * dashboard offers "retry" instead of telling the user their request was bad.
 */
export function fromUpstreamStatus(status: number, body: string): StudioError {
  const detail = extractDetail(body)
  const suffix = detail === '' ? '' : `：${detail}`
  if (status === 401 || status === 403) {
    return new StudioError('unauthorized', `Agnes API Key 无效或没有该模型的权限（HTTP ${status}）${suffix}`)
  }
  if (status === 429) {
    return new StudioError('rate-limited', `请求太频繁，已被 Agnes 限流（HTTP 429）${suffix}`, {}, true)
  }
  if (status === 503 && /queue/i.test(detail === '' ? body : detail)) {
    return new StudioError('queue-full', 'Agnes 视频队列已满，请稍后重试。', {}, true)
  }
  if (status >= 500) {
    return new StudioError('upstream-failed', `Agnes 服务暂时不可用（HTTP ${status}）${suffix}`, {}, true)
  }
  if (status === 400 || status === 404 || status === 422) {
    return new StudioError('invalid-parameter', `Agnes 拒绝了这次请求（HTTP ${status}）${suffix}`)
  }
  return new StudioError('upstream-failed', `Agnes 请求失败（HTTP ${status}）${suffix}`)
}

/**
 * Pull the most specific message out of an upstream error body.
 *
 * The API answers `{"detail": "..."}` for validation errors, OpenAI-shaped
 * `{"error": {"message": ...}}` elsewhere, and `{"code","message"}` for its own
 * queue errors; an HTML error page yields the empty string.
 */
export function extractDetail(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '' || trimmed.startsWith('<')) return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object') return ''
    const record = parsed as Record<string, unknown>
    for (const candidate of [record['detail'], (record['error'] as Record<string, unknown> | undefined)?.['message'], record['message']]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 300)
    }
    return ''
  } catch {
    return trimmed.slice(0, 300)
  }
}

/** Whether an unknown value is an abort. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Wrap an unknown throw as a StudioError without losing the abort distinction.
 *
 * A cancelled request is not a failure the user should debug, so it keeps its
 * own code; anything else becomes an internal fault whose text stays generic.
 */
export function asStudioError(error: unknown): StudioError {
  if (error instanceof StudioError) return error
  if (isAbort(error)) return new StudioError('cancelled', '请求已取消。')
  const message = error instanceof Error ? error.message : String(error)
  return new StudioError('internal', `生成失败：${message.slice(0, 300)}`)
}
