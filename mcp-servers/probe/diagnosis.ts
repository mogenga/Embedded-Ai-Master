export interface UartBaselineWarnings {
  vtor?: boolean
  apb1enr?: boolean
  gpioaModer?: boolean
  usartCr1?: boolean
  usartBrr?: boolean
}

export interface UartBaselineRegisters {
  vtor: number
  apb1enr: number
  gpioaModer: number
  usartCr1: number
  usartBrr: number
  warnings?: UartBaselineWarnings
}

export interface DiagnosisCheck {
  name: string
  value: string
  expected: string
  ok: boolean
  reliable?: boolean
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
  '全 0 读数可能来自未映射地址（Renode 会返回 warning），不能单独证明寄存器真实值为 0。',
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

/**
 * 把 `MemoryReadResult.hex` 解码为整数。
 *
 * RenodeBackend.readMemory 的 hex 是地址递增的内存字节顺序，即小端字节串；
 * 直接 `Number.parseInt(hex, 16)` 会把它当作大端整数，高位非零的寄存器会整体错位
 * （例如 0xa8000000 的字节串 `000000a8` 会被读成 0xa8）。这里按小端逐字节拼接，
 * 并校验字节串长度与读取长度一致，避免用错长度或非十六进制输入静默得出错误证据。
 */
export function decodeMemoryHex(raw: string, length: number): number {
  if (!Number.isInteger(length) || length < 1 || length > 4) {
    throw new Error(`内存解码长度必须是 1..4 字节的整数: ${length}`)
  }
  if (raw.length !== length * 2) {
    throw new Error(`内存字节串长度与读取长度不符: hex="${raw}" length=${length}`)
  }
  if (!/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error(`内存字节串不是十六进制: ${raw}`)
  }
  let value = 0
  for (let index = 0; index < length; index += 1) {
    const byte = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16)
    value += byte * 2 ** (8 * index)
  }
  return value >>> 0
}

function mode(value: number, shift: number): number {
  return (value >>> shift) & 3
}

export function analyzeUartBaseline(input: UartBaselineRegisters): DiagnosisVerdict {
  const warnings = input.warnings ?? {}
  const reliable = {
    vtor: warnings.vtor !== true,
    apb1enr: warnings.apb1enr !== true,
    gpioaModer: warnings.gpioaModer !== true,
    usartCr1: warnings.usartCr1 !== true,
    usartBrr: warnings.usartBrr !== true,
  }
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
      reliable: reliable.apb1enr,
    },
    {
      name: 'GPIOA.MODER.PA2',
      value: String(pa2Mode),
      expected: `AF(${AF_MODE})`,
      ok: pa2Af,
      reliable: reliable.gpioaModer,
    },
    {
      name: 'GPIOA.MODER.PA3',
      value: String(pa3Mode),
      expected: `AF(${AF_MODE})`,
      ok: pa3Af,
      reliable: reliable.gpioaModer,
    },
    {
      name: 'USART2.CR1.UE',
      value: String(ue),
      expected: '1',
      ok: ue === 1,
      reliable: reliable.usartCr1,
    },
    {
      name: 'USART2.CR1.TE',
      value: String(te),
      expected: '1',
      ok: te === 1,
      reliable: reliable.usartCr1,
    },
    {
      name: 'USART2.BRR',
      value: hex(input.usartBrr),
      expected: '> 0',
      ok: brrConfigured,
      reliable: reliable.usartBrr,
    },
    {
      name: 'SCB.VTOR',
      value: hex(input.vtor),
      expected: '!= 0（已加载向量表）',
      ok: input.vtor !== 0,
      reliable: reliable.vtor,
    },
  ]

  const allReset =
    reliable.apb1enr &&
    reliable.gpioaModer &&
    reliable.usartCr1 &&
    reliable.usartBrr &&
    usart2en === 0 &&
    !pa2Af &&
    !pa3Af &&
    ue === 0 &&
    te === 0 &&
    input.usartBrr === 0
  const initialized = usart2en === 1 && (pa2Af || pa3Af) && ue === 1 && te === 1 && brrConfigured
  const criticalUnreliable = !reliable.apb1enr || !reliable.gpioaModer || !reliable.usartBrr

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

  if (criticalUnreliable) {
    const confirmed: string[] = []
    if (reliable.vtor && input.vtor === 0) confirmed.push('VTOR=0（未加载向量表）')
    if (reliable.usartCr1 && ue === 0 && te === 0) {
      confirmed.push('USART2 CR1 的 UE/TE 未置位')
    }
    return {
      rootCause: `仿真基线证据不足：${
        confirmed.length > 0 ? confirmed.join('；') : '关键寄存器读数不可信'
      }；RCC/GPIO/BRR 的全 0 读数带未映射警告，无法确认时钟与引脚配置`,
      matchedKbSteps: [3],
      checks,
      falsifiablePrediction: FALSIFIABLE_PREDICTION,
      limitations: [
        ...BASE_LIMITATIONS,
        '本结论未完成完整根因判定；需加载固件或换用支持寄存器模型的仿真/真机后重跑。',
      ],
    }
  }

  if (allReset) {
    const baselineNote =
      input.vtor === 0
        ? '；VTOR=0 表示未加载向量表，结论仅适用于该仿真基线'
        : ''
    return {
      rootCause: `USART2 未初始化：RCC 时钟未使能、PA2/PA3 未复用为 AF、CR1 的 UE/TE 未置位、BRR 为 0${baselineNote}`,
      matchedKbSteps: [7, 8],
      checks,
      falsifiablePrediction: FALSIFIABLE_PREDICTION,
      limitations: BASE_LIMITATIONS,
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