/**
 * Structural mirrors of the DSH Client contracts this bundle consumes.
 *
 * Queried from the live 0.2.2-rc.1 runtime on 2026-11-11:
 * - `ctx.slots` (from `@deepseek-ai/dsh-client-ui-renderer`'s SlotRegistry):
 *   `inject(slot, callback)` waits for a slot declaration, `register(options,
 *   component)` registers one entry through the caller's Fiber.
 * - `sidebar.panellist` is a `list` slot; its entry receives `{ size, active }`
 *   and selecting it dispatches the panel id to the keyed `main` slot.
 * - `main` is a `keyed` slot selected by `ctx.layout.selectPanel(key)`; its
 *   component receives no props, so the page owns its own data.
 * - `ctx.locale` (`@deepseek-ai/dsh-client-locale`): `register(ns, { zh, en })`,
 *   `bind(ns)`, `getSnapshot()` / `subscribe()`.
 * - `ctx.connection` (`@deepseek-ai/dsh-client-connection`):
 *   `rpc.call(channel, endpoint, payload, signal)` resolving
 *   `{ ok: true, value } | { ok: false, error }`.
 *
 * Mirrored rather than imported so this package does not pull the whole client
 * package graph into its own build. Re-query the live contracts before widening
 * this surface, and treat a mismatch as a compatibility finding.
 */

import type { ComponentType, ReactNode } from 'react'

/** One teardown callback returned by every registration. */
export type Disposer = () => void

/** Registration options shared by the list and keyed slots used here. */
export interface SlotRegisterOptions {
  /** Target slot name, e.g. `sidebar.panellist` or `main`. */
  readonly name: string
  /** Cell id for list slots; a fresh id is added beside the shipped entries. */
  readonly id?: string
  /** Panel key for keyed slots such as `main`. */
  readonly key?: string
  /** Ascending position among the entries. */
  readonly order?: number
  /** Display text where the owner projects one; a thunk follows the locale. */
  readonly label?: string | (() => string)
}

/** The slot registry face a Client plugin uses. */
export interface SlotsLike {
  /** Wait for a slot declaration, then run the registration callback. */
  inject(slot: string, callback: () => Disposer | readonly Disposer[]): Disposer
  /** Register one contribution; returns its disposer. */
  register<P>(options: SlotRegisterOptions, component: ComponentType<P> | ((props: P) => ReactNode)): Disposer
}

/** Current locale snapshot as `ctx.locale.getSnapshot()` returns it. */
export interface ClientLocaleSnapshot {
  /** Active locale id, e.g. `en` or `zh`. */
  readonly active: string
  /** Every declared locale definition. */
  readonly locales: readonly { readonly id: string }[]
  /** Bumped on every locale switch or dictionary registration. */
  readonly revision: number
}

/** The Client locale service face this bundle uses. */
export interface ClientLocaleLike {
  /** Read the current locale snapshot (stable reference between changes). */
  getSnapshot(): ClientLocaleSnapshot
  /** Observe locale switches and dictionary registrations. */
  subscribe(listener: () => void): Disposer
  /** Register one namespace dictionary for one or more locales. */
  register(namespace: string, locales: Record<string, Record<string, string>>): Disposer
  /** Bind a namespace to a translate function reading the active locale. */
  bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
}

/** The result envelope Connection's browser RPC caller resolves. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } }

/** The Client connection face this bundle uses. */
export interface ClientConnectionLike {
  readonly rpc: {
    call<T>(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<T>>
  }
}

/** The restricted Client context handed to a module's `apply`. */
export interface ClientContext {
  /** The slot registry service, a hard dependency of this module. */
  readonly slots: SlotsLike
  /** The locale service, a hard dependency of this module. */
  readonly locale: ClientLocaleLike
  /** The authenticated Host transport, a hard dependency of this module. */
  readonly connection: ClientConnectionLike
  /** Register a resource owned by this plugin's Fiber; returns its disposer. */
  effect(callback: () => Disposer | void, label?: string): Disposer
}

/** Props the sidebar entry receives from its slot. */
export interface SidebarEntryProps {
  /** Icon size hint the shell passes; `sm` is the collapsed rail. */
  readonly size?: 'sm' | 'md'
  /** Whether this panel is the selected one. */
  readonly active?: boolean
}
