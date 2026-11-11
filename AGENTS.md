# AGENTS.md — dsh-plugin-agnes-studio

## Repository identity

- GitHub: `skillre/dsh-plugin-agnes-studio`
- npm: `@skillre/dsh-plugin-agnes-studio`
- Fleet slug: `agnes-studio`
- Initial DSH observation: `0.2.2-rc.1` on `2026-11-11`
- Status: experimental

This repository is an independent Git and npm release unit. Its parent fleet instructions are not automatically inherited because this repository's `.git` is the project root; this file is therefore self-contained.

## Dynamic discovery is mandatory

The repository template is only an engineering shell. It does not define the current DSH business API.

Before using any Service, Event, Builtin, Tool, Slot, Theme token, current page prop, or Host/Client bridge:

1. Load `cordis-plugin-development` when available.
2. Call `cordis_inspect_list` against the current runtime.
3. Query the exact required contract with `cordis_inspect_query`.
4. Decide Host, Client, or both from the data owner.
5. Validate uncertain behavior as a temporary creation-mode Plugin.
6. Promote verified behavior into native TypeScript and tests.

Never copy a complete API from another plugin, old README, recipe, declaration, or template. Never use Inspect output as runtime business data.

For Cordis composition or preset work, load `editing-cordis-compositions` when available; otherwise verify the target-version composition documentation and schema before editing. Never edit shipped DSH presets or the shipped installation.

## Native package constraints

- Preserve the package, repository, row, and Cordis plugin names after first public release.
- Keep the package ESM and its bundle patch at `cordis.patch.yml`.
- Ensure `package.json#dsh.bundle.patch` points to a file included by `files`; publish only built runtime/declaration files, the patch, `compatibility.json`, the `locale/` dictionaries, the icon, README/uninstall guidance, and license.
- Declare `engines.dsh` and keep it honest: it is the machine-readable statement of the DSH lines this package was really mounted and tested against. A SemVer range is documentation, not evidence; re-verify on each new DSH line instead of widening the range.
- Row IDs are fleet-global and start with `skillre-`.
- Declare only actual dependencies. Keep identity-sensitive Cordis/DSH APIs as peers when required and mirror them in devDependencies.
- Do not commit `file:`, `link:`, or `workspace:` dependency specifications.
- Standalone TypeScript relative imports use explicit `.js` specifiers unless the build configuration deliberately establishes another tested rewrite rule.
- Required Cordis services use `inject`; optional services use `ctx.get()` and handle absence.
- Every side effect must belong to the current Fiber and be removed on stop/update.
- Host↔Client boundaries carry only minimal lossless JSON.
- Do not add Client structure from memory; query the current Client contract and then add the required build/export manifest deliberately.

## Release authority

This repository is published through the reviewed OIDC workflow (`.github/workflows/release.yml`)
with npm Trusted Publishing. Never store an npm token, and never run `npm publish` from a local
checkout.

An agent may **dispatch** that workflow after explicit human authorization:

```sh
DSH_RELEASE_AUTHORIZATION="@skillre/dsh-plugin-agnes-studio@<version> authorized by <name>" \
  npm run release:dispatch -- agnes-studio
```

Dispatch is not publication: the protected `npm-publish` environment still needs a human reviewer.
The dispatch preflight refuses unless the worktree is clean, the branch is `main`, HEAD matches
`origin/main`, the update-readiness audit is clean, and `compatibility.json` carries a real
`dump-config` + `bounded-startup` record for the mounted DSH line.

## Update readiness is a hard requirement

A user must be able to open the plugin card and get a **Versions** section with one-click in-place
update. The DSH plugin manager grants that only to a bundle installed from a **registry spec under
its own name** that declares a valid SemVer version, ships its bundle patch, carries no protected
management row, and accepts the running DSH line.

Non-negotiable consequences for this repository:

- **Publish to npm.** `github:`, `git+`, `file:`, absolute paths and tarballs are never updatable in
  place. The registry is the delivery channel, not an option.
- Keep `publishConfig.access: "public"` and never set `private: true`; npm refuses those publishes.
- Never declare a protected management row in `cordis.patch.yml`
  (`@deepseek-ai/dsh-plugin-manager`, `@deepseek-ai/dsh-plugin-manager/tools`,
  `@deepseek-ai/cordis-plugin-loader`, `@deepseek-ai/cordis-plugin-include`,
  `@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-client-modules`,
  and the plugin-inventory / typert / remotes rows). A bundle that ships one becomes unremovable and
  loses its update path. Consuming the `pluginManager` service is fine; publishing those rows is not.
- Keep `engines.dsh` honest and wide enough for the DSH line you actually mount. An update target is
  refused with `incompatible-version` when its own `engines.dsh` or DSH peers reject the runtime.
  DSH judges this with `includePrerelease`, so `>=0.2.0-rc.2 <0.3.0` does accept `0.2.2-rc.1`.
- Do not add `scripts.prepare`; it only exists for raw Git installs, which are not updatable.

`npm run check` enforces the repository-side half through the fleet audit; the remaining half is a
user action (installing from the npm package spec instead of a Git URL).

