/**
 * Offline tests for the Agnes client, request validation and response parsing.
 *
 * These are the load-bearing tests: the capability table is the only thing
 * standing between the dashboard and an HTTP 400, so every documented rejection
 * is asserted here rather than discovered in production. No test touches the
 * network — a fake `fetch` stands in for the upstream.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildImageBody,
  buildVideoBody,
  createClient,
  dataUriFor,
  decodeBase64,
  originOf,
  parseCreateResponse,
  parseImageResponse,
  isSameOrigin,
  normalizeHostname,
  parsePollResponse,
  sniffMediaType,
  validateRequest,
} from '../src/agnes.js'
import { StudioError, extractDetail, fromUpstreamStatus } from '../src/errors.js'
import type { ImageRequest, VideoRequest } from '../src/types.js'

/** A 1x1 transparent PNG, the smallest valid image for the fake upstream. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
])

/** Build an image request with overridable fields. */
function imageRequest(patch: Partial<ImageRequest> = {}): ImageRequest {
  return { kind: 'image', prompt: 'a red apple', model: 'agnes-image-2.5-flash', size: '1K', ratio: '1:1', references: [], ...patch }
}

/** Build a video request with overridable fields. */
function videoRequest(patch: Partial<VideoRequest> = {}): VideoRequest {
  return {
    kind: 'video',
    prompt: 'a red apple rotating',
    model: 'agnes-video-2.5',
    mode: 'text',
    size: '720P',
    ratio: '16:9',
    seconds: 5,
    references: [],
    ...patch,
  }
}

/** Assert a call throws a StudioError with one code. */
function expectCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(StudioError)
    expect((error as StudioError).code).toBe(code)
    return
  }
  throw new Error(`expected a StudioError with code ${code}, but nothing was thrown`)
}

describe('hostname normalization', () => {
  it('strips IPv6 brackets, case and trailing dots', () => {
    expect(normalizeHostname('[::1]')).toBe('::1')
    expect(normalizeHostname('[fd00::1]')).toBe('fd00::1')
    expect(normalizeHostname('LOCALHOST.')).toBe('localhost')
    expect(normalizeHostname('Example.COM...')).toBe('example.com')
    expect(normalizeHostname('cdn.example.com')).toBe('cdn.example.com')
  })
})

describe('media type sniffing', () => {
  it('recognizes the formats the API returns', () => {
    expect(sniffMediaType(PNG_BYTES)).toBe('image/png')
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    const webp = new Uint8Array(12)
    webp.set([0x52, 0x49, 0x46, 0x46], 0)
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffMediaType(webp)).toBe('image/webp')
  })

  it('recognizes an ISO base media video by its ftyp box', () => {
    const mp4 = new Uint8Array(12)
    mp4.set([0x66, 0x74, 0x79, 0x70], 4)
    expect(sniffMediaType(mp4)).toBe('video/mp4')
  })

  it('refuses to guess when the bytes are unrecognized', () => {
    expect(sniffMediaType(new Uint8Array([1, 2, 3, 4]))).toBe('application/octet-stream')
  })
})

