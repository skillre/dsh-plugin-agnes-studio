/**
 * Contract tests for the model-facing tool definitions.
 *
 * These exist because of a real bug found during isolated-profile verification:
 * the tools were authored in the `defineTool` author DSL and passed straight to
 * `ctx.tools.register`, which validates RAW JSON Schema. The plugin mounted, the
 * route registered, and the first request 404'd because `apply` had thrown while
 * registering the tools — a failure invisible to typechecking and to unit tests
 * that only exercised the pure helpers.
 *
 * The schemas are IMPORTED from `src/tools.ts`, not copied: an earlier version
 * re-declared them here, so editing the registered schema left this suite green.
 */

import { describe, expect, it } from 'vitest'
import { IMAGE_PARAMETERS, OUTPUT_SCHEMA, VIDEO_PARAMETERS } from '../src/tools.js'
import { imageRequestFrom, videoRequestFrom } from '../src/tools.js'
import { modelsFor, IMAGE_RATIOS, IMAGE_SIZES, VIDEO_RATIOS, VIDEO_SECONDS } from '../src/types.js'

/**
 * The structural subset DSH enforces, re-implemented for the offline path.
 *
 * Mirrors `checkSchemaNode` in `@deepseek-ai/dsh-tools`: `required` is legal only
 * on an object schema, `enum` only on a scalar, and `items` only on an array.
 * That is exactly the rule the original bug broke. The isolated-profile run is
 * what proves the real validator accepts these; this is the fast local mirror.
 */
function assertStructurallySupported(schema: unknown, path = 'schema'): void {
  if (schema === null || typeof schema !== 'object') throw new Error(`${path} is not a schema object`)
  const node = schema as Record<string, unknown>
  const type = node['type']
  if (type !== 'object' && type !== 'array' && type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean' && type !== 'null') {
    throw new Error(`${path}.type is not a supported type`)
  }
  if (Object.hasOwn(node, 'required')) {
    if (type !== 'object') throw new Error(`${path}.required is not supported on type "${String(type)}"`)
    const required = node['required']
    if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${path}.required must be an array of strings`)
    }
    const properties = (node['properties'] ?? {}) as Record<string, unknown>
    for (const name of required) {
      if (!Object.hasOwn(properties, name)) throw new Error(`${path}.required names "${name}" which is not in properties`)
    }
  }
  if (Object.hasOwn(node, 'enum')) {
    if (type === 'object' || type === 'array') throw new Error(`${path}.enum is only valid on a scalar type`)
    const allowed = node['enum']
    if (!Array.isArray(allowed) || allowed.length === 0) throw new Error(`${path}.enum must be a non-empty array`)
  }
  if (Object.hasOwn(node, 'items')) {
    if (type !== 'array') throw new Error(`${path}.items is only valid on an array`)
    assertStructurallySupported(node['items'], `${path}.items`)
  }
  const properties = node['properties']
  if (properties !== undefined) {
    if (type !== 'object') throw new Error(`${path}.properties is only valid on an object`)
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      assertStructurallySupported(child, `${path}.properties.${name}`)
    }
  }
}

/** Read a schema property, failing loudly when the shape drifted. */
function property(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined
  const found = properties?.[name]
  if (found === undefined) throw new Error(`schema has no property ${name}`)
  return found
}

describe('tool schemas are valid raw JSON Schema', () => {
  const schemas: Array<[string, unknown]> = [
    ['agnes_image parameters', IMAGE_PARAMETERS],
    ['agnes_video parameters', VIDEO_PARAMETERS],
    ['tool output', OUTPUT_SCHEMA],
  ]

  for (const [label, schema] of schemas) {
    it(`${label} is accepted by the registry's structural rules`, () => {
      expect(() => assertStructurallySupported(schema)).not.toThrow()
    })
  }

  it('never puts `required` on a leaf property, which is the bug this guards', () => {
    // The exact shape that made `apply` throw and the route 404.
    const broken = { type: 'object', properties: { prompt: { type: 'string', required: true } } }
    expect(() => assertStructurallySupported(broken)).toThrowError(/required is not supported on type "string"/)
  })

  it('declares `required` at the object root instead', () => {
    expect(IMAGE_PARAMETERS['required']).toEqual(['prompt'])
    expect(VIDEO_PARAMETERS['required']).toEqual(['prompt'])
    expect(OUTPUT_SCHEMA['required']).toContain('id')
  })
})

describe('tool schemas match the capability table', () => {
  it('offers exactly the image models the plugin ships', () => {
    expect(property(IMAGE_PARAMETERS, 'model')['enum']).toEqual(modelsFor('image').map((model) => model.id))
  })

  it('offers exactly the video models the plugin ships', () => {
    expect(property(VIDEO_PARAMETERS, 'model')['enum']).toEqual(modelsFor('video').map((model) => model.id))
  })

  it('offers every documented size and ratio', () => {
    expect(property(IMAGE_PARAMETERS, 'size')['enum']).toEqual([...IMAGE_SIZES])
    expect(property(IMAGE_PARAMETERS, 'ratio')['enum']).toEqual([...IMAGE_RATIOS])
    expect(property(VIDEO_PARAMETERS, 'ratio')['enum']).toEqual([...VIDEO_RATIOS])
  })

  it('offers the full documented duration range', () => {
    expect(property(VIDEO_PARAMETERS, 'seconds')['enum']).toEqual([...VIDEO_SECONDS])
  })

  it('declares integer seconds, so a fractional duration is rejected before execution', () => {
    expect(property(VIDEO_PARAMETERS, 'seconds')['type']).toBe('integer')
  })
})

describe('tool argument mapping still works after the schema change', () => {
  it('builds an image request from the tool arguments', () => {
    expect(imageRequestFrom({ prompt: 'a red apple' })).toMatchObject({ kind: 'image', size: '1K', ratio: '1:1' })
  })

  it('builds a video request from the tool arguments', () => {
    expect(videoRequestFrom({ prompt: 'a cat' })).toMatchObject({ kind: 'video', mode: 'text', seconds: 5 })
  })
})
