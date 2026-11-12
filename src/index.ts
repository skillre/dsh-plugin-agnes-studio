/**
 * Host entry of Agnes Studio.
 *
 * Ownership split: this half owns the API key resolution, the generation store,
 * the upstream calls and the two Connection routes; the Client half owns only
 * view state (which tab, the form draft, the in-flight spinner). Everything
 * registered here belongs to this plugin's Fiber, so stopping or updating the row
 * releases the routes, the tools and the store handle with no residue.
 *
 * Key resolution order, per operation rather than cached at mount, so a rotated
 * key reaches the next request without a restart:
 * 1. the DSH credentials service record named by `credentialRef`;
 * 2. the environment variable named by `apiKeyEnv`;
 * 3. nothing — reported as `not-configured`, never as an empty Bearer token.
 */

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { Config, resolveConfig, resolveDataDir } from './config.js'
import type { StudioConfig } from './config.js'
import { notConfigured } from './errors.js'
import { createRuntime, type KeyResolver } from './runtime.js'
import { openStore } from './store.js'
import { createExecuteRoute, createMediaRoute } from './transport.js'
import type { HostConnection } from './transport.js'
import { registerAgentTools } from './tools.js'
import { LIMITS } from './types.js'
import type { KeySource } from './types.js'

export { Config, resolveConfig }
export { createRuntime } from './runtime.js'
export { openStore } from './store.js'
export { createClient, buildImageBody, buildVideoBody, validateRequest, sniffMediaType } from './agnes.js'
export { StudioError } from './errors.js'
export const name = 'skillre-agnes-studio'

/**
 * Required services. `connection` provides the authenticated Client routes; it
 * is a hard dependency so a profile without it fails loudly instead of mounting
 * a panel that can never be reached.
 */
export const inject = ['connection']

/** Read an optional Cordis service without declaring it required. */
function service<T>(ctx: Context, key: string): T | undefined {
  return ctx.get(key) as T | undefined
}

/** The credential service face this plugin uses. */
interface Credentials {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

/** The attachment service face the image tool uses. */
interface Attachments {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

/**
 * Build the key resolver for one configuration.
 *
 * The credentials service is consulted first because it is the managed store a
 * user can write through the GUI; the environment is the documented fallback for
 * a headless profile. A blank value counts as absent at both layers, so a stray
 * empty variable cannot masquerade as a configured key.
 */
export function createKeyResolver(config: StudioConfig, credentials: Credentials | undefined, env: NodeJS.ProcessEnv): KeyResolver {
  return async () => {
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(config.credentialRef)
        if (resolved !== undefined && resolved.value.trim() !== '') {
          return { key: resolved.value.trim(), source: 'credential' as KeySource }
        }
      } catch {
        // A failing credential store must not hide a working environment key.
      }
    }
    const fromEnv = env[config.apiKeyEnv]?.trim()
    if (fromEnv !== undefined && fromEnv !== '') return { key: fromEnv, source: 'environment' as KeySource }
    throw notConfigured()
  }
}

/** Whether a resolved key exists, without leaking the value. */
async function configured(resolve: KeyResolver): Promise<boolean> {
  try {
    const resolved = await resolve()
    return resolved.key !== ''
  } catch {
    return false
  }
}

export function apply(ctx: Context, rawConfig: Partial<StudioConfig> = {}): void {
  const config = resolveConfig(rawConfig)
  const connection = service<HostConnection>(ctx, 'connection')
  if (!connection?.fetch?.register) throw new Error('Agnes Studio requires the current DSH Connection exact Fetch-route registry.')

  const credentials = service<Credentials>(ctx, 'credentials')
  const resolveKey = createKeyResolver(config, credentials, process.env)
  const dataDir = resolveDataDir(config.dataDir, process.env, homedir())

  // The store opens lazily: a storage failure is reported on the first request
  // instead of preventing the plugin from mounting at all.
  const storeReady = openStore(dataDir, config.historyLimit)
  storeReady.catch((error: unknown) => {
    ctx.logger?.error?.(`agnes-studio: could not open the generation store: ${error instanceof Error ? error.message : String(error)}`)
  })

  const runtime = createRuntime({
    store: {
      // Delegate to the opened store; every method awaits the same promise so a
      // failed open surfaces once, at the first real call.
      list: async () => (await storeReady).list(),
      append: async (generation, bytes, mediaType) => (await storeReady).append(generation, bytes, mediaType),
      remove: async (id) => (await storeReady).remove(id),
      clear: async () => (await storeReady).clear(),
      readMedia: async (id) => (await storeReady).readMedia(id),
      mediaPath: async (id) => (await storeReady).mediaPath(id),
    },
    baseUrl: config.baseUrl,
    resolveKey,
    imageTimeoutMs: config.imageTimeoutMs,
    videoTimeoutMs: config.videoTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    maxMediaBytes: LIMITS.maxMediaBytes,
    retryAttempts: config.retryAttempts,
    retryBaseDelayMs: config.retryBaseDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs,
  })

  // A missing key is a configuration state the panel explains, not a mount
  // failure: the plugin must mount so the user can see WHY it cannot generate.
  void configured(resolveKey).then((ready) => {
    if (!ready) ctx.logger?.info?.('agnes-studio: no Agnes API key configured yet; the panel will show how to set it.')
  })

  ctx.effect(() => connection.fetch.register(createExecuteRoute(runtime)), 'skillre-agnes-studio client route')
  ctx.effect(() => connection.fetch.register(createMediaRoute(runtime)), 'skillre-agnes-studio media route')

  // Background jobs belong to this Fiber: stopping or updating the plugin row
  // must abort them instead of leaving detached fetches running against a
  // registry nothing can reach any more.
  ctx.effect(() => () => runtime.dispose(), 'skillre-agnes-studio background jobs')

  if (config.enableTools) {
    registerAgentTools(ctx, runtime, () => service<Attachments>(ctx, 'attachments'))
  }
}
