import { defineConfig } from 'vitest/config'

// 默认只收集版本控制内的 tests；显式传入 .tmp 页面测试路径时才纳入 ignored 用例。
// Vitest 的位置参数只过滤已收集文件，无法绕过 include，因此这里按 CLI 参数放宽。
const cliArgs = process.argv.slice(2).map((arg) => arg.replace(/\\/g, '/'))
const includesTmpTests = cliArgs.some((arg) => arg.startsWith('.tmp/') || arg.includes('/.tmp/'))

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.{ts,js}',
      ...(includesTmpTests ? ['.tmp/**/*.test.js'] : []),
    ],
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