describe('request validation against the capability table', () => {
  it('accepts the documented image combinations', () => {
    expect(validateRequest(imageRequest()).id).toBe('agnes-image-2.5-flash')
    expect(validateRequest(imageRequest({ model: 'agnes-image-2.0-flash', size: '4K', ratio: '21:9' })).kind).toBe('image')
  })

  it('accepts the documented video combinations', () => {
    expect(validateRequest(videoRequest({ size: '2K', seconds: 12 })).id).toBe('agnes-video-2.5')
    expect(validateRequest(videoRequest({ model: 'agnes-video-2.5-flash', size: '720P' })).id).toBe('agnes-video-2.5-flash')
  })

  it('refuses a Flash video at a resolution it does not support', () => {
    // The Flash model is fixed to 720P; sending 1080P is an HTTP 400 upstream,
    // so it must be refused before the request is built.
    expectCode(() => validateRequest(videoRequest({ model: 'agnes-video-2.5-flash', size: '1080P' })), 'invalid-parameter')
  })

  it('refuses a model used for the wrong capability', () => {
    expectCode(() => validateRequest(imageRequest({ model: 'agnes-video-2.5' })), 'invalid-model')
    expectCode(() => validateRequest(videoRequest({ model: 'agnes-image-2.1-flash' })), 'invalid-model')
  })

  it('refuses an unknown model and an empty prompt', () => {
    expectCode(() => validateRequest(imageRequest({ model: 'agnes-image-9.9' })), 'invalid-model')
    expectCode(() => validateRequest(imageRequest({ prompt: '   ' })), 'bad-request')
  })

  it('enforces the keyframe media rules', () => {
    // keyframe needs at least one frame, supplied through the named slots.
    expectCode(() => validateRequest(videoRequest({ mode: 'keyframe' })), 'invalid-reference')
    expect(validateRequest(videoRequest({ mode: 'keyframe', firstFrame: 'https://example.com/a.png' })).id).toBe(
      'agnes-video-2.5',
    )
    // Frames must not ride in `references`: that was the shape that made a lone
    // last frame become a first frame.
    expectCode(
      () => validateRequest(videoRequest({ mode: 'keyframe', references: [{ url: 'https://example.com/a.png', kind: 'image' }] })),
      'invalid-reference',
    )
    // A frame URL is fetched by the upstream, so it gets the same public-HTTPS
    // check as a reference. (A `.mp3` extension cannot be judged from the URL
    // alone; the upstream rejects the content, not this preflight.)
    expectCode(() => validateRequest(videoRequest({ mode: 'keyframe', firstFrame: 'http://insecure/a.png' })), 'invalid-reference')
    expectCode(
      () => validateRequest(videoRequest({ mode: 'keyframe', lastFrame: 'https://127.0.0.1/a.png' })),
      'invalid-reference',
    )
  })

  it('never sends a lone last frame as the first frame', () => {
    // Regression: a filtered positional array collapsed `[lastFrame]` to index 0.
    const body = buildVideoBody(videoRequest({ mode: 'keyframe', lastFrame: 'https://example.com/last.png' }))
    expect(body['last_frame']).toBe('https://example.com/last.png')
    expect('first_frame' in body).toBe(false)
  })

  it('enforces the reference media rules, including the Flash video ban', () => {
    expectCode(() => validateRequest(videoRequest({ mode: 'reference' })), 'invalid-reference')
    expectCode(
      () =>
        validateRequest(
          videoRequest({
            model: 'agnes-video-2.5-flash',
            mode: 'reference',
            references: [{ url: 'https://example.com/a.mp4', kind: 'video' }],
          }),
        ),
      'invalid-reference',
    )
    // Six images exceed the Flash limit of five.
    const six = Array.from({ length: 6 }, (_unused, index) => ({ url: `https://example.com/${index}.png`, kind: 'image' as const }))
    expectCode(
      () => validateRequest(videoRequest({ model: 'agnes-video-2.5-flash', mode: 'reference', references: six })),
      'invalid-reference',
    )
  })

  it('refuses references in text mode and non-public reference URLs', () => {
    expectCode(
      () => validateRequest(videoRequest({ mode: 'text', references: [{ url: 'https://example.com/a.png', kind: 'image' }] })),
      'invalid-reference',
    )
    expectCode(
      () => validateRequest(imageRequest({ references: [{ url: 'http://insecure/a.png', kind: 'image' }] })),
      'invalid-reference',
    )
  })
})

