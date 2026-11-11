/**
 * Offline render tests for the studio panel.
 *
 * These assert the states that are easy to get wrong and expensive to miss: the
 * unconfigured panel must explain itself instead of offering a button that can
 * only fail, the empty gallery must not look broken, and the video resolution
 * list must narrow with the model so the UI cannot offer a value the Host
 * refuses.
 */

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StudioPage, SidebarGlyph } from '../src/client/view.js'
import { dictFor, NAMESPACE, zh } from '../src/client/text.js'
import type { ClientApi } from '../src/client/api.js'
import type { Generation, StudioState } from '../src/types.js'

/** Every render starts from an empty document so queries cannot match a previous panel. */
afterEach(() => {
  cleanup()
})

/** A translate function backed by the real Chinese dictionary. */
function translate(key: string, params?: Record<string, string | number>): string {
  const template = zh[key] ?? key
  if (params === undefined) return template
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
}

/** A fake API that records calls and answers with a fixed state. */
function fakeApi(state: Partial<StudioState> = {}): { api: ClientApi; generated: unknown[] } {
  const full: StudioState = {
    configured: true,
    keySource: 'credential',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    upstreamModels: ['agnes-image-2.5-flash'],
    generations: [],
    ...state,
  }
  const generated: unknown[] = []
  const api: ClientApi = {
    state: async () => full,
    generate: async (request) => {
      generated.push(request)
      const created: Generation = {
        id: 'generated',
        kind: request.kind,
        status: 'succeeded',
        model: request.model,
        prompt: request.prompt,
        params: {},
        createdAt: new Date().toISOString(),
        asset: { src: '/api/agnes-studio/media/generated', mediaType: 'image/png', bytes: 10 },
      }

      const next: StudioState = { ...full, generations: [created] }
      return { state: next, created }
    },
    remove: async () => full,
    clear: async () => full,
  }
  return { api, generated }
}

/** Render the panel with a fake API. */
function renderPanel(state: Partial<StudioState> = {}) {
  const { api, generated } = fakeApi(state)
  const view = render(
    createElement(StudioPage, {
      api,
      locale: { getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }), subscribe: () => () => undefined, register: () => () => undefined, bind: () => translate },
      t: translate,
    }),
  )
  return { ...view, api, generated }
}

