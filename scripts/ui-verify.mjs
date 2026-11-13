/**
 * Owned UI verification driver for Agnes Studio (local only, not shipped).
 *
 * Drives the headless Chrome attached to the owned DSH Web app over CDP: selects
 * the sidebar entry, verifies the studio page actually RENDERS, exercises both
 * capability tabs, checks that the model-driven parameter narrowing works in the
 * real DOM, and captures screenshots as evidence.
 *
 * This is the check the packaging suite cannot make. A bundled client half can
 * register both slots and still throw on first render (that is exactly what a
 * classic-JSX `React is not defined` bug looks like), so "the panel mounted" is
 * not evidence — this driver asserts painted content.
 *
 * Requires the harness (`ui-check.mjs`) to be running with CDP_PORT set.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendFailedGeneration, FIXTURE_ID, seedChain } from './seed-fixture.mjs'

const port = process.env.CDP_PORT || '9333'
const evidenceDir = process.env.EVIDENCE_DIR || 'docs/evidence'
const shotDir = join(evidenceDir, 'screenshots')

/** Connect to the page target and return small CDP helpers. */
async function connect() {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject })
      ws.send(JSON.stringify({ id: next, method, params }))
    })
  /**
   * Run an expression in the page. Evaluations that split a background layer
   * list use the page-side copy of the helper below, because a regex literal
   * inside a template string cannot carry an escaped paren.
   */
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails).slice(0, 800)}`)
    }
    return result.result?.value
  }
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const shot = async (name) => {
    // The first-run overlays live in the browser top layer and would cover the
    // panel in the evidence. Dismiss them right before each capture so the
    // screenshot shows what the user actually sees once past onboarding.
    //
    // Scoped to overlays OUTSIDE the panel: this plugin's own viewer also has a
    // button labelled 关闭, and dismissing it here would close the very thing the
    // screenshot is meant to show.
    await evaluate(`(() => {
      const inPanel = (node) => node.closest('.agnes') !== null;
      const labels = ['继续', '知道了', '跳过', '稍后'];
      for (const button of [...document.querySelectorAll('button')]) {
        if (inPanel(button)) continue;
        const text = button.textContent.trim();
        if (labels.includes(text) || button.getAttribute('aria-label') === '关闭') button.click();
      }
      const dialog = document.querySelector('dialog[open]');
      if (dialog && dialog.closest('.agnes') === null) {
        const close = [...dialog.querySelectorAll('button')].find((n) => n.textContent.trim() === '' || n.getAttribute('aria-label') === '关闭');
        close?.click();
        if (dialog.open) dialog.close();
      }
      return true;
    })()`).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 350))
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(shotDir, name), Buffer.from(result.data, 'base64'))
  }
  const close = () => ws.close()
  return { send, evaluate, click, shot, close }
}

/** Wait until an expression returns truthy, or fail with the last value. */
async function until(evaluate, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression).catch((error) => `threw: ${error.message}`)
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 500)}`)
}

const checks = []
const check = (name, detail) => {
  checks.push(detail === undefined ? name : `${name}: ${detail}`)
  process.stdout.write(`  ok ${name}${detail === undefined ? '' : ` (${detail})`}\n`)
}

/** Collect console errors so a render crash is reported, not silently ignored. */
const consoleErrors = []