describe('private-address and origin guards', () => {
  it('refuses every IPv6 and trailing-dot spelling of a private host', () => {
    // Regression: `new URL().hostname` keeps IPv6 brackets and a trailing dot,
    // so comparing against "::1" / "localhost" let all of these through.
    const blocked = [
      'https://[::1]/a.png',
      'https://[0:0:0:0:0:0:0:1]/a.png',
      'https://[fd00::1]/a.png',
      'https://[fe80::1]/a.png',
      'https://[::ffff:127.0.0.1]/a.png',
      'https://[::ffff:7f00:1]/a.png',
      'https://[::ffff:10.0.0.1]/a.png',
      'https://LOCALHOST./a.png',
      'https://localhost/a.png',
      'https://api.localhost/a.png',
      'https://service.internal/a.png',
      'https://10.1.2.3/a.png',
      'https://172.16.0.1/a.png',
      'https://192.168.1.1/a.png',
      'https://169.254.1.1/a.png',
      'https://100.64.0.1/a.png',
      'https://127.0.0.1/a.png',
    ]
    for (const url of blocked) {
      expectCode(() => validateRequest(imageRequest({ references: [{ url, kind: 'image' }] })), 'invalid-reference')
    }
  })

  it('still accepts a genuine public HTTPS reference', () => {
    expect(
      validateRequest(imageRequest({ references: [{ url: 'https://cdn.example.com/a.png', kind: 'image' }] })).id,
    ).toBe('agnes-image-2.5-flash')
    expect(
      validateRequest(imageRequest({ references: [{ url: 'data:image/png;base64,iVBORw0KGgo=', kind: 'image' }] })).id,
    ).toBe('agnes-image-2.5-flash')
  })

  it('accepts a stored image as a reference without a URL', () => {
    // "Continue editing" seeds the next request with an artifact this plugin
    // already owns. The Host resolves it to a data: URI from the stored bytes,
    // because the upstream cannot reach the authenticated local media route.
    expect(
      validateRequest(
        imageRequest({ references: [{ kind: 'image', generationId: '11111111-1111-4111-8111-111111111111' }] }),
      ).id,
    ).toBe('agnes-image-2.5-flash')
  })

  it('refuses a reference with two locators or with none', () => {
    // A payload carrying both would let one silently win; carrying neither
    // reaches the API as an empty image, which the provider answers with a 400.
    expectCode(
      () =>
        validateRequest(
          imageRequest({
            references: [{ url: 'https://cdn.example.com/a.png', kind: 'image', generationId: '11111111-1111-4111-8111-111111111111' }],
          }),
        ),
      'invalid-reference',
    )
    expectCode(() => validateRequest(imageRequest({ references: [{ kind: 'image' }] })), 'invalid-reference')
  })

  it('refuses a stored reference for audio or video, which needs a public address', () => {
    expectCode(
      () =>
        validateRequest(
          videoRequest({ mode: 'reference', references: [{ kind: 'video', generationId: '11111111-1111-4111-8111-111111111111' }] }),
        ),
      'invalid-reference',
    )
  })

  it('refuses a reference URL carrying userinfo', () => {
    // userinfo is how a hostile URL impersonates a trusted host.
    expectCode(
      () => validateRequest(imageRequest({ references: [{ url: 'https://user:pass@example.com/a.png', kind: 'image' }] })),
      'invalid-reference',
    )
  })

  it('compares parsed origins, so a prefixed host is not same-origin', () => {
    // Regression: `startsWith(baseUrl)` treated these as same-origin and would
    // have sent the bearer token to a host the operator never configured.
    expect(isSameOrigin('https://apihub.agnes-ai.com/v1/x.png', 'https://apihub.agnes-ai.com/v1')).toBe(true)
    expect(isSameOrigin('https://apihub.agnes-ai.com.evil.example/x.png', 'https://apihub.agnes-ai.com')).toBe(false)
    expect(isSameOrigin('https://apihub.agnes-ai.com@evil.example/x.png', 'https://apihub.agnes-ai.com')).toBe(false)
    expect(isSameOrigin('https://evil.example/x.png', 'https://apihub.agnes-ai.com/v1')).toBe(false)
    expect(isSameOrigin('not a url', 'https://apihub.agnes-ai.com/v1')).toBe(false)
  })
})

