#!/usr/bin/env node
/**
 * Bundle the browser half and wrap it in the DSH client-module envelope.
 *
 * The shell serves every `dsh.client` bundle as one lazy registration:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 *
 * The envelope's `require` only resolves the browser module table, so a
 * relative `require('./api.js')` would not resolve at runtime. esbuild
 * therefore bundles `src/client/index.tsx` and its relative imports into one
 * CommonJS body, keeping exactly the baseline `react` module external.
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client', 'index.tsx')
const output = join(root, 'lib', 'client.js')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // React comes from the browser module table; nothing else may be external,
  // because the envelope cannot resolve a second module. Both entries are in the
  // shell's PLATFORM_MODULES seed table, so both resolve at runtime.
  external: ['react', 'react/jsx-runtime'],
  write: false,
  logLevel: 'warning',
  legalComments: 'none',
  // `automatic` compiles JSX to `require('react/jsx-runtime').jsx(...)`. The
  // previous `transform` (classic) emitted `React.createElement(...)` while only
  // making `require('react')` external — esbuild never creates a `React`
  // binding, so the shipped bundle threw `ReferenceError: React is not defined`
  // on the first render. `apply` still succeeded, so mounting, routing,
  // --dump-config and bounded startup all passed while the panel was unusable.
  // Keep this aligned with tsconfig.client.json's "jsx": "react-jsx".
  jsx: 'automatic',
})

const bundle = result.outputFiles?.[0]?.text
if (typeof bundle !== 'string' || bundle === '') throw new Error('esbuild produced no client bundle')

/** Indent every line of the bundled body by two tabs. */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `\t\t${line}`))
    .join('\n')
}

const envelope = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indent(bundle)}
\t\treturn module.exports;
\t}
});
`

await mkdir(dirname(output), { recursive: true })
await writeFile(output, envelope, 'utf8')

process.stdout.write(`built ${output} (${String(envelope.length)} bytes)\n`)
