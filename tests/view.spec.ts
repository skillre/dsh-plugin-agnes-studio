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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StudioPage, SidebarGlyph } from '../src/client/view.js'
import { dictFor, NAMESPACE, zh } from '../src/client/text.js'
import type { ClientApi } from '../src/client/api.js'
import type { Generation, MediaKind, StudioState } from '../src/types.js'

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
function fakeApi(state: Partial<StudioState> = {}): {
  api: ClientApi
  generated: unknown[]
  retried: string[]
  retryAll: boolean[]
  optimized: { prompt: string; kind: MediaKind }[]
} {
  const full: StudioState = {
    configured: true,
    keySource: 'credential',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    upstreamModels: ['agnes-image-2.5-flash'],
    generations: [],
    running: [],
    ...state,
  }
  const generated: unknown[] = []
  /** The record id each retry targeted. */
  const retried: string[] = []
  /** Whether each retry asked the Host for the continuous loop. */
  const retryAll: boolean[] = []
  const optimized: { prompt: string; kind: MediaKind }[] = []
  const api: ClientApi = {
    state: async () => full,
    // The Host answers a start by registering a job; the panel then polls.
    start: async (request, retryOf) => {
      generated.push(request)
      if (retryOf !== undefined) retried.push(retryOf)
      return {
        ...full,
        running: [
          { id: retryOf ?? 'generated', kind: request.kind, prompt: request.prompt, model: request.model, startedAt: new Date().toISOString(), ...(retryOf === undefined ? {} : { retryOf }) },
        ],
      }
    },
    retry: async (id, options) => {
      retried.push(id)
      retryAll.push(options?.retryAll === true)
      const target = full.generations.find((generation) => generation.id === id)
      return { ...full, running: [{ id, kind: target?.kind ?? 'image', prompt: target?.prompt ?? '', model: target?.model ?? '', startedAt: new Date().toISOString(), retryOf: id }] }
    },
    cancel: async () => ({ ...full, running: [] }),
    optimize: async (prompt, kind) => {
      optimized.push({ prompt, kind })
      return `${prompt} —— 具体、高清、自然光线`
    },
    remove: async () => full,
    clear: async () => full,
  }
  return { api, generated, retried, retryAll, optimized }
}

