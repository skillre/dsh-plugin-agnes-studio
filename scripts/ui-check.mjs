#!/usr/bin/env node
/**
 * One-command UI verification: clean profile in, evidence out.
 *
 * The browser check has three moving parts (an owned DSH Web profile, a headless
 * Chrome attached over CDP, and the driver script), and running them by hand
 * invites exactly the failure this script removes: reusing one profile across
 * runs, so notes from a previous attempt are still on the wall and every
 * "the wall has N notes" assertion becomes order-dependent.
 *
 * This boots a fresh owned profile, drives it, then tears everything down in a
 * `finally` — including the Chrome scratch directory — so each run starts from
 * the same empty wall and leaves nothing behind.
 *
 * Usage: node scripts/ui-check.mjs [path-to-tgz]
 *
 * Chrome is launched with --no-sandbox and its own --user-data-dir under the
 * platform temp dir because it cannot start under the file sandbox; that is a
 * local development harness concern, not part of the shipped plugin.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const chrome = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/**
 * Pick a free CDP port.
 *
 * A fixed port is a trap: another Chrome (another session's harness, a leftover
 * probe) can already hold it, and the driver then attaches to THAT browser and
 * reports failures that have nothing to do with this run. Binding :0 and asking
 * the OS for a free port removes the whole class of confusion.
 */
async function freePort() {
  if (process.env.CDP_PORT !== undefined) return process.env.CDP_PORT
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const chosen = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(String(chosen)))
    })
  })
}

const port = await freePort()
// Derive the tarball name from the manifest instead of hard-coding a version:
// a hard-coded one silently breaks the harness at the next release.
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const tarball = resolve(process.argv[2] ?? join(repo, `skillre-dsh-plugin-agnes-studio-${manifest.version}.tgz`))

if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME_BIN`)
if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`)

const scratch = await mkdtemp(join(await realpathTmp(), 'agnes-ui-check-'))
const children = []
const statePath = join(repo, '.preview-state.json')
const urlPath = join(repo, '.preview-url.txt')
const stopPath = join(repo, '.preview-stop')

/** Resolve the real temp root; `mkdtemp` on a symlinked tmpdir can fail. */
async function realpathTmp() {
  return realpath(tmpdir()).catch(() => tmpdir())
}

function launch(command, args, options) {
  const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  children.push(child)
  return child
}

/** Wait for a CDP endpoint to answer, up to `timeoutMs`. */
async function waitForCdp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return true
    } catch {
      // Not up yet.
    }
    await delay(500)
  }
  return false
}

let harness
let browser
let failure

try {
  for (const path of [statePath, urlPath, stopPath]) await rm(path, { force: true })

  // 1. Boot the owned profile and wait for the harness to publish its URL.
  harness = launch('node', [join(repo, 'scripts', 'ui-preview.mjs'), tarball], { cwd: repo })
  harness.stdout.on('data', (data) => process.stdout.write(`[harness] ${data}`))
  harness.stderr.on('data', (data) => process.stderr.write(`[harness] ${data}`))

  const urlDeadline = Date.now() + 120_000
  let url
  while (Date.now() < urlDeadline) {
    url = await readFile(urlPath, 'utf8').then((text) => text.trim()).catch(() => undefined)
    if (url !== undefined && url !== '') break
    await delay(1000)
  }
  if (url === undefined || url === '') throw new Error('the harness never published a launch URL')
  process.stdout.write(`profile ready: ${url.replace(/token=.*/, 'token=[redacted]')}\n`)

  // 2. Launch headless Chrome against that exact URL.
  browser = launch(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(scratch, 'chrome')}`,
    '--window-size=1440,900',
    url,
  ])
  browser.stderr.on('data', () => {})
  if (!(await waitForCdp())) throw new Error('Chrome never exposed a CDP endpoint')

  // 3. Drive the real UI.
  const driver = spawn('node', [join(repo, process.env.UI_DRIVER ?? 'scripts/ui-verify.mjs')], {
    cwd: repo,
    env: { ...process.env, CDP_PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  driver.stdout.on('data', (data) => { output += data.toString(); process.stdout.write(data) })
  driver.stderr.on('data', (data) => { output += data.toString(); process.stderr.write(data) })
  const code = await new Promise((res) => driver.once('close', res))
  if (code !== 0) throw new Error(`ui-verify exited ${code}`)
  if (!output.includes('checks passed')) throw new Error('ui-verify produced no summary line')
} catch (error) {
  failure = error
} finally {
  // Teardown order matters: signal the harness, then stop Chrome, then WAIT for
  // both, then delete only the scratch directory this run created.
  //
  // The harness deletes its owned DSH profile in its own `finally`. Signalling
  // it and immediately escalating to SIGKILL skips that cleanup and orphans a
  // whole profile directory under the platform temp root — which is exactly what
  // an earlier version of this script did (seven leaked profiles). So the stop
  // signal gets a real grace period, and the escalation only fires after the
  // process has had its chance.
  await writeFile(stopPath, 'stop\n', 'utf8').catch(() => {})
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  for (const child of children) {
    const exited = await Promise.race([
      new Promise((resolveExit) => child.once('close', () => resolveExit(true))),
      delay(30_000).then(() => false),
    ])
    if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await delay(1000)

  // Verify the harness actually cleaned its owned profile: it publishes the path
  // in .preview-state.json, and a leftover directory is a cleanup failure, not a
  // silent detail.
  const ownedPath = await readFile(statePath, 'utf8')
    .then((text) => JSON.parse(text).owned)
    .catch(() => undefined)
  if (typeof ownedPath === 'string' && existsSync(ownedPath)) {
    await rm(ownedPath, { recursive: true, force: true }).catch(() => {})
    const stillThere = existsSync(ownedPath)
    process.stdout.write(`cleanup: owned profile removed=${!stillThere}\n`)
    if (stillThere) failure ??= new Error(`owned profile could not be removed: ${ownedPath}`)
  } else {
    process.stdout.write('cleanup: owned profile removed=true\n')
  }
  for (const path of [stopPath, urlPath, statePath]) await rm(path, { force: true })
  await rm(scratch, { recursive: true, force: true })
  const scratchGone = !existsSync(scratch)
  process.stdout.write(`cleanup: scratch removed=${scratchGone}\n`)
  if (!scratchGone) failure ??= new Error('Chrome scratch directory could not be removed')
}

if (failure !== undefined) {
  process.stderr.write(`ui-check failed: ${failure.stack ?? failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('ui-check: passed\n')
}
