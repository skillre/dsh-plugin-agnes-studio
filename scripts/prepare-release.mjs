#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DETAIL_LAYER_KINDS, DISPLAY_CONTRACT_TEMPLATE_VERSION, REQUIRED_ARTIFACTS, validateDisplay } from './display-contract.mjs'

const root = process.cwd()
const artifactDirectory = join(root, 'release-artifact')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))

if (compatibility.schemaVersion !== 1) {
  throw new Error('compatibility.json schemaVersion must be 1')
}
if (compatibility.package !== manifest.name) {
  throw new Error('compatibility.json package must match package.json name')
}
if (!Array.isArray(compatibility.verified) || compatibility.verified.length === 0) {
  throw new Error('At least one verified DSH compatibility record is required before release')
}
for (const [index, record] of compatibility.verified.entries()) {
  const label = `compatibility.json verified[${index}]`
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${label} must be an object`)
  }
  if (typeof record.dsh !== 'string' || record.dsh === '') throw new Error(`${label}.dsh is required`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.verifiedAt ?? '')) {
    throw new Error(`${label}.verifiedAt must be an ISO date`)
  }
  if (record.result !== 'passed') throw new Error(`${label}.result must be passed`)
  if (
    !Array.isArray(record.checks) ||
    !record.checks.includes('dump-config') ||
    !record.checks.includes('bounded-startup')
  ) {
    throw new Error(`${label}.checks must include dump-config and bounded-startup`)
  }
}

// A Client package must carry real target-UI evidence in the record of the
// release being prepared (verified[0], newest first). Older records may
// document a DSH line verified before the UI pass existed, and the documented
// check vocabulary accepts the whole browser family: `browser`, `browser-*`
// and `web-ui-*` (see docs/evidence/compatibility-notes.md).
const BROWSER_CHECK = /^(?:browser(?:-|$)|web-ui-)/
if (manifest.dsh?.client !== undefined) {
  const newestChecks = Array.isArray(compatibility.verified[0]?.checks)
    ? compatibility.verified[0].checks
    : []
  if (
    !newestChecks.some(
      (check) => typeof check === 'string' && BROWSER_CHECK.test(check),
    )
  ) {
    throw new Error(
      'compatibility.json verified[0].checks must include a browser UI check ' +
        '(browser, browser-* or web-ui-*) for a Client package',
    )
  }
}

// A repository generated before the display contract was built against the
// README fallback, so its plugin page legitimately *is* the README. That is a
// migration to schedule, not a reason to block a release; every other half of
// the contract still applies to it. The fleet audit reports the same
// repositories, so the two never disagree about who has migrated.
const legacyDisplay = await isLegacyDisplay()

async function isLegacyDisplay() {
  try {
    const metadata = JSON.parse(await readFile(join(root, '.fleet-template.json'), 'utf8'))
    const version = String(metadata.templateVersion ?? '')
    const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10))
    const [floorMajor, floorMinor] = DISPLAY_CONTRACT_TEMPLATE_VERSION.split('.').map((part) => Number.parseInt(part, 10))
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
    return major < floorMajor || (major === floorMajor && minor < floorMinor)
  } catch {
    // No readable template metadata: hold the package to the full contract.
    return false
  }
}

await rm(artifactDirectory, { recursive: true, force: true })
await mkdir(artifactDirectory)
const packed = spawnSync(
  'npm',
  ['pack', '--json', '--ignore-scripts', '--pack-destination', artifactDirectory],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)
if (packed.error !== undefined) throw packed.error
if (packed.status !== 0) throw new Error(`npm pack exited ${packed.status ?? 'without status'}`)

const results = JSON.parse(packed.stdout)
if (!Array.isArray(results) || results.length !== 1 || typeof results[0]?.filename !== 'string') {
  throw new Error('npm pack must produce exactly one tarball')
}
const result = results[0]
const packedPaths = new Set((result.files ?? []).map((file) => file.path))
for (const required of ['package.json', 'compatibility.json', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts']) {
  if (!packedPaths.has(required)) throw new Error(`Release tarball is missing ${required}`)
}

// Display metadata is a published contract, and every way of getting it wrong
// fails silently in DSH: a missing locale dictionary degrades the card to the
// bare package name, a `meta.detail` that names an unpublished file raises
// `invalid` instead of falling back to the README, and an icon outside `files`
// leaves a default mark. This is the only place that judges them against the
// bytes that will actually be published.
{
  const display = await validateDisplay(root, { packedPaths, legacyReadmeFallback: legacyDisplay })
  for (const entry of display.warnings) {
    process.stderr.write(`prepare-release: WARN ${entry.message}\n`)
  }
  // Only the detail layer may be deferred by the legacy fallback. The card layer
  // and the whiteboard-registry rule are enforced for every package, so a
  // security-relevant finding never becomes a warning here.
  const problems = [
    ...new Set(
      display.errors
        .filter((entry) => !legacyDisplay || !DETAIL_LAYER_KINDS.includes(entry.kind))
        .map((entry) => entry.message),
    ),
  ]
  for (const entry of display.errors) {
    if (problems.includes(entry.message)) continue
    process.stderr.write(`prepare-release: WARN (deferred until migration) ${entry.message}\n`)
  }
  if (!legacyDisplay) {
    for (const artifact of REQUIRED_ARTIFACTS) {
      if (packedPaths.has(artifact)) continue
      if (problems.some((message) => message.startsWith(`${artifact}:`))) continue
      problems.push(`${artifact}: the tarball is missing it`)
    }
  }
  if (problems.length > 0) {
    // Remove the rejected tarball before failing: a `release-artifact/` left
    // behind by a failed gate is indistinguishable from a prepared one, and the
    // whole point of the gate is that nothing publishable survives it.
    await rm(artifactDirectory, { recursive: true, force: true })
    throw new Error(`Release tarball does not satisfy the display contract:\n  ${problems.join('\n  ')}`)
  }
}
await copyFile(join(root, 'CHANGELOG.md'), join(artifactDirectory, 'CHANGELOG.md'))
await writeFile(
  join(artifactDirectory, 'release.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      package: manifest.name,
      version: manifest.version,
      tag: `v${manifest.version}`,
      tarball: result.filename,
      integrity: result.integrity,
      shasum: result.shasum,
    },
    null,
    2,
  )}\n`,
)
process.stdout.write(`Prepared ${result.filename} without publishing it.\n`)
