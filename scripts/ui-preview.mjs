#!/usr/bin/env node
/**
 * Long-running owned test profile for the browser UI check.
 *
 * It creates one owned, disposable DSH home, installs the packed tarball, boots
 * the real Web app, writes the authenticated launch URL to `url.txt`, and then
 * waits for `stop` to appear before stopping everything and deleting the owned
 * root. The caller drives the browser against `url.txt` and then creates `stop`.
 *
 * This is a temporary development harness: it never touches a user profile.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { seedTwoImageGenerations } from './seed-fixture.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const cli = process.env.DSH_TEST_CLI || 'dsh'
const tarball = resolve(process.argv[2] || join(repo, `skillre-dsh-plugin-agnes-studio-${manifest.version}.tgz`))
const owned = await mkdtemp(join(await realpath(tmpdir()), 'dsh-agnes-studio-ui-'))
const home = join(owned, 'home')
const work = join(owned, 'work')
const profile = `agnes-studio-ui-${owned.slice(-6)}`
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_AGENTS_HOME: join(home, 'agents'),
  DSH_PROFILE: profile,
  DSH_PROFILE_DIR: join(home, 'profiles', profile),
  DSH_TELEMETRY_DISABLED: '1',
  npm_config_cache: join(owned, 'npm-cache'),
  npm_config_store_dir: join(owned, 'pnpm-store'),
}
const strip = (text) => text.replace(/\u001b\[[0-9;]*m/g, '')

function run(args, timeoutMs = 120000) {
  const child = spawn(cli, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  child.stdout.on('data', (data) => { text += data.toString() })
  child.stderr.on('data', (data) => { text += data.toString() })
  const closed = new Promise((res) => child.once('close', (code) => res(code)))
  const deadline = delay(timeoutMs).then(() => { child.kill('SIGKILL'); throw new Error(`timeout: dsh ${args.join(' ')}`) })
  return Promise.race([closed, deadline]).then((code) => {
    if (code !== 0) throw new Error(`dsh ${args.join(' ')} exited ${code}: ${strip(text).slice(-3000)}`)
    return strip(text)
  })
}

let app
async function shutdown() {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM')
    await Promise.race([new Promise((res) => app.once('close', res)), delay(3000)])
    if (app.exitCode === null) app.kill('SIGKILL')
  }
  // Wait for the child to actually be reaped before deleting its home.
  //
  // A single `rm -rf` raced the dying process once and left a re-created
  // `home/storages/...` directory behind: DSH flushed a session cache file after
  // the removal had walked past it. The leftover survived into the next run and
  // looked like a leaked profile. Retry the removal until the tree is really
  // gone, and fail loudly if it never is.
  await delay(1000)
  try {
    const marker = await readFile(join(owned, '.owned'), 'utf8')
    if (marker.trim() !== owned) throw new Error('owned marker mismatch')
    let removed = false
    for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
      await rm(owned, { recursive: true, force: true })
      removed = !existsSync(owned)
      if (!removed) await delay(500)
    }
    if (!removed) throw new Error(`owned root survived removal: ${owned}`)
    process.stdout.write(`cleaned ${owned}\n`)
  } catch (error) {
    process.stderr.write(`cleanup failed: ${error.message}\n`)
    process.exitCode = 1
  }
}

try {
  await writeFile(join(owned, '.owned'), owned, { flag: 'wx', mode: 0o600 })
  await mkdir(home)
  await mkdir(work)
  await run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  await run(['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts', '--store-dir', join(owned, 'pnpm-store')])
  const dump = await run(['--profile', profile, '--dump-config'])
  if (!dump.includes('skillre-agnes-studio')) throw new Error('bundle row did not compose')

  // Seed one finished image generation so the driver can exercise the gallery
  // card and its viewer without calling the live Agnes API. The bundle's default
  // `dataDir` is empty, which the Host resolves to `$DSH_HOME/agnes-studio`; this
  // harness sets DSH_HOME, so the fixture lands inside the owned root and is
  // deleted with it. Seeding before boot means the panel's first `state` call
  // already sees the record, so the driver never races a late write.
  const dataDir = join(home, 'agnes-studio')
  const seeded = await seedTwoImageGenerations(dataDir)
  process.stdout.write(`seeded ${seeded.first.id} + ${seeded.second.id} (${String(seeded.first.asset.bytes)} bytes each) into ${dataDir}\n`)

  app = spawn(cli, ['--profile', profile, '--port', '0', '--no-open'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  const append = (data) => { text += data.toString() }
  app.stdout.on('data', append)
  app.stderr.on('data', append)
  const url = await new Promise((res, rej) => {
    const deadline = setTimeout(() => rej(new Error(`no launch URL: ${strip(text).slice(-3000)}`)), 40000)
    const inspect = () => {
      const match = strip(text).match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"<>]*[?&]token=[^\s"<>]+/)
      if (match) { clearTimeout(deadline); res(match[0]) }
    }
    app.stdout.on('data', inspect)
    app.stderr.on('data', inspect)
    app.once('close', (code) => { clearTimeout(deadline); rej(new Error(`app exited ${code}: ${strip(text).slice(-3000)}`)) })
    inspect()
  })
  await writeFile(join(repo, '.preview-url.txt'), `${url}\n`, 'utf8')
  await writeFile(
    join(repo, '.preview-state.json'),
    `${JSON.stringify(
      {
        owned,
        profile,
        url: url.replace(/token=[^&]+/, 'token=[redacted]'),
        dataDir,
        // The driver asserts against this exact record, so it must not guess the id.
        fixtureId: seeded.first.id,
        secondFixtureId: seeded.second.id,
        fixtureBytes: seeded.first.asset.bytes,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  process.stdout.write(`ready: ${profile} (url written)\n`)
  while (true) {
    if (await readFile(join(repo, '.preview-stop'), 'utf8').then(() => true, () => false)) break
    await delay(1000)
  }
} catch (error) {
  process.stderr.write(`harness failed: ${error.stack ?? error}\n`)
  process.exitCode = 1
} finally {
  await shutdown()
}
