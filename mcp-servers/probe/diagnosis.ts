export interface UartBaselineRegisters {
  vtor: number
  apb1enr: number
  gpioaModer: number
  usartCr1: number
  usartBrr: number
}

export interface DiagnosisCheck {
  name: string
  value: string
  expected: string
  ok: boolean
}

export interface DiagnosisVerdict {
  rootCause: string
  matchedKbSteps: number[]
  checks: DiagnosisCheck[]
  falsifiablePrediction: string
  limitations: string[]
}

const AF_MODE = 2
const USART2EN_BIT = 17
const UE_BIT = 13
const TE_BIT = 3
const PA2_SHIFT = 4
const PA3_SHIFT = 6

const BASE_LIMITATIONS = [
  'Renode 复位基线不等于真实板卡故障；VTOR=0 仅表示未加载固件。',
  '本证据只覆盖 USART2 时钟、引脚复用、CR1 与 BRR，不覆盖线序、共地、电平与对端配置。',
]

const FALSIFIABLE_PREDICTION =
  '若在固件中使能 USART2 时钟、将 PA2/PA3 配为 AF7、置 UE|TE 并写入与 PCLK 匹配的 BRR，则 TX 应产生字节；若仍无输出，则本根因判断被证伪。'

function bit(value: number, position: number): number {
  return (value >>> position) & 1
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`
}

function mode(value: number, shift: number): number {
  return (value >>> shift) & 3
}

export function analyzeUartBaseline(input: UartBaselineRegisters): DiagnosisVerdict {
  const usart2en = bit(input.apb1enr, USART2EN_BIT)
  const pa2Mode = mode(input.gpioaModer, PA2_SHIFT)
  const pa3Mode = mode(input.gpioaModer, PA3_SHIFT)
  const ue = bit(input.usartCr1, UE_BIT)
  const te = bit(input.usartCr1, TE_BIT)
  const brrConfigured = input.usartBrr > 0
  const pa2Af = pa2Mode === AF_MODE
  const pa3Af = pa3Mode === AF_MODE

  const checks: DiagnosisCheck[] = [
    {
      name: 'RCC_APB1ENR.USART2EN',
      value: String(usart2en),
      expected: '1',
      ok: usart2en === 1,
    },
    {
      name: 'GPIOA.MODER.PA2',
      value: String(pa2Mode),
      expected: `AF(${AF_MODE})`,
      ok: pa2Af,
    },
    {
      name: 'GPIOA.MODER.PA3',
      value: String(pa3Mode),
      expected: `AF(${AF_MODE})`,
      ok: pa3Af,
    },
    { name: 'USART2.CR1.UE', value: String(ue), expected: '1', ok: ue === 1 },
    { name: 'USART2.CR1.TE', value: String(te), expected: '1', ok: te === 1 },
    {
      name: 'USART2.BRR',
      value: hex(input.usartBrr),
      expected: '> 0',
      ok: brrConfigured,
    },
    {
      name: 'SCB.VTOR',
      value: hex(input.vtor),
      expected: '!= 0（已加载向量表）',
      ok: input.vtor !== 0,
    },
  ]

  const allReset =
    usart2en === 0 && !pa2Af && !pa3Af && ue === 0 && te === 0 && input.usartBrr === 0
  const initialized = usart2en === 1 && (pa2Af || pa3Af) && ue === 1 && te === 1 && brrConfigured

  if (allReset) {
    return {
      rootCause: 'USART2 未初始化：RCC 时钟未使能、PA2/PA3 未复用为 AF、CR1 的 UE/TE 未置位、BRR 为 0',
      matchedKbSteps: [7, 8],
      checks,
      falsifiablePrediction: FALSIFIABLE_PREDICTION,
      limitations: BASE_LIMITATIONS,
    }
  }

  if (initialized) {
    return {
      rootCause: '仿真基线显示 USART2 已初始化；本证据不能证明线序、共地或电平正常，需在真实板卡上继续排查',
      matchedKbSteps: [],
      checks,
      falsifiablePrediction: FALSIFIABLE_PREDICTION,
      limitations: [
        ...BASE_LIMITATIONS,
        '未发现未初始化证据，不能据此排除接线、电平或对端问题。',
      ],
    }
  }

  const missing: string[] = []
  if (usart2en === 0) missing.push('USART2 时钟未使能')
  if (!pa2Af && !pa3Af) missing.push('PA2/PA3 均未复用为 AF')
  if (ue === 0) missing.push('CR1.UE 未置位')
  if (te === 0) missing.push('CR1.TE 未置位')
  if (!brrConfigured) missing.push('BRR 未配置')

  const matchedKbSteps: number[] = []
  if (!pa2Af && !pa3Af) matchedKbSteps.push(7)
  if (!brrConfigured) matchedKbSteps.push(8)

  return {
    rootCause: `USART2 初始化不完整：${missing.join('；')}`,
    matchedKbSteps,
    checks,
    falsifiablePrediction: FALSIFIABLE_PREDICTION,
    limitations: BASE_LIMITATIONS,
  }
}