## Display contract

The plugin detail page is a **picture**, not the README. Keep the three layers separate:

- `locale/en.json` and `locale/zh.json` carry `meta.title`, a one-sentence `meta.description`
  (<= 120 characters, plain text) and `meta.detail`;
- `docs/DETAIL.md` / `docs/DETAIL.zh.md` hold exactly one `![alt](preview*.svg)` line and nothing else;
- `README.md` / `README.en.md` keep the install, configuration, compatibility and limitation detail.

The preview image is edited on a **Feishu whiteboard** and exported into `docs/preview.svg` /
`docs/preview.zh.svg`; `docs/PREVIEW.md` records each language's board. `npm run check` runs
`node scripts/preview.mjs check`, which enforces the fixed 640x300 banner ratio, the 500 KiB budget
and the parser element set. Never replace the picture with prose, and never let `meta.detail` fall
back to the README by leaving it unset.

## Development workflow

1. Define goal, non-goals, permissions and data owner.
2. Inspect current contracts and record only the minimum used.
3. Prototype dynamically where useful.
4. Implement native TypeScript.
5. Add behavior, error and lifecycle tests.
6. Run `npm run check`.
7. Pack and temporarily install the tarball through an owned, disposable non-Desktop DSH profile; verify mounting and bounded startup.
8. In `finally`-style cleanup, stop the test process and uninstall the test bundle or remove only the confirmed owned test profile; verify no test install remains, even after failure.
9. Update README, compatibility evidence and a Changeset.
10. Request independent review, then hand the install source to the user without installing it in their profile.

`link:` deployment is **forbidden**. Never install a plugin into a DSH profile by symlinking or
`link:`-ing its source directory, and never add `file:`, `link:`, or `workspace:` specs to a
manifest. A source link makes the plugin resolve its own `node_modules` instead of the host's,
which silently hides API drift between the plugin and the running DSH: everything looks green
locally while a packed install aborts the whole profile boot. Pack a tarball and install that
into an isolated profile — that is the only supported **development-test** install path, not final delivery.

## Installation ownership and cleanup

- Development installs are temporary. Before a packed-tarball test, record ownership and a cleanup plan; after testing (including errors), stop test processes, remove only test-created bundle/dependency/selection/config entries or the confirmed owned isolated profile, and verify their absence. Never leave an agent-installed plugin in the user's DSH at handoff.
- Electron owns the `desktop` profile; do not use CLI `--profile desktop` as a substitute. A test install in a user's actual Desktop Client or Web UI profile requires prior user approval, a baseline inventory and a reversible plan. Preserve all preexisting plugins and data; only undo this test's changes and verify the prior state. If complete restoration cannot be verified, disclose the residue and do not claim delivery is complete.
- Final installation, update and enablement are the user's decision in the Desktop Client or Web UI **Plugins** manager. After cleanup give the user the supported source and steps; never run CLI, an agent plugin manager or a profile edit to install/enable it for the user. Check the target manager and artifact before presenting an npm package spec, an absolute local built-package/tarball path, or a GitHub URL as usable. Raw Git requires a safe, documented, self-contained `prepare` build; a `file:` dependency in a manifest is not a user-entered local installation address.

## Subagents

For independent work, prefer background subagents using `opencode-go-dsv41/deepseek-flash` at `max` effort.

- One writing agent owns this repository per wave by default.
- Parallel writers require separate Git worktrees and non-overlapping paths.
- The parent/integrator owns package exports, dependency changes, bundle composition and final verification.
- A separate read-only agent reviews the completed diff.
- Do not run concurrent installs against this lockfile.

Every handoff includes files changed, tests run, result, risks and follow-ups.

## Remote and release authority

Without a new direct human instruction, agents MUST NOT:

- push;
- open or merge pull requests;
- create tags or GitHub Releases;
- publish or deprecate npm versions;
- alter Trusted Publisher, Environment, repository protection or credentials.

Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `_authToken`, private keys, login output, or real secrets to any file or workflow. Follow `RELEASING.md`; release preparation must consume real `compatibility.json` evidence and keep source/dependency execution outside the OIDC job.

Lifecycle status is fleet-owned. When proposing `experimental`, `active`, `maintenance`, `deprecated`, or `archived` changes, report the requested transition to the fleet parent/maintainer so it can update `plugins.json`, npm deprecation state, README and GitHub repository state consistently; do not edit a parent checkout implicitly.

## Verification

During implementation:

```sh
npm run typecheck
npm test
```

Before review:

```sh
npm run check
```

Before release, additionally verify the generated tarball in a fresh, non-Desktop DSH profile with `--dump-config` and a bounded real startup, then clean it up and verify removal. UI changes require a real check in the target UI: Electron Desktop Client for Desktop delivery, the existing DSH Web application for Web UI delivery. Neither is a substitute for the other; actual-profile test installs require the approval and cleanup safeguards above.

Compatibility claims are based on real mount tests, not peer-range satisfaction alone. Record the exact DSH version and verification date in `compatibility.json` and README.
