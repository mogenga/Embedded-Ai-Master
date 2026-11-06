import { defineConfig } from 'vitest/config'

// 默认只收集版本控制内的 tests；显式传入 .tmp 页面测试路径时才纳入 ignored 用例。
// Vitest 的位置参数只过滤已收集文件，无法绕过 include，因此这里按 CLI 参数放宽。
const cliArgs = process.argv.slice(2).map((arg) => arg.replace(/\\/g, '/'))
const includesTmpTests = cliArgs.some((arg) => arg.startsWith('.tmp/') || arg.includes('/.tmp/'))

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.{ts,tsx,js}',
      'mcp-servers/**/*.test.ts',
      'src/**/*.test.ts',
      ...(includesTmpTests ? ['.tmp/**/*.test.js'] : []),
    ],
    unstubEnvs: true,
    // 默认 5000ms 对这套测试太紧：CI 的 Windows runner 磁盘明显慢于开发机，而
    // 这些用例要 spawn 宿主/探针子进程、写几百个文件、跑完整 runSession 循环。
    // 实测 CI 上四次失败**全是** `Test timed out in 5000ms`，没有一次是断言不符
    // （2026-11-04 integration ×2、2026-11-06 files-api ×1）；同样的用例单跑必绿。
    //
    // 放宽的是「等它跑完」的容忍度，不是断言：超时仍然会让 CI 红，只是不再把
    // 「慢」判成「错」。单条需要更长的用例仍可自己传第三个参数，这里是兜底。
    testTimeout: 20_000,
    // 钩子同样放宽：afterEach 里关 MCP 连接、删临时目录在慢磁盘上也会超默认 10s。
    hookTimeout: 20_000,
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
