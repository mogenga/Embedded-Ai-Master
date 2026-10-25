#!/usr/bin/env node
/**
 * 下载 datasheet 回归语料（ST 公开参考手册）到 mcp-servers/datasheet/corpus/。
 *
 * - 下载 URL 与 sha256 与 scripts/datasheet-regression.mjs 中的钉死值一致；
 *   哈希不符即报错，防止手册换版导致基线页码失真。
 * - 语料是 ST 版权材料，不入版本库（.gitignore 已排除 corpus/）。
 * - 需要出网：本机需走 clash 代理（HTTPS_PROXY=http://127.0.0.1:7897）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CORPUS_DIR = path.join(ROOT, 'mcp-servers', 'datasheet', 'corpus')

const CORPUS = [
  {
    name: 'RM0008.pdf',
    url: 'https://www.st.com/resource/en/reference_manual/rm0008-stm32f101xx-stm32f102xx-stm32f103xx-stm32f105xx-and-stm32f107xx-advanced-armbased-32bit-mcus-stmicroelectronics.pdf',
    sha256: '4c1b8ac2729cc1f45a4685eea9e91e6139e24e58804fba21e27201dfcc2ad149',
    note: 'RM0008 Rev 21 (2021-02), STM32F1 参考手册',
  },
  {
    name: 'RM0090.pdf',
    url: 'https://www.st.com/resource/en/reference_manual/dm00031020-stm32f405-415-stm32f407-417-stm32f427-429-and-stm32f431-433-advanced-armbased-32bit-mcus-stmicroelectronics.pdf',
    sha256: 'f3ff2322eec21f4e49081f68481b764506eee81dba6031bc767e2f8955b27cca',
    note: 'RM0090 Rev 22 (2026-05), STM32F4 参考手册',
  },
]

function fail(message) {
  console.error(`datasheet corpus: ${message}`)
  process.exitCode = 2
}

async function main() {
  mkdirSync(CORPUS_DIR, { recursive: true })
  for (const item of CORPUS) {
    const target = path.join(CORPUS_DIR, item.name)
    if (existsSync(target)) {
      const current = createHash('sha256').update(await import('node:fs').then((fs) => fs.readFileSync(target))).digest('hex')
      if (current === item.sha256) {
        console.log(`${item.name}: 已存在且哈希一致，跳过`)
        continue
      }
      console.log(`${item.name}: 哈希不符，重新下载`)
    }
    console.log(`下载 ${item.name} (${item.note}) ...`)
    const response = await fetch(item.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(300_000),
    })
    if (!response.ok) {
      fail(`下载失败 HTTP ${response.status}: ${item.url}`)
      return
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== item.sha256) {
      writeFileSync(target, bytes)
      fail(`哈希不符: 期望 ${item.sha256} 实际 ${digest}（上游换版？重标基线后再更新钉死值）`)
      return
    }
    writeFileSync(target, bytes)
    console.log(`${item.name}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB, sha256 校验通过`)
  }
}

await main()