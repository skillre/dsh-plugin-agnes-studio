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

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  const heading = await until(
    cdp.evaluate,
    `(() => { const h = [...document.querySelectorAll('.agnes__title')][0]; return h ? h.textContent.trim() : null })()`,
    'the studio page heading',
  )
  check('browser-panel-renders', heading)

  const renderErrors = await drainConsole()
  if (renderErrors.length > 0) throw new Error(`the panel logged render errors: ${JSON.stringify(renderErrors).slice(0, 800)}`)
  check('browser-no-render-error')

  // 4. The panel reports configuration state rather than pretending to work.
  //    The state arrives from the Host after mount, so wait for it instead of
  //    sampling the DOM in the gap where neither branch has rendered yet.
  await until(
    cdp.evaluate,
    `document.querySelector('.agnes__notice') !== null || document.querySelector('.agnes__meta') !== null`,
    'the panel configuration state',
  )
  const configured = await cdp.evaluate(
    `(() => {
      const notice = document.querySelector('.agnes__notice');
      const meta = document.querySelector('.agnes__meta');
      return JSON.stringify({ notice: notice ? notice.textContent.slice(0, 80) : null, meta: meta ? meta.textContent.slice(0, 120) : null, submitDisabled: (() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('生成图片')); return b ? b.disabled : null })() });
    })()`,
  )
  const state = JSON.parse(configured)
  check('browser-config-state', state.notice ?? state.meta)
  await cdp.shot('02-panel-configured.png')

  // 5. The image form renders its controls, and its option sets come from the
  //    capability table (not from a hard-coded list in the component).
  const imageForm = await cdp.evaluate(
    `(() => {
      const selects = [...document.querySelectorAll('select.agnes__field')];
      const textarea = document.querySelector('textarea.agnes__field');
      return JSON.stringify({
        selects: selects.length,
        textarea: textarea !== null,
        options: selects.map((s) => [...s.options].map((o) => o.value)),
      });
    })()`,
  )
  const form = JSON.parse(imageForm)
  if (!form.textarea) throw new Error('the prompt textarea did not render')
  if (form.selects !== 3) throw new Error(`expected 3 image selects (model/size/ratio), got ${String(form.selects)}`)
  const sizes = form.options[1] ?? []
  if (sizes.join(',') !== '1K,2K,3K,4K') throw new Error(`unexpected image sizes: ${sizes.join(',')}`)
  check('browser-image-form-controls', `${String(form.selects)} selects`)

  // 6. Switch to the video tab: the size list must narrow to the model's real
  //    capability (Flash is 720P only), which is the behaviour the panel's whole
  //    design exists to guarantee.
  await cdp.evaluate(`(() => { const tab = [...document.querySelectorAll('[role="tab"]')].find((n) => n.textContent.includes('生视频')); tab?.click(); return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const videoForm = await cdp.evaluate(
    `(() => {
      const selects = [...document.querySelectorAll('select.agnes__field')];
      const byLabel = {};
      for (const select of selects) {
        const label = select.closest('label')?.textContent?.replace(select.textContent, '').trim() ?? '';
        byLabel[label] = [...select.options].map((o) => o.value);
      }
      return JSON.stringify(byLabel);
    })()`,
  )
  const videoOptions = JSON.parse(videoForm)
  const allSizes = Object.entries(videoOptions).find(([label]) => label.startsWith('分辨率'))?.[1] ?? []
  if (allSizes.join(',') !== '720P,1080P,1K,2K') throw new Error(`unexpected video sizes: ${allSizes.join(',')}`)
  check('browser-video-form-controls', allSizes.join('/'))

  // Narrowing: choose the Flash model and confirm the size list collapses.
  const narrowed = await cdp.evaluate(
    `(() => {
      const selects = [...document.querySelectorAll('select.agnes__field')];
      const modelSelect = selects.find((s) => [...s.options].some((o) => o.value === 'agnes-video-2.5-flash'));
      if (!modelSelect) return 'no model select';
      modelSelect.value = 'agnes-video-2.5-flash';
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return 'dispatched';
    })()`,
  )
  if (narrowed !== 'dispatched') throw new Error(`could not switch the video model: ${String(narrowed)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const narrowedSizes = await cdp.evaluate(
    `(() => {
      const selects = [...document.querySelectorAll('select.agnes__field')];
      const size = selects.find((s) => s.closest('label')?.textContent?.includes('分辨率'));
      return size ? [...size.options].map((o) => o.value).join(',') : 'missing';
    })()`,
  )
  if (narrowedSizes !== '720P') throw new Error(`Flash did not narrow the size list; got ${String(narrowedSizes)}`)
  check('browser-flash-narrows-sizes', String(narrowedSizes))
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
      return JSON.stringify({ disabled });
    })()`,
  )
  const guard = JSON.parse(submitGuard)
  if (guard.error !== undefined) throw new Error('the video submit button did not render')
  if (guard.disabled) {
    const notice = await cdp.evaluate(`document.querySelector('.agnes__notice') !== null`)
    if (!notice) throw new Error('the submit is disabled without an explanation on the panel')
    check('browser-submit-guarded-unconfigured', 'disabled + notice, no key in this run')
  } else {
    const promptWarning = await until(
      cdp.evaluate,
      `(() => { const el = document.querySelector('.agnes__errorBody'); return el ? el.textContent.trim() : null })()`,
      'the empty-prompt refusal',
    )
    check('browser-refuses-empty-prompt', String(promptWarning).slice(0, 40))
  }

  // 8. The gallery renders the seeded record as a grid card.
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
  if (!galleryState.grid) throw new Error('the seeded record did not render a result grid')
  if (galleryState.cards !== 1) throw new Error(`expected the one seeded card, got ${String(galleryState.cards)}`)
  if (galleryState.empty !== null) throw new Error('the gallery showed its empty state while holding a record')
  check('browser-gallery-card-grid', `${String(galleryState.cards)} card, ${galleryState.title}`)
  await cdp.shot('04-gallery-seeded.png')

  // 9. Theme: the panel must stay legible in both themes, which is why it uses
  //    inherited colour rather than a fixed palette.
  const themed = await cdp.evaluate(
    `(() => {
      const root = document.documentElement;
      const before = getComputedStyle(root).colorScheme || 'unset';
      root.classList.toggle('dark');
      const panel = document.querySelector('.agnes__title');
      const color = panel ? getComputedStyle(panel).color : null;
      root.classList.toggle('dark');
      return JSON.stringify({ before, color });
    })()`,
  )
  const themeState = JSON.parse(themed)
  if (themeState.color === null) throw new Error('the panel title lost its colour after a theme toggle')
  check('browser-theme-toggle', themeState.color)

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
      if (!open || !thumb || !image) return null;
      return JSON.stringify({
        openLabel: open.textContent.trim(),
        openTag: open.tagName,
        thumbTag: thumb.tagName,
        imgSrc: image.getAttribute('src'),
        imgComplete: image.complete,
        imgWidth: image.naturalWidth,
      });
    })()`,
    'the gallery card with its open control',
  )
  const cardState = JSON.parse(card)
  if (cardState.openTag !== 'BUTTON') throw new Error(`the open control must be a button, got ${String(cardState.openTag)}`)
  if (cardState.openLabel !== '打开原图') throw new Error(`unexpected open label: ${String(cardState.openLabel)}`)
  // The seeded PNG must have actually loaded through the authenticated media
  // route; a 401 would leave naturalWidth at 0 and the viewer would show nothing.
  if (cardState.imgWidth === 0) throw new Error('the gallery thumbnail did not load from the media route')
  check('browser-gallery-card', `${String(cardState.imgWidth)}px source`)
  // The card's action row sits below the fold in the default window, so the
  // evidence screenshot would show a thumbnail with no visible control. Scroll
  // the open button into view first; a screenshot that does not contain the
  // thing it claims to prove is not evidence.
  await cdp.evaluate(
    `(() => { document.querySelector('.agnes__open')?.scrollIntoView({ block: 'center' }); return true })()`,
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  await cdp.shot('06-gallery-card.png')

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

  // 16. The display metadata shipped in the package is what the plugin card reads.
  check('display-detail-image', 'docs/DETAIL*.md + docs/preview*.svg present in the packed tarball')

  await drainConsole()
  if (consoleErrors.length > 0) throw new Error(`console errors during the run: ${JSON.stringify(consoleErrors).slice(0, 800)}`)
  check('browser-console-clean')

  await cdp.shot('05-final.png')
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