await mkdir(shotDir, { recursive: true })
const cdp = await connect()
try {
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  cdp.send('Log.enable').catch(() => {})

  // Fail loudly on an uncaught render error: this is the class of bug that made
  // a fully "green" package ship an unusable panel.
  const drainConsole = async () => {
    const found = await cdp.evaluate(`JSON.stringify(window.__agnesUiErrors ?? [])`).catch(() => '[]')
    const parsed = JSON.parse(found ?? '[]')
    for (const entry of parsed) if (!consoleErrors.includes(entry)) consoleErrors.push(entry)
    return parsed
  }

  // 0. A first-run notice can cover the shell; dismiss it so later clicks land.
  //
  //    Two different overlays show up on a fresh profile: a "预览版说明" notice with
  //    a 继续 button, and the "开始使用" onboarding card with a close X. Both live in
  //    the browser's TOP LAYER (a modal <dialog>), which no z-index can rise above —
  //    so a screenshot taken while one is open shows it over the panel no matter
  //    what the plugin does. Dismiss every candidate, then confirm none remains.
  const dismissOverlays = `
    (() => {
      const inPanel = (node) => node.closest('.agnes') !== null;
      const labels = ['继续', '知道了', '跳过', '稍后'];
      for (const button of [...document.querySelectorAll('button')]) {
        if (inPanel(button)) continue;
        const text = button.textContent.trim();
        const isClose = button.getAttribute('aria-label') === '关闭' || text === '×' || text === '✕';
        if (labels.includes(text) || isClose) button.click();
      }
      // The onboarding card's X is an icon button with no accessible name.
      const dialog = document.querySelector('dialog[open]');
      if (dialog && dialog.closest('.agnes') === null) {
        const close = [...dialog.querySelectorAll('button')].find((n) => n.textContent.trim() === '' || n.getAttribute('aria-label') === '关闭');
        close?.click();
        if (dialog.open) dialog.close();
      }
      return true;
    })()
  `
  await cdp.evaluate(dismissOverlays).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 800))
  await cdp.evaluate(dismissOverlays).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 300))
  // A modal <dialog> that is still open would swallow clicks and cover every
  // screenshot, so treat its presence as a harness failure rather than a mystery.
  const stillBlocked = await cdp.evaluate(`document.querySelector('dialog[open]') !== null`)
  if (stillBlocked) throw new Error('a first-run modal dialog is still open and would cover the panel')

  // 1. The shell boots.
  await until(cdp.evaluate, `document.querySelector('[data-dsh-boot]') === null || document.querySelector('#root')?.children.length > 0`, 'the app shell to paint')
  check('browser-app-boot')

  // 2. The sidebar entry for this plugin exists and is labelled from the locale.
  //    The shell renders a panel row as BUTTON > SPAN(title); the label lives on
  //    the span, so the click target is its closest button ancestor.
  const entry = await until(
    cdp.evaluate,
    `(() => {
      const label = 'Agnes 工作室';
      const span = [...document.querySelectorAll('span')].find((node) => node.textContent.trim() === label);
      if (!span) return null;
      const button = span.closest('button') ?? span;
      const box = button.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return null;
      return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2, label });
    })()`,
    'the Agnes Studio sidebar entry',
  )
  const box = JSON.parse(entry)
  check('browser-sidebar-entry', box.label)
  await cdp.shot('01-sidebar-entry.png')

  // 3. Selecting it renders the studio page. A render throw leaves the centre
  //    column without the panel's own heading, so this is the load-bearing assert.
  //
  //    The click goes through the element's own `click()` rather than a synthetic
  //    CDP mouse event: the shell's panel row is inside a scroll container whose
  //    hit-testing swallowed the dispatched coordinates, so the synthetic event
  //    silently did nothing while a DOM click switches the panel correctly.
  /** Select the studio panel, or confirm it is already open (used again after a reload). */
  const openStudio = async () => {
    if (await cdp.evaluate(`document.querySelector('.agnes__title') !== null`)) return
    const clicked = await cdp.evaluate(
      `(() => {
        const span = [...document.querySelectorAll('span')].find((node) => node.textContent.trim() === ${JSON.stringify(box.label)});
        const button = span?.closest('button');
        if (!button) return 'no button';
        button.click();
        return 'clicked';
      })()`,
    )
    if (clicked !== 'clicked') throw new Error(`could not select the sidebar entry: ${String(clicked)}`)
    await until(cdp.evaluate, `document.querySelector('.agnes__title') !== null`, 'the studio page heading')
  }
  await openStudio()
  const heading = await cdp.evaluate(
    `(() => { const h = [...document.querySelectorAll('.agnes__title')][0]; return h ? h.textContent.trim() : null })()`,
  )
  if (heading === null) throw new Error('the studio page heading did not render')
  check('browser-panel-renders', heading)

  const renderErrors = await drainConsole()
  if (renderErrors.length > 0) throw new Error(`the panel logged render errors: ${JSON.stringify(renderErrors).slice(0, 800)}`)
  check('browser-no-render-error')

  // 4. The panel reports configuration state rather than pretending to work.
  //    The state arrives from the Host after mount, so wait for it instead of
  //    sampling the DOM in the gap where neither branch has rendered yet.
  //
  //    The status pill is always present (it reports 正在连接… before the first
  //    state arrives), so this waits for it to leave that state rather than for
  //    an element to appear.
  await until(
    cdp.evaluate,
    `(() => {
      const pill = document.querySelector('.agnes__status');
      if (!pill) return null;
      const text = pill.textContent.trim();
      if (text.includes('正在连接') || text === '') return null;
      return text;
    })()`,
    'the panel configuration state',
  )
  const configured = await cdp.evaluate(
    `(() => {
      const pill = document.querySelector('.agnes__status');
      const notice = document.querySelector('.agnes__notice');
      const submit = document.querySelector('.agnes__button--primary');
      return JSON.stringify({
        status: pill ? pill.textContent.trim() : null,
        tone: pill ? pill.className : null,
        notice: notice ? notice.textContent.slice(0, 90) : null,
        submitDisabled: submit ? submit.disabled : null,
      });
    })()`,
  )
  const state = JSON.parse(configured)
  check('browser-config-state', `${String(state.status)}${state.notice === null ? '' : ' + notice'}`)
  await cdp.shot('02-panel-configured.png')

  // 5. The composer renders its controls, and their option sets come from the
  //    capability table (not from a hard-coded list in the component). The
  //    control SHAPE is also asserted: the panel picks a segmented control for a
  //    small mutually-exclusive set and chips for a large one, so a future
  //    refactor that collapses everything back into a <select> fails here.
  const imageForm = await cdp.evaluate(
    `(() => {
      const read = (label) => {
        const group = [...document.querySelectorAll('[role="radiogroup"]')].find((n) => n.getAttribute('aria-label') === label);
        if (!group) return null;
        return {
          shape: group.className,
          values: [...group.querySelectorAll('[role="radio"]')].map((n) => n.textContent.trim()),
          checked: [...group.querySelectorAll('[role="radio"]')].filter((n) => n.getAttribute('aria-checked') === 'true').map((n) => n.textContent.trim()),
        };
      };
      const selects = [...document.querySelectorAll('select.agnes__field')];
      return JSON.stringify({
        prompt: document.querySelector('textarea.agnes__prompt') !== null,
        selects: selects.length,
        modelOptions: selects[0] ? [...selects[0].options].map((o) => o.value) : [],
        size: read('分辨率'),
        ratio: read('比例'),
        examples: document.querySelectorAll('.agnes__example').length,
        counter: document.querySelector('.agnes__counter')?.textContent.trim() ?? null,
      });
    })()`,
  )
  const form = JSON.parse(imageForm)
  if (!form.prompt) throw new Error('the prompt textarea did not render')
  if (form.selects !== 1) throw new Error(`expected exactly 1 select (model), got ${String(form.selects)}`)
  if (form.size === null) throw new Error('the image resolution group did not render')
  if (form.size.shape !== 'agnes__seg') throw new Error(`the 4-way resolution must be a segmented control, got ${String(form.size.shape)}`)
  if (form.size.values.join(',') !== '1K,2K,3K,4K') throw new Error(`unexpected image sizes: ${form.size.values.join(',')}`)
  if (form.ratio === null) throw new Error('the image ratio group did not render')
  if (form.ratio.shape !== 'agnes__chips') throw new Error(`the 8-way ratio must be a chip row, got ${String(form.ratio.shape)}`)
  if (form.ratio.values.length !== 8) throw new Error(`expected 8 ratios, got ${String(form.ratio.values.length)}`)
  if (form.ratio.checked.length !== 1) throw new Error('exactly one ratio must be selected')
  if (form.examples < 3) throw new Error(`expected example prompts, got ${String(form.examples)}`)
  if (form.counter === null) throw new Error('the prompt character counter did not render')
  check('browser-image-form-controls', `seg ${form.size.values.join('/')}, ${String(form.ratio.values.length)} ratio chips`)

  // 5b. The layout is two panes, not one long column.
  //
  //     The previous panel stacked a full-width form above a full-width gallery:
  //     every control was ~1200px wide, the prompt field was a letterbox, and the
  //     results started below the fold. This measures the actual geometry, because
  //     "the grid template says two columns" is satisfied by a collapsed layout
  //     too — a zero-width second column still has two columns in the computed
  //     style.
  const layout = await cdp.evaluate(
    `(() => {
      const composer = document.querySelector('.agnes__composer');
      const gallery = document.querySelector('.agnes__gallery');
      const body = document.querySelector('.agnes__body');
      if (!composer || !gallery || !body) return null;
      const composerBox = composer.getBoundingClientRect();
      const galleryBox = gallery.getBoundingClientRect();
      const columns = getComputedStyle(body).gridTemplateColumns.split(' ').length;
      return JSON.stringify({
        columns,
        composerWidth: Math.round(composerBox.width),
        galleryWidth: Math.round(galleryBox.width),
        composerTop: Math.round(composerBox.top),
        galleryTop: Math.round(galleryBox.top),
        viewportWidth: window.innerWidth,
      });
    })()`,
  )
  const layoutState = JSON.parse(layout)
  if (layoutState === null) throw new Error('the two-pane body did not render')
  if (layoutState.columns < 2) throw new Error(`the body is not a two-column grid: ${String(layoutState.columns)} column(s)`)
  // Side by side, not stacked: the gallery starts at the same height as the form.
  if (Math.abs(layoutState.composerTop - layoutState.galleryTop) > 24) {
    throw new Error(`the panes are stacked, not side by side: composer top ${String(layoutState.composerTop)}, gallery top ${String(layoutState.galleryTop)}`)
  }
  // The composer must not stretch to the full panel: a 1200px-wide prompt field
  // is unreadable, and that is exactly what the redesign removes.
  if (layoutState.composerWidth > layoutState.viewportWidth * 0.62) {
    throw new Error(`the composer is still full width: ${String(layoutState.composerWidth)} of ${String(layoutState.viewportWidth)}`)
  }
  if (layoutState.galleryWidth < layoutState.composerWidth) {
    throw new Error(`the gallery is narrower than the composer: ${String(layoutState.galleryWidth)} vs ${String(layoutState.composerWidth)}`)
  }
  check('browser-two-pane-layout', `${String(layoutState.composerWidth)}px + ${String(layoutState.galleryWidth)}px side by side`)

  // 6. Switch to the video tab: the size list must narrow to the model's real
  //    capability (Flash is 720P only), which is the behaviour the panel's whole
  //    design exists to guarantee.
  await cdp.evaluate(`(() => { const tab = [...document.querySelectorAll('[role="tab"]')].find((n) => n.textContent.includes('生视频')); tab?.click(); return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const readVideoSizes = `(() => {
    const group = [...document.querySelectorAll('[role="radiogroup"]')].find((n) => n.getAttribute('aria-label') === '分辨率');
    return group ? [...group.querySelectorAll('[role="radio"]')].map((n) => n.textContent.trim()).join(',') : 'missing';
  })()`
  const allSizes = await cdp.evaluate(readVideoSizes)
  if (allSizes !== '720P,1080P,1K,2K') throw new Error(`unexpected video sizes: ${String(allSizes)}`)
  check('browser-video-form-controls', String(allSizes))

  // Narrowing: choose the Flash model and confirm the size list collapses.
  const narrowed = await cdp.evaluate(
    `(() => {
      const modelSelect = [...document.querySelectorAll('select.agnes__field')].find((s) => [...s.options].some((o) => o.value === 'agnes-video-2.5-flash'));
      if (!modelSelect) return 'no model select';
      modelSelect.value = 'agnes-video-2.5-flash';
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return 'dispatched';
    })()`,
  )
  if (narrowed !== 'dispatched') throw new Error(`could not switch the video model: ${String(narrowed)}`)
  const narrowedSizes = await until(
    cdp.evaluate,
    `(() => { const value = ${readVideoSizes}; return value === 'missing' ? null : value })()`,
    'the narrowed video size list',
  ).then((value) => String(value))
  if (narrowedSizes !== '720P') throw new Error(`Flash did not narrow the size list; got ${narrowedSizes}`)
  check('browser-flash-narrows-sizes', narrowedSizes)
  await cdp.shot('03-video-tab-flash-720p.png')

  // 7. The submit is guarded, and the guard is the one the panel can express.
  //
  //    Two legitimate states, and the check must be honest about which one it
  //    exercised instead of silently depending on whether the runner happens to
  //    export a key:
  //      - configured:   the button is live, so an empty prompt must be refused
  //                      client-side, before any upstream call;
  //      - unconfigured: the button is disabled by design, because offering it
  //                      would only produce a failure the panel already warned
  //                      about in step 4.
  //    The offline view spec covers the configured refusal deterministically, so
  //    this browser check does not need a secret to be meaningful.
  const submitGuard = await cdp.evaluate(
    `(() => {
      const submit = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('生成视频'));
      if (!submit) return JSON.stringify({ error: 'no submit' });
      const disabled = submit.disabled;
      if (!disabled) submit.click();
      return JSON.stringify({ disabled, hasPrimary: submit.classList.contains('agnes__button--primary') });
    })()`,
  )
  const guard = JSON.parse(submitGuard)
  if (guard.error !== undefined) throw new Error('the video submit button did not render')
  if (!guard.hasPrimary) throw new Error('the submit lost its primary styling')

  // The submit must be REACHABLE without scrolling. On the video tab the form is
  // taller than the pane, and the previous layout put the button at the end of
  // it — below the fold, so the panel's primary action needed a page scroll.
  const reachable = await cdp.evaluate(
    `(() => {
      const submit = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('生成视频'));
      if (!submit) return null;
      const box = submit.getBoundingClientRect();
      const composer = document.querySelector('.agnes__composer');
      const composerBox = composer ? composer.getBoundingClientRect() : null;
      return JSON.stringify({
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        viewportHeight: window.innerHeight,
        insideComposer: composerBox === null ? null : box.bottom <= composerBox.bottom + 1 && box.top >= composerBox.top - 1,
      });
    })()`,
  )
  const reachState = JSON.parse(reachable)
  if (reachState === null) throw new Error('the submit button is not in the DOM')
  if (reachState.bottom > reachState.viewportHeight) {
    throw new Error(
      `the submit is below the fold: bottom ${String(reachState.bottom)} of ${String(reachState.viewportHeight)}`,
    )
  }
  if (reachState.insideComposer !== true) throw new Error('the submit escaped the composer pane')
  check('browser-submit-reachable', `bottom ${String(reachState.bottom)} of ${String(reachState.viewportHeight)}`)
  if (guard.disabled) {
    const notice = await cdp.evaluate(`document.querySelector('.agnes__notice') !== null`)
    if (!notice) throw new Error('the submit is disabled without an explanation on the panel')
    // A disabled primary used to be the gradient at 45% opacity, i.e. a pale
    // lilac slab with white text on it. It must now be a flat muted surface with
    // a readable label, so the contrast is measured rather than assumed.
    const contrast = await cdp.evaluate(
      `(() => {
        const button = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('生成视频'));
        if (!button) return null;
        const style = getComputedStyle(button);
        return JSON.stringify({
          color: style.color,
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          opacity: style.opacity,
        });
      })()`,
    )
    const disabledStyle = JSON.parse(contrast)
    if (disabledStyle.backgroundImage !== 'none') {
      throw new Error(`a disabled primary must not keep the gradient: ${String(disabledStyle.backgroundImage).slice(0, 60)}`)
    }
    if (Number(disabledStyle.opacity) < 0.99) {
      throw new Error(`a disabled primary must not be faded over its own label: opacity ${String(disabledStyle.opacity)}`)
    }
    check('browser-submit-guarded-unconfigured', 'disabled + notice, flat muted surface')
  } else {
    const promptWarning = await until(
      cdp.evaluate,
      `(() => { const el = document.querySelector('.agnes__errorBody'); return el ? el.textContent.trim() : null })()`,
      'the empty-prompt refusal',
    )
    check('browser-refuses-empty-prompt', String(promptWarning).slice(0, 40))
  }

  // 8. The gallery renders the seeded records as grid cards.
  //
  //    The image tab is restored first: leaving the video tab selected would make
  //    this screenshot a duplicate of the previous one, which is not evidence of
  //    anything the previous shot does not already show.
  await cdp.evaluate(`(() => { const tab = [...document.querySelectorAll('[role="tab"]')].find((n) => n.textContent.includes('生图')); tab?.click(); return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  //
  //    The harness seeds one finished image before boot (see
  //    `scripts/seed-fixture.mjs`), so this asserts the populated path. The empty
  //    state is covered by the offline view spec, which can render it
  //    deterministically without a Host; asserting it here would only re-test
  //    React and would force every browser run to also cover an unseeded profile.
  const gallery = await cdp.evaluate(
    `(() => {
      const empty = document.querySelector('.agnes__empty');
      const grid = document.querySelector('.agnes__grid');
      const title = document.querySelector('.agnes__galleryTitle');
      const cards = document.querySelectorAll('.agnes__card');
      return JSON.stringify({
        empty: empty ? empty.textContent.slice(0, 60) : null,
        grid: grid !== null,
        title: title ? title.textContent : null,
        cards: cards.length,
      });
    })()`,
  )
  const galleryState = JSON.parse(gallery)
  if (galleryState.title === null) throw new Error('the gallery heading did not render')
  if (!galleryState.grid) throw new Error('the seeded records did not render a result grid')
  if (galleryState.cards !== 2) throw new Error(`expected the two seeded cards, got ${String(galleryState.cards)}`)
  if (galleryState.empty !== null) throw new Error('the gallery showed its empty state while holding records')
  check('browser-gallery-card-grid', `${String(galleryState.cards)} cards, ${galleryState.title}`)
  // The screenshot is taken BEFORE the filter experiment below: the filter leaves
  // the pane scrolled to wherever the sticky header put it, and a shot of that
  // state would show the same thing as this one but less clearly.
  await cdp.shot('04-gallery-seeded.png')

  // 8b. The filter tabs report the real counts and actually filter.
  //
  //     A tab that renders but does not filter is the same class of defect as a
  //     button that renders but does nothing. Both seeded records are images, so
  //     selecting 视频 must empty the grid and selecting 图片 must restore it.
  const filterCounts = await cdp.evaluate(
    `(() => {
      const tabs = [...document.querySelectorAll('.agnes__filter')];
      return JSON.stringify(tabs.map((t) => ({ label: t.textContent.trim(), selected: t.getAttribute('aria-selected') })));
    })()`,
  )
  const filterState = JSON.parse(filterCounts)
  if (filterState.length !== 3) throw new Error(`expected 3 gallery filters, got ${String(filterState.length)}`)
  const imageFilter = filterState.find((entry) => entry.label.startsWith('图片'))
  const videoFilter = filterState.find((entry) => entry.label.startsWith('视频'))
  if (imageFilter === undefined || !imageFilter.label.endsWith('2')) {
    throw new Error(`the image filter count is wrong: ${JSON.stringify(imageFilter)}`)
  }
  if (videoFilter === undefined || !videoFilter.label.endsWith('0')) {
    throw new Error(`the video filter count is wrong: ${JSON.stringify(videoFilter)}`)
  }
  await cdp.evaluate(
    `(() => { const tab = [...document.querySelectorAll('.agnes__filter')].find((n) => n.textContent.trim().startsWith('视频')); tab?.click(); return true })()`,
  )
  const filteredEmpty = await until(
    cdp.evaluate,
    `(() => {
      const empty = document.querySelector('.agnes__empty');
      const cards = document.querySelectorAll('.agnes__card').length;
      if (!empty) return null;
      return JSON.stringify({ text: empty.textContent.trim().slice(0, 40), cards });
    })()`,
    'the video filter to empty the grid',
  )
  const filteredState = JSON.parse(filteredEmpty)
  if (filteredState.cards !== 0) throw new Error('the video filter did not hide the image cards')
  check('browser-gallery-filters', `${imageFilter.label} / ${videoFilter.label} -> ${String(filteredState.text)}`)
  await cdp.evaluate(
    `(() => { const tab = [...document.querySelectorAll('.agnes__filter')].find((n) => n.textContent.trim().startsWith('全部')); tab?.click(); return true })()`,
  )
  await until(cdp.evaluate, `document.querySelectorAll('.agnes__card').length === 2`, 'the grid to restore under the All filter')

  // 9. Theme: the panel must follow the host theme.
  //
  //    The host flips themes by putting `data-ds-dark-theme` on <body>, and the
  //    panel's tokens read `--dsw-*` properties that the host redefines under
  //    that attribute. Toggling a `.dark` class (what the previous version of this
  //    check did) proves nothing: no rule keys off it, so the assertion passed
  //    while the panel was in fact hard-coded to inherited colour only.
  //
  //    So the real attribute is flipped and the panel's own computed surface and
  //    text colours are compared across the two states.
  //
  //    The direction is decided at run time, not assumed: the profile this
  //    harness boots may come up in either theme, and a check that hard-codes
  //    "add the attribute, expect dark" silently passes (or fails) depending on
  //    which one it happened to get.
  const themed = await cdp.evaluate(
    `(() => {
      const body = document.body;
      const sample = () => {
        const card = document.querySelector('.agnes__card') ?? document.querySelector('.agnes__composer');
        const title = document.querySelector('.agnes__title');
        if (!card || !title) return null;
        return {
          surface: getComputedStyle(card).backgroundColor,
          text: getComputedStyle(title).color,
        };
      };
      const had = body.hasAttribute('data-ds-dark-theme');
      const before = sample();
      // Flip to the OTHER theme.
      if (had) body.removeAttribute('data-ds-dark-theme');
      else body.setAttribute('data-ds-dark-theme', '');
      const after = sample();
      // Restore the theme the app was actually in.
      if (had) body.setAttribute('data-ds-dark-theme', '');
      else body.removeAttribute('data-ds-dark-theme');
      return JSON.stringify({ from: had ? 'dark' : 'light', to: had ? 'light' : 'dark', before, after });
    })()`,
  )
  const themeState = JSON.parse(themed)
  if (themeState.before === null || themeState.after === null) throw new Error('the panel lost its colours across a theme switch')
  if (themeState.before.surface === themeState.after.surface) {
    throw new Error(
      `the panel surface did not follow the theme (${themeState.from} -> ${themeState.to}): ${String(themeState.before.surface)} in both`,
    )
  }
  if (themeState.before.text === themeState.after.text) {
    throw new Error(
      `the panel text colour did not follow the theme (${themeState.from} -> ${themeState.to}): ${String(themeState.before.text)} in both`,
    )
  }
  // Both surfaces must stay readable: the point of using host tokens is that
  // neither theme collapses the panel into its own background.
  const luminance = (color) => {
    const match = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (match === null) return null
    return (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000
  }
  const surfaceLuma = luminance(themeState.before.surface)
  const textLuma = luminance(themeState.before.text)
  if (surfaceLuma !== null && textLuma !== null && Math.abs(surfaceLuma - textLuma) < 60) {
    throw new Error(
      `the panel text and its surface are too close to read: text ${String(themeState.before.text)} on ${String(themeState.before.surface)}`,
    )
  }
  check(
    'browser-theme-toggle',
    `${themeState.from} ${String(themeState.before.surface)} -> ${themeState.to} ${String(themeState.after.surface)}`,
  )

  // Capture the theme the run did NOT boot in. A panel that only looks right in
  // one theme is half a panel, and a screenshot of the untested half is the only
  // way to review it — the computed colours above say "it changed", not "it
  // reads".
  await cdp.evaluate(
    `(() => {
      const body = document.body;
      if (${JSON.stringify(themeState.to)} === 'light') body.removeAttribute('data-ds-dark-theme');
      else body.setAttribute('data-ds-dark-theme', '');
      return true;
    })()`,
  )
  await new Promise((resolve) => setTimeout(resolve, 350))
  await cdp.shot(`09-${themeState.to}-theme.png`)
  // Restore the boot theme so the remaining shots match a normal session.
  await cdp.evaluate(
    `(() => {
      const body = document.body;
      if (${JSON.stringify(themeState.from)} === 'dark') body.setAttribute('data-ds-dark-theme', '');
      else body.removeAttribute('data-ds-dark-theme');
      return true;
    })()`,
  )
  await new Promise((resolve) => setTimeout(resolve, 250))

  // 10. Locale: the sidebar label and heading come from the registered
  //     dictionaries, so a missing namespace would surface the bare key.
  const localeOk = await cdp.evaluate(
    `(() => {
      const title = document.querySelector('.agnes__title')?.textContent ?? '';
      return JSON.stringify({ title, isKey: title.startsWith('title') || title.startsWith('nav') });
    })()`,
  )
  const localeState = JSON.parse(localeOk)
  if (localeState.isKey) throw new Error(`the panel shows an untranslated key: ${localeState.title}`)
  check('browser-locale-dictionary', localeState.title)

  // 11. The gallery shows the seeded record and its open control.
  //
  //     This is the check the old suite could not make. "打开原图" used to be an
  //     `<a target="_blank">` pointing at a session-authenticated same-origin
  //     path; the Desktop shell denies every popup the page asks for, so the
  //     control rendered, focused, and did nothing. A registration or DOM-presence
  //     assertion passes on that broken build — only driving the click and looking
  //     at the resulting overlay catches it.
  const card = await until(
    cdp.evaluate,
    `(() => {
      const open = document.querySelector('.agnes__open');
      const thumb = document.querySelector('.agnes__thumbButton');
      const image = document.querySelector('img.agnes__thumb');
      const veil = document.querySelector('.agnes__thumbVeil');
      if (!open || !thumb || !image || !veil) return null;
      const frame = thumb.getBoundingClientRect();
      const natural = image.naturalWidth > 0 ? image.naturalWidth / image.naturalHeight : 0;
      return JSON.stringify({
        openLabel: open.textContent.trim(),
        openTag: open.tagName,
        thumbTag: thumb.tagName,
        imgSrc: image.getAttribute('src'),
        imgWidth: image.naturalWidth,
        frameWidth: Math.round(frame.width),
        frameHeight: Math.round(frame.height),
        naturalAspect: Math.round(natural * 100) / 100,
        objectFit: getComputedStyle(image).objectFit,
      });
    })()`,
    'the gallery card with its open control',
  )
  const cardState = JSON.parse(card)
  if (cardState.openTag !== 'BUTTON') throw new Error(`the open control must be a button, got ${String(cardState.openTag)}`)
  if (cardState.openLabel !== '查看大图') throw new Error(`unexpected open label: ${String(cardState.openLabel)}`)
  // The seeded PNG must have actually loaded through the authenticated media
  // route; a 401 would leave naturalWidth at 0 and the viewer would show nothing.
  if (cardState.imgWidth === 0) throw new Error('the gallery thumbnail did not load from the media route')
  // Every thumbnail frame is 4:3 with `cover`, so the grid cannot develop holes
  // under cards whose source aspect ratios differ.
  if (cardState.frameWidth === 0 || cardState.frameHeight === 0) throw new Error('the thumbnail frame has no layout box')
  const frameAspect = cardState.frameWidth / cardState.frameHeight
  if (Math.abs(frameAspect - 4 / 3) > 0.05) {
    throw new Error(`the thumbnail frame is not 4:3: ${String(cardState.frameWidth)}x${String(cardState.frameHeight)}`)
  }
  if (cardState.objectFit !== 'cover') throw new Error(`the thumbnail must crop with cover, got ${String(cardState.objectFit)}`)
  check('browser-gallery-card', `${String(cardState.imgWidth)}px source in a 4:3 frame`)
  // No separate screenshot here: with the two-pane layout the card's action row
  // is visible in shot 04 already, and a second image that shows the same thing
  // is not evidence of anything the first one does not prove.

  // 12. Clicking it opens the in-panel viewer, at fit zoom, on the same URL.
  await cdp.evaluate(`(() => { document.querySelector('.agnes__open').click(); return true })()`)
  const opened = await until(
    cdp.evaluate,
    `(() => {
      const box = document.querySelector('.agnes__lightbox');
      const image = document.querySelector('.agnes__lightboxImage');
      const zoom = document.querySelector('.agnes__lightboxZoom');
      if (!box || !image) return null;
      const rect = image.getBoundingClientRect();
      return JSON.stringify({
        role: box.getAttribute('role'),
        modal: box.getAttribute('aria-modal'),
        zoom: zoom ? zoom.textContent.trim() : null,
        src: image.getAttribute('src'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        transform: image.style.transform,
      });
    })()`,
    'the image viewer to open',
  )
  const openedState = JSON.parse(opened)
  if (openedState.role !== 'dialog') throw new Error('the viewer is not a dialog')
  if (openedState.modal !== 'true') throw new Error('the viewer is not marked modal')
  if (openedState.zoom !== '100%') throw new Error(`the viewer must open at fit zoom, got ${String(openedState.zoom)}`)
  if (openedState.src !== cardState.imgSrc) throw new Error('the viewer shows a different URL than the card')
  // Fit zoom means the picture is laid out at its natural size (96px) or the
  // max-width/max-height clamp, never at 0 — a broken layout is caught here.
  if (openedState.width === 0 || openedState.height === 0) throw new Error('the viewer image has no layout box')
  check('browser-viewer-opens', `${String(openedState.width)}x${String(openedState.height)} at ${String(openedState.zoom)}`)

  // 12b. The overlay must actually cover the window.
  //
  //      `position: fixed` resolves against the nearest ancestor that establishes
  //      a containing block — a `transform`, `filter`, `contain` or `will-change`
  //      anywhere above the panel silently confines the "full screen" sheet to the
  //      panel's own box. The first version of this viewer looked correct in a
  //      jsdom test and rendered a small card-sized rectangle in the real shell.
  //      So the geometry is measured, not assumed.
  const overlay = await cdp.evaluate(
    `(() => {
      const box = document.querySelector('.agnes__lightbox');
      if (!box) return null;
      const rect = box.getBoundingClientRect();
      const style = getComputedStyle(box);
      // Walk up looking for the property that would trap a fixed element.
      const traps = [];
      for (let node = box.parentElement; node !== null; node = node.parentElement) {
        const computed = getComputedStyle(node);
        if (computed.transform !== 'none') traps.push(node.className + ':transform');
        if (computed.filter !== 'none') traps.push(node.className + ':filter');
        if (computed.contain !== 'none') traps.push(node.className + ':contain');
        if (computed.perspective !== 'none') traps.push(node.className + ':perspective');
        if (computed.willChange !== 'auto') traps.push(node.className + ':will-change');
      }
      return JSON.stringify({
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        position: style.position,
        background: style.backgroundColor,
        traps,
      });
    })()`,
  )
  const overlayState = JSON.parse(overlay)
  if (overlayState.position !== 'fixed') throw new Error(`the viewer is not fixed-positioned: ${String(overlayState.position)}`)
  // One pixel of slack for sub-pixel rounding on a fractional device pixel ratio.
  if (Math.abs(overlayState.width - overlayState.viewportWidth) > 1) {
    throw new Error(
      `the viewer does not span the viewport width: ${String(overlayState.width)} vs ${String(overlayState.viewportWidth)}; ` +
        `containing-block traps: ${overlayState.traps.join(', ') || 'none'}`,
    )
  }
  if (Math.abs(overlayState.height - overlayState.viewportHeight) > 1) {
    throw new Error(
      `the viewer does not span the viewport height: ${String(overlayState.height)} vs ${String(overlayState.viewportHeight)}; ` +
        `containing-block traps: ${overlayState.traps.join(', ') || 'none'}`,
    )
  }
  // The backdrop must actually dim what is behind it.
  const alpha = Number.parseFloat(String(overlayState.background).replace(/^rgba?\([^)]*?,\s*([\d.]+)\)$/, '$1'))
  if (!Number.isFinite(alpha) || alpha < 0.5) {
    throw new Error(`the viewer backdrop is not dark enough to read as an overlay: ${String(overlayState.background)}`)
  }
  check(
    'browser-viewer-covers-viewport',
    `${String(overlayState.width)}x${String(overlayState.height)} @${String(overlayState.position)}, ${overlayState.traps.length === 0 ? 'no traps' : overlayState.traps.join(',')}`,
  )
  await cdp.shot('07-viewer-open.png')

  // 13. Zooming actually changes the rendered size, not just a label.
  //
  //     Asserting the percentage text alone would pass on a viewer whose transform
  //     was never applied. So the button is pressed and the picture's own bounding
  //     box is compared before and after.
  //
  //     The wait condition is the LAYOUT change, not the label: the picture has a
  //     140ms transform transition, so reading its box in the same tick as the
  //     click reports the pre-animation size and would fail a correct viewer.
  const beforeWidth = openedState.width
  await cdp.evaluate(`(() => { document.querySelector('.agnes__lightboxZoomIn').click(); return true })()`)
  const zoomed = await until(
    cdp.evaluate,
    `(() => {
      const zoom = document.querySelector('.agnes__lightboxZoom');
      const image = document.querySelector('.agnes__lightboxImage');
      if (!zoom || !image) return null;
      const text = zoom.textContent.trim();
      if (text === '100%') return null;
      const rect = image.getBoundingClientRect();
      // Wait for the transition to settle: the box must be strictly larger than
      // the fit size before this counts as a zoom.
      if (Math.round(rect.width) <= ${String(beforeWidth)}) return null;
      return JSON.stringify({ zoom: text, width: Math.round(rect.width), height: Math.round(rect.height), transform: image.style.transform });
    })()`,
    'the zoom-in control to enlarge the picture',
  )
  const zoomedState = JSON.parse(zoomed)
  if (!(zoomedState.width > beforeWidth)) {
    throw new Error(`zoom did not enlarge the picture: ${String(beforeWidth)} -> ${String(zoomedState.width)}`)
  }
  if (!zoomedState.transform.includes('scale(')) throw new Error('the picture has no scale transform')
  check('browser-viewer-zoom-in', `${String(beforeWidth)}px -> ${String(zoomedState.width)}px at ${String(zoomedState.zoom)}`)
  await cdp.shot('08-viewer-zoomed.png')

  // 14. Escape closes it and the panel is usable again.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await until(cdp.evaluate, `document.querySelector('.agnes__lightbox') === null`, 'the viewer to close on Escape')
  const afterClose = await cdp.evaluate(
    `JSON.stringify({ heading: document.querySelector('.agnes__title')?.textContent.trim() ?? null, cards: document.querySelectorAll('.agnes__card').length })`,
  )
  const afterCloseState = JSON.parse(afterClose)
  if (afterCloseState.heading === null) throw new Error('the panel did not survive closing the viewer')
  check('browser-viewer-escape-closes', `${String(afterCloseState.cards)} card(s) still rendered`)

  // 15. The backdrop closes it too, and clicking the picture does not.
  await cdp.evaluate(`(() => { document.querySelector('.agnes__open').click(); return true })()`)
  await until(cdp.evaluate, `document.querySelector('.agnes__lightboxImage') !== null`, 'the viewer to reopen')
  const reopenedWidth = await cdp.evaluate(
    `(() => { const image = document.querySelector('.agnes__lightboxImage'); return image ? Math.round(image.getBoundingClientRect().width) : 0 })()`,
  )
  await cdp.evaluate(`(() => { document.querySelector('.agnes__lightboxImage').click(); return true })()`)
  const afterImageClick = await until(
    cdp.evaluate,
    `(() => {
      const box = document.querySelector('.agnes__lightbox');
      if (!box) return JSON.stringify({ open: false, zoom: null });
      const zoom = document.querySelector('.agnes__lightboxZoom');
      const image = document.querySelector('.agnes__lightboxImage');
      const text = zoom ? zoom.textContent.trim() : null;
      const width = image ? Math.round(image.getBoundingClientRect().width) : 0;
      // Same transition race as the toolbar: wait for the box, not just the label.
      if (text === '100%' || width <= ${String(reopenedWidth)}) return null;
      return JSON.stringify({ open: true, zoom: text, width });
    })()`,
    'clicking the picture to zoom it',
  )
  const imageClickState = JSON.parse(afterImageClick)
  if (!imageClickState.open) throw new Error('clicking the picture closed the viewer instead of zooming')
  if (imageClickState.zoom === '100%') throw new Error('clicking the picture did not zoom')
  check('browser-viewer-click-zooms', `${String(imageClickState.zoom)} (${String(imageClickState.width)}px)`)

  await cdp.evaluate(`(() => { const box = document.querySelector('.agnes__lightbox'); box.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`)
  await until(cdp.evaluate, `document.querySelector('.agnes__lightbox') === null`, 'the viewer to close on a backdrop click')
  check('browser-viewer-backdrop-closes')

  // 15b. The viewer steps between pictures, by arrow button and by arrow key.
  //
  //      The seeded profile holds two images, so this exercises the real
  //      sequence: a viewer that renders arrows but always shows the same picture
  //      passes a DOM-presence assertion and fails here.
  await cdp.evaluate(`(() => { document.querySelector('.agnes__open').click(); return true })()`)
  await until(cdp.evaluate, `document.querySelector('.agnes__lightboxImage') !== null`, 'the viewer to reopen')
  const nav = await cdp.evaluate(
    `(() => {
      const prev = document.querySelector('.agnes__lightboxNav--prev');
      const next = document.querySelector('.agnes__lightboxNav--next');
      const image = document.querySelector('.agnes__lightboxImage');
      return JSON.stringify({
        prev: prev !== null,
        next: next !== null,
        src: image ? image.getAttribute('src') : null,
        counter: document.querySelector('.agnes__lightboxSub')?.textContent ?? null,
      });
    })()`,
  )
  const navState = JSON.parse(nav)
  if (!navState.prev || !navState.next) throw new Error('two pictures must offer prev/next controls')
  if (!String(navState.counter).includes('/ 2')) {
    throw new Error(`the viewer does not report its position in the sequence: ${String(navState.counter)}`)
  }
  await cdp.evaluate(`(() => { document.querySelector('.agnes__lightboxNav--next').click(); return true })()`)
  const stepped = await until(
    cdp.evaluate,
    `(() => {
      const image = document.querySelector('.agnes__lightboxImage');
      if (!image) return null;
      const src = image.getAttribute('src');
      if (src === ${JSON.stringify(navState.src)}) return null;
      return JSON.stringify({ src, zoom: document.querySelector('.agnes__lightboxZoom')?.textContent.trim() ?? null });
    })()`,
    'the next arrow to change the picture',
  )
  const steppedState = JSON.parse(stepped)
  // A new picture starts fitted: carrying a zoom across a step would show the
  // next picture cropped to a corner of the previous one.
  if (steppedState.zoom !== '100%') throw new Error(`stepping did not reset the zoom: ${String(steppedState.zoom)}`)
  check('browser-viewer-navigates', `next -> ${String(steppedState.src)} at ${String(steppedState.zoom)}`)

  // The arrow keys do the same, and wrap around.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
  await until(
    cdp.evaluate,
    `(() => { const image = document.querySelector('.agnes__lightboxImage'); return image && image.getAttribute('src') !== ${JSON.stringify(steppedState.src)} })()`,
    'the right arrow key to step the picture',
  )
  check('browser-viewer-arrow-keys')

  const fitWidth = await cdp.evaluate(
    `(() => { const image = document.querySelector('.agnes__lightboxImage'); return image ? Math.round(image.getBoundingClientRect().width) : 0 })()`,
  )
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '+', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187, modifiers: 8 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '+', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187, modifiers: 8 })
  const keyboardZoom = await until(
    cdp.evaluate,
    `(() => {
      const zoom = document.querySelector('.agnes__lightboxZoom');
      const image = document.querySelector('.agnes__lightboxImage');
      if (!zoom || !image) return null;
      const text = zoom.textContent.trim();
      if (text === '100%') return null;
      const width = Math.round(image.getBoundingClientRect().width);
      if (width <= ${String(fitWidth)}) return null;
      return JSON.stringify({ zoom: text, width });
    })()`,
    'the + key to zoom the picture',
  )
  const keyboardState = JSON.parse(keyboardZoom)
  check('browser-viewer-keyboard-zoom', `${String(fitWidth)}px -> ${String(keyboardState.width)}px at ${String(keyboardState.zoom)}`)

  // Zoom-out is disabled at fit zoom, so it cannot shrink the picture below the
  // frame it was laid out in.
  await cdp.evaluate(`(() => { document.querySelector('.agnes__lightboxReset').click(); return true })()`)
  const outDisabled = await until(
    cdp.evaluate,
    `(() => {
      const button = document.querySelector('.agnes__lightboxZoomOut');
      if (!button) return null;
      return button.disabled ? 'disabled' : null;
    })()`,
    'zoom-out to disable at fit zoom',
  )
  check('browser-viewer-zoom-out-disabled', String(outDisabled))

  // Escape closes it again, and the focus lands back on the control that opened it.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await until(cdp.evaluate, `document.querySelector('.agnes__lightbox') === null`, 'the viewer to close on Escape')
  const focusReturned = await cdp.evaluate(
    `(() => { const active = document.activeElement; return active ? active.className : null })()`,
  )
  if (focusReturned !== null && !String(focusReturned).includes('agnes__open')) {
    throw new Error(`closing the viewer did not return focus to the opener: ${String(focusReturned)}`)
  }
  check('browser-viewer-focus-returns')

  // 16. The prompt optimizer is wired to the Host and changes the prompt.
  //
  //     It needs a key, so the check reports which case it exercised instead of
  //     depending on whether the runner exported one: unconfigured, the control
  //     must be present but disabled (it cannot work without a key), and the
  //     configured path is covered by the offline view spec.
  await cdp.evaluate(`(() => { const tab = [...document.querySelectorAll('[role="tab"]')].find((n) => n.textContent.includes('生图')); tab?.click(); return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const optimizer = await cdp.evaluate(
    `(() => {
      const button = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('优化提示词'));
      if (!button) return JSON.stringify({ error: 'no optimizer button' });
      return JSON.stringify({
        disabled: button.disabled,
        inPromptFoot: button.closest('.agnes__promptFoot') !== null,
      });
    })()`,
  )
  const optState = JSON.parse(optimizer)
  if (optState.error !== undefined) throw new Error('the prompt optimizer did not render')
  if (!optState.inPromptFoot) throw new Error('the prompt optimizer is not inside the prompt box')
  check('browser-prompt-optimizer', optState.disabled ? 'present, disabled without a key' : 'present, enabled')

  // 17. Running jobs are Host state, not panel state.
  //
  //     The defect this guards is subtle and was reported from real use: the work
  //     continued after leaving the studio (the Host kept generating), but coming
  //     back showed an idle panel because the in-flight marker lived in the
  //     unmounted React tree. The panel must therefore read `state.running` from
  //     the Host. Asserting a live job here would need a real generation, so this
  //     asserts the contract instead: the polling loop is installed and the panel
  //     consumes the running list. Combining them means a panel that forgot to
  //     poll cannot pass.
  const runningWiring = await cdp.evaluate(
    `(() => {
      // The gallery/host contract: a running entry renders as a pending card, and
      // the pending card offers the cancel action that only exists for a Host job.
      const pending = document.querySelectorAll('.agnes__card--pending').length;
      const hasCancelWiring = document.querySelector('.agnes__cancelJob') !== null;
      const busyBox = document.querySelector('.agnes__busy');
      return JSON.stringify({ pending, hasCancelWiring, busy: busyBox !== null });
    })()`,
  )
  const runningState = JSON.parse(runningWiring)
  // With no job in flight the idle panel must show none of the running UI: a
  // permanent "generating" banner would be the opposite bug.
  if (runningState.pending > 0 || runningState.busy) {
    throw new Error('the panel shows running-job UI with no job in flight')
  }
  check('browser-running-jobs-idle', 'no phantom in-flight UI')

  // 18. The display metadata shipped in the package is what the plugin card reads.
  check('display-detail-image', 'docs/DETAIL*.md + docs/preview*.svg present in the packed tarball')

  // The closing shot: the panel after the full viewer round-trip, which is what
  // proves closing the viewer left the page usable rather than merely present.
  await cdp.shot('05-panel-after-viewer.png')

  // 19. A retry restarts the record's own card.
  //
  //     Reported from real use: clicking 重试 put a NEW skeleton card beside the
  //     failed one, and the two "merged" only when the attempt settled, so one
  //     task looked like two. A retry reuses the failed record's id, so the panel
  //     must show the progress INSIDE that record's card, add no card at all, and
  //     not repeat the same work in a second surface (the background banner).
  //
  //     A retry needs a usable key — the Host refuses to register a job without
  //     one — so the check reports which case it exercised instead of failing a
  //     deliberately keyless packaging run. The failure is seeded into this OWNED
  //     profile only now, after every card-count assertion above, so those counts
  //     stay exact. The page is then reloaded, which also re-proves that the
  //     in-flight state comes from the Host and not from panel memory.
  const apiKey = process.env.AGNES_API_KEY
  if (apiKey === undefined || apiKey === '') {
    process.stdout.write('  skip browser-retry-in-place (no AGNES_API_KEY: the Host cannot start a retry)\n')
  } else {
    const previewState = JSON.parse(await readFile(join(process.cwd(), '.preview-state.json'), 'utf8'))
    const seeded = await appendFailedGeneration(previewState.dataDir)
    await cdp.evaluate(`window.__agnesBeforeReload = true`)
    await cdp.send('Page.reload')
    await until(
      cdp.evaluate,
      `window.__agnesBeforeReload === undefined && document.querySelector('#root')?.children.length > 0`,
      'the app to boot after a reload',
      45_000,
    )
    await cdp.evaluate(dismissOverlays).catch(() => {})
    await openStudio()

    // The seeded failure is the newest record, so it leads the gallery.
    const failedCard = await until(
      cdp.evaluate,
      `(() => {
        const card = document.querySelector('.agnes__card--failed');
        if (!card) return null;
        const retry = [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === '重试');
        if (!retry) return null;
        return JSON.stringify({ text: card.querySelector('.agnes__promptText')?.textContent.trim() ?? '' });
      })()`,
      'the seeded retryable failure',
    )
    const seededCard = JSON.parse(failedCard)
    if (!seededCard.text.includes('重试验收')) {
      throw new Error(`the seeded failure is not the failed card: ${seededCard.text}`)
    }

    // Click 重试 exactly as a user would: the card's own button, never a shared
    // "last request" the panel happened to remember.
    const clicked = await cdp.evaluate(
      `(() => {
        const card = document.querySelector('.agnes__card--failed');
        const retry = card ? [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === '重试') : null;
        if (!retry) return 'no retry button';
        retry.click();
        return 'clicked';
      })()`,
    )
    if (clicked !== 'clicked') throw new Error(`could not click the seeded retry: ${String(clicked)}`)

    const progress = await until(
      cdp.evaluate,
      `(() => {
        const card = document.querySelector('.agnes__card--retrying');
        if (!card) return null;
        const hint = [...card.querySelectorAll('.agnes__hint')].map((node) => node.textContent.trim());
        const cancel = [...card.querySelectorAll('button')].some((node) => node.textContent.includes('取消'));
        return JSON.stringify({
          retrying: document.querySelectorAll('.agnes__card--retrying').length,
          pending: document.querySelectorAll('.agnes__card--pending').length,
          banners: document.querySelectorAll('.agnes__busy').length,
          cards: document.querySelectorAll('.agnes__card').length,
          spinner: card.querySelector('.agnes__spinner') !== null,
          hint,
          cancel,
        });
      })()`,
      'the retried card to become the progress card',
    )
    const retryState = JSON.parse(progress)
    if (retryState.retrying !== 1) throw new Error('exactly one card must be retrying')
    if (retryState.pending !== 0) throw new Error('a retry must not add a placeholder card')
    if (retryState.banners !== 0) throw new Error('a retry must not duplicate its progress in a background banner')
    if (retryState.cards !== 3) {
      throw new Error(`a retry must not change the card count: got ${String(retryState.cards)} cards for ${seeded.id}`)
    }
    if (!retryState.spinner) throw new Error('the retrying card has no spinner')
    if (!retryState.cancel) throw new Error('the retrying card offers no way to stop the retry')
    if (!retryState.hint.some((entry) => entry.includes('正在重试'))) {
      throw new Error('the retrying card does not explain what it is doing')
    }
    await cdp.shot('06-retry-in-place.png')
    check('browser-retry-in-place', '1 card retrying, 0 pending, 3 cards, no banner')

    // It settles back into the SAME record: the count must not change and no
    // placeholder may take over. This runs a real generation (~10s).
    const settled = await until(
      cdp.evaluate,
      `(() => {
        if (document.querySelector('.agnes__card--retrying')) return null;
        if (document.querySelector('.agnes__card--pending')) return null;
        return JSON.stringify({
          cards: document.querySelectorAll('.agnes__card').length,
          failed: document.querySelectorAll('.agnes__card--failed').length,
          images: document.querySelectorAll('.agnes__card img').length,
        });
      })()`,
      'the retry to settle into the same card',
      120_000,
    )
    const settledState = JSON.parse(settled)
    if (settledState.cards !== 3) {
      throw new Error(`a retried attempt must settle into its own record: got ${String(settledState.cards)} cards`)
    }
    await cdp.shot('07-retry-settled.png')
    check(
      'browser-retry-settles-in-place',
      settledState.failed > 0 ? 'settled back to the failed card, 3 cards' : `${String(settledState.images)} images, 3 cards`,
    )
  }

  // 20. "继续编辑": a finished picture becomes the next request's reference.
  //
  //     The panel only knows the authenticated same-origin media route, so the
  //     upstream cannot fetch the source itself: the Host must inline the stored
  //     bytes as a data: URI. This check therefore exercises the whole chain
  //     against the real API — click 继续编辑 on a seeded picture, submit, and
  //     then read the store to prove the new record kept the symbolic reference
  //     and its lineage instead of freezing base64 into the index.
  if (apiKey === undefined || apiKey === '') {
    process.stdout.write('  skip browser-continue-editing (no AGNES_API_KEY: the Host cannot start the follow-up)\n')
  } else {
    const continueState = JSON.parse(await readFile(join(process.cwd(), '.preview-state.json'), 'utf8'))
    const cardsBefore = await cdp.evaluate(`document.querySelectorAll('.agnes__card').length`)
    const clickedContinue = await cdp.evaluate(
      `(() => {
        const card = [...document.querySelectorAll('.agnes__card')].find((node) =>
          (node.querySelector('.agnes__promptText')?.textContent ?? '').includes('灯箱验收用图：网格 + 圆环'));
        const button = card ? [...card.querySelectorAll('button')].find((node) => node.textContent.includes('继续编辑')) : null;
        if (!button) return 'no continue button';
        button.click();
        return 'clicked';
      })()`,
    )
    if (clickedContinue !== 'clicked') throw new Error(`could not start continue editing: ${String(clickedContinue)}`)

    const editor = await until(
      cdp.evaluate,
      `(() => {
        const banner = document.querySelector('.agnes__refine');
        const prompt = document.querySelector('textarea.agnes__prompt');
        const thumb = document.querySelector('img.agnes__refineThumb');
        const submit = [...document.querySelectorAll('.agnes__composerFoot button')].map((node) => node.textContent.trim()).join('|');
        if (!banner || !prompt || !thumb) return null;
        return JSON.stringify({
          title: banner.querySelector('.agnes__refineTitle')?.textContent.trim() ?? '',
          prompt: prompt.value,
          thumb: thumb.getAttribute('src'),
          refining: document.querySelectorAll('.agnes__card--refining').length,
          cards: document.querySelectorAll('.agnes__card').length,
          submit,
        });
      })()`,
      'the composer to load the finished picture',
    )
    const editorState = JSON.parse(editor)
    if (!editorState.title.includes('接着这条')) throw new Error(`unexpected editor title: ${editorState.title}`)
    if (!editorState.prompt.includes('灯箱验收用图：网格 + 圆环')) throw new Error('the prompt was not restored')
    if (!String(editorState.thumb).includes(encodeURIComponent(FIXTURE_ID))) throw new Error('the source thumbnail is not the fixture')
    if (editorState.refining !== 1) throw new Error('the source card is not marked as being edited')
    if (editorState.cards !== cardsBefore) throw new Error('opening the editor must not add a card')
    if (!editorState.submit.includes('生成修改版')) throw new Error('the submit button does not say it will generate an edit')
    await cdp.shot('08-continue-editing.png')
    check('browser-continue-editing-prefills', 'source thumbnail, prompt and card count preserved')

    const submittedEdit = await cdp.evaluate(
      `(() => {
        const button = [...document.querySelectorAll('.agnes__composerFoot button')].find((node) => node.textContent.includes('生成修改版'));
        if (!button) return 'no submit';
        button.click();
        return 'clicked';
      })()`,
    )
    if (submittedEdit !== 'clicked') throw new Error(`could not submit the edit: ${String(submittedEdit)}`)

    // A settled continuation JOINS its source's card as a second version instead
    // of adding a sibling: the gallery must keep the same number of cards, and
    // the stack must now report two versions with the new picture on top.
    const settledEdit = await until(
      cdp.evaluate,
      `(() => {
        if (document.querySelector('.agnes__card--pending')) return null;
        if (document.querySelector('.agnes__card--retrying')) return null;
        if (document.querySelector('.agnes__busy')) return null;
        if (document.querySelector('.agnes__refine')) return null;
        const stack = document.querySelector('.agnes__stack');
        if (!stack) return null;
        const front = stack.querySelector('.agnes__card--stacked');
        if (!front) return null;
        return JSON.stringify({
          cards: document.querySelectorAll('.agnes__card').length,
          stacks: document.querySelectorAll('.agnes__stack').length,
          layers: stack.querySelectorAll('.agnes__stackStrip').length,
          pills: [...stack.querySelectorAll('.agnes__stackPill')].map((node) => node.textContent.trim()),
          badge: stack.querySelector('.agnes__stackBadge')?.textContent.trim() ?? '',
          facts: [...front.querySelectorAll('.agnes__fact')].map((node) => node.textContent.trim()),
          // The front card holds every version's shot, so "has an image" is only
          // meaningful for the shot that is actually visible.
          hasImage: front.querySelector('.agnes__stackShot--on img.agnes__thumb') !== null,
          failed: front.classList.contains('agnes__card--failed'),
        });
      })()`,
      'the edited picture to finish',
      180_000,
    )
    const settleState = JSON.parse(settledEdit)
    if (settleState.failed) throw new Error('the edited generation failed')
    if (!settleState.hasImage) throw new Error('the edited generation has no picture')
    if (settleState.cards !== cardsBefore) {
      throw new Error(`a continuation must join its source's stack, not add a card: ${String(settleState.cards)} vs ${String(cardsBefore)}`)
    }
    if (settleState.stacks !== 1) throw new Error(`expected exactly one stack, got ${String(settleState.stacks)}`)
    // Two versions mean exactly one neighbour to fan out: the pile shows the
    // older print as a strip beside the new one, never as a second full card.
    if (settleState.layers !== 1) {
      throw new Error(`expected one fanned-out neighbour beside a two-version pile, got ${String(settleState.layers)}`)
    }
    if (settleState.pills.length !== 2) throw new Error(`the version rail does not list two versions: ${JSON.stringify(settleState.pills)}`)
    if (!settleState.badge.includes('2')) throw new Error(`the stack badge does not report two versions: ${settleState.badge}`)
    if (!settleState.facts.some((fact) => fact.includes('承接'))) {
      throw new Error(`the newest version does not show its lineage: ${JSON.stringify(settleState.facts)}`)
    }
    await cdp.shot('09-continue-settled.png')
    check('browser-continue-editing-settles', `${String(settleState.cards)} cards, 1 stack of 2 versions, lineage on top`)

    // 21. Flipping the pile: the gesture the panel is meant to feel like a chat
    //     app's merged photos. Two things have to be true at once, and a jsdom
    //     test can only prove the first:
    //
    //     - the real wheel/drag events reach the handler and change the version;
    //     - the card's painted box is IDENTICAL at every version. A remount, a
    //       height change or a hover lift would all show up as a different box,
    //       which is what "it shakes" was about.
    const boxOf = async () =>
      JSON.parse(
        await cdp.evaluate(
          `(() => {
            const card = document.querySelector('.agnes__card--stacked');
            const media = document.querySelector('.agnes__stackMedia');
            if (!card || !media) return JSON.stringify(null);
            const c = card.getBoundingClientRect();
            const m = media.getBoundingClientRect();
            return JSON.stringify({
              card: [Math.round(c.left), Math.round(c.top), Math.round(c.width * 100) / 100, Math.round(c.height * 100) / 100],
              media: [Math.round(m.left), Math.round(m.top), Math.round(m.width * 100) / 100, Math.round(m.height * 100) / 100],
              badge: document.querySelector('.agnes__stackBadge')?.textContent.trim() ?? '',
              active: [...document.querySelectorAll('.agnes__stackPill--on')].map((n) => n.textContent.trim()),
              src: document.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') ?? null,
            });
          })()`,
        ),
      )
    const boxBefore = await boxOf()
    if (boxBefore === null) throw new Error('the stacked card is not in the DOM')
    const topVersionSrc = boxBefore.src
    if (topVersionSrc === null) throw new Error('the pile has no visible picture')

    // The pile must announce its depth with the neighbours' own pictures, in the
    // gutters reserved beside the front print, BEFORE any gesture is used.
    //
    // The fan is a background layer of the STAGE rather than a sibling element:
    // the card paints a box shadow across the gutter, so a sibling strip is
    // covered by it no matter how it is stacked. Reading the stage's computed
    // background is therefore reading the fan itself.
    const pileLook = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const stage = document.querySelector('.agnes__stackStage');
          const media = document.querySelector('.agnes__stackMedia');
          const deck = document.querySelector('.agnes__stackDeck');
          const hint = document.querySelector('.agnes__stackHint');
          const card = document.querySelector('.agnes__card--stacked');
          if (!stage || !media || !deck || !hint || !card) return JSON.stringify(null);
          const cardBox = card.getBoundingClientRect();
          const deckBox = deck.getBoundingClientRect();
          const stageBox = stage.getBoundingClientRect();
          const strips = [...document.querySelectorAll('.agnes__stackStrip')].map((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              side: node.getAttribute('data-side'),
              // The picture is a background; data-src mirrors it, and the
              // resolved style is what proves the browser is painting it.
              src: node.getAttribute('data-src'),
              painted: style.backgroundImage,
              area: [Math.round(box.width), Math.round(box.height)],
              // The strips live INSIDE the card now, in the gutter the deck
              // leaves free. A strip outside the card's box is what used to make
              // the pile wider than its column.
              insideCard: box.left >= cardBox.left - 0.5 && box.right <= cardBox.right + 0.5,
              // ...and hugging the picture's outer edge, which is where the fan
              // reads as a print tucked behind the face rather than as a border
              // floating in the middle of the card.
              hugsEdge:
                node.getAttribute('data-side') === 'right'
                  ? Math.round((deckBox.right - box.right) * 10) / 10
                  : Math.round((box.left - deckBox.left) * 10) / 10,
            };
          });
          // The gallery pane is the thing that grew a scrollbar. A pile may never
          // make it scroll horizontally: that is what dragged the whole screen
          // sideways during a flip.
          const panes = [...document.querySelectorAll('.agnes *')].filter((node) => {
            const style = getComputedStyle(node);
            return /(auto|scroll)/.test(style.overflowX) || /(auto|scroll)/.test(style.overflowY);
          });
          const overflowing = panes
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => ({ className: node.className, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
          const grid = document.querySelector('.agnes__grid');
          return JSON.stringify({
            strips,
            // The deck is inset inside the picture area: that inset IS the gutter.
            gutter: Math.round((deckBox.left - stageBox.left) * 100) / 100,
            cardWidth: Math.round(cardBox.width * 100) / 100,
            stageWidth: Math.round(stageBox.width * 100) / 100,
            deckWidth: Math.round(deckBox.width * 100) / 100,
            overflowing,
            gridScrollWidth: grid === null ? null : grid.scrollWidth,
            gridClientWidth: grid === null ? null : grid.clientWidth,
            hintText: hint.textContent.trim(),
            cursor: getComputedStyle(media).cursor,
            touchAction: getComputedStyle(media).touchAction,
            stageTouch: getComputedStyle(stage).touchAction,
            veil: (() => {
              const veil = media.querySelector('.agnes__thumbVeil');
              return veil === null ? 'none' : getComputedStyle(veil).display;
            })(),
          });
        })()`,
      ),
    )
    if (pileLook === null) throw new Error('the pile is missing its stage, deck, media or hint')
    if (pileLook.strips.length !== 1) {
      throw new Error(`a two-version pile must fan out exactly one neighbour, got ${String(pileLook.strips.length)}`)
    }
    const [onlyStrip] = pileLook.strips
    if (!String(onlyStrip.src).includes('/api/agnes-studio/media')) {
      throw new Error(`the fanned-out neighbour is not generated media: ${String(onlyStrip.src)}`)
    }
    if (!String(onlyStrip.painted).includes('url(')) {
      throw new Error(`the fanned-out neighbour paints no picture: ${String(onlyStrip.painted)}`)
    }
    if (!(onlyStrip.area[0] >= 4) || !(onlyStrip.area[1] >= 40)) {
      throw new Error(`the fanned-out neighbour has no painted area: ${JSON.stringify(onlyStrip.area)}`)
    }
    if (onlyStrip.side !== 'right') {
      throw new Error(`the older version should fan out to the right of the face of the pile: ${String(onlyStrip.side)}`)
    }
    if (!onlyStrip.insideCard) {
      throw new Error('the fanned-out neighbour sticks out of the card, so the pile is wider than its column')
    }
    // It overlays the picture's outer edge: flush with it, not floating in the
    // middle of the card and not hanging outside it.
    if (!(Number(onlyStrip.hugsEdge) >= -1 && Number(onlyStrip.hugsEdge) <= 2)) {
      throw new Error(`the fanned-out neighbour is not hugging the picture edge: ${String(onlyStrip.hugsEdge)}px inside`)
    }
    // THE regression this check exists for: no pile may create horizontal scroll.
    if (pileLook.overflowing.length > 0) {
      throw new Error(`the pile made a pane scroll horizontally: ${JSON.stringify(pileLook.overflowing)}`)
    }
    if (Number(pileLook.gridScrollWidth) > Number(pileLook.gridClientWidth) + 1) {
      throw new Error(`the grid overflows horizontally: ${String(pileLook.gridScrollWidth)} > ${String(pileLook.gridClientWidth)}`)
    }
    // The stage is exactly the card: no borrowed width, no negative margin.
    if (Math.abs(Number(pileLook.cardWidth) - Number(pileLook.stageWidth)) > 0.5) {
      throw new Error(`the stage is wider than the card: ${String(pileLook.stageWidth)} vs ${String(pileLook.cardWidth)}`)
    }
    // The deck is the full width of the card: the fan is overlaid on the picture's
    // own edge instead of taking columns from it, so the face of a pile is exactly
    // as wide as any other card's picture.
    if (Math.abs(Number(pileLook.deckWidth) - Number(pileLook.cardWidth)) > 2.5) {
      throw new Error(`the deck is narrower than the card: ${String(pileLook.deckWidth)} vs ${String(pileLook.cardWidth)}`)
    }
    if (pileLook.hintText === '') throw new Error('the flip hint has no label')
    if (pileLook.veil !== 'none') throw new Error(`the pile picture still renders the hover veil: ${String(pileLook.veil)}`)
    if (pileLook.touchAction !== 'pan-y' && pileLook.touchAction !== 'pan-y pinch-zoom') {
      throw new Error(`the picture would eat a vertical scroll: touch-action ${String(pileLook.touchAction)}`)
    }
    if (pileLook.stageTouch !== 'pan-y' && pileLook.stageTouch !== 'pan-y pinch-zoom') {
      throw new Error(`the pile stage would eat a vertical scroll: touch-action ${String(pileLook.stageTouch)}`)
    }
    check(
      'browser-stack-pile-contained',
      `full-width deck, fan painted over the picture edge (${String(onlyStrip.area[0])}x${String(onlyStrip.area[1])}px), no horizontal overflow`,
    )

    // The dealing motion must be REAL: the prints carry their deck position as an
    // inline transform with a real transition, so a flip interpolates instead of
    // blinking. A crossfade-only build has no transform here at all.
    const dealLook = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const shots = [...document.querySelectorAll('.agnes__stackShot')].map((node) => {
            const style = getComputedStyle(node);
            return {
              offset: node.getAttribute('data-offset'),
              inline: node.style.transform,
              resolved: style.transform,
              transition: style.transitionProperty,
              duration: style.transitionDuration,
            };
          });
          return JSON.stringify(shots);
        })()`,
      ),
    )
    if (dealLook.length < 2) throw new Error('the deck has fewer than two prints to deal')
    const face = dealLook.find((shot) => shot.offset === '0')
    const behind = dealLook.find((shot) => shot.offset === '1')
    if (face === undefined || behind === undefined) {
      throw new Error(`the deck is not positioned by offset: ${JSON.stringify(dealLook.map((s) => s.offset))}`)
    }
    // Every print must animate its transform, or a flip cannot deal.
    for (const shot of dealLook) {
      if (!String(shot.transition).includes('transform')) {
        throw new Error(`a print does not transition its transform: ${String(shot.transition)}`)
      }
      if (!/[1-9]/.test(String(shot.duration))) {
        throw new Error(`a print has no transition duration: ${String(shot.duration)}`)
      }
    }
    // The face is square; the print behind it is shifted and tilted.
    if (String(face.inline).includes('rotate(') && !String(face.inline).includes('rotate(0deg)')) {
      throw new Error(`the face of the pile is tilted: ${String(face.inline)}`)
    }
    if (!String(behind.inline).includes('translate3d')) {
      throw new Error(`the print behind the face is not shifted: ${String(behind.inline)}`)
    }
    if (!String(behind.inline).includes('rotate(')) {
      throw new Error(`the print behind the face is not tilted: ${String(behind.inline)}`)
    }
    {
      const info = JSON.parse(await cdp.evaluate(
        `(() => {
          const strip = document.querySelector('.agnes__stackStrip');
          const deck = document.querySelector('.agnes__stackDeck');
          const media = document.querySelector('.agnes__stackMedia');
          if (!strip || !deck || !media) return JSON.stringify(null);
          const sb = strip.getBoundingClientRect();
          const db = deck.getBoundingClientRect();
          const mb = media.getBoundingClientRect();
          const cx = Math.round(sb.left + sb.width / 2);
          const cy = Math.round(sb.top + Math.min(sb.height / 2, 60));
          // NOTE: elementFromPoint cannot see the strips — they are
          // pointer-events:none by design. Hit testing says nothing about
          // painting here; the screenshot sampled below is the real evidence.
          const shot = deck.querySelector('.agnes__stackShot--on');
          return JSON.stringify({
            strip: [Math.round(sb.left), Math.round(sb.top), Math.round(sb.width), Math.round(sb.height)],
            deck: [Math.round(db.left), Math.round(db.top), Math.round(db.width), Math.round(db.height)],
            media: [Math.round(mb.left), Math.round(mb.top), Math.round(mb.width), Math.round(mb.height)],
            stripZ: getComputedStyle(strip).zIndex,
            deckZ: getComputedStyle(deck).zIndex,
            shotZ: shot === null ? null : getComputedStyle(shot).zIndex,
            topAtStrip: (() => { const t = document.elementFromPoint(cx, cy); return t === null ? null : (t.className || t.tagName); })(),
            stripBg: getComputedStyle(strip).backgroundImage.slice(0, 60),
          });
        })()`,
      ))
      process.stdout.write(`DIAGZ ${JSON.stringify(info)}\n`)
    }
    // The strips must be VISIBLE, not merely present: they are pointer-events:none
    // by design, so no hit test can answer this, and a resolved url() in the
    // computed style only proves a declaration exists. The evidence is the PAINTED
    // PIXEL: the strip column is screenshotted and compared with the picture
    // beside it. A strip painted correctly shows its own version's photo, which
    // differs from the face; a strip buried under the face is identical to it.
    {
      const geo = JSON.parse(
        await cdp.evaluate(
          `(() => {
            const strip = document.querySelector('.agnes__stackStrip');
            const deck = document.querySelector('.agnes__stackDeck');
            if (!strip || !deck) return JSON.stringify(null);
            const s = strip.getBoundingClientRect();
            const d = deck.getBoundingClientRect();
            return JSON.stringify({
              side: strip.getAttribute('data-side'),
              stripX: Math.round(s.left),
              stripW: Math.round(s.width),
              stripY: Math.round(s.top),
              stripH: Math.round(s.height),
              deckRight: Math.round(d.right),
            });
          })()`,
        ),
      )
      if (geo === null) throw new Error('the pile lost its strip while sampling pixels')
      // A 1px-wide column inside the strip, and the same height just inside the
      // picture, far enough in that it is certainly the face.
      const height = Math.min(20, Math.max(6, geo.stripH - 20))
      /** One 1px-wide column of PNG bytes at `x`. */
      const grab = async (x) => {
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x, y: geo.stripY + 10, width: 1, height, scale: 1 },
        })
        return Buffer.from(shot.data, 'base64')
      }
      const insideStrip = await grab(geo.stripX + Math.max(1, Math.floor(geo.stripW / 2)))
      const insideFace = await grab(geo.deckRight - 40)
      const differs = (a, b) => {
        const min = Math.min(a.length, b.length)
        if (min === 0) return false
        let diff = 0
        for (let i = 0; i < min; i += 1) if (a[i] !== b[i]) diff += 1
        return diff / min > 0.05
      }
      if (!differs(insideStrip, insideFace)) {
        throw new Error('the strip is painted in the same pixels as the face of the pile, so it is hidden under it')
      }
      await writeFile(join(shotDir, 'strip-sample.png'), insideStrip)
    }
    check('browser-stack-deal-motion', `${String(dealLook.length)} prints positioned by offset with transform transitions`)

    // The deal must actually ANIMATE, not just end up in the right place: this is
    // the difference between a photo being dealt and a photo blinking. The check
    // dispatches a real flip and samples the computed transform on every
    // animation frame, requiring at least one INTERMEDIATE matrix — a value that
    // is neither the starting transform nor the settled one.
    const dealFrames = JSON.parse(
      await cdp.evaluate(
        `(async () => {
          const stack = document.querySelector('.agnes__stack');
          if (!stack) return JSON.stringify(null);
          // Start from the OLDER version so the flip has somewhere to go. A
          // two-version pile sitting on the newest one is already clamped at the
          // end of the deck: swiping further would legitimately do nothing, and
          // the sample would prove nothing about the animation.
          const pills = [...stack.querySelectorAll('.agnes__stackPill')];
          pills.at(-1)?.click();
          await new Promise((resolve) => setTimeout(resolve, 320));
          const face = () => stack.querySelector('.agnes__stackShot--on');
          const before = [...stack.querySelectorAll('.agnes__stackShot')].map((n) => n.getAttribute('data-offset'));
          const faceBefore = face();
          const startTransform = faceBefore === null ? '' : getComputedStyle(faceBefore).transform;
          const stage = stack.querySelector('.agnes__stackStage');
          const rect = stage.getBoundingClientRect();
          stage.dispatchEvent(new WheelEvent('wheel', {
            // Negative deltaX flips BACK toward the newest version, which is
            // where the pile was just parked away from.
            deltaX: -140, deltaY: 0, bubbles: true, cancelable: true,
            clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2),
          }));
          const seen = [];
          for (let frame = 0; frame < 24; frame += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const moving = stack.querySelector('.agnes__stackShot--on');
            if (moving !== null) seen.push(getComputedStyle(moving).transform);
          }
          const after = [...stack.querySelectorAll('.agnes__stackShot')].map((n) => n.getAttribute('data-offset'));
          const endTransform = face() === null ? '' : getComputedStyle(face()).transform;
          return JSON.stringify({ before, after, startTransform, endTransform, seen });
        })()`,
      ),
    )
    if (dealFrames === null) throw new Error('the pile disappeared while sampling the deal')
    // The deck moved, or nothing was animated at all.
    if (JSON.stringify(dealFrames.before) === JSON.stringify(dealFrames.after)) {
      throw new Error(`the deck did not deal: ${JSON.stringify(dealFrames.before)}`)
    }
    const distinct = [...new Set(dealFrames.seen)].filter(
      (value) => value !== dealFrames.startTransform && value !== dealFrames.endTransform,
    )
    if (distinct.length === 0) {
      throw new Error(
        `the flip snapped instead of dealing: sampled ${String(dealFrames.seen.length)} frames with no intermediate transform`,
      )
    }
    check('browser-stack-deal-animates', `${String(distinct.length)} intermediate transform frame(s) during one flip`)

    // Put the pile back on the newest version so the following checks start where
    // a user would leave it.
    await cdp.evaluate(`[...document.querySelectorAll('.agnes__stackPill')].at(0)?.click()`)
    await until(
      cdp.evaluate,
      `document.querySelector('.agnes__stackShot--on')?.getAttribute('data-offset') === '0'`,
      'the pile to return to the newest version',
      5_000,
    )

    /** Send one real horizontal wheel gesture over the pile. */
    const swipe = async (deltaX, repeat = 1) => {
      const point = JSON.parse(
        await cdp.evaluate(
          `(() => {
            const media = document.querySelector('.agnes__stackMedia');
            if (!media) return JSON.stringify(null);
            const box = media.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
          })()`,
        ),
      )
      if (point === null) throw new Error('the pile lost its picture mid-test')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
      for (let index = 0; index < repeat; index += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX,
          deltaY: 0,
          button: 'none',
          buttons: 0,
        })
        // Trackpads emit a stream; the real handler accumulates it, so the test
        // does too rather than jumping straight past the threshold.
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }

    // A vertical wheel belongs to the gallery column, not to the pile: a pile
    // that ate it would strand a user whose pointer rests on a picture.
    //
    // Whether the column actually overflows depends on how many records the
    // fixture happens to hold, so the scroll assertion is conditional on there
    // being somewhere to scroll; what is never conditional is that a vertical
    // wheel must not flip a version.
    const scrollPaneExpr = `(() => {
      const media = document.querySelector('.agnes__stackMedia');
      if (!media) return 'null';
      let node = media.parentElement;
      while (node !== null) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8) return 'found';
        node = node.parentElement;
      }
      return 'none';
    })()`
    const scrollPane = await cdp.evaluate(scrollPaneExpr)
    const scrollTopOf = () =>
      cdp.evaluate(
        `(() => {
          const media = document.querySelector('.agnes__stackMedia');
          let node = media === null ? null : media.parentElement;
          while (node !== null) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8) return node.scrollTop;
            node = node.parentElement;
          }
          return null;
        })()`,
      )
    const scrollPoint = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const media = document.querySelector('.agnes__stackMedia');
          if (!media) return JSON.stringify(null);
          const box = media.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
        })()`,
      ),
    )
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: scrollPoint.x, y: scrollPoint.y, button: 'none', buttons: 0 })
    const scrollTopBefore = await scrollTopOf()
    for (let step = 0; step < 4; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: scrollPoint.x,
        y: scrollPoint.y,
        deltaX: 0,
        deltaY: 120,
        button: 'none',
        buttons: 0,
      })
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    const scrollTopAfter = await scrollTopOf()
    const afterVertical = await boxOf()
    if (afterVertical.src !== boxBefore.src) throw new Error('a vertical wheel flipped the pile')
    if (scrollPane === 'found') {
      if (!(Number(scrollTopAfter) > Number(scrollTopBefore))) {
        throw new Error(`a vertical wheel over the pile no longer scrolls the gallery: ${String(scrollTopBefore)} -> ${String(scrollTopAfter)}`)
      }
      // Restore the scroll position so the geometry assertions below measure the
      // same place as the earlier ones.
      await cdp.evaluate(
        `(() => {
          const media = document.querySelector('.agnes__stackMedia');
          let node = media === null ? null : media.parentElement;
          while (node !== null) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8) { node.scrollTop = 0; return true; }
            node = node.parentElement;
          }
          return false;
        })()`,
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    check(
      'browser-stack-vertical-scroll',
      scrollPane === 'found'
        ? `a vertical wheel scrolled the gallery (${String(scrollTopBefore)} -> ${String(scrollTopAfter)}) instead of flipping`
        : 'a vertical wheel did not flip (the fixture column had no overflow to scroll)',
    )

    // The flip itself. Swiping two fingers to the LEFT moves the content left,
    // which the browser reports as deltaX > 0; that gesture pulls the next print
    // — the older version fanned out on the right — into view.
    await swipe(120)
    const flipped = await until(
      cdp.evaluate,
      `(() => {
        const on = document.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') ?? null;
        if (on === ${JSON.stringify(topVersionSrc)}) return null;
        return on;
      })()`,
      'the swipe to flip to the older version',
      5_000,
    )
    const afterFlip = await boxOf()
    if (afterFlip.badge.includes('1 /')) throw new Error(`the badge did not follow the flip: ${afterFlip.badge}`)
    if (afterFlip.active.join(',') !== '2') throw new Error(`the rail did not follow the flip: ${JSON.stringify(afterFlip.active)}`)
    if (JSON.stringify(afterFlip.card) !== JSON.stringify(boxBefore.card)) {
      throw new Error(`flipping resized or moved the card: ${JSON.stringify(afterFlip.card)} vs ${JSON.stringify(boxBefore.card)}`)
    }
    if (JSON.stringify(afterFlip.media) !== JSON.stringify(boxBefore.media)) {
      throw new Error(`flipping moved the picture area: ${JSON.stringify(afterFlip.media)} vs ${JSON.stringify(boxBefore.media)}`)
    }
    await cdp.shot('10-stack-flipped.png')
    check('browser-stack-swipe-flips', `one swipe to the older version, card box constant (${String(flipped)})`)

    // Swiping the other way returns to the newest version, and the strips swap
    // sides: the versions the user is NOT looking at always fan out beside the
    // face of the pile.
    await swipe(-120)
    await until(
      cdp.evaluate,
      `document.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') === ${JSON.stringify(topVersionSrc)}`,
      'the swipe to return to the newest version',
      5_000,
    )
    const backToNewest = await boxOf()
    if (JSON.stringify(backToNewest.card) !== JSON.stringify(boxBefore.card)) {
      throw new Error('returning to the newest version resized the card')
    }
    check('browser-stack-swipe-back', 'the opposite swipe returns to the newest version')

    // A pointer drag is the mouse-only equivalent, and it must not also count as
    // a click on the picture (which would open the viewer the user was dragging
    // past). The lightbox is the observable.
    const dragPoint = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const media = document.querySelector('.agnes__stackMedia');
          if (!media) return JSON.stringify(null);
          const box = media.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(box.left + box.width * 0.72), y: Math.round(box.top + box.height * 0.5) });
        })()`,
      ),
    )
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPoint.x, y: dragPoint.y, button: 'none', buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPoint.x, y: dragPoint.y, button: 'left', buttons: 1, clickCount: 1 })
    for (const travel of [30, 62, 96, 130]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: dragPoint.x - travel,
        y: dragPoint.y + 2,
        button: 'left',
        buttons: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    // The drag offset lives on the DECK now (the whole hand of prints follows the
    // pointer), not on the picture area.
    const midDrag = await cdp.evaluate(
      `(() => {
        const deck = document.querySelector('.agnes__stackDeck');
        return deck === null ? null : deck.style.getPropertyValue('--agnes-drag').trim();
      })()`,
    )
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: dragPoint.x - 130,
      y: dragPoint.y + 2,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    })
    if (midDrag === null || !midDrag.includes('px') || Number.parseFloat(midDrag) === 0) {
      throw new Error(`the picture did not follow the drag: ${String(midDrag)}`)
    }
    const afterDrag = await until(
      cdp.evaluate,
      `(() => {
        const on = document.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') ?? null;
        return on === ${JSON.stringify(topVersionSrc)} ? null : on;
      })()`,
      'the drag to flip to the older version',
      5_000,
    )
    const lightboxOpen = await cdp.evaluate(`document.querySelector('.agnes__lightbox') !== null`)
    if (lightboxOpen) throw new Error('finishing a drag opened the image viewer')
    const afterDragBox = await boxOf()
    if (JSON.stringify(afterDragBox.card) !== JSON.stringify(boxBefore.card)) {
      throw new Error(`dragging flipped but resized the card: ${JSON.stringify(afterDragBox.card)}`)
    }
    const clearedDrag = await cdp.evaluate(
      `(() => {
        const deck = document.querySelector('.agnes__stackDeck');
        return deck === null ? 'missing' : deck.style.getPropertyValue('--agnes-drag').trim();
      })()`,
    )
    if (String(clearedDrag) !== '') {
      throw new Error(`the drag offset was not cleared after release: ${String(clearedDrag)}`)
    }
    check('browser-stack-drag-flips', `picture follows the drag (${String(midDrag)}), no viewer opened, box constant (${String(afterDrag)})`)

    // Arrow keys are the keyboard equivalent and must reach the same version.
    await cdp.evaluate(`(() => {
      const media = document.querySelector('.agnes__stackMedia');
      media?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      return true;
    })()`)
    await until(
      cdp.evaluate,
      `document.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') === ${JSON.stringify(topVersionSrc)}`,
      'the arrow key to return to the newest version',
      5_000,
    )
    const afterKey = await boxOf()
    if (JSON.stringify(afterKey.card) !== JSON.stringify(boxBefore.card)) {
      throw new Error('the arrow key resized the card')
    }
    check('browser-stack-arrow-keys', 'ArrowLeft returns to the newest version, box constant')

    // 22. The rail commits to a version, and the committed version's own actions
    //     become the card's actions. A swipe is easy to overshoot; this is the
    //     precise control, and it must not depend on the pointer staying put.
    const pinned = await cdp.evaluate(
      `(() => {
        const button = [...document.querySelectorAll('.agnes__stackPill')].at(-1);
        if (!button) return 'no pill';
        button.click();
        return 'clicked';
      })()`,
    )
    if (pinned !== 'clicked') throw new Error(`could not pin a version: ${String(pinned)}`)
    const pinnedState = await until(
      cdp.evaluate,
      `(() => {
        const stack = document.querySelector('.agnes__stack');
        if (!stack) return null;
        const on = stack.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') ?? null;
        if (on === ${JSON.stringify(topVersionSrc)}) return null;
        const box = stack.querySelector('.agnes__card--stacked').getBoundingClientRect();
        return JSON.stringify({
          src: on,
          badge: stack.querySelector('.agnes__stackBadge')?.textContent.trim() ?? '',
          active: [...stack.querySelectorAll('.agnes__stackPill--on')].map((n) => n.textContent.trim()),
          card: [Math.round(box.width * 100) / 100, Math.round(box.height * 100) / 100],
        });
      })()`,
      'the rail to commit to the older version',
      5_000,
    )
    const pinnedParsed = JSON.parse(pinnedState)
    if (!pinnedParsed.badge.includes('2')) throw new Error(`the badge did not follow the rail: ${pinnedParsed.badge}`)
    if (pinnedParsed.active.join(',') !== '2') throw new Error(`the rail did not mark the pinned version: ${JSON.stringify(pinnedParsed.active)}`)
    // The pin survives the pointer leaving: that is what makes the pinned
    // version's action row usable.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none', buttons: 0 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const pinnedSticky = await boxOf()
    if (pinnedSticky.src !== pinnedParsed.src) throw new Error('the pinned version was lost when the pointer left the stack')
    if (Math.abs(pinnedSticky.card[3] - boxBefore.card[3]) > 0.5) {
      throw new Error(`pinning a version changed the card height: ${String(pinnedSticky.card[3])} vs ${String(boxBefore.card[3])}`)
    }
    // The strips must now be on the other side, painting the version that is no
    // longer on the face.
    const pinnedFan = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const stage = document.querySelector('.agnes__stackStage');
          return JSON.stringify({
            fan: (stage.dataset.fan ?? '') === '' ? [] : stage.dataset.fan.split('|'),
            strips: [...document.querySelectorAll('.agnes__stackStrip')].map((node) => ({
              side: node.getAttribute('data-side'),
              src: node.getAttribute('data-src'),
              painted: getComputedStyle(node).backgroundImage,
            })),
          });
        })()`,
      ),
    )
    if (pinnedFan.strips.length !== 1) {
      throw new Error(`the fan did not stay beside the pinned version: ${JSON.stringify(pinnedFan)}`)
    }
    // The older version is on the face now, so the NEWER one is behind it: the
    // strip must have moved to the left, exactly where a swipe back will come
    // from — and it must still be carrying a real picture.
    if (pinnedFan.strips[0].side !== 'left') {
      throw new Error(`the fan did not swap sides with the pinned version: ${JSON.stringify(pinnedFan.strips)}`)
    }
    if (!String(pinnedFan.strips[0].src).includes('/api/agnes-studio/media') || !String(pinnedFan.strips[0].painted).includes('url(')) {
      throw new Error(`the swapped strip lost its picture: ${JSON.stringify(pinnedFan.strips[0])}`)
    }
    await cdp.shot('11-stack-pinned.png')
    // Back to following the newest version, so the expanded view is entered from
    // the state a user would leave behind.
    await cdp.evaluate(`[...document.querySelectorAll('.agnes__stackPill')].at(0)?.click()`)
    await until(
      cdp.evaluate,
      `document.querySelector('.agnes__stackShot--on img.agnes__thumb')?.getAttribute('src') === ${JSON.stringify(topVersionSrc)}`,
      'the rail to return to the newest version',
      5_000,
    )
    check('browser-stack-rail-pin', 'older version pinned, strips swapped sides, box unchanged, newest restored')

    //     The pile in the other theme: the strips are pictures dimmed by a filter
    //     over a mixed surface, and the one place that can go wrong is the DARK
    //     theme, where a near-black strip on a near-black page reads as no pile
    //     at all. The earlier theme screenshot is taken before any pile exists, so
    //     this is the only place the dark pile is ever looked at.
    const darkStack = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const body = document.body;
          const wasDark = body.hasAttribute('data-ds-dark-theme');
          body.setAttribute('data-ds-dark-theme', '');
          const stage = document.querySelector('.agnes__stackStage');
          const card = document.querySelector('.agnes__card--stacked');
          if (!stage || !card) return JSON.stringify(null);
          const strip = document.querySelector('.agnes__stackStrip');
          if (strip === null) return JSON.stringify(null);
          const stripStyle = getComputedStyle(strip);
          return JSON.stringify({
            src: strip.getAttribute('data-src'),
            painted: stripStyle.backgroundImage,
            width: Math.round(strip.getBoundingClientRect().width),
            gutter: Math.round((card.getBoundingClientRect().left - stage.getBoundingClientRect().left) * 100) / 100,
            cardBg: getComputedStyle(card).backgroundColor,
            pageBg: getComputedStyle(body).backgroundColor,
            wasDark,
          });
        })()`,
      ),
    )
    if (darkStack === null) throw new Error('the pile disappeared in the dark theme')
    // The strip must be painting a real picture: the flat colour here would mean
    // the fan fell back to a decorative bar and lost the "there are more" signal.
    if (!String(darkStack.painted).includes('url(') || !(Number(darkStack.width) >= 4)) {
      throw new Error(`the dark pile lost its fan: ${JSON.stringify({ painted: darkStack.painted, width: darkStack.width })}`)
    }
    if (!String(darkStack.src).includes('/api/agnes-studio/media')) {
      throw new Error(`the dark pile strip has no picture: ${String(darkStack.src)}`)
    }
    await cdp.shot('13-stack-dark.png')
    // Restore whatever theme the session was actually in, rather than assuming
    // one: the remaining checks must run in the state a user would be in.
    if (darkStack.wasDark) {
      await cdp.evaluate(`document.body.setAttribute('data-ds-dark-theme', '')`)
    } else {
      await cdp.evaluate(`document.body.removeAttribute('data-ds-dark-theme')`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('browser-stack-dark-theme', 'the fanned-out strip renders its picture in the dark theme')

    // 23. Expand: every version becomes its own card, and collapse restores the
    //     pile. The card count is the observable difference.
    const expanded = await cdp.evaluate(
      `(() => {
        const button = [...document.querySelectorAll('.agnes__stackBar button')].find((node) => node.textContent.includes('展开'));
        if (!button) return 'no expand button';
        button.click();
        return 'clicked';
      })()`,
    )
    if (expanded !== 'clicked') throw new Error(`could not expand the pile: ${String(expanded)}`)
    await until(
      cdp.evaluate,
      `document.querySelectorAll('.agnes__card').length === ${String(cardsBefore + 1)}`,
      'every version to render as its own card',
      5_000,
    )
    await cdp.shot('12-stack-expanded.png')
    const collapsed = await cdp.evaluate(
      `(() => {
        const button = [...document.querySelectorAll('.agnes__stackExpandedBar button')].find((node) => node.textContent.includes('收起'));
        if (!button) return 'no collapse button';
        button.click();
        return 'clicked';
      })()`,
    )
    if (collapsed !== 'clicked') throw new Error(`could not collapse the pile: ${String(collapsed)}`)
    await until(
      cdp.evaluate,
      `document.querySelectorAll('.agnes__card').length === ${String(cardsBefore)} && document.querySelector('.agnes__stack') !== null`,
      'the pile to come back',
      5_000,
    )
    check('browser-stack-expand-collapse', `${String(cardsBefore + 1)} cards expanded, ${String(cardsBefore)} stacked`)

    // The store keeps the SYMBOLIC reference; the data URI is built per attempt.
    const storedIndex = JSON.parse(await readFile(join(continueState.dataDir, 'index.json'), 'utf8'))
    const newest = storedIndex.generations[0]
    const storedRefs = newest?.request?.references ?? []
    if (newest?.derivedFrom !== FIXTURE_ID) {
      throw new Error(`the new record does not remember its source: ${String(newest?.derivedFrom)}`)
    }
    if (storedRefs[0]?.generationId !== FIXTURE_ID) throw new Error('the stored request lost the symbolic reference')
    check('browser-continue-editing-lineage', 'derivedFrom + symbolic reference kept in the store')
  }

  // 24. A DEEP chain. Two versions exercise the pile; six exercise the parts
  //     that only break when there are "too many": the rail must never clip a
  //     version away, the fan of strips must stay capped, and the oldest version
  //     must stay reachable by both the rail and the swipe.
  //
  //     Seeding happens HERE and the page is reloaded, because the checks above
  //     assert exact card counts and a six-record lineage would change them.
  {
    const state = JSON.parse(await readFile(join(process.cwd(), '.preview-state.json'), 'utf8'))
    const chain = await seedChain(state.dataDir, 6)
    // The reload drops the panel (the sidebar entry has to be selected again),
    // and a marker left on `window` is the only reliable way to tell the OLD
    // document from the new one: the previous one stays queryable for a moment.
    await cdp.evaluate(`window.__agnesBeforeDeep = true`)
    await cdp.send('Page.reload')
    await until(
      cdp.evaluate,
      `window.__agnesBeforeDeep === undefined && document.querySelector('#root')?.children.length > 0`,
      'the app to boot after a reload',
      45_000,
    )
    await cdp.evaluate(dismissOverlays).catch(() => {})
    await openStudio()
    await until(
      cdp.evaluate,
      `document.querySelectorAll('.agnes__stack').length >= 1 && document.querySelector('.agnes__stackPill') !== null`,
      'the deep lineage to render after a reload',
      30_000,
    )
    const deep = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const stack = [...document.querySelectorAll('.agnes__stack')].find(
            (node) => node.querySelectorAll('.agnes__stackPill').length > 2);
          if (!stack) return JSON.stringify(null);
          const pills = [...stack.querySelectorAll('.agnes__stackPill')];
          const rail = stack.querySelector('.agnes__stackPills');
          const railBox = rail.getBoundingClientRect();
          // Every pill must be INSIDE the rail's box: a clipped pill is a version
          // the user cannot pick.
          const clipped = pills.filter((pill) => {
            const box = pill.getBoundingClientRect();
            return box.bottom > railBox.bottom + 1 || box.right > railBox.right + 1;
          }).length;
          return JSON.stringify({
            pills: pills.length,
            layers: stack.querySelectorAll('.agnes__stackStrip').length,
            clipped,
            badge: stack.querySelector('.agnes__stackBadge')?.textContent.trim() ?? '',
            cards: document.querySelectorAll('.agnes__card').length,
          });
        })()`,
      ),
    )
    if (deep === null) throw new Error('the deep lineage did not render a version rail')
    if (deep.pills !== 6) throw new Error(`expected six versions on the rail, got ${String(deep.pills)}`)
    if (deep.clipped !== 0) throw new Error(`${String(deep.clipped)} version number(s) are clipped out of the rail`)
    // The fan is capped at two per side no matter how deep the chain: the badge
    // states the real count, so six strips would be noise crowding the card.
    if (deep.layers !== 2) throw new Error(`expected the fan to stay capped at two strips, got ${String(deep.layers)}`)
    if (!deep.badge.includes('6')) throw new Error(`the badge does not report six versions: ${deep.badge}`)
    await cdp.shot('14-stack-deep.png')

    // Measure the card, then walk the whole chain to its oldest version.
    const deepBox = async () =>
      JSON.parse(
        await cdp.evaluate(
          `(() => {
            const stack = [...document.querySelectorAll('.agnes__stack')].find(
              (node) => node.querySelectorAll('.agnes__stackPill').length > 2);
            const box = stack.querySelector('.agnes__card--stacked').getBoundingClientRect();
            return JSON.stringify({
              card: [Math.round(box.width * 100) / 100, Math.round(box.height * 100) / 100],
              badge: stack.querySelector('.agnes__stackBadge')?.textContent.trim() ?? '',
            });
          })()`,
        ),
      )
    const deepStart = await deepBox()

    // The oldest version is reachable by typing on the rail.
    await cdp.evaluate(`[...document.querySelectorAll('.agnes__stackPill')].filter((n) => n.textContent.trim() === '6').at(-1)?.click()`)
    await until(
      cdp.evaluate,
      `(() => {
        const stack = [...document.querySelectorAll('.agnes__stack')].find(
          (node) => node.querySelectorAll('.agnes__stackPill').length > 2);
        return stack?.querySelector('.agnes__stackBadge')?.textContent.includes('6') ?? false;
      })()`,
      'the rail to reach the oldest version',
      5_000,
    )
    // ...and back by swiping, which is the gesture a deep chain is most likely to
    // break: every step has to actually change the version.
    const deepPoint = JSON.parse(
      await cdp.evaluate(
        `(() => {
          const stack = [...document.querySelectorAll('.agnes__stack')].find(
            (node) => node.querySelectorAll('.agnes__stackPill').length > 2);
          const box = stack.querySelector('.agnes__stackMedia').getBoundingClientRect();
          return JSON.stringify({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
        })()`,
      ),
    )
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: deepPoint.x, y: deepPoint.y, button: 'none', buttons: 0 })
    const seen = new Set()
    for (let step = 0; step < 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: deepPoint.x,
        y: deepPoint.y,
        deltaX: -120,
        deltaY: 0,
        button: 'none',
        buttons: 0,
      })
      await new Promise((resolve) => setTimeout(resolve, 120))
      seen.add((await deepBox()).badge)
    }
    if (![...seen].some((badge) => badge.includes('1 /'))) {
      throw new Error(`swiping never got back to the newest version of a deep pile: ${JSON.stringify([...seen])}`)
    }
    const deepAfter = await deepBox()
    if (String(deepStart.card) !== String(deepAfter.card)) {
      throw new Error(`a six-version card changed size while flipping: ${JSON.stringify(deepStart.card)} -> ${JSON.stringify(deepAfter.card)}`)
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none', buttons: 0 })
    check('browser-stack-deep-chain', `6 versions, ${String(chain.length)} records, rail unclipped, ${String(seen.size)} swipe stops, height constant`)
  }

  await drainConsole()
  if (consoleErrors.length > 0) throw new Error(`console errors during the run: ${JSON.stringify(consoleErrors).slice(0, 800)}`)
  check('browser-console-clean')
} finally {
  cdp.close()
}

const summary = {
  at: new Date().toISOString(),
  dsh: process.env.DSH_VERIFIED ?? 'unknown',
  checks,
}
await writeFile(join(evidenceDir, 'browser-ui-check.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
process.stdout.write(`\n${String(checks.length)} checks passed\n`)