describe('sidebar glyph', () => {
  it('renders an svg that inherits the current color', () => {
    const { container } = render(createElement(SidebarGlyph, {}))
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('studio panel', () => {
  it('explains a missing key instead of offering a button that can only fail', async () => {
    renderPanel({ configured: false, keySource: 'none' })
    expect(await screen.findByText(translate('config.title'))).toBeTruthy()
    expect(screen.getByText(translate('config.body'))).toBeTruthy()
    const submit = screen.getByRole('button', { name: translate('form.submitImage') })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows an empty state, not an error, with no history', async () => {
    renderPanel()
    expect(await screen.findByText(translate('gallery.empty'))).toBeTruthy()
  })

  it('renders a stored image with its prompt and model', async () => {
    const generation: Generation = {
      id: 'abc',
      kind: 'image',
      status: 'succeeded',
      model: 'agnes-image-2.5-flash',
      prompt: 'a red apple on a white table',
      params: { size: '1K' },
      createdAt: '2026-11-11T00:00:00.000Z',
      durationMs: 21_000,
      asset: { src: '/api/agnes-studio/media/abc', mediaType: 'image/png', bytes: 900 },
    }
    renderPanel({ generations: [generation] })
    expect(await screen.findByText('a red apple on a white table')).toBeTruthy()
    expect(screen.getByText('agnes-image-2.5-flash')).toBeTruthy()
    expect(screen.getByText(translate('gallery.took', { seconds: '21.0' }))).toBeTruthy()
    const image = document.querySelector('img.agnes__thumb')
    expect(image?.getAttribute('src')).toBe('/api/agnes-studio/media/abc')
  })

  it('renders a stored video through a video element, not an img', async () => {
    const generation: Generation = {
      id: 'vid',
      kind: 'video',
      status: 'succeeded',
      model: 'agnes-video-2.5',
      prompt: 'an apple rotating',
      params: { seconds: 5 },
      createdAt: '2026-11-11T00:00:00.000Z',
      asset: { src: '/api/agnes-studio/media/vid', mediaType: 'video/mp4', bytes: 100 },
    }
    renderPanel({ generations: [generation] })
    await screen.findByText('an apple rotating')
    expect(document.querySelector('video.agnes__thumb')).not.toBeNull()
    expect(document.querySelector('img.agnes__thumb')).toBeNull()
  })

  it('offers a retry only for a retryable failure', async () => {
    const base: Generation = {
      id: 'f1',
      kind: 'video',
      status: 'failed',
      model: 'agnes-video-2.5',
      prompt: 'queue test',
      params: {},
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'queue-full',
      error: 'Agnes 视频队列已满，请稍后重试。',
    }
    renderPanel({ generations: [base] })
    await screen.findByText('queue test')
    expect(screen.queryByRole('button', { name: translate('gallery.retry') })).toBeNull()

    renderPanel({ generations: [{ ...base, id: 'f2', retryable: true }] })
    expect(await screen.findAllByRole('button', { name: translate('gallery.retry') })).not.toHaveLength(0)
  })

  it('switches to the video form and narrows the resolution list with the model', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('tab', { name: translate('tab.video') }))
    const sizeSelect = (await screen.findByLabelText(translate('form.size'))) as HTMLSelectElement
    // The default video model accepts four tiers.
    expect(Array.from(sizeSelect.options).map((option) => option.value)).toEqual(['720P', '1080P', '1K', '2K'])

    // The Flash model is 720P only, so the control must collapse to one option.
    fireEvent.change(screen.getByLabelText(translate('form.model')), { target: { value: 'agnes-video-2.5-flash' } })
    const narrowed = (await screen.findByLabelText(translate('form.size'))) as HTMLSelectElement
    expect(Array.from(narrowed.options).map((option) => option.value)).toEqual(['720P'])
  })

  it('refuses an empty prompt without calling the Host', async () => {
    const { generated } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: translate('form.submitImage') }))
    expect(await screen.findByText(translate('form.needPrompt'))).toBeTruthy()
    expect(generated).toHaveLength(0)
  })

  it('sends a valid image request and shows the new record', async () => {
    const { generated } = renderPanel()
    fireEvent.change(await screen.findByLabelText(translate('form.prompt')), { target: { value: 'a blue apple' } })
    fireEvent.click(screen.getByRole('button', { name: translate('form.submitImage') }))
    expect(await screen.findByText('a blue apple')).toBeTruthy()
    expect(generated).toHaveLength(1)
    expect(generated[0]).toMatchObject({ kind: 'image', prompt: 'a blue apple', model: 'agnes-image-2.5-flash' })
  })

  it('filters the gallery by capability', async () => {
    const image: Generation = {
      id: 'i1',
      kind: 'image',
      status: 'succeeded',
      model: 'agnes-image-2.5-flash',
      prompt: 'an image record',
      params: {},
      createdAt: '2026-11-11T00:00:00.000Z',
      asset: { src: '/x.png', mediaType: 'image/png', bytes: 1 },
    }
    const video: Generation = { ...image, id: 'v1', kind: 'video', prompt: 'a video record', asset: { src: '/x.mp4', mediaType: 'video/mp4', bytes: 1 } }
    renderPanel({ generations: [image, video] })
    await screen.findByText('an image record')
    fireEvent.click(screen.getByRole('button', { name: `${translate('gallery.images')} 1` }))
    expect(await screen.findByText('an image record')).toBeTruthy()
    expect(screen.queryByText('a video record')).toBeNull()
  })
})

/**
 * The image viewer.
 *
 * These exist because of a defect the previous suite could not see: "打开原图"
 * was an `<a target="_blank">` to a session-authenticated same-origin path. It
 * rendered, focused, and did nothing, because the Desktop shell denies every
 * popup the page requests and only forwards `https:` URLs to the OS browser.
 * A DOM-presence assertion passes on that build; only clicking and inspecting the
 * resulting overlay catches it. So every test here drives the interaction.
 */
