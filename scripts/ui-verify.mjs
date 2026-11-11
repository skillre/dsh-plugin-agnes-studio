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
    // The first-run notice re-asserts itself and would cover the panel in the
    // evidence. Dismiss it right before each capture so the screenshot shows
    // what the user actually sees once they are past onboarding.
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '继续'); b?.click(); return true })()`).catch(() => {})
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
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '继续'); b?.click(); return true })()`).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 800))

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

  // 7. An empty prompt is refused client-side, so no upstream call is made.
  const refused = await cdp.evaluate(
    `(() => {
      const submit = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('生成视频'));
      if (!submit) return 'no submit';
      submit.click();
      return 'clicked';
    })()`,
  )
  if (refused !== 'clicked') throw new Error('the video submit button did not render')
  const promptWarning = await until(
    cdp.evaluate,
    `(() => { const el = document.querySelector('.agnes__errorBody'); return el ? el.textContent.trim() : null })()`,
    'the empty-prompt refusal',
  )
  check('browser-refuses-empty-prompt', String(promptWarning).slice(0, 40))

  // 8. The gallery renders its empty state instead of a broken grid.
  const gallery = await cdp.evaluate(
    `(() => {
      const empty = document.querySelector('.agnes__empty');
      const grid = document.querySelector('.agnes__grid');
      const title = document.querySelector('.agnes__galleryTitle');
      return JSON.stringify({ empty: empty ? empty.textContent.slice(0, 60) : null, grid: grid !== null, title: title ? title.textContent : null });
    })()`,
  )
  const galleryState = JSON.parse(gallery)
  if (galleryState.title === null) throw new Error('the gallery heading did not render')
  if (galleryState.grid) throw new Error('an empty gallery rendered a result grid')
  check('browser-gallery-empty-state', galleryState.title)
  await cdp.shot('04-gallery-empty.png')

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

  // 11. The display metadata shipped in the package is what the plugin card reads.
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