describe('request bodies', () => {
  it('nests image references in extra_body and asks for a URL', () => {
    const body = buildImageBody(imageRequest({ references: [{ url: 'https://example.com/a.png', kind: 'image' }] }))
    expect(body).toMatchObject({
      model: 'agnes-image-2.5-flash',
      size: '1K',
      ratio: '1:1',
      extra_body: { response_format: 'url', image: ['https://example.com/a.png'] },
    })
    // The documented contract forbids a top-level response_format.
    expect('response_format' in body).toBe(false)
  })

  it('refuses to send an unresolved stored reference instead of an empty image', () => {
    // The runtime inlines stored references BEFORE the client is called; a value
    // that reaches the body builder still symbolic would be sent as a missing
    // image, so it is a programming error worth an explicit refusal.
    expectCode(
      () => buildImageBody(imageRequest({ references: [{ kind: 'image', generationId: '11111111-1111-4111-8111-111111111111' }] })),
      'invalid-reference',
    )
  })

  it('builds the data: URI a stored image is inlined as', () => {
    expect(dataUriFor('image/png', new Uint8Array([0x01, 0x02]))).toBe('data:image/png;base64,AQI=')
  })

  it('sends seconds as a string and omits media for text mode', () => {
    const body = buildVideoBody(videoRequest())
    expect(body['seconds']).toBe('5')
    expect(body['mode']).toBe('text')
    expect('images' in body).toBe(false)
    expect('first_frame' in body).toBe(false)
  })

  it('maps the named keyframe slots onto first_frame and last_frame', () => {
    const body = buildVideoBody(
      videoRequest({ mode: 'keyframe', firstFrame: 'https://example.com/first.png', lastFrame: 'https://example.com/last.png' }),
    )
    expect(body['first_frame']).toBe('https://example.com/first.png')
    expect(body['last_frame']).toBe('https://example.com/last.png')
    // Keyframe mode must not leak the reference arrays.
    expect('images' in body).toBe(false)
  })

  it('maps reference mode onto the media arrays, wrapping videos as objects', () => {
    const body = buildVideoBody(
      videoRequest({
        mode: 'reference',
        references: [
          { url: 'https://example.com/a.png', kind: 'image' },
          { url: 'https://example.com/a.mp3', kind: 'audio' },
          { url: 'https://example.com/a.mp4', kind: 'video' },
        ],
      }),
    )
    expect(body['images']).toEqual(['https://example.com/a.png'])
    expect(body['audios']).toEqual(['https://example.com/a.mp3'])
    expect(body['videos']).toEqual([{ url: 'https://example.com/a.mp4', start_seconds: 0, require_audio: false }])
  })
})

describe('response parsing', () => {
  it('reads a URL image response and the upstream task id', () => {
    const parsed = parseImageResponse('{"data":[{"url":"https://x/a.png","b64_json":""}],"task_id":"task_1"}')
    expect(parsed.url).toBe('https://x/a.png')
    expect(parsed.b64).toBeUndefined()
    expect(parsed.taskId).toBe('task_1')
  })

  it('prefers base64 when the API returns it', () => {
    const parsed = parseImageResponse('{"data":[{"url":null,"b64_json":"iVBORw0KGgo="}]}')
    expect(parsed.b64).toBe('iVBORw0KGgo=')
    expect(parsed.url).toBeUndefined()
  })

  it('reports an empty image response instead of returning undefined', () => {
    expectCode(() => parseImageResponse('{"data":[]}'), 'upstream-failed')
    expectCode(() => parseImageResponse('not json'), 'upstream-failed')
  })

  it('reads a created video task, falling back to id', () => {
    expect(parseCreateResponse('{"video_id":"video_1"}').videoId).toBe('video_1')
    expect(parseCreateResponse('{"id":"task_9"}').videoId).toBe('task_9')
    expectCode(() => parseCreateResponse('{"status":"queued"}'), 'upstream-failed')
  })

  it('reads poll status, url and failure detail', () => {
    expect(parsePollResponse('{"status":"completed","url":"https://x/a.mp4"}').url).toBe('https://x/a.mp4')
    const failed = parsePollResponse('{"status":"failed","error":{"message":"Invalid reference media"}}')
    expect(failed.status).toBe('failed')
    expect(failed.error).toEqual({ message: 'Invalid reference media' })
  })
})