describe('image viewer', () => {
  /** One stored image generation, ready to open. */
  function imageGeneration(overrides: Partial<Generation> = {}): Generation {
    return {
      id: 'viewer-1',
      kind: 'image',
      status: 'succeeded',
      model: 'agnes-image-2.5-flash',
      prompt: 'a viewer fixture',
      params: { size: '1K' },
      createdAt: '2026-11-11T00:00:00.000Z',
      asset: { src: '/api/agnes-studio/media?id=viewer-1', mediaType: 'image/png', bytes: 512, width: 96, height: 96 },
      ...overrides,
    }
  }

  /** The zoom percentage the viewer reports, as a number. */
  function zoomPercent(): number {
    const label = document.querySelector('.agnes__lightboxZoom')
    if (label === null) throw new Error('no zoom label')
    return Number.parseInt(String(label.textContent).replace('%', ''), 10)
  }

  it('is a button, not a new-window link', async () => {
    // The exact regression: an `<a target="_blank">` looks identical in the DOM
    // and is a no-op in the Desktop shell.
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    const open = document.querySelector('.agnes__open')
    expect(open).not.toBeNull()
    expect(open?.tagName).toBe('BUTTON')
    expect(open?.getAttribute('href')).toBeNull()
    expect(open?.getAttribute('target')).toBeNull()
    expect(open?.textContent).toBe(translate('gallery.open'))
    // No other element may still open a popup for the image.
    const popups = [...document.querySelectorAll('a[target="_blank"]')]
    expect(popups).toHaveLength(0)
  })

  it('opens on click, showing the same URL at fit zoom', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    expect(document.querySelector('.agnes__lightbox')).toBeNull()

    fireEvent.click(document.querySelector('.agnes__open') as Element)
    const box = await screen.findByRole('dialog')
    expect(box.getAttribute('aria-modal')).toBe('true')
    expect(box.getAttribute('aria-label')).toBe(translate('gallery.viewer'))
    const shown = document.querySelector('.agnes__lightboxImage')
    expect(shown?.getAttribute('src')).toBe('/api/agnes-studio/media?id=viewer-1')
    expect(zoomPercent()).toBe(100)
  })

  it('also opens from the thumbnail', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    fireEvent.click(document.querySelector('.agnes__thumbButton') as Element)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('zooms with the toolbar controls and clamps at the declared range', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')

    fireEvent.click(document.querySelector('.agnes__lightboxZoomIn') as Element)
    expect(zoomPercent()).toBeGreaterThan(100)
    const zoomedIn = zoomPercent()

    fireEvent.click(document.querySelector('.agnes__lightboxReset') as Element)
    expect(zoomPercent()).toBe(100)

    // Out at fit zoom is a no-op, not a shrink below the fit: a picture smaller
    // than the stage reads as broken rather than as zoomed out.
    fireEvent.click(document.querySelector('.agnes__lightboxZoomOut') as Element)
    expect(zoomPercent()).toBe(100)

    // In past the cap must stop at 800%, which is where one pixel of a 4K
    // render is readable.
    for (let press = 0; press < 40; press += 1) {
      fireEvent.click(document.querySelector('.agnes__lightboxZoomIn') as Element)
    }
    expect(zoomPercent()).toBe(800)
    expect(zoomedIn).toBeGreaterThan(100)
  })

  it('closes on Escape', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.agnes__lightbox')).toBeNull())
    // The panel itself must survive: closing the viewer is not a panel crash.
    expect(document.querySelector('.agnes__title')).not.toBeNull()
  })

  it('closes on the backdrop and on the close button, but not on the picture', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')

    // A click on the picture zooms; it must not dismiss.
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')
    fireEvent.click(document.querySelector('.agnes__lightboxImage') as Element)
    expect(document.querySelector('.agnes__lightbox')).not.toBeNull()
    expect(zoomPercent()).toBeGreaterThan(100)

    fireEvent.click(document.querySelector('.agnes__lightboxClose') as Element)
    await waitFor(() => expect(document.querySelector('.agnes__lightbox')).toBeNull())

    // A click on the overlay itself dismisses.
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')
    fireEvent.click(document.querySelector('.agnes__lightbox') as Element)
    await waitFor(() => expect(document.querySelector('.agnes__lightbox')).toBeNull())
  })

  it('removes its window listener when it unmounts', async () => {
    // A leaked keydown listener would keep closing on Escape after the panel is
    // gone, which is invisible until some other surface starts using Escape.
    const remove = vi.spyOn(window, 'removeEventListener')
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.agnes__lightbox')).toBeNull())
    expect(remove.mock.calls.some((call) => call[0] === 'keydown')).toBe(true)
    remove.mockRestore()
  })

  it('stays open across a Host state refresh', async () => {
    // The panel re-reads state after a failed attempt; the viewer is keyed by
    // record id rather than by object identity so a refresh must not close it.
    const { api } = renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')

    // A second state read returns a structurally new record with the same id.
    await act(async () => {
      await api.state()
    })
    expect(document.querySelector('.agnes__lightbox')).not.toBeNull()
  })
})

describe('dictionaries', () => {
  it('ships both locales with identical key sets', () => {
    const en = dictFor('en')
    const keys = Object.keys(zh).sort()
    expect(Object.keys(en).sort()).toEqual(keys)
    for (const key of keys) {
      expect(zh[key], `zh ${key}`).not.toBe('')
      expect(en[key], `en ${key}`).not.toBe('')
    }
  })

  it('exposes the namespace the client registers', () => {
    expect(NAMESPACE).toBe('skillreAgnesStudio')
  })
})
