/**
 * Offline tests for the model-facing tools and the key resolver.
 *
 * The tool layer is where a wrong default silently costs a user a bad request,
 * so the argument mapping is asserted directly: the model supplies loose strings,
 * the capability table decides what they mean, and an impossible combination is
 * refused with the accepted set in the message.
 */

import { describe, expect, it } from 'vitest'
import { describeGeneration, imageRequestFrom, videoRequestFrom } from '../src/tools.js'
import { createKeyResolver } from '../src/index.js'
import { resolveConfig, expandHome, resolveDataDir } from '../src/config.js'
import type { Generation } from '../src/types.js'

describe('image tool arguments', () => {
  it('defaults to the newest image model and a square 1K canvas', () => {
    const request = imageRequestFrom({ prompt: 'a red apple' })
    expect(request).toMatchObject({ kind: 'image', model: 'agnes-image-2.5-flash', size: '1K', ratio: '1:1' })
  })

  it('honours an explicit model, size and ratio', () => {
    const request = imageRequestFrom({ prompt: 'x', model: 'agnes-image-2.0-flash', size: '4K', ratio: '21:9' })
    expect(request).toMatchObject({ model: 'agnes-image-2.0-flash', size: '4K', ratio: '21:9' })
  })

  it('maps referenceImages to image references', () => {
    const request = imageRequestFrom({ prompt: 'x', referenceImages: ['https://example.com/a.png'] })
    expect(request.references).toEqual([{ url: 'https://example.com/a.png', kind: 'image' }])
  })

  it('refuses values outside the documented sets with the accepted set in the message', () => {
    expect(() => imageRequestFrom({ prompt: 'x', size: '8K' })).toThrowError(/1K \/ 2K \/ 3K \/ 4K/)
    expect(() => imageRequestFrom({ prompt: 'x', ratio: '5:4' })).toThrowError(/1:1/)
  })
})

describe('video tool arguments', () => {
  it('defaults to the full video model at 720P, 16:9, 5 seconds', () => {
    const request = videoRequestFrom({ prompt: 'a cat' })
    expect(request).toMatchObject({ kind: 'video', model: 'agnes-video-2.5', mode: 'text', size: '720P', ratio: '16:9', seconds: 5 })
  })

  it('follows the model when it only supports one resolution', () => {
    // The Flash model is fixed to 720P, so the default must not be inherited
    // from the global table.
    const request = videoRequestFrom({ prompt: 'x', model: 'agnes-video-2.5-flash' })
    expect(request).toMatchObject({ size: '720P' })
    expect(() => videoRequestFrom({ prompt: 'x', model: 'agnes-video-2.5-flash', size: '1080P' })).toThrowError(/720P/)
  })

  it('promotes keyframes to keyframe mode and keeps them in named slots', () => {
    const request = videoRequestFrom({
      prompt: 'x',
      firstFrame: 'https://example.com/first.png',
      lastFrame: 'https://example.com/last.png',
    })
    expect(request.mode).toBe('keyframe')
    expect(request.firstFrame).toBe('https://example.com/first.png')
    expect(request.lastFrame).toBe('https://example.com/last.png')
    // Frames must not also appear in the reference array.
    expect(request.references).toHaveLength(0)
  })

  it('keeps a lone last frame as a last frame', () => {
    // Regression: the filtered positional array turned `[lastFrame]` into index 0,
    // so the video started on the wrong picture with no error.
    const request = videoRequestFrom({ prompt: 'x', lastFrame: 'https://example.com/last.png' })
    expect(request.mode).toBe('keyframe')
    expect(request.firstFrame).toBeUndefined()
    expect(request.lastFrame).toBe('https://example.com/last.png')
  })

  it('keeps an explicit mode over the keyframe inference', () => {
    const request = videoRequestFrom({ prompt: 'x', mode: 'reference', referenceImages: ['https://example.com/a.png'] })
    expect(request.mode).toBe('reference')
  })

  it('refuses an out-of-range duration and an unknown mode', () => {
    expect(() => videoRequestFrom({ prompt: 'x', seconds: 30 })).toThrowError(/seconds/)
    expect(() => videoRequestFrom({ prompt: 'x', mode: 'magic' })).toThrowError(/mode/)
  })

  it('passes an explicit seed through', () => {
    expect(videoRequestFrom({ prompt: 'x', seed: 42 })).toMatchObject({ seed: 42 })
  })
})