describe('upstream error mapping', () => {
  it('maps 401 to unauthorized and 429 to a retryable rate limit', () => {
    expect(fromUpstreamStatus(401, '{"message":"bad key"}').code).toBe('unauthorized')
    const limited = fromUpstreamStatus(429, '')
    expect(limited.code).toBe('rate-limited')
    expect(limited.retryable).toBe(true)
  })

  it('maps the observed video queue-full answer to its own retryable code', () => {
    // This exact body was returned by the live API on 2026-11-11.
    const failure = fromUpstreamStatus(
      503,
      '{"code":"video_queue_full","message":"video queue is full, please retry later (request id: abc)"}',
    )
    expect(failure.code).toBe('queue-full')
    expect(failure.retryable).toBe(true)
    // The message must say the cause is upstream capacity, not the request: a
    // bare "queue is full" left the user unable to tell whether they did
    // something wrong.
    expect(failure.message).toContain('队列已满')
    expect(failure.message).toContain('上游')
    // The request id is what Agnes support asks for, so it is preserved.
    expect(failure.details['requestId']).toBe('abc')
  })

  it('does not report an exhausted balance as an invalid key', () => {
    // Observed live on 2026-11-11 for agnes-video-2.5: the video endpoint
    // answers 403 `insufficient_user_quota`, which the generic 401/403 branch
    // would have blamed on the API key while the key was working fine.
    const failure = fromUpstreamStatus(
      403,
      '{"code":"insufficient_user_quota","message":"Failed to pre-consume quota, remaining: ＄0.100000, required: ＄0.125000 (request id: xyz)"}',
    )
    expect(failure.code).toBe('quota-exceeded')
    expect(failure.message).toContain('余额不足')
    expect(failure.message).not.toContain('Key 无效')
    expect(failure.retryable).toBe(false)
    // A genuine permission failure still reports as unauthorized.
    expect(fromUpstreamStatus(403, '{"message":"no access to this model"}').code).toBe('unauthorized')
  })

  it('maps a validation rejection to invalid-parameter and keeps the detail', () => {
    const failure = fromUpstreamStatus(400, '{"detail":"size must be 720P"}')
    expect(failure.code).toBe('invalid-parameter')
    expect(failure.message).toContain('size must be 720P')
  })

  it('never treats an HTML error page as a message', () => {
    expect(extractDetail('<html>gateway</html>')).toBe('')
    expect(fromUpstreamStatus(502, '<html>bad gateway</html>').code).toBe('upstream-failed')
  })
})

