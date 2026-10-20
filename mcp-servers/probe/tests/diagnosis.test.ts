import { describe, expect, it } from 'vitest'

import { analyzeUartBaseline } from '../diagnosis.js'
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
    expect(verdict.matchedKbSteps).toEqual([7, 8])
    expect(verdict.checks).toHaveLength(7)
    expect(verdict.checks.find((check) => check.name === 'USART2.CR1.UE')?.ok).toBe(false)
    expect(verdict.falsifiablePrediction).toContain('则 TX 应产生字节')
  })

  it('已初始化基线不宣称根因，并要求真板继续排查', () => {
    const verdict = analyzeUartBaseline(INITIALIZED)

    expect(verdict.rootCause).toContain('已初始化')
    expect(verdict.rootCause).not.toContain('未初始化')
    expect(verdict.matchedKbSteps).toEqual([])
    expect(verdict.limitations.join('')).toContain('不能据此排除接线')
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