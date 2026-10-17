import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    unstubEnvs: true,
    coverage: {
      include: ['src/**'],
      // 显式列出 reporter: Vitest 在 agent 环境会把 text reporter 强制改为 skipFull:true,
      // 隐藏 100% 文件。这里显式给对象形式,保证表格始终列出所有文件,便于核验。
      reporter: [['text', { skipFull: false }], 'text-summary'],
      thresholds: {
        lines: 85,
      },
    },
  },
})
