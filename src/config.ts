/**
 * Plugin configuration.
 *
 * Schemastery is the loader-facing schema: DSH resolves a row's `config` through
 * it before `apply` runs, so every tunable value has a declared default and an
 * out-of-range value fails loudly at mount time instead of surfacing later as a
 * confusing HTTP error.
 *
 * The API key is deliberately NOT a config field: it is a secret, so it is read
 * through the credentials service (or the documented environment variable) at
 * each operation, which also means a rotated key takes effect without a restart.
 */

import Schema from '@deepseek-ai/schemastery'

/** Effective plugin configuration after schema resolution. */
export interface StudioConfig {
  /** Base URL of the Agnes API, without a trailing slash. */
  baseUrl: string
  /** Credential reference name resolved through `ctx.credentials`. */
  credentialRef: string
  /** Environment variable consulted when the credential store is empty. */
  apiKeyEnv: string
  /**
   * Directory holding the generation index and generated media.
   *
   * Empty means "follow the DSH home", resolved at mount time from `DSH_HOME`.
   * A hard-coded `~/.dsh` default would escape an isolated or alternate DSH
   * home — which is exactly how a test profile ends up writing into the user's
   * real data directory, or failing because that path is outside its sandbox.
   */
  dataDir: string
  /** Register the `agnes_image` and `agnes_video` model tools. */
  enableTools: boolean
  /** How many generations to keep; older ones are evicted. */
  historyLimit: number
  /** Image generation timeout in milliseconds. */
  imageTimeoutMs: number
  /** Whole video-task timeout in milliseconds, including queue wait. */
  videoTimeoutMs: number
  /** Poll interval for video tasks in milliseconds. */
  pollIntervalMs: number
}

/** The schema DSH resolves a `skillre-agnes-studio` row's config through. */
export const Config: Schema<StudioConfig> = Schema.object({
  baseUrl: Schema.string().default('https://apihub.agnes-ai.com/v1'),
  credentialRef: Schema.string().default('AGNES_API_KEY'),
  apiKeyEnv: Schema.string().default('AGNES_API_KEY'),
  dataDir: Schema.string().default(''),
  enableTools: Schema.boolean().default(true),
  historyLimit: Schema.number().min(10).max(1000).step(1).default(200),
  imageTimeoutMs: Schema.number().min(10_000).max(600_000).step(1000).default(360_000),
  videoTimeoutMs: Schema.number().min(30_000).max(1_800_000).step(1000).default(900_000),
  pollIntervalMs: Schema.number().min(500).max(15_000).step(100).default(2000),
})

/** Resolve raw row config, keeping the declared defaults authoritative. */
export function resolveConfig(raw: unknown = {}): StudioConfig {
  // Schemastery fills every declared default, so the resolved value always
  // carries the full shape; the cast states that instead of re-declaring it.
  const resolved = Config(raw as StudioConfig) as StudioConfig
  return { ...resolved, baseUrl: resolved.baseUrl.replace(/\/+$/, '') }
}

/** Expand a leading `~` against the user's home directory. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
  return path
}

/**
 * Resolve the data directory for one deployment.
 *
 * Order: an explicit `dataDir` wins; otherwise the directory follows `DSH_HOME`
 * when the harness sets it, and only then falls back to `~/.dsh`. Following the
 * harness home is what keeps an isolated profile's data inside that profile
 * instead of in the user's real installation.
 */
export function resolveDataDir(configured: string, env: NodeJS.ProcessEnv, home: string): string {
  if (configured.trim() !== '') return expandHome(configured.trim(), home)
  const dshHome = env['DSH_HOME']?.trim()
  if (dshHome !== undefined && dshHome !== '') return `${dshHome.replace(/\/+$/, '')}/agnes-studio`
  return `${home}/.dsh/agnes-studio`
}