/** Render the panel with a fake API. */
function renderPanel(state: Partial<StudioState> = {}) {
  const { api, generated, retried, retryAll, optimized } = fakeApi(state)
  const view = render(
    createElement(StudioPage, {
      api,
      locale: { getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }), subscribe: () => () => undefined, register: () => () => undefined, bind: () => translate },
      t: translate,
    }),
  )
  return { ...view, api, generated, retried, retryAll, optimized }
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

  it('retries the record the click belongs to, in place, without adding a card', async () => {
    // Retry is a Host operation keyed by the record id: the panel must not resend a
    // shared "last submitted" request, and it must not depend on anything only this
    // component instance remembers. That is exactly why retry did nothing after the
    // user left the studio and came back — the remembered request was gone.
    //
    // It also must not put a placeholder BESIDE the failed card. The Host reuses the
    // failed record's id, so two cards for one task is a rendering bug that "heals"
    // only when the attempt settles — reported from real use as "a new task pops out,
    // then the two merge into one".
    const failedA: Generation = {
      id: 'aaaa1111-1111-4111-8111-111111111111',
      kind: 'image',
      status: 'failed',
      model: 'agnes-image-2.1-flash',
      prompt: 'a blue square',
      params: {},
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'upstream-failed',
      error: '上游 502',
      retryable: true,
      request: { kind: 'image', prompt: 'a blue square', model: 'agnes-image-2.1-flash', size: '1K', ratio: '1:1', references: [] },
    }
    const failedB: Generation = {
      ...failedA,
      id: 'bbbb2222-2222-4222-8222-222222222222',
      prompt: 'a green circle',
      errorCode: 'upstream-failed-again',
      error: '上游 503',
      request: { kind: 'image', prompt: 'a green circle', model: 'agnes-image-2.1-flash', size: '2K', ratio: '4:3', references: [] },
    }
    const { retried } = renderPanel({ generations: [failedA, failedB] })
    const retryButtons = await screen.findAllByRole('button', { name: translate('gallery.retry') })
    expect(retryButtons).toHaveLength(2)

    // The gallery lists newest first, so the second card is failedB.
    fireEvent.click(retryButtons[1] as HTMLElement)
    await waitFor(() => {
      expect(retried).toHaveLength(1)
    })
    expect(retried[0]).toBe(failedB.id)

    // The clicked card IS the progress card: same slot, same history row.
    const retryingCard = await waitFor(() => {
      const card = document.querySelector('.agnes__card--retrying')
      expect(card).not.toBeNull()
      return card as HTMLElement
    })
    expect(document.querySelector('.agnes__card--pending')).toBeNull()
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(2)
    expect(retryingCard.textContent).toContain(translate('hint.retrying'))
    expect(retryingCard.querySelector('.agnes__spinner')).not.toBeNull()
    expect(retryingCard.querySelector('.agnes__thumbEmpty')).toBeNull()
    // The stale failure line and its retry button are gone from the retried card;
    // the untouched failure still shows both.
    expect(screen.queryByText('上游 503')).toBeNull()
    expect(screen.getByText('上游 502')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: translate('gallery.retry') })).toHaveLength(1)
  })

  it('returns the record to its failed card when a retry is cancelled', async () => {
    // Cancelling must not strand the row in a "working" state, and it must not
    // leave a record behind: the Host only stores SETTLED attempts, so the card
    // goes back to the failure the user can retry again.
    const failed: Generation = {
      id: 'cccc3333-3333-4333-8333-333333333333',
      kind: 'video',
      status: 'failed',
      model: 'agnes-video-2.5-flash',
      prompt: 'a queue test',
      params: {},
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'queue-full',
      error: '队列已满',
      retryable: true,
      request: { kind: 'video', prompt: 'a queue test', model: 'agnes-video-2.5-flash', mode: 'text', size: '720P', ratio: '16:9', seconds: 5, references: [] },
    }
    renderPanel({ generations: [failed] })
    fireEvent.click(await screen.findByRole('button', { name: translate('gallery.retry') }))
    const retryingCard = await waitFor(() => {
      const card = document.querySelector('.agnes__card--retrying')
      expect(card).not.toBeNull()
      return within(card as HTMLElement)
    })
    // The retry is reported by the card and nowhere else: one progress surface,
    // one cancel button for the task.
    expect(screen.queryAllByRole('button', { name: translate('action.cancelJob') })).toHaveLength(1)
    fireEvent.click(retryingCard.getByRole('button', { name: translate('action.cancelJob') }))

    await waitFor(() => expect(document.querySelector('.agnes__card--retrying')).toBeNull())
    expect(document.querySelector('.agnes__card--pending')).toBeNull()
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(1)
    expect(screen.getByText('队列已满')).toBeTruthy()
    expect(screen.getByRole('button', { name: translate('gallery.retry') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: translate('action.cancelJob') })).toBeNull()
  })

  it('switches to the video form and narrows the resolution list with the model', async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole('tab', { name: translate('tab.video') }))

    /** The resolution chips currently offered, in order. */
    const sizeValues = (): string[] => {
      const group = screen.getByRole('radiogroup', { name: translate('form.size') })
      return [...group.querySelectorAll('[role="radio"]')].map((node) => String(node.textContent))
    }

    // The default video model accepts four tiers, each rendered as its own chip
    // so the alternatives are visible instead of hidden in a popup.
    expect(sizeValues()).toEqual(['720P', '1080P', '1K', '2K'])

    // The Flash model is 720P only, so the control must collapse to one option.
    fireEvent.change(screen.getByLabelText(translate('form.model')), { target: { value: 'agnes-video-2.5-flash' } })
    await waitFor(() => expect(sizeValues()).toEqual(['720P']))
  })

  it('explains the selected model and the expected output size', async () => {
    renderPanel()
    // The model's own `note` is the reason a control narrowed, so it is shown
    // rather than left to be discovered by trying a value the API refuses.
    expect(await screen.findByText(/复杂构图/)).toBeTruthy()
    expect(screen.getByText(translate('hint.dimensions', { width: 1024, height: 1024 }))).toBeTruthy()
  })

  it('picks the control shape from the option count', async () => {
    renderPanel()
    // Four image tiers: a segmented control, because every alternative should
    // stay on screen.
    expect(screen.getByRole('radiogroup', { name: translate('form.size') }).className).toBe('agnes__seg')
    // Eight ratios: chips, because eight segments would shrink the labels.
    expect(screen.getByRole('radiogroup', { name: translate('form.ratio') }).className).toBe('agnes__chips')
  })

  it('fills the prompt from an example chip', async () => {
    renderPanel()
    const example = await screen.findByText(translate('example.image.1'))
    fireEvent.click(example)
    expect((screen.getByLabelText(translate('form.prompt')) as HTMLTextAreaElement).value).toBe(translate('example.image.1'))
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
    // The filters are a tablist, so they are reachable as tabs and announce
    // which one is selected.
    const imageTab = screen.getAllByRole('tab', { name: `${translate('gallery.images')} 1` })[0]
    fireEvent.click(imageTab as Element)
    expect(await screen.findByText('an image record')).toBeTruthy()
    expect(screen.queryByText('a video record')).toBeNull()
    expect(imageTab?.getAttribute('aria-selected')).toBe('true')
  })

  it('shows a skeleton card for a running job reported by the Host', async () => {
    // A running job is Host state, not panel state: the panel renders the slot the
    // result will fill from `state.running`, which is why it is still there after
    // the user leaves the studio and comes back.
    const { api } = fakeApi({
      running: [{ id: 'job-1', kind: 'video', prompt: 'a slow one', model: 'agnes-video-2.5', startedAt: new Date().toISOString() }],
    })
    render(
      createElement(StudioPage, {
        api,
        locale: { getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }), subscribe: () => () => undefined, register: () => () => undefined, bind: () => translate },
        t: translate,
      }),
    )
    await waitFor(() => expect(document.querySelector('.agnes__card--pending')).not.toBeNull())
    // The submit is disabled while it runs, so a double click cannot double the cost.
    expect((screen.getByRole('button', { name: translate('form.submitImage') }) as HTMLButtonElement).disabled).toBe(true)
    // The job cannot be stopped from anywhere else, so the panel offers it.
    expect(screen.getAllByRole('button', { name: translate('action.cancelJob') }).length).toBeGreaterThan(0)
  })

  it('shows a Host-reported retry as progress on the record, not as a second card', async () => {
    // Coming back to the studio (or reloading the page) while a retry is still
    // running must render the same in-place state as the click did: the Host
    // reports the job with `retryOf`, so the record's card is the progress card.
    const failed: Generation = {
      id: 'dddd4444-4444-4444-8444-444444444444',
      kind: 'image',
      status: 'failed',
      model: 'agnes-image-2.5-flash',
      prompt: 'retry me after a reload',
      params: {},
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'timeout',
      error: '上游超时',
      retryable: true,
      request: { kind: 'image', prompt: 'retry me after a reload', model: 'agnes-image-2.5-flash', size: '1K', ratio: '1:1', references: [] },
    }
    renderPanel({
      generations: [failed],
      running: [
        {
          id: failed.id,
          kind: 'image',
          prompt: failed.prompt,
          model: failed.model,
          startedAt: new Date().toISOString(),
          retryOf: failed.id,
        },
      ],
    })

    const card = await waitFor(() => {
      const found = document.querySelector('.agnes__card--retrying')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(1)
    expect(document.querySelector('.agnes__card--pending')).toBeNull()
    expect(document.querySelector('.agnes__busy')).toBeNull()
    expect(card.textContent).toContain(translate('hint.retrying'))
    expect(within(card).getByRole('button', { name: translate('action.cancelJob') })).toBeTruthy()
  })

  it('keeps polling while the Host reports a running job, then stops', async () => {
    // Coming back to the studio must show progress, which only works if the panel
    // asks the Host. This asserts the poll actually happens and then ceases.
    let polls = 0
    const running = [{ id: 'job-1', kind: 'image' as const, prompt: 'slow', model: 'm', startedAt: new Date().toISOString() }]
    const api: ClientApi = {
      ...fakeApi().api,
      state: async () => {
        polls += 1
        // The second poll reports the job finished.
        return {
          configured: true,
          keySource: 'credential',
          baseUrl: '',
          upstreamModels: [],
          generations: [],
          running: polls >= 2 ? [] : running,
        }
      },
    }
    render(
      createElement(StudioPage, {
        api,
        locale: { getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }), subscribe: () => () => undefined, register: () => () => undefined, bind: () => translate },
        t: translate,
      }),
    )
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2), { timeout: 6000 })
    // Once the job settled the interval must stop, or an idle panel would poll forever.
    const settledAt = polls
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(polls).toBe(settledAt)
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
describe('version stack', () => {
  /** One stored picture; `from` makes it a continuation of another record. */
  function version(id: string, prompt: string, from?: string): Generation {
    return {
      id,
      kind: 'image',
      status: 'succeeded',
      model: 'agnes-image-2.5-flash',
      prompt,
      params: { size: '1K', ratio: '1:1' },
      createdAt: '2026-11-11T00:00:00.000Z',
      asset: { src: `/api/agnes-studio/media?id=${id}`, mediaType: 'image/png', bytes: 900 },
      ...(from === undefined ? {} : { derivedFrom: from }),
      ...(from === undefined
        ? {}
        : {
            request: {
              kind: 'image' as const,
              prompt,
              model: 'agnes-image-2.5-flash',
              size: '1K' as const,
              ratio: '1:1' as const,
              references: [{ kind: 'image' as const, generationId: from }],
            },
          }),
    }
  }

  /** The ids whose thumbnails are rendered inside a stack's front card. */
  function frontSources(): string[] {
    const front = document.querySelector('.agnes__stackFront')
    if (front === null) return []
    return [...front.querySelectorAll('img.agnes__thumb')].map((img) => img.getAttribute('src') ?? '')
  }

  it('renders a chain of continuations as ONE card, newest on top', async () => {
    // The complaint this fixes: a chain of edits looked like three unrelated
    // results, so the user could not tell which one was the latest or that they
    // belonged together. The gallery lists newest first, so v3 is index 0.
    const v1 = version('v1000000-0000-4000-8000-000000000001', 'a red apple')
    const v2 = version('v2000000-0000-4000-8000-000000000002', 'a redder apple', v1.id)
    const v3 = version('v3000000-0000-4000-8000-000000000003', 'a scarlet apple', v2.id)
    renderPanel({ generations: [v3, v2, v1] })

    await screen.findByText('a scarlet apple')
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(1)
    expect(document.querySelector('.agnes__stack')).not.toBeNull()
    // Newest version is the visible face of the stack.
    expect(frontSources()).toEqual([v3.asset?.src])
    // The badge tells the user there is more than one version, and which one they
    // are looking at.
    expect(screen.getByText(translate('stack.badge', { index: 1, total: 3 }))).toBeTruthy()
  })

  it('leaves a single record exactly as it was', async () => {
    // Stack chrome on an ordinary result would be dead weight: one version can
    // never be scrubbed or expanded.
    const only = version('v1000000-0000-4000-8000-000000000001', 'a lonely apple')
    renderPanel({ generations: [only] })
    await screen.findByText('a lonely apple')
    expect(document.querySelector('.agnes__stack')).toBeNull()
    expect(document.querySelectorAll('.agnes__stackLayer')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: translate('stack.expand') })).toBeNull()
    // Its ordinary actions are untouched.
    expect(screen.getByRole('button', { name: translate('gallery.continueEditing') })).toBeTruthy()
  })

  it('switches versions as the pointer moves over the stack and restores on leave', async () => {
    // Hover scrubbing is the whole point: comparing versions must not need a
    // click, and it must never commit anything.
    const v1 = version('v1000000-0000-4000-8000-000000000001', 'v1 prompt')
    const v2 = version('v2000000-0000-4000-8000-000000000002', 'v2 prompt', v1.id)
    renderPanel({ generations: [v2, v1] })
    await screen.findByText('v2 prompt')
    expect(frontSources()).toEqual([v2.asset?.src])

    const stack = document.querySelector('.agnes__stack') as HTMLElement
    const frame = stack.querySelector('.agnes__thumbButton') as HTMLElement
    // jsdom reports a zero-height box, so the band maths needs a real height.
    Object.defineProperty(frame, 'getBoundingClientRect', {
      value: () => ({ top: 0, left: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) }),
    })
    // The gesture is scoped to the picture, not the action row: a card must not
    // swap identity under a pointer that is about to click one of its buttons.
    // The lower half of the picture is the second-newest version.
    fireEvent.mouseMove(frame, { clientY: 150, clientX: 100 })
    await waitFor(() => expect(frontSources()).toEqual([v1.asset?.src]))
    expect(screen.getByText(translate('stack.badge', { index: 2, total: 2 }))).toBeTruthy()

    // Leaving the stack snaps back to the newest version without changing data.
    fireEvent.mouseLeave(stack)
    await waitFor(() => expect(frontSources()).toEqual([v2.asset?.src]))
  })

  it('expands every version into its own card and collapses back', async () => {
    const v1 = version('v1000000-0000-4000-8000-000000000001', 'v1 prompt')
    const v2 = version('v2000000-0000-4000-8000-000000000002', 'v2 prompt', v1.id)
    const v3 = version('v3000000-0000-4000-8000-000000000003', 'v3 prompt', v2.id)
    renderPanel({ generations: [v3, v2, v1] })
    await screen.findByText('v3 prompt')
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: translate('stack.expand') }))
    await waitFor(() => expect(document.querySelectorAll('.agnes__card')).toHaveLength(3))
    // Newest first, and each version keeps its own actions.
    expect(screen.getByText('v1 prompt')).toBeTruthy()
    expect(screen.getByText('v2 prompt')).toBeTruthy()
    expect(screen.getByText('v3 prompt')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: translate('gallery.continueEditing') })).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: translate('stack.collapse') }))
    await waitFor(() => expect(document.querySelectorAll('.agnes__card')).toHaveLength(1))
    expect(document.querySelector('.agnes__stack')).not.toBeNull()
  })

  it('keeps the chain in its NEWEST version\'s gallery position', async () => {
    // The gallery is newest-first, so a chain must sit where its latest version
    // belongs: ordering it by the oldest version would push a freshly edited
    // result down the page, which is the opposite of what the user just did.
    const older = version('a0000000-0000-4000-8000-00000000000a', 'an unrelated apple')
    const v1 = version('v1000000-0000-4000-8000-000000000001', 'v1 prompt')
    const v2 = version('v2000000-0000-4000-8000-000000000002', 'v2 prompt', v1.id)
    // Newest first: the chain's head (v2) precedes the unrelated record.
    renderPanel({ generations: [v2, v1, older] })

    await screen.findByText('v2 prompt')
    // The stack element IS the grid cell, so it has to be matched on itself
    // rather than searched for among its descendants.
    const cells = [...document.querySelectorAll('.agnes__grid > *')]
    const stackIndex = cells.findIndex((cell) => cell.classList.contains('agnes__stack'))
    const unrelatedIndex = cells.findIndex((cell) => (cell.textContent ?? '').includes('an unrelated apple'))
    expect(stackIndex).toBe(0)
    expect(unrelatedIndex).toBe(1)
    // And the newest version is the one on the face of the stack.
    expect(frontSources()).toEqual([v2.asset?.src])
    // The older chain members are NOT rendered as separate top-level cells.
    expect(document.querySelectorAll('.agnes__grid .agnes__card')).toHaveLength(2)
  })

  it('survives a corrupt lineage that points at itself or in a loop', async () => {
    // derivedFrom is written by the Host, so a cycle should be impossible — but a
    // hand-edited or half-restored index must not hang the gallery in an infinite
    // walk. The guard is a depth bound, and the observable requirement is simply
    // that every record still renders exactly once.
    const selfish = version('c0000000-0000-4000-8000-00000000000c', 'self cycle')
    const loopA0 = version('d0000000-0000-4000-8000-00000000000d', 'loop a')
    const loopB = version('e0000000-0000-4000-8000-00000000000e', 'loop b', loopA0.id)
    const state = {
      generations: [
        { ...selfish, derivedFrom: selfish.id },
        { ...loopA0, derivedFrom: loopB.id },
        loopB,
      ],
    }
    renderPanel(state as never)
    await screen.findByText('self cycle')
    expect(screen.getByText('loop a')).toBeTruthy()
    expect(screen.getByText('loop b')).toBeTruthy()
    // Each orphaned cycle collapses to a single rendered card; nothing is lost and
    // nothing is rendered twice.
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(3)
  })

  it('drops back to a plain card when a deletion leaves one version', async () => {
    // Delete/clear can reduce a chain at any moment, including while it is
    // expanded. The card must not keep stack chrome it can no longer justify, and
    // it must not crash on the now-stale expansion state.
    const v1 = version('v1000000-0000-4000-8000-000000000001', 'v1 prompt')
    const v2 = version('v2000000-0000-4000-8000-000000000002', 'v2 prompt', v1.id)
    const { api } = renderPanel({ generations: [v2, v1] })
    await screen.findByText('v2 prompt')
    fireEvent.click(screen.getByRole('button', { name: translate('stack.expand') }))
    await waitFor(() => expect(document.querySelectorAll('.agnes__card')).toHaveLength(2))

    // Delete the ROOT, which is the harder half: the surviving version still
    // points at a record that is gone, so the chain must collapse to a plain card
    // instead of keeping stack chrome or breaking on the stale expansion entry.
    const afterDelete: StudioState = {
      configured: true,
      keySource: 'credential',
      baseUrl: '',
      upstreamModels: [],
      generations: [v2],
      running: [],
    }
    api.remove = async () => afterDelete
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      // Expanded order is newest first, so the root is the last card.
      const deletes = screen.getAllByRole('button', { name: translate('gallery.delete') })
      fireEvent.click(deletes[deletes.length - 1] as HTMLElement)
    } finally {
      confirm.mockRestore()
    }
    await waitFor(() => expect(document.querySelectorAll('.agnes__card')).toHaveLength(1))
    expect(document.querySelector('.agnes__stack')).toBeNull()
    expect(screen.queryByRole('button', { name: translate('stack.collapse') })).toBeNull()
  })

  it('treats an orphaned continuation as its own chain', async () => {
    // The source record can be deleted or evicted; the remaining version is still
    // a real result and must not disappear or break the gallery.
    const orphan = version('v9000000-0000-4000-8000-000000000009', 'a stranded apple', 'gone0000-0000-4000-8000-000000000000')
    renderPanel({ generations: [orphan] })
    await screen.findByText('a stranded apple')
    expect(document.querySelectorAll('.agnes__card')).toHaveLength(1)
    expect(document.querySelector('.agnes__stack')).toBeNull()
  })
})

