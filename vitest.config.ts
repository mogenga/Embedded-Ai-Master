import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    unstubEnvs: true,
    coverage: {
      include: ['src/**'],
      thresholds: {
        lines: 85,
      },
    },
  },
})