describe('base64 decoding', () => {
  it('round-trips canonical base64', () => {
    expect(Array.from(decodeBase64('iVBORw0KGgo='))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('refuses an empty payload', () => {
    expectCode(() => decodeBase64('   '), 'upstream-failed')
  })
})

describe('client transport', () => {
  it('downloads a URL image with no key when the URL is a public CDN', async () => {
    const calls: string[] = []
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      fetchImpl: async (input) => {
        calls.push(input)
        if (input.includes('/images/generations')) {
          return Response.json({ data: [{ url: 'https://cdn.example.com/a.png' }] })
        }
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
      },
    })
    const outcome = await client.generateImage(imageRequest())
    expect(outcome.mediaType).toBe('image/png')
    expect(outcome.bytes.byteLength).toBe(PNG_BYTES.byteLength)
    expect(calls).toHaveLength(2)
  })

  it('sends the bearer token to the API but not to a public CDN', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-secret',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      fetchImpl: async (input, init) => {
        seen.push({ url: input, auth: new Headers(init?.headers).get('authorization') })
        if (input.includes('/images/generations')) return Response.json({ data: [{ url: 'https://cdn.example.com/a.png' }] })
        return new Response(PNG_BYTES, { status: 200 })
      },
    })
    await client.generateImage(imageRequest())
    expect(seen[0]?.auth).toBe('Bearer sk-secret')
    // A third-party CDN URL must not receive the key.
    expect(seen[1]?.auth).toBeNull()
  })

  it('polls a video task until completion and downloads the result', async () => {
    let polls = 0
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 10_000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        if (input.includes('/videos')) return Response.json({ video_id: 'video_1', status: 'queued' })
        if (input.includes('/agnesapi')) {
          polls += 1
          if (polls < 3) return Response.json({ status: 'in_progress', progress: polls * 30 })
          return Response.json({ status: 'completed', url: 'https://cdn.example.com/a.mp4' })
        }
        const mp4 = new Uint8Array(12)
        mp4.set([0x66, 0x74, 0x79, 0x70], 4)
        return new Response(mp4, { status: 200 })
      },
    })
    const outcome = await client.generateVideo(videoRequest())
    expect(polls).toBe(3)
    expect(outcome.mediaType).toBe('video/mp4')
    expect(outcome.upstreamId).toBe('video_1')
  })

  it('always sends model_name when polling, which keyframe mode requires', async () => {
    const urls: string[] = []
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 10_000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        urls.push(input)
        if (input.includes('/videos')) return Response.json({ video_id: 'video_2' })
        if (input.includes('/agnesapi')) return Response.json({ status: 'completed', url: 'https://cdn.example.com/a.mp4' })
        return new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { status: 200 })
      },
    })
    await client.generateVideo(videoRequest({ mode: 'keyframe', firstFrame: 'https://example.com/f.png' }))
    const poll = urls.find((url) => url.includes('/agnesapi'))
    expect(poll).toContain('model_name=agnes-video-2.5')
  })

  it('surfaces a failed task with the upstream message', async () => {
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 10_000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        if (input.includes('/videos')) return Response.json({ video_id: 'video_3' })
        return Response.json({ status: 'failed', error: { message: 'Invalid reference media' } })
      },
    })
    await expect(client.generateVideo(videoRequest())).rejects.toMatchObject({
      code: 'upstream-failed',
      message: 'Invalid reference media',
    })
  })

  it('reports a timeout when the task never finishes', async () => {
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 0,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        if (input.includes('/videos')) return Response.json({ video_id: 'video_4' })
        return Response.json({ status: 'in_progress' })
      },
    })
    await expect(client.generateVideo(videoRequest())).rejects.toMatchObject({ code: 'timeout', retryable: true })
  })

  it('refuses media that exceeds the byte ceiling', async () => {
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 4,
      fetchImpl: async (input) => {
        if (input.includes('/images/generations')) return Response.json({ data: [{ url: 'https://cdn.example.com/a.png' }] })
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-length': String(PNG_BYTES.byteLength) } })
      },
    })
    await expect(client.generateImage(imageRequest())).rejects.toMatchObject({ code: 'too-large' })
  })

  it('retries a flaky media download, which the upstream CDN really does', async () => {
    // Observed live: the transfer aborts mid-body with UND_ERR_SOCKET. The image
    // was already generated, so throwing it away would waste a real result.
    let downloads = 0
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        if (input.includes('/images/generations')) return Response.json({ data: [{ url: 'https://cdn.example.com/a.png' }] })
        downloads += 1
        if (downloads < 3) throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })
        return new Response(PNG_BYTES, { status: 200 })
      },
    })
    const outcome = await client.generateImage(imageRequest())
    expect(downloads).toBe(3)
    expect(outcome.mediaType).toBe('image/png')
  })

  it('gives up after the bounded number of download attempts', async () => {
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024 * 1024,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        if (input.includes('/images/generations')) return Response.json({ data: [{ url: 'https://cdn.example.com/a.png' }] })
        throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })
      },
    })
    await expect(client.generateImage(imageRequest())).rejects.toBeInstanceOf(StudioError)
  })

  it('never calls the network when the request is invalid', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    const client = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024,
      fetchImpl,
    })
    await expect(client.generateImage(imageRequest({ model: 'agnes-video-2.5' }))).rejects.toBeInstanceOf(StudioError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('probes the model catalog and reports a failure without throwing', async () => {
    const ok = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024,
      fetchImpl: async () => Response.json({ data: [{ id: 'agnes-image-2.5-flash' }, { id: 'agnes-video-2.5' }] }),
    })
    expect((await ok.listModels()).models).toEqual(['agnes-image-2.5-flash', 'agnes-video-2.5'])

    const broken = createClient({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      resolveKey: async () => 'sk-test',
      imageTimeoutMs: 1000,
      videoTimeoutMs: 1000,
      pollIntervalMs: 1,
      maxMediaBytes: 1024,
      fetchImpl: async () => new Response('nope', { status: 500 }),
    })
    const probe = await broken.listModels()
    expect(probe.models).toEqual([])
    expect(probe.error).toBeTypeOf('string')
  })
})

describe('poll origin', () => {
  it('strips the version suffix so the non-/v1 poll endpoint is reachable', () => {
    expect(originOf('https://apihub.agnes-ai.com/v1')).toBe('https://apihub.agnes-ai.com')
    expect(originOf('https://apihub.agnes-ai.com/v1/')).toBe('https://apihub.agnes-ai.com')
    expect(originOf('https://proxy.example.com/agnes')).toBe('https://proxy.example.com/agnes')
  })
})
