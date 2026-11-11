import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('@skillre/dsh-plugin-agnes-studio', () => {
  it('exports the minimal Cordis function-plugin contract', () => {
    expect(plugin.name).toBe('skillre-agnes-studio')
    expect(plugin.apply).toBeTypeOf('function')
    expect('default' in plugin).toBe(false)
  })
})
