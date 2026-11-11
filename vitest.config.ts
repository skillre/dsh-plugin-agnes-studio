import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The view tests need a DOM; the Host tests do not care either way.
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
})
