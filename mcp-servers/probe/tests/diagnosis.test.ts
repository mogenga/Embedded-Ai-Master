import { describe, expect, it } from 'vitest'

import { analyzeUartBaseline, decodeMemoryHex } from '../diagnosis.js'
import type { UartBaselineRegisters } from '../diagnosis.js'

const RESET_BASELINE: UartBaselineRegisters = {
  vtor: 0,
  apb1enr: 0,
  gpioaModer: 0xa8000000,
  usartCr1: 0xc0000000,
  usartBrr: 0,
}

const INITIALIZED: UartBaselineRegisters = {
  vtor: 0x08000000,
  apb1enr: 1 << 17,
  gpioaModer: 0xa8000000 | (2 << 4) | (2 << 6),
  usartCr1: (1 << 13) | (1 << 3),
  usartBrr: 0x2d9,
}

describe('analyzeUartBaseline', () => {
  it('复位基线判定 USART2 未初始化', () => {
    const verdict = analyzeUartBaseline(RESET_BASELINE)

    expect(verdict.rootCause).toContain('未初始化')
    expect(verdict.rootCause).toContain('VTOR=0')
    expect(verdict.matchedKbSteps).toEqual([7, 8])
    expect(verdict.checks).toHaveLength(7)
    expect(verdict.checks.find((check) => check.name === 'USART2.CR1.UE')?.ok).toBe(false)
    expect(verdict.falsifiablePrediction).toContain('则 TX 应产生字节')
    expect(verdict.limitations.join('')).toContain('全 0')
  })

  it('已初始化基线不宣称根因，并要求真板继续排查', () => {
    const verdict = analyzeUartBaseline(INITIALIZED)

    expect(verdict.rootCause).toContain('已初始化')
    expect(verdict.rootCause).not.toContain('未初始化')
    expect(verdict.matchedKbSteps).toEqual([])
    expect(verdict.limitations.join('')).toContain('不能据此排除接线')
  })

  it('关键读数带未映射警告时只给证据不足结论', () => {
    const verdict = analyzeUartBaseline({
      ...RESET_BASELINE,
      warnings: { vtor: true, apb1enr: true, gpioaModer: true, usartBrr: true },
    })

    expect(verdict.rootCause).toContain('证据不足')
    expect(verdict.rootCause).toContain('CR1 的 UE/TE 未置位')
    expect(verdict.matchedKbSteps).toEqual([3])
    expect(verdict.limitations.join('')).toContain('未完成完整根因')
    expect(verdict.checks.find((check) => check.name === 'RCC_APB1ENR.USART2EN')?.reliable).toBe(
      false,
    )
  })

  it('部分初始化时列出未满足项', () => {
    const verdict = analyzeUartBaseline({ ...INITIALIZED, usartCr1: 1 << 13 })

    expect(verdict.rootCause).toContain('初始化不完整')
    expect(verdict.rootCause).toContain('CR1.TE')
    expect(verdict.matchedKbSteps).toEqual([])
  })

  it('缺少引脚复用时匹配 KB 第 7 步', () => {
    const verdict = analyzeUartBaseline({
      ...INITIALIZED,
      gpioaModer: 0xa8000000,
    })

    expect(verdict.matchedKbSteps).toEqual([7])
    expect(verdict.rootCause).toContain('PA2/PA3')
  })

  it('所有分支都声明复位基线的局限', () => {
    for (const input of [RESET_BASELINE, INITIALIZED, { ...INITIALIZED, usartBrr: 0 }]) {
      expect(analyzeUartBaseline(input).limitations.join('')).toContain('复位基线')
    }
  })

  it('decodeMemoryHex 按小端解码内存字节串', () => {
    // RenodeBackend.readMemory 的 hex 是地址递增的内存字节顺序（小端）。
    expect(decodeMemoryHex('00000020', 4)).toBe(0x20000000)
    expect(decodeMemoryHex('000000a8', 4)).toBe(0xa8000000)
    expect(decodeMemoryHex('78563412', 4)).toBe(0x12345678)
    expect(decodeMemoryHex('0002', 2)).toBe(0x0200)
    expect(decodeMemoryHex('01', 1)).toBe(0x01)
  })

  it('decodeMemoryHex 拒绝与长度不符或非十六进制的输入', () => {
    expect(() => decodeMemoryHex('0000', 4)).toThrow(/长度/)
    expect(() => decodeMemoryHex('0000000000', 4)).toThrow(/长度/)
    expect(() => decodeMemoryHex('zzzzzzzz', 4)).toThrow(/十六进制/)
    expect(() => decodeMemoryHex('', 4)).toThrow(/长度/)
    expect(() => decodeMemoryHex('00000020', 0)).toThrow(/长度/)
    expect(() => decodeMemoryHex('00000020', 5)).toThrow(/长度/)
  })

  it('复位基线 0xa8000000 经小端解码后仍判定未初始化', () => {
    // 0xa8000000 的内存字节串是 000000a8；按大端 parseInt 会得到 0xa8，
    // 使 PA2/PA3 被判为 AF 而漏掉第 7 步。此处锁定正确的端序。
    const gpioaModer = decodeMemoryHex('000000a8', 4)
    const verdict = analyzeUartBaseline({
      ...RESET_BASELINE,
      gpioaModer,
      usartCr1: decodeMemoryHex('000000c0', 4),
    })

    expect(verdict.rootCause).toContain('未初始化')
    expect(verdict.matchedKbSteps).toEqual([7, 8])
  })

  it('正确提取位域', () => {
    const verdict = analyzeUartBaseline({
      ...RESET_BASELINE,
      apb1enr: 1 << 17,
      gpioaModer: 2 << 4,
      usartCr1: (1 << 13) | (1 << 3),
      usartBrr: 1,
    })

    expect(verdict.checks.find((check) => check.name === 'RCC_APB1ENR.USART2EN')?.ok).toBe(true)
    expect(verdict.checks.find((check) => check.name === 'GPIOA.MODER.PA2')?.ok).toBe(true)
    expect(verdict.checks.find((check) => check.name === 'GPIOA.MODER.PA3')?.ok).toBe(false)
  })
})