import type { SessionEvent } from "../../../src/session/types.js";
import type { AppProps } from "../../../src/ui/app.js";
import { UNKNOWN_DEVICE } from "../../../src/ui/view/device.js";
import { transcriptFromSession } from "../../../src/ui/view/transcript.js";
import type { TranscriptView } from "../../../src/ui/view/transcript.js";

export { UNKNOWN_DEVICE };

const TS = "2026-10-18T21:40:00.000Z";

export function makeSessionEvents(): SessionEvent[] {
  return [
    {
      seq: 1,
      ts: TS,
      type: "user",
      payload: {
        content:
          "板子上电后串口打印全是乱码，从第一行开始就这样。用的是 USB-TTL 接 PA9/PA10，终端设的 115200 8N1。同一根线接别的板子正常。",
      },
    },
    {
      seq: 2,
      ts: TS,
      type: "assistant",
      payload: {
        content:
          "第 0 步分流 · 一次只问一个问题\n先用一个问题劈开假设空间：把终端改成 9600、38400、230400 三档各看一眼，哪一档能读出完整字符？",
        note:
          "这一步能立刻区分「波特率算错」与「时钟源没切到 PLL」两条主假设，信息增益最高。若三档都不行，则转向电平 / 地线 / 引脚复用。",
        toolCalls: [],
      },
    },
    {
      seq: 3,
      ts: TS,
      type: "user",
      payload: { content: "230400 时能勉强读出字符，速度大约是预期的一半。" },
    },
    {
      seq: 4,
      ts: TS,
      type: "assistant",
      payload: {
        content:
          "230400 可读、115200 乱码 —— 说明 MCU 实际波特率约为目标值的 2 倍偏差，时钟频率与 BRR 计算不一致。先检索知识库，再上探针取证。",
        toolCalls: [
          { id: "call_kb_1", name: "kb_lookup", arguments: { query: "STM32 UART 乱码 波特率 时钟" } },
        ],
      },
    },
    {
      seq: 5,
      ts: TS,
      type: "tool_result",
      parent: 4,
      payload: {
        id: "call_kb_1",
        ok: true,
        text: "命中 2",
        detail: {
          ms: 38,
          hits: [
            {
              path: "protocols/uart-stm32-baud.md",
              desc: "症状 → 原因 → 鉴别测试表：时钟源 / BRR 计算 / 过采样方式",
              score: "0.91 · 四段式 · 三级加载进入症状正文",
              channel: 1,
            },
            {
              path: "system/clock-tree-pll.md",
              desc: "HSE 起振失败 → 回退 HSI，系统时钟与固件预期不符",
              score: "0.77 · 按需读取，未整篇加载",
              channel: 1,
            },
          ],
        },
      },
    },
    {
      seq: 6,
      ts: TS,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [
          { id: "call_mem_1", name: "mem_read", arguments: { address: "0x40023808", size: 4, label: "RCC_CFGR" } },
        ],
      },
    },
    {
      seq: 7,
      ts: TS,
      type: "tool_result",
      parent: 6,
      payload: {
        id: "call_mem_1",
        ok: true,
        text: "0x00000000",
        detail: {
          ms: 12,
          readout: [
            { label: "地址", value: "0x4002_3808" },
            { label: "读回", value: "0x0000_0000" },
            {
              label: "字段",
              value: "RCC_CFGR.SW[1:0] = 0b00 → 系统时钟仍为 HSI，未切到 PLL",
            },
          ],
          evidence: [
            {
              name: "时钟源判定",
              code: "RCC_CFGR.SWS",
              value: "0b00 HSI",
              verdict: "bad",
              label: "与预期不符",
            },
          ],
        },
      },
    },
    {
      seq: 8,
      ts: TS,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [
          { id: "call_mem_2", name: "mem_read", arguments: { address: "0x40004408", size: 4, label: "USART2_BRR" } },
        ],
      },
    },
    {
      seq: 9,
      ts: TS,
      type: "tool_result",
      parent: 8,
      payload: {
        id: "call_mem_2",
        ok: true,
        text: "0x0000002E",
        detail: {
          ms: 11,
          readout: [
            { label: "地址", value: "0x4000_4408" },
            { label: "读回", value: "0x0000_002E" },
            {
              label: "字段",
              value: "USART2_BRR = 46 —— 按 PCLK1 = 84 MHz、115200 计算所得（84e6 / (16 × 115200) ≈ 45.6）",
            },
          ],
          evidence: [
            {
              name: "BRR 与真实时钟一致性",
              code: "16e6 / (16 × 46) ≈ 21.7 kbps",
              value: "实际 ≈ 21.7 kbps",
              verdict: "bad",
              label: "偏快 5.3×",
            },
            {
              name: "工具诚实性检查",
              code: "全 0 不得判为无故障",
              value: "0x2E ≠ 0x00",
              verdict: "ok",
              label: "读数有效",
            },
          ],
        },
      },
    },
    {
      seq: 10,
      ts: TS,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [],
        verdict: {
          rootCause:
            "固件按 PCLK1 = 84 MHz 计算 USART2_BRR，但 HSE 晶振未起振，PLL 使能失败后系统回退到 HSI（16 MHz）。时钟与 BRR 不一致，波特率整体偏快约 5.3 倍，接收端按 115200 采样即得乱码。",
          evidence: [
            { name: "RCC_CFGR.SW", code: "0x40023808", value: "0x00", verdict: "warn", label: "HSI 直供" },
            { name: "USART2_BRR", code: "0x40004408", value: "0x2E", verdict: "warn", label: "按 84 MHz 计算" },
            { name: "实测波特率", code: "16e6 / (16 × 46)", value: "21.7 kbps", verdict: "bad", label: "≠ 115200" },
          ],
          prediction:
            "在 HSI 直供前提下，将 USART2->BRR 改为按 16 MHz 计算的值 0x0009；预取预测：终端回到 115200 应立即可读，且实测波特率落在 111.1 kbps（偏差 3.5%，在容限内）。若仍乱码，则本判据被推翻，转向 HSE 起振条件排查。",
          ownership: [
            { t: "agent", title: "agent 自己做", desc: "读寄存器、反汇编 SystemInit、比对 BRR 计算式。" },
            { t: "user", title: "需要你回答", desc: "改 BRR 后 115200 是否恢复可读。" },
            { t: "manual", title: "建议你执行", desc: "用万用表确认 HSE 晶振是否起振（8 MHz）。" },
          ],
          confidence: "高",
        },
      },
    },
    {
      seq: 11,
      ts: TS,
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [],
        guard: { action: "写入", address: "0x40004408", value: "0x0009", state: "待确认" },
      },
    },
    {
      seq: 12,
      ts: TS,
      type: "usage",
      payload: {
        promptTokens: 8120,
        completionTokens: 1460,
        cachedTokens: 2048,
        costUsd: 0.018,
      },
    },
  ];
}

export function makeTranscriptView(): TranscriptView {
  return transcriptFromSession(makeSessionEvents());
}

export function makeAppProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    view: makeTranscriptView(),
    sessions: [],
    kbTree: [],
    kbRoot: null,
    device: UNKNOWN_DEVICE,
    ...overrides,
  };
}