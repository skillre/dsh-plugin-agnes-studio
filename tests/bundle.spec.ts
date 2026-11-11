/**
 * Tests the SHIPPED client bundle, not the source.
 *
 * This file exists because of a real defect: the source compiled correctly under
 * vitest (esbuild's automatic JSX transform) while `scripts/build-client.mjs`
 * emitted classic `React.createElement` with no `React` binding, so the packaged
 * `lib/client.js` threw `ReferenceError: React is not defined` on first render.
 * `apply` still succeeded, so mounting, route registration, `--dump-config` and
 * bounded startup all passed — every green signal except the one that mattered.
 *
 * So these tests load the built artifact, drive it through the loader envelope
 * the shell uses, and actually render both registered surfaces. A future
 * JSX-config drift fails here instead of in a user's sidebar.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(repo, 'lib', 'client.js')
const require = createRequire(import.meta.url)

/** The baseline modules the shell's PLATFORM_MODULES seed table provides. */
function platformRequire(spec: string): unknown {
  if (spec === 'react') return require('react')
  if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
  throw new Error(`bundle requested a module outside the platform seed: ${spec}`)
}

/** Load the shipped bundle through the real `window.__ModuleLoader__` envelope. */
function loadShippedBundle(): { exports: Record<string, unknown>; requested: string[] } {
  const code = readFileSync(bundlePath, 'utf8')
  const requested: string[] = []
  let factory: ((req: (spec: string) => unknown) => Record<string, unknown>) | undefined
  const window = { __ModuleLoader__: { load: (registration: { factory: typeof factory }) => {
    factory = registration.factory
  } } }
  // The bundle is a browser script that assigns through `window`; evaluating it
  // with that object reproduces the loader's environment without a DOM.
  new Function('window', code)(window)
  if (factory === undefined) throw new Error('bundle did not register a factory')
  const exports = factory((spec) => {
    requested.push(spec)
    return platformRequire(spec)
  })
  return { exports, requested }
}

/** The smallest Client context the bundle's `apply` needs. */
function fakeContext() {
  const registrations: Array<{ slot: string; options: Record<string, unknown>; component: (props: unknown) => unknown }> = []
  const ctx = {
    slots: {
      inject: (_slot: string, callback: () => unknown) => {
        callback()
        return () => undefined
      },
      register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
        registrations.push({ slot: String(options['name'] ?? options['id']), options, component })
        return () => undefined
      },
    },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
      subscribe: () => () => undefined,
    },
    connection: {
      rpc: {
        call: async () => ({
          ok: true,
          value: {
            state: { configured: true, keySource: 'credential', baseUrl: '', upstreamModels: [], generations: [] },
          },
        }),
      },
    },
    effect: (callback: () => unknown) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
  }
  return { ctx, registrations }
}

describe('shipped client bundle', () => {
  it('is built before this test runs', () => {
    // `npm test` runs `build:client` first; a missing artifact would otherwise
    // silently skip the only check that matters.
    expect(existsSync(bundlePath)).toBe(true)
  })

  it('registers a factory under the package id', () => {
    const code = readFileSync(bundlePath, 'utf8')
    expect(code).toContain('window.__ModuleLoader__.load({')
    expect(code).toContain('"@skillre/dsh-plugin-agnes-studio"')
  })

  it('never emits a bare React.createElement reference', () => {
    // The exact defect: classic JSX transform without a `React` binding.
    const code = readFileSync(bundlePath, 'utf8')
    expect(code).not.toContain('React.createElement')
  })

  it('requests only modules the platform seed table provides', () => {
    const { requested } = loadShippedBundle()
    const unique = [...new Set(requested)].sort()
    expect(unique.every((spec) => spec === 'react' || spec === 'react/jsx-runtime')).toBe(true)
  })

  it('applies and registers the sidebar entry and the studio page', () => {
    const { exports } = loadShippedBundle()
    const apply = exports['apply']
    expect(typeof apply).toBe('function')
    const { ctx, registrations } = fakeContext()
    ;(apply as (context: unknown) => void)(ctx)
    expect(registrations.map((entry) => entry.slot)).toEqual(['sidebar.panellist', 'main'])
  })

  it('RENDERS both registered surfaces without throwing', () => {
    // This is the assertion the old suite lacked: a render, not a registration.
    const { exports } = loadShippedBundle()
    const { ctx, registrations } = fakeContext()
    ;(exports['apply'] as (context: unknown) => void)(ctx)
    expect(registrations).toHaveLength(2)
    for (const registration of registrations) {
      let rendered: unknown
      expect(() => {
        rendered = registration.component({ size: 'md' })
      }, `${registration.slot} must render`).not.toThrow()
      expect(rendered, `${registration.slot} returned nothing`).toBeTypeOf('object')
    }
  })
})