describe('continuous retry', () => {
  /** A retryable failed video, as the Host stores it. */
  function failedVideo(): Generation {
    return {
      id: 'cccc3333-3333-4333-8333-333333333333',
      kind: 'video',
      status: 'failed',
      model: 'agnes-video-2.5-flash',
      prompt: 'a queue test',
      params: {},
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'queue-full',
      error: '队列已满',
      retryable: true,
      request: { kind: 'video', prompt: 'a queue test', model: 'agnes-video-2.5-flash', mode: 'text', size: '720P', ratio: '16:9', seconds: 5, references: [] },
    }
  }

  it('asks the Host for the continuous loop from the failed card', async () => {
    // The one-click difference: a single retry mostly lands in the same full
    // queue, so the card also offers the Host-owned loop.
    const { retryAll, retried } = renderPanel({ generations: [failedVideo()] })
    await screen.findByText('a queue test')
    expect(screen.getByRole('button', { name: translate('gallery.retry') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: translate('gallery.retryAll') }))
    await waitFor(() => expect(retried).toHaveLength(1))
    // The flag is what turns the loop on; without it the click is just a retry.
    expect(retryAll).toEqual([true])
  })

  it('keeps a plain retry single-shot', async () => {
    const { retryAll } = renderPanel({ generations: [failedVideo()] })
    await screen.findByText('a queue test')
    fireEvent.click(screen.getByRole('button', { name: translate('gallery.retry') }))
    await waitFor(() => expect(retryAll).toHaveLength(1))
    expect(retryAll).toEqual([false])
  })

  it('counts down while a continuous retry waits for the next attempt', async () => {
    // Nothing is being generated during the wait, so the card must look like it is
    // waiting and must say which attempt is next.
    const failed = failedVideo()
    const failedAt = Date.parse(failed.createdAt)
    const until = new Date(failedAt + 30_000).toISOString()
    renderPanel({
      generations: [failed],
      running: [
        {
          id: failed.id,
          kind: 'video',
          prompt: failed.prompt,
          model: failed.model,
          startedAt: '2026-11-11T00:00:00.000Z',
          retryOf: failed.id,
          attempt: 2,
          maxAttempts: 5,
          nextAttemptAt: until,
        },
      ],
    })

    const card = await waitFor(() => {
      const found = document.querySelector('.agnes__card--retrying')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(card.textContent).toContain(translate('retry.attempt', { index: 2, total: 5 }))
    // The countdown reads from the Host's own deadline, so it renders as a
    // remaining-seconds phrase rather than a fixed label.
    expect(card.textContent).toMatch(/秒后自动重试/)
    // Waiting is not working: the shimmer is static.
    expect(card.querySelector('.agnes__pendingShine--waiting')).not.toBeNull()
    // And the wait is cancellable.
    expect(within(card).getByRole('button', { name: translate('action.cancelJob') })).toBeTruthy()
  })

  it('shows the attempt counter while an attempt is actually running', async () => {
    const failed = failedVideo()
    renderPanel({
      generations: [failed],
      running: [
        {
          id: failed.id,
          kind: 'video',
          prompt: failed.prompt,
          model: failed.model,
          startedAt: '2026-11-11T00:00:00.000Z',
          retryOf: failed.id,
          attempt: 3,
          maxAttempts: 5,
        },
      ],
    })
    const card = await waitFor(() => {
      const found = document.querySelector('.agnes__card--retrying')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(card.textContent).toContain(translate('retry.attempt', { index: 3, total: 5 }))
    expect(card.querySelector('.agnes__pendingShine--waiting')).toBeNull()
    expect(card.querySelector('.agnes__spinner')).not.toBeNull()
  })

  it('reports how many attempts a settled record took', async () => {
    const failed = { ...failedVideo(), attempts: 4 }
    renderPanel({ generations: [failed] })
    await screen.findByText('a queue test')
    expect(screen.getByText(translate('gallery.attempts', { count: 4 }))).toBeTruthy()
  })
})

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

  it('steps between pictures with the arrows and the arrow keys', async () => {
    // A gallery is browsed. Making the user close and re-open per picture turns
    // comparison into a chore, so the viewer owns the sequence.
    const first = imageGeneration({ id: 'n1', prompt: 'first picture', asset: { src: '/n1.png', mediaType: 'image/png', bytes: 1, width: 96, height: 96 } })
    const second = imageGeneration({ id: 'n2', prompt: 'second picture', asset: { src: '/n2.png', mediaType: 'image/png', bytes: 1, width: 96, height: 96 } })
    renderPanel({ generations: [first, second] })
    await screen.findByText('first picture')
    fireEvent.click(document.querySelectorAll('.agnes__open')[0] as Element)
    await screen.findByRole('dialog')
    expect(document.querySelector('.agnes__lightboxImage')?.getAttribute('src')).toBe('/n1.png')

    fireEvent.click(document.querySelector('.agnes__lightboxNav--next') as Element)
    await waitFor(() => expect(document.querySelector('.agnes__lightboxImage')?.getAttribute('src')).toBe('/n2.png'))

    // Wrapping: next from the last picture returns to the first.
    fireEvent.click(document.querySelector('.agnes__lightboxNav--next') as Element)
    await waitFor(() => expect(document.querySelector('.agnes__lightboxImage')?.getAttribute('src')).toBe('/n1.png'))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(document.querySelector('.agnes__lightboxImage')?.getAttribute('src')).toBe('/n2.png'))
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() => expect(document.querySelector('.agnes__lightboxImage')?.getAttribute('src')).toBe('/n1.png'))

    // The counter says where in the sequence the picture sits.
    expect(document.querySelector('.agnes__lightboxSub')?.textContent).toContain(
      translate('gallery.position', { index: 1, total: 2 }),
    )
  })

  it('offers no navigation controls for a single picture', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    fireEvent.click(document.querySelector('.agnes__open') as Element)
    await screen.findByRole('dialog')
    // One picture means no prev/next: a disabled pair of arrows on a lone image
    // reads as a broken control rather than as "there is nothing to step to".
    expect(document.querySelector('.agnes__lightboxNav--prev')).toBeNull()
    expect(document.querySelector('.agnes__lightboxNav--next')).toBeNull()
    expect(document.querySelector('.agnes__lightboxSub')?.textContent).not.toContain(translate('gallery.position', { index: 1, total: 1 }))
  })

  it('resets the zoom when stepping to another picture', async () => {
    // Carrying a 400% pan onto the next picture would show it cropped to a
    // corner of the previous one.
    const first = imageGeneration({ id: 'z1', prompt: 'zoomed source', asset: { src: '/z1.png', mediaType: 'image/png', bytes: 1 } })
    const second = imageGeneration({ id: 'z2', prompt: 'fresh target', asset: { src: '/z2.png', mediaType: 'image/png', bytes: 1 } })
    renderPanel({ generations: [first, second] })
    await screen.findByText('zoomed source')
    fireEvent.click(document.querySelectorAll('.agnes__open')[0] as Element)
    await screen.findByRole('dialog')
    fireEvent.click(document.querySelector('.agnes__lightboxZoomIn') as Element)
    expect(zoomPercent()).toBeGreaterThan(100)

    fireEvent.click(document.querySelector('.agnes__lightboxNav--next') as Element)
    await waitFor(() => expect(zoomPercent()).toBe(100))
  })

  it('returns focus to the control that opened it', async () => {
    renderPanel({ generations: [imageGeneration()] })
    await screen.findByText('a viewer fixture')
    const opener = document.querySelector('.agnes__open') as HTMLElement
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.agnes__lightbox')).toBeNull())
    expect(document.activeElement).toBe(opener)
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

describe('continue editing', () => {
  /** A finished picture with its exact request, as the Host stores it. */
  function finishedImage(): Generation {
    return {
      id: 'aaaa1111-1111-4111-8111-111111111111',
      kind: 'image',
      status: 'succeeded',
      model: 'agnes-image-2.5-flash',
      prompt: 'a red apple on a white table',
      params: { size: '2K', ratio: '4:3', references: 1, imageReferences: 1 },
      createdAt: '2026-11-11T00:00:00.000Z',
      durationMs: 21_000,
      asset: { src: '/api/agnes-studio/media/aaaa1111-1111-4111-8111-111111111111', mediaType: 'image/png', bytes: 900 },
      request: {
        kind: 'image',
        prompt: 'a red apple on a white table',
        model: 'agnes-image-2.5-flash',
        size: '2K',
        ratio: '4:3',
        references: [{ url: 'https://cdn.example.com/plate.png', kind: 'image' }],
      },
    }
  }

  it('loads a finished picture back into the composer and seeds the next request with it', async () => {
    const source = finishedImage()
    const { generated } = renderPanel({ generations: [source] })
    await screen.findByText(source.prompt)

    fireEvent.click(screen.getByRole('button', { name: translate('gallery.continueEditing') }))

    // The editor explains itself and the source picture is visible in it.
    expect(await screen.findByText(translate('refine.title'))).toBeTruthy()
    const thumb = document.querySelector('img.agnes__refineThumb')
    expect(thumb?.getAttribute('src')).toBe(source.asset?.src)
    // The record's own request came back: prompt, model, size and its URL reference.
    const prompt = screen.getByLabelText(translate('form.prompt')) as HTMLTextAreaElement
    expect(prompt.value).toBe(source.prompt)
    const select = document.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('agnes-image-2.5-flash')
    expect((screen.getByLabelText(`${translate('form.references')} 1`) as HTMLInputElement).value).toBe(
      'https://cdn.example.com/plate.png',
    )
    // The source card is highlighted while it is being edited, and it is NOT
    // replaced — a continuation is a new record.
    expect(document.querySelector('.agnes__card--refining')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: translate('form.submitRefine') }))
    await waitFor(() => expect(generated).toHaveLength(1))
    // The result being edited goes first, and the record's own reference survives.
    expect(generated[0]).toMatchObject({
      kind: 'image',
      prompt: source.prompt,
      size: '2K',
      ratio: '4:3',
      references: [
        { kind: 'image', generationId: source.id },
        { kind: 'image', url: 'https://cdn.example.com/plate.png' },
      ],
    })
    // Accepting the request closes the editor; the new record starts as a job.
    await waitFor(() => expect(screen.queryByText(translate('refine.title'))).toBeNull())
  })

  it('brings a failed generation back for adjustment, without a seed', async () => {
    const failed: Generation = {
      id: 'fail1111-1111-4111-8111-111111111111',
      kind: 'image',
      status: 'failed',
      model: 'agnes-image-2.1-flash',
      prompt: 'a blurry cat',
      params: { size: '1K', ratio: '1:1' },
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'upstream-failed',
      error: '上游 500',
      request: { kind: 'image', prompt: 'a blurry cat', model: 'agnes-image-2.1-flash', size: '1K', ratio: '1:1', references: [] },
    }
    const { generated } = renderPanel({ generations: [failed] })
    await screen.findByText('a blurry cat')

    fireEvent.click(screen.getByRole('button', { name: translate('gallery.editFailed') }))
    expect(await screen.findByText(translate('refine.titleFailed'))).toBeTruthy()
    expect(document.querySelector('img.agnes__refineThumb')).toBeNull()
    const prompt = screen.getByLabelText(translate('form.prompt')) as HTMLTextAreaElement
    expect(prompt.value).toBe('a blurry cat')

    fireEvent.change(prompt, { target: { value: 'a sharp cat' } })
    fireEvent.click(screen.getByRole('button', { name: translate('form.submitRefineFailed') }))
    await waitFor(() => expect(generated).toHaveLength(1))
    expect(generated[0]).toMatchObject({ kind: 'image', prompt: 'a sharp cat', references: [] })
  })

  it('brings a failed video back on the video tab with its parameters', async () => {
    const failed: Generation = {
      id: 'fa11v111-1111-4111-8111-111111111111',
      kind: 'video',
      status: 'failed',
      model: 'agnes-video-2.5-flash',
      prompt: 'a queue test',
      params: { mode: 'text', seconds: 7, size: '720P', ratio: '16:9' },
      createdAt: '2026-11-11T00:00:00.000Z',
      errorCode: 'queue-full',
      error: 'Agnes 视频队列已满，请稍后重试。',
      retryable: true,
      request: {
        kind: 'video',
        prompt: 'a queue test',
        model: 'agnes-video-2.5-flash',
        mode: 'text',
        size: '720P',
        ratio: '16:9',
        seconds: 7,
        references: [],
      },
    }
    const { generated } = renderPanel({ generations: [failed] })
    await screen.findByText('a queue test')

    fireEvent.click(screen.getByRole('button', { name: translate('gallery.editFailed') }))
    expect(await screen.findByText(translate('refine.titleFailed'))).toBeTruthy()
    expect(screen.getByRole('tab', { name: translate('tab.video') }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: translate('form.submitRefineFailed') }))
    await waitFor(() => expect(generated).toHaveLength(1))
    expect(generated[0]).toMatchObject({ kind: 'video', prompt: 'a queue test', mode: 'text', seconds: 7 })
  })

  it('does not offer result-based editing for a finished video', async () => {
    // Agnes' video API has no way to take a stored video back in without a public
    // URL, so a finished video deliberately offers neither action.
    const video: Generation = {
      id: 'vid11v11-1111-4111-8111-111111111111',
      kind: 'video',
      status: 'succeeded',
      model: 'agnes-video-2.5',
      prompt: 'an apple rotating',
      params: { seconds: 5 },
      createdAt: '2026-11-11T00:00:00.000Z',
      asset: { src: '/api/agnes-studio/media/vid11v11-1111-4111-8111-111111111111', mediaType: 'video/mp4', bytes: 100 },
    }
    renderPanel({ generations: [video] })
    await screen.findByText('an apple rotating')
    expect(screen.queryByRole('button', { name: translate('gallery.continueEditing') })).toBeNull()
    expect(screen.queryByRole('button', { name: translate('gallery.editFailed') })).toBeNull()
  })

  it('abandons the edit without touching the form or the source record', async () => {
    const source = finishedImage()
    renderPanel({ generations: [source] })
    await screen.findByText(source.prompt)
    fireEvent.click(screen.getByRole('button', { name: translate('gallery.continueEditing') }))
    await screen.findByText(translate('refine.title'))

    fireEvent.click(screen.getByRole('button', { name: translate('refine.cancel') }))
    await waitFor(() => expect(screen.queryByText(translate('refine.title'))).toBeNull())
    expect(document.querySelector('.agnes__card--refining')).toBeNull()
    // The form is a scratch pad: cancelling leaves the loaded text for reuse.
    expect((screen.getByLabelText(translate('form.prompt')) as HTMLTextAreaElement).value).toBe(source.prompt)
    expect(screen.getByRole('button', { name: translate('form.submitImage') })).toBeTruthy()
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