describe('tool result text', () => {
  const generation: Generation = {
    id: 'abc',
    kind: 'image',
    status: 'succeeded',
    model: 'agnes-image-2.5-flash',
    prompt: 'a red apple',
    params: { size: '1K', ratio: '1:1', references: 0 },
    createdAt: '2026-11-11T00:00:00.000Z',
    durationMs: 21_000,
    asset: { src: '/api/agnes-studio/media/abc', mediaType: 'image/png', bytes: 925_231 },
  }

  it('names the model, prompt, parameters and storage id', () => {
    const text = describeGeneration(generation)
    expect(text).toContain('agnes-image-2.5-flash')
    expect(text).toContain('a red apple')
    expect(text).toContain('size=1K')
    expect(text).toContain('abc')
    expect(text).toContain('21.0s')
  })

  it('tells the model where a video can be found instead of implying it is visible', () => {
    const text = describeGeneration({ ...generation, kind: 'video', asset: { src: '/api/x', mediaType: 'video/mp4', bytes: 10 } })
    expect(text).toContain('Agnes Studio panel')
  })
})

describe('key resolution', () => {
  const config = resolveConfig({})

  it('prefers the credential store over the environment', async () => {
    const resolve = createKeyResolver(config, { resolve: async () => ({ value: 'from-credential', source: 'store' }) }, {
      AGNES_API_KEY: 'from-env',
    })
    expect(await resolve()).toEqual({ key: 'from-credential', source: 'credential' })
  })

  it('falls back to the environment when the credential store is empty', async () => {
    const resolve = createKeyResolver(config, { resolve: async () => undefined }, { AGNES_API_KEY: 'from-env' })
    expect(await resolve()).toEqual({ key: 'from-env', source: 'environment' })
  })

  it('treats a blank value as absent at both layers', async () => {
    const blankCredential = createKeyResolver(config, { resolve: async () => ({ value: '   ', source: 'store' }) }, {
      AGNES_API_KEY: 'from-env',
    })
    expect(await blankCredential()).toEqual({ key: 'from-env', source: 'environment' })

    const blankBoth = createKeyResolver(config, { resolve: async () => undefined }, { AGNES_API_KEY: '  ' })
    await expect(blankBoth()).rejects.toMatchObject({ code: 'not-configured' })
  })

  it('still uses an environment key when the credential store throws', async () => {
    const resolve = createKeyResolver(
      config,
      {
        resolve: async () => {
          throw new Error('store offline')
        },
      },
      { AGNES_API_KEY: 'from-env' },
    )
    expect(await resolve()).toEqual({ key: 'from-env', source: 'environment' })
  })

  it('reports not-configured rather than sending an empty bearer token', async () => {
    const resolve = createKeyResolver(config, undefined, {})
    await expect(resolve()).rejects.toMatchObject({ code: 'not-configured' })
  })
})

describe('configuration', () => {
  it('applies the declared defaults', () => {
    const config = resolveConfig()
    expect(config.baseUrl).toBe('https://apihub.agnes-ai.com/v1')
    expect(config.enableTools).toBe(true)
    expect(config.historyLimit).toBe(200)
  })

  it('strips a trailing slash from a custom base URL', () => {
    expect(resolveConfig({ baseUrl: 'https://proxy.example.com/v1/' }).baseUrl).toBe('https://proxy.example.com/v1')
  })

  it('expands a leading tilde', () => {
    expect(expandHome('~/.dsh/agnes-studio', '/Users/x')).toBe('/Users/x/.dsh/agnes-studio')
    expect(expandHome('/absolute/path', '/Users/x')).toBe('/absolute/path')
  })

  it('defaults dataDir to empty so it follows the harness home', () => {
    // A hard-coded ~/.dsh default escapes an isolated DSH_HOME; that bug made a
    // test profile try to write into the user's real data directory.
    expect(resolveConfig().dataDir).toBe('')
  })

  it('follows DSH_HOME when no dataDir is configured', () => {
    expect(resolveDataDir('', { DSH_HOME: '/tmp/owned-home' }, '/Users/x')).toBe('/tmp/owned-home/agnes-studio')
    expect(resolveDataDir('', { DSH_HOME: '/tmp/owned-home/' }, '/Users/x')).toBe('/tmp/owned-home/agnes-studio')
  })

  it('falls back to the user home only when DSH_HOME is unset', () => {
    expect(resolveDataDir('', {}, '/Users/x')).toBe('/Users/x/.dsh/agnes-studio')
    expect(resolveDataDir('', { DSH_HOME: '   ' }, '/Users/x')).toBe('/Users/x/.dsh/agnes-studio')
  })

  it('lets an explicit dataDir win over DSH_HOME, expanding a tilde', () => {
    expect(resolveDataDir('/explicit/data', { DSH_HOME: '/tmp/owned-home' }, '/Users/x')).toBe('/explicit/data')
    expect(resolveDataDir('~/mydata', { DSH_HOME: '/tmp/owned-home' }, '/Users/x')).toBe('/Users/x/mydata')
  })
})
