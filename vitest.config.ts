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
    // 覆盖率口径：src/** 是平台层，全部纳入；领域层只纳入离线可测的 kb / datasheet / probe。
    // 实测（2026-11-07，npm run coverage，lines；下列数字一律按本文件同一条文件选择规则
    // —— 只取 .ts、排除 **/tests/** —— 复跑三次一致，可直接复核）：
    //   src/** 单独                  → 90.99%（6837/7514，通过）
    //   src/** + 全部 mcp-servers/** → 78.43%（9979/12722，失败：距 85% 还差 835 行）
    //   src/** + kb/datasheet/probe  → 90.15%（8778/9737，通过）
    // 排除 keil / serial / embedded 的理由不是「它们没测」，而是剩余路径必须插着硬件才能走：
    //   - keil（行覆盖 42.65%，1144/2682）：keilSession 要连真实 uVision 的 UVSOCK（端口 4823）才能走完；
    //   - serial（19.45%，57/293）：embed-serial.test.ts 头注释明写刻意不 spawn 泵、不碰真实 COM 口，
    //     泵与真机收发路径离线无法覆盖；
    //   - embedded（0%，0/10）：server.ts 目前只是 phase 1 移植骨架，尚无测试。
    // 把它们算进闸门，等于要求离线测试覆盖真机路径，只能靠豁免或造假达成，两者都比不设闸门更糟。
    // 纳入的三块自身：kb 91.30%（714/782）、datasheet 93.18%（437/469）、probe 81.28%（790/972）。
    // probe 单独低于 85%，靠 src/** 的余量拉平到 90.15%——口径是全局闸门而非逐模块闸门，这是有意的。
    // 另排除 **/tests/**：Vitest 只会自动排除与 test.include 匹配的 *测试文件*，
    // 像 datasheet/tests/fixtures.ts 这类夹具若被 include 会被当成产品代码计入（实测会让
    // datasheet 从 93.18% 掉到 92.55%，分母多出 3 行夹具）。
    coverage: {
      include: [
        'src/**/*.ts',
        'mcp-servers/kb/**/*.ts',
        'mcp-servers/datasheet/**/*.ts',
        'mcp-servers/probe/**/*.ts',
      ],
      exclude: ['**/tests/**'],
      // 显式列出 reporter: Vitest 在 agent 环境会把 text reporter 强制改为 skipFull:true,
      // 隐藏 100% 文件。这里显式给对象形式,保证表格始终列出所有文件,便于核验。
      reporter: [['text', { skipFull: false }], 'text-summary'],
      thresholds: {
        lines: 85,
      },
    },
  },
})
