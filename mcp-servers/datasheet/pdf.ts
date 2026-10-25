import { execFile } from 'node:child_process'

/**
 * pdftotext 封装（poppler；Windows 亦可随 MiKTeX 取得）。
 *
 * 两条诚实语义继承自 A 侧实现（Prometheus src/embedded/datasheet.ts）：
 *
 *   - `pdftotext -v` 在所有版本上都以非零码退出，因此探测的信号不是退出码，
 *     而是「可执行文件是否存在」：ENOENT 才意味着没装。
 *   - 提取失败返回 null，调用方把它报告为 skipped/错误，绝不把失败伪装成
 *     「没有命中」（R3）。
 */

/** `pdftotext -v` 恒非零退出；ENOENT 才是「没装」。env 仅供测试注入假 PATH。 */
export function findPdfExtractor(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('pdftotext', ['-v'], { windowsHide: true, timeout: 5_000, env }, (error) => {
      resolve((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? null : 'pdftotext')
    })
  })
}

/**
 * 提取一个 PDF 的文本（`-layout` 保留列对齐——寄存器表的位域列依赖它）。
 * 任何失败（超时、损坏、加密）都返回 null，由调用方如实报告。
 */
export function extractPdfText(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'pdftotext',
      ['-layout', file, '-'],
      { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : String(stdout)),
    )
  })
}